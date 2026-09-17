package realtime

import (
	"context"
	"encoding/json"
	"time"

	"github.com/our-chat/biz/internal/metrics"
	"github.com/our-chat/biz/internal/service"
)

// handleUplink.go:网关上行帧共用业务处理,语义对齐 server/src/realtime/handleUplink.ts。
// HTTP 端点(/internal/gateway/uplink)与 gRPC 流服务共用同一份实现。

// UplinkContext 网关注入的身份(不信任帧内自报)。
type UplinkContext struct {
	UserID   int64
	DeviceID string
}

// UplinkResult 处理结果对齐 HTTP 语义:NoContent=不回投(仅确认);其余=回投 body。
type UplinkResult struct {
	Status int
	Body   any
}

// wsEnvelope 客户端信封 {type,data}。
type wsEnvelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// HandleUplink 处理一条网关上行帧(message.send / read.report / call:*)。见 handleUplink.ts:52-181。
func HandleUplink(ctx context.Context, raw []byte, uctx UplinkContext) UplinkResult {
	var env wsEnvelope
	if err := json.Unmarshal(raw, &env); err != nil || env.Type == "" {
		return UplinkResult{Status: 400, Body: map[string]any{"type": "message.error", "message": "缺少帧类型 type"}}
	}

	switch {
	case env.Type == "message.send":
		return handleMessageSend(ctx, env.Data, raw, uctx)
	case env.Type == "read.report":
		return handleReadReport(ctx, env.Data, uctx)
	case len(env.Type) > 5 && env.Type[:5] == "call:":
		return HandleCallEvent(ctx, env.Type, uctx, env.Data)
	default:
		return UplinkResult{Status: 400, Body: map[string]any{"type": "message.error", "message": "不支持的上行类型: " + env.Type}}
	}
}

// ---- message.send(handleUplink.ts:60-137) ----

// sendMessageInput 上行发消息入参(contracts/message.ts 的 sendMessageInput 等价)。
type sendMessageInput struct {
	ClientMsgID    string          `json:"clientMsgId"`
	ConversationID string          `json:"conversationId"`
	SenderID       json.RawMessage `json:"senderId"` // 仅前端回显,忽略
	Content        string          `json:"content"`
	Type           string          `json:"type"`
	Mentions       json.RawMessage `json:"mentions"`
	Extra          json.RawMessage `json:"extra"`
	FileInfo       json.RawMessage `json:"fileInfo"`
}

// parseSendMessage 校验入参(默认值对齐 zod default 语义)。
func parseSendMessage(payload json.RawMessage) (sendMessageInput, bool) {
	var in sendMessageInput
	if err := json.Unmarshal(payload, &in); err != nil {
		return in, false
	}
	if in.ClientMsgID == "" || len(in.ClientMsgID) > 64 {
		return in, false
	}
	if in.ConversationID == "" || len(in.ConversationID) > 100 {
		return in, false
	}
	if in.Type == "" {
		in.Type = "text"
	}
	if len(in.Type) > 32 {
		return in, false
	}
	return in, true
}

func handleMessageSend(ctx context.Context, data json.RawMessage, raw []byte, uctx UplinkContext) UplinkResult {
	// 兼容两种上行帧形态:①{type,data} 推荐;②直接整帧即消息载荷(早期 PoC,handleUplink.ts:61-64)
	payload := data
	if len(payload) == 0 {
		payload = raw
	}
	in, ok := parseSendMessage(payload)
	if !ok {
		// 错误回投带 clientMsgId(handleUplink.ts:66-75)
		var cmid struct {
			ClientMsgID string `json:"clientMsgId"`
		}
		_ = json.Unmarshal(raw, &cmid)
		_ = json.Unmarshal(data, &cmid)
		return UplinkResult{Status: 400, Body: map[string]any{
			"type": "message.error", "message": "消息参数非法",
			"data": map[string]any{"clientMsgId": cmid.ClientMsgID},
		}}
	}

	metrics.MessageInTotal.Inc()
	start := time.Now()
	defer func() {
		metrics.MessageDuration.Observe(time.Since(start).Seconds())
	}()

	senderID := uctx.UserID
	participants, err := service.GetConversationMembers(ctx, in.ConversationID, senderID)
	if err != nil {
		metrics.MessageOutTotal.WithLabelValues("error").Inc()
		return UplinkResult{Status: 500, Body: map[string]any{
			"type": "message.error", "data": map[string]any{"message": "消息发送失败", "clientMsgId": in.ClientMsgID},
		}}
	}

	res, err := service.PersistMessage(ctx, service.PersistMessageInput{
		ConversationID: in.ConversationID,
		SenderID:       senderID,
		ClientMsgID:    in.ClientMsgID,
		Content:        in.Content,
		Type:           in.Type,
		Mentions:       in.Mentions,
		Extra:          in.Extra,
		FileInfo:       in.FileInfo,
		ParticipantIDs: participants,
	})
	if err != nil {
		metrics.MessageOutTotal.WithLabelValues("error").Inc()
		return UplinkResult{Status: 500, Body: map[string]any{
			"type": "message.error", "data": map[string]any{"message": "消息发送失败", "clientMsgId": in.ClientMsgID},
		}}
	}
	metrics.MessageOutTotal.WithLabelValues("ok").Inc()

	// 去重命中不重复扇出(handleUplink.ts:94-117)
	if !res.Deduped {
		isGroup := len(in.ConversationID) > 0 && in.ConversationID[0] == 'g'
		targets := map[int64]bool{}
		if isGroup {
			online, ferr := service.FilterOnline(ctx, participants)
			if ferr != nil {
				metrics.MessageOutTotal.WithLabelValues("error").Inc()
				return UplinkResult{Status: 500, Body: map[string]any{
					"type": "message.error", "data": map[string]any{"message": "消息发送失败", "clientMsgId": in.ClientMsgID},
				}}
			}
			targets = online
		} else {
			for _, p := range participants {
				targets[p] = true
			}
		}
		targetIDs := make([]int64, 0, len(targets))
		for uid := range targets {
			targetIDs = append(targetIDs, uid)
		}
		service.FanoutDownlink(ctx, targetIDs, "receiveMessage", res.Message)

		mentioned := service.ParseMentionIDs(in.Mentions, participants)
		if len(mentioned) > 0 {
			if err := service.MarkMentions(ctx, in.ConversationID, res.Message.Seq, mentioned); err != nil {
				logWarn("markMentions 失败", err)
			}
			onlineMentioned, _ := service.FilterOnline(ctx, mentioned)
			mentionIDs := make([]int64, 0, len(onlineMentioned))
			for uid := range onlineMentioned {
				mentionIDs = append(mentionIDs, uid)
			}
			service.FanoutDownlink(ctx, mentionIDs, "mention", map[string]any{
				"conversationId": in.ConversationID,
				"seq":            res.Message.Seq,
				"serverMsgId":    res.Message.ID,
			})
		}
	}

	return UplinkResult{Status: 200, Body: map[string]any{
		"type": "message.ack",
		"data": map[string]any{
			"clientMsgId": in.ClientMsgID,
			"seq":         res.Message.Seq,
			"serverMsgId": res.Message.ID,
		},
	}}
}

// ---- read.report(handleUplink.ts:140-163) ----

func handleReadReport(ctx context.Context, data json.RawMessage, uctx UplinkContext) UplinkResult {
	var in struct {
		ConversationID string `json:"conversationId"`
		UptoSeq        any    `json:"uptoSeq"`
	}
	if err := json.Unmarshal(data, &in); err != nil {
		return UplinkResult{Status: 400, Body: map[string]any{"type": "message.error", "message": "已读上报参数非法"}}
	}
	if in.ConversationID == "" || len(in.ConversationID) > 100 {
		return UplinkResult{Status: 400, Body: map[string]any{"type": "message.error", "message": "已读上报参数非法"}}
	}
	upto, ok := parseNonnegAny(in.UptoSeq)
	if !ok {
		return UplinkResult{Status: 400, Body: map[string]any{"type": "message.error", "message": "已读上报参数非法"}}
	}

	member, err := service.IsConversationMember(ctx, uctx.UserID, in.ConversationID)
	if err != nil {
		return UplinkResult{Status: 500, Body: map[string]any{"type": "message.error", "message": "已读上报失败"}}
	}
	if !member {
		return UplinkResult{Status: 403, Body: map[string]any{"type": "message.error", "message": "无权操作该会话"}}
	}

	advanced, err := service.AdvanceLastRead(ctx, uctx.UserID, in.ConversationID, upto)
	if err != nil {
		return UplinkResult{Status: 500, Body: map[string]any{"type": "message.error", "message": "已读上报失败"}}
	}
	// 单调未推进时无需扰动其它端(handleUplink.ts:152-157)
	if advanced {
		if err := service.PublishDownlink(ctx, uctx.UserID, "read.sync",
			map[string]any{"conversationId": in.ConversationID, "uptoSeq": upto},
			&service.DownlinkOpts{ExceptDeviceID: uctx.DeviceID}); err != nil {
			logDownlinkWarn(err)
		}
	}
	return UplinkResult{Status: 204}
}
