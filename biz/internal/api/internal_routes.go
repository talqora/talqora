package api

import (
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"log/slog"

	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/realtime"
)

// mountInternalRoutes 挂载网关内部端点(HTTP 模式回滚兼容保留,routes/internal.ts 同语义)。
func mountInternalRoutes(r *gin.Engine, cfg *config.Config) {
	g := r.Group("/internal")
	g.POST("/gateway/uplink", func(c *gin.Context) {
		handleGatewayUplink(c, cfg)
	})
	g.POST("/gateway/disconnect", func(c *gin.Context) {
		handleGatewayDisconnect(c, cfg)
	})
}

// checkInternalToken X-Gateway-Token 必须等于共享内部令牌(internal.ts:15)。
func checkInternalToken(c *gin.Context, cfg *config.Config) bool {
	if c.GetHeader("X-Gateway-Token") != cfg.InternalToken {
		c.JSON(http.StatusUnauthorized, gin.H{"type": "message.error", "message": "内部令牌校验失败"})
		return false
	}
	return true
}

// resolveIdentity X-User-Id / X-Device-Id(internal.ts:21-25)。
func resolveIdentity(c *gin.Context) (int64, string, bool) {
	userID, err := strconv.ParseInt(c.GetHeader("X-User-Id"), 10, 64)
	if err != nil || userID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"type": "message.error", "message": "缺少合法的用户身份"})
		return 0, "", false
	}
	return userID, c.GetHeader("X-Device-Id"), true
}

func handleGatewayUplink(c *gin.Context, cfg *config.Config) {
	if !checkInternalToken(c, cfg) {
		return
	}
	userID, deviceID, ok := resolveIdentity(c)
	if !ok {
		return
	}
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"type": "message.error", "message": "缺少合法的用户身份"})
		return
	}
	result := realtime.HandleUplink(c.Request.Context(), raw, realtime.UplinkContext{UserID: userID, DeviceID: deviceID})
	if result.Status == 204 {
		c.Status(http.StatusNoContent)
		return
	}
	c.JSON(result.Status, result.Body)
}

func handleGatewayDisconnect(c *gin.Context, cfg *config.Config) {
	if !checkInternalToken(c, cfg) {
		return
	}
	userID, deviceID, ok := resolveIdentity(c)
	if !ok {
		return
	}
	realtime.HandleDisconnect(c.Request.Context(), userID, deviceID, slog.Default())
	c.Status(http.StatusNoContent)
}
