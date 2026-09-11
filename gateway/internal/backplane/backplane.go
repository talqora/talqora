// Package backplane 订阅 Redis 下行频道 gw:downlink,把 Node 业务侧 publish 的下行帧路由到本副本连接。
// 这是跨副本投递的接收端:任意副本的 Node 落库后 publish,持有该用户连接的网关副本据此代投(docs 16 §5.1)。
//
// 频道载荷(与 Node 内部端点约定):{ "userId": <number>, "frame": <客户端帧原样> }
//   - userId 用于路由(投给该用户在本副本的全部连接);
//   - frame 是客户端最终收到的 WS 帧(如 { type:"receiveMessage", data:<message> }),网关原样转发不解析。
package backplane

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/our-chat/gateway/internal/hub"
	"github.com/our-chat/gateway/internal/metrics"
)

const channel = "gw:downlink"

type downlinkMsg struct {
	UserID int64           `json:"userId"`
	Frame  json.RawMessage `json:"frame"`
}

// Run 订阅下行频道并阻塞分发,直到 ctx 取消。订阅连接独立于命令连接(订阅态不能发普通命令)。
func Run(ctx context.Context, rdb *redis.Client, h *hub.Hub, log *slog.Logger) error {
	sub := rdb.Subscribe(ctx, channel)
	defer sub.Close()

	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case m, ok := <-ch:
			if !ok {
				return nil
			}
			var dm downlinkMsg
			if err := json.Unmarshal([]byte(m.Payload), &dm); err != nil {
				log.Warn("下行帧解析失败", "err", err)
				continue
			}
			if dm.UserID == 0 || len(dm.Frame) == 0 {
				continue
			}
			// 计时窗口:从此刻(已解出本条下行帧)到 RouteToUser 把它投进目标连接 send channel 为止。
			// RouteToUser 内部对该用户在本副本的每条连接都做 enqueue(非阻塞 channel 写),
			// 这里量的是"路由 + 入队"这一段,不含客户端后续真正读走/写到 socket 的耗时。
			start := time.Now()
			h.RouteToUser(dm.UserID, dm.Frame)
			metrics.DownlinkDuration.Observe(time.Since(start).Seconds())
		}
	}
}
