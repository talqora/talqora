#!/usr/bin/env node
// IM server(Socket.io)实时路径压测 harness —— 自研,零重依赖(仅 socket.io-client)。
// 用途:给监测平台(Prometheus server_ws_connections / server_message_duration_seconds 等指标)造真实负载。
//
// 流程:① 批量注册/登录 bench 用户拿 JWT → ② 按 RAMP 速率建立 CONNS 条已鉴权 socket 连接(连接负载,必须跑通)
//      → ③ 稳态 DURATION 秒内按 RATE 发 message.send,用 message.ack/message.error 回包测 RTT(消息负载,best-effort)
//      → ④ 打印统计:成功连接数、连接耗时分位数、消息发送/ack 数、RTT 分位数、错误分类计数。
//
// 用法见 perf/README.md。

import { io as ioClient } from 'socket.io-client';
import { randomUUID } from 'node:crypto';

// ---------------- 配置(全部走环境变量,给默认值) ----------------
const BASE = process.env.BASE || 'http://localhost:3007';
const CONNS = parseInt(process.env.CONNS || '200', 10); // 并发连接数(= bench 用户数)
const RATE = parseFloat(process.env.RATE || '5'); // 每连接每秒发消息数,<=0 则跳过消息负载
const DURATION = parseInt(process.env.DURATION || '30', 10); // 稳态压测时长(秒)
const RAMP = parseInt(process.env.RAMP || '5', 10); // 每秒新增连接数(建连爬坡)
const REG_CONCURRENCY = parseInt(process.env.REG_CONCURRENCY || '20', 10); // 注册/登录并发度
const PASSWORD = process.env.BENCH_PASSWORD || 'bench_pw_123456'; // 固定密码,6-255 位,满足 register 校验
const ACK_TIMEOUT_MS = parseInt(process.env.ACK_TIMEOUT_MS || '5000', 10); // 消息 ack 等待超时

// ---------------- 分位数统计(自己实现,不引 stats 库) ----------------
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return NaN;
  const idx = Math.min(
    sortedArr.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1),
  );
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

const fmt = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 'n/a');

// ---------------- 错误分类计数 ----------------
const errors = new Map();
function bumpError(cat) {
  errors.set(cat, (errors.get(cat) || 0) + 1);
}

// ---------------- HTTP 小工具(Node 18+ 内置 fetch) ----------------
async function httpPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    // 非 JSON 响应(如服务未起、502 页面等)——上抛让调用方分类计数,不裸吞。
    throw new Error(`${path} 响应非 JSON(HTTP ${res.status}): ${e.message}`);
  }
  return { status: res.status, json };
}

// 注册/登录单个 bench 用户:先登录(用户可能已在上次压测中创建),失败再注册后重登。
// 严格对齐 server/src/routes/register.ts(username/email/password 必填,username 长度2-50、
// 仅字母数字下划线中文,password 6-255)与 server/src/routes/login.ts(body {username,password},
// 返回 { success, data: { ...userInfo, token } },token 字段名就是 token)。
async function registerAndLogin(i) {
  const username = `bench_user_${i}`;
  const email = `${username}@bench.local`;

  let loginRes;
  try {
    loginRes = await httpPost('/api/login', { username, password: PASSWORD });
  } catch (e) {
    bumpError('login_http_error');
    throw new Error(`登录请求失败(${username}): ${e.message}`);
  }

  if (!loginRes.json?.success) {
    let regRes;
    try {
      regRes = await httpPost('/api/register', { username, email, password: PASSWORD });
    } catch (e) {
      bumpError('register_http_error');
      throw new Error(`注册请求失败(${username}): ${e.message}`);
    }
    if (!regRes.json?.success) {
      // 409(用户名/邮箱已存在)等:仍重试登录一次,可能是并发压测场景下用户已被建好。
      bumpError('register_failed');
    }
    try {
      loginRes = await httpPost('/api/login', { username, password: PASSWORD });
    } catch (e) {
      bumpError('login_http_error');
      throw new Error(`重试登录失败(${username}): ${e.message}`);
    }
    if (!loginRes.json?.success) {
      bumpError('login_failed');
      throw new Error(`登录失败(${username}): ${loginRes.json?.message ?? loginRes.status}`);
    }
  }

  const token = loginRes.json.data?.token;
  const id = loginRes.json.data?.id;
  if (!token || id === undefined || id === null) {
    bumpError('login_missing_fields');
    throw new Error(`登录响应缺少 token/id 字段(${username})`);
  }
  return { username, id: Number(id), token };
}

// 简单并发限流池:避免 CONNS=200 时把注册/登录(bcrypt 12 轮)一次性全打过去。
async function pooledMap(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      try {
        results[cur] = { ok: true, value: await fn(items[cur], cur) };
      } catch (e) {
        results[cur] = { ok: false, error: e };
      }
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// 按 conversationId 规则(single_<u1>_<u2>)构造会话 id。message.send 落库路径
// (server/src/services/message.ts persistMessage)会用 ON CONFLICT DO NOTHING 自动建会话,
// 不需要提前走好友/建会话 API;getConversationMembers 对 single_ 前缀直接从 id 里解析双方 id
// (server/src/services/message.ts deriveParticipants),因此两个 bench 用户配对即可直接发消息。
function singleConversationId(idA, idB) {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  return `single_${lo}_${hi}`;
}

// ---------------- 主流程 ----------------
async function main() {
  console.log(
    `[harness] BASE=${BASE} CONNS=${CONNS} RATE=${RATE}/conn/s DURATION=${DURATION}s RAMP=${RAMP}/s`,
  );

  // ===== 阶段1: 注册/登录 =====
  console.log(`[harness] 阶段1: 注册/登录 ${CONNS} 个 bench 用户(并发 ${REG_CONCURRENCY})...`);
  const t1 = Date.now();
  const idxArr = Array.from({ length: CONNS }, (_, i) => i);
  const loginResults = await pooledMap(idxArr, REG_CONCURRENCY, (i) => registerAndLogin(i));
  const users = [];
  for (const r of loginResults) {
    if (r.ok) users.push(r.value);
    else console.error(`[harness] ${r.error.message}`);
  }
  console.log(
    `[harness] 登录成功 ${users.length}/${CONNS},失败 ${CONNS - users.length},耗时 ${Date.now() - t1}ms`,
  );

  if (users.length === 0) {
    console.error('[harness] 无可用用户,无法继续建连,终止。请确认 server 已启动且 /api/register /api/login 可用。');
    printSummary({ totalUsers: 0, connectedCount: 0, connectTimes: [], sentCount: 0, ackCount: 0, rtts: [] });
    process.exitCode = 1;
    return;
  }

  // ===== 阶段2: 建连(爬坡) =====
  console.log(`[harness] 阶段2: 建立 socket 连接(爬坡 ${RAMP}/s,共 ${users.length} 条)...`);
  const connectTimes = [];
  const sockets = new Array(users.length).fill(null);

  // 单条连接握手鉴权对齐 server/src/utils/socket.ts io.use:从 handshake.auth.token 验签,
  // deviceId 取 handshake.auth.deviceId(缺省回落 socket.id)。
  function connectOne(user, i) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const socket = ioClient(BASE, {
        auth: { token: user.token, deviceId: `bench-${i}` },
        transports: ['websocket'],
        reconnection: false,
        timeout: 10000,
      });
      const cleanup = () => {
        socket.off('connect', onConnect);
        socket.off('connect_error', onError);
      };
      const onConnect = () => {
        connectTimes.push(Date.now() - t0);
        sockets[i] = socket;
        cleanup();
        resolve();
      };
      const onError = (err) => {
        bumpError(`connect_error:${err?.message ?? 'unknown'}`);
        cleanup();
        socket.close();
        resolve();
      };
      socket.once('connect', onConnect);
      socket.once('connect_error', onError);
    });
  }

  // 爬坡调度:每秒放 RAMP 条新连接进去,首批立即发出(不等第一个 tick)。
  const connectPromises = [];
  await new Promise((resolveRamp) => {
    let launched = 0;
    const launchBatch = () => {
      const batch = users.slice(launched, launched + RAMP);
      batch.forEach((user, bi) => connectPromises.push(connectOne(user, launched + bi)));
      launched += batch.length;
      if (launched >= users.length) {
        clearInterval(timer);
        resolveRamp();
      }
    };
    const timer = setInterval(launchBatch, 1000);
    launchBatch(); // 首批立即发出
  });
  await Promise.all(connectPromises);

  const connectedCount = sockets.filter(Boolean).length;
  console.log(`[harness] 建连完成: 成功 ${connectedCount}/${users.length}`);

  // ===== 阶段3: 稳态消息负载(best-effort) =====
  const rtts = [];
  let sentCount = 0;
  let ackCount = 0;
  const timers = [];

  if (connectedCount === 0) {
    console.error('[harness] 无成功连接,跳过消息负载阶段。');
  } else if (RATE <= 0) {
    console.log('[harness] RATE<=0,跳过消息负载阶段(仅测连接负载)。');
  } else {
    console.log(`[harness] 阶段3: 稳态消息负载 ${DURATION}s,每连接 ${RATE} msg/s...`);

    // 两两配对成单聊会话,奇数落单则自聊(single_<id>_<id>),不影响 message.send 落库/回 ack。
    const conversationIdOf = new Array(sockets.length).fill(null);
    for (let k = 0; k < sockets.length; k += 2) {
      const a = sockets[k] ? users[k] : null;
      const b = k + 1 < sockets.length && sockets[k + 1] ? users[k + 1] : null;
      if (a && b) {
        const convId = singleConversationId(a.id, b.id);
        conversationIdOf[k] = convId;
        conversationIdOf[k + 1] = convId;
      } else if (a) {
        conversationIdOf[k] = singleConversationId(a.id, a.id);
      } else if (b) {
        conversationIdOf[k + 1] = singleConversationId(b.id, b.id);
      }
    }

    // pending: clientMsgId -> { t0, timer }。ack/error 到达时清掉;超时兜底清理防内存泄漏。
    const pending = new Map();

    sockets.forEach((socket, i) => {
      if (!socket || !conversationIdOf[i]) return;

      socket.on('message.ack', ({ clientMsgId }) => {
        const p = pending.get(clientMsgId);
        if (!p) return; // 已超时清理过或不属于本连接的意外回包
        clearTimeout(p.timer);
        pending.delete(clientMsgId);
        rtts.push(Date.now() - p.t0);
        ackCount++;
      });

      socket.on('message.error', ({ clientMsgId }) => {
        bumpError('message.error');
        const p = clientMsgId && pending.get(clientMsgId);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(clientMsgId);
        }
      });

      const intervalMs = 1000 / RATE;
      const sendOne = () => {
        const clientMsgId = randomUUID();
        const payload = {
          clientMsgId,
          conversationId: conversationIdOf[i],
          content: `bench message from ${users[i].username} @ ${Date.now()}`,
          type: 'text',
        };
        try {
          socket.emit('message.send', payload);
          sentCount++;
          const timer = setTimeout(() => {
            pending.delete(clientMsgId);
            bumpError('message.ack_timeout');
          }, ACK_TIMEOUT_MS);
          pending.set(clientMsgId, { t0: Date.now(), timer });
        } catch (e) {
          bumpError('message.emit_error');
          console.error(`[harness] emit 失败(${users[i].username}): ${e.message}`);
        }
      };
      timers.push(setInterval(sendOne, intervalMs));
    });

    await new Promise((r) => setTimeout(r, DURATION * 1000));
    timers.forEach(clearInterval);

    // 停发后留一点宽限期收尾中的 ack,再清理仍未到达的 pending。
    const grace = Math.min(ACK_TIMEOUT_MS, 3000);
    console.log(`[harness] 停止发送,等待 ${grace}ms 收尾 ack...`);
    await new Promise((r) => setTimeout(r, grace));
    for (const [clientMsgId, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(clientMsgId);
      bumpError('message.ack_timeout');
    }
  }

  // ===== 阶段4: 收尾 =====
  sockets.forEach((s) => {
    try {
      s?.close();
    } catch (e) {
      console.error(`[harness] 关闭连接时出错: ${e.message}`);
    }
  });

  printSummary({
    totalUsers: users.length,
    connectedCount,
    connectTimes,
    sentCount,
    ackCount,
    rtts,
  });
}

function printSummary({ totalUsers, connectedCount, connectTimes, sentCount, ackCount, rtts }) {
  const connStats = summarize(connectTimes);
  const rttStats = summarize(rtts);
  console.log('\n========== 压测结果 ==========');
  console.log(`用户注册/登录成功: ${totalUsers}`);
  console.log(`Socket 连接成功: ${connectedCount} / 尝试 ${totalUsers}`);
  console.log(
    `连接建立耗时(ms): p50=${fmt(connStats.p50)} p95=${fmt(connStats.p95)} p99=${fmt(connStats.p99)} min=${fmt(connStats.min)} max=${fmt(connStats.max)} (n=${connStats.count})`,
  );
  console.log(`消息发送数: ${sentCount}, 收到 ack 数: ${ackCount}`);
  console.log(
    `消息 RTT(ms): p50=${fmt(rttStats.p50)} p95=${fmt(rttStats.p95)} p99=${fmt(rttStats.p99)} min=${fmt(rttStats.min)} max=${fmt(rttStats.max)} (n=${rttStats.count})`,
  );
  console.log('错误分类计数:');
  if (errors.size === 0) {
    console.log('  (无)');
  } else {
    for (const [cat, count] of [...errors.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat}: ${count}`);
    }
  }
  console.log('===============================\n');
}

main().catch((e) => {
  console.error('[harness] 致命错误:', e);
  process.exitCode = 1;
});
