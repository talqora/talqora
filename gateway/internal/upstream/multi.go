// 多后端 gRPC 上行:业务层多副本时 EDGE_GRPC_ADDR 逗号分隔多地址,
// 每地址一组流池;上行帧按 userId 哈希落到固定后端(同用户帧恒同后端,ack 可关联)。
// 断连通知按同一哈希选后端(与上行同后端,ConnClosed 与上行帧同流语义保持)。
package upstream

import (
	"context"
	"fmt"
	"log/slog"
)

// MultiGrpc 是 Upstream 的多后端实现:组合 N 个 GrpcClient。
type MultiGrpc struct {
	clients []*GrpcClient
	log     *slog.Logger
}

// NewMultiGrpc 为每个后端地址建立一组 gRPC 流。
func NewMultiGrpc(addrs []string, streamsPerBackend int, token string, log *slog.Logger, onDownlink DownlinkHandler) (*MultiGrpc, error) {
	m := &MultiGrpc{log: log}
	for _, addr := range addrs {
		gc, err := NewGrpc(addr, streamsPerBackend, token, log, onDownlink)
		if err != nil {
			_ = m.Close()
			return nil, fmt.Errorf("后端 %s: %w", addr, err)
		}
		m.clients = append(m.clients, gc)
		log.Info("gRPC 上行后端就绪", "addr", addr, "streams", streamsPerBackend)
	}
	return m, nil
}

// clientFor 按 userId 哈希选后端(同用户恒同后端)。
func (m *MultiGrpc) clientFor(userID int64) *GrpcClient {
	return m.clients[int(uint64(userID)%uint64(len(m.clients)))]
}

// Forward 把上行帧交给 userId 对应的后端,等 ack 返回回投载荷。
func (m *MultiGrpc) Forward(ctx context.Context, userID int64, deviceID string, frame []byte) ([]byte, error) {
	if len(m.clients) == 0 {
		return nil, fmt.Errorf("无可用 gRPC 后端")
	}
	return m.clientFor(userID).Forward(ctx, userID, deviceID, frame)
}

// NotifyDisconnect 断连通知发给与上行相同的后端。
func (m *MultiGrpc) NotifyDisconnect(ctx context.Context, userID int64, deviceID string) error {
	if len(m.clients) == 0 {
		return fmt.Errorf("无可用 gRPC 后端")
	}
	return m.clientFor(userID).NotifyDisconnect(ctx, userID, deviceID)
}

// ConcurrentSafe 恒 true(gRPC 流异步确认)。
func (m *MultiGrpc) ConcurrentSafe() bool { return true }

// Close 关闭全部后端连接。
func (m *MultiGrpc) Close() error {
	var first error
	for _, c := range m.clients {
		if err := c.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

var _ Upstream = (*MultiGrpc)(nil)
