// Package realtime 是 gRPC edge 流服务(ourchat.edge.v1.Realtime/Stream)。
// 承接 gateway 上行帧(UplinkFrame→业务→ack)与断连通知(ConnClosed),语义对齐 server/src/realtime/edgeGrpc.ts。
package realtime

import (
	"context"
	"log/slog"
	"net"

	"google.golang.org/grpc"
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
}

// StartEdge 启动 gRPC 流服务(仅内网)。失败(端口占用等)返回 error 由调用方决定退出。
func StartEdge(cfg *config.Config, logger *slog.Logger) (*EdgeServer, error) {
	lis, err := net.Listen("tcp", cfg.EdgeGrpcAddr)
	if err != nil {
		return nil, err
	}
	s := &EdgeServer{cfg: cfg, logger: logger}
	srv := grpc.NewServer()
	s.grpc = srv
	edgev1.RegisterRealtimeServer(srv, s)
	go func() {
		if err := srv.Serve(lis); err != nil {
			logger.Error("gRPC 流服务异常退出", "err", err)
		}
	}()
	logger.Info("gRPC 流服务已启动", "addr", cfg.EdgeGrpcAddr)
	return s, nil
}

// GracefulStop 优雅停止 gRPC 服务。
func (s *EdgeServer) GracefulStop() {
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
