// 网关端到端冒烟:用真 Redis 验证握手+JWT 鉴权、presence 镜像登记、下行 backplane 投递、未授权拒绝。
// 跑法:确保本机 Redis 可达(REDIS_URL,缺省 redis://localhost:6379),go test ./test/。Redis 不可达则跳过。
package smoke

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	"github.com/our-chat/gateway/internal/backplane"
	"github.com/our-chat/gateway/internal/hub"
	"github.com/our-chat/gateway/internal/presence"
	"github.com/our-chat/gateway/internal/ws"
)

const secret = "smoke-secret"

func mintToken(t *testing.T, uid int64) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"id":       uid,
		"username": "smoke",
		"exp":      time.Now().Add(time.Hour).Unix(),
	})
	s, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("签 token 失败: %v", err)
	}
	return s
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func TestGatewaySmoke(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	opt, err := redis.ParseURL(envOr("REDIS_URL", "redis://localhost:6379"))
	if err != nil {
		t.Fatalf("REDIS_URL 解析失败: %v", err)
	}
	rdb := redis.NewClient(opt)
	subRdb := redis.NewClient(opt)
	defer rdb.Close()
	defer subRdb.Close()
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Skipf("Redis 不可达,跳过冒烟: %v", err)
	}

	const uid int64 = 9_911_223_344
	const deviceID = "dev1"
	defer rdb.Del(context.Background(), "presence:"+strconv.FormatInt(uid, 10), "presence:"+strconv.FormatInt(uid, 10)+":meta")

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	reg := presence.New(rdb, 60*time.Second, "gw-test")
	h := hub.New(100, 8, 60*time.Second, reg, nil, log)
	handler := ws.NewHandler(h, reg, []byte(secret), log, nil)

	srv := httptest.NewServer(handler)
	defer srv.Close()

	go func() { _ = backplane.Run(ctx, subRdb, h, log) }()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?deviceId=" + deviceID

	// 1) 未授权:无 token cookie 直接被拒。
	t.Run("无凭据握手被拒", func(t *testing.T) {
		_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err == nil {
			t.Fatal("期望握手失败,实际成功")
		}
		if resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("期望 401,实际 %v", resp)
		}
	})

	// 2) 合法 token 握手成功,且 presence 被镜像登记到 Redis。
	header := http.Header{}
	header.Set("Cookie", "token="+mintToken(t, uid))
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("合法握手失败: %v", err)
	}
	defer conn.Close()

	t.Run("presence 已登记", func(t *testing.T) {
		var members []string
		// 登记是异步的(握手返回后写 Redis),短轮询等待。
		for i := 0; i < 50; i++ {
			members, _ = rdb.ZRange(ctx, "presence:"+strconv.FormatInt(uid, 10), 0, -1).Result()
			if len(members) > 0 {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if len(members) != 1 || members[0] != deviceID {
			t.Fatalf("期望 presence 含设备 %q,实际 %v", deviceID, members)
		}
		meta, _ := rdb.HGet(ctx, "presence:"+strconv.FormatInt(uid, 10)+":meta", deviceID).Result()
		if !strings.HasPrefix(meta, "gw-test:") {
			t.Fatalf("期望 meta 以 replica 前缀开头,实际 %q", meta)
		}
	})

	// 3) 下行 backplane:publish 到 gw:downlink 应被路由到该连接。
	t.Run("下行投递", func(t *testing.T) {
		payload, _ := json.Marshal(map[string]any{
			"userId": uid,
			"frame":  map[string]any{"type": "receiveMessage", "data": map[string]any{"hello": 1}},
		})
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))

		// 订阅建立可能晚于 publish,循环发布直到收到。
		got := make(chan []byte, 1)
		go func() {
			_, msg, err := conn.ReadMessage()
			if err == nil {
				got <- msg
			}
		}()
		deadline := time.After(3 * time.Second)
		for {
			rdb.Publish(ctx, "gw:downlink", payload)
			select {
			case msg := <-got:
				if !strings.Contains(string(msg), "receiveMessage") {
					t.Fatalf("下行帧内容不符: %s", msg)
				}
				return
			case <-deadline:
				t.Fatal("超时未收到下行帧")
			case <-time.After(100 * time.Millisecond):
			}
		}
	})
}
