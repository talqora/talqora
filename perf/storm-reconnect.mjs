#!/usr/bin/env node
// 惊群重连测试(纯 Node / socket.io):N 条已鉴权连接稳态保持后「同一瞬间全部断开」,
// 再「同一瞬间全部重连」,测量重连成功率、重连耗时分布与 server 侧资源尖峰
// (连接数回升曲线 / eventloop lag / RSS)。数据落 docs/监测设施/测试报告/26-9-14/data/。
//
// 用法:node storm-reconnect.mjs [CONNS=300] [RAMP=50]
import { io as ioClient } from 'socket.io-client';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告', '26-9-14', 'data');
const BASE = process.env.BASE || 'http://localhost:3007';
const CONNS = parseInt(process.env.CONNS || '300', 10);
const RAMP = parseInt(process.env.RAMP || '50', 10);
const REG_CONCURRENCY = parseInt(process.env.REG_CONCURRENCY || '20', 10);
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

// 建立单条已鉴权连接,返回 { ok, ms }(不重连、超时 10s)
function connectOne(user, i) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = ioClient(BASE, {
      auth: { token: user.token, deviceId: `storm-${i}` },
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
  console.log(`[storm] BASE=${BASE} CONNS=${CONNS} RAMP=${RAMP}/s`);
  const serverPid = pidOnPort(3007);

  // 阶段1: 注册/登录
  console.log(`[storm] 阶段1: 注册/登录 ${CONNS} 用户(并发 ${REG_CONCURRENCY})...`);
  const t1 = Date.now();
  const loginResults = await pooledMap(
    Array.from({ length: CONNS }, (_, i) => i),
    REG_CONCURRENCY,
    (i) => registerAndLogin(i),
  );
  const users = loginResults.filter((r) => r.ok).map((r) => r.value);
  console.log(`[storm] 登录成功 ${users.length}/${CONNS},耗时 ${Date.now() - t1}ms`);
  if (users.length === 0) {
    console.error('[storm] 无可用用户,终止');
    process.exit(1);
  }

  // 阶段2: 初次建连(爬坡)
  console.log(`[storm] 阶段2: 初次建连(爬坡 ${RAMP}/s)...`);
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
  // 等建连收尾(首批已在途,给最长 15s 缓冲)
  await new Promise((r) => setTimeout(r, Math.min(15000, Math.max(3000, RAMP))));
  const firstOk = firstResults.filter((r) => r?.ok).length;
  console.log(`[storm] 初次建连成功 ${firstOk}/${users.length}`);

  // 阶段3: 稳态保持 5s,采集断连前基线
  await new Promise((r) => setTimeout(r, 5000));
  const baselineRss = rssMB(serverPid);
  const baselineConn = await promInstant('server_ws_connections');
  const baselineLag = await promInstant('nodejs_eventloop_lag_p99_seconds{job="server"}');

  // 阶段4: 惊群断开(同一 tick 内全部 close)
  console.log('[storm] 阶段4: 惊群断开...');
  const tDisconnect = Date.now();
  firstResults.forEach((r) => {
    try {
      r?.socket?.close();
    } catch {
      /* ignore */
    }
  });
  // 等待 server 感知断连(presence 摘除等)
  await new Promise((r) => setTimeout(r, 3000));

  // 阶段5: 惊群重连(同一 tick 内全部重新发起连接)
  console.log('[storm] 阶段5: 惊群重连(全量同一瞬间发起)...');
  const tReconnectStart = Date.now();
  const reconnectTimes = [];
  const reconnectResults = await Promise.all(users.map((u, i) => connectOne(u, i)));
  reconnectResults.forEach((r) => {
    if (r.ok) reconnectTimes.push(r.ms);
  });
  const reconnectOk = reconnectResults.filter((r) => r.ok).length;

  // 阶段6: 重连后保持 5s,高频采样资源尖峰(重连瞬间 + 恢复期)
  const samples = { rss: [], conn: [], lag: [] };
  const spikeUntil = Date.now() + 8000;
  while (Date.now() < spikeUntil) {
    samples.rss.push(rssMB(serverPid));
    samples.conn.push(await promInstant('server_ws_connections'));
    samples.lag.push(await promInstant('nodejs_eventloop_lag_p99_seconds{job="server"}'));
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tDone = Date.now();
  const finalConn = await promInstant('server_ws_connections');

  // 收尾:断开全部重连上的连接
  reconnectResults.forEach((r) => {
    try {
      r?.socket?.close();
    } catch {
      /* ignore */
    }
  });

  const result = {
    label: 's7_storm',
    mode: 'socketio',
    params: { CONNS, RAMP },
    startedAt: Date.now() - (tDone - tDisconnect) - 5000, // 近似起始
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
      baselineServerRssMB: baselineRss,
      baselineConnections: baselineConn,
      baselineEventloopP99Ms: baselineLag != null ? +(baselineLag * 1000).toFixed(2) : null,
      spikePeakServerRssMB: samples.rss.filter((v) => v != null).length ? Math.max(...samples.rss.filter((v) => v != null)) : null,
      spikePeakConnections: samples.conn.filter((v) => v != null).length ? Math.max(...samples.conn.filter((v) => v != null)) : null,
      spikePeakEventloopP99Ms: samples.lag.filter((v) => v != null).length
        ? +(Math.max(...samples.lag.filter((v) => v != null)) * 1000).toFixed(2)
        : null,
      finalConnections: finalConn,
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 's7_storm.json');
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log('\n========== 惊群重连结果 ==========');
  console.log(`初次建连: ${firstOk}/${users.length} 成功,耗时 p50=${summarize(firstConnTimes).p50}ms p95=${summarize(firstConnTimes).p95}ms p99=${summarize(firstConnTimes).p99}ms`);
  console.log(`惊群重连: ${reconnectOk}/${users.length} 成功,耗时 p50=${summarize(reconnectTimes).p50}ms p95=${summarize(reconnectTimes).p95}ms p99=${summarize(reconnectTimes).p99}ms`);
  console.log(`资源: RSS ${baselineRss}MB→${result.resource.spikePeakServerRssMB}MB, conn ${baselineConn}→${result.resource.spikePeakConnections}, eventloopP99 ${result.resource.baselineEventloopP99Ms}→${result.resource.spikePeakEventloopP99Ms}ms`);
  console.log(`已写 ${path}`);
  console.log('==================================');
}

main().catch((e) => {
  console.error('[storm] 失败:', e);
  process.exit(1);
});
