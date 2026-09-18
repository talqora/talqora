package service

import (
	"context"
	"log/slog"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"

	"github.com/our-chat/biz/internal/store"
)

// presence.go:连接注册表读侧(写侧在 gateway,键结构与 server/src/realtime/presence.ts 完全一致):
//
//	presence:{userId}        ZSET  member=deviceId, score=过期时刻(ms)
//	presence:{userId}:meta   HASH  field=deviceId,  value="{replica}:{socketId}"
//
// 业务层只读:filterOnline(群扇出在线子集)与 getDevices(属主路由)。

func presenceZKey(userID int64) string { return "presence:" + strconv.FormatInt(userID, 10) }

// DeviceEntry 在线设备条目(presence.ts:22-26)。
type DeviceEntry struct {
	DeviceID string
	Replica  string
	SocketID string
}

// FilterOnline 批量在线判定:返回「至少有一台设备在 TTL 内」的 userId 子集(presence.ts:94-112)。
// 单条 pipeline 把 N 次 ZRANGEBYSCORE 压成一次往返。
func FilterOnline(ctx context.Context, userIDs []int64) (map[int64]bool, error) {
	online := make(map[int64]bool)
	if len(userIDs) == 0 {
		return online, nil
	}
	rdb := store.Redis()
	now := strconv.FormatInt(unixMilli(), 10)
	pipe := rdb.Pipeline()
	for _, uid := range userIDs {
		pipe.ZRangeByScore(ctx, presenceZKey(uid), &redis.ZRangeBy{Min: now, Max: "+inf", Count: 1})
	}
	cmds, err := pipe.Exec(ctx)
	if err != nil && !isRedisNil(err) {
		return nil, err
	}
	for i, cmd := range cmds {
		rows, rerr := cmd.(*redis.StringSliceCmd).Result()
		if rerr == nil && len(rows) > 0 {
			online[userIDs[i]] = true
		}
	}
	return online, nil
}

// GetDevices 枚举一个用户当前在线的全部设备(presence.ts:61-89):
// 读取前惰性摘除已过期项,再解析 meta 返回活跃设备。
func GetDevices(ctx context.Context, userID int64) ([]DeviceEntry, error) {
	rdb := store.Redis()
	zkey := presenceZKey(userID)
	mkey := zkey + ":meta"
	now := unixMilli()

	// 惰性摘除过期项(score < now)
	expired, err := rdb.ZRangeByScore(ctx, zkey, &redis.ZRangeBy{Min: "0", Max: strconv.FormatInt(now-1, 10)}).Result()
	if err != nil {
		return nil, err
	}
	if len(expired) > 0 {
		pipe := rdb.TxPipeline()
		pipe.ZRemRangeByScore(ctx, zkey, "0", strconv.FormatInt(now-1, 10))
		pipe.HDel(ctx, mkey, expired...)
		if _, err := pipe.Exec(ctx); err != nil {
			return nil, err
		}
	}

	alive, err := rdb.ZRangeByScore(ctx, zkey, &redis.ZRangeBy{Min: strconv.FormatInt(now, 10), Max: "+inf"}).Result()
	if err != nil {
		return nil, err
	}
	if len(alive) == 0 {
		return nil, nil
	}
	metas, err := rdb.HMGet(ctx, mkey, alive...).Result()
	if err != nil {
		return nil, err
	}
	out := make([]DeviceEntry, 0, len(alive))
	for i, deviceID := range alive {
		raw, _ := metas[i].(string)
		sep := strings.Index(raw, ":")
		if sep == -1 {
			continue
		}
		out = append(out, DeviceEntry{
			DeviceID: deviceID,
			Replica:  raw[:sep],
			SocketID: raw[sep+1:],
		})
	}
	return out, nil
}

// ReplicaOf 单用户在线副本定位(定向下行用):取任一在线设备的 replica id。
// 轻量路径(不做惰性摘除——摘除是 gateway 侧职责,过期数据由 pub/sub 兜底)。
func ReplicaOf(ctx context.Context, userID int64) (string, error) {
	rdb := store.Redis()
	now := strconv.FormatInt(unixMilli(), 10)
	alive, err := rdb.ZRangeByScore(ctx, presenceZKey(userID), &redis.ZRangeBy{Min: now, Max: "+inf", Count: 1}).Result()
	if err != nil || len(alive) == 0 {
		return "", err
	}
	metas, err := rdb.HMGet(ctx, presenceZKey(userID)+":meta", alive[0]).Result()
	if err != nil || len(metas) == 0 {
		return "", err
	}
	raw, _ := metas[0].(string)
	if sep := strings.Index(raw, ":"); sep != -1 {
		return raw[:sep], nil
	}
	return "", nil
}

// ReplicaOfBatch 批量在线副本定位(群扇出定向下行用):
// 第一段 pipeline 在线判定(ZRANGEBYSCORE),第二段 pipeline 批量 meta 解析——共 2 次往返。
func ReplicaOfBatch(ctx context.Context, userIDs []int64) (map[int64]string, error) {
	out := make(map[int64]string)
	if len(userIDs) == 0 {
		return out, nil
	}
	rdb := store.Redis()
	now := strconv.FormatInt(unixMilli(), 10)

	pipe := rdb.Pipeline()
	cmds := make([]*redis.StringSliceCmd, len(userIDs))
	for i, uid := range userIDs {
		cmds[i] = pipe.ZRangeByScore(ctx, presenceZKey(uid), &redis.ZRangeBy{Min: now, Max: "+inf", Count: 1})
	}
	if _, err := pipe.Exec(ctx); err != nil && !isRedisNil(err) {
		return out, err
	}
	var aliveUIDs []int64
	var aliveDevices []string
	for i, cmd := range cmds {
		rows, rerr := cmd.Result()
		if rerr == nil && len(rows) > 0 {
			aliveUIDs = append(aliveUIDs, userIDs[i])
			aliveDevices = append(aliveDevices, rows[0])
		}
	}
	if len(aliveUIDs) == 0 {
		return out, nil
	}

	pipe2 := rdb.Pipeline()
	metaCmds := make([]*redis.SliceCmd, len(aliveUIDs))
	for i, uid := range aliveUIDs {
		metaCmds[i] = pipe2.HMGet(ctx, presenceZKey(uid)+":meta", aliveDevices[i])
	}
	if _, err := pipe2.Exec(ctx); err != nil && !isRedisNil(err) {
		return out, err
	}
	for i, cmd := range metaCmds {
		vals, verr := cmd.Result()
		if verr != nil || len(vals) == 0 {
			continue
		}
		raw, _ := vals[0].(string)
		if sep := strings.Index(raw, ":"); sep != -1 {
			out[aliveUIDs[i]] = raw[:sep]
		}
	}
	return out, nil
}

func unixMilli() int64 { return nowMillis() }

func isRedisNil(err error) bool { return err == redis.Nil }

func logDownlinkError(err error) {
	slog.Default().Warn("下行 publish 失败", "err", err)
}
