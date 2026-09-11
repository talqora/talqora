// Package metrics 暴露网关运行时的 Prometheus 指标:连接量、握手结果、上下行计数、
// 慢消费者逐出、上行落库耗时。运维据此判断网关健康与背压是否在生效(docs 16 §8)。
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// 当前活跃连接数。配额/容量规划的核心观测量,接近 MaxConns 即需扩副本。
	Connections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "gateway_connections",
		Help: "当前活跃 WS 连接数",
	})

	// 握手结果分布(ok / unauthorized / over_quota)。鉴权失败激增=被刷或密钥不一致。
	Handshakes = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "gateway_handshakes_total",
		Help: "WS 握手结果计数",
	}, []string{"result"})

	// 上行处理结果(ok / bad_request / upstream_error)。透传到 Node 的成败。
	Uplink = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "gateway_uplink_total",
		Help: "上行消息处理结果计数",
	}, []string{"result"})

	// 下行投递计数(delivered=路由到本地连接 / dropped=本副本无此用户连接)。
	Downlink = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "gateway_downlink_total",
		Help: "下行消息投递结果计数",
	}, []string{"result"})

	// 慢消费者逐出计数。发送缓冲打满即逐出,这条上扬=有客户端读得太慢(背压在生效)。
	Evicted = promauto.NewCounter(prometheus.CounterOpts{
		Name: "gateway_evicted_total",
		Help: "因发送缓冲打满被逐出的慢消费者连接数",
	})

	// 上行端到端耗时(网关收到帧 → Node 落库返回 ack)。p99 是消息可靠性的关键 SLI。
	UplinkDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "gateway_uplink_duration_seconds",
		Help:    "上行从收帧到拿到 Node ack 的耗时",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5},
	})

	// 下行端到端耗时(网关从 backplane 收到帧 → 投递进目标连接的发送 channel)。
	// buckets 与 UplinkDuration 保持一致,便于上下行同口径对比。
	DownlinkDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "gateway_downlink_duration_seconds",
		Help:    "下行从 backplane 收到到写入客户端连接发送缓冲的耗时",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5},
	})
)

// runtime 指标(goroutine 数、GC 耗时、内存等 go_*/process_*)由 promauto 使用的默认
// registry 自动暴露,无需在此额外注册——与 Node 侧 prom-client 默认指标对比时可直接用这些。

// Handler 返回 /metrics 的 HTTP 处理器,挂到网关的 metrics 监听上供 Prometheus 抓取。
func Handler() http.Handler {
	return promhttp.Handler()
}
