// gateway(Go)实时路径压测 harness —— 与 harness.mjs(socket.io/Node)同口径,便于 A/B。
// 唯一区别:经原生 WebSocket 连 gateway /ws(Cookie token 鉴权),发 {type:'message.send',data:{...}}
// 信封帧;RTT 用 message.ack 回包(与 socketio harness 一致)。依赖:ws。
//
// 用法:BASE=http://localhost:3007 GW=ws://localhost:8090/ws CONNS=100 RATE=5 DURATION=20 RAMP=25 node harness-gw.mjs
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:3007';
const GW = process.env.GW || 'ws://localhost:8090/ws';
const CONNS = parseInt(process.env.CONNS || '100', 10);
const RATE = parseFloat(process.env.RATE || '5');
const DURATION = parseInt(process.env.DURATION || '20', 10);
const RAMP = parseInt(process.env.RAMP || '25', 10);
const REG_CONCURRENCY = parseInt(process.env.REG_CONCURRENCY || '20', 10);
const PASSWORD = process.env.BENCH_PASSWORD || 'bench_pw_123456';
const ACK_TIMEOUT_MS = parseInt(process.env.ACK_TIMEOUT_MS || '5000', 10);

const errors = {};
const bumpError = (c) => { errors[c] = (errors[c] || 0) + 1; };

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}
function summarize(arr) {
  if (!arr.length) return { p50: NaN, p95: NaN, p99: NaN, min: NaN, max: NaN, n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), min: s[0], max: s[s.length - 1], n: s.length };
}

async function httpPost(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: j };
}

async function registerAndLogin(i) {
  const username = `bench_user_${i}`;
  const email = `${username}@bench.local`;
  // 先登录;失败再注册再登录(用户已存在则直接登录成功)
  let r = await httpPost('/api/login', { username, password: PASSWORD });
  if (!r.body?.success) {
    await httpPost('/api/register', { username, email, password: PASSWORD });
    r = await httpPost('/api/login', { username, password: PASSWORD });
  }
  if (!r.body?.success) throw new Error(r.body?.message || `login 失败 ${username}`);
  const d = r.body.data || {};
  const id = d.id ?? d.userId ?? d.userInfo?.id;
  if (!d.token || id == null) throw new Error(`缺 token/id ${username}`);
  return { username, token: d.token, id: Number(id) };
}

async function pooledMap(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      try { out[cur] = await fn(items[cur], cur); } catch (e) { out[cur] = { __err: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const singleConversationId = (a, b) => `single_${Math.min(a, b)}_${Math.max(a, b)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`[gw-harness] BASE=${BASE} GW=${GW} CONNS=${CONNS} RATE=${RATE}/conn/s DURATION=${DURATION}s RAMP=${RAMP}/s`);

  // 阶段1:注册/登录
  console.log(`[gw-harness] 阶段1: 注册/登录 ${CONNS} 个 bench 用户(并发 ${REG_CONCURRENCY})...`);
  const t0 = Date.now();
  const users = (await pooledMap(Array.from({ length: CONNS }, (_, i) => i), REG_CONCURRENCY, registerAndLogin))
    .filter((u) => u && !u.__err);
  console.log(`[gw-harness] 登录成功 ${users.length}/${CONNS},耗时 ${Date.now() - t0}ms`);
  if (!users.length) { console.error('无可用用户,退出'); process.exit(1); }

  // 阶段2:爬坡建连(原生 ws + Cookie token)
  console.log(`[gw-harness] 阶段2: 建立 ws 连接(爬坡 ${RAMP}/s,共 ${users.length} 条)...`);
  const conns = [];
  const connectTimes = [];
  const sentAt = new Map();       // clientMsgId -> 发送时刻
  const rtts = [];
  let sentCount = 0, ackCount = 0;

  function connectOne(user, i) {
    return new Promise((resolve) => {
      const started = Date.now();
      const ws = new WebSocket(`${GW}?deviceId=bench-gw-${i}`, { headers: { Cookie: `token=${user.token}` } });
      let opened = false;
      const to = setTimeout(() => { if (!opened) { bumpError('connect_timeout'); try { ws.close(); } catch {} resolve(null); } }, ACK_TIMEOUT_MS);
      ws.on('open', () => {
        opened = true; clearTimeout(to);
        connectTimes.push(Date.now() - started);
        resolve({ ws, user });
      });
      ws.on('message', (data) => {
        let m = null; try { m = JSON.parse(String(data)); } catch { return; }
        if (m?.type === 'message.ack') {
          const cid = m.clientMsgId ?? m.data?.clientMsgId;
          const st = cid && sentAt.get(cid);
          if (st) { rtts.push(Date.now() - st); sentAt.delete(cid); ackCount++; }
        } else if (m?.type === 'message.error') {
          bumpError('message.error');
        }
      });
      ws.on('error', () => { if (!opened) { clearTimeout(to); bumpError('connect_error'); resolve(null); } });
    });
  }

  for (let i = 0; i < users.length; i += RAMP) {
    const batch = users.slice(i, i + RAMP);
    const res = await Promise.all(batch.map((u, k) => connectOne(u, i + k)));
    for (const c of res) if (c) conns.push(c);
    await sleep(1000);
  }
  console.log(`[gw-harness] 建连完成: 成功 ${conns.length}/${users.length}`);

  // 阶段3:稳态消息负载
  if (RATE > 0 && conns.length) {
    console.log(`[gw-harness] 阶段3: 稳态消息负载 ${DURATION}s,每连接 ${RATE} msg/s...`);
    const intervalMs = 1000 / RATE;
    const timers = [];
    conns.forEach((c, i) => {
      const peer = conns[(i + 1) % conns.length].user; // 与相邻用户配对成单聊
      const convo = singleConversationId(c.user.id, peer.id);
      const t = setInterval(() => {
        if (c.ws.readyState !== WebSocket.OPEN) return;
        const clientMsgId = `gw-${c.user.id}-${Date.now()}-${Math.round(performance.now() % 1e6)}`;
        sentAt.set(clientMsgId, Date.now());
        sentCount++;
        try {
          c.ws.send(JSON.stringify({
            type: 'message.send',
            data: { clientMsgId, conversationId: convo, content: 'bench gw msg', type: 'text' },
          }));
        } catch (e) { bumpError('send_error'); sentAt.delete(clientMsgId); }
      }, intervalMs);
      timers.push(t);
    });
    await sleep(DURATION * 1000);
    timers.forEach(clearInterval);
    console.log('[gw-harness] 停止发送,等待 3000ms 收尾 ack...');
    await sleep(3000);
  }

  conns.forEach((c) => { try { c.ws.close(); } catch {} });

  const ct = summarize(connectTimes), rt = summarize(rtts);
  console.log('\n========== 压测结果(gateway/Go)==========');
  console.log(`用户登录成功: ${users.length}`);
  console.log(`WS 连接成功: ${conns.length} / 尝试 ${users.length}`);
  console.log(`连接建立耗时(ms): p50=${ct.p50} p95=${ct.p95} p99=${ct.p99} min=${ct.min} max=${ct.max} (n=${ct.n})`);
  console.log(`消息发送数: ${sentCount}, 收到 ack 数: ${ackCount}`);
  console.log(`消息 RTT(ms): p50=${rt.p50} p95=${rt.p95} p99=${rt.p99} min=${rt.min} max=${rt.max} (n=${rt.n})`);
  console.log('错误分类计数:');
  const ek = Object.keys(errors).sort();
  if (!ek.length) console.log('  (无)'); else ek.forEach((k) => console.log(`  ${k}: ${errors[k]}`));
  console.log('=========================================\n');
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => { console.error('[gw-harness] 失败:', e); process.exit(1); });
