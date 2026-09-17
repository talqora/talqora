package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/our-chat/biz/internal/store"
)

// read.go:已读/同步位点(语义对齐 server/src/services/read.ts)。

// IsConversationMember 成员校验(防越权,read.ts:4-13)。
func IsConversationMember(ctx context.Context, userID int64, convID string) (bool, error) {
	var one int64
	err := store.PG().QueryRow(ctx, `
		SELECT id FROM user_conversations WHERE user_id = $1 AND conversation_id = $2`,
		userID, convID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// AdvanceLastRead 已读单调推进:仅当上报位点更大时前移(WHERE lastReadSeq < upto,read.ts:17-27)。
func AdvanceLastRead(ctx context.Context, userID int64, convID string, uptoSeq int64) (bool, error) {
	tag, err := store.PG().Exec(ctx, `
		UPDATE user_conversations SET last_read_seq = $3
		WHERE user_id = $1 AND conversation_id = $2 AND last_read_seq < $3`,
		userID, convID, uptoSeq)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// MentionRow @提醒查询行(read.ts:31-40)。
type MentionRow struct {
	ConversationID string `json:"conversationId"`
	MentionSeq     int64  `json:"mentionSeq"`
	LastReadSeq    int64  `json:"lastReadSeq"`
}

// ListMentions 列出「有未读 @」的会话(mentionSeq > lastReadSeq,read.ts:31-40)。
func ListMentions(ctx context.Context, userID int64) ([]MentionRow, error) {
	rows, err := store.PG().Query(ctx, `
		SELECT conversation_id, mention_seq, last_read_seq
		FROM user_conversations
		WHERE user_id = $1 AND mention_seq > last_read_seq
		ORDER BY mention_seq DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MentionRow
	for rows.Next() {
		var r MentionRow
		if err := rows.Scan(&r.ConversationID, &r.MentionSeq, &r.LastReadSeq); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CountReadMembers 群已读聚合(read.ts:44-53):已读到 seq 的成员数与总成员数。
func CountReadMembers(ctx context.Context, convID string, seq int64) (readCount, total int, err error) {
	err = store.PG().QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM user_conversations WHERE conversation_id = $1 AND last_read_seq >= $2),
			(SELECT COUNT(*) FROM user_conversations WHERE conversation_id = $1)`,
		convID, seq).Scan(&readCount, &total)
	return readCount, total, err
}

// RecordDeviceSync per-device 同步位点(read.ts:57-71):ON CONFLICT GREATEST 单调推进。
func RecordDeviceSync(ctx context.Context, userID int64, deviceID, convID string, syncedSeq int64) error {
	_, err := store.PG().Exec(ctx, `
		INSERT INTO device_sync_state (user_id, device_id, conversation_id, last_synced_seq, last_heartbeat)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (user_id, device_id, conversation_id)
		DO UPDATE SET
			last_synced_seq = GREATEST(device_sync_state.last_synced_seq, EXCLUDED.last_synced_seq),
			last_heartbeat = now()`,
		userID, deviceID, convID, syncedSeq)
	return err
}
