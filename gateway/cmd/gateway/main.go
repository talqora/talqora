// Command gateway 是 our-chat 的无状态 Go 连接网关:承载 WS 连接生命周期 + 心跳 + JWT 握手
// + 订阅 backplane 下行 + 上行透传 Node + 背压/配额 + Prometheus 指标。业务仍在 Node(docs 16)。
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

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	"github.com/our-chat/gateway/internal/backplane"
	"github.com/our-chat/gateway/internal/config"
	"github.com/our-chat/gateway/internal/hub"
	"github.com/our-chat/gateway/internal/metrics"
	"github.com/our-chat/gateway/internal/presence"
	"github.com/our-chat/gateway/internal/upstream"
	"github.com/our-chat/gateway/internal/ws"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg, err := config.Load()
	if err != nil {
		log.Error("配置装载失败", "err", err)
		os.Exit(1)
	}

	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Error("REDIS_URL 解析失败", "err", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(opt)
	// 订阅连接必须独立于命令连接(进入订阅态后该连接不能再发普通命令)。
	subRdb := redis.NewClient(opt)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Error("Redis 不可达", "err", err)
		os.Exit(1)
	}

	reg := presence.New(rdb, cfg.HeartbeatTimeout, cfg.ReplicaID)
	up := upstream.New(cfg.UpstreamBaseURL, cfg.InternalToken)
	h := hub.New(cfg.MaxConns, cfg.SendBuffer, cfg.HeartbeatTimeout, reg, up, log)
	wsHandler := ws.NewHandler(h, reg, cfg.JWTSecret, log, cfg.AllowedOrigins)

	// 下行 backplane:订阅 gw:downlink 路由到本地连接,随 ctx 取消退出。
	go func() {
		if err := backplane.Run(ctx, subRdb, h, log); err != nil && !errors.Is(err, context.Canceled) {
			log.Error("backplane 退出", "err", err)
		}
	}()

	mux := http.NewServeMux()
	mux.Handle("/ws", wsHandler)
	mux.Handle("/metrics", metrics.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	srv := &http.Server{Addr: cfg.Addr, Handler: mux}
	go func() {
		log.Info("网关启动", "addr", cfg.Addr, "replica", cfg.ReplicaID, "maxConns", cfg.MaxConns)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("HTTP 服务退出", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("收到退出信号,开始优雅关闭")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// drain:先向存量连接发 1012(Service Restart)引导客户端重连其它副本,再关 HTTP 服务。
	h.ShutdownAll(websocket.CloseServiceRestart, "gateway restarting")
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("HTTP 优雅关闭失败", "err", err)
	}
	_ = rdb.Close()
	_ = subRdb.Close()
	log.Info("已退出")
}
