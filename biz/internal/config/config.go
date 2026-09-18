// Package config 从环境变量装载业务层配置。
// env 全集以 docker/.env.debug 为基础,并补齐 Node 源码引用而 .env.debug 缺失的键
// (EDGE_GRPC_* / TURN_* / AUTH_RATE_LIMIT_* / OAUTH_WEB_REDIRECT_URI 等,见 prompts/26-9-16)。
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type TurnConfig struct {
	Secret   string // 为空表示未启用 TURN(端点降级为空 iceServers)
	Host     string
	STUNPort int
	TLSPort  int
	TTLSec   int
}

type RateLimitConfig struct {
	Max      int
	WindowMS time.Duration
}

type OAuthConfig struct {
	IssuerBaseURL string
	ActiveKid     string
	RetiredKids   []string
	PrivateKeyFile string // OAUTH_PRIVATE_KEY_FILE(active kid 优先)
	KeyDir        string // OAUTH_KEY_DIR(未配 privateKeyFile 时按 kid 拼文件名)
	ATTtlSec      int
	RTTtlSec      int
	IDTtlSec      int
	CodeTTLSec    int
	WebRedirectURI []string
}

type S3Config struct {
	Endpoint        string
	Region          string
	Bucket          string
	AccessKey       string
	SecretKey       string
	ForcePathStyle  bool
	PublicBaseURL   string
}

type Config struct {
	Port            string
	IsProduction    bool
	AllowedOrigins  []string
	JWTSecret       []byte
	JWTExpiresIn    string
	InternalToken   string
	DatabaseURL     string
	RedisURL        string
	Turn            TurnConfig
	AuthRateLimit   RateLimitConfig
	ConvRateLimit   RateLimitConfig
	EdgeGrpcAddr    string
	EdgeGrpcEnabled bool
	ReplicaID       string
	OAuth           OAuthConfig
	S3              S3Config
}

// Load 装载全部配置。JWT_SECRET 缺失 fail-fast(与 gateway/Node 同语义)。
func Load() (*Config, error) {
	isProd := os.Getenv("NODE_ENV") == "production"
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		return nil, fmt.Errorf("缺少环境变量 JWT_SECRET:业务层必须与 gateway 共享同一登录密钥")
	}
	host, _ := os.Hostname()

	s3Endpoint := envOr("S3_ENDPOINT", "http://localhost:9000")
	s3Bucket := envOr("S3_BUCKET", "our-chat")

	cfg := &Config{
		Port:            envOr("PORT", "3007"),
		IsProduction:    isProd,
		AllowedOrigins:  parseList(envOr("CLIENT_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,https://localhost:5173,https://127.0.0.1:5173")),
		JWTSecret:       []byte(secret),
		JWTExpiresIn:    envOr("JWT_EXPIRES_IN", "7d"),
		InternalToken:   envOr("GATEWAY_INTERNAL_TOKEN", "dev-internal-token"),
		DatabaseURL:     envOr("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/our_chat"),
		RedisURL:        envOr("REDIS_URL", "redis://localhost:6379"),
		Turn: TurnConfig{
			Secret:   strings.TrimSpace(os.Getenv("TURN_SECRET")),
			Host:     strings.TrimSpace(os.Getenv("TURN_HOST")),
			STUNPort: positiveIntEnv("TURN_STUN_PORT", 3478),
			TLSPort:  positiveIntEnv("TURN_TLS_PORT", 5349),
			TTLSec:   positiveIntEnv("TURN_TTL_SEC", 86400),
		},
		AuthRateLimit: RateLimitConfig{
			Max:      envInt("AUTH_RATE_LIMIT_MAX", 10),
			WindowMS: time.Duration(envInt("AUTH_RATE_LIMIT_WINDOW_MS", 15*60*1000)) * time.Millisecond,
		},
		ConvRateLimit: RateLimitConfig{
			// 会话热点限流:单会话 1s 窗口消息率上限(压测 tp_r30 每会话仅 30/s,不受影响;
			// 默认 500/s 仅拦截热点/恶意会话)。
			Max:      envInt("CONV_RATE_LIMIT_MAX", 500),
			WindowMS: time.Duration(envInt("CONV_RATE_LIMIT_WINDOW_MS", 1000)) * time.Millisecond,
		},
		EdgeGrpcAddr:    envOr("EDGE_GRPC_ADDR", "127.0.0.1:3008"),
		EdgeGrpcEnabled: os.Getenv("EDGE_GRPC_ENABLED") != "false",
		ReplicaID:       envOr("REPLICA_ID", host),
		OAuth: OAuthConfig{
			IssuerBaseURL:  strings.TrimRight(envOr("OAUTH_ISSUER_BASE_URL", "http://localhost:3007"), "/"),
			ActiveKid:      os.Getenv("OAUTH_ACTIVE_KID"),
			RetiredKids:    parseList(os.Getenv("OAUTH_RETIRED_KIDS")),
			PrivateKeyFile: os.Getenv("OAUTH_PRIVATE_KEY_FILE"),
			KeyDir:         os.Getenv("OAUTH_KEY_DIR"),
			ATTtlSec:       envInt("OAUTH_AT_TTL_SEC", 900),
			RTTtlSec:       envInt("OAUTH_RT_TTL_SEC", 2592000),
			IDTtlSec:       envInt("OAUTH_ID_TTL_SEC", 900),
			CodeTTLSec:     envInt("OAUTH_CODE_TTL_SEC", 60),
			WebRedirectURI: parseList(envOr("OAUTH_WEB_REDIRECT_URI", "http://localhost:5173/oauth/callback")),
		},
		S3: S3Config{
			Endpoint:       s3Endpoint,
			Region:         envOr("S3_REGION", "us-east-1"),
			Bucket:         s3Bucket,
			AccessKey:      envOr("S3_ACCESS_KEY", "minioadmin"),
			SecretKey:      envOr("S3_SECRET_KEY", "minioadmin123"),
			ForcePathStyle: envOr("S3_FORCE_PATH_STYLE", "true") == "true",
			PublicBaseURL:  strings.TrimRight(envOr("S3_PUBLIC_BASE_URL", s3Endpoint+"/"+s3Bucket), "/"),
		},
	}

	if isProd {
		var missing []string
		for _, k := range []string{"S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"} {
			if os.Getenv(k) == "" {
				missing = append(missing, k)
			}
		}
		if len(missing) > 0 {
			return nil, fmt.Errorf("生产环境缺少对象存储配置: %s", strings.Join(missing, ", "))
		}
	}
	return cfg, nil
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

// positiveIntEnv 取正整数环境变量,非法/缺失回退默认(对齐 Node config.ts)。
func positiveIntEnv(key string, def int) int {
	n := envInt(key, def)
	if n <= 0 {
		return def
	}
	return n
}

func parseList(raw string) []string {
	if raw == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if s := strings.TrimSpace(p); s != "" {
			out = append(out, s)
		}
	}
	return out
}
