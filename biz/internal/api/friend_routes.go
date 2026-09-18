package api

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/service"
	"github.com/our-chat/biz/internal/store"
)

// mountFriendRoutes 挂载 /user 面的好友路由(friend.ts 全部端点)。
func mountFriendRoutes(r *gin.Engine) {
	g := r.Group("/user")
	g.GET("/getFriendList/:id", AuthenticateToken(), handleGetFriendList)
	g.GET("/searchUser", AuthenticateToken(), handleSearchUser)
	g.PUT("/addFriend", AuthenticateToken(), handleAddFriend)
	g.PUT("/updateRemark", AuthenticateToken(), handleUpdateRemark)
	g.GET("/getFriendReqs", AuthenticateToken(), handleGetFriendReqs)
	g.PUT("/replyFriendReq", AuthenticateToken(), handleReplyFriendReq)
}

// handleGetFriendList 好友列表(friend.ts:10-50)。注意:错误路径无显式状态码 → 200。
func handleGetFriendList(c *gin.Context) {
	id := c.Param("id")
	if strconvFormatInt(CurrentUser(c).ID) != id {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权访问其他用户的好友列表"})
		return
	}
	ctx := c.Request.Context()
	rows, err := store.RO().Query(ctx,
		"SELECT friend_id, remark FROM friendships WHERE user_id = $1", id)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "获取好友列表失败"})
		return
	}
	defer rows.Close()
	var friendIDs []int64
	remarks := map[string]*string{}
	for rows.Next() {
		var fid int64
		var remark *string
		if err := rows.Scan(&fid, &remark); err != nil {
			c.JSON(http.StatusOK, gin.H{"success": false, "message": "获取好友列表失败"})
			return
		}
		friendIDs = append(friendIDs, fid)
		remarks[strconv.FormatInt(fid, 10)] = remark
	}
	if rows.Err() != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "获取好友列表失败"})
		return
	}

	friendList := gin.H{"friendId": gin.H{}, "friendInfo": gin.H{}}
	if len(friendIDs) > 0 {
		urows, err := store.RO().Query(ctx,
			"SELECT id, username, avatar, gender FROM users WHERE id = ANY($1::bigint[])", friendIDs)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"success": false, "message": "获取好友列表失败"})
			return
		}
		defer urows.Close()
		friendIDMap := map[string]*string{}
		infoMap := map[string]gin.H{}
		for _, fid := range friendIDs {
			friendIDMap[strconv.FormatInt(fid, 10)] = remarks[strconv.FormatInt(fid, 10)]
		}
		for urows.Next() {
			var uid int64
			var username string
			var avatar, gender *string
			if err := urows.Scan(&uid, &username, &avatar, &gender); err != nil {
				c.JSON(http.StatusOK, gin.H{"success": false, "message": "获取好友列表失败"})
				return
			}
			infoMap[strconv.FormatInt(uid, 10)] = gin.H{"username": username, "avatar": avatar, "gender": gender}
		}
		friendList = gin.H{"friendId": friendIDMap, "friendInfo": infoMap}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": friendList})
}

// handleSearchUser 查询用户(friend.ts:53-94)。OR: id/phone/username 取第一条。
func handleSearchUser(c *gin.Context) {
	keyword := c.Query("keyword")
	_ = c.Query("userId") // 仅 Node 侧取(匹配后查关系);Go 侧身份以 token 为准但保留参数兼容
	ctx := c.Request.Context()

	var idKw any
	if n, err := strconv.ParseInt(keyword, 10, 64); err == nil {
		idKw = n
	}
	var (
		matchedID  int64
		matchedUsr string
		avatar, gender *string
	)
	err := store.RO().QueryRow(ctx, `
		SELECT id, username, avatar, gender FROM users
		WHERE ($1::bigint IS NOT NULL AND id = $1) OR phone = $2 OR username = $2
		LIMIT 1`, idKw, keyword,
	).Scan(&matchedID, &matchedUsr, &avatar, &gender)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "查询用户信息失败"})
		return
	}
	matched := gin.H{"id": matchedID, "avatar": avatar, "username": matchedUsr, "gender": gender}

	// 查询当前用户与目标的关系(以 token 身份为准)
	user := CurrentUser(c)
	var existingID int64
	err = store.RO().QueryRow(ctx, `
		SELECT id FROM friendships WHERE user_id = $1 AND friend_id = $2`,
		user.ID, matchedID).Scan(&existingID)
	relationExists := err == nil
	if err != nil && !isNoRows(err) {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "查询用户信息失败"})
		return
	}
	if relationExists {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": "已经是好友",
			"data":    gin.H{"exist": true, "isFriend": true, "friendInfo": matched},
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    gin.H{"exist": true, "isFriend": false, "friendInfo": matched},
	})
}

// handleAddFriend 发起好友请求(friend.ts:97-140):双向写入 + 推 receiveFriendReq。
func handleAddFriend(c *gin.Context) {
	var body struct {
		UserID   string `json:"userId"`
		FriendID string `json:"friendId"`
	}
	_ = c.ShouldBindJSON(&body)
	if strconvFormatInt(CurrentUser(c).ID) != body.UserID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权代替其他用户发起好友请求"})
		return
	}
	ctx := c.Request.Context()
	friendID, _ := strconv.ParseInt(body.FriendID, 10, 64)
	userID, _ := strconv.ParseInt(body.UserID, 10, 64)

	if _, err := store.PG().Exec(ctx, `
		INSERT INTO friendships (user_id, friend_id, status) VALUES
			($1, $2, 'sent'), ($2, $1, 'pending')`,
		userID, friendID); err != nil {
		// 撞唯一约束等:与 Node createMany 异常一致,默认 200 信封(friend.ts:136-139)
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "发起好友请求失败"})
		return
	}

	// 推好友请求给接收方(best-effort,friend.ts:110-130)
	var username string
	var avatar *string
	if err := store.RO().QueryRow(ctx,
		"SELECT username, avatar FROM users WHERE id = $1", userID).Scan(&username, &avatar); err == nil {
		now := nowISOString()
		service.EmitToUser(ctx, friendID, "receiveFriendReq", gin.H{
			"id":        0,
			"userId":    friendID,
			"friendId":  userID,
			"status":    "pending",
			"remark":    nil,
			"createdAt": now,
			"updatedAt": now,
			"username":  username,
			"avatar":    avatar,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "发起好友请求成功",
		"data":    gin.H{"isFriend": false, "friendId": friendID},
	})
}

// handleUpdateRemark 更新备注(friend.ts:143-163,显式 500)。
func handleUpdateRemark(c *gin.Context) {
	var body struct {
		UserID   string `json:"userId"`
		FriendID string `json:"friendId"`
		Remark   string `json:"remark"`
	}
	_ = c.ShouldBindJSON(&body)
	if strconvFormatInt(CurrentUser(c).ID) != body.UserID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权修改其他用户的好友备注"})
		return
	}
	var remark any
	if trimmed := trimSpace(body.Remark); trimmed != "" {
		remark = trimmed
	} else {
		remark = nil
	}
	if _, err := store.PG().Exec(c.Request.Context(), `
		UPDATE friendships SET remark = $3 WHERE user_id = $1 AND friend_id = $2`,
		body.UserID, body.FriendID, remark); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "更新好友备注失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// handleGetFriendReqs 收到的好友请求(friend.ts:166-196)。
func handleGetFriendReqs(c *gin.Context) {
	userID := c.Query("userId")
	if strconvFormatInt(CurrentUser(c).ID) != userID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权访问其他用户的好友请求"})
		return
	}
	ctx := c.Request.Context()
	rows, err := store.RO().Query(ctx, `
		SELECT id, user_id, friend_id, status, remark, created_at, updated_at
		FROM friendships WHERE user_id = $1 ORDER BY updated_at DESC`, userID)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "获取好友请求失败"})
		return
	}
	defer rows.Close()
	type rowT struct {
		ID        int64
		UserID    int64
		FriendID  int64
		Status    string
		Remark    *string
		CreatedAt service.JSONTime
		UpdatedAt service.JSONTime
	}
	var rowsList []rowT
	requesterIDs := []int64{}
	for rows.Next() {
		var r rowT
		if err := rows.Scan(&r.ID, &r.UserID, &r.FriendID, &r.Status, &r.Remark,
			&r.CreatedAt.Time, &r.UpdatedAt.Time); err != nil {
			c.JSON(http.StatusOK, gin.H{"success": false, "message": "获取好友请求失败"})
			return
		}
		rowsList = append(rowsList, r)
		requesterIDs = append(requesterIDs, r.FriendID)
	}

	requesterMap := map[string]gin.H{}
	if len(requesterIDs) > 0 {
		urows, err := store.RO().Query(ctx,
			"SELECT id, username, avatar FROM users WHERE id = ANY($1::bigint[])", requesterIDs)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"success": false, "message": "获取好友请求失败"})
			return
		}
		defer urows.Close()
		for urows.Next() {
			var uid int64
			var username string
			var avatar *string
			if err := urows.Scan(&uid, &username, &avatar); err != nil {
				c.JSON(http.StatusOK, gin.H{"success": false, "message": "获取好友请求失败"})
				return
			}
			requesterMap[strconv.FormatInt(uid, 10)] = gin.H{"username": username, "avatar": avatar}
		}
	}

	result := gin.H{}
	for _, r := range rowsList {
		key := strconv.FormatInt(r.FriendID, 10)
		u := requesterMap[key]
		var username any
		var avatar any
		if u != nil {
			username = u["username"]
			avatar = u["avatar"]
		}
		result[key] = gin.H{
			"id":        r.ID,
			"userId":    r.UserID,
			"friendId":  r.FriendID,
			"status":    r.Status,
			"remark":    r.Remark,
			"createdAt": r.CreatedAt,
			"updatedAt": r.UpdatedAt,
			"username":  username,
			"avatar":    avatar,
		}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": result})
}

// handleReplyFriendReq 回复好友请求(friend.ts:199-261)。
func handleReplyFriendReq(c *gin.Context) {
	var body struct {
		UserID   string `json:"userId"`
		FriendID string `json:"friendId"`
		Status   string `json:"status"`
	}
	_ = c.ShouldBindJSON(&body)
	user := CurrentUser(c)
	if strconvFormatInt(user.ID) != body.UserID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权代替其他用户回复好友请求"})
		return
	}
	ctx := c.Request.Context()
	userID, _ := strconv.ParseInt(body.UserID, 10, 64)
	friendID, _ := strconv.ParseInt(body.FriendID, 10, 64)

	if body.Status == "accepted" {
		convID := singleConvID(userID, friendID)
		// 会话已存在则跳过(friend.ts:207-210,P2002 忽略语义)
		if _, err := store.PG().Exec(ctx,
			"INSERT INTO conversations (id, conv_type) VALUES ($1, 'single') ON CONFLICT (id) DO NOTHING",
			convID); err != nil {
			c.JSON(http.StatusOK, gin.H{"success": false, "message": "回复好友请求失败"})
			return
		}
	}
	// 双向状态更新
	if _, err := store.PG().Exec(ctx, `
		UPDATE friendships SET status = $3 WHERE user_id = $1 AND friend_id = $2`,
		userID, friendID, body.Status); err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "回复好友请求失败"})
		return
	}
	if _, err := store.PG().Exec(ctx, `
		UPDATE friendships SET status = $3 WHERE user_id = $1 AND friend_id = $2`,
		friendID, userID, body.Status); err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "回复好友请求失败"})
		return
	}

	// 副作用(best-effort):通知双方 + 微信式自动消息(friend.ts:222-254)
	if body.Status == "accepted" {
		convID := singleConvID(userID, friendID)
		service.EmitToUser(ctx, userID, "friendListChanged", gin.H{"peerId": friendID})
		service.EmitToUser(ctx, friendID, "friendListChanged", gin.H{"peerId": userID})

		var requesterName string
		_ = store.RO().QueryRow(ctx,
			"SELECT username FROM users WHERE id = $1", friendID).Scan(&requesterName)

		if _, err := service.PersistAndBroadcastMessage(ctx, service.PersistMessageInput{
			ConversationID: convID,
			SenderID:       friendID,
			ClientMsgID:    randomUUID(),
			Content:        "我是" + requesterName,
			Type:           "text",
		}); err != nil {
			slogWarn("好友通过后自动消息失败", err)
		}
		if _, err := service.PersistAndBroadcastMessage(ctx, service.PersistMessageInput{
			ConversationID: convID,
			SenderID:       userID,
			ClientMsgID:    randomUUID(),
			Content:        "我通过了你的朋友验证请求，现在我们可以开始聊天了",
			Type:           "text",
		}); err != nil {
			slogWarn("好友通过后自动消息失败", err)
		}
	} else {
		service.EmitToUser(ctx, friendID, "friendListChanged", gin.H{"peerId": userID})
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "message": "回复好友请求成功"})
}

// singleConvID 单聊会话 id:single_<min>_<max>(friend.ts:206 同构)。
func singleConvID(a, b int64) string {
	if a > b {
		a, b = b, a
	}
	return "single_" + strconv.FormatInt(a, 10) + "_" + strconv.FormatInt(b, 10)
}

// randomUUID 生成 UUIDv4(clientMsgId 幂等键,与 Node randomUUID 对齐)。
func randomUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b)
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}
