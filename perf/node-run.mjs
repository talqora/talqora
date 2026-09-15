#!/usr/bin/env node
// 纯 Node(socket.io) 性能测试编排器(无 gateway)。
// 跑 harness.mjs(socket.io 直连 server),运行中每 2s 采样 server 资源指标
// (RSS/连接数/eventloop lag/堆/GC/CPU),结束后查询服务内时延直方图分位,
// 产出结构化 JSON 落到 docs/监测设施/测试报告/26-9-14/data/(纯 Node 基线)。
//
// 用法:node node-run.mjs <label> [CONNS] [RATE] [DURATION] [RAMP]
// 例:  node node-run.mjs s1_throughput 100 10 20 25
//      node node-run.mjs s4_large_conn 500 1 15 50
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告', '26-9-14', 'data');
const PROM = process.env.PROM || 'http://localhost:9090';

const [label, CONNS = '100', RATE = '10', DURATION = '20', RAMP = '25'] = process.argv.slice(2);
if (!label) {
  console.error('用法: node node-run.mjs <label> [CONNS RATE DURATION RAMP]');
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

// macOS 上 Go 的 client_golang 进程采集器依赖 /proc(仅 Linux),不导出 process_resident_memory_bytes;
// 本编排器只管 Node server,RSS 用 ps 直接读进程(跨平台一致)。按端口解析 pid。
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
    const r = await fetch(`${PROM}/api/v1/query?` + new URLSearchParams({ query }));
    const j = await r.json();
    const v = j?.data?.result?.[0]?.value?.[1];
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}

// 直方图分位查询(服务内时延),返回 ms。rate 窗口 = 本次运行窗口。
async function promHistQuantile(metric, winSec, p) {
  const q = `histogram_quantile(${p}, sum(rate(${metric}[${winSec}s])) by (le))`;
  const v = await promInstant(q);
  return v != null ? +(v * 1000).toFixed(2) : null;
}

function parseSummary(text) {
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  const grp = (re) => {
    const m = text.match(re);
    return m ? m.slice(1).map(Number) : null;
  };
  const conn = grp(/连接建立耗时\(ms\): p50=(\S+) p95=(\S+) p99=(\S+) p999=(\S+) min=(\S+) max=(\S+) \(n=(\d+)\)/);
  const rtt = grp(/消息 RTT\(ms\): p50=(\S+) p95=(\S+) p99=(\S+) p999=(\S+) min=(\S+) max=(\S+) \(n=(\d+)\)/);
  const errs = {};
  const errBlock = text.split('错误分类计数:')[1] || '';
  for (const line of errBlock.split('\n')) {
    const m = line.match(/^\s{2}(\S+): (\d+)/);
    if (m) errs[m[1]] = Number(m[2]);
  }
  return {
    connectedCount: num(/(?:Socket|WS) 连接成功: (\d+)/),
    attempted: num(/尝试 (\d+)/),
    sent: num(/消息发送数: (\d+)/),
    ack: num(/收到 ack 数: (\d+)/),
    connectMs: conn ? { p50: conn[0], p95: conn[1], p99: conn[2], p999: conn[3], min: conn[4], max: conn[5], n: conn[6] } : null,
    rttMs: rtt ? { p50: rtt[0], p95: rtt[1], p99: rtt[2], p999: rtt[3], min: rtt[4], max: rtt[5], n: rtt[6] } : null,
    errors: errs,
  };
}

async function main() {
  const startedAt = Date.now();
  console.log(`[node-run] label=${label} CONNS=${CONNS} RATE=${RATE} DURATION=${DURATION} RAMP=${RAMP}`);
  const env = { ...process.env, CONNS, RATE, DURATION, RAMP };
  const child = spawn('node', [join(__dir, 'harness.mjs')], { env });
  let stdout = '';
  child.stdout.on('data', (d) => {
    stdout += d;
    process.stdout.write(d);
  });
  child.stderr.on('data', (d) => process.stderr.write(d));

  // 运行中每 2s 采样 server 资源指标
  const serverPid = pidOnPort(3007);
  const samples = {
    connections: [],
    serverRss: [],
    eventloopP99: [],
    heapMB: [],
    gcCount: [],
    cpuSeconds: [],
  };
  const poll = setInterval(async () => {
    const [c, el, heap, gc, cpu] = await Promise.all([
      promInstant('server_ws_connections'),
      promInstant('nodejs_eventloop_lag_p99_seconds{job="server"}'),
      promInstant('nodejs_heap_size_used_bytes{job="server"}'),
      promInstant('nodejs_gc_pause_seconds_count{job="server"}'),
      promInstant('process_cpu_seconds_total{job="server"}'),
    ]);
    const srss = rssMB(serverPid);
    if (c != null) samples.connections.push(c);
    if (srss != null) samples.serverRss.push(srss);
    if (el != null) samples.eventloopP99.push(el);
    if (heap != null) samples.heapMB.push(+(heap / 1048576).toFixed(1));
    if (gc != null) samples.gcCount.push(gc);
    if (cpu != null) samples.cpuSeconds.push(cpu);
  }, 2000);

  const code = await new Promise((res) => child.on('close', res));
  clearInterval(poll);
  const endedAt = Date.now();

  const max = (a) => (a.length ? Math.max(...a) : null);
  const first = (a) => (a.length ? a[0] : null);
  const last = (a) => (a.length ? a[a.length - 1] : null);
  const winSec = Math.max(1, Math.ceil((endedAt - startedAt) / 1000));

  // 结束后查窗口内各直方图分位(服务内视角)
  const q = (metric, p) => promHistQuantile(metric, winSec, p);
  const msgQ = async (p) => q('server_message_duration_seconds_bucket', p);
  const httpQ = async (p) => q('http_request_duration_seconds_bucket', p);
  const dbQ = async (p) => q('db_query_duration_seconds_bucket', p);
  const gcQ = async (p) => q('nodejs_gc_pause_seconds_bucket', p);
  const [m50, m95, m99, h50, h95, h99, d50, d95, d99, g50, g95, g99] = await Promise.all([
    msgQ(0.5), msgQ(0.95), msgQ(0.99),
    httpQ(0.5), httpQ(0.95), httpQ(0.99),
    dbQ(0.5), dbQ(0.95), dbQ(0.99),
    gcQ(0.5), gcQ(0.95), gcQ(0.99),
  ]);

  const cpuDelta = last(samples.cpuSeconds) != null && first(samples.cpuSeconds) != null
    ? last(samples.cpuSeconds) - first(samples.cpuSeconds)
    : null;

  const result = {
    label,
    mode: 'socketio', // 纯 Node:客户端 socket.io 直连 server,无 gateway 参与
    exitCode: code,
    params: { CONNS: +CONNS, RATE: +RATE, DURATION: +DURATION, RAMP: +RAMP },
    startedAt,
    endedAt,
    windowSec: winSec,
    harness: parseSummary(stdout),
    resource: {
      peakConnections: max(samples.connections),
      peakServerRssMB: max(samples.serverRss),
      baseServerRssMB: first(samples.serverRss),
      peakEventloopP99Ms: max(samples.eventloopP99) ? +(max(samples.eventloopP99) * 1000).toFixed(2) : null,
      peakHeapMB: max(samples.heapMB),
      gcPausesDelta: last(samples.gcCount) != null && first(samples.gcCount) != null
        ? last(samples.gcCount) - first(samples.gcCount)
        : null,
      cpuSecondsDelta: cpuDelta != null ? +cpuDelta.toFixed(2) : null,
    },
    serverInternalDurationMs: { p50: m50, p95: m95, p99: m99 },
    httpDurationMs: { p50: h50, p95: h95, p99: h99 },
    dbDurationMs: { p50: d50, p95: d95, p99: d99 },
    gcPauseMs: { p50: g50, p95: g95, p99: g99 },
  };
  const path = join(OUT_DIR, `${label}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`\n[node-run] 已写 ${path}`);
  console.log(
    `[node-run] 峰值: conn=${result.resource.peakConnections} serverRss=${result.resource.peakServerRssMB}MB heap=${result.resource.peakHeapMB}MB eventloopP99=${result.resource.peakEventloopP99Ms}ms gc+=${result.resource.gcPausesDelta} cpuΔ=${result.resource.cpuSecondsDelta}s`,
  );
}
main().catch((e) => {
  console.error('[node-run] 失败', e);
  process.exit(1);
});
