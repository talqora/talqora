#!/usr/bin/env node
// 群扇出(fan-out)延迟测试(gateway/Go 路径):N 个成员全部经 gateway /ws 在线,1 人向群发消息,
// 测量「最后一名成员收到 vs 第一名成员收到」(扇出扩散 span)与
// 「最后一名成员收到 vs 发送」(扇出端到端 e2e)的延迟分布。
// 群通过直写 DB(user_groups + group_members)建立(server 暂无建群 API,benchmark 场景可接受)。
// gateway 路径下行:server 落库后 publish gw:downlink → 网关代投 receiveMessage 帧。
// 数据落 docs/监测设施/测试报告/data/fanout_bench_gateway.json。
//
// 用法:node gw-fanout-bench.mjs [MEMBERS=100] [ROUNDS=20] [GROUP_ID=9000002]
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告', 'data');
const BASE = process.env.BASE || 'http://localhost:3007';
const GW = process.env.GW || 'ws://localhost:8090/ws';
const MEMBERS = parseInt(process.env.MEMBERS || '100', 10);
const ROUNDS = parseInt(process.env.ROUNDS || '20', 10);
const GROUP_ID = process.env.GROUP_ID || '9000002';
const CONNECT_TIMEOUT_MS = parseInt(process.env.CONNECT_TIMEOUT_MS || '10000', 10);
const PASSWORD = process.env.BENCH_PASSWORD || 'bench_pw_123456';

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return NaN;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1));
  return sortedArr[idx];
}
function summarize(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted.length ? sorted[0] : NaN,
    max: sorted.length ? sorted[sorted.length - 1] : NaN,
  };
}

async function httpPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function loginOne(i) {
  const username = `bench_user_${i}`;
  let r = await httpPost('/api/login', { username, password: PASSWORD });
  if (!r.json?.success) {
    await httpPost('/api/register', { username, email: `${username}@bench.local`, password: PASSWORD });
    r = await httpPost('/api/login', { username, password: PASSWORD });
  }
  const token = r.json?.data?.token;
  const id = r.json?.data?.id;
  if (!token || id == null) throw new Error(`登录失败(${username})`);
  return { id: Number(id), token };
}
function sql(cmd) {
  return execSync(
    `docker exec our-chat-postgres psql -U postgres -d our_chat -c ${JSON.stringify(cmd)}`,
    { encoding: 'utf8' },
  );
}

// 单条 WS 建连(query token/deviceId),保活心跳 25s
function connectOne(user, i) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ws = new WebSocket(`${GW}?deviceId=fanout-gw-${i}&token=${encodeURIComponent(user.token)}`);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (!ok) { try { ws.close(); } catch { /* ignore */ } resolve({ ok: false, ms: null, ws: null }); }
      else resolve({ ok: true, ms: Date.now() - t0, ws });
    };
    const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    ws.on('open', () => {
      clearTimeout(timer);
      ws._hb = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'heartbeat' })); } catch { /* ignore */ }
        }
      }, 25000);
      finish(true);
    });
    ws.on('unexpected-response', () => finish(false));
    ws.on('error', () => { /* 统一在 close 收口 */ });
    ws.on('close', () => { clearTimeout(timer); if (!done) finish(false); });
  });
}

async function main() {
  console.log(`[gw-fanout] MEMBERS=${MEMBERS} ROUNDS=${ROUNDS} GROUP_ID=${GROUP_ID}`);
  // 1) 登录成员
  console.log(`[gw-fanout] 登录 ${MEMBERS} 成员...`);
  const users = [];
  for (let i = 0; i < MEMBERS; i++) users.push(await loginOne(i));

  // 2) 建群 + 成员(直写 DB,与 fanout-bench.mjs 同法)
  console.log(`[gw-fanout] 直写 DB 建群(group_${GROUP_ID})与 ${MEMBERS} 成员...`);
  sql(`INSERT INTO user_groups (id, name, owner_id, max_members, group_type) VALUES (${GROUP_ID}, 'bench_group_gw', ${users[0].id}, 500, 'private') ON CONFLICT (id) DO NOTHING;`);
  const values = users.map((u, i) => `(${GROUP_ID}, ${u.id}, '${i === 0 ? 'owner' : 'member'}')`).join(',');
  sql(`INSERT INTO group_members (group_id, user_id, role) VALUES ${values} ON CONFLICT (group_id, user_id) DO NOTHING;`);

  // 3) 全部成员经 gateway 建立连接
  console.log(`[gw-fanout] 建立 ${MEMBERS} 条 gateway 连接...`);
  const conns = [];
  for (let i = 0; i < MEMBERS; i++) {
    const r = await connectOne(users[i], i);
    if (r.ok) conns.push({ idx: i, ws: r.ws });
  }
  console.log(`[gw-fanout] 连接成功 ${conns.length}/${MEMBERS}`);

  // 4) 监听 receiveMessage 下行帧:clientMsgId -> recvTs
  const conversationId = `group_${GROUP_ID}`;
  const sendTs = {};
  const recvTs = {};
  for (const { idx, ws } of conns) {
    ws.on('message', (data) => {
      let frame = null;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (frame?.type !== 'receiveMessage') return;
      const cid = frame.data?.clientMsgId;
      if (!cid || !sendTs[cid]) return;
      (recvTs[cid] ??= {})[idx] = Date.now();
    });
  }

  // 5) sender 发 ROUNDS 条消息(间隔 300ms),其余成员只收
  const sender = conns[0].ws;
  console.log(`[gw-fanout] sender 发 ${ROUNDS} 条消息...`);
  await new Promise((r) => setTimeout(r, 500)); // 等所有连接 ready
  for (let k = 0; k < ROUNDS; k++) {
    const cid = `fanout-gw-${Date.now()}-${k}`;
    sendTs[cid] = Date.now();
    sender.send(JSON.stringify({
      type: 'message.send',
      data: { clientMsgId: cid, conversationId, content: `fanout bench gw ${k}`, type: 'text' },
    }));
    await new Promise((r) => setTimeout(r, 300));
  }
  // 收尾窗口
  await new Promise((r) => setTimeout(r, 2000));

  // 6) 统计每条消息的 fan-out span / e2e
  const spans = [];
  const e2es = [];
  let deliveredCount = 0;
  for (const cid of Object.keys(sendTs)) {
    const times = Object.values(recvTs[cid] ?? {});
    if (!times.length) continue;
    deliveredCount++;
    const mn = Math.min(...times), mx = Math.max(...times);
    spans.push(mx - mn);
    e2es.push(mx - sendTs[cid]);
  }

  // 7) 收尾
  conns.forEach(({ ws }) => {
    if (ws._hb) clearInterval(ws._hb);
    try { ws.close(); } catch { /* ignore */ }
  });

  const spanStat = summarize(spans);
  const e2eStat = summarize(e2es);
  const result = {
    label: 'fanout_bench_gateway',
    mode: 'gateway',
    params: { MEMBERS, ROUNDS, GROUP_ID, conversationId },
    connected: conns.length,
    roundsSent: ROUNDS,
    roundsDelivered: deliveredCount,
    fanoutSpanMs: { p50: spanStat.p50, p95: spanStat.p95, p99: spanStat.p99, min: spanStat.min, max: spanStat.max, n: spanStat.count },
    fanoutE2EMs: { p50: e2eStat.p50, p95: e2eStat.p95, p99: e2eStat.p99, min: e2eStat.min, max: e2eStat.max, n: e2eStat.count },
    endedAt: Date.now(),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 'fanout_bench_gateway.json');
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log('\n========== 群扇出结果(gateway/Go)==========');
  console.log(`成员在线: ${conns.length},发送 ${ROUNDS} 条,完整送达 ${deliveredCount} 条`);
  console.log(`扇出扩散 span(最后-最先收到): p50=${spanStat.p50}ms p95=${spanStat.p95}ms p99=${spanStat.p99}ms max=${spanStat.max}ms`);
  console.log(`扇出端到端 e2e(最后收到-发送): p50=${e2eStat.p50}ms p95=${e2eStat.p95}ms p99=${e2eStat.p99}ms max=${e2eStat.max}ms`);
  console.log(`已写 ${path}`);
  console.log('===========================================');
}

main().catch((e) => {
  console.error('[gw-fanout] 失败:', e);
  process.exit(1);
});
