package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/service"
)

// authCfg 由 NewRouter 注入(包级单例,进程生命周期不变)。
var authCfg *config.Config

func initAuthConfig(cfg *config.Config) { authCfg = cfg }

// safeMethods 读操作不改变状态,无需 CSRF 校验(middleware/auth.ts:13)。
var safeMethods = map[string]bool{"GET": true, "HEAD": true, "OPTIONS": true}

// extractToken 优先 Authorization: Bearer,回落 HttpOnly cookie(auth.ts:30-37)。
func extractToken(c *gin.Context) (token string, viaBearer bool) {
	authHeader := c.GetHeader("Authorization")
	if strings.HasPrefix(authHeader, "Bearer ") {
		if b := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer ")); b != "" {
			return b, true
		}
	}
	if ck, err := c.Cookie(TokenCookie); err == nil && ck != "" {
		return ck, false
	}
	return "", false
}

// verifyCsrf 双提交 CSRF:变更类请求 X-CSRF-Token 头必须等于 csrfToken cookie(auth.ts:17-26)。
func verifyCsrf(c *gin.Context) bool {
	if safeMethods[c.Request.Method] {
		return true
	}
	cookieToken, err := c.Cookie(CsrfCookie)
	headerToken := c.GetHeader("X-CSRF-Token")
	if err != nil || cookieToken == "" || headerToken == "" || headerToken != cookieToken {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
			"success": false,
			"message": "CSRF 校验失败，请重新登录",
		})
		return false
	}
	return true
}

// AuthenticateToken JWT 验证中间件:双鉴权 + CSRF + 用户存在性校验(auth.ts:40-101)。
// 通过后把用户资料挂到 c.Set("user", profile)。
func AuthenticateToken() gin.HandlerFunc {
	return func(c *gin.Context) {
		token, viaBearer := extractToken(c)
		if !viaBearer && !verifyCsrf(c) {
			return
		}
		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"success": false,
				"message": "访问令牌缺失，请先登录",
			})
			return
		}

		claims, err := service.VerifySessionToken(authCfg.JWTSecret, token)
		if err != nil {
			if errors.Is(err, jwt.ErrTokenExpired) {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
					"success": false,
					"message": "Token已过期，请重新登录",
					"code":    "TOKEN_EXPIRED",
				})
				return
			}
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"success": false,
				"message": "Token无效，请重新登录",
				"code":    "TOKEN_INVALID",
			})
			return
		}

		user, err := service.FindActiveUser(c.Request.Context(), claims.ID)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
				"success": false,
				"message": "服务器内部错误",
			})
			return
		}
		if user == nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"success": false,
				"message": "用户不存在",
			})
			return
		}
		c.Set("user", user)
		c.Next()
	}
}

// CurrentUser 取中间件挂上的用户资料。
func CurrentUser(c *gin.Context) *service.UserProfile {
	if v, ok := c.Get("user"); ok {
		if u, ok := v.(*service.UserProfile); ok {
			return u
		}
	}
	return nil
}
