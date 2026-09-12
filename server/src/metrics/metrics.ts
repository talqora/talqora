// 后端性能指标(Prometheus)。用全局默认 Registry(prom-client 的 register 单例),
// 与 collectDefaultMetrics 采的 process_* / nodejs_* 指标共用同一份输出,
// /metrics 端点一次性 scrape 全部。
import { register, collectDefaultMetrics, Gauge, Histogram, Counter } from 'prom-client';
import { PerformanceObserver, constants as perfConstants } from 'node:perf_hooks';
import type { NodeGCPerformanceDetail } from 'node:perf_hooks';

// 默认指标:CPU/内存/句柄数/nodejs 版本等进程级基线,运维排障常用。
collectDefaultMetrics();

// 当前活跃 WS 连接数。与 gateway 的 gateway_connections 同语义,便于 Node/Go 两侧对比容量。
export const wsConnections = new Gauge({
  name: 'server_ws_connections',
  help: '当前活跃 Socket.io 连接数',
});

// 消息处理耗时(message.send 从收到到 ack/error 落定)。buckets 与 gateway 的
// gateway_uplink_duration_seconds 对齐,是 Node/Go 实时层可比性的地基。
export const messageDuration = new Histogram({
  name: 'server_message_duration_seconds',
  help: 'message.send 处理耗时(收到帧到 ack/error)',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

// 上行消息计数(收到 message.send 帧,不论成败)。
export const messageInTotal = new Counter({
  name: 'server_message_in_total',
  help: '收到的 message.send 帧计数',
});

// 上行消息处理结果分布(ok/error)。
export const messageOutTotal = new Counter({
  name: 'server_message_out_total',
  help: 'message.send 处理结果计数',
  labelNames: ['result'] as const,
});

// 前端 RUM(Real User Monitoring)web-vitals 上报承接:按指标名(LCP/INP/CLS/FCP/TTFB)
// 与 rating(good/needs-improvement/poor)分桶观测数值分布。
export const rumWebVitals = new Histogram({
  name: 'server_rum_web_vitals',
  help: '前端 RUM 上报的 web-vitals 数值分布',
  labelNames: ['name', 'rating'] as const,
  // CLS 是无量纲分值(通常 <1),其余(LCP/INP/FCP/TTFB)是秒;
  // 沿用同一组 buckets 覆盖两种量级,够用即可,不为精确区分再拆两个指标。
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// event loop lag(事件循环延迟):事件循环被同步任务/GC 等阻塞的程度,是 Node 服务
// 响应劣化的早期信号。经核实 prom-client 的 collectDefaultMetrics() 已内置此项——
// 基于 perf_hooks.monitorEventLoopDelay() 采样,每次 collect 时刷新 Gauge
// nodejs_eventloop_lag_seconds(以及 _min/_max/_mean/_stddev/_p50/_p90/_p99 变体),
// 故此处不重复自建(若重复用同名注册会与默认指标冲突,prom-client 的 Registry 不允许
// 同名指标重复注册)。/metrics 输出里已包含该指标,直接使用即可。

// GC 停顿耗时。kind 标签还原 Node perf_hooks 的 GC 类型常量(major/minor/incremental/weakcb),
// 用于区分是哪种 GC 在造成停顿。
const gcKindNames: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};

export const gcPauseSeconds = new Histogram({
  name: 'nodejs_gc_pause_seconds',
  help: 'GC 单次停顿耗时(秒)',
  labelNames: ['kind'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    // entry.kind 已废弃(Node 提示 "Custom PerformanceEntry accessors are deprecated"),
    // 改从 entry.detail.kind 取 GC 类型常量。@types/node 的 PerformanceEntry 基类未声明
    // detail(仅 gc 类型的条目才有),按 Node 官方文档的运行时形状转型读取。
    const detail = (entry as unknown as { detail?: NodeGCPerformanceDetail }).detail;
    const kind = gcKindNames[detail?.kind ?? -1] ?? 'unknown';
    gcPauseSeconds.observe({ kind }, entry.duration / 1000);
  }
});
gcObserver.observe({ entryTypes: ['gc'] });

// ===== 以下 6 类为新增指标(HTTP/DB/在线用户/广播扇出/通话信令/断连原因),复用同一个默认 register =====

// HTTP 请求耗时(app.ts 的全局中间件在 res 'finish' 时 observe)。route 标签用路由模式
// (req.route.path 拼 baseUrl)而非原始 path,避免带 id/token 的真实路径把标签基数打爆。
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP 请求处理耗时',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// DB 单次操作(model 方法或 $queryRaw/$executeRaw)耗时,由 database/prisma.ts 的
// Client Extension 统一埋点,业务代码不用逐处手测。
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Prisma 单次操作耗时',
  labelNames: ['model', 'operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

// 当前在线用户数(去重同一用户的多设备连接)。语义与 server_ws_connections(连接数,不去重)
// 不同:一个用户开 3 个标签页贡献 3 条 ws 连接,但只算 1 个在线用户。
// 精度说明:本进程内维护(socket.ts 用 Map<userId, 设备数> 计数,0↔1 转换时才动 gauge),
// 与其余指标同为「单副本本地值」,多副本部署需在 Prometheus 侧 sum() 聚合各副本值近似集群在线用户数
// (若同一用户同时连了不同副本会被重复计数一次,属已知近似;presence.ts 的 Redis 结构是按 userId 存,
// 没有现成的「全体在线 userId 去重集合」可直接读,若要做到跨副本精确去重需再建一套 Redis 结构,当前从简)。
export const onlineUsers = new Gauge({
  name: 'server_online_users',
  help: '当前在线用户数(单进程内按 userId 去重的连接数)',
});

// 一条消息广播给多少个接收者(读扩散扇出规模),用于观察群聊大小对广播成本的影响。
export const broadcastRecipients = new Histogram({
  name: 'server_broadcast_recipients',
  help: '单次消息广播的接收者数量分布',
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
});

// 通话信令事件计数,按事件类型区分。
export const callEventsTotal = new Counter({
  name: 'server_call_events_total',
  help: '通话信令事件计数',
  labelNames: ['event'] as const,
});

// 当前进行中的通话数(近似值,见 socket.ts call:start/call:end/call:reject 处注释:
// 按「已建立会话(ringing 起)到 end/reject 止」计数,含振铃未接通阶段,不是严格的「已接通」数)。
export const activeCalls = new Gauge({
  name: 'server_active_calls',
  help: '当前进行中的通话数(近似,含振铃阶段)',
});

// WS 断连原因分布(socket.io disconnect 回调的 reason,如 transport close / ping timeout / client namespace disconnect)。
export const wsDisconnectsTotal = new Counter({
  name: 'server_ws_disconnects_total',
  help: 'WS 断连计数,按断连原因分类',
  labelNames: ['reason'] as const,
});

// 便捷函数:业务代码(socket.ts / routes/rum.ts)不直接摸指标对象,统一走这几个函数埋点。
export function incConnections(): void {
  wsConnections.inc();
}

export function decConnections(): void {
  wsConnections.dec();
}

export function observeMessageDuration(sec: number): void {
  messageDuration.observe(sec);
}

export function observeRumVital(name: string, rating: string, value: number): void {
  rumWebVitals.observe({ name, rating }, value);
}

export function observeHttpRequestDuration(
  method: string,
  route: string,
  status: number,
  sec: number
): void {
  httpRequestDuration.observe({ method, route, status: String(status) }, sec);
}

export function observeDbQueryDuration(model: string, operation: string, sec: number): void {
  dbQueryDuration.observe({ model, operation }, sec);
}

export function incOnlineUsers(): void {
  onlineUsers.inc();
}

export function decOnlineUsers(): void {
  onlineUsers.dec();
}

export function observeBroadcastRecipients(count: number): void {
  broadcastRecipients.observe(count);
}

export function incCallEvent(event: string): void {
  callEventsTotal.inc({ event });
}

export function incActiveCalls(): void {
  activeCalls.inc();
}

export function decActiveCalls(): void {
  activeCalls.dec();
}

export function incWsDisconnect(reason: string): void {
  wsDisconnectsTotal.inc({ reason });
}

// /metrics 端点用:导出全量指标文本 + 对应 Content-Type。
export async function metricsText(): Promise<string> {
  return register.metrics();
}

export { register };
