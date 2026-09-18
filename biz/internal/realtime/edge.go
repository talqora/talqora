// Package realtime 是 gRPC edge 流服务(ourchat.edge.v1.Realtime/Stream)。
// 承接 gateway 上行帧(UplinkFrame→业务→ack)与断连通知(ConnClosed),语义对齐 server/src/realtime/edgeGrpc.ts。
package realtime

import (
	"context"
	"log/slog"
	"net"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"

	edgev1 "github.com/our-chat/biz/internal/contracts/gen/ourchat/edge/v1"
	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/metrics"
)

// EdgeServer 实现 Realtime/Stream 双向流。
type EdgeServer struct {
	edgev1.UnimplementedRealtimeServer
	cfg    *config.Config
	logger *slog.Logger
	grpc   *grpc.Server
	health *health.Server
}

// StartEdge 启动 gRPC 流服务(仅内网)。失败(端口占用等)返回 error 由调用方决定退出。
func StartEdge(cfg *config.Config, logger *slog.Logger) (*EdgeServer, error) {
	lis, err := net.Listen("tcp", cfg.EdgeGrpcAddr)
	if err != nil {
		return nil, err
	}
	s := &EdgeServer{cfg: cfg, logger: logger}
	srv := grpc.NewServer(
		// 帧上限与 gateway WS 读限对齐(1MB):防超大帧瞬时分配峰值。
		grpc.MaxRecvMsgSize(1<<20),
		// keepalive 匹配:gateway 客户端 Time=30s 空闲 ping;默认 MinTime=5min 会把 30s 间隔的
		// ping 判违规(>2 次 GOAWAY "too_many_pings",约 90s 周期断连,已实测验证)。
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             20 * time.Second,
			PermitWithoutStream: true,
		}),
		// server 主动探活:60s 空闲发 ping,20s 无响应判死,尽快感知 gateway 副本死亡。
		grpc.KeepaliveParams(keepalive.ServerParameters{
			Time:    60 * time.Second,
			Timeout: 20 * time.Second,
		}),
		// 流控窗口调大:减少小消息高频下的 WINDOW_UPDATE 往返,不增稳态内存。
		grpc.InitialWindowSize(1 << 20),
		grpc.InitialConnWindowSize(1 << 20),
	)
	s.grpc = srv
	edgev1.RegisterRealtimeServer(srv, s)
	// 标准 health 协议(V3-P4 扩缩容前置):副本滚动时供 gateway/编排探活。
	hs := health.NewServer()
	hs.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)
	hs.SetServingStatus("ourchat.edge.v1.Realtime", healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(srv, hs)
	s.health = hs
	go func() {
		if err := srv.Serve(lis); err != nil {
			logger.Error("gRPC 流服务异常退出", "err", err)
		}
	}()
	logger.Info("gRPC 流服务已启动", "addr", cfg.EdgeGrpcAddr)
	return s, nil
}

// GracefulStop 优雅停止 gRPC 服务(先置 NOT_SERVING 让探活感知,再停流)。
func (s *EdgeServer) GracefulStop() {
	if s.health != nil {
		s.health.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)
		s.health.Shutdown()
	}
	if s.grpc != nil {
		s.grpc.GracefulStop()
	}
}

// Stream 双向流:gateway 为每条流按 userId 哈希分片。
func (s *EdgeServer) Stream(stream edgev1.Realtime_StreamServer) error {
	// 鉴权:gateway 经 PerRPCCredentials 注入 x-gateway-token(edgeGrpc.ts:113-117)。
	md, _ := metadata.FromIncomingContext(stream.Context())
	tokens := md.Get("x-gateway-token")
	if len(tokens) == 0 || tokens[0] != s.cfg.InternalToken {
		return statusErrorUnauthenticated()
	}

	metrics.WSConnections.Inc()
	defer func() {
		metrics.WSConnections.Dec()
		metrics.WSDisconnectsTotal.WithLabelValues("stream_close").Inc()
	}()

	// 定向下行:按 x-replica-id 登记本流所属的网关副本(缺失则仅上行/ack,下行走 pub/sub 兜底)。
	replica := ""
	if reps := md.Get("x-replica-id"); len(reps) > 0 {
		replica = reps[0]
	}
	if replica != "" {
		registerReplicaStream(replica, stream)
		defer unregisterReplicaStream(replica, stream)
	}

	// 帧并发处理:同用户消息顺序由服务端 seq 发号保证,处理乱序无害(edgeGrpc.ts:119-124)。
	for {
		frame, err := stream.Recv()
		if err != nil {
			if isCancelled(err) {
				return err
			}
			s.logger.Error("gRPC 流异常", "err", err)
			return err
		}
		go func(f *edgev1.EdgeFrame) {
			if err := processFrame(stream, f, s); err != nil {
				s.logger.Error("gRPC 上行帧处理异常", "err", err)
			}
		}(frame)
	}
}

// FinalCheckpoint 优雅关闭时把内存中的 seq 发号位点终检写回 PG(发号 checkpoint 的关闭兜底)。
func FinalCheckpoint(ctx context.Context, logger *slog.Logger) {
	if err := checkpointAll(ctx); err != nil {
		logger.Warn("关闭终检 checkpoint 失败", "err", err)
	}
}
