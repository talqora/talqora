// Package metrics 注册业务层 Prometheus 指标。
// 指标名/buckets 与 server/src/metrics/metrics.ts 注册全集逐一对齐(监测看板口径断裂 = 验收失败)。
// 口径差异(报告注明):nodejs_gc_pause_seconds → go_gc_duration_seconds(Go runtime 默认指标);
// server_ws_connections 语义改为「本副本当前 gRPC edge 流连接数」(连接在 gateway);
// server_online_users 在业务层无本地连接注册表,恒 0(presence 在 Redis,多副本口径同 Node 近似)。
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// 消息处理耗时(message.send 从收到到 ack/error)。buckets 与 gateway 契约一致。
	MessageDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "server_message_duration_seconds",
		Help:    "message.send 处理耗时(收到帧到 ack/error)",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5},
	})
	// 上行消息计数(收到 message.send 帧,不论成败)。
	MessageInTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "server_message_in_total",
		Help: "收到的 message.send 帧计数",
	})
	// 上行消息处理结果分布(ok/error)。
	MessageOutTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "server_message_out_total",
		Help: "message.send 处理结果计数",
	}, []string{"result"})
	// 当前活跃实时流连接数(本副本 gRPC edge 流;连接实体在 gateway)。
	WSConnections = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "server_ws_connections",
		Help: "当前活跃实时流连接数(gRPC edge 流,口径变化见 docs)",
	})
	// 实时流断连计数,按原因分类。
	WSDisconnectsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "server_ws_disconnects_total",
		Help: "实时流断连计数,按断连原因分类",
	}, []string{"reason"})
	// 在线用户数:业务层无本地连接注册表,恒 0 占位(口径见 docs)。
	OnlineUsers = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "server_online_users",
		Help: "当前在线用户数(业务层无本地连接,恒 0;多副本口径同 Node 近似)",
	})
	// 单次消息广播的接收者数量分布。
	BroadcastRecipients = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "server_broadcast_recipients",
		Help:    "单次消息广播的接收者数量分布",
		Buckets: []float64{1, 2, 5, 10, 25, 50, 100, 250, 500, 1000},
	})
	// 通话信令事件计数,按事件类型。
	CallEventsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "server_call_events_total",
		Help: "通话信令事件计数",
	}, []string{"event"})
	// 当前进行中的通话数(近似,含振铃阶段)。
	ActiveCalls = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "server_active_calls",
		Help: "当前进行中的通话数(近似,含振铃阶段)",
	})
	// 前端 RUM web-vitals 数值分布。
	RumWebVitals = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "server_rum_web_vitals",
		Help:    "前端 RUM 上报的 web-vitals 数值分布",
		Buckets: []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
	}, []string{"name", "rating"})
	// HTTP 请求处理耗时。
	HTTPRequestDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_request_duration_seconds",
		Help:    "HTTP 请求处理耗时",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5},
	}, []string{"method", "route", "status"})
	// DB 单次操作耗时(pgx 查询计时埋点,替代 Prisma 扩展埋点)。
	DBQueryDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "db_query_duration_seconds",
		Help:    "DB 单次操作耗时",
		Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1},
	}, []string{"model", "operation"})
)

func init() {
	prometheus.MustRegister(
		MessageDuration, MessageInTotal, MessageOutTotal,
		WSConnections, WSDisconnectsTotal, OnlineUsers,
		BroadcastRecipients, CallEventsTotal, ActiveCalls,
		RumWebVitals, HTTPRequestDuration, DBQueryDuration,
	)
}

// Handler 返回 /metrics 的 promhttp 处理器(默认 Registry 含 go_*/process_* 指标)。
func Handler() http.Handler {
	return promhttp.Handler()
}

// ObserveDbQuery 记录一次 DB 操作耗时(秒)。
func ObserveDbQuery(model, operation string, sec float64) {
	DBQueryDuration.WithLabelValues(model, operation).Observe(sec)
}
