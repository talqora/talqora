#!/usr/bin/env node
// 群扇出(fan-out)延迟测试(纯 Node):N 个成员全部在线,1 人向群发消息,
// 测量「最后一名成员收到 vs 第一名成员收到」(扇出扩散 span)与
// 「最后一名成员收到 vs 发送」(扇出端到端 e2e)的延迟分布。
// 群通过直写 DB(user_groups + group_members)建立(server 暂无建群 API,benchmark 场景可接受)。
// 数据落 docs/监测设施/测试报告/26-9-14/data/fanout_bench.json。
//
// 用法:node fanout-bench.mjs [MEMBERS=100] [ROUNDS=20] [GROUP_ID=9000001]
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { io as ioClient } from 'socket.io-client';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告', '26-9-14', 'data');
const BASE = process.env.BASE || 'http://localhost:3007';
const MEMBERS = parseInt(process.env.MEMBERS || '100', 10);
const ROUNDS = parseInt(process.env.ROUNDS || '20', 10);
const GROUP_ID = process.env.GROUP_ID || '9000001';
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

function connectOne(user, i) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = ioClient(BASE, {
      auth: { token: user.token, deviceId: `fanout-${i}` },
      transports: ['websocket'],
      reconnection: false,
      timeout: 10000,
    });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.off('connect');
      socket.off('connect_error');
      if (!ok) socket.close();
      resolve({ ok, ms: ok ? Date.now() - t0 : null, socket: ok ? socket : null });
    };
    socket.once('connect', () => finish(true));
    socket.once('connect_error', () => finish(false));
  });
}

async function main() {
  console.log(`[fanout] MEMBERS=${MEMBERS} ROUNDS=${ROUNDS} GROUP_ID=${GROUP_ID}`);
  // 1) 登录成员
  console.log(`[fanout] 登录 ${MEMBERS} 成员...`);
  const users = [];
  for (let i = 0; i < MEMBERS; i++) users.push(await loginOne(i));

  // 2) 建群 + 成员
  console.log(`[fanout] 直写 DB 建群(group_${GROUP_ID})与 ${MEMBERS} 成员...`);
  sql(`INSERT INTO user_groups (id, name, owner_id, max_members, group_type) VALUES (${GROUP_ID}, 'bench_group', ${users[0].id}, 500, 'private') ON CONFLICT (id) DO NOTHING;`);
  const values = users.map((u, i) => `(${GROUP_ID}, ${u.id}, '${i === 0 ? 'owner' : 'member'}')`).join(',');
  sql(`INSERT INTO group_members (group_id, user_id, role) VALUES ${values} ON CONFLICT (group_id, user_id) DO NOTHING;`);

  // 3) 全部成员建立连接
  console.log(`[fanout] 建立 ${MEMBERS} 条连接...`);
  const conns = [];
  for (let i = 0; i < MEMBERS; i++) {
    const r = await connectOne(users[i], i);
    if (r.ok) conns.push({ idx: i, socket: r.socket });
  }
  console.log(`[fanout] 连接成功 ${conns.length}/${MEMBERS}`);

  // 4) 监听 receiveMessage:clientMsgId -> recvTs
  const conversationId = `group_${GROUP_ID}`;
  const sendTs = {}; // clientMsgId -> 发送时间
  const recvTs = {}; // clientMsgId -> { [memberIdx]: recvTime }
  for (const { idx, socket } of conns) {
    socket.on('receiveMessage', (msg) => {
      const cid = msg?.clientMsgId;
      if (!cid || !sendTs[cid]) return;
      (recvTs[cid] ??= {})[idx] = Date.now();
    });
  }

  // 5) sender 发 ROUNDS 条消息(间隔 300ms),其余成员只收
  const sender = conns[0].socket;
  console.log(`[fanout] sender 发 ${ROUNDS} 条消息...`);
  await new Promise((r) => setTimeout(r, 500)); // 等所有连接 ready
  for (let k = 0; k < ROUNDS; k++) {
    const cid = `fanout-${Date.now()}-${k}`;
    sendTs[cid] = Date.now();
    sender.emit('message.send', { clientMsgId: cid, conversationId, content: `fanout bench ${k}`, type: 'text' });
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
  conns.forEach(({ socket }) => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  });

  const spanStat = summarize(spans);
  const e2eStat = summarize(e2es);
  const result = {
    label: 'fanout_bench',
    mode: 'socketio',
    params: { MEMBERS, ROUNDS, GROUP_ID, conversationId },
    connected: conns.length,
    roundsSent: ROUNDS,
    roundsDelivered: deliveredCount,
    fanoutSpanMs: { p50: spanStat.p50, p95: spanStat.p95, p99: spanStat.p99, min: spanStat.min, max: spanStat.max, n: spanStat.count },
    fanoutE2EMs: { p50: e2eStat.p50, p95: e2eStat.p95, p99: e2eStat.p99, min: e2eStat.min, max: e2eStat.max, n: e2eStat.count },
    endedAt: Date.now(),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 'fanout_bench.json');
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log('\n========== 群扇出结果 ==========');
  console.log(`成员在线: ${conns.length},发送 ${ROUNDS} 条,完整送达 ${deliveredCount} 条`);
  console.log(`扇出扩散 span(最后-最先收到): p50=${spanStat.p50}ms p95=${spanStat.p95}ms p99=${spanStat.p99}ms max=${spanStat.max}ms`);
  console.log(`扇出端到端 e2e(最后收到-发送): p50=${e2eStat.p50}ms p95=${e2eStat.p95}ms p99=${e2eStat.p99}ms max=${e2eStat.max}ms`);
  console.log(`已写 ${path}`);
  console.log('================================');
}

main().catch((e) => {
  console.error('[fanout] 失败:', e);
  process.exit(1);
});
