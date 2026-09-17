package api

import (
	"log/slog"
	"net/http"
	"regexp"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/service"
)

// mountSyncRoutes 挂载 /user 面的同步与已读路由(sync.ts 全部端点)。
func mountSyncRoutes(r *gin.Engine) {
	g := r.Group("/user")
	g.GET("/sync", AuthenticateToken(), handleSync)
	g.POST("/read", AuthenticateToken(), handleRead)
	g.GET("/mentions", AuthenticateToken(), handleMentions)
	g.GET("/readCount", AuthenticateToken(), handleReadCount)
}

const (
	syncMaxLimit     = 200
	syncDefaultLimit = 50
)

var uintRe = regexp.MustCompile(`^\d+$`)

// zodIssue 近似 zod error.issues 条目(对比测试报告注明口径差异)。
type zodIssue struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Path    []any  `json:"path"`
}

func invalidParams(c *gin.Context, issues []zodIssue) {
	c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "参数非法", "issues": issues})
}

// handleSync 增量补拉(sync.ts:19-48):seq > since 升序分页 + per-device 位点记录。
func handleSync(c *gin.Context) {
	conv := c.Query("conv")
	since := c.Query("since")
	limit := c.Query("limit")
	device := c.Query("device")

	// zod 契约校验(syncQuery):conv 1-100;since 非负整数;limit 数字;device ≤64
	if conv == "" || len(conv) > 100 {
		invalidParams(c, []zodIssue{{Code: "too_small", Message: "conv 非法", Path: []any{"conv"}}})
		return
	}
	if since == "" {
		since = "0"
	}
	if !uintRe.MatchString(since) {
		invalidParams(c, []zodIssue{{Code: "invalid_string", Message: "since 必须为非负整数", Path: []any{"since"}}})
		return
	}
	if limit != "" && !uintRe.MatchString(limit) {
		invalidParams(c, []zodIssue{{Code: "invalid_string", Message: "limit 必须为数字", Path: []any{"limit"}}})
		return
	}
	if device != "" && len(device) > 64 {
		invalidParams(c, []zodIssue{{Code: "too_big", Message: "device 过长", Path: []any{"device"}}})
		return
	}

	user := CurrentUser(c)
	ctx := c.Request.Context()

	ok, err := service.IsConversationMember(ctx, user.ID, conv)
	if err != nil {
		serverError(c)
		return
	}
	if !ok {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权拉取该会话"})
		return
	}

	take := syncDefaultLimit
	if limit != "" {
		if n, err := strconv.Atoi(limit); err == nil && n > 0 {
			take = n
		}
	}
	if take > syncMaxLimit {
		take = syncMaxLimit
	}

	sinceSeq, _ := strconv.ParseInt(since, 10, 64)
	messages, err := queryMessages(c,
		"WHERE conversation_id = $1 AND seq > $2 AND is_deleted = false ORDER BY seq ASC LIMIT $3",
		conv, sinceSeq, take)
	if err != nil {
		serverError(c)
		return
	}

	// per-device synced 位点(辅助状态,失败不影响响应,sync.ts:40-45)
	if device != "" {
		maxSeq := sinceSeq
		if len(messages) > 0 {
			maxSeq = messages[len(messages)-1].Seq
		}
		if err := service.RecordDeviceSync(ctx, user.ID, device, conv, maxSeq); err != nil {
			slog.Default().Warn("记录 device sync 失败", "err", err)
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    gin.H{"messages": messages, "hasMore": len(messages) == take},
	})
}

// handleRead 已读上报(sync.ts:51-65):单调推进 lastReadSeq。
func handleRead(c *gin.Context) {
	var body struct {
		ConversationID string `json:"conversationId"`
		UptoSeq        any    `json:"uptoSeq"`
	}
	_ = c.ShouldBindJSON(&body)

	if body.ConversationID == "" || len(body.ConversationID) > 100 {
		invalidParams(c, []zodIssue{{Code: "too_small", Message: "conversationId 非法", Path: []any{"conversationId"}}})
		return
	}
	upto, ok := parseNonneg(body.UptoSeq)
	if !ok {
		invalidParams(c, []zodIssue{{Code: "invalid_type", Message: "uptoSeq 必须为非负整数", Path: []any{"uptoSeq"}}})
		return
	}

	user := CurrentUser(c)
	ctx := c.Request.Context()
	member, err := service.IsConversationMember(ctx, user.ID, body.ConversationID)
	if err != nil {
		serverError(c)
		return
	}
	if !member {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权操作该会话"})
		return
	}

	advanced, err := service.AdvanceLastRead(ctx, user.ID, body.ConversationID, upto)
	if err != nil {
		serverError(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"advanced": advanced}})
}

// handleMentions @我列表(sync.ts:69-73)。
func handleMentions(c *gin.Context) {
	user := CurrentUser(c)
	list, err := service.ListMentions(c.Request.Context(), user.ID)
	if err != nil {
		serverError(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// handleReadCount 群已读人数(sync.ts:77-89)。
func handleReadCount(c *gin.Context) {
	conv := c.Query("conv")
	seqRaw := c.Query("seq")
	if conv == "" || !uintRe.MatchString(seqRaw) {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "参数非法"})
		return
	}
	user := CurrentUser(c)
	ctx := c.Request.Context()
	member, err := service.IsConversationMember(ctx, user.ID, conv)
	if err != nil {
		serverError(c)
		return
	}
	if !member {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权查看该会话"})
		return
	}
	seq, _ := strconv.ParseInt(seqRaw, 10, 64)
	readCount, total, err := service.CountReadMembers(ctx, conv, seq)
	if err != nil {
		serverError(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"readCount": readCount, "total": total}})
}

// parseNonneg 解析非负整数(zod union string regex / number int nonnegative 的等价)。
func parseNonneg(v any) (int64, bool) {
	switch t := v.(type) {
	case float64:
		if t >= 0 && t == float64(int64(t)) {
			return int64(t), true
		}
		return 0, false
	case string:
		if uintRe.MatchString(t) {
			n, err := strconv.ParseInt(t, 10, 64)
			return n, err == nil
		}
		return 0, false
	default:
		return 0, false
	}
}
