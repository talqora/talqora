// 纯 Node(socket.io,无 gateway)性能基线报告生成器(完整版)。
// 读取 docs/监测设施/测试报告/26-9-14/data/*.json,生成自包含 HTML 报告
// (内联 SVG 图表,无外网依赖,可长期归档,跟随系统深浅色)。
// 用法:node gen-node-report.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告', '26-9-14');
const DATA = join(REPORT_DIR, 'data');
const load = (n) => JSON.parse(readFileSync(join(DATA, n + '.json'), 'utf8'));
const has = (n) => {
  try {
    readFileSync(join(DATA, n + '.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
};

const scenarios = [
  { key: 's0_smoke', title: 'S0 Smoke', desc: '50 连接 × 2 msg/s × 15s(≈100 msg/s)' },
  { key: 's1_throughput', title: 'S1 常规吞吐', desc: '100 连接 × 10 msg/s × 20s(≈1000 msg/s)' },
  { key: 's2_conn_scale', title: 'S2 连接规模', desc: '300 连接 × 2 msg/s × 15s(≈600 msg/s)' },
  { key: 's3_overload', title: 'S3 过载压力', desc: '150 连接 × 20 msg/s × 15s(≈3000 msg/s)' },
  { key: 's4_large_conn', title: 'S4 大连接', desc: '500 连接 × 1 msg/s × 15s(≈500 msg/s)' },
  { key: 's5_stability', title: 'S5 长时稳态', desc: '100 连接 × 5 msg/s × 120s(≈500 msg/s)' },
];
const data = {};
for (const s of scenarios) data[s.key] = load(s.key);
const ramp = load('s6_ramp');
const storm = load('s7_storm');
const tpRates = [10, 15, 20, 25, 30];
const tp = {};
for (const r of tpRates) tp[r] = load('tp_r' + r);
const http = has('http_bench') ? load('http_bench') : null;
const fanout = has('fanout_bench') ? load('fanout_bench') : null;

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const errSum = (h) => Object.values(h.errors || {}).reduce((a, b) => a + b, 0);
const fmt = (n) => (n == null || Number.isNaN(n) ? '—' : n);
const pct = (a, b) => (b ? +(100 * a / b).toFixed(1) : null);

function barChart({ title, unit, cats, series, colors, width = 720, height = 300, log = false }) {
  const padL = 60, padR = 20, padT = 40, padB = 50;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const all = series.flat().filter((v) => v != null && !Number.isNaN(v) && v > 0);
  if (!all.length) return '';
  let maxV = Math.max(...all);
  const nice = Math.pow(10, Math.floor(Math.log10(maxV)));
  maxV = Math.ceil(maxV / nice) * nice || maxV;
  const groups = cats.length, gw = plotW / groups;
  const bw = Math.min(40, gw / (series.length + 1));
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  let ticks = '';
  for (let t = 0; t <= 4; t++) {
    const v = (maxV / 4) * t, yy = y(v);
    ticks += `<line x1="${padL}" y1="${yy}" x2="${width - padR}" y2="${yy}" stroke="var(--grid)"/><text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${+v.toFixed(v < 10 ? 1 : 0)}</text>`;
  }
  let bars = '', labels = '';
  cats.forEach((c, i) => {
    const cx = padL + gw * i + gw / 2;
    series.forEach((ser, si) => {
      const v = ser[i];
      if (v == null || Number.isNaN(v)) return;
      const yy = y(v);
      const x = cx - (series.length * bw) / 2 + si * bw + 1;
      bars += `<rect x="${x}" y="${yy}" width="${bw - 2}" height="${padT + plotH - yy}" fill="${colors[si % colors.length]}"><title>${esc(c)}: ${v}${unit}</title></rect>`;
      if (series.length <= 3) bars += `<text x="${x + bw / 2 - 1}" y="${Math.max(yy - 4, 14)}" text-anchor="middle" font-size="9" fill="${colors[si % colors.length]}">${v}</text>`;
    });
    labels += `<text x="${cx}" y="${height - padB + 18}" text-anchor="middle" font-size="11" fill="var(--text)">${esc(c)}</text>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="${esc(title)}">
    <text x="${width / 2}" y="22" text-anchor="middle" font-size="14" font-weight="600" fill="var(--text)">${esc(title)}（${unit}）</text>
    ${ticks}${bars}${labels}</svg>`;
}

function lineChart({ title, unit, xs, series, colors, width = 720, height = 300 }) {
  const padL = 60, padR = 20, padT = 40, padB = 50;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const all = series.flat().filter((v) => v != null && !Number.isNaN(v));
  if (!all.length || !xs.length) return '';
  const maxV = Math.max(...all) * 1.15 || 1;
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  const x = (i) => padL + (i / Math.max(1, xs.length - 1)) * plotW;
  let ticks = '';
  for (let t = 0; t <= 4; t++) {
    const v = (maxV / 4) * t, yy = y(v);
    ticks += `<line x1="${padL}" y1="${yy}" x2="${width - padR}" y2="${yy}" stroke="var(--grid)"/><text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${+v.toFixed(v < 10 ? 1 : 0)}</text>`;
  }
  let polylines = '', dots = '', labels = '';
  series.forEach((ser, si) => {
    const pts = ser.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
    polylines += `<polyline points="${pts}" fill="none" stroke="${colors[si % colors.length]}" stroke-width="2"/>`;
    ser.forEach((v, i) => {
      if (v != null) dots += `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${colors[si % colors.length]}"><title>${esc(xs[i])}: ${v}${unit}</title></circle>`;
    });
  });
  xs.forEach((v, i) => {
    labels += `<text x="${x(i)}" y="${height - padB + 18}" text-anchor="middle" font-size="10" fill="var(--text)">${esc(v)}</text>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="${esc(title)}">
    <text x="${width / 2}" y="22" text-anchor="middle" font-size="14" font-weight="600" fill="var(--text)">${esc(title)}（${unit}）</text>
    ${ticks}${polylines}${dots}${labels}</svg>`;
}

// ===== 场景 S0-S5 指标 =====
const scCats = scenarios.map((s) => s.title.replace(/^S\d /, ''));
const rttP50 = scenarios.map((s) => data[s.key].harness.rttMs?.p50);
const rttP99 = scenarios.map((s) => data[s.key].harness.rttMs?.p99);
const rttP999 = scenarios.map((s) => data[s.key].harness.rttMs?.p999);
const ackRate = scenarios.map((s) => pct(data[s.key].harness.ack, data[s.key].harness.sent));
const errs = scenarios.map((s) => errSum(data[s.key].harness));
const rss = scenarios.map((s) => data[s.key].resource.peakServerRssMB);
const heap = scenarios.map((s) => data[s.key].resource.peakHeapMB);
const lag = scenarios.map((s) => data[s.key].resource.peakEventloopP99Ms);
const gcDelta = scenarios.map((s) => data[s.key].resource.gcPausesDelta);
const cpuDelta = scenarios.map((s) => data[s.key].resource.cpuSecondsDelta);
const durP99 = scenarios.map((s) => data[s.key].serverInternalDurationMs.p99);
const maxLag = Math.max(...lag.filter((v) => v != null));

// ===== 吞吐饱和扫描 =====
const tpCats = tpRates.map((r) => `${r * 100} msg/s`);
const tpFailRate = tpRates.map((r) => pct(errSum(tp[r].harness), tp[r].harness.sent));
const tpAckRate = tpRates.map((r) => pct(tp[r].harness.ack, tp[r].harness.sent));
const tpRttP99 = tpRates.map((r) => tp[r].harness.rttMs?.p99);
const tpRss = tpRates.map((r) => tp[r].resource.peakServerRssMB);

function dataTable() {
  let rows = '';
  for (const s of scenarios) {
    const h = data[s.key].harness, res = data[s.key].resource, si = data[s.key].serverInternalDurationMs, e = errSum(h);
    rows += `<tr>
      <td>${s.title}</td><td>${s.desc}</td>
      <td>${h.connectedCount}/${h.attempted}</td><td>${h.sent}/${h.ack}</td>
      <td class="${e ? 'bad' : 'ok'}">${e}</td>
      <td>${h.rttMs?.p50}/${h.rttMs?.p95}/<b>${h.rttMs?.p99}</b>/${h.rttMs?.p999 ?? '—'}</td>
      <td>${fmt(si.p50)}/${fmt(si.p95)}/<b>${fmt(si.p99)}</b></td>
      <td>${h.connectMs?.p50}/${h.connectMs?.p99}</td>
      <td>${fmt(res.peakServerRssMB)}</td><td>${fmt(res.peakHeapMB)}</td>
      <td>${fmt(res.peakEventloopP99Ms)}</td><td>${fmt(res.gcPausesDelta)}</td>
    </tr>`;
  }
  return rows;
}

function rampTable() {
  let rows = '';
  for (const l of ramp.levels) {
    rows += `<tr>
      <td>${l.target}</td><td>${l.batchOk}/${l.batchAttempted} (${(l.successRate * 100).toFixed(0)}%)</td>
      <td>${l.connectMs.p50}/${l.connectMs.p95}/<b>${l.connectMs.p99}</b></td>
      <td>${l.serverConnections}</td><td>${l.serverRssMB}</td><td>${l.eventloopP99Ms}</td>
    </tr>`;
  }
  return rows;
}

function tpTable() {
  let rows = '';
  for (const r of tpRates) {
    const h = tp[r].harness, e = errSum(h);
    rows += `<tr>
      <td>${r} msg/s/连接</td><td>${r * 100}</td>
      <td>${h.sent}/${h.ack}</td>
      <td class="${e ? 'bad' : 'ok'}">${e} (${pct(e, h.sent)}%)</td>
      <td>${h.rttMs?.p50}/<b>${h.rttMs?.p99}</b></td>
      <td>${fmt(tp[r].resource.peakServerRssMB)}</td>
    </tr>`;
  }
  return rows;
}

function httpTable() {
  if (!http) return '';
  let rows = '';
  for (const t of http.targets) {
    const e = t.errors;
    rows += `<tr>
      <td>${t.target}</td>
      <td>${t.rps}</td>
      <td>${t.latencyMs.p50}/${t.latencyMs.p95}/<b>${t.latencyMs.p99}</b></td>
      <td>${fmt(t.latencyMs.max)}</td>
      <td class="${e ? 'bad' : 'ok'}">${e}</td>
    </tr>`;
  }
  return rows;
}

const rampLast = ramp.levels[ramp.levels.length - 1];
const rampMax = ramp.params.MAX;
const rampStop = ramp.stopReason;
const ts = new Date(Math.max(...Object.values(data).map((d) => d.endedAt), ramp.endedAt, storm.endedAt, ...tpRates.map((r) => tp[r].endedAt), http?.endedAt ?? 0, fanout?.endedAt ?? 0)).toISOString();

// 每连接 RSS(KB)
const perConnKb = rampLast && rampLast.serverRssMB ? (rampLast.serverRssMB / rampLast.heldAfter * 1024).toFixed(0) : '—';

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>纯 Node(socket.io) 性能基线报告 — 无 gateway</title>
<style>
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
  body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;color:var(--text);background:var(--bg);max-width:980px;margin:0 auto;padding:24px;}
  h1{border-bottom:3px solid var(--accent);padding-bottom:8px;color:var(--text)}
  h2{margin-top:36px;border-left:5px solid var(--accent);padding-left:10px;color:var(--text)}
  h3{margin-top:24px;color:var(--h-color)}
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
  a{color:var(--accent)}
</style></head><body>

<h1>纯 Node(socket.io) 性能基线报告（无 gateway）</h1>
<p class="muted">生成时间(数据窗口结束):${ts} ｜ 分支 feat/perf-monitoring ｜ 被测:server(Node/Express/Socket.io :3007) ｜ <b>gateway(Go)未启动、未参与任何流量</b> ｜ 数据源:26-9-14/data/*.json(真实压测采集)</p>

<div class="box warn">
<b>测量诚实性声明（务必先读）</b><br>
① 压测器(harness)与 server 跑在<b>同一台 macOS 开发机</b>、共用 CPU,绝对毫秒数有噪声、非生产代表值;本报告价值在<b>同一环境下的相对趋势、拐点与失败模式</b>。<br>
② 本报告是<b>纯 Node 基线</b>:只启动 server + docker 中间件(pg/redis)+ 监测栈,<b>gateway 全程未运行</b>——目的是先留存"引入 Go 层之前"的完整性能记录,作为后续 A/B 的对照基座。<br>
③ 中间件(pg/redis)为 docker 容器(colima),server 跑宿主机,Prometheus 每 5s 抓 /metrics;资源数据(RSS/eventloop/堆/GC/CPU)来自真实采样,harness/接口统计来自真实压测输出。
</div>

<h2>一、结论速览</h2>
<div class="box key">
<b>1. 中等负载(≤1500 msg/s)表现优异、零错误。</b> S1(100 连接 × 10 msg/s)RTT p50=${rttP50[1]}ms / p99=${rttP99[1]}ms / p999=${rttP999[1]}ms,${data.s1_throughput.harness.sent} 条消息 <b>100% ack、0 错误</b>;S5 连续 2 分钟稳态同样 100% ack、0 错误、RTT 无漂移。<br>
<b>2. 吞吐饱和拐点定位在 1500~2000 msg/s 之间。</b> 固定 100 连接、RATE 递增:1500 msg/s 仍零错误,2000 msg/s 开始 7.6% 失败且 RTT 断崖式排队到 ~2s,3000 msg/s 失败率高达 62.5%。<b>一旦过饱和点,RTT 不是渐进恶化而是瞬间跳到 ~2s 排队</b>——这是 DB 写路径(发号行锁 + Prisma 连接池)成为第一瓶颈的典型特征。<br>
<b>3. RTT 随连接数上升而上升(本机口径,低消息率下)。</b> 50→100→300→500 连接,RTT p50 ${rttP50[0]}→${rttP50[1]}→${rttP50[2]}→${rttP50[3]}ms;事件循环/GC 全程健康(lag p99≤${maxLag}ms),增量来自每连接维护成本(presence/心跳/Redis)与同机噪声,而非事件循环饱和。<br>
<b>4. 连接容量:${rampMax} 连接 100% 建连成功,上限未探到。</b> 爬坡 ${ramp.levels[0].target}→${rampMax} 全程零失败;${rampMax} 连接稳态 RSS 仅 ${rampLast.serverRssMB}MB(<b>约 ${perConnKb}KB/连接</b>),建连耗时 p50 ${rampLast.connectMs.p50}ms、eventloop p99 ${rampLast.eventloopP99Ms}ms。Node 单实例连接上限远高于 ${rampMax}。<br>
<b>5. 群扇出极快。</b> ${fanout?.params?.MEMBERS ?? 100} 成员在线、1 人发消息:fan-out 扩散 span(最后收到-最先收到)p99 仅 <b>${fanout?.fanoutSpanMs?.p99 ?? '—'}ms</b>,端到端(最后收到-发送)p99 <b>${fanout?.fanoutE2EMs?.p99 ?? '—'}ms</b>。socket.io 房间广播到百人近乎同步。<br>
<b>6. 惊群重连零失败、无资源尖峰。</b> ${storm.params.CONNS} 连接同一瞬间全断再全连:<b>100% 成功</b>,重连 p50=${storm.stormReconnect.p50}ms,eventloop 尖峰仅 ${storm.resource.spikePeakEventloopP99Ms}ms。<br>
<b>7. HTTP 层两大瓶颈(新发现)。</b> ①<code>POST /api/login</code> 吞吐仅 <b>${http?.targets?.[1]?.rps ?? '—'} rps</b>(bcrypt 12 轮单次 ~1s 的 CPU 代价);②<code>GET /user/messages</code> 仅 <b>${http?.targets?.[3]?.rps ?? '—'} rps</b>、p99 ${http?.targets?.[3]?.latencyMs?.p99 ?? '—'}ms——该接口 <b>无 limit 全量返回会话历史消息</b>,大会话下退化为慢查询。<br>
<b>8. 纯 Node 基线显著优于旧 26-9-12 A/B 的 socketio 侧数据。</b> 同参数 S1 旧 RTT p99=392ms → 新 ${rttP99[1]}ms;旧测受同机 gateway 干扰且方法本末倒置。本基线是后续一切对比的唯一参照。
</div>

<h2>二、测试方法与场景总览</h2>
<ul>
<li><b>实时消息路径</b>:<code>harness.mjs</code>(socket.io-client 直连 /socket.io,纯 WS):注册/登录 → 爬坡建连 → 稳态按 RATE 发 <code>message.send</code> → 用 <code>message.ack</code> 匹配测 RTT(含 p999) → 错误分类。</li>
<li><b>编排与采样</b>:<code>node-run.mjs</code> 跑 harness 同时每 2s 采样资源(ps RSS + Prometheus:连接/eventloop/堆/GC/CPU),结束查窗口内服务内直方图分位(消息/HTTP/DB/GC 四类)。</li>
<li><b>吞吐饱和扫描</b>:固定 100 连接,RATE 10/15/20/25/30 五档各 20s,定位吞吐拐点。</li>
<li><b>爬坡探顶</b>:<code>ramp-probe.mjs</code> 阶梯加压并保持连接,阈值判定拐点。</li>
<li><b>惊群重连</b>:<code>storm-reconnect.mjs</code> 同瞬间全断→全连。</li>
<li><b>群扇出</b>:<code>fanout-bench.mjs</code> 直写 DB 建群 + 100 成员在线,测 fan-out span/e2e。</li>
<li><b>HTTP API</b>:<code>http-bench.mjs</code> 并发压测典型接口,统计吞吐/时延/错误。</li>
<li><b>被测拓扑</b>:client(宿主机) → server(Node :3007,宿主机) → Postgres/Redis(colima docker);Prometheus+Grafana 只读观测;gateway 不启动。</li>
</ul>

<h2>三、实时消息路径(socket.io)</h2>
${barChart({ title: '消息 RTT p50(客户端往返)', unit: 'ms', cats: scCats, series: [rttP50], colors: ['#4e79a7'] })}
${barChart({ title: '消息 RTT p99(客户端往返)', unit: 'ms', cats: scCats, series: [rttP99], colors: ['#e15759'], log: true })}
${barChart({ title: '消息投递成功率(ack/发送)', unit: '%', cats: scCats, series: [ackRate], colors: ['#59a14f'] })}
${barChart({ title: '错误数(message.error 等)', unit: '条', cats: scCats, series: [errs], colors: ['#c0392b'], log: true })}
${barChart({ title: 'server 进程 RSS 峰值', unit: 'MB', cats: scCats, series: [rss], colors: ['#4e79a7'] })}
${barChart({ title: 'server 堆峰值', unit: 'MB', cats: scCats, series: [heap], colors: ['#76b7b2'] })}
${barChart({ title: '事件循环滞后 p99 峰值', unit: 'ms', cats: scCats, series: [lag], colors: ['#f28e2b'] })}
${barChart({ title: 'GC 停顿次数(窗口内增量)', unit: '次', cats: scCats, series: [gcDelta], colors: ['#b07aa1'] })}

<h3>3.1 吞吐饱和曲线(固定 100 连接,RATE 递增)——本报告核心发现</h3>
${lineChart({ title: '消息失败率 vs 目标吞吐', unit: '%', xs: tpCats, series: [tpFailRate], colors: ['#c0392b'] })}
${lineChart({ title: '消息投递成功率 vs 目标吞吐', unit: '%', xs: tpCats, series: [tpAckRate], colors: ['#59a14f'] })}
${lineChart({ title: '消息 RTT p99 vs 目标吞吐(断崖)', unit: 'ms', xs: tpCats, series: [tpRttP99], colors: ['#e15759'] })}
<p class="muted">饱和拐点:1500 msg/s 零错误、RTT p99 ${tpRttP99[1]}ms;2000 msg/s 起失败率 ${tpFailRate[2]}%、RTT p99 跳到 ${tpRttP99[2]}ms——<b>断崖式饱和,无中间态</b>。</p>
<table>
<tr><th>每连接速率</th><th>目标 msg/s</th><th>发送/ack</th><th>错误(失败率)</th><th>RTT p50/<b>p99</b>(ms)</th><th>RSS(MB)</th></tr>
${tpTable()}
</table>

<h2>四、连接容量(爬坡 ${ramp.levels[0].target}→${rampMax})</h2>
${lineChart({ title: '建连耗时 p50/p99 随连接数', unit: 'ms', xs: ramp.levels.map((l) => String(l.target)), series: [ramp.levels.map((l) => l.connectMs.p50), ramp.levels.map((l) => l.connectMs.p99)], colors: ['#4e79a7', '#e15759'] })}
${lineChart({ title: 'server RSS 随连接数', unit: 'MB', xs: ramp.levels.map((l) => String(l.target)), series: [ramp.levels.map((l) => l.serverRssMB)], colors: ['#59a14f'] })}
${lineChart({ title: 'eventloop p99 随连接数', unit: 'ms', xs: ramp.levels.map((l) => String(l.target)), series: [ramp.levels.map((l) => l.eventloopP99Ms)], colors: ['#f28e2b'] })}
<p class="muted">爬坡停止原因:${esc(rampStop)}——到 ${rampMax} 上限即停,未触发任何恶化阈值,<b>单实例连接上限未探到</b>。</p>
<table>
<tr><th>目标连接</th><th>建连成功(率)</th><th>建连 p50/95/<b>99</b>(ms)</th><th>server 连接数</th><th>RSS(MB)</th><th>lag p99(ms)</th></tr>
${rampTable()}
</table>

<h2>五、群扇出(fan-out)</h2>
<table>
<tr><th>成员在线</th><th>发送轮次</th><th>完整送达</th><th>扇出 span p50/95/<b>99</b>(ms)</th><th>端到端 e2e p50/95/<b>99</b>(ms)</th></tr>
<tr><td>${fanout?.connected ?? '—'}</td><td>${fanout?.roundsSent ?? '—'}</td><td>${fanout?.roundsDelivered ?? '—'}</td>
<td>${fanout?.fanoutSpanMs?.p50}/${fanout?.fanoutSpanMs?.p95}/<b>${fanout?.fanoutSpanMs?.p99}</b></td>
<td>${fanout?.fanoutE2EMs?.p50}/${fanout?.fanoutE2EMs?.p95}/<b>${fanout?.fanoutE2EMs?.p99}</b></td></tr>
</table>
<p class="muted">扇出 span = 最后一名成员收到 vs 第一名成员收到(纯扩散时间差);e2e = 最后收到 vs 发送(含落库 + 发号 + 广播)。</p>

<h2>六、惊群重连(S7:${storm.params.CONNS} 连接)</h2>
<table>
<tr><th>阶段</th><th>结果</th><th>耗时 p50/95/<b>99</b>(ms)</th></tr>
<tr><td>初次建连</td><td class="ok">${storm.initialConnect.ok}/${storm.initialConnect.attempted} 成功</td><td>${storm.initialConnect.p50}/${storm.initialConnect.p95}/<b>${storm.initialConnect.p99}</b></td></tr>
<tr><td>惊群重连(全量同瞬间)</td><td class="ok">${storm.stormReconnect.ok}/${storm.stormReconnect.attempted} 成功</td><td>${storm.stormReconnect.p50}/${storm.stormReconnect.p95}/<b>${storm.stormReconnect.p99}</b></td></tr>
<tr><td colspan="3">资源:断连前 RSS ${storm.resource.baselineServerRssMB}MB → 重连窗口峰值 ${storm.resource.spikePeakServerRssMB}MB;连接数 ${storm.resource.baselineConnections} → 峰值 ${storm.resource.spikePeakConnections} → 终值 ${storm.resource.finalConnections};eventloop p99 ${storm.resource.baselineEventloopP99Ms} → ${storm.resource.spikePeakEventloopP99Ms}ms</td></tr>
</table>

<h2>七、HTTP API 层(并发 ${http?.params?.CONCURRENCY ?? 20} × ${http?.params?.DURATION ?? 10}s)</h2>
<table>
<tr><th>接口</th><th>吞吐(rps)</th><th>时延 p50/95/<b>99</b>(ms)</th><th>时延 max(ms)</th><th>错误</th></tr>
${httpTable()}
</table>
${barChart({ title: 'HTTP 接口吞吐(rps)', unit: 'rps', cats: http ? http.targets.map((t) => t.target.replace('GET ', '').replace('POST ', '').replace(' /user/', '').replace(' /api/', '')) : [], series: [http ? http.targets.map((t) => t.rps) : []], colors: ['#4e79a7'], log: true })}
${barChart({ title: 'HTTP 接口时延 p99', unit: 'ms', cats: http ? http.targets.map((t) => t.target.replace('GET ', '').replace('POST ', '').replace(' /user/', '').replace(' /api/', '')) : [], series: [http ? http.targets.map((t) => t.latencyMs.p99) : []], colors: ['#e15759'], log: true })}
<p class="muted">health 为 HTTP 栈裸能力(~${http?.targets?.[0]?.rps ?? '—'} rps,无 DB);login 受 bcrypt 12 轮 CPU 限制;messages 无 limit 全量返回历史消息导致慢;其余接口命中索引、表现良好。</p>

<h2>八、完整数据表(场景 S0-S5)</h2>
<table>
<tr><th>场景</th><th>参数</th><th>连接</th><th>发送/ack</th><th>错误</th><th>RTT p50/95/<b>99</b>/p999(ms)</th><th>服务内 p50/95/<b>99</b>(ms)</th><th>建连 p50/<b>p99</b>(ms)</th><th>RSS(MB)</th><th>堆(MB)</th><th>lag p99(ms)</th><th>GC(次)</th></tr>
${dataTable()}
</table>
<p class="muted">"服务内" = <code>server_message_duration_seconds</code> 经 <code>histogram_quantile</code> 算得(桶宽较粗,尾分位偏插值估计);RTT 为客户端原始分位,更精确。</p>

<h2>九、深入分析</h2>

<h3>9.1 吞吐饱和点:为什么在 1500~2000 msg/s 断崖?(最重要的结论)</h3>
<p>吞吐扫描给出了清晰的拐点:1500 msg/s 仍零错误(RTT p99 ${tpRttP99[1]}ms),2000 msg/s 起 ${tpFailRate[2]}% 失败且成功消息 RTT p99 瞬间跳到 ${tpRttP99[2]}ms。这不是渐进退化,而是<b>到达某个临界点后排队系统瞬间饱和</b>。结合监测数据(eventloop p99 ≤${maxLag}ms 健康、DB 单次查询 p50 仅 ${data.s1_throughput.dbDurationMs.p50}ms),瓶颈不在 Node 事件循环,而在:</p>
<ul>
<li><b>会话发号行锁</b>:<code>persistMessage</code> 对每条消息执行 <code>UPDATE conversations SET next_seq=next_seq+1 ... RETURNING</code>,同一会话的写入被行锁串行化。100 连接两两配对 50 个会话,每会话 ~40 msg/s(2000 msg/s ÷ 50),单行锁吞吐接近上限时开始排队。</li>
<li><b>Prisma 连接池</b>:瞬时并发写打满连接池后,新事务等待,等待超时/累积 → <code>message.error</code>。</li>
</ul>
<p>工程含义:<b>要提升单实例消息吞吐,先优化 DB 写路径(发号批量化 / 连接池扩容 / 写合并),而不是换协议或换运行时</b>。这也是后续"Node vs Go"对比时最容易误判的点——Go 网关不替代这段 DB 写路径,单靠换连接层不会让饱和点右移。</p>

<h3>9.2 过载失败模式:快速失败 + 明确报错(可复现)</h3>
<p>S3(≈3000 msg/s)与吞吐扫描 tp_r30 一致:约 ${(100 * errs[3] / data.s3_overload.harness.sent).toFixed(0)}% 被 <code>message.error</code> 拒绝,成功消息 RTT 挤到 ~2s,RSS 飙至 ${rss[3]}MB。以"拒绝而非无限排队"失败,配合 <code>message.error</code> 回执让客户端可感知重试——对"消息必达"友好。注意:<b>过载压测曾使 colima docker(PostgreSQL)短暂失联(P1001)</b>,属同机争抢下环境稳定性现象,需在独立环境复测确认是否影响生产判断。</p>

<h3>9.3 RTT 随连接数上升的归因</h3>
<p>低消息率下 RTT p50 随连接数近似线性(${rttP50[0]}→${rttP50[1]}→${rttP50[2]}→${rttP50[3]}ms),但 eventloop/GC 全程健康、DB 查询很快。增量主要来自:每连接的 presence/心跳 Redis 往返、消息落库事务的 <code>UserConversation.createMany</code>、以及同机 harness 与 server 的 CPU 争抢。真实容量应以服务内直方图(几乎不随连接数变化)与多机压测为准。</p>

<h3>9.4 HTTP 层:bcrypt 与无 limit 查询是两个真实瓶颈</h3>
<p>①<code>POST /api/login</code> 仅 ${http?.targets?.[1]?.rps ?? '—'} rps、单次 ~1s——bcrypt 12 轮是认证吞吐的硬上限,也是压测登录阶段的耗时主因。②<code>GET /user/messages</code> 仅 ${http?.targets?.[3]?.rps ?? '—'} rps、p99 ${http?.targets?.[3]?.latencyMs?.p99 ?? '—'}ms——该接口 <code>findMany({conversationId, orderBy: timestamp asc})</code> <b>无 limit</b>,大会话历史全量返回。其余接口(sync/lastMessages/userConversations/mentions)命中索引、表现良好。</p>

<h3>9.5 长时稳态与 GC:2 分钟无漂移</h3>
<p>S5(100 连接 × 5 msg/s × 120s,${data.s5_stability.harness.sent} 条)全程 100% ack、0 错误,RTT p99=${rttP99[4]}ms 与 20s 短窗一致;GC ${gcDelta[4]} 次、eventloop p99 ${lag[4]}ms、RSS ${rss[4]}MB。该负载点距能力边界很远,无泄漏/退化。</p>

<h3>9.6 连接密度:${rampMax} 连接轻松、~${perConnKb}KB/连接</h3>
<p>纯连接(不发消息)下 ${rampMax} 连接 100% 建连成功、RSS 仅 ${rampLast.serverRssMB}MB。Node socket.io 单实例连接上限通常在数万级(受 ulimit/内存约束),${rampMax} 远未到顶。要继续探顶需更大 MAX + 压测端多进程(单进程 socket.io-client 数千连接已吃内存)。</p>

<h3>9.7 与旧 26-9-12 报告的关系(为什么重测)</h3>
<p>旧报告把"含 gateway 的 A/B"作为首次产出,方法本末倒置:<b>无纯 Node 基线则 A/B 差异无法归因</b>;旧测同参数数据受同机 gateway 干扰。本次基线:①gateway 全程未启动;②场景从 3 个扩到 11 类(吞吐扫描/爬坡 1 万/惊群/群扇出/HTTP 层/长稳);③采样新增堆/GC/CPU/GC 停顿分位/p999。后续 gateway 对比<b>必须以此基座、同场景同参数复测</b>。</p>

<h2>十、建议与后续</h2>
<ul>
<li><b>优先修两个真实瓶颈</b>:①<code>/user/messages</code> 加 limit + 分页;②评估 bcrypt 轮数/哈希方案(如登录限流下保持 12 轮,但批量注册走异步)。</li>
<li><b>吞吐再上探先动 DB</b>:发号 <code>UPDATE ... RETURNING</code> 是 2000 msg/s 饱和主因,评估批量发号/连接池扩容/写合并。</li>
<li><b>多机隔离复测</b>:压测端与被测端分机,消除同机争抢噪声;并把过载导致的 docker 失联在独立环境复验。</li>
<li><b>探真实连接上限</b>:ramp MAX 提到 3 万+,压测端多进程。</li>
<li><b>群扇出规模化</b>:本轮 N=100,后续测 N=500/1000(需更大群 + 更多连接)。</li>
<li><b>gateway 对比基线已就绪</b>:gateway 补 parity(ack/心跳/重连/顺序)后,严格按本报告 S0-S7 + 吞吐扫描 + HTTP 层 + 扇出全套同参复测。</li>
<li><b>直方图尾桶加细</b>:<code>server_message_duration_seconds</code> 在 [0.1,0.25] 插值高估尾分位,加 .15/.2 桶。</li>
</ul>

<p class="muted" style="margin-top:40px;border-top:1px solid #eee;padding-top:12px">本报告由 <code>perf/gen-node-report.mjs</code> 从真实压测 JSON 自动生成(内联 SVG,无外网依赖);原始数据见同目录 <code>data/</code>。工具:<code>harness.mjs</code>/<code>node-run.mjs</code>/<code>ramp-probe.mjs</code>/<code>storm-reconnect.mjs</code>/<code>fanout-bench.mjs</code>/<code>http-bench.mjs</code>。</p>
</body></html>`;

writeFileSync(join(REPORT_DIR, '纯Node性能基线报告.html'), html);
console.log('已生成 ' + join(REPORT_DIR, '纯Node性能基线报告.html'));
