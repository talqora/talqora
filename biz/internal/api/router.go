// Package api 是 HTTP 面(gin):路由挂载与中间件链,语义对齐 server/src/app.ts。
// 挂载面(app.ts:65-104):/health → /metrics → 计时中间件 → 认证限流 + 各业务路由 → 错误处理。
package api

import (
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/metrics"
)

// NewRouter 装配完整 HTTP 路由面。业务路由按阶段逐个挂载(全部对齐 Node 语义)。
func NewRouter(cfg *config.Config, logger *slog.Logger) *gin.Engine {
	if cfg.IsProduction {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()

	// trust proxy:取 X-Forwarded-For 第一段为客户端 IP(与 app.ts trust proxy=1 对齐)
	_ = r.SetTrustedProxies(nil)

	// 安全响应头(helmet 对齐:nosniff/隐藏 X-Powered-By/Referrer-Policy/HSTS 等)
	r.Use(securityHeaders(cfg))

	// CORS:白名单校验 + 允许携带 cookie(无 origin 请求放行)
	r.Use(corsMiddleware(cfg))

	// 请求体解析:json/urlencoded 上限 10mb
	r.MaxMultipartMemory = 100 << 20
	bodyParser := &limitedBodyParser{}
	_ = bodyParser

	// Health:容器编排探针,不查 DB
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "uptime": time.Since(startTime).Seconds()})
	})

	// Prometheus 抓取端点(在计时中间件之前,避免自监控自举)
	metricsGroup := r.Group("/")
	metricsGroup.GET("/metrics", gin.WrapH(metrics.Handler()))

	// HTTP 耗时中间件:包住全部业务路由(method/route/status 标签)
	r.Use(httpDurationMiddleware())

	// 认证端点限流(登录/注册)
	globalLimiter = newAuthRateLimiter(cfg)
	r.Use(limiterForPaths("/api/login", "/api/register"))

	// 业务路由挂载(与 app.ts:91-104 同面)
	mountAuthRoutes(r, cfg)        // /api: register/login/refresh/logout/check-*/turn-credentials
	mountUserRoutes(r)             // /user: profile/update
	mountFriendRoutes(r)           // /user: friend 全部
	mountChatRoutes(r)             // /user: userConversations/conversations/messages/updateConversationTime/lastMessages
	mountSyncRoutes(r)             // /user: sync/read/mentions/readCount
	mountUploadRoutes(r, cfg)      // /user/uploads/uploadImg + /api/upload/*
	mountInternalRoutes(r, cfg)    // /internal: gateway/uplink、gateway/disconnect
	mountRumRoutes(r)              // /api/rum
	mountOAuthRoutes(r, cfg, logger) // /.well-known/* + /oauth/*

	// 错误处理(注册在所有路由之后;对齐 app.ts:107-114)
	r.Use(errorHandler())

	return r
}

var startTime = time.Now()
