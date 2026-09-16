// A/B 单次运行编排器:跑一个 harness(socketio 或 gateway),运行中采样 Prometheus 资源指标,
// 结束后解析 harness 统计 + 查询消息时延分位,产出结构化 JSON 落盘到 测试报告/data/。
// 用法:node ab-run.mjs <mode socketio|gateway> <label> [CONNS] [RATE] [DURATION] [RAMP]
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告', 'data');
const PROM = process.env.PROM || 'http://localhost:9090';

const [mode, label, CONNS = '100', RATE = '10', DURATION = '20', RAMP = '25'] = process.argv.slice(2);
if (!mode || !label) { console.error('用法: node ab-run.mjs <socketio|gateway> <label> [CONNS RATE DURATION RAMP]'); process.exit(1); }
const harnessFile = mode === 'gateway' ? 'harness-gw.mjs' : 'harness.mjs';

// macOS 上 Go 的 client_golang 进程采集器依赖 /proc(仅 Linux),不导出 process_resident_memory_bytes,
// 故 RSS 统一用 ps 直接读进程(跨平台一致)。按端口解析 pid。
function pidOnPort(port) {
  try { return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' }).trim().split('\n')[0] || null; }
  catch { return null; }
}
function rssMB(pid) {
  if (!pid) return null;
  try { const kb = Number(execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim()); return kb ? +(kb / 1024).toFixed(1) : null; }
  catch { return null; }
}

async function promInstant(query) {
  try {
    const r = await fetch(`${PROM}/api/v1/query?` + new URLSearchParams({ query }));
    const j = await r.json();
    const v = j?.data?.result?.[0]?.value?.[1];
    return v == null ? null : Number(v);
  } catch { return null; }
}

function parseSummary(text) {
  const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : null; };
  const grp = (re) => { const m = text.match(re); return m ? m.slice(1).map(Number) : null; };
  // harness-gw 与 harness 均输出 p999(口径一致)
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
    retriesSent: num(/超时重发帧数: (\d+)/),
    reconnectsTriggered: num(/断线重连: 触发 (\d+) 次/),
    connectMs: conn ? { p50: conn[0], p95: conn[1], p99: conn[2], p999: conn[3], min: conn[4], max: conn[5], n: conn[6] } : null,
    rttMs: rtt ? { p50: rtt[0], p95: rtt[1], p99: rtt[2], p999: rtt[3], min: rtt[4], max: rtt[5], n: rtt[6] } : null,
    errors: errs,
  };
}

async function main() {
  const startedAt = Date.now();
  console.log(`[ab-run] mode=${mode} label=${label} CONNS=${CONNS} RATE=${RATE} DURATION=${DURATION}`);
  const env = { ...process.env, CONNS, RATE, DURATION, RAMP };
  const child = spawn('node', [join(__dir, harnessFile)], { env });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
  child.stderr.on('data', (d) => process.stderr.write(d));

  // 运行中每 2s 采样资源指标(server 与 gateway 两进程 RSS 用 ps 采,footprint 才完整)
  const serverPid = pidOnPort(3007);
  const gatewayPid = pidOnPort(8090);
  const samples = {
    connections: [], serverRss: [], gatewayRss: [], eventloopP99: [], goroutines: [],
    goGcSum: [], nodeGcCount: [], serverCpu: [], gatewayCpu: [],
  };
  const connMetric = mode === 'gateway' ? 'gateway_connections' : 'server_ws_connections';
  const poll = setInterval(async () => {
    const [c, el, gr, goGc, ngc, scpu, gcpu] = await Promise.all([
      promInstant(connMetric),
      promInstant(`nodejs_eventloop_lag_p99_seconds{job="server"}`),
      promInstant(`go_goroutines{job="gateway"}`),
      promInstant(`go_gc_duration_seconds_sum{job="gateway"}`),
      promInstant(`nodejs_gc_pause_seconds_count{job="server"}`),
      promInstant(`process_cpu_seconds_total{job="server"}`),
      promInstant(`process_cpu_seconds_total{job="gateway"}`),
    ]);
    const srss = rssMB(serverPid), grss = rssMB(gatewayPid);
    if (c != null) samples.connections.push(c);
    if (srss != null) samples.serverRss.push(srss);
    if (grss != null) samples.gatewayRss.push(grss);
    if (el != null) samples.eventloopP99.push(el);
    if (gr != null) samples.goroutines.push(gr);
    if (goGc != null) samples.goGcSum.push(goGc);
    if (ngc != null) samples.nodeGcCount.push(ngc);
    if (scpu != null) samples.serverCpu.push(scpu);
    if (gcpu != null) samples.gatewayCpu.push(gcpu);
  }, 2000);

  const code = await new Promise((res) => child.on('close', res));
  clearInterval(poll);
  const endedAt = Date.now();

  const max = (a) => (a.length ? Math.max(...a) : null);
  const first = (a) => (a.length ? a[0] : null);
  const last = (a) => (a.length ? a[a.length - 1] : null);
  const delta = (a) => (first(a) != null && last(a) != null ? +(last(a) - first(a)).toFixed(3) : null);

  // 结束后查窗口内消息处理时延分位(服务内)
  const winSec = Math.max(1, Math.ceil((endedAt - startedAt) / 1000));
  const durMetric = mode === 'gateway' ? 'gateway_uplink_duration_seconds_bucket' : 'server_message_duration_seconds_bucket';
  const q = async (metric, p) => {
    const v = await promInstant(`histogram_quantile(${p}, sum(rate(${metric}[${winSec}s])) by (le))`);
    return v != null ? +(v * 1000).toFixed(1) : null;
  };
  const [sp50, sp95, sp99] = await Promise.all([q(durMetric, 0.5), q(durMetric, 0.95), q(durMetric, 0.99)]);
  // 归因补充:gateway 下行投递 + Node HTTP 层 + Node GC 停顿
  const [dl50, dl95, dl99] = mode === 'gateway'
    ? await Promise.all([
      q('gateway_downlink_duration_seconds_bucket', 0.5),
      q('gateway_downlink_duration_seconds_bucket', 0.95),
      q('gateway_downlink_duration_seconds_bucket', 0.99),
    ])
    : [null, null, null];
  const [h50, h95, h99] = await Promise.all([
    q('http_request_duration_seconds_bucket', 0.5),
    q('http_request_duration_seconds_bucket', 0.95),
    q('http_request_duration_seconds_bucket', 0.99),
  ]);
  const [g50, g95, g99] = await Promise.all([
    q('nodejs_gc_pause_seconds_bucket', 0.5),
    q('nodejs_gc_pause_seconds_bucket', 0.95),
    q('nodejs_gc_pause_seconds_bucket', 0.99),
  ]);

  const result = {
    label, mode, exitCode: code,
    params: { CONNS: +CONNS, RATE: +RATE, DURATION: +DURATION, RAMP: +RAMP },
    startedAt, endedAt, windowSec: winSec,
    harness: parseSummary(stdout),
    resource: {
      peakConnections: max(samples.connections),
      peakServerRssMB: max(samples.serverRss),
      baseServerRssMB: first(samples.serverRss),
      peakGatewayRssMB: max(samples.gatewayRss),
      baseGatewayRssMB: first(samples.gatewayRss),
      peakEventloopP99Ms: max(samples.eventloopP99) ? +(max(samples.eventloopP99) * 1000).toFixed(2) : null,
      peakGoroutines: max(samples.goroutines),
      goGcSecondsDelta: delta(samples.goGcSum),
      nodeGcPausesDelta: Math.round(delta(samples.nodeGcCount) ?? NaN) || null,
      serverCpuSecondsDelta: delta(samples.serverCpu),
      gatewayCpuSecondsDelta: delta(samples.gatewayCpu),
    },
    serverInternalDurationMs: { p50: sp50, p95: sp95, p99: sp99 },
    gatewayDownlinkDurationMs: { p50: dl50, p95: dl95, p99: dl99 },
    httpDurationMs: { p50: h50, p95: h95, p99: h99 },
    nodeGcPauseMs: { p50: g50, p95: g95, p99: g99 },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${label}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`\n[ab-run] 已写 ${path}`);
  console.log(`[ab-run] 峰值: conn=${result.resource.peakConnections} serverRss=${result.resource.peakServerRssMB}MB gatewayRss=${result.resource.peakGatewayRssMB}MB eventloopP99=${result.resource.peakEventloopP99Ms}ms goroutines=${result.resource.peakGoroutines} goGcΔ=${result.resource.goGcSecondsDelta}s nodeGcΔ=${result.resource.nodeGcPausesDelta} srvCpuΔ=${result.resource.serverCpuSecondsDelta}s gwCpuΔ=${result.resource.gatewayCpuSecondsDelta}s`);
}
main().catch((e) => { console.error('[ab-run] 失败', e); process.exit(1); });
