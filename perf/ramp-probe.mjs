#!/usr/bin/env node
// 连接爬坡探顶(纯 Node / socket.io):从 START 条连接开始,每级加 STEP 条并【保持】,
// 逐级记录建连成功率/耗时分布与 server 侧资源(连接数/eventloop/RSS),
// 直到建连成功率跌破阈值、eventloop 显著恶化或达到 MAX,输出拐点与各级数据。
// 数据落 docs/监测设施/测试报告/26-9-14/data/s6_ramp.json。
//
// 用法:node ramp-probe.mjs [START=500] [STEP=500] [MAX=3000] [HOLD_MS=5000]
import { io as ioClient } from 'socket.io-client';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告', '26-9-14', 'data');
const BASE = process.env.BASE || 'http://localhost:3007';
const START = parseInt(process.env.START || '500', 10);
const STEP = parseInt(process.env.STEP || '500', 10);
const MAX = parseInt(process.env.MAX || '3000', 10);
const HOLD_MS = parseInt(process.env.HOLD_MS || '5000', 10);
const REG_CONCURRENCY = parseInt(process.env.REG_CONCURRENCY || '20', 10);
const SUCCESS_THRESHOLD = parseFloat(process.env.SUCCESS_THRESHOLD || '0.9', 10); // 建连成功率红线
const LAG_THRESHOLD_MS = parseInt(process.env.LAG_THRESHOLD_MS || '200', 10); // eventloop p99 恶化红线
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
  return { status: res.status, json: await res.json() };
}
async function registerAndLogin(i) {
  const username = `bench_user_${i}`;
  const email = `${username}@bench.local`;
  let loginRes = await httpPost('/api/login', { username, password: PASSWORD });
  if (!loginRes.json?.success) {
    await httpPost('/api/register', { username, email, password: PASSWORD });
    loginRes = await httpPost('/api/login', { username, password: PASSWORD });
  }
  const token = loginRes.json.data?.token;
  const id = loginRes.json.data?.id;
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

function connectOne(user, i) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = ioClient(BASE, {
      auth: { token: user.token, deviceId: `ramp-${i}` },
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
  console.log(`[ramp] START=${START} STEP=${STEP} MAX=${MAX} HOLD=${HOLD_MS}ms 阈值:成功率<${SUCCESS_THRESHOLD} 或 lag>${LAG_THRESHOLD_MS}ms`);
  const serverPid = pidOnPort(3007);

  // 登录 MAX 个用户(一次登录够,各级共用)
  console.log(`[ramp] 阶段1: 注册/登录 ${MAX} 用户(并发 ${REG_CONCURRENCY},bcrypt 较慢请耐心)...`);
  const t1 = Date.now();
  const loginResults = await pooledMap(Array.from({ length: MAX }, (_, i) => i), REG_CONCURRENCY, (i) => registerAndLogin(i));
  const users = loginResults.filter((r) => r.ok).map((r) => r.value);
  console.log(`[ramp] 登录成功 ${users.length}/${MAX},耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  if (users.length === 0) {
    console.error('[ramp] 无可用用户,终止');
    process.exit(1);
  }

  const held = []; // 保持中的连接
  const levels = [];
  let stopReason = null;
  const startedAt = Date.now();

  let target = Math.min(START, users.length);
  while (target <= users.length && held.length < users.length) {
    const t0 = Date.now();
    console.log(`\n[ramp] ── 爬坡到 ${target} 连接(当前持有 ${held.length},本批 +${target - held.length})──`);
    // 本批并发建连(不限速,全量瞬间发起,模拟瞬时冲击)
    const batchResults = await Promise.all(
      users.slice(held.length, target).map((u, bi) => connectOne(u, held.length + bi)),
    );
    const times = [];
    batchResults.forEach((r) => {
      if (r.ok) {
        times.push(r.ms);
        held.push(r.socket);
      }
    });
    const okCount = times.length;
    const successRate = okCount / batchResults.length;
    const connStat = summarize(times);
    console.log(`[ramp]   建连 ${okCount}/${batchResults.length} (${(successRate * 100).toFixed(1)}%),耗时 p50=${connStat.p50}ms p95=${connStat.p95}ms p99=${connStat.p99}ms max=${connStat.max}ms`);

    // 保持 HOLD_MS 观察稳态指标
    await new Promise((r) => setTimeout(r, HOLD_MS));
    const lag = await promInstant('nodejs_eventloop_lag_p99_seconds{job="server"}');
    const connGauge = await promInstant('server_ws_connections');
    const rss = rssMB(serverPid);
    const lagMs = lag != null ? +(lag * 1000).toFixed(2) : null;
    console.log(`[ramp]   稳态: server连接数=${connGauge} eventloopP99=${lagMs}ms serverRSS=${rss}MB`);

    levels.push({
      target,
      batchAttempted: batchResults.length,
      batchOk: okCount,
      successRate: +successRate.toFixed(4),
      connectMs: connStat,
      heldAfter: held.length,
      serverConnections: connGauge,
      eventloopP99Ms: lagMs,
      serverRssMB: rss,
    });

    // 拐点判定
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
  held.forEach((s) => {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  });
  await new Promise((r) => setTimeout(r, 2000));

  const peakLevel = levels.length ? levels.reduce((a, b) => (b.heldAfter >= a.heldAfter ? b : a)) : null;
  const result = {
    label: 's6_ramp',
    mode: 'socketio',
    params: { START, STEP, MAX, HOLD_MS, SUCCESS_THRESHOLD, LAG_THRESHOLD_MS },
    startedAt,
    endedAt: Date.now(),
    stopReason,
    levels,
    summary: {
      maxStableConnections: peakLevel?.heldAfter ?? 0,
      peakLevelServerRssMB: peakLevel?.serverRssMB ?? null,
      peakLevelEventloopP99Ms: peakLevel?.eventloopP99Ms ?? null,
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 's6_ramp.json');
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`\n[ramp] 结束: ${stopReason}`);
  console.log(`[ramp] 最大稳定连接数(探到) = ${result.summary.maxStableConnections}`);
  console.log(`[ramp] 已写 ${path}`);
}

main().catch((e) => {
  console.error('[ramp] 失败:', e);
  process.exit(1);
});
