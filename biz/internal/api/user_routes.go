package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/store"
)

// mountUserRoutes 挂载 /user 面的用户资料路由(user.ts:仅 profile/update 两端点)。
func mountUserRoutes(r *gin.Engine) {
	g := r.Group("/user")
	g.GET("/profile", AuthenticateToken(), handleProfile)
	g.POST("/update", AuthenticateToken(), handleUserUpdate)
}

// allowedFields 白名单(user.ts:11-20,含 last_seen→lastSeen 双写兼容)。
var allowedFields = map[string]string{
	"email":      "email",
	"phone":      "phone",
	"nickname":   "nickname",
	"avatar":     "avatar",
	"bio":        "bio",
	"gender":     "gender",
	"last_seen":  "last_seen",
	"lastSeen":   "last_seen",
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

	updates := map[string]any{}
	for k, v := range body {
		if k == "id" {
			continue
		}
		if col, ok := allowedFields[k]; ok {
			updates[col] = v
		}
	}
	if len(updates) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"message": "没有可更新的字段"})
		return
	}

	// 逐字段生成 SET 子句(列名来自白名单,安全)
	sql := "UPDATE users SET "
	args := []any{}
	i := 1
	for k, v := range updates {
		if i > 1 {
			sql += ", "
		}
		sql += k + " = $" + itoa(i)
		args = append(args, v)
		i++
	}
	sql += " WHERE id = $" + itoa(i)
	args = append(args, user.ID)

	if _, err := store.PG().Exec(c.Request.Context(), sql, args...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": "更新失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "更新成功"})
}
