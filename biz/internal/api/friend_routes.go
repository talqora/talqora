package api

import (
	"crypto/rand"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/repo"
	"github.com/our-chat/biz/internal/service"
)

// friendSvc 好友域用例(见 internal/service/friend.go);handler 只做传输层的事。
var friendSvc = service.NewFriendService(repo.NewFriendRepo())

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

// pageOf 解析键集分页参数;limit=0 表示「全量」旧语义。
func pageOf(c *gin.Context) repo.Page {
	var p repo.Page
	if v := c.Query("limit"); v != "" {
		p.Limit, _ = strconv.Atoi(v)
		if p.Limit > 200 {
			p.Limit = 200
		}
	}
	if v := c.Query("after"); v != "" {
		p.After, _ = strconv.ParseInt(v, 10, 64)
	}
	return p
}

// handleGetFriendList 好友列表;带 limit 时按 friend_id 键集分页并返回 hasMore/nextAfter。
func handleGetFriendList(c *gin.Context) {
	id := c.Param("id")
	if strconvFormatInt(CurrentUser(c).ID) != id {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权访问其他用户的好友列表"})
		return
	}
	uid, _ := strconv.ParseInt(id, 10, 64)
	p := pageOf(c)
	res, err := friendSvc.ListFriends(c.Request.Context(), uid, p)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "获取好友列表失败"})
		return
	}
	ids := map[string]*string{}
	infos := map[string]gin.H{}
	for _, f := range res.Items {
		key := strconvFormatInt(f.UserID)
		ids[key] = f.Remark
		infos[key] = gin.H{"username": f.Username, "avatar": f.Avatar, "gender": f.Gender}
	}
	data := gin.H{"friendId": ids, "friendInfo": infos}
	if p.Limit > 0 {
		data["hasMore"] = res.HasMore
		data["nextAfter"] = res.Next
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

// handleSearchUser 查询用户(id/手机号/用户名取第一条)并给出与我的关系。
func handleSearchUser(c *gin.Context) {
	keyword := c.Query("keyword")
	_ = c.Query("userId") // 兼容旧参数,身份以 token 为准
	u, isFriend, err := friendSvc.Search(c.Request.Context(), CurrentUser(c).ID, keyword)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "查询用户信息失败"})
		return
	}
	info := gin.H{"id": u.ID, "avatar": u.Avatar, "username": u.Username, "gender": u.Gender}
	if isFriend {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": "已经是好友",
			"data":    gin.H{"exist": true, "isFriend": true, "friendInfo": info},
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    gin.H{"exist": true, "isFriend": false, "friendInfo": info},
	})
}

// handleAddFriend 发起好友请求(双向写入 + 推送接收方)。
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
	fid, _ := strconv.ParseInt(body.FriendID, 10, 64)
	uid, _ := strconv.ParseInt(body.UserID, 10, 64)
	if err := friendSvc.AddFriend(c.Request.Context(), uid, fid); err != nil {
		// 撞唯一约束等:与 Node createMany 异常一致,默认 200 信封
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "发起好友请求失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true, "message": "发起好友请求成功",
		"data": gin.H{"isFriend": false, "friendId": fid},
	})
}

// handleUpdateRemark 更新备注(空串/全空白 → 清空)。
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
	fid, _ := strconv.ParseInt(body.FriendID, 10, 64)
	uid, _ := strconv.ParseInt(body.UserID, 10, 64)
	var remark *string
	if trimmed := strings.TrimSpace(body.Remark); trimmed != "" {
		remark = &trimmed
	}
	if err := friendSvc.SetRemark(c.Request.Context(), uid, fid, remark); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "更新好友备注失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// handleGetFriendReqs 收到的好友请求;带 limit 时按 id 倒序键集分页(hasMore/nextBefore)。
func handleGetFriendReqs(c *gin.Context) {
	userID := c.Query("userId")
	if strconvFormatInt(CurrentUser(c).ID) != userID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权访问其他用户的好友请求"})
		return
	}
	uid, _ := strconv.ParseInt(userID, 10, 64)
	p := pageOf(c)
	res, err := friendSvc.ListReqs(c.Request.Context(), uid, p)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "获取好友请求失败"})
		return
	}
	out := gin.H{}
	for _, r := range res.Items {
		out[strconvFormatInt(r.FriendID)] = gin.H{
			"id": r.ID, "userId": r.UserID, "friendId": r.FriendID, "status": r.Status,
			"remark": r.Remark, "createdAt": r.CreatedAt, "updatedAt": r.UpdatedAt,
			"username": r.Username, "avatar": r.Avatar,
		}
	}
	if p.Limit > 0 {
		out["hasMore"] = res.HasMore
		out["nextBefore"] = res.Next
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": out})
}

// handleReplyFriendReq 同意/拒绝好友请求(双向改状态 + 通知 + 自动招呼语)。
func handleReplyFriendReq(c *gin.Context) {
	var body struct {
		UserID   string `json:"userId"`
		FriendID string `json:"friendId"`
		Status   string `json:"status"`
	}
	_ = c.ShouldBindJSON(&body)
	if strconvFormatInt(CurrentUser(c).ID) != body.UserID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权代替其他用户回复好友请求"})
		return
	}
	uid, _ := strconv.ParseInt(body.UserID, 10, 64)
	fid, _ := strconv.ParseInt(body.FriendID, 10, 64)
	if err := friendSvc.Reply(c.Request.Context(), uid, fid, body.Status); err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "回复好友请求失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "回复好友请求成功"})
}

// singleConvID / randomUUID 保留在本包:已有单测直接引用它们。
func singleConvID(a, b int64) string { return service.SingleConvID(a, b) }

func randomUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return strings.ToLower(
		hex4(b[0:4]) + "-" + hex4(b[4:6]) + "-" + hex4(b[6:8]) + "-" + hex4(b[8:10]) + "-" + hex4(b[10:16]))
}

func hex4(b []byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, v := range b {
		out = append(out, hexdigits[v>>4], hexdigits[v&0x0f])
	}
	return string(out)
}
