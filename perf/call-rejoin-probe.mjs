// 音视频通话信令层回归探针:probe_a 与 涂将(10301) 建立通话 → probe_a 断线(模拟刷新) → 重连发 call:rejoin,
// 验证服务端 rejoin 重协商链路:call:start → call:peer-reconnecting → call:rejoin 送达。
// 用法:node perf/call-rejoin-probe.mjs(前置:biz 双副本 + gateway;账号 probe_a/probe123456、涂将/Tj@19970924)
import WebSocket from 'ws';

async function login(u, p) {
  const r = await fetch('http://localhost:3007/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  const j = await r.json();
  if (!j.success) throw new Error(`login ${u} 失败: ${JSON.stringify(j)}`);
  return { token: j.data.token, id: Number(j.data.id) };
}
const a = await login('probe_a', 'probe123456');
const b = await login('涂将', 'Tj@19970924');
const callId = `call_${Math.min(a.id, b.id)}_${Math.max(a.id, b.id)}_${Date.now()}`;
console.log('callId=', callId);

function connect(token, dev) {
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://localhost:8090/ws?deviceId=' + dev, { headers: { Cookie: `token=${token}` } });
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
console.log('① call:start 后,涂将收到:', msgsB.length, '帧');

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
console.log('③ rejoin 后,涂将收到的新帧:');
for (const m of msgsB.slice(1)) console.log('   B↓', m.slice(0, 140));
console.log('④ 主叫收到的帧:');
for (const m of msgsA) console.log('   A↓', m.slice(0, 160));

wsA.close(); wsB.close();
setTimeout(() => process.exit(0), 300);
