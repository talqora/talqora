package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/metrics"
)

// securityHeaders 对齐 helmet 默认(nosniff/隐藏 X-Powered-By/Referrer-Policy/HSTS 等)。
func securityHeaders(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-DNS-Prefetch-Control", "off")
		h.Set("X-Download-Options", "noopen")
		h.Set("X-Permitted-Cross-Domain-Policies", "none")
		h.Set("Content-Security-Policy", "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests")
		if cfg.IsProduction {
			h.Set("Strict-Transport-Security", "max-age=15552000; includeSubDomains")
		}
		c.Next()
	}
}

// corsMiddleware 对齐 Express cors:白名单校验 + credentials:true;无 origin 放行;非白名单 500。
func corsMiddleware(cfg *config.Config) gin.HandlerFunc {
	allowed := make(map[string]bool, len(cfg.AllowedOrigins))
	for _, o := range cfg.AllowedOrigins {
		allowed[o] = true
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && !allowed[origin] {
			// Express 版经 errorHandler 变 500:「不允许的跨域来源: {origin}」
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
				"success": false,
				"message": "服务器内部错误",
			})
			return
		}
		if origin != "" {
			h := c.Writer.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Vary", "Origin")
			h.Set("Access-Control-Allow-Credentials", "true")
		}
		if c.Request.Method == http.MethodOptions {
			h := c.Writer.Header()
			h.Set("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE")
			h.Set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-CSRF-Token")
			h.Set("Access-Control-Max-Age", "600")
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	}
}

// httpDurationMiddleware 计时埋点:route 标签取路由模式(gin 的 FullPath),未匹配记 unmatched。
func httpDurationMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		metrics.HTTPRequestDuration.WithLabelValues(c.Request.Method, route, strconv.Itoa(c.Writer.Status())).Observe(time.Since(start).Seconds())
	}
}

// errorHandler 全局错误处理:500 + {success:false,message:'服务器内部错误'}(app.ts:107-114)。
func errorHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
				"success": false,
				"message": "服务器内部错误",
			})
		}
	}
}

// limitedBodyParser 标记 json/urlencoded 10mb 上限(gin 在具体 c.ShouldBindJSON 时按需读取;
// 这里仅保留与 Express 对齐的语义文档,实际限制在 readBodyWithLimit 处生效)。
type limitedBodyParser struct{}

// ---- 认证限流(对齐 middleware/rateLimit.ts:按 IP 内存计数,超阈值 429) ----

type rateWindow struct {
	count  int
	window int64 // 窗口起始 unixMs
}

type ipLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	buckets map[string]*rateWindow
}

func newAuthRateLimiter(limit int, window time.Duration) *ipLimiter {
	return &ipLimiter{
		limit:   limit,
		window:  window,
		buckets: make(map[string]*rateWindow),
	}
}

// limiterForPaths 仅对指定路径组生效的限流中间件。
func limiterForPaths(paths ...string) gin.HandlerFunc {
	set := make(map[string]bool, len(paths))
	for _, p := range paths {
		set[p] = true
	}
	return func(c *gin.Context) {
		if !set[c.FullPath()] {
			c.Next()
			return
		}
		// 限流器从 engine 上下文取不到,改用全局实例(由 NewRouter 注入的闭包工厂保证单例)
		if globalLimiter != nil && !globalLimiter.allow(clientIP(c)) {
			h := c.Writer.Header()
			h.Set("Retry-After", strconv.FormatInt(globalLimiter.window.Milliseconds()/1000, 10))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"success": false,
				"message": "尝试过于频繁,请稍后再试",
			})
			return
		}
		c.Next()
	}
}

var globalLimiter *ipLimiter

// clientIP 取真实客户端 IP:优先 X-Forwarded-For 第一段,回落 RemoteAddr。
func clientIP(c *gin.Context) string {
	xff := c.GetHeader("X-Forwarded-For")
	if xff != "" {
		if i := strings.Index(xff, ","); i > 0 {
			xff = xff[:i]
		}
		if ip := strings.TrimSpace(xff); ip != "" {
			return ip
		}
	}
	if ip := c.ClientIP(); ip != "" {
		return ip
	}
	return "unknown"
}

func (l *ipLimiter) allow(ip string) bool {
	now := time.Now().UnixMilli()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) > 10_000 { // 防内存膨胀:粗暴清理过期桶
		for k, w := range l.buckets {
			if now-w.window >= l.window.Milliseconds() {
				delete(l.buckets, k)
			}
		}
	}
	w, ok := l.buckets[ip]
	if !ok || now-w.window >= l.window.Milliseconds() {
		l.buckets[ip] = &rateWindow{count: 1, window: now}
		return true
	}
	w.count++
	return w.count <= l.limit
}

var _ = fmt.Sprintf
