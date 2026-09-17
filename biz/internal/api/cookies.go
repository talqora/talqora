package api

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"

	"github.com/gin-gonic/gin"
)

// 与 utils/authCookies.ts 对齐:cookie 名 token(HttpOnly)与 csrfToken(可读)。
const (
	TokenCookie = "token"
	CsrfCookie  = "csrfToken"
	// RememberMaxAge 记住我 7 天(秒)。
	RememberMaxAge = 7 * 24 * 60 * 60
	// SessionMaxAge 默认 1 小时(秒)。
	SessionMaxAge = 60 * 60
)

// GenerateCsrfToken 24 字节随机 hex(与 Node crypto.randomBytes(24).toString('hex') 对齐)。
func GenerateCsrfToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err) // 熵源故障属致命环境问题
	}
	return hex.EncodeToString(b)
}

// SetAuthCookies 写 token(HttpOnly) + csrfToken(可读),sameSite=strict(对齐 authCookies.ts)。
func SetAuthCookies(c *gin.Context, token, csrf string, maxAgeSec int, secure bool) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     TokenCookie,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAgeSec,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     CsrfCookie,
		Value:    csrf,
		Path:     "/",
		MaxAge:   maxAgeSec,
		HttpOnly: false,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
}

// ClearAuthCookies 清两个 cookie(path=/,与 clearCookie 对齐)。
func ClearAuthCookies(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{Name: TokenCookie, Path: "/", MaxAge: -1})
	http.SetCookie(c.Writer, &http.Cookie{Name: CsrfCookie, Path: "/", MaxAge: -1})
}
