// 前端真实用户监控（RUM / field 数据）——三层性能防线的第三层。
// lab（size-limit + Lighthouse CI）只反映干净 CI 机器的表现；唯有这里采集的
// 是真实用户在真实设备/网络下的体验，是 INP 这类 field-only 指标的唯一来源。
import { onCLS, onINP, onLCP, onFCP, onTTFB, type Metric } from 'web-vitals';

const ENDPOINT = '/api/rum';

function report(metric: Metric) {
  const body = JSON.stringify({
    name: metric.name,
    value: metric.value,
    rating: metric.rating, // good / needs-improvement / poor，按 Core Web Vitals 阈值判定
    delta: metric.delta,
    id: metric.id,
    navigationType: metric.navigationType,
    path: location.pathname, // 带上路由，线上才能按页面切分 P75 分位
    ts: Date.now(),
  });

  // 开发期只打印，便于本地观察指标，不向后端打点
  if (import.meta.env.DEV) {
    console.log(`[web-vitals] ${metric.name} ${metric.rating} ${Math.round(metric.value)}`, metric);
    return;
  }

  // 生产：优先 sendBeacon——它在页面卸载（unload/visibilitychange）时也能可靠送出且不阻塞页面；
  // 不支持时退回 keepalive fetch，同样能在卸载阶段发送。
  if (navigator.sendBeacon) {
    navigator.sendBeacon(ENDPOINT, body);
  } else {
    fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {});
  }
}

// 在应用入口调用一次。各指标库内部已处理"页面隐藏时上报最终值"的时机，无需手动监听。
export function initWebVitals() {
  onLCP(report);
  onINP(report); // 交互到下次绘制——field-only，lab 用 TBT 近似，这里才是真值
  onCLS(report);
  onFCP(report);
  onTTFB(report);
}

// 实时消息 RTT（往返时延）打点：与 web-vitals 走同一上报通道/环境判定（dev 打印、生产 sendBeacon），
// 但不经 web-vitals 的 Metric 结构——这是按消息事件触发的自定义指标，调用方在发送/收到回显处各调一次。
// path 区分承载层：当前实时消息走 socket.io（server/），预留 'ws' 给未来可能接入的 Go gateway 原生 WebSocket。
// kind 可选，标注具体测的是哪种往返（如 'message.send'），便于后续分设备/分事件类型统计分位数。
export function reportRealtimeRtt(path: 'socketio' | 'ws', rttMs: number, kind?: string) {
  const body = JSON.stringify({
    name: 'realtime_rtt',
    path,
    rttMs,
    kind,
    ts: Date.now(),
    route: location.pathname, // 命名区别于上面的 path（此处 path 已被用作传输层字段），语义同 report() 里的 path：当前路由
  });

  if (import.meta.env.DEV) {
    console.log(`[realtime-rtt] ${path}${kind ? `/${kind}` : ''} ${Math.round(rttMs)}ms`);
    return;
  }

  if (navigator.sendBeacon) {
    navigator.sendBeacon(ENDPOINT, body);
  } else {
    fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {});
  }
}
