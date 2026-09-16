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
//
// 上行模式随通道实现分化:
//   - http 模式(concurrentUpstream=false):读循环串行等回包(既有行为,天然背压);
//   - grpc 流模式(concurrentUpstream=true):读循环非阻塞派发到 goroutine,每连接 in-flight
//     信号量限并发(满时读循环阻塞,TCP 背压传导给客户端),同 clientMsgId 在途去重(重发帧丢弃,
//     复用首帧响应);ack 乱序回投按 clientMsgId 收敛(26-9-16 方案文档 §4.4)。
type Conn struct {
	userID   int64
	deviceID string
	socketID string

	ws   *websocket.Conn
	send chan []byte
	hub  *Hub

	// grpc 并发上行状态
	inflightMu sync.Mutex
	inflight   map[string]struct{} // clientMsgId 在途集合(同键去重)
	sem        chan struct{}       // 每连接 in-flight 上限

	closed    chan struct{} // 关闭信号(enqueue/writeLoop 据此退出,send 永不关闭防 panic)
	closeOnce sync.Once
}

// 每连接并发上行的 in-flight 上限:满时读循环阻塞(自然背压),防单连接无限堆积。
const inflightLimit = 64

// 上行帧只解出 type 与 clientMsgId(用于错误帧关联与同键去重),其余字段原样透传给 Node。
type inboundFrame struct {
	Type        string `json:"type"`
	ClientMsgID string `json:"clientMsgId"`
	Data        struct {
		ClientMsgID string `json:"clientMsgId"`
	} `json:"data"`
}

func (f *inboundFrame) clientMsgID() string {
	if f.Data.ClientMsgID != "" {
		return f.Data.ClientMsgID
	}
	return f.ClientMsgID
}

// enqueue 非阻塞投递一条下行帧。返回 false 表示 send 缓冲已满(慢消费者),调用方据此逐出连接。
// 用 select-default 而非阻塞写:下行扇出绝不能因为某条连接读得慢而卡住整个 backplane 循环。
func (c *Conn) enqueue(payload []byte) bool {
	select {
	case <-c.closed:
		return false
	default:
	}
	select {
	case c.send <- payload:
		return true
	default:
		return false
	}
}

// close 幂等关闭:摘 presence、出 hub 注册表、通知 Node 断连、关底层 ws。
// 不 close send channel(并发上行 goroutine 可能仍在 enqueue,close 会导致 panic);
// writeLoop 以 closed 信号与 ws 写失败退出。
func (c *Conn) close() {
	c.closeOnce.Do(func() {
		close(c.closed)
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
		if c.hub.concurrentUpstream {
			c.dispatchConcurrent(raw)
		} else {
			c.dispatch(raw)
		}
	}
}

// dispatchLocal 处理网关本地帧(心跳等),返回 true 表示已本地消化、无需透传 Node。
func (c *Conn) dispatchLocal(raw []byte) bool {
	var f inboundFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		c.enqueue(errorFrame("帧不是合法 JSON", ""))
		return true
	}

	// 应用层心跳:续约 presence TTL + 推后读截止。与 Node socket.ts 的 heartbeat 事件等价(docs 16 §5.2)。
	if f.Type == "heartbeat" {
		_ = c.ws.SetReadDeadline(time.Now().Add(c.hub.heartbeatTimeout))
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := c.hub.presence.Refresh(ctx, c.userID, c.deviceID); err != nil {
			c.hub.log.Warn("presence 续约失败", "userId", c.userID, "err", err)
		}
		return true
	}
	return false
}

// dispatch 串行上行(http 模式):透传 Node 拿同步响应,回投发送方。网关不解析业务语义。
func (c *Conn) dispatch(raw []byte) {
	if c.dispatchLocal(raw) {
		return
	}

	var f inboundFrame
	_ = json.Unmarshal(raw, &f) // dispatchLocal 已校验合法 JSON(非法会回错误帧并返回)

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	resp, err := c.hub.upstream.Forward(ctx, c.userID, c.deviceID, raw)
	metrics.UplinkDuration.Observe(time.Since(start).Seconds())
	if err != nil {
		metrics.Uplink.WithLabelValues("upstream_error").Inc()
		c.hub.log.Warn("上行透传失败", "userId", c.userID, "err", err)
		// 错误帧必须带 clientMsgId:客户端据此收敛 pending,不再依赖超时重发(26-9-16 根因 E3)。
		c.enqueue(errorFrame("消息发送失败", f.clientMsgID()))
		return
	}
	metrics.Uplink.WithLabelValues("ok").Inc()
	if len(resp) > 0 {
		c.enqueue(resp)
	}
}

// dispatchConcurrent 并发上行(grpc 流模式):读循环非阻塞派发,由上游异步确认。
//   - 同 clientMsgId 在途去重:重发帧直接丢弃,首帧响应回投后客户端收敛(服务端幂等);
//   - in-flight 信号量满时阻塞读循环(TCP 背压传导),不无限堆积 goroutine;
//   - 回投在派发 goroutine 内完成,乱序无妨(ack 按 clientMsgId 收敛)。
func (c *Conn) dispatchConcurrent(raw []byte) {
	if c.dispatchLocal(raw) {
		return
	}

	var f inboundFrame
	_ = json.Unmarshal(raw, &f)
	cid := f.clientMsgID()

	if cid != "" {
		c.inflightMu.Lock()
		if _, dup := c.inflight[cid]; dup {
			c.inflightMu.Unlock()
			return // 同键在途:重发帧丢弃(首帧响应回投后客户端收敛)
		}
		c.inflight[cid] = struct{}{}
		c.inflightMu.Unlock()
	}

	c.sem <- struct{}{} // 背压:in-flight 满则阻塞读循环(信号量跨 goroutine 传递,释放见下)

	go func() {
		defer func() {
			<-c.sem
			if cid != "" {
				c.inflightMu.Lock()
				delete(c.inflight, cid)
				c.inflightMu.Unlock()
			}
		}()

		start := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		resp, err := c.hub.upstream.Forward(ctx, c.userID, c.deviceID, raw)
		metrics.UplinkDuration.Observe(time.Since(start).Seconds())
		if err != nil {
			metrics.Uplink.WithLabelValues("upstream_error").Inc()
			c.hub.log.Warn("上行透传失败", "userId", c.userID, "err", err)
			c.enqueue(errorFrame("消息发送失败", cid))
			return
		}
		metrics.Uplink.WithLabelValues("ok").Inc()
		if len(resp) > 0 {
			c.enqueue(resp)
		}
	}()
}

func (c *Conn) writeLoop() {
	// 协议 ping 间隔取心跳超时的 ~0.4,确保超时窗口内至少探测一次存活。
	pingInterval := c.hub.heartbeatTimeout * 2 / 5
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.closed:
			return
		case payload := <-c.send:
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

// errorFrame 构造错误回投帧。clientMsgID 非空时带上,让客户端可收敛 pending(26-9-16 根因 E3)。
func errorFrame(msg, clientMsgID string) []byte {
	if clientMsgID == "" {
		b, _ := json.Marshal(map[string]string{"type": "message.error", "message": msg})
		return b
	}
	b, _ := json.Marshal(map[string]any{
		"type": "message.error",
		"data": map[string]string{"message": msg, "clientMsgId": clientMsgID},
	})
	return b
}
