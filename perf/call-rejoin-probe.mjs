// 音视频通话信令层回归探针:主叫与被叫建立通话 → 主叫断线(模拟刷新) → 重连发 call:rejoin,
// 验证服务端 rejoin 重协商链路:call:start → call:peer-reconnecting → call:rejoin 送达。
//
// 前置:biz 双副本 + gateway 已启动,两个账号已在库中存在(可先用 POST /api/register 注册)。
// 用法(口令不写在仓库里,只从环境变量读):
//   PROBE_USER=a PROBE_PASSWORD=*** PEER_USER=b PEER_PASSWORD=*** node perf/call-rejoin-probe.mjs
//
// 可选:BASE(默认 http://localhost:3007)、GW(默认 ws://localhost:8090/ws)
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:3007';
const GW = process.env.GW || 'ws://localhost:8090/ws';

const PROBE = { user: process.env.PROBE_USER, pass: process.env.PROBE_PASSWORD };
const PEER = { user: process.env.PEER_USER, pass: process.env.PEER_PASSWORD };

if (!PROBE.user || !PROBE.pass || !PEER.user || !PEER.pass) {
  console.error('缺少凭据:需要 PROBE_USER / PROBE_PASSWORD / PEER_USER / PEER_PASSWORD 四个环境变量');
  process.exit(1);
}

async function login({ user, pass }) {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(`login ${user} 失败: ${JSON.stringify(j)}`);
  return { token: j.data.token, id: Number(j.data.id) };
}

const a = await login(PROBE);
const b = await login(PEER);
const callId = `call_${Math.min(a.id, b.id)}_${Math.max(a.id, b.id)}_${Date.now()}`;
console.log('callId=', callId);

function connect(token, dev) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${GW}?deviceId=${dev}`, { headers: { Cookie: `token=${token}` } });
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}

let wsA = await connect(a.token, 'rejoin-a');
const wsB = await connect(b.token, 'rejoin-b');
const msgsB = [];
wsB.on('message', (d) => msgsB.push(String(d).slice(0, 160)));

// 1. 主叫 call:start
wsA.send(JSON.stringify({ type: 'call:start', data: { callId, from: { id: a.id }, to: { id: b.id }, callType: 'video', offer: { type: 'offer', sdp: 'v=0\r\noffer1' } } }));
await new Promise((r) => setTimeout(r, 1000));
console.log('① call:start 后,被叫收到:', msgsB.length, '帧');

// 2. 被叫 call:accept
wsB.send(JSON.stringify({ type: 'call:accept', data: { callId, from: b.id, to: a.id, answer: { type: 'answer', sdp: 'v=0\r\nanswer1' } } }));
await new Promise((r) => setTimeout(r, 1000));

// 3. 主叫"刷新":断开 WS(网关会 NotifyDisconnect → biz MarkReconnecting)
wsA.close();
console.log('② 主叫断开(模拟刷新)');
await new Promise((r) => setTimeout(r, 1500));

// 4. 主叫重连并 call:rejoin(带新 offer)
const msgsA = [];
wsA = await connect(a.token, 'rejoin-a2');
wsA.on('message', (d) => msgsA.push(String(d).slice(0, 200)));
wsA.send(JSON.stringify({ type: 'call:rejoin', data: { callId, from: { id: a.id }, to: { id: b.id }, offer: { type: 'offer', sdp: 'v=0\r\noffer2' } } }));
await new Promise((r) => setTimeout(r, 1500));
console.log('③ rejoin 后,被叫收到的新帧:');
for (const m of msgsB.slice(1)) console.log('   B↓', m.slice(0, 140));
console.log('④ 主叫收到的帧:');
for (const m of msgsA) console.log('   A↓', m.slice(0, 160));

wsA.close(); wsB.close();
setTimeout(() => process.exit(0), 300);
