package repo

import (
	"context"
	"strconv"

	"github.com/our-chat/biz/internal/db"
)

// ChatRepo 会话/消息读取与轻量写入。
type ChatRepo interface {
	UserConversations(ctx context.Context, userID string) ([]UserConversation, error)
	ConversationsByIDs(ctx context.Context, ids []string) ([]Conversation, error)
	Messages(ctx context.Context, convID string, beforeSeq int64, limit int) ([]Message, error)
	AllMessages(ctx context.Context, convID string) ([]Message, error)
	MessagesSince(ctx context.Context, convID string, sinceSeq int64, limit int) ([]Message, error)
	LastMessages(ctx context.Context, convIDs []string) ([]Message, error)
	TouchConversation(ctx context.Context, convID string) error
	AddUserConversation(ctx context.Context, userID, convID string) error
}

type chatRepo struct{}

func NewChatRepo() ChatRepo { return chatRepo{} }

func (chatRepo) UserConversations(ctx context.Context, userID string) ([]UserConversation, error) {
	rows, err := db.RO().Query(ctx, `
		SELECT id, user_id, conversation_id, last_read_message_id, last_synced_seq, last_read_seq,
			mention_seq, unread_count, is_muted, is_pinned, is_archived, joined_at, last_activity
		FROM user_conversations WHERE user_id = $1 ORDER BY last_activity DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []UserConversation{}
	for rows.Next() {
		var uc UserConversation
		if err := rows.Scan(&uc.ID, &uc.UserID, &uc.ConversationID, &uc.LastReadMsgID, &uc.LastSyncedSeq,
			&uc.LastReadSeq, &uc.MentionSeq, &uc.UnreadCount, &uc.IsMuted, &uc.IsPinned,
			&uc.IsArchived, &uc.JoinedAt.Time, &uc.LastActivity.Time); err != nil {
			return nil, err
		}
		list = append(list, uc)
	}
	return list, rows.Err()
}

func (chatRepo) ConversationsByIDs(ctx context.Context, ids []string) ([]Conversation, error) {
	rows, err := db.RO().Query(ctx, `
		SELECT id, conv_type, title, avatar, next_seq, created_at, updated_at
		FROM conversations WHERE id = ANY($1::text[]) ORDER BY updated_at DESC`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Conversation{}
	for rows.Next() {
		var cv Conversation
		if err := rows.Scan(&cv.ID, &cv.ConvType, &cv.Title, &cv.Avatar, &cv.NextSeq,
			&cv.CreatedAt.Time, &cv.UpdatedAt.Time); err != nil {
			return nil, err
		}
		list = append(list, cv)
	}
	return list, rows.Err()
}

func (chatRepo) Messages(ctx context.Context, convID string, beforeSeq int64, limit int) ([]Message, error) {
	where := "WHERE conversation_id = $1"
	args := []any{convID}
	if beforeSeq > 0 {
		where += " AND seq < $2"
		args = append(args, beforeSeq)
	}
	where += " ORDER BY seq DESC LIMIT $" + strconv.Itoa(len(args)+1)
	args = append(args, limit+1)
	return queryMessages(ctx, msgColumns, where, args...)
}

// AllMessages 全量按时间升序(兼容旧版无 limit 的拉取语义)。
func (chatRepo) AllMessages(ctx context.Context, convID string) ([]Message, error) {
	return queryMessages(ctx, msgColumns, "WHERE conversation_id = $1 ORDER BY timestamp ASC", convID)
}

// MessagesSince 增量同步:seq 大于游标、未删除、升序、限流。
func (chatRepo) MessagesSince(ctx context.Context, convID string, sinceSeq int64, limit int) ([]Message, error) {
	return queryMessages(ctx, msgColumns,
		"WHERE conversation_id = $1 AND seq > $2 AND is_deleted = false ORDER BY seq ASC LIMIT $3",
		convID, sinceSeq, limit)
}

func (chatRepo) LastMessages(ctx context.Context, convIDs []string) ([]Message, error) {
	return queryMessages(ctx, "SELECT DISTINCT ON (conversation_id) "+msgCols+" ",
		"WHERE conversation_id = ANY($1::text[]) ORDER BY conversation_id, timestamp DESC", convIDs)
}

const msgColumns = `SELECT id, conversation_id, sender_id, seq, client_msg_id, content, type, status,
			mentions, is_edited, is_deleted, extra, file_info, edit_history, timestamp, created_at, updated_at `

const msgCols = `id, conversation_id, sender_id, seq, client_msg_id, content, type, status,
			mentions, is_edited, is_deleted, extra, file_info, edit_history, timestamp, created_at, updated_at`

func queryMessages(ctx context.Context, selectSQL, where string, args ...any) ([]Message, error) {
	rows, err := db.RO().Query(ctx, selectSQL+"FROM messages "+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Message{}
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.Seq, &m.ClientMsgID, &m.Content,
			&m.Type, &m.Status, &m.Mentions, &m.IsEdited, &m.IsDeleted, &m.Extra, &m.FileInfo,
			&m.EditHistory, &m.Timestamp.Time, &m.CreatedAt.Time, &m.UpdatedAt.Time); err != nil {
			return nil, err
		}
		list = append(list, m)
	}
	return list, rows.Err()
}

func (chatRepo) TouchConversation(ctx context.Context, convID string) error {
	return Exec(ctx, `
		INSERT INTO conversations (id, conv_type, updated_at) VALUES ($1, 'single', now())
		ON CONFLICT (id) DO UPDATE SET updated_at = now()`, convID)
}

func (chatRepo) AddUserConversation(ctx context.Context, userID, convID string) error {
	return Exec(ctx, `
		INSERT INTO user_conversations (user_id, conversation_id) VALUES ($1, $2)
		ON CONFLICT (user_id, conversation_id) DO NOTHING`, userID, convID)
}
