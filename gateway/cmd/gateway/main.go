// Command gateway 是 our-chat 的无状态 Go 连接网关:承载 WS 连接生命周期 + 心跳 + JWT 握手
// + 订阅 backplane 下行 + 上行透传 Node + 背压/配额 + Prometheus 指标。业务仍在 Node(docs 16)。
// 上行通道两种模式(env GATEWAY_UPSTREAM):
//   - http:每消息一次 POST /internal/gateway/uplink(默认,回滚兼容);
//   - grpc :双向流(ourchat.edge.v1.Realtime/Stream),单长连接复用 + 异步确认(演进方案文档 §4)。
// GATEWAY_PROXY_API=true 时网关同时反代 /api、/user 到 Node,作为唯一对外入口(目标态,方案文档 §6)。
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	"github.com/our-chat/gateway/internal/backplane"
	"github.com/our-chat/gateway/internal/config"
	edgev1 "github.com/our-chat/gateway/internal/contracts/gen/ourchat/edge/v1"
	"github.com/our-chat/gateway/internal/hub"
	"github.com/our-chat/gateway/internal/metrics"
	"github.com/our-chat/gateway/internal/presence"
	"github.com/our-chat/gateway/internal/proxy"
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

	// 上行通道装配:grpc 模式下 downlink 回调经原子引用路由到 hub(回调先于 hub 建立注册,
	// 帧真正到达时 hub 必已就绪)。grpc 未启用下行流时(onDownlink 非空即启用)仍走 Redis backplane。
	var router downlinkRouter
	var up upstream.Upstream
	var grpcUp *upstream.GrpcClient
	if cfg.UpstreamMode == "grpc" {
		gc, gerr := upstream.NewGrpc(cfg.EdgeGrpcAddr, cfg.EdgeGrpcStreams, cfg.InternalToken, log, func(f *edgev1.DownlinkFrame) {
			router.route(f)
		})
		if gerr != nil {
			log.Error("gRPC 上行通道初始化失败", "err", gerr)
			os.Exit(1)
		}
		grpcUp = gc
		up = gc
		log.Info("上行通道:grpc 流", "addr", cfg.EdgeGrpcAddr, "streams", cfg.EdgeGrpcStreams)
	} else {
		up = upstream.New(cfg.UpstreamBaseURL, cfg.InternalToken)
		log.Info("上行通道:http-per-message", "base", cfg.UpstreamBaseURL)
	}

	h := hub.New(cfg.MaxConns, cfg.SendBuffer, cfg.HeartbeatTimeout, reg, up, log)
	router.h.Store(h)
	wsHandler := ws.NewHandler(h, reg, cfg.JWTSecret, log, cfg.AllowedOrigins)

	// 下行 backplane:订阅 gw:downlink 路由到本地连接,随 ctx 取消退出。
	// grpc 下行流(目标态)落地后此订阅退化为兜底通道,当前两条路径并存不冲突(id 幂等由业务层保证)。
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
	// 网关作为唯一对外入口(目标态):HTTP API 反代到 Node 业务层。
	if cfg.ProxyAPI {
		px := proxy.New(cfg.UpstreamBaseURL, log)
		mux.Handle("/api/", px)
		mux.Handle("/user/", px)
		log.Info("HTTP 反代已启用(唯一入口模式)", "base", cfg.UpstreamBaseURL)
	}

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
	if grpcUp != nil {
		_ = grpcUp.Close()
	}
	_ = rdb.Close()
	_ = subRdb.Close()
	log.Info("已退出")
}

// downlinkRouter 把 gRPC 下行帧原子转发到 hub(建连顺序解耦)。
type downlinkRouter struct {
	h atomic.Pointer[hub.Hub]
}

func (r *downlinkRouter) route(f *edgev1.DownlinkFrame) {
	if h := r.h.Load(); h != nil {
		h.RouteToUser(f.UserId, f.TargetDeviceId, f.ExceptDeviceId, f.RawFrame)
	}
}
