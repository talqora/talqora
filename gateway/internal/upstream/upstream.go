// Package upstream 是网关到 Node 业务层的上行通道抽象。网关只管连接,业务仍在 Node:
// 落库/发号/幂等/扩散都由 Node 复用既有逻辑完成,网关不碰 DB(docs 16 §5.4「上行透传」)。
//
// 两种实现(env GATEWAY_UPSTREAM 选择,默认 http 保持回滚兼容):
//   - http:每消息一次 POST /internal/gateway/uplink(26-9-16 压测证实 ≈1000 msg/s 出现 dial 耗尽,
//     本文件已做连接池调优止血;但每连接串行等待的排队问题只有 grpc 流模式能根治);
//   - grpc:双向流(ourchat.edge.v1.Realtime/Stream),单长连接复用 + 异步确认,见 grpc.go。
package upstream

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Upstream 上行通道抽象:Forward 把一条客户端上行帧交给 Node 处理并返回 ack/error 回投载荷;
// NotifyDisconnect 通知 Node 一条连接已断开(通话 grace 重连等,对齐 socket.io disconnect 事件)。
type Upstream interface {
	Forward(ctx context.Context, userID int64, deviceID string, frame []byte) ([]byte, error)
	NotifyDisconnect(ctx context.Context, userID int64, deviceID string) error
	// ConcurrentSafe 表示该实现支持每连接并发上行(读循环无需串行等回包):
	// grpc 流实现为 true(异步确认,26-9-16 方案文档 §4.4);HTTP-per-message 为 false
	// (保持每连接串行,既是既有行为也是天然背压,避免并发 HTTP 打爆业务层)。
	ConcurrentSafe() bool
}

// Client 是 HTTP 实现:每消息一次 POST /internal/gateway/uplink(同步等回包)。
type Client struct {
	baseURL       string
	internalToken string
	http          *http.Client
}

// New 构造 HTTP 上行客户端。
// Transport 调优(P0 止血,26-9-16 根因 E1):Go 默认 MaxIdleConnsPerHost=2,HTTP-per-message
// 每秒上千次建连会打满 TIME_WAIT 端口(实测 10,341 次 "can't assign requested address")。
// 这里把每主机空闲连接上限提到 128 并放大总空闲池,让高频短请求尽量复用连接。
func New(baseURL, internalToken string) *Client {
	transport := &http.Transport{
		MaxIdleConns:        256,
		MaxIdleConnsPerHost: 128,
		IdleConnTimeout:     90 * time.Second,
	}
	return &Client{
		baseURL:       baseURL,
		internalToken: internalToken,
		// 上行是同步等 ack 的热路径,给一个有界超时,避免 Node 卡住时连接堆积。
		http: &http.Client{Timeout: 10 * time.Second, Transport: transport},
	}
}

// Forward 把原始上行帧 POST 给 Node /internal/gateway/uplink,带上验签得到的 userId 与内部令牌。
// 返回 Node 的响应体(网关原样回投给发送方连接,如 message.ack / message.error)。
// userId 走头部由网关注入——身份以网关验签为准,Node 不信任帧内自报的 senderId。
func (c *Client) Forward(ctx context.Context, userID int64, deviceID string, frame []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/gateway/uplink", bytes.NewReader(frame))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gateway-Token", c.internalToken)
	req.Header.Set("X-User-Id", strconv.FormatInt(userID, 10))
	req.Header.Set("X-Device-Id", deviceID)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream 返回 %d: %s", resp.StatusCode, string(body))
	}
	return body, nil
}

// ConcurrentSafe 返回 false:HTTP 实现保持每连接串行上行(既有行为,见接口注释)。
func (c *Client) ConcurrentSafe() bool { return false }

// NotifyDisconnect 通知 Node 一条连接已断开(优雅/异常断开的统一出口)。
// fire-and-forget:调用方只关心是否送达,失败仅记日志;身份与内部令牌注入方式与 Forward 一致。
func (c *Client) NotifyDisconnect(ctx context.Context, userID int64, deviceID string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/gateway/disconnect", nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Gateway-Token", c.internalToken)
	req.Header.Set("X-User-Id", strconv.FormatInt(userID, 10))
	req.Header.Set("X-Device-Id", deviceID)

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("disconnect 通知返回 %d", resp.StatusCode)
	}
	return nil
}
