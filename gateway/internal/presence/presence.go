// Package presence 把网关持有的连接镜像进与 Node 同一套 Redis 注册表,
// 让 Node 的读扩散(filterOnline)把网关上的在线用户也算进在线子集(docs 14 §6③ / 15 §5.1)。
//
// 键结构与 server/src/realtime/presence.ts 完全一致(必须一致,否则两侧互相看不见对方的连接):
//
//	presence:{userId}        ZSET  member=deviceId, score=过期时刻(ms)
//	presence:{userId}:meta   HASH  field=deviceId,  value="{replica}:{socketId}"
package presence

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

type Registry struct {
	rdb     *redis.Client
	ttl     time.Duration
	replica string
}

func New(rdb *redis.Client, ttl time.Duration, replica string) *Registry {
	return &Registry{rdb: rdb, ttl: ttl, replica: replica}
}

func zkey(userID int64) string { return "presence:" + strconv.FormatInt(userID, 10) }
func mkey(userID int64) string { return "presence:" + strconv.FormatInt(userID, 10) + ":meta" }

func (r *Registry) expireAt() float64 {
	return float64(time.Now().Add(r.ttl).UnixMilli())
}

// Register 上线:登记设备并写 meta。与 Node 的 register 等价(MULTI 里 ZADD + HSET)。
func (r *Registry) Register(ctx context.Context, userID int64, deviceID, socketID string) error {
	pipe := r.rdb.TxPipeline()
	pipe.ZAdd(ctx, zkey(userID), redis.Z{Score: r.expireAt(), Member: deviceID})
	pipe.HSet(ctx, mkey(userID), deviceID, r.replica+":"+socketID)
	_, err := pipe.Exec(ctx)
	return err
}

// Refresh 心跳续约:仅推后过期时刻(不动 meta),与 Node 的 refresh 一致。
func (r *Registry) Refresh(ctx context.Context, userID int64, deviceID string) error {
	return r.rdb.ZAdd(ctx, zkey(userID), redis.Z{Score: r.expireAt(), Member: deviceID}).Err()
}

// Remove 优雅断开:即时摘除设备与 meta(非优雅断开靠 Node 读取时的惰性过期兜底)。
func (r *Registry) Remove(ctx context.Context, userID int64, deviceID string) error {
	pipe := r.rdb.TxPipeline()
	pipe.ZRem(ctx, zkey(userID), deviceID)
	pipe.HDel(ctx, mkey(userID), deviceID)
	_, err := pipe.Exec(ctx)
	return err
}
