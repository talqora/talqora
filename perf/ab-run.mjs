// A/B 单次运行编排器:跑一个 harness(socketio 或 gateway),运行中采样 Prometheus 资源指标,
// 结束后解析 harness 统计 + 查询消息时延分位,产出结构化 JSON 落盘到 测试报告/data/。
// 用法:node ab-run.mjs <mode socketio|gateway> <label> [CONNS] [RATE] [DURATION] [RAMP]
import { spawn, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告', 'data');
const PROM = process.env.PROM || 'http://localhost:9090';

const [mode, label, CONNS = '100', RATE = '10', DURATION = '20', RAMP = '25'] = process.argv.slice(2);
if (!mode || !label) { console.error('用法: node ab-run.mjs <socketio|gateway> <label> [CONNS RATE DURATION RAMP]'); process.exit(1); }
const harnessFile = mode === 'gateway' ? 'harness-gw.mjs' : 'harness.mjs';
const job = mode === 'gateway' ? 'gateway' : 'server';

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
  const conn = grp(/连接建立耗时\(ms\): p50=(\S+) p95=(\S+) p99=(\S+) min=(\S+) max=(\S+) \(n=(\d+)\)/);
  const rtt = grp(/消息 RTT\(ms\): p50=(\S+) p95=(\S+) p99=(\S+) min=(\S+) max=(\S+) \(n=(\d+)\)/);
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
    connectMs: conn ? { p50: conn[0], p95: conn[1], p99: conn[2], min: conn[3], max: conn[4], n: conn[5] } : null,
    rttMs: rtt ? { p50: rtt[0], p95: rtt[1], p99: rtt[2], min: rtt[3], max: rtt[4], n: rtt[5] } : null,
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
  const samples = { connections: [], serverRss: [], gatewayRss: [], eventloopP99: [], goroutines: [] };
  const connMetric = mode === 'gateway' ? 'gateway_connections' : 'server_ws_connections';
  const poll = setInterval(async () => {
    const [c, el, gr] = await Promise.all([
      promInstant(connMetric),
      promInstant(`nodejs_eventloop_lag_p99_seconds{job="server"}`),
      promInstant(`go_goroutines{job="gateway"}`),
    ]);
    const srss = rssMB(serverPid), grss = rssMB(gatewayPid);
    if (c != null) samples.connections.push(c);
    if (srss != null) samples.serverRss.push(srss);
    if (grss != null) samples.gatewayRss.push(grss);
    if (el != null) samples.eventloopP99.push(el);
    if (gr != null) samples.goroutines.push(gr);
  }, 2000);

  const code = await new Promise((res) => child.on('close', res));
  clearInterval(poll);
  const endedAt = Date.now();

  const max = (a) => (a.length ? Math.max(...a) : null);
  // 结束后查窗口内消息处理时延分位(服务内)
  const durMetric = mode === 'gateway' ? 'gateway_uplink_duration_seconds_bucket' : 'server_message_duration_seconds_bucket';
  const winSec = Math.ceil((endedAt - startedAt) / 1000);
  const q = async (p) => promInstant(`histogram_quantile(${p}, sum(rate(${durMetric}[${winSec}s])) by (le))`);
  const [sp50, sp95, sp99] = await Promise.all([q(0.5), q(0.95), q(0.99)]);

  const result = {
    label, mode, exitCode: code,
    params: { CONNS: +CONNS, RATE: +RATE, DURATION: +DURATION, RAMP: +RAMP },
    startedAt, endedAt, windowSec: winSec,
    harness: parseSummary(stdout),
    resource: {
      peakConnections: max(samples.connections),
      peakServerRssMB: max(samples.serverRss),
      peakGatewayRssMB: max(samples.gatewayRss),
      peakEventloopP99Ms: max(samples.eventloopP99) ? +(max(samples.eventloopP99) * 1000).toFixed(2) : null,
      peakGoroutines: max(samples.goroutines),
    },
    serverInternalDurationMs: { p50: sp50 != null ? +(sp50 * 1000).toFixed(1) : null, p95: sp95 != null ? +(sp95 * 1000).toFixed(1) : null, p99: sp99 != null ? +(sp99 * 1000).toFixed(1) : null },
  };
  const path = join(OUT_DIR, `${label}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`\n[ab-run] 已写 ${path}`);
  console.log(`[ab-run] 峰值: conn=${result.resource.peakConnections} serverRss=${result.resource.peakServerRssMB}MB gatewayRss=${result.resource.peakGatewayRssMB}MB eventloopP99=${result.resource.peakEventloopP99Ms}ms goroutines=${result.resource.peakGoroutines}`);
}
main().catch((e) => { console.error('[ab-run] 失败', e); process.exit(1); });
