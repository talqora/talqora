#!/usr/bin/env node
// 惊群重连测试(gateway/Go 路径):N 条已鉴权 WS 连接稳态保持后「同一瞬间全部断开」,
// 再「同一瞬间全部重连」,测量重连成功率、重连耗时分布与双侧资源尖峰
// (gateway 连接数回升曲线 / goroutine / gateway+server RSS / server eventloop)。
// 数据落 docs/监测设施/测试报告/<期目录>/data/s7_storm_gateway.json(期目录 env OUT_SUBDIR,默认 26-9-16)。
//
// 用法:node gw-storm-reconnect.mjs [CONNS=300] [RAMP=50]
import WebSocket from 'ws';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告', process.env.OUT_SUBDIR || '26-9-16', 'data');
const BASE = process.env.BASE || 'http://localhost:3007';
const GW = process.env.GW || 'ws://localhost:8090/ws';
const CONNS = parseInt(process.env.CONNS || '300', 10);
const RAMP = parseInt(process.env.RAMP || '50', 10);
const REG_CONCURRENCY = parseInt(process.env.REG_CONCURRENCY || '20', 10);
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

// 单条 WS 建连(不重连、超时 10s);成功保活(心跳 25s)
function connectOne(user, i) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ws = new WebSocket(`${GW}?deviceId=storm-gw-${i}&token=${encodeURIComponent(user.token)}`);
    let done = false;
    let hbTimer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (hbTimer) clearInterval(hbTimer);
      if (!ok) { try { ws.close(); } catch { /* ignore */ } resolve({ ok: false, ms: null, ws: null }); }
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
    ws.on('unexpected-response', () => finish(false));
    ws.on('error', () => { /* 统一在 close 收口 */ });
    ws.on('close', () => { clearTimeout(timer); if (!done) finish(false); });
  });
}

async function main() {
  console.log(`[gw-storm] BASE=${BASE} GW=${GW} CONNS=${CONNS} RAMP=${RAMP}/s`);
  const serverPid = pidOnPort(3007);
  const gatewayPid = pidOnPort(8090);

  // 阶段1: 注册/登录
  console.log(`[gw-storm] 阶段1: 注册/登录 ${CONNS} 用户(并发 ${REG_CONCURRENCY})...`);
  const t1 = Date.now();
  const loginResults = await pooledMap(Array.from({ length: CONNS }, (_, i) => i), REG_CONCURRENCY, (i) => registerAndLogin(i));
  const users = loginResults.filter((r) => r.ok).map((r) => r.value);
  console.log(`[gw-storm] 登录成功 ${users.length}/${CONNS},耗时 ${Date.now() - t1}ms`);
  if (users.length === 0) {
    console.error('[gw-storm] 无可用用户,终止');
    process.exit(1);
  }

  // 阶段2: 初次建连(爬坡)
  console.log(`[gw-storm] 阶段2: 初次建连(爬坡 ${RAMP}/s)...`);
  const firstConnTimes = [];
  const firstResults = [];
  {
    let launched = 0;
    await new Promise((resolveRamp) => {
      const launchBatch = () => {
        const batch = users.slice(launched, launched + RAMP);
        batch.forEach((u, bi) => {
          const idx = launched + bi;
          connectOne(u, idx).then((r) => {
            firstResults[idx] = r;
            if (r.ok) firstConnTimes.push(r.ms);
          });
        });
        launched += batch.length;
        if (launched >= users.length) {
          clearInterval(timer);
          resolveRamp();
        }
      };
      const timer = setInterval(launchBatch, 1000);
      launchBatch();
    });
  }
  await new Promise((r) => setTimeout(r, Math.min(15000, Math.max(3000, RAMP))));
  const firstOk = firstResults.filter((r) => r?.ok).length;
  console.log(`[gw-storm] 初次建连成功 ${firstOk}/${users.length}`);

  // 阶段3: 稳态保持 5s,采集断连前基线
  await new Promise((r) => setTimeout(r, 5000));
  const [baselineGwRss, baselineSrvRss, baselineGwConn, baselineGoroutines, baselineLag] = await Promise.all([
    Promise.resolve(rssMB(gatewayPid)),
    Promise.resolve(rssMB(serverPid)),
    promInstant('gateway_connections'),
    promInstant('go_goroutines{job="gateway"}'),
    promInstant('nodejs_eventloop_lag_p99_seconds{job="server"}'),
  ]);

  // 阶段4: 惊群断开(同一 tick 内全部 close)
  console.log('[gw-storm] 阶段4: 惊群断开...');
  const tDisconnect = Date.now();
  firstResults.forEach((r) => {
    try { r?.ws?.close(); } catch { /* ignore */ }
  });
  await new Promise((r) => setTimeout(r, 3000)); // 等 gateway 感知断连(presence 摘除)

  // 阶段5: 惊群重连(同一 tick 内全部重新发起连接)
  console.log('[gw-storm] 阶段5: 惊群重连(全量同一瞬间发起)...');
  const tReconnectStart = Date.now();
  const reconnectTimes = [];
  const reconnectResults = await Promise.all(users.map((u, i) => connectOne(u, i)));
  reconnectResults.forEach((r) => {
    if (r.ok) reconnectTimes.push(r.ms);
  });
  const reconnectOk = reconnectResults.filter((r) => r.ok).length;

  // 阶段6: 重连后保持 8s,高频采样资源尖峰(重连瞬间 + 恢复期)
  const samples = { gwRss: [], srvRss: [], gwConn: [], goro: [], lag: [] };
  const spikeUntil = Date.now() + 8000;
  while (Date.now() < spikeUntil) {
    samples.gwRss.push(rssMB(gatewayPid));
    samples.srvRss.push(rssMB(serverPid));
    samples.gwConn.push(await promInstant('gateway_connections'));
    samples.goro.push(await promInstant('go_goroutines{job="gateway"}'));
    samples.lag.push(await promInstant('nodejs_eventloop_lag_p99_seconds{job="server"}'));
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tDone = Date.now();
  const finalConn = await promInstant('gateway_connections');

  // 收尾:断开全部重连上的连接
  reconnectResults.forEach((r) => {
    try { r?.ws?.close(); } catch { /* ignore */ }
  });

  const maxOf = (a) => (a.filter((v) => v != null).length ? Math.max(...a.filter((v) => v != null)) : null);
  const result = {
    label: 's7_storm_gateway',
    mode: 'gateway',
    params: { CONNS, RAMP },
    startedAt: Date.now() - (tDone - tDisconnect) - 5000,
    endedAt: tDone,
    initialConnect: { ok: firstOk, attempted: users.length, ...summarize(firstConnTimes) },
    stormDisconnect: { allClosedAt: tDisconnect },
    stormReconnect: {
      startedAt: tReconnectStart,
      ok: reconnectOk,
      attempted: users.length,
      ...summarize(reconnectTimes),
    },
    resource: {
      baselineGatewayRssMB: baselineGwRss,
      baselineServerRssMB: baselineSrvRss,
      baselineGatewayConnections: baselineGwConn,
      baselineGoroutines: baselineGoroutines,
      baselineEventloopP99Ms: baselineLag != null ? +(baselineLag * 1000).toFixed(2) : null,
      spikePeakGatewayRssMB: maxOf(samples.gwRss),
      spikePeakServerRssMB: maxOf(samples.srvRss),
      spikePeakGatewayConnections: maxOf(samples.gwConn),
      spikePeakGoroutines: maxOf(samples.goro),
      spikePeakEventloopP99Ms: maxOf(samples.lag) != null ? +(maxOf(samples.lag) * 1000).toFixed(2) : null,
      finalConnections: finalConn,
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 's7_storm_gateway.json');
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log('\n========== 惊群重连结果(gateway/Go)==========');
  console.log(`初次建连: ${firstOk}/${users.length} 成功,耗时 p50=${summarize(firstConnTimes).p50}ms p95=${summarize(firstConnTimes).p95}ms p99=${summarize(firstConnTimes).p99}ms`);
  console.log(`惊群重连: ${reconnectOk}/${users.length} 成功,耗时 p50=${summarize(reconnectTimes).p50}ms p95=${summarize(reconnectTimes).p95}ms p99=${summarize(reconnectTimes).p99}ms`);
  console.log(`资源: gatewayRSS ${baselineGwRss}→${result.resource.spikePeakGatewayRssMB}MB, serverRSS ${baselineSrvRss}→${result.resource.spikePeakServerRssMB}MB, gwConn ${baselineGwConn}→${result.resource.spikePeakGatewayConnections}, goroutines ${baselineGoroutines}→${result.resource.spikePeakGoroutines}, eventloopP99 ${result.resource.baselineEventloopP99Ms}→${result.resource.spikePeakEventloopP99Ms}ms`);
  console.log(`已写 ${path}`);
  console.log('===============================================');
}

main().catch((e) => {
  console.error('[gw-storm] 失败:', e);
  process.exit(1);
});
