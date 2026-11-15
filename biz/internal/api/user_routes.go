package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"errors"

	"github.com/our-chat/biz/internal/service"
)

// mountUserRoutes 挂载 /user 面的用户资料路由(user.ts:仅 profile/update 两端点)。
func mountUserRoutes(r *gin.Engine) {
	g := r.Group("/user")
	g.GET("/profile", AuthenticateToken(), handleProfile)
	g.POST("/update", AuthenticateToken(), handleUserUpdate)
}

// handleProfile 当前登录用户资料(user.ts:24-26,直接回中间件挂上的现值)。
func handleProfile(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"success": true, "data": CurrentUser(c)})
}

// handleUserUpdate 资料更新(user.ts:28-59)。字段白名单 + 属主校验。
func handleUserUpdate(c *gin.Context) {
	var body map[string]any
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "id不能为空"})
		return
	}
	rawID, _ := body["id"]
	idStr := toStr(rawID)
	// 顺序对齐 user.ts:31-36(先属主校验,后 id 空校验)
	user := CurrentUser(c)
	if strconvFormatInt(user.ID) != idStr {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "无权修改其他用户信息"})
		return
	}
	if idStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"message": "id不能为空"})
		return
	}

	if err := service.UpdateUserProfile(c.Request.Context(), user.ID, body); err != nil {
		if errors.Is(err, service.ErrNoFields) {
			c.JSON(http.StatusBadRequest, gin.H{"message": "没有可更新的字段"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"message": "更新失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "更新成功"})
}
