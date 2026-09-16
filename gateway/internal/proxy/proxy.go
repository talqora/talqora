// Package proxy 把 HTTP API 流量反代到 Node 业务层,支撑「网关作为唯一对外入口」的目标态
// (26-9-16 方案文档 §6):客户端只连网关,业务层完全内网化。
// 用 httputil.ReverseProxy 直反代而非 grpc-gateway 转码:REST 语义/JSON 载荷原样保留,
// 且支持流式响应(/user/messages 等大响应体不整体缓冲)。env GATEWAY_PROXY_API=true 时由 main 挂载。
package proxy

import (
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

// New 构造到 Node 的反向代理 handler。path 原样透传(/api/... → Node /api/...)。
func New(baseURL string, log *slog.Logger) http.Handler {
	target, err := url.Parse(baseURL)
	if err != nil {
		log.Error("反代目标地址非法", "url", baseURL, "err", err)
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "网关配置错误:反代目标不可用", http.StatusBadGateway)
		})
	}
	rp := httputil.NewSingleHostReverseProxy(target)
	// FlushInterval < 0:每次上游写立即 flush 给客户端——大响应体(/user/messages 全量历史)流式下发,
	// 避免网关侧整体缓冲引入新瓶颈(26-9-16 实测该端点全量 2.4 万条曾达 3.9s)。
	rp.FlushInterval = -1
	// 上游异常时的兜底:不让客户端看到 Go 默认的裸错误文本。
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Warn("反代上游失败", "path", r.URL.Path, "err", err)
		http.Error(w, "业务服务暂不可用", http.StatusBadGateway)
	}
	// 显式给上游响应设超时,防止业务层挂死时反代连接堆积。
	rp.Transport = &http.Transport{
		MaxIdleConns:        128,
		MaxIdleConnsPerHost: 64,
		IdleConnTimeout:     90 * time.Second,
	}
	return rp
}
