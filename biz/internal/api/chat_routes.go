package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/repo"
	"github.com/our-chat/biz/internal/service"
)

// chatSvc 会话/消息用例(见 internal/service/chat.go)。
var chatSvc = service.NewChatService(repo.NewChatRepo())

// mountChatRoutes 挂载 /user 面的会话与消息路由(chat.ts 全部端点)。
func mountChatRoutes(r *gin.Engine) {
	g := r.Group("/user")
	g.GET("/userConversations", AuthenticateToken(), handleUserConversations)
	g.GET("/conversations", AuthenticateToken(), handleConversations)
	g.GET("/messages", AuthenticateToken(), handleMessages)
	g.POST("/updateConversationTime", AuthenticateToken(), handleUpdateConversationTime)
	g.GET("/lastMessages", AuthenticateToken(), handleLastMessages)
}

// 行结构定义在 repo(数据层),这里用别名引用,保持既有字段与 JSON 契约不变。
type (
	UserConversation = service.UserConversation
	Conversation     = service.Conversation
)

// handleUserConversations 会话列表(chat.ts:8-23,按 lastActivity 降序)。
func handleUserConversations(c *gin.Context) {
	userID := c.Query("userId")
	if strconvFormatInt(CurrentUser(c).ID) != userID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权访问其他用户的会话列表"})
		return
	}
	list, err := chatSvc.UserConversations(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取用户会话列表失败"})
		return
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
	rows, err := chatSvc.ConversationsByIDs(c.Request.Context(), ids)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取会话列表失败"})
		return
	}
	list := map[string]Conversation{}
	for _, cv := range rows {
		list[cv.ID] = cv
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// handleMessages 会话消息(chat.ts:49-64)。
// 向后兼容:不传 limit 时保持旧行为(全量按时间升序);
// 传 limit 时走游标分页(历史回看):返回 seq DESC 一页(≤limit 条)+ hasMore,
// 翻页游标 beforeSeq = 上一页最后一条的 seq。分页走 (conversation_id, seq DESC) 索引。
func handleMessages(c *gin.Context) {
	conversationID := c.Query("conversationId")
	if conversationID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "缺少 conversationId 参数"})
		return
	}

	limitStr := c.Query("limit")
	if limitStr == "" {
		// 旧行为:全量升序(零改动兼容)
		messages, err := chatSvc.AllMessages(c.Request.Context(), conversationID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取会话消息失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"success": true, "data": messages})
		return
	}

	limit, err := strconv.Atoi(limitStr)
	if err != nil || limit <= 0 || limit > 200 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "limit 参数非法(1~200)"})
		return
	}

	var beforeSeq *int64
	if bs := c.Query("beforeSeq"); bs != "" {
		v, perr := strconv.ParseInt(bs, 10, 64)
		if perr != nil || v <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "beforeSeq 参数非法"})
			return
		}
		beforeSeq = &v
	}

	// 多取 1 条判 hasMore 的逻辑在 repo 内(统一键集分页约定)
	before := int64(0)
	if beforeSeq != nil {
		before = *beforeSeq
	}
	out, qerr := chatSvc.Messages(c.Request.Context(), conversationID, before, limit)
	if qerr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取会话消息失败"})
		return
	}
	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": out, "hasMore": hasMore})
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
	// 会话与「我的」视图各自幂等 upsert(chat.ts:76-87 语义)
	if err := chatSvc.Touch(c.Request.Context(), body.UserID, body.ConversationID); err != nil {
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
	msgs, err := chatSvc.LastMessages(c.Request.Context(), ids)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "获取会话列表失败"})
		return
	}
	out := map[string]gin.H{}
	for _, row := range msgs {
		convID := row.ConversationID
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

// parseStringArray 解析 query 里的 JSON 字符串数组(userConversationIds)。
func parseStringArray(raw string) []string {
	var arr []string
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		return nil
	}
	return arr
}
