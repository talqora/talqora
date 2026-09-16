#!/usr/bin/env node
// gateway(Go)实时路径压测 harness —— 与 harness.mjs(socket.io/Node)同口径,便于 A/B。
// 协议严格对齐 web/src/ws/wsClient.ts 语义:
//   · 信封 {type, data}:上行 {type:'message.send', data:{clientMsgId, conversationId, content, type:'text'}}
//   · 可靠上行:等 message.ack(按 clientMsgId 匹配)计 RTT;5s 超时同键重发,上限 3 次(服务端幂等);
//   · 心跳:每 25s 发 {type:'heartbeat'} 续约网关 presence TTL(60s),否则连接被判离线;
//   · 断线重连:指数退避 1s→2s→...→30s 封顶,重连成功继续发消息(重连次数单独统计,不混入消息错误)。
// 连接:原生 WebSocket → ws://<GW>/ws?deviceId=<唯一>&token=<JWT>(token 来自 HTTP 登录,契约见 perf/README.md)。
// 统计口径与旧 harness 完全一致:RTT 分位 p50/p95/p99/p999、发送数、ack 数、错误分类计数。
//
// 用法:BASE=http://localhost:3007 GW=ws://localhost:8090/ws CONNS=100 RATE=5 DURATION=20 RAMP=25 node harness-gw.mjs
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

// ---------------- 配置(全部走环境变量,与旧 harness 对齐) ----------------
const BASE = process.env.BASE || 'http://localhost:3007';
const GW = process.env.GW || 'ws://localhost:8090/ws';
const CONNS = parseInt(process.env.CONNS || '200', 10);
const RATE = parseFloat(process.env.RATE || '5');
const DURATION = parseInt(process.env.DURATION || '30', 10);
const RAMP = parseInt(process.env.RAMP || '5', 10);
const REG_CONCURRENCY = parseInt(process.env.REG_CONCURRENCY || '20', 10);
const PASSWORD = process.env.BENCH_PASSWORD || 'bench_pw_123456';
const ACK_TIMEOUT_MS = parseInt(process.env.ACK_TIMEOUT_MS || '5000', 10);
const ACK_MAX_RETRIES = parseInt(process.env.ACK_MAX_RETRIES || '3', 10); // 对齐 wsClient.ts:重发上限 3 次
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '25000', 10); // 对齐 wsClient.ts 25s
const CONNECT_TIMEOUT_MS = parseInt(process.env.CONNECT_TIMEOUT_MS || '10000', 10); // 建连超时(对齐旧 harness 的 10s)

// ---------------- 统计工具(与旧 harness 同实现) ----------------
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
    p999: percentile(sorted, 99.9),
    min: sorted.length ? sorted[0] : NaN,
    max: sorted.length ? sorted[sorted.length - 1] : NaN,
  };
}
const fmt = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 'n/a');

// ---------------- 全局统计 ----------------
const errors = new Map();
const bumpError = (cat) => errors.set(cat, (errors.get(cat) || 0) + 1);
const rtts = [];            // ack 到达时记录(从首次发送起算,含重发等待)
const connectTimes = [];    // 初次建连耗时
const reconnectTimes = [];  // 重连成功耗时
let sentCount = 0;          // 首次发送数(不含重发;重发单列 retriesSent)
let ackCount = 0;
let retriesSent = 0;        // 超时重发的帧数
let reconnectEvents = 0;    // 触发的重连次数(含失败)

// ---------------- HTTP 小工具(契约见 perf/README.md「已知限制」) ----------------
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
    throw new Error(`${path} 响应非 JSON(HTTP ${res.status}): ${e.message}`);
  }
  return { status: res.status, json };
}

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
    try {
      await httpPost('/api/register', { username, email, password: PASSWORD });
    } catch (e) {
      bumpError('register_http_error');
      throw new Error(`注册请求失败(${username}): ${e.message}`);
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

// conversationId 规则:single_<minId>_<maxId>(对齐旧 harness 与 perf/README.md)
const singleConversationId = (idA, idB) => `single_${Math.min(idA, idB)}_${Math.max(idA, idB)}`;

// ---------------- 单连接客户端(对齐 wsClient.ts 协议语义) ----------------
class GwClient {
  constructor(user, deviceId) {
    this.user = user;
    this.deviceId = deviceId;
    this.ws = null;
    this.manualClose = false;
    this.pending = new Map(); // clientMsgId -> { firstSentAt, timer, retries, resolve, reject }
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.openedOnce = false;   // 区分「初次建连」与「重连」,耗时分别统计
    this.firstFailHandled = false; // 初次建连失败只分类一次(避免 error→close 双计)
  }

  /** 发起初次建连。resolve 于 open;失败/超时 reject(已分类计数)。 */
  connect() {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        this.firstFailHandled = true; // 避免随后 close 事件重复分类
        bumpError('connect_timeout');
        try { this.ws?.close(); } catch { /* ignore */ }
        finish(reject, new Error('connect_timeout'));
      }, CONNECT_TIMEOUT_MS);
      this._open(
        () => {
          clearTimeout(timer);
          connectTimes.push(Date.now() - t0);
          finish(resolve);
        },
        (err) => {
          clearTimeout(timer);
          finish(reject, err);
        },
      );
    });
  }

  /**
   * 底层建连(初次与重连共用)。握手:query deviceId + token(与 wsClient.ts 的 query 通道一致;
   * gateway 同时支持 Cookie token,无 cookie 环境用 query)。
   */
  _open(onOpen, onFirstFail) {
    this.manualClose = false;
    this.firstFailHandled = false;
    const url = `${GW}?deviceId=${encodeURIComponent(this.deviceId)}&token=${encodeURIComponent(this.user.token)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      bumpError('connect_error:construct');
      onFirstFail?.(e);
      return;
    }
    this.ws = ws;

    ws.on('unexpected-response', (_req, res) => {
      // 握手被拒(401/503 等)。初次建连记分类;重连时 4xx 属永久性错误,停止重试防死循环。
      if (!this.openedOnce) {
        if (!this.firstFailHandled) {
          this.firstFailHandled = true;
          bumpError(`connect_error:http_${res.statusCode}`);
          onFirstFail?.(new Error(`connect_error:http_${res.statusCode}`));
        }
      } else if (res.statusCode === 401 || res.statusCode === 403) {
        this.manualClose = true; // 凭据失效,重连无意义
      }
    });

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.openedOnce = true;
      this.startHeartbeat();
      onOpen?.();
    });

    ws.on('message', (data) => this.handleMessage(String(data)));

    ws.on('error', () => {
      // 统一在 close 里分类处理(error 后必跟 close)
    });

    ws.on('close', (code) => {
      this.stopHeartbeat();
      // 在途 pending 全部判失败(对齐 wsClient.ts:连接断开 reject 所有在途可靠上行)
      this.rejectAllPending();
      if (this.manualClose) return;
      if (!this.openedOnce) {
        // 初次建连未成功即断开(网关拒绝/网络错误等非 4xx 路径)
        if (!this.firstFailHandled) {
          this.firstFailHandled = true;
          bumpError(`connect_error:close_${code}`);
          onFirstFail?.(new Error(`connect_error:close_${code}`));
        }
        return;
      }
      this.scheduleReconnect();
    });
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // 对齐 wsClient.ts:仅 OPEN 时发,发送失败静默(下个周期再试)
      if (this.isOpen()) {
        try {
          this.ws.send(JSON.stringify({ type: 'heartbeat' }));
        } catch { /* ignore */ }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.manualClose) return;
    reconnectEvents++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000); // 对齐 wsClient.ts:1s 起步 ×2 封顶 30s
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const t0 = Date.now();
      // 重连失败无需额外分类:close 事件(openedOnce=true)会再次调度重连
      this._open(() => reconnectTimes.push(Date.now() - t0));
    }, delay);
  }

  handleMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return; // 非法帧静默丢弃(对齐 wsClient.ts)
    }
    if (frame?.type === 'message.ack' || frame?.type === 'message.error') {
      const cid = frame.data?.clientMsgId ?? frame.clientMsgId;
      const entry = cid && this.pending.get(cid);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(cid);
        if (frame.type === 'message.ack') {
          rtts.push(Date.now() - entry.firstSentAt); // RTT 从首次发送起算(含重发等待,对齐「往返」口径)
          ackCount++;
          entry.resolve();
        } else {
          bumpError('message.error');
          entry.reject(new Error(frame.data?.message ?? '消息发送失败'));
        }
      }
    }
  }

  /**
   * 可靠上行(对齐 wsClient.ts sendMessage):连接未就绪 reject;
   * 5s 超时按同 clientMsgId 重发,达到 ACK_MAX_RETRIES 仍未确认则 reject。
   */
  sendMessage(payload) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) {
        bumpError('send_not_connected');
        reject(new Error('连接未就绪,消息未发送'));
        return;
      }
      const entry = {
        firstSentAt: Date.now(),
        timer: null,
        retries: 0,
        resolve,
        reject,
      };
      const sendNow = () => {
        if (!this.isOpen()) {
          if (this.pending.get(payload.clientMsgId) === entry) this.pending.delete(payload.clientMsgId);
          bumpError('message.conn_lost');
          reject(new Error('连接已断开,消息未确认'));
          return;
        }
        // 竞态防护:ack 恰在上轮 timer 触发前后到达,pending 已被收敛,不得重发(对齐 wsClient.ts)
        if (this.pending.get(payload.clientMsgId) !== entry) return;
        try {
          this.ws.send(JSON.stringify({ type: 'message.send', data: payload }));
        } catch (e) {
          this.pending.delete(payload.clientMsgId);
          bumpError('send_error');
          reject(e);
          return;
        }
        entry.timer = setTimeout(() => {
          if (this.pending.get(payload.clientMsgId) !== entry) return; // ack 已到
          entry.retries += 1;
          if (entry.retries >= ACK_MAX_RETRIES) {
            this.pending.delete(payload.clientMsgId);
            bumpError('message.ack_timeout'); // 三次重发仍未确认(与旧 harness 错误类对齐)
            reject(new Error('消息发送确认超时'));
            return;
          }
          retriesSent++;
          sendNow(); // 同键重发(服务端幂等去重)
        }, ACK_TIMEOUT_MS);
      };
      this.pending.set(payload.clientMsgId, entry);
      sendNow();
    });
  }

  rejectAllPending() {
    for (const [cid, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(cid);
      bumpError('message.conn_lost');
      entry.reject(new Error('连接已断开,消息未确认'));
    }
  }

  /** 主动断开:停止心跳与重连(对齐 wsClient.ts disconnect) */
  close() {
    this.manualClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch { /* ignore */ }
  }
}

// ---------------- 主流程 ----------------
async function main() {
  console.log(`[gw-harness] BASE=${BASE} GW=${GW} CONNS=${CONNS} RATE=${RATE}/conn/s DURATION=${DURATION}s RAMP=${RAMP}/s ACK_TIMEOUT=${ACK_TIMEOUT_MS}ms RETRIES=${ACK_MAX_RETRIES}`);

  // ===== 阶段1: 注册/登录 =====
  console.log(`[gw-harness] 阶段1: 注册/登录 ${CONNS} 个 bench 用户(并发 ${REG_CONCURRENCY})...`);
  const t1 = Date.now();
  const loginResults = await pooledMap(Array.from({ length: CONNS }, (_, i) => i), REG_CONCURRENCY, (i) => registerAndLogin(i));
  const users = [];
  for (const r of loginResults) {
    if (r.ok) users.push(r.value);
    else console.error(`[gw-harness] ${r.error.message}`);
  }
  console.log(`[gw-harness] 登录成功 ${users.length}/${CONNS},失败 ${CONNS - users.length},耗时 ${Date.now() - t1}ms`);
  if (users.length === 0) {
    console.error('[gw-harness] 无可用用户,无法继续建连,终止。请确认 server 已启动且 /api/register /api/login 可用。');
    printSummary(users.length, 0);
    process.exitCode = 1;
    return;
  }

  // ===== 阶段2: 爬坡建连 =====
  console.log(`[gw-harness] 阶段2: 建立 ws 连接(爬坡 ${RAMP}/s,共 ${users.length} 条,经 gateway /ws)...`);
  const clients = new Array(users.length).fill(null);
  const connectPromises = [];

  const launchOne = (user, i) => {
    const client = new GwClient(user, `bench-gw-${i}`);
    clients[i] = client;
    connectPromises.push(client.connect());
  };

  await new Promise((resolveRamp) => {
    let launched = 0;
    const launchBatch = () => {
      const batch = users.slice(launched, launched + RAMP);
      batch.forEach((u, bi) => launchOne(u, launched + bi));
      launched += batch.length;
      if (launched >= users.length) {
        clearInterval(timer);
        resolveRamp();
      }
    };
    const timer = setInterval(launchBatch, 1000);
    launchBatch(); // 首批立即发出(对齐旧 harness)
  });
  await Promise.all(connectPromises);

  const connectedClients = clients.filter((c) => c && c.openedOnce);
  const connectedCount = connectedClients.length;
  console.log(`[gw-harness] 建连完成: 成功 ${connectedCount}/${users.length}`);

  // ===== 阶段3: 稳态消息负载 =====
  const timers = [];
  if (connectedCount === 0) {
    console.error('[gw-harness] 无成功连接,跳过消息负载阶段。');
  } else if (RATE <= 0) {
    console.log('[gw-harness] RATE<=0,跳过消息负载阶段(仅测连接负载)。');
  } else {
    console.log(`[gw-harness] 阶段3: 稳态消息负载 ${DURATION}s,每连接 ${RATE} msg/s(可靠上行:ack/超时重发/心跳/重连)...`);

    // 相邻用户配对成单聊,奇数落单自聊(对齐旧 harness)
    const conversationIdOf = new Array(clients.length).fill(null);
    for (let k = 0; k < clients.length; k += 2) {
      const a = clients[k] ? users[k] : null;
      const b = k + 1 < clients.length && clients[k + 1] ? users[k + 1] : null;
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

    connectedClients.forEach((client, i) => {
      const convo = conversationIdOf[i];
      if (!convo) return;
      const sendOne = () => {
        const payload = {
          clientMsgId: randomUUID(),
          conversationId: convo,
          content: `bench gw message from ${client.user.username} @ ${Date.now()}`,
          type: 'text',
        };
        sentCount++; // 首次发送计数(重发单列 retriesSent,口径对齐旧 harness)
        client.sendMessage(payload).catch(() => { /* 失败已在 sendMessage 内分类计数 */ });
      };
      timers.push(setInterval(sendOne, 1000 / RATE));
    });

    await new Promise((r) => setTimeout(r, DURATION * 1000));
    timers.forEach(clearInterval);

    // 停发后留宽限期收尾 ack,再清理仍未确认的 pending(对齐旧 harness)
    const grace = Math.min(ACK_TIMEOUT_MS, 3000);
    console.log(`[gw-harness] 停止发送,等待 ${grace}ms 收尾 ack...`);
    await new Promise((r) => setTimeout(r, grace));
    for (const c of connectedClients) {
      for (const [cid, entry] of c.pending) {
        clearTimeout(entry.timer);
        c.pending.delete(cid);
        bumpError('message.ack_timeout');
      }
    }
  }

  // ===== 阶段4: 收尾 =====
  clients.forEach((c) => c?.close());
  await new Promise((r) => setTimeout(r, 500));

  printSummary(users.length, connectedCount);
}

function printSummary(totalUsers, connectedCount) {
  const connStats = summarize(connectTimes);
  const rttStats = summarize(rtts);
  const reconnStats = summarize(reconnectTimes);
  console.log('\n========== 压测结果(gateway/Go)==========');
  console.log(`用户注册/登录成功: ${totalUsers}`);
  console.log(`WS 连接成功: ${connectedCount} / 尝试 ${totalUsers}`);
  console.log(`连接建立耗时(ms): p50=${fmt(connStats.p50)} p95=${fmt(connStats.p95)} p99=${fmt(connStats.p99)} p999=${fmt(connStats.p999)} min=${fmt(connStats.min)} max=${fmt(connStats.max)} (n=${connStats.count})`);
  console.log(`消息发送数: ${sentCount}, 收到 ack 数: ${ackCount}, 超时重发帧数: ${retriesSent}`);
  console.log(`消息 RTT(ms): p50=${fmt(rttStats.p50)} p95=${fmt(rttStats.p95)} p99=${fmt(rttStats.p99)} p999=${fmt(rttStats.p999)} min=${fmt(rttStats.min)} max=${fmt(rttStats.max)} (n=${rttStats.count})`);
  console.log(`断线重连: 触发 ${reconnectEvents} 次, 成功 ${reconnectTimes.length} 次, 重连耗时(ms): p50=${fmt(reconnStats.p50)} p95=${fmt(reconnStats.p95)} p99=${fmt(reconnStats.p99)} max=${fmt(reconnStats.max)}`);
  console.log('错误分类计数:');
  if (errors.size === 0) {
    console.log('  (无)');
  } else {
    for (const [cat, count] of [...errors.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat}: ${count}`);
    }
  }
  console.log('=========================================\n');
}

main().catch((e) => {
  console.error('[gw-harness] 致命错误:', e);
  process.exitCode = 1;
});
