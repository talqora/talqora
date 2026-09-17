package api

import (
	"log/slog"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/oauth"
)

// mountOAuthRoutes 挂载 OAuth IdP 全部端点(index.ts:22-44 同面):
// .well-known/openid-configuration、jwks.json + /oauth 下 6 个端点。
// 密钥装载/seed client 在 main 启动时完成(fail-fast),此处只挂端点。
func mountOAuthRoutes(r *gin.Engine, cfg *config.Config, logger *slog.Logger) {
	keyOpts, err := oauth.ReadKeyOptionsFromEnv()
	if err != nil {
		logger.Error("OAuth 密钥配置缺失,IdP 端点不挂载", "err", err)
		return
	}
	store, err := oauth.LoadKeyStore(keyOpts)
	if err != nil {
		logger.Error("OAuth 密钥装载失败,IdP 端点不挂载", "err", err)
		return
	}
	env := &oauth.HandlerEnv{
		Store:      store,
		Issuer:     oauth.ReadIssuerConfigFromEnv(cfg.OAuth.IssuerBaseURL, cfg.OAuth.ATTtlSec, cfg.OAuth.RTTtlSec, cfg.OAuth.IDTtlSec),
		CodeTTLSec: cfg.OAuth.CodeTTLSec,
		LoginPath:  "/login",
		JWTSecret:  cfg.JWTSecret,
	}
	oauth.Mount(r, env, AuthenticateToken())
	logger.Info("OAuth IdP 已挂载", "issuer", env.Issuer.Issuer, "active_kid", store.Active.Kid)
}
