// 读取 测试报告/<REPORT_SUBDIR>/data/*.json,生成自包含 HTML 报告(内联 SVG 图表,无外网依赖,可长期归档)。
// 数据命名约定:<key>_socketio.json(26-9-14 纯 Node 基线,复制改名)/ <key>_gateway.json(本次 gateway 路径)。
// 覆盖:S0-S5 主场景 A/B + 吞吐饱和扫描 + S6 爬坡 + S7 惊群 + 群扇出 + HTTP API 层。
// 每期测试产物按 测试报告/<日期>/ 归档(与 26-9-14 同结构);期目录用 env REPORT_SUBDIR 指定。
// 用法:REPORT_SUBDIR=26-9-16 node gen-report.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告');
const REPORT_SUBDIR = process.env.REPORT_SUBDIR || '26-9-16'; // 期目录(如 26-9-16);不设时默认最新期
const DATA = join(REPORT_DIR, REPORT_SUBDIR, 'data');
const load = (n) => {
  const p = join(DATA, n + '.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const loadAB = (key) => ({ a: load(key + '_socketio'), b: load(key + '_gateway') });

const scenarios = [
  { key: 's0', title: 'S0 Smoke', desc: '50 连接 × 2 msg/s × 15s(冒烟)' },
  { key: 's1', title: 'S1 常规吞吐', desc: '100 连接 × 10 msg/s × 20s(≈1000 msg/s)' },
  { key: 's2', title: 'S2 连接规模', desc: '300 连接 × 2 msg/s × 15s(≈600 msg/s,低消息率、看连接与资源)' },
  { key: 's3', title: 'S3 过载压力', desc: '150 连接 × 20 msg/s × 15s(≈3000 msg/s,探失败模式)' },
  { key: 's4', title: 'S4 大连接', desc: '500 连接 × 1 msg/s × 15s(≈500 msg/s,看连接与资源)' },
  { key: 's5', title: 'S5 长时稳态', desc: '100 连接 × 5 msg/s × 120s(长稳漂移/心跳有效性)' },
];
const tpKeys = [10, 15, 20, 25, 30].map((r) => `tp_r${r}`);
const data = {};
for (const s of scenarios) data[s.key] = loadAB(s.key);
const tpData = tpKeys.map((k) => loadAB(k));
const ramp = loadAB('s6_ramp');
const storm = loadAB('s7_storm');
const fanout = loadAB('fanout');
const http = loadAB('http');

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const errSum = (h) => Object.values(h?.errors || {}).reduce((a, b) => a + b, 0);
const f1 = (v) => (v == null || Number.isNaN(v) ? '—' : Math.round(v * 10) / 10);
const f2 = (v) => (v == null || Number.isNaN(v) ? '—' : Math.round(v * 100) / 100);
const errRate = (h) => (h?.sent ? +(100 * errSum(h) / h.sent).toFixed(1) : null);
const ackRate = (h) => (h?.sent ? +(100 * h.ack / h.sent).toFixed(1) : null);
const COLOR_A = '#4e79a7', COLOR_B = '#e15759';

// 分组柱状图(A=Node 蓝 vs B=Go 红),自动纵轴缩放。
function groupedBar(title, unit, cats, seriesA, seriesB, opts = {}) {
  const W = 760, H = 320, padL = 64, padR = 20, padT = 44, padB = 54;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const all = [...seriesA, ...seriesB].filter((v) => v != null && !Number.isNaN(v));
  let maxV = Math.max(1, ...all);
  const nice = Math.pow(10, Math.floor(Math.log10(maxV)));
  maxV = Math.ceil(maxV / nice) * nice || maxV;
  const groups = cats.length, gw = plotW / groups, bw = Math.min(46, gw / 3);
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  let bars = '', labels = '', ticks = '';
  // 颜色走 CSS 变量/类(深浅色双主题):网格 --grid、刻度 --muted、类目/标题/图例 --text、A/B 系列 class
  for (let t = 0; t <= 4; t++) { const v = (maxV / 4) * t, yy = y(v); ticks += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--grid)"/><text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${+(+v.toFixed(v < 10 ? 1 : 0))}</text>`; }
  cats.forEach((c, i) => {
    const cx = padL + gw * i + gw / 2;
    const a = seriesA[i], b = seriesB[i];
    if (a != null && !Number.isNaN(a)) { const yy = y(a); bars += `<rect class="series-a" x="${cx - bw - 3}" y="${yy}" width="${bw}" height="${padT + plotH - yy}" fill="${COLOR_A}"><title>Node(socket.io) ${f1(a)}${unit}</title></rect><text class="series-a" x="${cx - bw / 2 - 3}" y="${yy - 4}" text-anchor="middle" font-size="10" fill="${COLOR_A}">${f1(a)}</text>`; }
    if (b != null && !Number.isNaN(b)) { const yy = y(b); bars += `<rect class="series-b" x="${cx + 3}" y="${yy}" width="${bw}" height="${padT + plotH - yy}" fill="${COLOR_B}"><title>Go(gateway) ${f1(b)}${unit}</title></rect><text class="series-b" x="${cx + bw / 2 + 3}" y="${yy - 4}" text-anchor="middle" font-size="10" fill="${COLOR_B}">${f1(b)}</text>`; }
    labels += `<text x="${cx}" y="${H - padB + 18}" text-anchor="middle" font-size="12" fill="var(--text)">${esc(c)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(title)}">
    <text x="${W / 2}" y="22" text-anchor="middle" font-size="14" font-weight="600" fill="var(--text)">${esc(title)}（${unit}）</text>
    ${ticks}${bars}${labels}
    <rect class="series-a" x="${W - 196}" y="6" width="12" height="12" fill="${COLOR_A}"/><text class="leg" x="${W - 180}" y="16" font-size="11">Node(socket.io)</text>
    <rect class="series-b" x="${W - 84}" y="6" width="12" height="12" fill="${COLOR_B}"/><text class="leg" x="${W - 68}" y="16" font-size="11">Go(gateway)</text>
  </svg>`;
}

// 折线图(吞吐扫描:横轴 RATE,两条折线 A/B)
function lineChart(title, unit, xs, seriesA, seriesB) {
  const W = 760, H = 320, padL = 64, padR = 20, padT = 44, padB = 54;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const all = [...seriesA, ...seriesB].filter((v) => v != null && !Number.isNaN(v));
  let maxV = Math.max(1, ...all);
  const nice = Math.pow(10, Math.floor(Math.log10(maxV)));
  maxV = Math.ceil(maxV / nice) * nice || maxV;
  const x = (i) => padL + (plotW * i) / (xs.length - 1);
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  const mkPath = (cls, arr) => {
    let d = '', dots = '';
    arr.forEach((v, i) => {
      if (v == null || Number.isNaN(v)) return;
      d += (d ? ' L' : 'M') + `${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      dots += `<circle class="${cls}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5"><title>RATE=${xs[i]} → ${f1(v)}${unit}</title></circle>`;
    });
    return `<path class="${cls}" d="${d}" fill="none" stroke-width="2.5"/>${dots}`;
  };
  let ticks = '';
  for (let t = 0; t <= 4; t++) { const v = (maxV / 4) * t, yy = y(v); ticks += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--grid)"/><text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${+(+v.toFixed(v < 10 ? 1 : 0))}</text>`; }
  let labels = '';
  xs.forEach((v, i) => { labels += `<text x="${x(i)}" y="${H - padB + 18}" text-anchor="middle" font-size="12" fill="var(--text)">${v}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(title)}">
    <text x="${W / 2}" y="22" text-anchor="middle" font-size="14" font-weight="600" fill="var(--text)">${esc(title)}（${unit}）</text>
    ${ticks}${mkPath('series-a', seriesA)}${mkPath('series-b', seriesB)}${labels}
    <rect class="series-a" x="${W - 196}" y="6" width="12" height="12" fill="${COLOR_A}"/><text class="leg" x="${W - 180}" y="16" font-size="11">Node(socket.io)</text>
    <rect class="series-b" x="${W - 84}" y="6" width="12" height="12" fill="${COLOR_B}"/><text class="leg" x="${W - 68}" y="16" font-size="11">Go(gateway)</text>
  </svg>`;
}

const cats = scenarios.map((s) => s.title.replace(/^S\d /, ''));
const has = (d) => d?.a && d?.b;
const pick = (d, fn) => (has(d) ? { a: fn(d.a), b: fn(d.b) } : { a: null, b: null });

// ---------------- 主场景图表数据 ----------------
const rttP99 = scenarios.map((s) => pick(data[s.key], (r) => r.harness.rttMs?.p99));
const rttP999 = scenarios.map((s) => pick(data[s.key], (r) => r.harness.rttMs?.p999));
const errs = scenarios.map((s) => pick(data[s.key], (r) => errSum(r.harness)));
const ackR = scenarios.map((s) => pick(data[s.key], (r) => ackRate(r.harness)));
const srvRss = scenarios.map((s) => pick(data[s.key], (r) => r.resource.peakServerRssMB));
const gwRss = scenarios.map((s) => pick(data[s.key], (r) => r.resource.peakGatewayRssMB));
const el = scenarios.map((s) => pick(data[s.key], (r) => r.resource.peakEventloopP99Ms));
const goro = scenarios.map((s) => pick(data[s.key], (r) => r.resource.peakGoroutines));

// ---------------- 主场景数据表 ----------------
function mainTable() {
  let rows = '';
  for (const s of scenarios) {
    for (const [modeName, r] of [['Node(socket.io)', data[s.key]?.a], ['Go(gateway)', data[s.key]?.b]]) {
      if (!r) continue;
      const h = r.harness, res = r.resource, si = r.serverInternalDurationMs ?? {}, e = errSum(h);
      rows += `<tr>
        <td>${s.title}</td><td>${modeName}</td>
        <td>${h.connectedCount}/${h.attempted}</td><td>${h.sent}/${h.ack}</td>
        <td class="${e ? 'bad' : 'ok'}">${e}${h.sent ? ` (${f1(100 * e / h.sent)}%)` : ''}</td>
        <td>${f1(h.rttMs?.p50)}/${f1(h.rttMs?.p95)}/<b>${f1(h.rttMs?.p99)}</b>/${f1(h.rttMs?.p999)}</td>
        <td>${f1(si.p99)}</td>
        <td>${f1(res.peakServerRssMB)}</td><td>${f1(res.peakGatewayRssMB)}</td>
        <td>${f2(res.peakEventloopP99Ms)}</td><td>${f1(res.peakGoroutines)}</td>
        <td>${h.retriesSent ?? 0}</td>
      </tr>`;
    }
  }
  return rows;
}

// ---------------- 吞吐饱和扫描表 ----------------
function tpTable() {
  let rows = '';
  for (const k of tpKeys) {
    const d = loadAB(k);
    for (const [modeName, r] of [['Node', d.a], ['Go', d.b]]) {
      if (!r) continue;
      const h = r.harness, e = errSum(h);
      rows += `<tr><td>${k}</td><td>${modeName}</td><td>${h.sent}</td><td>${h.ack}</td>
        <td class="${e ? 'bad' : 'ok'}">${e} (${f1(h.sent ? 100 * e / h.sent : 0)}%)</td>
        <td>${f1(h.rttMs?.p50)}</td><td>${f1(h.rttMs?.p95)}</td><td><b>${f1(h.rttMs?.p99)}</b></td><td>${f1(h.rttMs?.p999)}</td>
        <td>${f1(r.resource?.peakServerRssMB)}</td><td>${f1(r.resource?.peakGatewayRssMB)}</td><td>${f2(r.resource?.peakEventloopP99Ms)}</td></tr>`;
    }
  }
  return rows;
}

// ---------------- S6 爬坡表 ----------------
function rampTable() {
  if (!ramp?.b) return '<p class="muted">无 gateway 爬坡数据。</p>';
  const b = ramp.b;
  let rows = b.levels.map((l) => `<tr><td>${l.target}</td><td>${l.batchOk}/${l.batchAttempted} (${(l.successRate * 100).toFixed(1)}%)</td>
    <td>${f1(l.connectMs?.p50)}/${f1(l.connectMs?.p95)}/${f1(l.connectMs?.p99)}</td>
    <td>${l.heldAfter}</td><td>${f1(l.gatewayConnections)}</td><td>${f1(l.goroutines)}</td>
    <td>${f2(l.eventloopP99Ms)}</td><td>${f1(l.gatewayRssMB)}</td><td>${f1(l.serverRssMB)}</td></tr>`).join('');
  const a = ramp.a;
  const aRows = a?.levels ? a.levels.map((l) => `<tr><td>${l.target}</td><td>${l.batchOk}/${l.batchAttempted} (${(l.successRate * 100).toFixed(1)}%)</td>
    <td>${f1(l.connectMs?.p50)}/${f1(l.connectMs?.p95)}/${f1(l.connectMs?.p99)}</td>
    <td>${l.heldAfter}</td><td>${f1(l.serverConnections)}</td><td>—</td>
    <td>${f2(l.eventloopP99Ms)}</td><td>—</td><td>${f1(l.serverRssMB)}</td></tr>`).join('') : '';
  return `<h4>gateway 路径(本次)</h4><table>
    <tr><th>目标连接</th><th>建连成功(成功率)</th><th>建连耗时 p50/95/99(ms)</th><th>实际持有</th><th>gw 连接数</th><th>goroutine</th><th>eventloop p99(ms)</th><th>gw RSS(MB)</th><th>server RSS(MB)</th></tr>${rows}</table>
    <p class="muted">拐点:${esc(b.stopReason ?? '—')};最大稳定连接 ${b.summary?.maxStableConnections ?? '—'}。</p>
    <h4>纯 Node 基线(26-9-14,对照)</h4><table>
    <tr><th>目标连接</th><th>建连成功(成功率)</th><th>建连耗时 p50/95/99(ms)</th><th>实际持有</th><th>server 连接数</th><th>goroutine</th><th>eventloop p99(ms)</th><th>gw RSS(MB)</th><th>server RSS(MB)</th></tr>${aRows}</table>
    <p class="muted">拐点:${esc(a?.stopReason ?? '—')};最大稳定连接 ${a?.summary?.maxStableConnections ?? '—'}。</p>`;
}

// ---------------- S7 惊群表 ----------------
function stormTable() {
  if (!storm?.b) return '<p class="muted">无 gateway 惊群数据。</p>';
  const mkRow = (modeName, r, gw) => {
    const rc = r.stormReconnect, res = r.resource;
    return `<tr><td>${modeName}</td><td>${rc.ok}/${rc.attempted}</td>
      <td>${f1(rc.p50)}/${f1(rc.p95)}/<b>${f1(rc.p99)}</b></td><td>${f1(rc.max)}</td>
      <td>${gw ? f1(res.baselineGatewayRssMB) + '→' + f1(res.spikePeakGatewayRssMB) : '—'}</td>
      <td>${f1(res.baselineServerRssMB)}→${f1(res.spikePeakServerRssMB)}</td>
      <td>${gw ? f1(res.baselineGatewayConnections) + '→' + f1(res.spikePeakGatewayConnections) : f1(res.baselineConnections) + '→' + f1(res.spikePeakConnections)}</td>
      <td>${f2(res.baselineEventloopP99Ms)}→${f2(res.spikePeakEventloopP99Ms)}</td>
      <td>${gw ? f1(res.spikePeakGoroutines) : '—'}</td></tr>`;
  };
  return `<table>
    <tr><th>模式</th><th>重连成功</th><th>重连耗时 p50/95/99(ms)</th><th>max(ms)</th><th>gw RSS 基线→峰值(MB)</th><th>server RSS 基线→峰值(MB)</th><th>连接数 基线→峰值</th><th>eventloop p99 基线→峰值(ms)</th><th>goroutine 峰值</th></tr>
    ${storm.a ? mkRow('Node(socket.io)', storm.a, false) : ''}
    ${mkRow('Go(gateway)', storm.b, true)}</table>`;
}

// ---------------- 群扇出表 ----------------
function fanoutTable() {
  if (!fanout?.b) return '<p class="muted">无 gateway 扇出数据。</p>';
  const mkRow = (modeName, r) => `<tr><td>${modeName}</td><td>${r.connected}</td><td>${r.roundsSent}</td><td>${r.roundsDelivered}</td>
    <td>${f1(r.fanoutSpanMs?.p50)}/${f1(r.fanoutSpanMs?.p95)}/<b>${f1(r.fanoutSpanMs?.p99)}</b> (max ${f1(r.fanoutSpanMs?.max)})</td>
    <td>${f1(r.fanoutE2EMs?.p50)}/${f1(r.fanoutE2EMs?.p95)}/<b>${f1(r.fanoutE2EMs?.p99)}</b> (max ${f1(r.fanoutE2EMs?.max)})</td></tr>`;
  return `<table>
    <tr><th>模式</th><th>成员在线</th><th>发送条数</th><th>完整送达</th><th>扇出扩散 span p50/95/99(ms)</th><th>扇出端到端 e2e p50/95/99(ms)</th></tr>
    ${fanout.a ? mkRow('Node(socket.io)', fanout.a) : ''}
    ${mkRow('Go(gateway)', fanout.b)}</table>`;
}

// ---------------- HTTP 表 ----------------
function httpTable() {
  if (!http?.b) return '<p class="muted">无 gateway 轮 HTTP 数据。</p>';
  const mkRow = (modeName, r) => {
    const m = (t) => r.targets.find((x) => x.target === t);
    const cell = (t, fn) => { const x = m(t); return x ? fn(x) : '—'; };
    return `<tr><td>${modeName}</td>
      <td>${cell('GET /health', (x) => f1(x.rps))}</td>
      <td>${cell('POST /api/login (bcrypt)', (x) => f1(x.rps) + '(' + f1(x.latencyMs?.p99) + 'ms)')}</td>
      <td>${cell('GET /user/userConversations', (x) => f1(x.rps))}</td>
      <td>${cell('GET /user/messages', (x) => f1(x.rps) + '(' + f1(x.latencyMs?.p99) + 'ms)')}</td>
      <td>${cell('GET /user/lastMessages', (x) => f1(x.rps))}</td>
      <td>${cell('GET /user/sync', (x) => f1(x.rps))}</td>
      <td>${cell('GET /user/mentions', (x) => f1(x.rps))}</td></tr>`;
  };
  return `<table>
    <tr><th>模式</th><th>/health rps</th><th>/api/login rps(p99)</th><th>userConversations rps</th><th>/user/messages rps(p99)</th><th>lastMessages rps</th><th>sync rps</th><th>mentions rps</th></tr>
    ${http.a ? mkRow('Node 基线(26-9-14)', http.a) : ''}
    ${mkRow('gateway 轮(本次)', http.b)}</table>
    <p class="muted">HTTP 层两轮均直连 server REST(不经过 gateway),用于确认两轮压测环境一致(无差别即环境同口径)。</p>`;
}

// ---------------- 每连接资源成本表 ----------------
function perConnTable() {
  let rows = '';
  for (const s of scenarios) {
    const d = data[s.key];
    for (const [modeName, r] of [['Node(socket.io)', d?.a], ['Go(gateway)', d?.b]]) {
      if (!r) continue;
      const res = r.resource ?? {};
      const n = res.peakConnections ?? r.harness?.connectedCount ?? 1;
      rows += `<tr><td>${s.title}</td><td>${modeName}</td><td>${f1(res.peakServerRssMB)}</td><td>${f1(res.peakGatewayRssMB)}</td>
        <td>${f2(res.peakServerRssMB / n)}</td><td>${f2((res.peakGatewayRssMB ?? 0) / n)}</td>
        <td>${f2(res.serverCpuSecondsDelta)}</td><td>${f2(res.gatewayCpuSecondsDelta)}</td></tr>`;
    }
  }
  return rows;
}

// ---------------- 结论速览(自动从数据提取) ----------------
function highlightBox() {
  const s1 = data.s1, s2 = data.s2, s3 = data.s3;
  const a = s1?.a, b = s1?.b;
  const parts = [];
  if (a && b) {
    const pa = a.harness.rttMs?.p99, pb = b.harness.rttMs?.p99;
    parts.push(`<b>1. 常规吞吐(S1,≈1000 msg/s)消息 RTT p99:Node ${f1(pa)}ms → Go ${f1(pb)}ms(${pb != null && pa ? ((pb / pa - 1) * 100).toFixed(0) : '—'}%)。</b>`);
    const ea = errSum(a.harness), eb = errSum(b.harness);
    parts.push(`错误:Node ${ea} 条 / Go ${eb} 条;Go 侧超时重发 ${f1(b.harness?.retriesSent ?? 0)} 帧。`);
  }
  if (s2?.a && s2?.b) {
    parts.push(`<b>2. 连接层(S2,300 连接):</b>Node server RSS 峰值 ${f1(s2.a.resource.peakServerRssMB)}MB(每连接 ${f2(s2.a.resource.peakServerRssMB / 300)}KB);Go gateway 仅 ${f1(s2.b.resource.peakGatewayRssMB)}MB / ${f1(s2.b.resource.peakGoroutines)} goroutine(每连接 ${f2((s2.b.resource.peakGatewayRssMB ?? 0) / 300)}KB)。gateway 路径总内存 = server + gateway 两者之和。`);
  }
  if (s3?.a && s3?.b) {
    const ea = errSum(s3.a.harness), eb = errSum(s3.b.harness);
    parts.push(`<b>3. 过载(S3,≈3000 msg/s)失败模式:</b>Node 错误 ${ea} 条(错误率 ${f1(errRate(s3.a.harness))}%,快速失败);Go 错误 ${eb} 条(错误率 ${f1(errRate(s3.b.harness))}%)、RTT p99 ${f1(s3.b.harness.rttMs?.p99)}ms(排队而非拒绝)。`);
  }
  const rampB = ramp?.b, rampA = ramp?.a;
  if (rampB) {
    parts.push(`<b>4. 连接容量:</b>gateway 路径探到 ${rampB.summary?.maxStableConnections ?? '—'} 连接(gw RSS ${f1(rampB.summary?.peakLevelGatewayRssMB)}MB / ${f1(rampB.summary?.peakLevelGoroutines)} goroutine;${esc(rampB.stopReason ?? '')});Node 基线 ${rampA?.summary?.maxStableConnections ?? '—'} 连接(${esc(rampA?.stopReason ?? '')})。`);
  }
  return parts.map((p) => `<li>${p}</li>`).join('');
}

const hasAnyGateway = scenarios.some((s) => data[s.key]?.b);
const maxTs = Math.max(...[].concat(...scenarios.map((s) => [data[s.key]?.a?.endedAt, data[s.key]?.b?.endedAt])).filter(Boolean));

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Node vs Go gateway 实时层性能对比报告</title>
<style>
  /* 深浅色双主题:跟随系统 prefers-color-scheme(与 gen-node-report.mjs 同一套变量,观感一致)。 */
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
  svg .series-a{fill:var(--accent);stroke:var(--accent)}
  svg .series-b{fill:#e15759;stroke:#e15759}
  svg .leg{fill:var(--text)}
</style></head><body>

<h1>Node(socket.io) vs Go gateway 实时层性能对比报告</h1>
<p class="muted">数据窗口结束时间:${maxTs ? new Date(maxTs).toISOString() : '—'} ｜ 分支 feat/perf-monitoring ｜ 数据源:测试报告/${REPORT_SUBDIR}/data/*.json(真实压测采集)</p>

<div class="box warn">
<b>测量诚实性声明(务必先读)</b><br>
① 全部服务(harness 负载生成 + Node server + Go gateway + Docker 中间件/Prometheus)<b>跑在同一台 macOS 开发机</b>,彼此抢 CPU,故<b>绝对毫秒数有噪声、非生产代表值</b>;本报告价值在<b>同机同负载下的相对 A/B 对比与定性失败模式</b>。<br>
② A = 纯 Node 基线(26-9-14,socket.io 直连 server :3007,gateway 未启动);B = gateway 路径(26-9-16,web 同款:原生 WS → gateway :8090 → Node /internal/gateway/uplink)。<b>B 是 A 基础上"加一层"</b>,业务/落库仍在 Node。<br>
③ 公平性:B 的压测客户端实现了与 socket.io 等价的 ack 匹配/5s 超时同键重发×3/25s 心跳/断线重连(对齐 web/src/ws/wsClient.ts),<b>不是裸发帧的假快路径</b>;两侧落库逻辑完全相同。<br>
④ 每场景 ≥3 轮取中位轮(RTT p99)落盘;RTT 用往返(clientMsgId 关联);资源按两侧进程 RSS/CPU 分别采样。
</div>

<h2>一、结论速览</h2>
<div class="box key"><ul>${highlightBox()}</ul></div>

<h2>二、测试方法</h2>
<ul>
<li><b>A = Node(socket.io)</b>:<code>perf/harness.mjs</code>,socket.io-client → server <code>/socket.io</code>(26-9-14 基线数据)。</li>
<li><b>B = Go(gateway)</b>:<code>perf/harness-gw.mjs</code>,原生 WebSocket(query token/deviceId)→ gateway <code>/ws</code> → 信封帧 <code>{type:'message.send',data:{...}}</code> → 等 <code>message.ack</code> 计 RTT。</li>
<li>编排 <code>perf/ab-run.mjs</code>:跑 harness + 每 2s 采样(Prometheus 连接/eventloop/goroutine/GC + <code>ps</code> 两进程 RSS/CPU)+ 服务内直方图分位(uplink/downlink/HTTP/GC)→ 落 JSON。</li>
<li>场景参数与 26-9-14 基线完全一致(S0-S5、吞吐扫描、爬坡、惊群、扇出、HTTP);爬坡探顶参数走 env(同 ramp-probe)。</li>
</ul>
<table><tr><th>场景</th><th>参数</th><th>目的</th></tr>
${scenarios.map((s) => `<tr><td>${s.title}</td><td>${s.desc}</td><td>${s.key === 's1' ? '常规吞吐下的 RTT' : s.key === 's2' || s.key === 's4' ? '连接规模下的资源占用' : s.key === 's3' ? '过载时的失败模式' : s.key === 's5' ? '长稳漂移与心跳有效性' : '冒烟'}</td></tr>`).join('')}</table>

<h2>三、图表(Node 蓝 vs Go 红)</h2>
${hasAnyGateway ? '' : '<p class="muted">尚无 gateway 数据文件。</p>'}
${groupedBar('消息 RTT p99(客户端往返)', 'ms', cats, rttP99.map((x) => x.a), rttP99.map((x) => x.b))}
${groupedBar('消息 RTT p999(尾延迟)', 'ms', cats, rttP999.map((x) => x.a), rttP999.map((x) => x.b))}
${groupedBar('错误数(所有错误分类之和)', '条', cats, errs.map((x) => x.a), errs.map((x) => x.b))}
${groupedBar('消息投递成功率(ack/发送)', '%', cats, ackR.map((x) => x.a), ackR.map((x) => x.b))}
${groupedBar('进程内存峰值(server RSS vs gateway RSS)', 'MB', cats, srvRss.map((x) => x.a), gwRss.map((x) => x.b))}
<p class="muted">注意口径:蓝=Node server 整体 RSS(含全部业务/DB),红=Go gateway 进程 RSS。gateway 路径实际总内存 = 两者之和。</p>
${groupedBar('Node 事件循环滞后 p99', 'ms', cats, el.map((x) => x.a), el.map((x) => x.b))}
${groupedBar('Go gateway goroutine 数', '个', cats, cats.map(() => null), goro.map((x) => x.b))}

<h3>3.1 吞吐饱和扫描(固定 100 连接,RATE 10→30,各 20s)</h3>
${lineChart('RTT p99 vs RATE', 'ms', tpKeys, tpData.map((d) => d.a?.harness?.rttMs?.p99), tpData.map((d) => d.b?.harness?.rttMs?.p99))}
${lineChart('错误率 vs RATE', '%', tpKeys, tpData.map((d) => errRate(d.a?.harness)), tpData.map((d) => errRate(d.b?.harness)))}
<table>
<tr><th>场景</th><th>模式</th><th>发送</th><th>ack</th><th>错误(错误率)</th><th>RTT p50</th><th>RTT p95</th><th>RTT p99</th><th>RTT p999</th><th>server RSS(MB)</th><th>gw RSS(MB)</th><th>eventloop p99(ms)</th></tr>
${tpTable()}
</table>

<h2>四、完整数据表(主场景)</h2>
<table>
<tr><th>场景</th><th>模式</th><th>连接(成功/尝试)</th><th>发送/ack</th><th>错误(错误率)</th><th>RTT p50/95/<b>99</b>/999(ms)</th><th>服务内 p99(ms)</th><th>server RSS(MB)</th><th>gateway RSS(MB)</th><th>eventloop p99(ms)</th><th>goroutine</th><th>重发帧数</th></tr>
${mainTable()}
</table>
<p class="muted">"服务内 p99" = 服务端消息处理直方图分位(Node 为 server_message_duration;Go 为 gateway_uplink_duration,收帧→Node ack),经 Prometheus histogram_quantile 算得,受桶宽影响偏粗。</p>

<h3>4.1 每连接资源成本</h3>
<table>
<tr><th>场景</th><th>模式</th><th>server RSS 峰值(MB)</th><th>gateway RSS 峰值(MB)</th><th>server KB/连接</th><th>gateway KB/连接</th><th>server CPU Δ(s)</th><th>gateway CPU Δ(s)</th></tr>
${perConnTable()}
</table>

<h2>五、专项场景</h2>
<h3>5.1 S6 连接爬坡探顶(2000 起每级 +2000 → 10000,每级保持 5s)</h3>
${rampTable()}
<h3>5.2 S7 惊群重连(300 连接同瞬间全断→全连)</h3>
${stormTable()}
<h3>5.3 群扇出(100 成员在线,1 人发 20 条)</h3>
${fanoutTable()}
<h3>5.4 HTTP API 层(7 接口,并发 20 × 10s,两轮均直连 server)</h3>
${httpTable()}

<h2>六、深入分析(详见配套 markdown 报告)</h2>
<p>归因证据链(gateway 路径):<code>gateway_uplink_duration_seconds</code>(收帧→Node ack 全程)/ <code>http_request_duration_seconds</code>(Node 侧 HTTP 处理)/ <code>db_query_duration_seconds</code>(落库)/ <code>nodejs_eventloop_lag</code> + <code>nodejs_gc_pause</code>(Node 运行时)/ <code>go_gc_duration</code> + <code>go_goroutines</code>(Go 运行时)。本 HTML 为数据自动汇总;结论、归因与单机极限分析见 <code>docs/监测设施/测试报告/26-9-16-Go网关压测对比报告.md</code>。</p>

<p class="muted" style="margin-top:40px;border-top:1px solid #eee;padding-top:12px">本报告由 <code>perf/gen-report.mjs</code> 从真实压测 JSON 自动生成(内联 SVG,无外网依赖);原始数据见同目录 <code>data/</code>。</p>
</body></html>`;

const outPath = join(REPORT_DIR, REPORT_SUBDIR, '性能对比报告.html');
mkdirSync(join(REPORT_DIR, REPORT_SUBDIR), { recursive: true });
writeFileSync(outPath, html);
console.log('已生成 ' + outPath);
