package service

import (
	"context"
	"encoding/json"

	"github.com/our-chat/biz/internal/metrics"
)

// push.go:统一推送器(语义对齐 server/src/realtime/push.ts 的 persistAndBroadcastMessage/emitToUser)。

// ParseMentionIDs 从客户端上报的 mentions 里只保留「确实是本会话成员」的 id(push.ts:42-51)。
func ParseMentionIDs(raw json.RawMessage, participants []int64) []int64 {
	var arr []any
	if len(raw) == 0 || json.Unmarshal(raw, &arr) != nil {
		return nil
	}
	memberSet := make(map[string]bool, len(participants))
	for _, p := range participants {
		memberSet[formatInt(p)] = true
	}
	var out []int64
	for _, v := range arr {
		s := formatAny(v)
		if digitRe.MatchString(s) && memberSet[s] {
			if id, err := parseInt64(s); err == nil {
				out = append(out, id)
			}
		}
	}
	return out
}

// PersistAndBroadcastMessage 落库 + 读扩散扇出 receiveMessage(push.ts:69-105)。
// 落库成功且非去重命中时:在线成员广播 receiveMessage(带 seq);被 @ 成员额外定向推 mention。
func PersistAndBroadcastMessage(ctx context.Context, input PersistMessageInput) (*PersistMessageResult, error) {
	participants, err := GetConversationMembers(ctx, input.ConversationID, input.SenderID)
	if err != nil {
		return nil, err
	}
	input.ParticipantIDs = participants

	res, err := PersistMessage(ctx, input)
	if err != nil {
		return nil, err
	}
	if res.Deduped {
		return res, nil // 去重命中不重复广播(push.ts:75)
	}

	// 单聊直推双方(成员仅 2 人);群聊先 FilterOnline 收敛在线子集(push.ts:79-82)
	targets := map[int64]bool{}
	isGroup := len(input.ConversationID) > 0 && input.ConversationID[0] == 'g'
	if isGroup {
		online, err := FilterOnline(ctx, participants)
		if err != nil {
			return nil, err
		}
		targets = online
	} else {
		for _, p := range participants {
			targets[p] = true
		}
	}
	metrics.BroadcastRecipients.Observe(float64(len(targets)))

	targetIDs := make([]int64, 0, len(targets))
	for uid := range targets {
		targetIDs = append(targetIDs, uid)
	}
	FanoutDownlink(ctx, targetIDs, "receiveMessage", res.Message)

	// @提醒旁路(push.ts:90-102)
	mentioned := ParseMentionIDs(input.Mentions, participants)
	if len(mentioned) > 0 {
		if err := MarkMentions(ctx, input.ConversationID, res.Message.Seq, mentioned); err != nil {
			return nil, err
		}
		onlineMentioned, err := FilterOnline(ctx, mentioned)
		if err != nil {
			return nil, err
		}
		mentionIDs := make([]int64, 0, len(onlineMentioned))
		for uid := range onlineMentioned {
			mentionIDs = append(mentionIDs, uid)
		}
		FanoutDownlink(ctx, mentionIDs, "mention", map[string]any{
			"conversationId": input.ConversationID,
			"seq":            res.Message.Seq,
			"serverMsgId":    res.Message.ID,
		})
	}
	return res, nil
}

func formatInt(v int64) string { return itoa64(v) }
