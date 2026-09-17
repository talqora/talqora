package api

import (
	"log/slog"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/config"
)

// 本文件为分阶段挂载的占位(P0 骨架)。各阶段实现后,对应函数在各自模块文件中被同名替换(删掉本文件同名函数)。

func mountFriendRoutes(r *gin.Engine)                        {}
func mountChatRoutes(r *gin.Engine)                          {}
func mountSyncRoutes(r *gin.Engine)                          {}
func mountUploadRoutes(r *gin.Engine, cfg *config.Config)    {}
func mountInternalRoutes(r *gin.Engine, cfg *config.Config)  {}
func mountRumRoutes(r *gin.Engine)                           {}
func mountOAuthRoutes(r *gin.Engine, cfg *config.Config, logger *slog.Logger) {}
