// 背压验收(docs 16 §4.4 / doc17 P5):慢客户端(只连不读)在持续下行下被逐出,进程不被拖垮。
// 用极小 send 缓冲 + 大下行帧,快速把 OS 发送缓冲与有界 channel 填满,触发逐出路径。
package smoke

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/redis/go-redis/v9"

	"github.com/our-chat/gateway/internal/hub"
	"github.com/our-chat/gateway/internal/metrics"
	"github.com/our-chat/gateway/internal/presence"
	"github.com/our-chat/gateway/internal/ws"
)

func TestBackpressureEviction(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	opt, err := redis.ParseURL(envOr("REDIS_URL", "redis://localhost:6379"))
	if err != nil {
		t.Fatalf("REDIS_URL 解析失败: %v", err)
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Skipf("Redis 不可达,跳过: %v", err)
	}

	const uid int64 = 9_911_223_355
	const deviceID = "slow"
	defer rdb.Del(context.Background(), "presence:"+strconv.FormatInt(uid, 10), "presence:"+strconv.FormatInt(uid, 10)+":meta")

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	reg := presence.New(rdb, 60*time.Second, "gw-test")
	// 极小缓冲:只要客户端读得慢,缓冲很快打满 → 逐出。
	h := hub.New(100, 1, 60*time.Second, reg, nil, log)
	handler := ws.NewHandler(h, reg, []byte(secret), log, nil)
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?deviceId=" + deviceID
	header := http.Header{}
	header.Set("Cookie", "token="+mintToken(t, uid))
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("握手失败: %v", err)
	}
	defer conn.Close()
	// 关键:客户端建立后【绝不读】,模拟慢消费者。

	// 等 presence 登记完成,确保连接已进 hub。
	for i := 0; i < 50; i++ {
		if n, _ := rdb.Exists(ctx, "presence:"+strconv.FormatInt(uid, 10)).Result(); n == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	before := testutil.ToFloat64(metrics.Evicted)

	// 大帧(~64KB)直接经 hub 路由,快速填满 OS 发送缓冲与有界 channel。
	big := strings.Repeat("x", 64*1024)
	frame, _ := json.Marshal(map[string]any{"type": "receiveMessage", "data": big})

	deadline := time.After(5 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatal("超时未触发慢消费者逐出")
		default:
		}
		h.RouteToUser(uid, "", "", frame)
		if testutil.ToFloat64(metrics.Evicted) > before {
			break // 已逐出,进程仍正常运转(本测试继续跑即证明未崩)
		}
		time.Sleep(2 * time.Millisecond)
	}

	// 逐出后该用户在本副本连接被摘除:presence 也应被 close 路径清掉。
	for i := 0; i < 100; i++ {
		if n, _ := rdb.Exists(ctx, "presence:"+strconv.FormatInt(uid, 10)).Result(); n == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("逐出后 presence 未被清除")
}
