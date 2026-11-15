package repo

import "encoding/json"

// Message 消息行(对外契约 camelCase;定义在数据层,service 以别名复用)。
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

// UserConversation 会话关系行(BigInt→int64)。
type UserConversation struct {
	ID             int64    `json:"id"`
	UserID         int64    `json:"userId"`
	ConversationID string   `json:"conversationId"`
	LastReadMsgID  *string  `json:"lastReadMessageId"`
	LastSyncedSeq  int64    `json:"lastSyncedSeq"`
	LastReadSeq    int64    `json:"lastReadSeq"`
	MentionSeq     int64    `json:"mentionSeq"`
	UnreadCount    int      `json:"unreadCount"`
	IsMuted        bool     `json:"isMuted"`
	IsPinned       bool     `json:"isPinned"`
	IsArchived     bool     `json:"isArchived"`
	JoinedAt       JSONTime `json:"joinedAt"`
	LastActivity   JSONTime `json:"lastActivity"`
}

// Conversation 会话行。
type Conversation struct {
	ID        string   `json:"id"`
	ConvType  string   `json:"convType"`
	Title     *string  `json:"title"`
	Avatar    *string  `json:"avatar"`
	NextSeq   int64    `json:"nextSeq"`
	CreatedAt JSONTime `json:"createdAt"`
	UpdatedAt JSONTime `json:"updatedAt"`
}
