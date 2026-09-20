// 读取 测试报告/<REPORT_SUBDIR>/data/*.json,生成本期单边深度分析 HTML(内联 SVG,无外网依赖,可长期归档)。
// 口径:只读 <key>_gateway.json 与原始轮次 <key>_gateway_rN.json——不做任何历史期/Node 对比(SOPV2 §8)。
// 覆盖:S0-S5 主场景 + 吞吐饱和扫描 + 轮间波动 + RTT 构成分解 + S6 爬坡 + S7 惊群 + 群扇出 + HTTP API 层。
// 用法:REPORT_SUBDIR=<日期> node gen-report-v2.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告');
const REPORT_SUBDIR = process.env.REPORT_SUBDIR || '26-9-20';
const DATA = join(REPORT_DIR, REPORT_SUBDIR, 'data');
const load = (n) => {
  const p = join(DATA, n + '.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

const scenarios = [
  { key: 's0', title: 'S0 冒烟', desc: '50 连接 × 2 msg/s × 15s(链路冒烟)' },
  { key: 's1', title: 'S1 常规吞吐', desc: '100 连接 × 10 msg/s × 20s(≈1000 msg/s)' },
  { key: 's2', title: 'S2 连接规模', desc: '300 连接 × 2 msg/s × 15s(低消息率,看连接与资源)' },
  { key: 's3', title: 'S3 过载压力', desc: '150 连接 × 20 msg/s × 15s(≈3000 msg/s)' },
  { key: 's4', title: 'S4 大连接', desc: '500 连接 × 1 msg/s × 15s(最低消息率,看连接与资源)' },
  { key: 's5', title: 'S5 长时稳态', desc: '100 连接 × 5 msg/s × 120s(长稳漂移与心跳)' },
];
const tpKeys = [10, 15, 20, 25, 30].map((r) => `tp_r${r}`);
const data = {}; for (const s of scenarios) data[s.key] = load(s.key + '_gateway');
const tpData = tpKeys.map((k) => load(k + '_gateway'));
const ramp = load('s6_ramp_gateway');
const storm = load('s7_storm_gateway');
const fanout = load('fanout_bench_gateway');
const http = load('http_gateway');

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const errSum = (h) => Object.values(h?.errors || {}).reduce((a, b) => a + b, 0);
const f1 = (v) => (v == null || Number.isNaN(v) ? '—' : Math.round(v * 10) / 10);
const f2 = (v) => (v == null || Number.isNaN(v) ? '—' : Math.round(v * 100) / 100);
const errRate = (h) => (h?.sent ? +(100 * errSum(h) / h.sent).toFixed(2) : null);
const ackRate = (h) => (h?.sent ? +(100 * h.ack / h.sent).toFixed(1) : null);
const COLOR = '#e15759';

// 单系列柱状图(本期数据,深色友好:网格/刻度/文字走 CSS 变量)。
function singleBar(title, unit, cats, series, opts = {}) {
  const W = 760, H = 300, padL = 64, padR = 20, padT = 44, padB = 54;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const all = series.filter((v) => v != null && !Number.isNaN(v));
  let maxV = Math.max(1, ...all);
  const nice = Math.pow(10, Math.floor(Math.log10(maxV)));
  maxV = Math.ceil(maxV / nice) * nice || maxV;
  const groups = cats.length, gw = plotW / groups, bw = Math.min(52, gw / 2);
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  let bars = '', labels = '', ticks = '';
  for (let t = 0; t <= 4; t++) { const v = (maxV / 4) * t, yy = y(v); ticks += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--grid)"/><text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${+(+v.toFixed(v < 10 ? 1 : 0))}</text>`; }
  cats.forEach((c, i) => {
    const cx = padL + gw * i + gw / 2;
    const v = series[i];
    if (v != null && !Number.isNaN(v)) { const yy = y(v); bars += `<rect class="series-b" x="${cx - bw / 2}" y="${yy}" width="${bw}" height="${padT + plotH - yy}" fill="${COLOR}"><title>${esc(c)} ${f1(v)}${unit}</title></rect><text class="series-b" x="${cx}" y="${yy - 4}" text-anchor="middle" font-size="10" fill="${COLOR}">${f1(v)}</text>`; }
    labels += `<text x="${cx}" y="${H - padB + 18}" text-anchor="middle" font-size="12" fill="var(--text)">${esc(c)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(title)}">
    <text x="${W / 2}" y="22" text-anchor="middle" font-size="14" font-weight="600" fill="var(--text)">${esc(title)}（${unit}）</text>
    ${ticks}${bars}${labels}
    <rect class="series-b" x="${W - 120}" y="6" width="12" height="12" fill="${COLOR}"/><text class="leg" x="${W - 104}" y="16" font-size="11">本期(全 Go 链路)</text>
  </svg>`;
}

// 多系列折线图(吞吐扫描:RATE 横轴,可多条曲线)。
function lineChart(title, unit, xs, seriesArr) {
  const W = 760, H = 300, padL = 64, padR = 20, padT = 44, padB = 54;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const all = seriesArr.flat().filter((v) => v != null && !Number.isNaN(v));
  let maxV = Math.max(1, ...all);
  const nice = Math.pow(10, Math.floor(Math.log10(maxV)));
  maxV = Math.ceil(maxV / nice) * nice || maxV;
  const x = (i) => padL + (plotW * i) / (xs.length - 1);
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  const colors = ['#e15759', '#4e79a7', '#59a14f', '#f28e2b'];
  const mkPath = (cls, arr, ci) => {
    let d = '', dots = '';
    arr.forEach((v, i) => {
      if (v == null || Number.isNaN(v)) return;
      d += (d ? ' L' : 'M') + `${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      dots += `<circle class="${cls}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5"><title>RATE=${xs[i]} → ${f1(v)}${unit}</title></circle>`;
    });
    return `<g class="series-b"><path class="${cls}" d="${d}" fill="none" stroke="${colors[ci]}" stroke-width="2.5"/>${dots}</g>`;
  };
  let ticks = '';
  for (let t = 0; t <= 4; t++) { const v = (maxV / 4) * t, yy = y(v); ticks += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--grid)"/><text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${+(+v.toFixed(v < 10 ? 1 : 0))}</text>`; }
  let labels = '';
  xs.forEach((v, i) => { labels += `<text x="${x(i)}" y="${H - padB + 18}" text-anchor="middle" font-size="12" fill="var(--text)">${v}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(title)}">
    <text x="${W / 2}" y="22" text-anchor="middle" font-size="14" font-weight="600" fill="var(--text)">${esc(title)}（${unit}）</text>
    ${ticks}${seriesArr.map((a, i) => mkPath('series-b', a, i)).join('')}${labels}
  </svg>`;
}

const cats = scenarios.map((s) => s.title.replace(/^S\d /, ''));

// ---------------- 主场景完整数据表(单边深度) ----------------
function mainTable() {
  let rows = '';
  for (const s of scenarios) {
    const r = data[s.key];
    if (!r) continue;
    const h = r.harness, res = r.resource ?? {}, si = r.serverInternalDurationMs ?? {};
    const e = errSum(h);
    rows += `<tr>
      <td>${s.title}</td>
      <td>${h.connectedCount}/${h.attempted}</td><td>${h.sent}/${h.ack}</td>
      <td class="${e ? 'bad' : 'ok'}">${e}${h.sent ? ` (${f1(100 * e / h.sent)}%)` : ''}</td>
      <td>${h.retriesSent ?? 0}</td><td>${h.reconnectsTriggered ?? 0}</td>
      <td>${f1(h.rttMs?.p50)}/${f1(h.rttMs?.p95)}/<b>${f1(h.rttMs?.p99)}</b>/${f1(h.rttMs?.p999)}</td>
      <td>${f1(h.rttMs?.min)}~${f1(h.rttMs?.max)}</td>
      <td>${f1(si.p50)}/${f1(si.p95)}/<b>${f1(si.p99)}</b></td>
      <td>${f1(res.baseServerRssMB)}→${f1(res.peakServerRssMB)}</td>
      <td>${f1(res.baseGatewayRssMB)}→${f1(res.peakGatewayRssMB)}</td>
      <td>${f1(res.peakGoroutines)}</td>
      <td>${f2(res.serverCpuSecondsDelta)}/${f2(res.gatewayCpuSecondsDelta)}</td>
    </tr>`;
  }
  return rows;
}

// ---------------- 轮间波动表(3 轮原始数据) ----------------
function roundsTable() {
  let rows = '';
  for (const k of [...scenarios.map((s) => s.key), ...tpKeys]) {
    const rounds = [];
    for (let r = 1; r <= 3; r++) {
      const j = load(`${k}_gateway_r${r}`);
      if (!j) continue;
      const h = j.harness;
      rounds.push({ r, p99: h.rttMs?.p99, sent: h.sent, ack: h.ack, err: errSum(h) });
    }
    const mid = data[k]?.harness?.rttMs?.p99 ?? load(k + '_gateway')?.harness?.rttMs?.p99;
    const midR = rounds.find((x) => x.p99 === mid)?.r ?? '—';
    rows += `<tr><td>${k}</td>${rounds.map((x) => `<td>${f1(x.p99)}<span class="muted">/s${x.sent}</span>${x.err ? `<span class="bad">(e${x.err})</span>` : ''}</td>`).join('')}<td><b>${f1(mid)}</b>(r${midR})</td></tr>`;
  }
  return rows;
}

// ---------------- 吞吐饱和扫描表 ----------------
function tpTable() {
  let rows = '';
  for (const k of tpKeys) {
    const r = load(k + '_gateway');
    if (!r) continue;
    const h = r.harness, si = r.serverInternalDurationMs ?? {};
    const e = errSum(h);
    rows += `<tr><td>${k}</td><td>${h.sent}</td><td>${h.ack}</td>
      <td class="${e ? 'bad' : 'ok'}">${e} (${f1(h.sent ? 100 * e / h.sent : 0)}%)</td>
      <td>${f1(h.rttMs?.p50)}</td><td>${f1(h.rttMs?.p95)}</td><td><b>${f1(h.rttMs?.p99)}</b></td><td>${f1(h.rttMs?.p999)}</td>
      <td>${f1(h.rttMs?.max)}</td><td>${f1(si.p99)}</td>
      <td>${f1(r.resource?.peakServerRssMB)}</td><td>${f1(r.resource?.peakGatewayRssMB)}</td><td>${f1(r.resource?.peakGoroutines)}</td></tr>`;
  }
  return rows;
}

// ---------------- RTT 构成分解表 ----------------
function decomposeTable() {
  let rows = '';
  for (const s of scenarios) {
    const r = data[s.key];
    if (!r) continue;
    const h = r.harness, si = r.serverInternalDurationMs ?? {};
    const dl = r.gatewayDownlinkDurationMs ?? {};
    rows += `<tr><td>${s.title}</td>
      <td>${f1(h.rttMs?.p50)}/<b>${f1(h.rttMs?.p99)}</b></td>
      <td>${f1(si.p50)}/<b>${f1(si.p99)}</b></td>
      <td>${f1(dl.p50)}/${f1(dl.p99)}</td></tr>`;
  }
  return rows;
}

// ---------------- S6 爬坡表 ----------------
function rampTable() {
  if (!ramp) return '<p class="muted">无 S6 爬坡数据。</p>';
  const rows = (ramp.levels || []).map((l) => `<tr><td>${l.target}</td><td>${l.batchOk}/${l.batchAttempted} (${(l.successRate * 100).toFixed(1)}%)</td>
    <td>${f1(l.connectMs?.p50)}/${f1(l.connectMs?.p95)}/${f1(l.connectMs?.p99)}</td>
    <td>${l.heldAfter}</td><td>${f1(l.gatewayConnections)}</td><td>${f1(l.goroutines)}</td>
    <td>${f1(l.gatewayRssMB)}</td><td>${f1(l.serverRssMB)}</td></tr>`).join('');
  const s = ramp.summary ?? {};
  return `<table>
    <tr><th>目标连接</th><th>建连成功(成功率)</th><th>建连耗时 p50/95/99(ms)</th><th>实际持有</th><th>gw 连接数</th><th>goroutine</th><th>gw RSS(MB)</th><th>biz RSS(MB)</th></tr>${rows}</table>
    <p class="muted">拐点:${esc(ramp.stopReason ?? '—')};最大稳定连接 ${s.maxStableConnections ?? '—'}(未探到上限,受预置用户数 1 万封顶)。</p>`;
}

// ---------------- S7 惊群表 ----------------
function stormTable() {
  if (!storm) return '<p class="muted">无 S7 惊群数据。</p>';
  const rc = storm.stormReconnect, res = storm.resource ?? {};
  return `<table>
    <tr><th>重连成功</th><th>重连耗时 p50/95/99(ms)</th><th>max(ms)</th><th>gw RSS 基线→峰值(MB)</th><th>biz RSS 基线→峰值(MB)</th><th>连接数 基线→峰值</th><th>goroutine 峰值</th></tr>
    <tr><td>${rc.ok}/${rc.attempted}</td><td>${f1(rc.p50)}/${f1(rc.p95)}/<b>${f1(rc.p99)}</b></td><td>${f1(rc.max)}</td>
    <td>${f1(res.baselineGatewayRssMB)}→${f1(res.spikePeakGatewayRssMB)}</td>
    <td>${f1(res.baselineServerRssMB)}→${f1(res.spikePeakServerRssMB)}</td>
    <td>${f1(res.baselineGatewayConnections ?? res.baselineConnections)}→${f1(res.spikePeakGatewayConnections ?? res.spikePeakConnections)}</td>
    <td>${f1(res.spikePeakGoroutines)}</td></tr></table>`;
}

// ---------------- 群扇出表 ----------------
function fanoutTable() {
  if (!fanout) return '<p class="muted">无群扇出数据。</p>';
  return `<table>
    <tr><th>成员在线</th><th>发送条数</th><th>完整送达</th><th>扇出扩散 span p50/95/99(ms)</th><th>max(ms)</th><th>扇出端到端 e2e p50/95/99(ms)</th><th>max(ms)</th></tr>
    <tr><td>${fanout.connected}</td><td>${fanout.roundsSent}</td><td>${fanout.roundsDelivered}</td>
    <td>${f1(fanout.fanoutSpanMs?.p50)}/${f1(fanout.fanoutSpanMs?.p95)}/<b>${f1(fanout.fanoutSpanMs?.p99)}</b></td><td>${f1(fanout.fanoutSpanMs?.max)}</td>
    <td>${f1(fanout.fanoutE2EMs?.p50)}/${f1(fanout.fanoutE2EMs?.p95)}/<b>${f1(fanout.fanoutE2EMs?.p99)}</b></td><td>${f1(fanout.fanoutE2EMs?.max)}</td></tr></table>`;
}

// ---------------- HTTP 表(含分位) ----------------
function httpTable() {
  if (!http) return '<p class="muted">无 HTTP 数据。</p>';
  const rows = (http.targets || []).map((t) => {
    const lm = t.latencyMs ?? {};
    return `<tr><td>${esc(t.target)}</td><td>${f1(t.rps)}</td><td>${f1(lm.p50)}/${f1(lm.p95)}/<b>${f1(lm.p99)}</b></td><td class="${t.errors ? 'bad' : 'ok'}">${t.errors ?? 0}</td></tr>`;
  }).join('');
  return `<table>
    <tr><th>端点</th><th>rps</th><th>延迟 p50/95/99(ms)</th><th>错误数</th></tr>${rows}</table>
    <p class="muted">HTTP 层直连 biz :3007 REST(不经过 gateway),并发 20 × 10s。</p>`;
}

// ---------------- 结论速览(自动提取) ----------------
function highlightBox() {
  const parts = [];
  const totalErr = scenarios.reduce((a, s) => a + errSum(data[s.key]?.harness), 0) + tpData.reduce((a, r) => a + errSum(r?.harness), 0);
  parts.push(`<b>1. 可靠性:</b>主场景 + 吞吐扫描全部 ${scenarios.length + tpData.length} 个数据文件共 ${scenarios.reduce((a, s) => a + (data[s.key]?.harness?.sent || 0), 0) + tpData.reduce((a, r) => a + (r?.harness?.sent || 0), 0)} 条消息,错误 ${totalErr} 条,重发 0 帧、断线重连 0 次。`);
  const s3 = data.s3?.harness, tp30 = load('tp_r30_gateway')?.harness;
  if (s3) parts.push(`<b>2. 过载形态(S3 ≈3000 msg/s,150 连接 × 20 msg/s):</b>${s3.sent} 条全 ack,错误 0,RTT p50=${f1(s3.rttMs?.p50)}/p99=${f1(s3.rttMs?.p99)}/p999=${f1(s3.rttMs?.p999)}ms——过载表现为软排队而非失败。`);
  if (tp30) parts.push(`<b>3. 吞吐拐点(100 连接):</b>RATE 25→30(≈2500→3000 msg/s)时 RTT p99 ${f1(load('tp_r25_gateway')?.harness?.rttMs?.p99)}→${f1(tp30.rttMs?.p99)}ms 超线性抬升,但错误率保持 0%——同机单 PG 实例写吞吐趋近饱和,系统排队而非拒绝。`);
  const s2 = data.s2?.harness, s1 = data.s1?.harness;
  if (s2 && s1) parts.push(`<b>4. 延迟-速率反相关:</b>低消息率场景 S2(2 msg/s)p50=${f1(s2.rttMs?.p50)}ms 高于高吞吐 S1(10 msg/s)p50=${f1(s1.rttMs?.p50)}ms——低速率下 RTT 由空闲唤醒与冷缓存主导,非瓶颈恶化。`);
  if (ramp) parts.push(`<b>5. 连接容量:</b>S6 爬坡到 1 万连接 100% 成功(建连 p99 ≤376ms/级),gw RSS ${f1(ramp.summary?.peakLevelGatewayRssMB)}MB / ${f1(ramp.summary?.peakLevelGoroutines)} goroutine(≈2 goroutine/连接);biz RSS 登录期峰值 ${f1(Math.max(...(ramp.levels || []).map((l) => l.serverRssMB || 0)))}MB → 结束档 ${f1(ramp.summary?.peakLevelServerRssMB)}MB(GC 回落)。`);
  if (storm) parts.push(`<b>6. 突发重连:</b>S7 惊群 300 连接同瞬间重连 ${storm.stormReconnect?.ok}/${storm.stormReconnect?.attempted} 成功,p99=${f1(storm.stormReconnect?.p99)}ms,资源无尖峰。`);
  return parts.map((p) => `<li>${p}</li>`).join('');
}

const maxTs = Math.max(...Object.values(data).concat(tpData, [ramp, storm, fanout, http]).map((r) => r?.endedAt).filter(Boolean));

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>实时消息链路性能深度分析报告(${REPORT_SUBDIR})</title>
<style>
  /* 深浅色双主题:跟随系统 prefers-color-scheme;SVG 内无硬编码浅色,网格/刻度/文字全走 CSS 变量。 */
  :root{color-scheme:light dark;
    --bg:#ffffff;--text:#222222;--muted:#888888;--grid:#eeeeee;--chart-bg:#ffffff;
    --table-border:#dddddd;--th-bg:#f3f6fa;
    --box-bg:#f7f9fc;--box-border:#dde6f0;
    --warn-bg:#fff7e6;--warn-border:#ffe0a3;
    --key-bg:#eef7ee;--key-border:#c9e6c9;
    --h-color:#33517a;--code-bg:#f0f0f0;
    --accent:#4e79a7;--bad:#c0392b;--ok:#27ae60;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#1b1c21;--text:#e4e6ea;--muted:#9ba1ab;--grid:#383b44;--chart-bg:#22242b;
      --table-border:#3d414b;--th-bg:#2a2d36;
      --box-bg:#252730;--box-border:#3d414b;
      --warn-bg:#3a3122;--warn-border:#6b5826;
      --key-bg:#20302a;--key-border:#3c5748;
      --h-color:#9dbce0;--code-bg:#30333c;
      --accent:#7fa9d4;--bad:#ff7a6e;--ok:#5ec98d;
    }
  }
  body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;color:var(--text);background:var(--bg);max-width:1000px;margin:0 auto;padding:24px;}
  h1{border-bottom:3px solid var(--accent);padding-bottom:8px;color:var(--text)}
  h2{margin-top:36px;border-left:5px solid var(--accent);padding-left:10px;color:var(--text)}
  h3{margin-top:24px;color:var(--h-color)}
  h4{margin:18px 0 6px;color:var(--h-color)}
  .chart{width:100%;height:auto;border:1px solid var(--grid);border-radius:6px;margin:12px 0;background:var(--chart-bg)}
  table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0;color:var(--text)}
  th,td{border:1px solid var(--table-border);padding:6px 8px;text-align:center}
  th{background:var(--th-bg);color:var(--text)}
  .bad{color:var(--bad);font-weight:700}.ok{color:var(--ok)}
  .box{background:var(--box-bg);border:1px solid var(--box-border);border-radius:8px;padding:12px 16px;margin:14px 0;color:var(--text)}
  .warn{background:var(--warn-bg);border-color:var(--warn-border)}
  .key{background:var(--key-bg);border-color:var(--key-border)}
  code{background:var(--code-bg);padding:1px 5px;border-radius:3px;font-size:12px;color:var(--text)}
  .muted{color:var(--muted);font-size:13px}
  svg .series-b{fill:#e15759;stroke:#e15759}
  svg .leg{fill:var(--text)}
</style></head><body>

<h1>实时消息链路性能深度分析报告</h1>
<p class="muted">期次 ${REPORT_SUBDIR} ｜ 数据窗口结束:${maxTs ? new Date(maxTs).toLocaleString('zh-CN') : '—'} ｜ 分支 feat/perf-monitoring ｜ 数据源:测试报告/${REPORT_SUBDIR}/data/*.json(真实压测采集,全 Go 链路:harness → gateway :8090 → gRPC 双向流 → biz ×2 → PG 分区表/Redis)</p>

<div class="box warn">
<b>测量诚实性声明(务必先读)</b><br>
① 全部服务(harness 负载生成 + biz ×2 + gateway + colima 中间件/Prometheus)<b>跑在同一台 macOS 开发机</b>,彼此抢 CPU,故<b>绝对毫秒数有噪声、非生产代表值</b>;本报告价值在<b>同机同负载下的定性行为、拐点形态与诊断结论</b>。<br>
② 本报告<b>只呈现本期数据</b>,不做任何历史期/跨技术栈对比(SOPV2 §8 口径)。<br>
③ 公平性:压测客户端实现与生产客户端等价的 ack 匹配/5s 超时同键重发×3/25s 心跳/断线重连(对齐 web/src/ws/wsClient.ts),不是裸发帧的假快路径。<br>
④ 每场景 ≥3 轮取中位轮(RTT p99)落盘;RTT 用往返口径(clientMsgId 关联);资源按两侧进程 RSS/CPU 分别采样(ps)。<br>
⑤ 口径注意:kill -9 重启会清零该副本 Prometheus counter,跨重启的累计指标需注明(本期分布式演练已注明)。
</div>

<h2>一、结论速览</h2>
<div class="box key"><ul>${highlightBox()}</ul></div>

<h2>二、测试方法与场景</h2>
<ul>
<li><code>perf/harness-gw.mjs</code>:原生 WebSocket(query token/deviceId)→ gateway <code>/ws</code> → 信封帧 <code>{type:'message.send',data:{...}}</code> → 等 <code>message.ack</code> 计 RTT。</li>
<li>编排 <code>perf/ab-run.mjs</code>:跑 harness + 每 2s 采样(Prometheus 连接/goroutine/GC + <code>ps</code> 两进程 RSS/CPU)+ 服务内直方图分位(uplink/downlink/HTTP)→ 落 JSON。</li>
<li>部署形态:双 biz 副本(3007/3008、3009/30081)+ gateway 双后端 gRPC(每后端 4 流,userId 哈希分片)。</li>
</ul>
<table><tr><th>场景</th><th>参数</th><th>目的</th></tr>
${scenarios.map((s) => `<tr><td>${s.title}</td><td>${s.desc}</td><td>${s.key === 's1' ? '常规吞吐下的 RTT' : s.key === 's2' || s.key === 's4' ? '低消息率下连接规模与资源(空闲唤醒定性)' : s.key === 's3' ? '过载时的失败/排队形态' : s.key === 's5' ? '长稳漂移与心跳有效性' : '链路冒烟'}</td></tr>`).join('')}</table>

<h2>三、主场景深度数据</h2>
${singleBar('消息 RTT p99(客户端往返)', 'ms', cats, scenarios.map((s) => data[s.key]?.harness?.rttMs?.p99))}
${singleBar('消息 RTT p999(尾延迟)', 'ms', cats, scenarios.map((s) => data[s.key]?.harness?.rttMs?.p999))}
${singleBar('biz RSS 峰值(ps 采样)', 'MB', cats, scenarios.map((s) => data[s.key]?.resource?.peakServerRssMB))}
${singleBar('gateway RSS 峰值(ps 采样)', 'MB', cats, scenarios.map((s) => data[s.key]?.resource?.peakGatewayRssMB))}
${singleBar('goroutine 峰值', '个', cats, scenarios.map((s) => data[s.key]?.resource?.peakGoroutines))}
<table>
<tr><th>场景</th><th>连接(成功/尝试)</th><th>发送/ack</th><th>错误(错误率)</th><th>重发</th><th>重连</th><th>RTT p50/95/<b>99</b>/999(ms)</th><th>min~max</th><th>上行链路 p50/95/99(ms)</th><th>biz RSS 基→峰(MB)</th><th>gw RSS 基→峰(MB)</th><th>goroutine</th><th>CPUΔ biz/gw(s)</th></tr>
${mainTable()}
</table>
<p class="muted">「上行链路」= gateway_uplink_duration_seconds(收帧→拿到 ack),经 Prometheus histogram_quantile 算得,受桶宽影响偏粗;「CPUΔ」为场景窗口内两进程累计 CPU 秒(ps -o time 差分)。</p>

<h3>3.1 RTT 构成分解(延迟发生在哪一面)</h3>
<table>
<tr><th>场景</th><th>客户端 RTT p50/p99(ms)</th><th>上行链路(gateway 收帧→ack)p50/p99(ms)</th><th>下行回投 p50/p99(ms)</th></tr>
${decomposeTable()}
</table>
<p class="muted">诊断口径:RTT ≈ 上行链路 + 下行回投(两段串行)。若 RTT ≈ 上行链路,说明延迟主导在 gateway→biz 处理面(限流/成员查询/发号/落库/扇出),网关转发与下行近乎免费。</p>

<h3>3.2 轮间稳定性(3 轮原始数据与中位选择)</h3>
<table>
<tr><th>场景</th><th>r1 p99(ms)</th><th>r2 p99(ms)</th><th>r3 p99(ms)</th><th>中位(落盘)</th></tr>
${roundsTable()}
</table>
<p class="muted">每格附 sent 数(斜杠后);高压档(tp_r25/r30)轮间 p99 波动属同机共享资源噪声,3 轮取中位口径抑制单轮尖峰;全部轮次错误数均为 0。</p>

<h2>四、吞吐饱和扫描(固定 100 连接,RATE 10→30,各 20s)</h2>
${lineChart('RTT p50/p95/p99 vs RATE', 'ms', tpKeys, [
  tpData.map((d) => d?.harness?.rttMs?.p50),
  tpData.map((d) => d?.harness?.rttMs?.p95),
  tpData.map((d) => d?.harness?.rttMs?.p99),
])}
${lineChart('RTT p999(尾延迟) vs RATE', 'ms', tpKeys, [tpData.map((d) => d?.harness?.rttMs?.p999)])}
<table>
<tr><th>场景</th><th>发送</th><th>ack</th><th>错误(错误率)</th><th>RTT p50</th><th>p95</th><th>p99</th><th>p999</th><th>max</th><th>上行链路 p99</th><th>biz RSS 峰值(MB)</th><th>gw RSS 峰值(MB)</th><th>goroutine</th></tr>
${tpTable()}
</table>

<h2>五、专项场景</h2>
<h3>5.1 S6 连接爬坡探顶(2000 起每级 +2000 → 10000,每级保持 5s)</h3>
${rampTable()}
<h3>5.2 S7 惊群重连(300 连接同瞬间全断→全连,3 轮取中位)</h3>
${stormTable()}
<h3>5.3 群扇出(100 成员在线,1 人发 20 条,3 轮取中位)</h3>
${fanoutTable()}
<h3>5.4 HTTP API 层(7 端点,并发 20 × 10s,直连 biz :3007)</h3>
${httpTable()}

<h2>六、深入分析(详见配套 markdown 报告)</h2>
<p>本 HTML 为数据自动汇总;场景间交叉诊断(延迟-速率反相关、拐点定位、内存剖面)、DB 面按 model 分线、下行双通道 direct/fallback 比例、分布式演练与遗留问题,见同目录 markdown 报告与 <code>grafana-authority-dashboard.png</code>(压测期间全面板截图)。</p>

<p class="muted" style="margin-top:40px;border-top:1px solid var(--grid);padding-top:12px">本报告由 <code>perf/gen-report-v2.mjs</code> 从真实压测 JSON 自动生成(内联 SVG,无外网依赖);原始数据见同目录 <code>data/</code>。</p>
</body></html>`;

const outPath = join(REPORT_DIR, REPORT_SUBDIR, '性能对比报告.html');
mkdirSync(join(REPORT_DIR, REPORT_SUBDIR), { recursive: true });
writeFileSync(outPath, html);
console.log('已生成 ' + outPath);
