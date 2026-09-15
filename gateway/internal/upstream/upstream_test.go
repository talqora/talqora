package upstream

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestNotifyDisconnect 验证断连通知的端点、头部与身份注入。
func TestNotifyDisconnect(t *testing.T) {
	type got struct {
		path       string
		token      string
		userID     string
		deviceID   string
		statusCode int
	}
	ch := make(chan got, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		ch <- got{
			path:       r.URL.Path,
			token:      r.Header.Get("X-Gateway-Token"),
			userID:     r.Header.Get("X-User-Id"),
			deviceID:   r.Header.Get("X-Device-Id"),
			statusCode: 204,
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-token")
	err := c.NotifyDisconnect(context.Background(), 42, "devA")
	if err != nil {
		t.Fatalf("期望成功,实际 %v", err)
	}

	g := <-ch
	if g.path != "/internal/gateway/disconnect" {
		t.Fatalf("期望端点 /internal/gateway/disconnect,实际 %q", g.path)
	}
	if g.token != "secret-token" {
		t.Fatalf("期望内部令牌 secret-token,实际 %q", g.token)
	}
	if g.userID != "42" {
		t.Fatalf("期望 X-User-Id=42,实际 %q", g.userID)
	}
	if g.deviceID != "devA" {
		t.Fatalf("期望 X-Device-Id=devA,实际 %q", g.deviceID)
	}
}

// TestNotifyDisconnectNon2xxIsError 验证非 2xx 视为失败(调用方据此告警)。
func TestNotifyDisconnectNon2xxIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := New(srv.URL, "t")
	if err := c.NotifyDisconnect(context.Background(), 1, "d"); err == nil {
		t.Fatal("期望非 2xx 返回错误,实际成功")
	}
}
