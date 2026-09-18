package realtime

import (
	"context"
	"encoding/json"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	edgev1 "github.com/our-chat/biz/internal/contracts/gen/ourchat/edge/v1"
	"github.com/our-chat/biz/internal/service"
)

func statusErrorUnauthenticated() error {
	return status.Error(codes.Unauthenticated, "内部令牌校验失败")
}

func isCancelled(err error) bool {
	s, ok := status.FromError(err)
	return ok && s.Code() == codes.Canceled
}

// makeAck 构造 UplinkAck(proto3 标量必填,未用字段补零值,edgeGrpc.ts:25-43)。
func makeAck(ok bool, clientMsgID string, userID int64, seq, serverMsgID int64, errMsg string, rawResponse []byte) *edgev1.EdgeFrame {
	ack := &edgev1.UplinkAck{
		Ok:           ok,
		ClientMsgId:  clientMsgID,
		UserId:       userID,
		Seq:          seq,
		ServerMsgId:  serverMsgID,
		Error:        errMsg,
		RawResponse:  rawResponse,
	}
	return &edgev1.EdgeFrame{Kind: &edgev1.EdgeFrame_Ack{Ack: ack}}
}

// extractAckMeta 从 message.ack 信封解出 seq/serverMsgId(edgeGrpc.ts:46-50)。
func extractAckMeta(body any) (seq, serverMsgID int64) {
	m, ok := body.(map[string]any)
	if !ok || m["type"] != "message.ack" {
		return 0, 0
	}
	data, ok := m["data"].(map[string]any)
	if !ok {
		return 0, 0
	}
	seq = anyToInt64(data["seq"])
	serverMsgID = anyToInt64(data["serverMsgId"])
	return seq, serverMsgID
}

func anyToInt64(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	default:
		return 0
	}
}

// processFrame 处理一条上游帧并回 ack(edgeGrpc.ts:53-105)。
// 身份来自网关注入的帧头,不信任帧内自报。
func processFrame(stream edgev1.Realtime_StreamServer, frame *edgev1.EdgeFrame, s *EdgeServer) error {
	ctx := stream.Context()
	if u := frame.GetUplink(); u != nil {
		// json.Valid 仅校验合法性,不构建 any 树(原 json.Unmarshal 每帧多一次全量解析分配,
		// 高连接密度下是纯浪费——真实解析在 HandleUplink 内进行)。
		if !json.Valid(u.RawFrame) {
			return stream.Send(makeAck(false, u.ClientMsgId, u.UserId, 0, 0, "上行帧不是合法 JSON", nil))
		}
		result := HandleUplink(ctx, u.RawFrame, UplinkContext{UserID: u.UserId, DeviceID: u.DeviceId})

		switch result.Status {
		case 204:
			// 无回投语义(read.report / call 204):仅确认收敛(edgeGrpc.ts:68-72)
			return stream.Send(makeAck(true, u.ClientMsgId, u.UserId, 0, 0, "", nil))
		case 200:
			meta, serverMsgID := extractAckMeta(result.Body)
			rawResp, _ := json.Marshal(result.Body)
			return stream.Send(makeAck(true, u.ClientMsgId, u.UserId, meta, serverMsgID, "", rawResp))
		default:
			// 4xx/5xx:错误收敛(edgeGrpc.ts:89-94)
			msg := "消息发送失败"
			if m, ok := result.Body.(map[string]any); ok {
				if s, ok := m["message"].(string); ok {
					msg = s
				}
			}
			return stream.Send(makeAck(false, u.ClientMsgId, u.UserId, 0, 0, msg, nil))
		}
	}

	if closed := frame.GetClosed(); closed != nil {
		// 断连通知:与 HTTP /internal/gateway/disconnect 等价(fire-and-forget,不回帧)
		HandleDisconnect(ctx, closed.UserId, closed.DeviceId, s.logger)
	}
	return nil
}

// checkpointAll 终检发号位点写回 PG(优雅关闭兜底)。
func checkpointAll(ctx context.Context) error {
	return service.CheckpointAll(ctx)
}
