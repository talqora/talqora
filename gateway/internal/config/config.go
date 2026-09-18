// Package config 从环境变量装载网关配置。键名与 Node 后端对齐(JWT_SECRET / REDIS_URL),
// 让网关与业务进程共享同一套登录密钥与 Redis,无需额外配置面。
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// 网关 WS/metrics 监听地址。
	Addr string
	// HS256 校验 our-chat 登录 token 的密钥,必须与 Node 的 JWT_SECRET 一致。
	JWTSecret []byte
	// Redis 连接(presence 注册表 + gw:downlink pub/sub)。
	RedisURL string
	// Node 业务进程的内部上行端点基址(上行透传落库)。
	UpstreamBaseURL string
	// 上行通道模式:http(默认,每消息一次 POST,回滚兼容)/ grpc(双向流,26-9-16 演进方案)。
	UpstreamMode string
	// grpc 模式下 Node 的 gRPC 流服务地址(单地址,向后兼容)。
	EdgeGrpcAddr string
	// grpc 模式的多后端地址列表(EDGE_GRPC_ADDR 逗号分隔;多副本业务层时每副本一组流)。
	EdgeGrpcAddrs []string
	// grpc 模式每个后端的流分片数量(按 userId 哈希分片)。
	EdgeGrpcStreams int
	// 是否以网关作为 HTTP 统一入口(/api 反代到 Node;目标态,默认关)。
	ProxyAPI bool
	// 网关与 Node 内部端点的共享密钥,防止内部端点被外部直接调用。
	InternalToken string
	// 单网关进程的连接数硬上限(配额),超过即拒绝握手,防 fd/内存爆(docs 16 坑6)。
	MaxConns int
	// 每连接下行发送缓冲的有界容量。满即判定慢消费者并逐出(背压,docs 16 §4.4)。
	SendBuffer int
	// 应用层心跳:超过该时长没收到客户端 ping/pong 即判连接死并摘除(docs 16 §5.2)。
	HeartbeatTimeout time.Duration
	// 副本标识,写入 presence:meta,供跨副本定位连接所在网关。
	ReplicaID string
	// WS 握手的 Origin 白名单(与 server 的 CLIENT_ORIGINS 同款 env)。
	// 空列表 = 全部放行(dev 兼容);非空时仅放行列表内 Origin,无 Origin 头放行(非浏览器客户端)。
	AllowedOrigins []string
}

func Load() (*Config, error) {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		return nil, fmt.Errorf("缺少环境变量 JWT_SECRET:网关必须与 Node 后端共享同一登录密钥")
	}
	host, _ := os.Hostname()
	cfg := &Config{
		Addr:             envOr("GATEWAY_ADDR", ":8090"),
		JWTSecret:        []byte(secret),
		RedisURL:         envOr("REDIS_URL", "redis://localhost:6379"),
		UpstreamBaseURL:  envOr("UPSTREAM_BASE_URL", "http://127.0.0.1:3007"),
		UpstreamMode:     envOr("GATEWAY_UPSTREAM", "http"),
		EdgeGrpcAddr:     envOr("EDGE_GRPC_ADDR", "127.0.0.1:3008"),
		EdgeGrpcAddrs:    parseOrigins(envOr("EDGE_GRPC_ADDR", "127.0.0.1:3008")), // 逗号分隔多后端
		EdgeGrpcStreams:  envInt("EDGE_GRPC_STREAMS", 4),
		ProxyAPI:         os.Getenv("GATEWAY_PROXY_API") == "true",
		InternalToken:    envOr("GATEWAY_INTERNAL_TOKEN", "dev-internal-token"),
		MaxConns:         envInt("GATEWAY_MAX_CONNS", 50000),
		SendBuffer:       envInt("GATEWAY_SEND_BUFFER", 256),
		HeartbeatTimeout: time.Duration(envInt("GATEWAY_HEARTBEAT_TIMEOUT_SEC", 60)) * time.Second,
		ReplicaID:        envOr("REPLICA_ID", "gw-"+host),
		AllowedOrigins:   parseOrigins(os.Getenv("CLIENT_ORIGINS")),
	}
	return cfg, nil
}

// parseOrigins 把逗号分隔的 Origin 白名单解析为去空白、去空项的列表。
func parseOrigins(raw string) []string {
	if raw == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if o := strings.TrimSpace(p); o != "" {
			out = append(out, o)
		}
	}
	return out
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
