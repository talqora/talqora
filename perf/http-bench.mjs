#!/usr/bin/env node
// HTTP API 层压测(纯 Node,补 RED 的 HTTP 盲区):对 server 的典型 HTTP 接口
// 逐个做并发持续压测,统计吞吐(req/s)、时延分位、错误分类,并采样 server 资源。
// 数据落 docs/监测设施/测试报告/26-9-14/data/http_bench.json。
//
// 用法:node http-bench.mjs [CONCURRENCY=20] [DURATION=10]
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告', '26-9-14', 'data');
const BASE = process.env.BASE || 'http://localhost:3007';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '20', 10);
const DURATION = parseInt(process.env.DURATION || '10', 10);
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
    p999: percentile(sorted, 99.9),
    min: sorted.length ? sorted[0] : NaN,
    max: sorted.length ? sorted[sorted.length - 1] : NaN,
  };
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

async function httpPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// 登录 bench_user_0 拿 token/id,并确定一个合法单聊会话 id(单聊成员从 id 直接解析)。
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

async function main() {
  console.log(`[http-bench] BASE=${BASE} CONCURRENCY=${CONCURRENCY} DURATION=${DURATION}s`);
  const serverPid = pidOnPort(3007);
  const a = await loginOne(0);
  const b = await loginOne(1);
  const conv = `single_${Math.min(a.id, b.id)}_${Math.max(a.id, b.id)}`;

  const targets = [
    { name: 'GET /health', method: 'GET', path: '/health', auth: false },
    { name: 'POST /api/login (bcrypt)', method: 'POST', path: '/api/login', body: { username: 'bench_user_0', password: PASSWORD }, auth: false },
    { name: 'GET /user/userConversations', method: 'GET', path: `/user/userConversations?userId=${a.id}`, auth: true },
    { name: 'GET /user/messages', method: 'GET', path: `/user/messages?conversationId=${conv}`, auth: true },
    { name: 'GET /user/lastMessages', method: 'GET', path: `/user/lastMessages?userConversationIds=${encodeURIComponent(JSON.stringify([conv]))}`, auth: true },
    { name: 'GET /user/sync', method: 'GET', path: `/user/sync?conv=${conv}&since=0&limit=50`, auth: true },
    { name: 'GET /user/mentions', method: 'GET', path: `/user/mentions`, auth: true },
  ];

  const results = [];
  const startedAt = Date.now();

  for (const t of targets) {
    const latencies = [];
    const statusCount = new Map();
    let running = true;

    async function worker() {
      while (running) {
        const t0 = Date.now();
        try {
          const headers = {};
          if (t.auth) headers.Authorization = `Bearer ${a.token}`;
          if (t.body) headers['Content-Type'] = 'application/json';
          const res = await fetch(`${BASE}${t.path}`, {
            method: t.method,
            headers,
            body: t.body ? JSON.stringify(t.body) : undefined,
          });
          latencies.push(Date.now() - t0);
          statusCount.set(res.status, (statusCount.get(res.status) || 0) + 1);
          try {
            await res.text(); // 消费响应体,释放连接
          } catch {
            /* ignore */
          }
        } catch (e) {
          statusCount.set('error', (statusCount.get('error') || 0) + 1);
        }
      }
    }

    console.log(`[http-bench] 压测 ${t.name} ...`);
    const start = Date.now();
    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await new Promise((r) => setTimeout(r, DURATION * 1000));
    running = false;
    await Promise.all(workers);
    const wallSec = (Date.now() - start) / 1000;

    const stat = summarize(latencies);
    const rps = +(latencies.length / wallSec).toFixed(1);
    const errCount = [...statusCount.entries()].filter(([s]) => s !== 200 && s !== 204).reduce((a, [, c]) => a + c, 0);
    results.push({
      target: t.name,
      method: t.method,
      rps,
      total: latencies.length,
      wallSec: +wallSec.toFixed(2),
      latencyMs: { p50: stat.p50, p95: stat.p95, p99: stat.p99, p999: stat.p999, min: stat.min, max: stat.max },
      status: Object.fromEntries(statusCount),
      errors: errCount,
    });
    console.log(`    rps=${rps} p50=${stat.p50}ms p95=${stat.p95}ms p99=${stat.p99}ms 状态=${JSON.stringify(Object.fromEntries(statusCount))}`);
  }

  // 采样 server 资源(压测后峰值)
  const [rss, lag, cpu] = await Promise.all([
    rssMB(serverPid),
    promInstant('nodejs_eventloop_lag_p99_seconds{job="server"}'),
    promInstant('process_cpu_seconds_total{job="server"}'),
  ]);

  const result = {
    label: 'http_bench',
    mode: 'http',
    params: { CONCURRENCY, DURATION, userId: a.id, conversationId: conv },
    startedAt,
    endedAt: Date.now(),
    targets: results,
    resource: {
      serverRssMB: rss,
      eventloopP99Ms: lag != null ? +(lag * 1000).toFixed(2) : null,
      cpuSecondsTotal: cpu,
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 'http_bench.json');
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`\n[http-bench] 已写 ${path}`);
}

main().catch((e) => {
  console.error('[http-bench] 失败:', e);
  process.exit(1);
});
