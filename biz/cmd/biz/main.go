// biz:our-chat 业务层(Go 模块化单体,多副本无状态)。
// HTTP(gin) 与 gRPC edge 流服务双面;PG/Redis/MinIO 为唯一外部状态。
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	biz "github.com/our-chat/biz"
	"github.com/our-chat/biz/internal/api"
	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/logx"
	"github.com/our-chat/biz/internal/metrics"
	"github.com/our-chat/biz/internal/migrate"
	"github.com/our-chat/biz/internal/oauth"
	"github.com/our-chat/biz/internal/realtime"
	"github.com/our-chat/biz/internal/service"
	"github.com/our-chat/biz/internal/store"
)

func main() {
	logger := logx.Init()
	if err := run(logger); err != nil {
		logger.Error("服务启动失败", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx := context.Background()

	// 数据层三件套:PG / Redis / MinIO。任一失败 fail-fast。
	pool, err := store.NewPG(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if _, err := store.NewRedis(ctx, cfg.RedisURL); err != nil {
		return err
	}
	if _, err := store.NewS3(cfg.S3); err != nil {
		return err
	}
	logger.Info("数据层连接就绪", "pg", cfg.DatabaseURL, "redis", cfg.RedisURL)

	// schema 迁移:golang-migrate embed + Prisma 基线自动 force。
	if err := migrate.Up(ctx, pool, biz.MigrationsFS); err != nil {
		return err
	}
	logger.Info("schema 迁移完成(golang-migrate)")

	// seq 发号 checkpoint 循环(每 60s 把 Redis 位点 GREATEST 写回 PG 兜底)
	service.StartCheckpointLoop(ctx, 60*time.Second, logger)

	// 会话热点限流装配(0=禁用,见 internal/service/ratelimit.go)
	service.SetConvRateLimit(cfg.ConvRateLimit.Max, cfg.ConvRateLimit.WindowMS)

	// OAuth IdP:seed 默认 client + 清理任务(密钥装载与端点挂载在 api 装配内完成)
	if err := oauth.SeedDefaultClient(ctx, oauth.SeedClient{
		ClientID:          "our-chat-web",
		ClientName:        "our-chat Web SPA",
		ClientType:        "public",
		RedirectURIs:      cfg.OAuth.WebRedirectURI,
		AllowedScopes:     []string{"openid", "profile", "email", "agent-server"},
		AllowedGrantTypes: []string{"authorization_code", "refresh_token"},
	}); err != nil {
		return err
	}
	oauth.StartCleanupLoop(ctx)

	// HTTP 面:gin 装配(路由/中间件见 internal/api)。
	router := api.NewRouter(cfg, logger)
	httpSrv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// 实时面:gRPC edge 流服务(gateway 经 GATEWAY_UPSTREAM=grpc 上行)。
	var edgeSrv *realtime.EdgeServer
	if cfg.EdgeGrpcEnabled {
		edgeSrv, err = realtime.StartEdge(cfg, logger)
		if err != nil {
			return err
		}
	}

	errCh := make(chan error, 2)
	go func() {
		logger.Info("HTTP 服务启动", "addr", httpSrv.Addr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	// 优雅关闭:SIGTERM/SIGINT → 停收新请求 → 终检 checkpoint → 收尾连接,10s 超时强制退出。
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	select {
	case sig := <-quit:
		logger.Info("收到信号,开始优雅关闭", "signal", sig.String())
	case err := <-errCh:
		return err
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if edgeSrv != nil {
		edgeSrv.GracefulStop()
	}
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP 优雅关闭出错", "err", err)
	}
	realtime.FinalCheckpoint(context.Background(), logger)
	if rdb := store.Redis(); rdb != nil {
		_ = rdb.Close()
	}
	logger.Info("已优雅关闭,退出")
	return nil
}

// 保留引用避免未使用告警(metrics 在 api 包内使用)。
var _ = metrics.Handler
var _ = gin.New
