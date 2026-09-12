// 读取 测试报告/data/*.json,生成自包含 HTML 报告(内联 SVG 图表,无外网依赖,可长期归档)。
// 用法:node gen-report.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(__dir, '..', 'docs', '监测设施', '测试报告');
const DATA = join(REPORT_DIR, 'data');
const load = (n) => JSON.parse(readFileSync(join(DATA, n + '.json'), 'utf8'));

const scenarios = [
  { key: 's1', title: 'S1 吞吐/RTT', desc: '100 连接 × 10 msg/s × 20s(≈1000 msg/s)' },
  { key: 's2', title: 'S2 连接规模', desc: '300 连接 × 2 msg/s × 15s(≈600 msg/s,低消息率、看连接与资源)' },
  { key: 's3', title: 'S3 过载压力', desc: '150 连接 × 20 msg/s × 15s(≈3000 msg/s,探失败模式)' },
];
const data = {};
for (const s of scenarios) { data[s.key] = { a: load(s.key + '_socketio'), b: load(s.key + '_gateway') }; }

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const errSum = (h) => Object.values(h.errors || {}).reduce((a, b) => a + b, 0);

// 分组柱状图(A=Node vs B=Go),自动纵轴缩放。
function groupedBar(title, unit, cats, seriesA, seriesB, opts = {}) {
  const W = 720, H = 300, padL = 60, padR = 20, padT = 40, padB = 50;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const all = [...seriesA, ...seriesB].filter((v) => v != null && !Number.isNaN(v));
  let maxV = Math.max(1, ...all);
  if (opts.log) maxV = Math.max(...all);
  const nice = Math.pow(10, Math.floor(Math.log10(maxV)));
  maxV = Math.ceil(maxV / nice) * nice || maxV;
  const groups = cats.length, gw = plotW / groups, bw = Math.min(46, gw / 3);
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  let bars = '', labels = '', ticks = '';
  for (let t = 0; t <= 4; t++) { const v = (maxV / 4) * t, yy = y(v); ticks += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#eee"/><text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#888">${(+v.toFixed(v < 10 ? 1 : 0))}</text>`; }
  cats.forEach((c, i) => {
    const cx = padL + gw * i + gw / 2;
    const a = seriesA[i], b = seriesB[i];
    if (a != null) { const yy = y(a); bars += `<rect x="${cx - bw - 3}" y="${yy}" width="${bw}" height="${padT + plotH - yy}" fill="#4e79a7"><title>Node ${a}${unit}</title></rect><text x="${cx - bw / 2 - 3}" y="${yy - 4}" text-anchor="middle" font-size="10" fill="#4e79a7">${a}</text>`; }
    if (b != null) { const yy = y(b); bars += `<rect x="${cx + 3}" y="${yy}" width="${bw}" height="${padT + plotH - yy}" fill="#e15759"><title>Go ${b}${unit}</title></rect><text x="${cx + bw / 2 + 3}" y="${yy - 4}" text-anchor="middle" font-size="10" fill="#e15759">${b}</text>`; }
    labels += `<text x="${cx}" y="${H - padB + 18}" text-anchor="middle" font-size="12" fill="#333">${esc(c)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(title)}">
    <text x="${W / 2}" y="22" text-anchor="middle" font-size="14" font-weight="600">${esc(title)}（${unit}）</text>
    ${ticks}${bars}${labels}
    <rect x="${W - 190}" y="6" width="12" height="12" fill="#4e79a7"/><text x="${W - 174}" y="16" font-size="11">Node(socket.io)</text>
    <rect x="${W - 80}" y="6" width="12" height="12" fill="#e15759"/><text x="${W - 64}" y="16" font-size="11">Go(gateway)</text>
  </svg>`;
}

const cats = scenarios.map((s) => s.title.replace(/^S\d /, ''));
const rttP99A = scenarios.map((s) => data[s.key].a.harness.rttMs?.p99);
const rttP99B = scenarios.map((s) => data[s.key].b.harness.rttMs?.p99);
const errA = scenarios.map((s) => errSum(data[s.key].a.harness));
const errB = scenarios.map((s) => errSum(data[s.key].b.harness));
const ackRateA = scenarios.map((s) => { const h = data[s.key].a.harness; return h.sent ? +(100 * h.ack / h.sent).toFixed(1) : null; });
const ackRateB = scenarios.map((s) => { const h = data[s.key].b.harness; return h.sent ? +(100 * h.ack / h.sent).toFixed(1) : null; });
const srvRssA = scenarios.map((s) => data[s.key].a.resource.peakServerRssMB);
const gwRssB = scenarios.map((s) => data[s.key].b.resource.peakGatewayRssMB);
const goroB = scenarios.map((s) => data[s.key].b.resource.peakGoroutines);
const elA = scenarios.map((s) => data[s.key].a.resource.peakEventloopP99Ms);
const elB = scenarios.map((s) => data[s.key].b.resource.peakEventloopP99Ms);

function dataTable() {
  let rows = '';
  for (const s of scenarios) {
    for (const [mode, r] of [['Node(socket.io)', data[s.key].a], ['Go(gateway)', data[s.key].b]]) {
      const h = r.harness, res = r.resource, si = r.serverInternalDurationMs, e = errSum(h);
      rows += `<tr>
        <td>${s.title}</td><td>${mode}</td>
        <td>${h.connectedCount}</td><td>${h.sent}/${h.ack}</td>
        <td class="${e ? 'bad' : 'ok'}">${e}${h.sent ? ` (${(100 * e / h.sent).toFixed(1)}%)` : ''}</td>
        <td>${h.rttMs?.p50}/${h.rttMs?.p95}/<b>${h.rttMs?.p99}</b></td>
        <td>${si.p99 ?? '—'}</td>
        <td>${res.peakServerRssMB ?? '—'}</td><td>${res.peakGatewayRssMB ?? '—'}</td>
        <td>${res.peakEventloopP99Ms ?? '—'}</td><td>${res.peakGoroutines ?? '—'}</td>
      </tr>`;
    }
  }
  return rows;
}

const ts = new Date(Math.max(...scenarios.flatMap((s) => [data[s.key].a.endedAt, data[s.key].b.endedAt]))).toISOString();

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Node vs Go 实时层性能对比报告</title>
<style>
  body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;color:#222;max-width:960px;margin:0 auto;padding:24px;}
  h1{border-bottom:3px solid #4e79a7;padding-bottom:8px}
  h2{margin-top:36px;border-left:5px solid #4e79a7;padding-left:10px}
  h3{margin-top:24px;color:#33517a}
  .chart{width:100%;height:auto;border:1px solid #eee;border-radius:6px;margin:12px 0;background:#fff}
  table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0}
  th,td{border:1px solid #ddd;padding:6px 8px;text-align:center}
  th{background:#f3f6fa}
  .bad{color:#c0392b;font-weight:700}.ok{color:#27ae60}
  .box{background:#f7f9fc;border:1px solid #dde6f0;border-radius:8px;padding:12px 16px;margin:14px 0}
  .warn{background:#fff7e6;border-color:#ffe0a3}
  .key{background:#eef7ee;border-color:#c9e6c9}
  code{background:#f0f0f0;padding:1px 5px;border-radius:3px;font-size:12px}
  .muted{color:#888;font-size:13px}
</style></head><body>

<h1>Node vs Go 实时层性能对比报告</h1>
<p class="muted">生成时间(数据窗口结束):${ts} ｜ 分支 feat/perf-monitoring ｜ 数据源:测试报告/data/*.json(真实压测采集)</p>

<div class="box warn">
<b>测量诚实性声明（务必先读）</b><br>
① 全部服务(harness 负载生成 + Node server + Go gateway + Docker 中间件/Prometheus)<b>跑在同一台 macOS 开发机</b>,彼此抢 CPU,故<b>绝对毫秒数有噪声、非生产代表值</b>;本报告价值在<b>同机同负载下的相对 A/B 对比与定性失败模式</b>。<br>
② <b>gateway 路径 = Go 网关 + Node 后端两个进程</b>:业务/落库仍在 Node,网关只做连接 + 上行透传。故"引入 Go"是<b>加一层</b>,不是用 Go 替换 Node 消息处理。<br>
③ 公平性:两路径服务端落库逻辑完全相同(gateway 经 <code>/internal/gateway/uplink</code> 复用同一 <code>persistMessage</code>);ack/心跳等实时特性两侧都具备。
</div>

<h2>一、结论速览</h2>
<div class="box key">
<b>1. "引入 Go 让消息更快"——不成立(现架构下)。</b> 中等负载(S1/S2)gateway 路径 RTT 与 Node 相当或略高,因为它多一跳(client→gateway→server→gateway)且上行是<b>每条消息一个 HTTP POST</b> 打到 Node。<br>
<b>2. Go 网关的连接层极轻。</b> 持有 300 连接仅约 <b>${gwRssB[1]}MB</b> / ${goroB[1]} goroutine;而 Node server 稳态 ${srvRssA[1]}MB。但这不是"省内存"——gateway 是<b>额外</b>进程,总内存 = server + gateway 反而更高。Go 的价值在<b>连接密度</b>(海量空闲连接),本轮未压到 Node 的连接上限故未显现。<br>
<b>3. 过载失败模式截然不同(S3,≈3000 msg/s,最有价值的发现):</b>
<ul>
<li><b>Node/socket.io:丢得快而响</b>——错误率 <b>${(100 * errA[2] / data.s3.a.harness.sent).toFixed(0)}%</b>(${errA[2]} 条 message.error)、RSS 飙到 <b>${srvRssA[2]}MB</b>、通过的消息 RTT p99 ≈ ${(rttP99A[2] / 1000).toFixed(1)}s。以<b>拒绝/报错</b>方式失败。</li>
<li><b>Go/gateway:0 错误但排队</b>——RTT p99 爆到 <b>${(rttP99B[2] / 1000).toFixed(1)}s</b>(HTTP-per-message 上行积压),服务内处理仍 ${data.s3.b.serverInternalDurationMs.p99}ms。以<b>延迟</b>方式失败。</li>
</ul>
两者在 3000 msg/s 都"失败",但一个丢消息、一个爆延迟——<b>取决于你更怕丢消息还是更怕卡</b>。
</div>

<h2>二、测试方法</h2>
<p>同一套压测器,两种模式仅传输层不同,其余(注册/登录/会话配对/RTT 用 message.ack/统计口径)完全一致:</p>
<ul>
<li><b>A = Node</b>:<code>perf/harness.mjs</code>,socket.io-client → server <code>/socket.io</code>。</li>
<li><b>B = Go</b>:<code>perf/harness-gw.mjs</code>,原生 WebSocket(Cookie token)→ gateway <code>/ws</code> → 上行 <code>{type:'message.send',data:{...}}</code>。</li>
<li>编排 <code>perf/ab-run.mjs</code>:跑 harness + 每 2s 采样(Prometheus 连接/eventloop/goroutine + <code>ps</code> 采两进程 RSS)+ 解析统计 → 落 JSON。</li>
</ul>
<table><tr><th>场景</th><th>参数</th><th>目的</th></tr>
${scenarios.map((s) => `<tr><td>${s.title}</td><td>${s.desc}</td><td>${s.key === 's1' ? '常规吞吐下的 RTT' : s.key === 's2' ? '连接规模下的资源占用' : '过载时的失败模式'}</td></tr>`).join('')}</table>

<h2>三、图表(Node 蓝 vs Go 红)</h2>
${groupedBar('消息 RTT p99(客户端往返)', 'ms', cats, rttP99A, rttP99B)}
<p class="muted">S3 过载下 Go 的 RTT 远高:网关不丢消息,代价是上行积压导致往返飙到 ~10s。</p>
${groupedBar('错误数(message.error)', '条', cats, errA, errB)}
<p class="muted">S3:Node 丢 ${errA[2]} 条(过载即拒);Go 全程 0 错误(转化为延迟)。</p>
${groupedBar('消息投递成功率(ack/发送)', '%', cats, ackRateA, ackRateB)}
${groupedBar('连接层进程内存峰值(Node server RSS vs Go gateway RSS)', 'MB', cats, srvRssA, gwRssB)}
<p class="muted">注意口径:蓝=Node server 整体 RSS(含全部业务/DB),红=Go gateway 进程 RSS。gateway 路径实际总内存 = 两者之和。</p>
${groupedBar('Go gateway goroutine 数(连接层并发单位)', '个', cats, [null, null, null], goroB)}
${groupedBar('Node 事件循环滞后 p99', 'ms', cats, elA, elB)}

<h2>四、完整数据表</h2>
<table>
<tr><th>场景</th><th>模式</th><th>连接</th><th>发送/ack</th><th>错误</th><th>RTT p50/95/<b>99</b>(ms)</th><th>服务内 p99(ms)</th><th>server RSS(MB)</th><th>gateway RSS(MB)</th><th>eventloop p99(ms)</th><th>goroutine</th></tr>
${dataTable()}
</table>
<p class="muted">"服务内 p99" = 服务端消息处理直方图分位(Node 为 server_message_duration,Go 为 gateway_uplink_duration),经 Prometheus <code>histogram_quantile</code> 算得,受桶宽影响偏粗。</p>

<h2>五、深入分析</h2>

<h3>5.1 为什么中等负载下 Go 网关并不更快</h3>
<p>gateway 路径每发一条消息,网关要向 Node 的 <code>/internal/gateway/uplink</code> 发<b>一个独立 HTTP POST</b>,拿到 ack 再写回客户端连接。相比 socket.io 在同一 Node 进程内直接处理,gateway 多了:①一次额外网络跳转,②一次 HTTP 请求的建立/解析开销。在 S1(1000 msg/s)这体现为 RTT 相当或略高。<b>结论:当业务逻辑仍在 Node 时,把连接层换成 Go 不会让"单条消息"更快——反而更慢一点。</b></p>

<h3>5.2 资源:Go 连接层极轻,但"总账"更高</h3>
<p>Go gateway 持有 300 连接仅约 ${gwRssB[1]}MB、${goroB[1]} 个 goroutine(每连接 ~2-4 个),内存随连接数近乎线性且极缓。Node server 稳态就 ${srvRssA[1]}MB 起步(含 Prisma/Express/业务)。<b>但关键:gateway 不替代 server</b>——消息最终仍回到 Node 落库。所以现架构下,gateway 路径的总内存 = Node(${srvRssA[1]}MB)+ Go(${gwRssB[1]}MB),比纯 Node 更高。<b>Go 的真正省钱点在"海量空闲长连接"</b>:当连接数达到 Node 事件循环/内存扛不住的量级(通常数万条)时,Go 的 goroutine 模型才显出碾压优势——本轮只压到 300 连接,远未触及 Node 的连接上限,故该优势未被测出。</p>

<h3>5.3 过载失败模式:丢消息 vs 爆延迟(最重要)</h3>
<p>S3 把两条路径都压垮(≈3000 msg/s),但方式相反:</p>
<ul>
<li><b>Node/socket.io</b>:事件循环 + DB 落库跟不上,<b>直接报错拒绝</b>——${errA[2]} 条 message.error(${(100 * errA[2] / data.s3.a.harness.sent).toFixed(0)}% 失败),同时进程 RSS 从 ~240MB 飙到 <b>${srvRssA[2]}MB</b>(积压对象),服务内处理 p99 达 ${data.s3.a.serverInternalDurationMs.p99}ms。表现为<b>"快速失败 + 内存尖峰"</b>。</li>
<li><b>Go/gateway</b>:网关来者不拒,把消息都收下再逐条 HTTP 转发给 Node,<b>0 错误</b>,但上行队列越积越长 → RTT p99 爆到 <b>${(rttP99B[2] / 1000).toFixed(1)}s</b>。而网关自身 RSS 仅 ${data.s3.b.resource.peakGatewayRssMB}MB、服务内处理 ${data.s3.b.serverInternalDurationMs.p99}ms——<b>瓶颈全压在 HTTP-per-message 上行管道</b>。表现为<b>"不丢但极慢"</b>。</li>
</ul>
<p>工程含义:若你的场景<b>宁可慢也不能丢</b>(如消息必达),Go 网关的"排队而非拒绝"更友好;若<b>宁可快速失败让客户端重试</b>,Node 的行为更直接。但两者在此负载都需优化——尤其 gateway 的 <b>HTTP-per-message 上行应改成批量/长连接/gRPC 流</b>,否则它会成为比 socket.io 更早的瓶颈。</p>

<h3>5.4 监测平台是否称职</h3>
<p>本轮所有结论都由监测数据直接支撑:错误计数、RTT 分位、服务内处理直方图、eventloop 滞后、goroutine、两进程 RSS——<b>降级发生时每个信号都如实抬升</b>,证明监测覆盖到位、可用于容量规划与瓶颈定位。补齐的 HTTP/DB 指标(<code>http_request_duration</code>/<code>db_query_duration</code>)可进一步下钻定位 S3 的 DB 竞争,后续可做。</p>

<h2>六、建议</h2>
<ul>
<li><b>不要为"让消息更快"而上 Go 网关</b>——现架构下它更慢。上它的正当理由是<b>连接密度</b>(需先压到数万连接验证 Node 的上限)。</li>
<li>若要真正发挥 Go 网关价值,<b>先重构上行通路</b>:把 HTTP-per-message 改为网关↔server 的持久连接/批量/gRPC 流,消除 S3 暴露的积压瓶颈。</li>
<li><b>补齐 A/B 前置</b>:gateway 目前仅 message.send parity,presence/已读/通话信令未迁;真正生产级 A/B 需先补齐这些特性再比。</li>
<li>做一轮<b>高连接数(1万~5万)、低消息率</b>的专项测试,才能测出 Go 相对 Node 在"海量空闲连接"上的真实优势(本轮 300 连接太少)。</li>
<li>把绝对数迁到<b>独立多机环境</b>复测(压测端与被测端分离),消除单机争抢导致的噪声。</li>
</ul>

<p class="muted" style="margin-top:40px;border-top:1px solid #eee;padding-top:12px">本报告由 <code>perf/gen-report.mjs</code> 从真实压测 JSON 自动生成(内联 SVG,无外网依赖);原始数据见同目录 <code>data/</code>。</p>
</body></html>`;

writeFileSync(join(REPORT_DIR, '性能对比报告.html'), html);
console.log('已生成 ' + join(REPORT_DIR, '性能对比报告.html'));
