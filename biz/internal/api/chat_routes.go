package api

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/service"
	"github.com/our-chat/biz/internal/store"
)

// mountChatRoutes 挂载 /user 面的会话与消息路由(chat.ts 全部端点)。
func mountChatRoutes(r *gin.Engine) {
	g := r.Group("/user")
	g.GET("/userConversations", AuthenticateToken(), handleUserConversations)
	g.GET("/conversations", AuthenticateToken(), handleConversations)
	g.GET("/messages", AuthenticateToken(), handleMessages)
	g.POST("/updateConversationTime", AuthenticateToken(), handleUpdateConversationTime)
	g.GET("/lastMessages", AuthenticateToken(), handleLastMessages)
}

// UserConversation 会话关系行(Prisma camelCase;BigInt→number)。
type UserConversation struct {
	ID               int64   `json:"id"`
	UserID           int64   `json:"userId"`
	ConversationID   string  `json:"conversationId"`
	LastReadMsgID    *string `json:"lastReadMessageId"`
	LastSyncedSeq    int64   `json:"lastSyncedSeq"`
	LastReadSeq      int64   `json:"lastReadSeq"`
	MentionSeq       int64   `json:"mentionSeq"`
	UnreadCount      int     `json:"unreadCount"`
	IsMuted          bool    `json:"isMuted"`
	IsPinned         bool    `json:"isPinned"`
	IsArchived       bool    `json:"isArchived"`
	JoinedAt         service.JSONTime `json:"joinedAt"`
	LastActivity     service.JSONTime `json:"lastActivity"`
}

// Conversation 会话行(Prisma camelCase)。
type Conversation struct {
	ID        string           `json:"id"`
	ConvType  string           `json:"convType"`
	Title     *string          `json:"title"`
	Avatar    *string          `json:"avatar"`
	NextSeq   int64            `json:"nextSeq"`
	CreatedAt service.JSONTime `json:"createdAt"`
	UpdatedAt service.JSONTime `json:"updatedAt"`
}

// handleUserConversations 会话列表(chat.ts:8-23,按 lastActivity 降序)。
func handleUserConversations(c *gin.Context) {
	userID := c.Query("userId")
	if strconvFormatInt(CurrentUser(c).ID) != userID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权访问其他用户的会话列表"})
		return
	}
	rows, err := store.PG().Query(c.Request.Context(), `
		SELECT id, user_id, conversation_id, last_read_message_id, last_synced_seq, last_read_seq,
			mention_seq, unread_count, is_muted, is_pinned, is_archived, joined_at, last_activity
		FROM user_conversations WHERE user_id = $1 ORDER BY last_activity DESC`, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取用户会话列表失败"})
		return
	}
	defer rows.Close()
	list := []UserConversation{}
	for rows.Next() {
		var uc UserConversation
		if err := rows.Scan(&uc.ID, &uc.UserID, &uc.ConversationID, &uc.LastReadMsgID, &uc.LastSyncedSeq,
			&uc.LastReadSeq, &uc.MentionSeq, &uc.UnreadCount, &uc.IsMuted, &uc.IsPinned,
			&uc.IsArchived, &uc.JoinedAt.Time, &uc.LastActivity.Time); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取用户会话列表失败"})
			return
		}
		list = append(list, uc)
	}
	if list == nil {
		list = []UserConversation{}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// handleConversations 按 ID 集合取会话(chat.ts:26-46,空集合返回 {})。
func handleConversations(c *gin.Context) {
	ids := parseStringArray(c.Query("userConversationIds"))
	if len(ids) == 0 {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{}})
		return
	}
	rows, err := store.PG().Query(c.Request.Context(), `
		SELECT id, conv_type, title, avatar, next_seq, created_at, updated_at
		FROM conversations WHERE id = ANY($1::text[]) ORDER BY updated_at DESC`, ids)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取会话列表失败"})
		return
	}
	defer rows.Close()
	list := map[string]Conversation{}
	for rows.Next() {
		var cv Conversation
		if err := rows.Scan(&cv.ID, &cv.ConvType, &cv.Title, &cv.Avatar, &cv.NextSeq,
			&cv.CreatedAt.Time, &cv.UpdatedAt.Time); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取会话列表失败"})
			return
		}
		list[cv.ID] = cv
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// handleMessages 会话全部消息按时间升序(chat.ts:49-64)。
func handleMessages(c *gin.Context) {
	conversationID := c.Query("conversationId")
	if conversationID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "缺少 conversationId 参数"})
		return
	}
	messages, err := queryMessages(c, "WHERE conversation_id = $1 ORDER BY timestamp ASC", conversationID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取会话消息失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": messages})
}

// handleUpdateConversationTime 会话/关系行双幂等 upsert(chat.ts:67-93)。
func handleUpdateConversationTime(c *gin.Context) {
	var body struct {
		ConversationID string `json:"conversationId"`
		UserID         string `json:"userId"`
	}
	_ = c.ShouldBindJSON(&body)
	if strconvFormatInt(CurrentUser(c).ID) != body.UserID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权更新其他用户的会话"})
		return
	}
	ctx := c.Request.Context()
	// 会话与「我的」视图各自幂等 upsert(chat.ts:76-87 注释语义)
	if _, err := store.PG().Exec(ctx, `
		INSERT INTO conversations (id, conv_type, updated_at) VALUES ($1, 'single', now())
		ON CONFLICT (id) DO UPDATE SET updated_at = now()`, body.ConversationID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "更新会话时间失败"})
		return
	}
	if _, err := store.PG().Exec(ctx, `
		INSERT INTO user_conversations (user_id, conversation_id) VALUES ($1, $2)
		ON CONFLICT (user_id, conversation_id) DO NOTHING`, body.UserID, body.ConversationID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "更新会话时间失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// handleLastMessages 每个会话最后一条消息(DISTINCT ON,chat.ts:99-115)。
// 注意:此端点输出 snake_case 列名($queryRaw 原始行形态,web 前端依赖)。
func handleLastMessages(c *gin.Context) {
	ids := parseStringArray(c.Query("userConversationIds"))
	if len(ids) == 0 {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{}})
		return
	}
	rows, err := store.PG().Query(c.Request.Context(), `
		SELECT DISTINCT ON (conversation_id) conversation_id, id, sender_id, seq, client_msg_id,
			content, type, status, mentions, is_edited, is_deleted, extra, file_info, edit_history,
			timestamp, created_at, updated_at
		FROM messages
		WHERE conversation_id = ANY($1::text[])
		ORDER BY conversation_id, timestamp DESC`, ids)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取会话列表失败"})
		return
	}
	defer rows.Close()
	out := map[string]gin.H{}
	for rows.Next() {
		var convID string
		var row snakeMessage
		if err := rows.Scan(&convID, &row.ID, &row.SenderID, &row.Seq, &row.ClientMsgID,
			&row.Content, &row.Type, &row.Status, &row.Mentions, &row.IsEdited, &row.IsDeleted,
			&row.Extra, &row.FileInfo, &row.EditHistory, &row.Timestamp.Time,
			&row.CreatedAt.Time, &row.UpdatedAt.Time); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取会话列表失败"})
			return
		}
		out[convID] = gin.H{
			"conversation_id": convID,
			"id":              row.ID,
			"sender_id":       row.SenderID,
			"seq":             row.Seq,
			"client_msg_id":   row.ClientMsgID,
			"content":         row.Content,
			"type":            row.Type,
			"status":          row.Status,
			"mentions":        row.Mentions,
			"is_edited":       row.IsEdited,
			"is_deleted":      row.IsDeleted,
			"extra":           row.Extra,
			"file_info":       row.FileInfo,
			"edit_history":    row.EditHistory,
			"timestamp":       row.Timestamp,
			"created_at":      row.CreatedAt,
			"updated_at":      row.UpdatedAt,
		}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": out})
}

// snakeMessage $queryRaw 原始行(snake_case 列)。
type snakeMessage struct {
	ID          int64
	SenderID    int64
	Seq         int64
	ClientMsgID *string
	Content     string
	Type        string
	Status      string
	Mentions    json.RawMessage
	IsEdited    bool
	IsDeleted   bool
	Extra       json.RawMessage
	FileInfo    json.RawMessage
	EditHistory json.RawMessage
	Timestamp   service.JSONTime
	CreatedAt   service.JSONTime
	UpdatedAt   service.JSONTime
}

// queryMessages 通用消息查询(输出 service.Message 列表,空列表转 [] 对齐 Prisma findMany)。
func queryMessages(c *gin.Context, where string, args ...any) ([]service.Message, error) {
	rows, err := store.PG().Query(c.Request.Context(),
		`SELECT id, conversation_id, sender_id, seq, client_msg_id, content, type, status,
			mentions, is_edited, is_deleted, extra, file_info, edit_history, timestamp, created_at, updated_at
		FROM messages `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []service.Message
	for rows.Next() {
		var m service.Message
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.Seq, &m.ClientMsgID, &m.Content,
			&m.Type, &m.Status, &m.Mentions, &m.IsEdited, &m.IsDeleted, &m.Extra, &m.FileInfo,
			&m.EditHistory, &m.Timestamp.Time, &m.CreatedAt.Time, &m.UpdatedAt.Time); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if out == nil {
		out = []service.Message{}
	}
	return out, rows.Err()
}

// parseStringArray 解析 query 里的 JSON 字符串数组(userConversationIds)。
func parseStringArray(raw string) []string {
	var arr []string
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		return nil
	}
	return arr
}
