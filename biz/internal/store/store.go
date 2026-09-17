// Package store 是唯一触达 PG/Redis/S3 的数据访问层(V3「模块化单体接口化」的存储边界)。
// pgxpool 配查询计时 tracer(db_query_duration_seconds 埋点,替代 Node 的 Prisma Client Extension)。
package store

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/redis/go-redis/v9"

	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/metrics"
)

var pgPool *pgxpool.Pool
var rdb *redis.Client
var s3Client *minio.Client

// NewPG 建立 pgxpool 连接池并 ping 验证。
func NewPG(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.ConnConfig.Tracer = &queryTracer{}
	cfg.MaxConns = 32
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	pgPool = pool
	return pool, nil
}

// NewRedis 建立 go-redis 客户端并 ping 验证。
func NewRedis(ctx context.Context, url string) (*redis.Client, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(opt)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}
	rdb = client
	return client, nil
}

// NewS3 建立 minio-go 客户端(S3 兼容;MinIO 走 path-style)。
func NewS3(cfg config.S3Config) (*minio.Client, error) {
	client, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: strings.HasPrefix(cfg.Endpoint, "https://"),
		Region: cfg.Region,
	})
	if err != nil {
		return nil, err
	}
	s3Client = client
	return client, nil
}

// PG 返回全局连接池(供各 service 使用)。
func PG() *pgxpool.Pool { return pgPool }

// Redis 返回全局 Redis 客户端。
func Redis() *redis.Client { return rdb }

// SetRedisForTest 测试替身注入(仅测试用,生产勿调)。
func SetRedisForTest(c *redis.Client) { rdb = c }

// S3 返回全局 minio 客户端。
func S3() *minio.Client { return s3Client }

// queryTracer 为 pgx 实现计时埋点:每次查询记录 db_query_duration_seconds。
// model 标签从 SQL 提取首个目标表名(与 Node 的 Prisma model 标签口径近似)。
type queryTracer struct{}

var tableRe = regexp.MustCompile(`(?i)(?:from|into|update)\s+["]?([a-z_][a-z0-9_]*)`)

func (t *queryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	ctx = context.WithValue(ctx, queryStartKey{}, time.Now())
	return context.WithValue(ctx, querySQLKey{}, data.SQL)
}

func (t *queryTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	start, _ := ctx.Value(queryStartKey{}).(time.Time)
	if start.IsZero() {
		return
	}
	model := "raw"
	if sql, _ := ctx.Value(querySQLKey{}).(string); sql != "" {
		if m := tableRe.FindStringSubmatch(sql); m != nil {
			model = strings.ToLower(m[1])
		}
	}
	metrics.ObserveDbQuery(model, "query", time.Since(start).Seconds())
}

type queryStartKey struct{}
type querySQLKey struct{}
