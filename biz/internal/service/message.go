package service

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"

	"github.com/our-chat/biz/internal/store"
)

// message.go:落库 + 发号 + 幂等去重(语义对齐 server/src/services/message.ts)。

// Message 消息主体(Prisma Message 对齐;BigInt→int64 JSON 输出 number,JSONB 原样透传)。
type Message struct {
	ID             int64           `json:"id"`
	ConversationID string          `json:"conversationId"`
	SenderID       int64           `json:"senderId"`
	Seq            int64           `json:"seq"`
	ClientMsgID    *string         `json:"clientMsgId"`
	Content        string          `json:"content"`
	Type           string          `json:"type"`
	Status         string          `json:"status"`
	Mentions       json.RawMessage `json:"mentions"`
	IsEdited       bool            `json:"isEdited"`
	IsDeleted      bool            `json:"isDeleted"`
	Extra          json.RawMessage `json:"extra"`
	FileInfo       json.RawMessage `json:"fileInfo"`
	EditHistory    json.RawMessage `json:"editHistory"`
	Timestamp      JSONTime        `json:"timestamp"`
	CreatedAt      JSONTime        `json:"createdAt"`
	UpdatedAt      JSONTime        `json:"updatedAt"`
}

// PersistMessageInput 落库入参(message.ts:5-16)。
type PersistMessageInput struct {
	ConversationID string
	SenderID       int64
	ClientMsgID    string
	Content        string
	Type           string
	Mentions       json.RawMessage // nil → '[]'
	Extra          json.RawMessage // nil → '{}'
	FileInfo       json.RawMessage // nil → '{}'
	ParticipantIDs []int64
}

// PersistMessageResult 落库结果(message.ts:18-22;Deduped=true 表示幂等命中未新写入)。
type PersistMessageResult struct {
	Message *Message
	Deduped bool
}

var digitRe = regexp.MustCompile(`^\d+$`)

// ucKey 关系行缓存键。
func ucKey(uid int64, convID string) string {
	return strconv.FormatInt(uid, 10) + ":" + convID
}

// convExistsCache / ucExistsCache:进程内「已确认存在」缓存(会话与关系行均无删除路径,
// 创建一次后恒存在;多副本下 INSERT ... ON CONFLICT DO NOTHING 幂等,缓存仅省写库往返)。
var (
	convExistsCache sync.Map // convID -> struct{}
	ucExistsCache   sync.Map // "userId:convID" -> struct{}
)

// ensureConversation 会话兜底创建(首条消息触发;缓存命中跳过写入,message.ts:35-39 语义不变)。
func ensureConversation(ctx context.Context, convID string) error {
	if _, ok := convExistsCache.Load(convID); ok {
		return nil
	}
	convType := "single"
	if strings.HasPrefix(convID, "group_") {
		convType = "group"
	}
	if _, err := store.PG().Exec(ctx,
		"INSERT INTO conversations (id, conv_type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
		convID, convType); err != nil {
		return err
	}
	convExistsCache.Store(convID, struct{}{})
	return nil
}

// PersistMessage 落库 + 发号 + 幂等去重。
// 语义对齐 message.ts:28-92:
//  1. 会话不存在则建(ON CONFLICT DO NOTHING,原子去重);
//  2. seq = Redis INCR(见 seq.go;Redis 故障降级 DB 行锁);
//  3. INSERT message 撞 uniq_msg_idem → 取首次结果返回(deduped=true,不重复扇出);
//  4. 确保参与者 user_conversations 行存在(ON CONFLICT DO NOTHING)。
func PersistMessage(ctx context.Context, input PersistMessageInput) (*PersistMessageResult, error) {
	// 1. 会话兜底创建(消息先到也能建会话;convType 按前缀推断,message.ts:35-39)
	if err := ensureConversation(ctx, input.ConversationID); err != nil {
		return nil, err
	}

	// 2. 幂等缓存前置:命中 → 查库返回首次结果(不 INCR,避免跳号)
	if hit, err := CheckIdempotency(ctx, input.ConversationID, input.SenderID, input.ClientMsgID); err == nil && hit {
		if m := findByIdemKey(ctx, input.ConversationID, input.SenderID, input.ClientMsgID); m != nil {
			return &PersistMessageResult{Message: m, Deduped: true}, nil
		}
		// 缓存残留但库中无行(极少见:缓存 TTL 内被清理):穿透继续走正常路径
	}

	// 3. 发号(Redis INCR,降级 DB 行锁)
	seq, err := NextSeq(ctx, input.ConversationID)
	if err != nil {
		return nil, err
	}

	mentions, extra, fileInfo := normalizeJSON(input.Mentions, "[]"), normalizeJSON(input.Extra, "{}"), normalizeJSON(input.FileInfo, "{}")
	msgType := input.Type
	if msgType == "" {
		msgType = "text"
	}

	// 4. 事务:INSERT message + 参与者关系行(撞唯一约束 → 查已有返回 deduped)
	tx, err := store.PG().Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var m Message
	err = tx.QueryRow(ctx, `
		INSERT INTO messages
			(conversation_id, sender_id, seq, client_msg_id, content, type, status, mentions, extra, file_info)
		VALUES ($1, $2, $3, $4, $5, $6, 'sent', $7, $8, $9)
		ON CONFLICT (conversation_id, sender_id, client_msg_id) DO NOTHING
		RETURNING id, conversation_id, sender_id, seq, client_msg_id, content, type, status,
			mentions, is_edited, is_deleted, extra, file_info, edit_history, timestamp, created_at, updated_at`,
		input.ConversationID, input.SenderID, seq, input.ClientMsgID, input.Content, msgType,
		mentions, extra, fileInfo,
	).Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.Seq, &m.ClientMsgID, &m.Content, &m.Type,
		&m.Status, &m.Mentions, &m.IsEdited, &m.IsDeleted, &m.Extra, &m.FileInfo, &m.EditHistory,
		&m.Timestamp.Time, &m.CreatedAt.Time, &m.UpdatedAt.Time)

	if errors.Is(err, pgx.ErrNoRows) {
		// 撞唯一约束:重发命中幂等键,取首次结果返回(message.ts:80-89)
		tx.Rollback(ctx) //nolint:errcheck
		MarkIdempotent(ctx, input.ConversationID, input.SenderID, input.ClientMsgID)
		existed := findByIdemKey(ctx, input.ConversationID, input.SenderID, input.ClientMsgID)
		if existed != nil {
			return &PersistMessageResult{Message: existed, Deduped: true}, nil
		}
		return nil, errUnexpectedIdemMiss
	}
	if err != nil {
		tx.Rollback(ctx) //nolint:errcheck
		return nil, err
	}

	// 参与者关系行(message.ts:66-72,createMany skipDuplicates 语义);
	// 已确认存在的关系行跳过写入(热路径减一次 ON CONFLICT)。
	var missing []int64
	for _, uid := range input.ParticipantIDs {
		if _, ok := ucExistsCache.Load(ucKey(uid, input.ConversationID)); !ok {
			missing = append(missing, uid)
		}
	}
	if len(missing) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_conversations (user_id, conversation_id)
			SELECT unnest($1::bigint[]), $2
			ON CONFLICT (user_id, conversation_id) DO NOTHING`,
			missing, input.ConversationID); err != nil {
			tx.Rollback(ctx) //nolint:errcheck
			return nil, err
		}
		for _, uid := range missing {
			ucExistsCache.Store(ucKey(uid, input.ConversationID), struct{}{})
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	MarkIdempotent(ctx, input.ConversationID, input.SenderID, input.ClientMsgID)
	return &PersistMessageResult{Message: &m, Deduped: false}, nil
}

var errUnexpectedIdemMiss = errors.New("幂等命中但首次消息缺失")

// findByIdemKey 按幂等三元组查首次落库消息。
func findByIdemKey(ctx context.Context, convID string, senderID int64, clientMsgID string) *Message {
	var m Message
	err := store.PG().QueryRow(ctx, `
		SELECT id, conversation_id, sender_id, seq, client_msg_id, content, type, status,
			mentions, is_edited, is_deleted, extra, file_info, edit_history, timestamp, created_at, updated_at
		FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
		convID, senderID, clientMsgID,
	).Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.Seq, &m.ClientMsgID, &m.Content, &m.Type,
		&m.Status, &m.Mentions, &m.IsEdited, &m.IsDeleted, &m.Extra, &m.FileInfo, &m.EditHistory,
		&m.Timestamp.Time, &m.CreatedAt.Time, &m.UpdatedAt.Time)
	if err != nil {
		return nil
	}
	return &m
}

// normalizeJSON 把空 RawMessage 归一为默认值(与 zod default 语义一致)。
func normalizeJSON(raw json.RawMessage, def string) []byte {
	if len(raw) == 0 {
		return []byte(def)
	}
	return raw
}

// GetConversationMembers 会话成员读取(message.ts:107-125):
// group_<id> → GroupMember 权威花名册;single_<u1>_<u2> → 解析双方;异常 → 仅发送者。
func GetConversationMembers(ctx context.Context, convID string, senderID int64) ([]int64, error) {
	parts := strings.Split(convID, "_")
	if parts[0] == "group" && len(parts) > 1 && digitRe.MatchString(parts[1]) {
		groupID, _ := strconv.ParseInt(parts[1], 10, 64)
		rows, err := store.RO().Query(ctx,
			"SELECT user_id FROM group_members WHERE group_id = $1", groupID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var ids []int64
		for rows.Next() {
			var uid int64
			if err := rows.Scan(&uid); err != nil {
				return nil, err
			}
			ids = append(ids, uid)
		}
		if rows.Err() != nil {
			return nil, rows.Err()
		}
		if len(ids) > 0 {
			return ids, nil
		}
		return []int64{senderID}, nil
	}
	return DeriveParticipants(convID, senderID), nil
}

// DeriveParticipants 从 single_<u1>_<u2> 解析双方(message.ts:96-105);异常仅发送者。
func DeriveParticipants(convID string, senderID int64) []int64 {
	parts := strings.Split(convID, "_")
	if parts[0] == "single" && len(parts) >= 3 {
		var ids []int64
		for _, p := range parts[1:3] {
			if digitRe.MatchString(p) {
				id, _ := strconv.ParseInt(p, 10, 64)
				ids = append(ids, id)
			}
		}
		if len(ids) == 2 {
			return ids
		}
	}
	return []int64{senderID}
}

// MarkMentions @提醒旁路(message.ts:127-140):被 @ 成员 mentionSeq 单调推到该消息 seq。
func MarkMentions(ctx context.Context, convID string, seq int64, mentionedIDs []int64) error {
	if len(mentionedIDs) == 0 {
		return nil
	}
	_, err := store.PG().Exec(ctx, `
		UPDATE user_conversations SET mention_seq = $3
		WHERE conversation_id = $1 AND user_id = ANY($2::bigint[]) AND mention_seq < $3`,
		convID, mentionedIDs, seq)
	return err
}
