package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildTurnIceServers(t *testing.T) {
	servers, ttl := buildTurnIceServers("turn-secret", "turn.example.com", 3478, 5349, 86400, 42)
	require.Len(t, servers, 2)
	assert.Equal(t, 86400, ttl)

	stun := servers[0]["urls"].([]string)
	assert.Equal(t, "stun:turn.example.com:3478", stun[0])

	turn := servers[1]
	username := turn["username"].(string)
	// username = <expiry>:<userId>
	parts := strings.Split(username, ":")
	assert.Len(t, parts, 2)
	assert.Equal(t, "42", parts[1])

	// credential = base64(HMAC-SHA1(secret, username))
	expected := hmacSHA1Base64("turn-secret", username)
	assert.Equal(t, expected, turn["credential"].(string))
}

func TestBuildTurnIceServersDisabled(t *testing.T) {
	servers, ttl := buildTurnIceServers("", "host", 3478, 5349, 86400, 1)
	assert.Empty(t, servers)
	assert.Equal(t, 0, ttl)
	servers, ttl = buildTurnIceServers("secret", "", 3478, 5349, 86400, 1)
	assert.Empty(t, servers)
	assert.Equal(t, 0, ttl)
}

func TestIPLimiter(t *testing.T) {
	l := newAuthRateLimiter(2, 15*60*1000*1000*1000) // 2 次 / 15 分钟
	for i := 0; i < 2; i++ {
		assert.True(t, l.allow("1.2.3.4"))
	}
	assert.False(t, l.allow("1.2.3.4")) // 第 3 次超限
	assert.True(t, l.allow("5.6.7.8"))  // 其它 IP 不受影响
}

func TestSetClearAuthCookies(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)

	SetAuthCookies(c, "tok", "csrf", SessionMaxAge, false)
	resp := w.Result()
	var sawToken, sawCsrf bool
	for _, ck := range resp.Cookies() {
		switch ck.Name {
		case "token":
			sawToken = true
			assert.Equal(t, "tok", ck.Value)
			assert.True(t, ck.HttpOnly)
		case "csrfToken":
			sawCsrf = true
			assert.Equal(t, "csrf", ck.Value)
			assert.False(t, ck.HttpOnly)
		}
	}
	assert.True(t, sawToken && sawCsrf)
}
