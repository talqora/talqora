package ws

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"

	"github.com/our-chat/gateway/internal/hub"
)

const testSecret = "ws-test-secret"

// fakeRegistrar 同时满足 ws.presenceRegistrar 与 hub.presenceRegistry,不碰 Redis。
type fakeRegistrar struct{}

func (f *fakeRegistrar) Register(_ context.Context, _ int64, _, _ string) error { return nil }
func (f *fakeRegistrar) Refresh(_ context.Context, _ int64, _ string) error     { return nil }
func (f *fakeRegistrar) Remove(_ context.Context, _ int64, _ string) error      { return nil }

func newTestServer(t *testing.T, origins []string) (*httptest.Server, *hub.Hub) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	fake := &fakeRegistrar{}
	h := hub.New(10, 8, 60*time.Second, fake, nil, log)
	handler := NewHandler(h, fake, []byte(testSecret), log, origins)
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv, h
}

func mintWsToken(t *testing.T, uid int64) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"id":       uid,
		"username": "t",
		"exp":      time.Now().Add(time.Hour).Unix(),
	})
	s, err := tok.SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("签 token 失败: %v", err)
	}
	return s
}

func dialWs(t *testing.T, srv *httptest.Server, uid int64, origin string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?deviceId=devT"
	header := http.Header{}
	header.Set("Cookie", "token="+mintWsToken(t, uid))
	if origin != "" {
		header.Set("Origin", origin)
	}
	return websocket.DefaultDialer.Dial(url, header)
}

func TestHandshakeOriginRejected(t *testing.T) {
	srv, _ := newTestServer(t, []string{"http://ok.example"})
	conn, resp, err := dialWs(t, srv, 1, "http://evil.example")
	if conn != nil {
		conn.Close()
	}
	if err == nil {
		t.Fatal("期望非法 Origin 握手被拒,实际成功")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("期望 403,实际 %v", resp)
	}
}

func TestHandshakeOriginAllowed(t *testing.T) {
	srv, _ := newTestServer(t, []string{"http://ok.example"})
	conn, _, err := dialWs(t, srv, 2, "http://ok.example")
	if err != nil {
		t.Fatalf("合法 Origin 应握手成功: %v", err)
	}
	conn.Close()
}

func TestHandshakeNoOriginAllowed(t *testing.T) {
	srv, _ := newTestServer(t, []string{"http://ok.example"})
	conn, _, err := dialWs(t, srv, 3, "")
	if err != nil {
		t.Fatalf("无 Origin(非浏览器客户端)应放行: %v", err)
	}
	conn.Close()
}

func TestHandshakeEmptyWhitelistAllowsAny(t *testing.T) {
	srv, _ := newTestServer(t, nil)
	conn, _, err := dialWs(t, srv, 4, "http://anything.example")
	if err != nil {
		t.Fatalf("白名单为空时应放行任意 Origin: %v", err)
	}
	conn.Close()
}

func TestShutdownAllSendsCloseCode(t *testing.T) {
	srv, h := newTestServer(t, nil)
	conn, _, err := dialWs(t, srv, 5, "")
	if err != nil {
		t.Fatalf("握手失败: %v", err)
	}
	defer conn.Close()

	h.ShutdownAll(websocket.CloseServiceRestart, "server restarting")

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = conn.ReadMessage()
	if err == nil {
		t.Fatal("期望收到 close 帧后读失败,实际成功")
	}
	if ce, ok := err.(*websocket.CloseError); !ok || ce.Code != websocket.CloseServiceRestart {
		t.Fatalf("期望 close code 1012(ServiceRestart),实际 %v", err)
	}
}
