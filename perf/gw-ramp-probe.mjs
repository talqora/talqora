#!/usr/bin/env node
// 连接爬坡探顶(gateway/Go 路径):从 START 条连接开始,每级加 STEP 条并【保持】,
// 逐级记录建连成功率/耗时分布与双侧资源(gateway 连接数/goroutine/RSS + server eventloop/RSS),
// 直到建连成功率跌破阈值、eventloop 显著恶化或达到 MAX,输出拐点与各级数据。
// 数据落 docs/监测设施/测试报告/<期目录>/data/s6_ramp_gateway.json(期目录 env OUT_SUBDIR,默认 26-9-16)。
//
// 用法(参数走环境变量,与 ramp-probe.mjs 对齐):
//   env START=2000 STEP=2000 MAX=10000 HOLD_MS=5000 node gw-ramp-probe.mjs
import WebSocket from 'ws';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告', process.env.OUT_SUBDIR || '26-9-16', 'data');
const BASE = process.env.BASE || 'http://localhost:3007';
const GW = process.env.GW || 'ws://localhost:8090/ws';
const START = parseInt(process.env.START || '2000', 10);
const STEP = parseInt(process.env.STEP || '2000', 10);
const MAX = parseInt(process.env.MAX || '10000', 10);
const HOLD_MS = parseInt(process.env.HOLD_MS || '5000', 10);
const REG_CONCURRENCY = parseInt(process.env.REG_CONCURRENCY || '20', 10);
const SUCCESS_THRESHOLD = parseFloat(process.env.SUCCESS_THRESHOLD || '0.9', 10);
const LAG_THRESHOLD_MS = parseInt(process.env.LAG_THRESHOLD_MS || '200', 10);
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
async function registerAndLogin(i) {
  const username = `bench_user_${i}`;
  const email = `${username}@bench.local`;
  let loginRes = await httpPost('/api/login', { username, password: PASSWORD });
  if (!loginRes.json?.success) {
    await httpPost('/api/register', { username, email, password: PASSWORD });
    loginRes = await httpPost('/api/login', { username, password: PASSWORD });
  }
  const token = loginRes.json?.data?.token;
  const id = loginRes.json?.data?.id;
  if (!token || id == null) throw new Error(`登录失败(${username})`);
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
function pidOnPort(port) {
  try {
    return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' }).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}
function rssMB(pid) {
  if (!pid) return null;
  try {
    const kb = Number(execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim());
    return kb ? +(kb / 1024).toFixed(1) : null;
  } catch {
    return null;
  }
}
async function promInstant(query) {
  try {
    const r = await fetch(`http://localhost:9090/api/v1/query?` + new URLSearchParams({ query }));
    const j = await r.json();
    const v = j?.data?.result?.[0]?.value?.[1];
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}

// 单条 WS 建连(query token/deviceId);成功保活(心跳 25s),失败分类计数。
function connectOne(user, i, heldCount) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const deviceId = `ramp-gw-${heldCount + i}`;
    const ws = new WebSocket(`${GW}?deviceId=${deviceId}&token=${encodeURIComponent(user.token)}`);
    let done = false;
    let hbTimer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (hbTimer) clearInterval(hbTimer);
      if (!ok) { try { ws.close(); } catch { /* ignore */ } resolve({ ok: false, ms: null }); }
      else resolve({ ok: true, ms: Date.now() - t0, ws });
    };
    const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    ws.on('open', () => {
      clearTimeout(timer);
      hbTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'heartbeat' })); } catch { /* ignore */ }
        }
      }, 25000);
      finish(true);
    });
    ws.on('unexpected-response', (_req, res) => finish(false));
    ws.on('error', () => { /* 统一在 close 收口 */ });
    ws.on('close', () => { clearTimeout(timer); if (!done) finish(false); });
  });
}

async function main() {
  console.log(`[gw-ramp] START=${START} STEP=${STEP} MAX=${MAX} HOLD=${HOLD_MS}ms 阈值:成功率<${SUCCESS_THRESHOLD} 或 eventloop>${LAG_THRESHOLD_MS}ms`);
  const serverPid = pidOnPort(3007);
  const gatewayPid = pidOnPort(8090);

  // 登录 MAX 个用户(一次登录够,各级共用;bcrypt 较慢请耐心)
  console.log(`[gw-ramp] 阶段1: 注册/登录 ${MAX} 用户(并发 ${REG_CONCURRENCY})...`);
  const t1 = Date.now();
  const loginResults = await pooledMap(Array.from({ length: MAX }, (_, i) => i), REG_CONCURRENCY, (i) => registerAndLogin(i));
  const users = loginResults.filter((r) => r.ok).map((r) => r.value);
  console.log(`[gw-ramp] 登录成功 ${users.length}/${MAX},耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  if (users.length === 0) {
    console.error('[gw-ramp] 无可用用户,终止');
    process.exit(1);
  }

  const held = []; // 保持中的 ws 连接
  const levels = [];
  let stopReason = null;
  const startedAt = Date.now();

  let target = Math.min(START, users.length);
  while (target <= users.length && held.length < users.length) {
    const t0 = Date.now();
    console.log(`\n[gw-ramp] ── 爬坡到 ${target} 连接(当前持有 ${held.length},本批 +${target - held.length})──`);
    // 本批并发建连(不限速,全量瞬间发起,模拟瞬时冲击;对齐 ramp-probe.mjs)
    const batchResults = await Promise.all(
      users.slice(held.length, target).map((u, bi) => connectOne(u, bi, held.length)),
    );
    const times = [];
    batchResults.forEach((r) => {
      if (r.ok) {
        times.push(r.ms);
        held.push(r.ws);
      }
    });
    const okCount = times.length;
    const successRate = okCount / batchResults.length;
    const connStat = summarize(times);
    console.log(`[gw-ramp]   建连 ${okCount}/${batchResults.length} (${(successRate * 100).toFixed(1)}%),耗时 p50=${connStat.p50}ms p95=${connStat.p95}ms p99=${connStat.p99}ms max=${connStat.max}ms`);

    // 保持 HOLD_MS 观察稳态指标
    await new Promise((r) => setTimeout(r, HOLD_MS));
    const [gwConn, goroutines, el, gwRss, srvRss] = await Promise.all([
      promInstant('gateway_connections'),
      promInstant('go_goroutines{job="gateway"}'),
      promInstant('nodejs_eventloop_lag_p99_seconds{job="server"}'),
      Promise.resolve(rssMB(gatewayPid)),
      Promise.resolve(rssMB(serverPid)),
    ]);
    const lagMs = el != null ? +(el * 1000).toFixed(2) : null;
    console.log(`[gw-ramp]   稳态: gateway连接数=${gwConn} goroutines=${goroutines} eventloopP99=${lagMs}ms gatewayRSS=${gwRss}MB serverRSS=${srvRss}MB`);

    levels.push({
      target,
      batchAttempted: batchResults.length,
      batchOk: okCount,
      successRate: +successRate.toFixed(4),
      connectMs: connStat,
      heldAfter: held.length,
      gatewayConnections: gwConn,
      goroutines,
      eventloopP99Ms: lagMs,
      gatewayRssMB: gwRss,
      serverRssMB: srvRss,
    });

    // 拐点判定(与基线同阈值)
    if (successRate < SUCCESS_THRESHOLD) {
      stopReason = `建连成功率 ${(successRate * 100).toFixed(1)}% < ${(SUCCESS_THRESHOLD * 100).toFixed(0)}%`;
      break;
    }
    if (lagMs != null && lagMs > LAG_THRESHOLD_MS) {
      stopReason = `eventloop p99 ${lagMs}ms > ${LAG_THRESHOLD_MS}ms`;
      break;
    }
    if (held.length >= users.length || target >= MAX) {
      stopReason = `达到 MAX=${MAX}(用户数 ${users.length})`;
      break;
    }
    target = Math.min(target + STEP, MAX, users.length);
  }

  // 收尾:断开所有保持中的连接
  held.forEach((ws) => {
    try { ws.close(); } catch { /* ignore */ }
  });
  await new Promise((r) => setTimeout(r, 2000));

  const peakLevel = levels.length ? levels.reduce((a, b) => (b.heldAfter >= a.heldAfter ? b : a)) : null;
  const result = {
    label: 's6_ramp_gateway',
    mode: 'gateway',
    params: { START, STEP, MAX, HOLD_MS, SUCCESS_THRESHOLD, LAG_THRESHOLD_MS },
    startedAt,
    endedAt: Date.now(),
    stopReason,
    levels,
    summary: {
      maxStableConnections: peakLevel?.heldAfter ?? 0,
      peakLevelGatewayRssMB: peakLevel?.gatewayRssMB ?? null,
      peakLevelServerRssMB: peakLevel?.serverRssMB ?? null,
      peakLevelGoroutines: peakLevel?.goroutines ?? null,
      peakLevelEventloopP99Ms: peakLevel?.eventloopP99Ms ?? null,
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 's6_ramp_gateway.json');
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`\n[gw-ramp] 结束: ${stopReason}`);
  console.log(`[gw-ramp] 最大稳定连接数(探到) = ${result.summary.maxStableConnections}`);
  console.log(`[gw-ramp] 已写 ${path}`);
}

main().catch((e) => {
  console.error('[gw-ramp] 失败:', e);
  process.exit(1);
});
