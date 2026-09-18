// gRPC 流上行实现(ourchat.edge.v1.Realtime/Stream):
//   - per-instance 多流池(默认 4 条),按 userId 哈希分片——同用户帧恒落同一流,ack/断连同流返回;
//   - Forward:把 UplinkFrame 写入流后立即在分片内登记等待,由 recv 循环分发 UplinkAck(异步确认,
//     消除 HTTP 模式的每连接串行等待,见 26-9-16 方案文档 §4);
//   - 流断开:拒绝该分片全部在途 pending 并自动重建(指数退避);重建窗口内的上行快速失败,
//     由 conn 层回 message.error 兜底、客户端按协议重发(5s 超时同键重发,服务端幂等);
//   - downlink 帧(目标态下行,替代 Redis gw:downlink):经 onDownlink 回调交给 hub 路由,回调为空时丢弃。
package upstream

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"

	edgev1 "github.com/our-chat/gateway/internal/contracts/gen/ourchat/edge/v1"
)

// DownlinkHandler 接收目标态下行帧(server → gateway)。生产装配为 hub 路由,测试可注入 fake。
type DownlinkHandler func(*edgev1.DownlinkFrame)

// GrpcClient 是 Upstream 的 gRPC 流实现。
type GrpcClient struct {
	addr       string
	streams    []*streamShard
	conn       *grpc.ClientConn
	log        *slog.Logger
	onDownlink DownlinkHandler
	closeOnce  sync.Once
}

// tokenAuth 把共享内部令牌与副本标识注入每次 RPC 的 metadata
// (token 与 HTTP 模式的 X-Gateway-Token 同义;x-replica-id 供业务层定向下行,V3 §4.3)。
type tokenAuth struct {
	token   string
	replica string
}

func (t tokenAuth) GetRequestMetadata(_ context.Context, _ ...string) (map[string]string, error) {
	return map[string]string{"x-gateway-token": t.token, "x-replica-id": t.replica}, nil
}

func (t tokenAuth) RequireTransportSecurity() bool { return false }

// NewGrpc 建立到 Node 的 gRPC 连接并拉起 n 条双向流(每条流自带 recv 循环)。
func NewGrpc(addr string, n int, token string, replica string, log *slog.Logger, onDownlink DownlinkHandler) (*GrpcClient, error) {
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithPerRPCCredentials(tokenAuth{token: token, replica: replica}),
		// 长连接保活:空闲 30s 发 ping,1s 内无 ack 判死——gateway 侧尽快感知 server 重启。
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             time.Second,
			PermitWithoutStream: true,
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("grpc 连接失败: %w", err)
	}
	if n < 1 {
		n = 1
	}
	gc := &GrpcClient{addr: addr, conn: conn, log: log, onDownlink: onDownlink}
	for i := 0; i < n; i++ {
		shard := newStreamShard(i, edgev1.NewRealtimeClient(conn), onDownlink)
		gc.streams = append(gc.streams, shard)
		go shard.recvLoop(log)
	}
	return gc, nil
}

// shardFor 按 userId 哈希定位分片。
func (g *GrpcClient) shardFor(userID int64) *streamShard {
	return g.streams[int(uint64(userID)%uint64(len(g.streams)))]
}

// IsHealthy 有任一已建立流即视为健康(流断后 recvLoop 自动退避重建)。
func (g *GrpcClient) IsHealthy() bool {
	for _, s := range g.streams {
		s.mu.Lock()
		ok := s.stream != nil
		s.mu.Unlock()
		if ok {
			return true
		}
	}
	return false
}

// Forward 把一条客户端上行帧经 gRPC 流交给 Node,等 UplinkAck 后返回回投载荷(raw_response)。
// 与 HTTP 实现语义一致:返回的 []byte 非空时网关原样回投给客户端连接。
func (g *GrpcClient) Forward(ctx context.Context, userID int64, deviceID string, frame []byte) ([]byte, error) {
	shard := g.shardFor(userID)
	key := fmt.Sprintf("%d:%s", userID, extractClientMsgID(frame))
	return shard.forward(ctx, key, userID, deviceID, frame)
}

// ConcurrentSafe 返回 true:gRPC 流异步确认,支持每连接并发上行(方案文档 §4.4)。
func (g *GrpcClient) ConcurrentSafe() bool { return true }

// NotifyDisconnect 经流内 ConnClosed 帧通知 Node(替代 HTTP 端点,fire-and-forget)。
func (g *GrpcClient) NotifyDisconnect(ctx context.Context, userID int64, deviceID string) error {
	return g.shardFor(userID).send(&edgev1.EdgeFrame{
		Kind: &edgev1.EdgeFrame_Closed{Closed: &edgev1.ConnClosed{UserId: userID, DeviceId: deviceID}},
	})
}

// Close 拒绝全部在途等待并释放 gRPC 连接。
func (g *GrpcClient) Close() error {
	var err error
	g.closeOnce.Do(func() {
		for _, s := range g.streams {
			s.shutdown()
		}
		err = g.conn.Close()
	})
	return err
}

// ---------------- 流分片 ----------------

// streamShard 是一条双向流及其在途等待表。
type streamShard struct {
	id         int
	client     edgev1.RealtimeClient
	onDownlink DownlinkHandler
	mu         sync.Mutex
	stream     edgev1.Realtime_StreamClient
	pending    map[string]chan *edgev1.UplinkAck // key = "userId:clientMsgId" → ack 通道
	backoff    int
	closed     bool
}

func newStreamShard(id int, client edgev1.RealtimeClient, onDownlink DownlinkHandler) *streamShard {
	return &streamShard{id: id, client: client, onDownlink: onDownlink, pending: make(map[string]chan *edgev1.UplinkAck)}
}

// forward 写上行帧并等待确认。ctx 超时(由 conn 层给出,默认 10s)即返回错误。
// 流不可用(未建立/重建中)时快速失败,不自行拨号——流生命周期统一由 recvLoop 管理,避免并发拨号泄漏。
func (s *streamShard) forward(ctx context.Context, key string, userID int64, deviceID string, frame []byte) ([]byte, error) {
	ch := make(chan *edgev1.UplinkAck, 1)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, fmt.Errorf("上行通道已关闭")
	}
	stream := s.stream
	if stream == nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("上行流不可用(建立中),请重试")
	}
	s.pending[key] = ch
	s.mu.Unlock()

	// ack 到达或超时后清理登记;ack 晚到(重发场景)查不到等待者自然丢弃。
	defer func() {
		s.mu.Lock()
		delete(s.pending, key)
		s.mu.Unlock()
	}()

	uf := &edgev1.EdgeFrame{Kind: &edgev1.EdgeFrame_Uplink{Uplink: &edgev1.UplinkFrame{
		UserId:      userID,
		DeviceId:    deviceID,
		ClientMsgId: extractClientMsgID(frame),
		RawFrame:    frame,
	}}}
	// grpc-go 保证 SendMsg 并发安全;同用户帧顺序由服务端 seq 发号保证,上行乱序无害(方案文档 §4.4)。
	if err := stream.Send(uf); err != nil {
		return nil, fmt.Errorf("上行写流失败: %w", err)
	}

	select {
	case ack := <-ch:
		if ack == nil {
			return nil, fmt.Errorf("上行流中断")
		}
		if !ack.Ok {
			return nil, fmt.Errorf("%s", ack.Error)
		}
		return ack.RawResponse, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// send 写一帧不等待(ConnClosed 等 fire-and-forget)。
func (s *streamShard) send(f *edgev1.EdgeFrame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.stream == nil {
		return fmt.Errorf("上行流不可用")
	}
	return s.stream.Send(f)
}

// recvLoop 持续读本分片流:ack 投递给等待者,downlink 由 GrpcClient 回调路由;
// 流断则拒绝全部在途并退避重建。
func (s *streamShard) recvLoop(log *slog.Logger) {
	if err := s.dialStream(); err != nil {
		log.Warn("上行流初始建立失败", "shard", s.id, "err", err)
	}
	for {
		s.mu.Lock()
		stream := s.stream
		closed := s.closed
		s.mu.Unlock()
		if closed {
			return
		}
		if stream == nil {
			time.Sleep(backoffDelay(&s.backoff))
			if err := s.dialStream(); err != nil {
				log.Warn("上行流重建失败", "shard", s.id, "err", err)
			}
			continue
		}

		frame, err := stream.Recv()
		if err != nil {
			log.Warn("上行流中断,重建中", "shard", s.id, "err", err)
			s.mu.Lock()
			if s.stream == stream {
				s.stream = nil
			}
			s.mu.Unlock()
			s.failAll()
			time.Sleep(backoffDelay(&s.backoff))
			if derr := s.dialStream(); derr != nil {
				log.Warn("上行流重建失败", "shard", s.id, "err", derr)
			}
			continue
		}

		s.backoff = 0 // 流健康,重置退避
		switch k := frame.Kind.(type) {
		case *edgev1.EdgeFrame_Ack:
			s.deliverAck(k.Ack)
		case *edgev1.EdgeFrame_Downlink:
			if s.onDownlink != nil {
				s.onDownlink(k.Downlink)
			}
		}
	}
}

func (s *streamShard) dialStream() error {
	stream, err := s.client.Stream(context.Background())
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.stream = stream
	s.mu.Unlock()
	return nil
}

func (s *streamShard) deliverAck(ack *edgev1.UplinkAck) {
	key := fmt.Sprintf("%d:%s", ack.UserId, ack.ClientMsgId)
	s.mu.Lock()
	ch := s.pending[key]
	s.mu.Unlock()
	if ch != nil {
		select {
		case ch <- ack:
		default: // 等待者已退出(超时),丢弃
		}
	}
}

// failAll 拒绝本分片全部在途等待(流断时),调用方以错误兜底重试。
func (s *streamShard) failAll() {
	s.mu.Lock()
	pending := s.pending
	s.pending = make(map[string]chan *edgev1.UplinkAck)
	s.mu.Unlock()
	for _, ch := range pending {
		close(ch) // forward 的 <-ch 读到零值 ack=nil → 返回「上行流中断」
	}
}

// shutdown 终止分片(网关退出)。
func (s *streamShard) shutdown() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.failAll()
}

func backoffDelay(attempt *int) time.Duration {
	*attempt++
	d := time.Duration(1) << bmin(*attempt, 5) * 100 * time.Millisecond // 0.1s → 3.2s 封顶
	if d > 3*time.Second {
		d = 3 * time.Second
	}
	return d
}

func bmin(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// extractClientMsgID 从客户端信封里解出幂等键(仅用于关联 ack,不解业务):
// 兼容 {type, data:{clientMsgId}} 与旧 PoC 平铺 {type, clientMsgId} 两种形态。
func extractClientMsgID(frame []byte) string {
	var env struct {
		ClientMsgID string `json:"clientMsgId"`
		Data        struct {
			ClientMsgID string `json:"clientMsgId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(frame, &env); err != nil {
		return ""
	}
	if env.Data.ClientMsgID != "" {
		return env.Data.ClientMsgID
	}
	return env.ClientMsgID
}
