package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/repo"
	"github.com/our-chat/biz/internal/service"
)

var groupSvc = service.NewGroupService(repo.NewGroupRepo())

// mountGroupRoutes 挂载 /group:建群、群资料、改名、加人。
func mountGroupRoutes(r *gin.Engine) {
	g := r.Group("/group", AuthenticateToken())
	g.POST("/create", handleGroupCreate)
	g.GET("/info", handleGroupInfo)
	g.PUT("/rename", handleGroupRename)
	g.POST("/addMembers", handleGroupAddMembers)
	g.PUT("/nickname", handleGroupNickname)
}

func handleGroupCreate(c *gin.Context) {
	var body struct {
		Name      string  `json:"name"`
		UserID    string  `json:"userId"`
		MemberIDs []int64 `json:"memberIds"`
	}
	_ = c.ShouldBindJSON(&body)
	if strconvFormatInt(CurrentUser(c).ID) != body.UserID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权代替他人建群"})
		return
	}
	gid, convID, err := groupSvc.CreateGroup(c.Request.Context(), CurrentUser(c).ID, body.MemberIDs, body.Name)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrGroupEmpty):
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "请至少选择一位成员"})
		case errors.Is(err, service.ErrGroupTooMany):
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "群成员超过上限"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "建群失败"})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true, "message": "建群成功",
		"data": gin.H{"groupId": gid, "conversationId": convID},
	})
}

func handleGroupInfo(c *gin.Context) {
	gid, _ := strconv.ParseInt(c.Query("groupId"), 10, 64)
	if gid <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "缺少 groupId"})
		return
	}
	info, members, err := groupSvc.Info(c.Request.Context(), CurrentUser(c).ID, gid)
	if err != nil {
		if errors.Is(err, service.ErrForbidden) {
			c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "非群成员无权查看"})
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "群不存在"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{
		"id": info.ID, "name": info.Name, "avatar": info.Avatar,
		"ownerId": info.OwnerID, "memberCount": info.MemberCount, "members": members,
	}})
}

func handleGroupRename(c *gin.Context) {
	var body struct {
		GroupID int64  `json:"groupId"`
		UserID  string `json:"userId"`
		Name    string `json:"name"`
	}
	_ = c.ShouldBindJSON(&body)
	if strconvFormatInt(CurrentUser(c).ID) != body.UserID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权修改他人群"})
		return
	}
	if err := groupSvc.Rename(c.Request.Context(), CurrentUser(c).ID, body.GroupID, body.Name); err != nil {
		if errors.Is(err, service.ErrForbidden) {
			c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "仅群主可修改群名"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "修改失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func handleGroupAddMembers(c *gin.Context) {
	var body struct {
		GroupID   int64   `json:"groupId"`
		UserID    string  `json:"userId"`
		MemberIDs []int64 `json:"memberIds"`
	}
	_ = c.ShouldBindJSON(&body)
	if strconvFormatInt(CurrentUser(c).ID) != body.UserID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权操作他人群"})
		return
	}
	if err := groupSvc.AddMembers(c.Request.Context(), CurrentUser(c).ID, body.GroupID, body.MemberIDs); err != nil {
		if errors.Is(err, service.ErrForbidden) {
			c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "仅群主可加人"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "添加失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// handleGroupNickname 设置「我在本群的昵称」。
func handleGroupNickname(c *gin.Context) {
	var body struct {
		GroupID  int64  `json:"groupId"`
		UserID   string `json:"userId"`
		Nickname string `json:"nickname"`
	}
	_ = c.ShouldBindJSON(&body)
	if strconvFormatInt(CurrentUser(c).ID) != body.UserID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权修改他人昵称"})
		return
	}
	if err := groupSvc.SetMyNickname(c.Request.Context(), CurrentUser(c).ID, body.GroupID, body.Nickname); err != nil {
		if errors.Is(err, service.ErrForbidden) {
			c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "非群成员"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "设置昵称失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}
