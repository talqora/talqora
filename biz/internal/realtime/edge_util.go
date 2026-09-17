package realtime

import (
	"context"
	"errors"
	"log/slog"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	edgev1 "github.com/our-chat/biz/internal/contracts/gen/ourchat/edge/v1"
)

func statusErrorUnauthenticated() error {
	return status.Error(codes.Unauthenticated, "内部令牌校验失败")
}

func isCancelled(err error) bool {
	s, ok := status.FromError(err)
	return ok && s.Code() == codes.Canceled
}

// processFrame 处理一条上游帧并回 ack(P1~P3 阶段填充业务分支)。
func processFrame(stream edgev1.Realtime_StreamServer, frame *edgev1.EdgeFrame, s *EdgeServer) error {
	return nil
}

// checkpointAll 终检发号位点(P3 发号落地后填充)。
func checkpointAll(ctx context.Context) error {
	_ = ctx
	_ = slog.Default
	return errors.New("not implemented")
}
