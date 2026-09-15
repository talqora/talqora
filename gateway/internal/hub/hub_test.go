package hub

import (
	"io"
	"log/slog"
	"testing"
)

const testUID int64 = 42

// newTestHub 构造带两条设备连接(devA/devB)的 hub,不依赖 Redis/websocket。
func newTestHub() *Hub {
	return &Hub{
		conns: map[int64]map[string]*Conn{
			testUID: {
				"devA": {userID: testUID, deviceID: "devA", send: make(chan []byte, 8)},
				"devB": {userID: testUID, deviceID: "devB", send: make(chan []byte, 8)},
			},
		},
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func recv(t *testing.T, c *Conn) ([]byte, bool) {
	t.Helper()
	select {
	case p := <-c.send:
		return p, true
	default:
		return nil, false
	}
}

func TestRouteToUserNoFilterDeliversToAll(t *testing.T) {
	h := newTestHub()
	payload := []byte(`{"type":"receiveMessage"}`)
	h.RouteToUser(testUID, "", "", payload)
	for _, d := range []string{"devA", "devB"} {
		c := h.conns[testUID][d]
		if p, ok := recv(t, c); !ok || string(p) != string(payload) {
			t.Fatalf("期望 %s 收到 %s,实际 %v", d, payload, p)
		}
	}
}

func TestRouteToUserTargetOnly(t *testing.T) {
	h := newTestHub()
	h.RouteToUser(testUID, "devA", "", []byte("x"))
	if p, ok := recv(t, h.conns[testUID]["devA"]); !ok || string(p) != "x" {
		t.Fatalf("devA 应收到,实际 %v", p)
	}
	if _, ok := recv(t, h.conns[testUID]["devB"]); ok {
		t.Fatal("devB 不应收到")
	}
}

func TestRouteToUserExcept(t *testing.T) {
	h := newTestHub()
	h.RouteToUser(testUID, "", "devA", []byte("x"))
	if p, ok := recv(t, h.conns[testUID]["devB"]); !ok || string(p) != "x" {
		t.Fatalf("devB 应收到,实际 %v", p)
	}
	if _, ok := recv(t, h.conns[testUID]["devA"]); ok {
		t.Fatal("devA 不应收到")
	}
}

func TestRouteToUserTargetMissingDeliversNothing(t *testing.T) {
	h := newTestHub()
	h.RouteToUser(testUID, "ghost", "", []byte("x"))
	for _, d := range []string{"devA", "devB"} {
		if _, ok := recv(t, h.conns[testUID][d]); ok {
			t.Fatalf("%s 不应收到", d)
		}
	}
}

func TestRouteToUserUnknownUserNoPanic(t *testing.T) {
	h := newTestHub()
	h.RouteToUser(999, "", "", []byte("x")) // 无本地连接,仅计数 dropped,不 panic
}
