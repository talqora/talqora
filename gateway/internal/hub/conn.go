package hub

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/our-chat/gateway/internal/metrics"
)

// Conn 是一条客户端 WS 连接。读写各跑一个 goroutine:
//   - readLoop:收上行帧 → 透传 Node / 处理心跳;
//   - writeLoop:从有界 send channel 取下行帧写出,并定时发协议 ping 保活。
// send 是有界 channel——这是背压的支点:打满即判定慢消费者并逐出,绝不让单个慢客户端拖垮网关(docs 16 §4.4)。
type Conn struct {
	userID   int64
	deviceID string
	socketID string

	ws   *websocket.Conn
	send chan []byte
	hub  *Hub

	closeOnce sync.Once
}

// 上行帧只解出 type,其余字段原样透传给 Node(网关不理解业务字段,docs 16 §5.4)。
type inboundFrame struct {
	Type string `json:"type"`
}

// enqueue 非阻塞投递一条下行帧。返回 false 表示 send 缓冲已满(慢消费者),调用方据此逐出连接。
// 用 select-default 而非阻塞写:下行扇出绝不能因为某条连接读得慢而卡住整个 backplane 循环。
func (c *Conn) enqueue(payload []byte) bool {
	select {
	case c.send <- payload:
		return true
	default:
		return false
	}
}

// close 幂等关闭:摘 presence、出 hub 注册表、关 send channel 让 writeLoop 退出、关闭底层 ws。
func (c *Conn) close() {
	c.closeOnce.Do(func() {
		c.hub.unregister(c)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := c.hub.presence.Remove(ctx, c.userID, c.deviceID); err != nil {
			c.hub.log.Warn("presence 摘除失败", "userId", c.userID, "deviceId", c.deviceID, "err", err)
		}
		// 通知 Node 业务侧连接已断开(通话 grace 重连等,对齐 socket.io disconnect 事件语义)。
		// upstream 为 nil 仅出现在测试装配,跳过。
		if c.hub.upstream != nil {
			if err := c.hub.upstream.NotifyDisconnect(ctx, c.userID, c.deviceID); err != nil {
				c.hub.log.Warn("断连通知失败", "userId", c.userID, "deviceId", c.deviceID, "err", err)
			}
		}
		close(c.send)
		_ = c.ws.Close()
		metrics.Connections.Dec()
	})
}

func (c *Conn) readLoop() {
	defer c.close()

	c.ws.SetReadLimit(1 << 20) // 单帧上限 1MB,防超大帧打爆内存
	_ = c.ws.SetReadDeadline(time.Now().Add(c.hub.heartbeatTimeout))
	// 协议层 pong 续期读截止:客户端回应网关 ping,即视为存活。
	c.ws.SetPongHandler(func(string) error {
		_ = c.ws.SetReadDeadline(time.Now().Add(c.hub.heartbeatTimeout))
		return nil
	})

	for {
		_, raw, err := c.ws.ReadMessage()
		if err != nil {
			return // 连接断开/超时/读错,统一走 defer close
		}
		c.dispatch(raw)
	}
}

func (c *Conn) dispatch(raw []byte) {
	var f inboundFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		c.enqueue(errorFrame("帧不是合法 JSON"))
		return
	}

	// 应用层心跳:续约 presence TTL + 推后读截止。与 Node socket.ts 的 heartbeat 事件等价(docs 16 §5.2)。
	if f.Type == "heartbeat" {
		_ = c.ws.SetReadDeadline(time.Now().Add(c.hub.heartbeatTimeout))
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := c.hub.presence.Refresh(ctx, c.userID, c.deviceID); err != nil {
			c.hub.log.Warn("presence 续约失败", "userId", c.userID, "err", err)
		}
		return
	}

	// 其余帧一律透传 Node 落库,拿同步响应(ack/error)回投发送方。网关不解析业务语义。
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	resp, err := c.hub.upstream.Forward(ctx, c.userID, c.deviceID, raw)
	metrics.UplinkDuration.Observe(time.Since(start).Seconds())
	if err != nil {
		metrics.Uplink.WithLabelValues("upstream_error").Inc()
		c.hub.log.Warn("上行透传失败", "userId", c.userID, "err", err)
		c.enqueue(errorFrame("消息发送失败"))
		return
	}
	metrics.Uplink.WithLabelValues("ok").Inc()
	if len(resp) > 0 {
		c.enqueue(resp)
	}
}

func (c *Conn) writeLoop() {
	// 协议 ping 间隔取心跳超时的 ~0.4,确保超时窗口内至少探测一次存活。
	pingInterval := c.hub.heartbeatTimeout * 2 / 5
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case payload, ok := <-c.send:
			if !ok {
				return // send 被 close()关闭,连接已下线
			}
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.ws.WriteMessage(websocket.TextMessage, payload); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func errorFrame(msg string) []byte {
	b, _ := json.Marshal(map[string]string{"type": "message.error", "message": msg})
	return b
}
