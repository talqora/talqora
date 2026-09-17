package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"github.com/our-chat/biz/internal/store"
)

// seq.go:会话内 seq 发号(V3 已定稿:Redis INCR 替代 DB 行锁)。
//
//   - 键 conv:seq:{conversationId},初始值从 PG conversations.next_seq 装载;
//   - 键不存在时经 Lua「GET or SET(装载值) + INCR」原子完成装载与自增(并发安全);
//   - Redis 不可用降级回 DB 行锁路径(UPDATE ... RETURNING,与 Node message.ts:42-47 同 SQL);
//   - 定期 checkpoint:把 Redis 当前值 GREATEST 写回 PG 兜底(崩溃恢复仍以 Redis 为权威,
//     PG 仅作初始装载源与灾备兜底)。
//
// 跳号语义:INCR 与 message INSERT 不在同一事务,幂等去重命中时 Redis 已 +1 产生跳号——
// seq 只需会话内单调(范围补拉/gap 检测的前提),跳号无害(与 V3 §4.1 一致);前置幂等缓存
// 把跳号概率压到「缓存未命中的并发竞态」级别。

const seqKeyPrefix = "conv:seq:"
const idemKeyPrefix = "msg:idem:"

// seqLua:键不存在时先装载 PG 初始值再自增,存在则直接自增(原子)。
var seqLua = redis.NewScript(`
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], ARGV[1])
end
return redis.call('INCR', KEYS[1])
`)

func seqKey(convID string) string { return seqKeyPrefix + convID }
func idemKey(convID string, senderID int64, clientMsgID string) string {
	return idemKeyPrefix + convID + ":" + strconv.FormatInt(senderID, 10) + ":" + clientMsgID
}

// NextSeq 取会话下一个 seq(Redis INCR;键缺失时从 PG 装载;Redis 故障降级 DB 行锁)。
func NextSeq(ctx context.Context, convID string) (int64, error) {
	seq, err := nextSeqWith(ctx, store.Redis(), convID,
		func(ctx context.Context) (int64, error) { return loadNextSeqFromPG(ctx, convID) },
		func(ctx context.Context) (int64, error) { return bumpSeqDB(ctx, convID) },
	)
	if err == nil {
		rememberConv(convID)
	}
	return seq, err
}

// nextSeqWith 发号核心逻辑(依赖注入版,便于单测):
//   - 快路径:键已存在 → INCR;
//   - 键缺失 → 装载 PG 初始值 → Lua「GET or SET(装载值) + INCR」原子;
//   - Redis 故障 → 降级 DB 行锁(loadInit/bump 由调用方注入)。
func nextSeqWith(ctx context.Context, rdb *redis.Client, convID string,
	loadInit func(context.Context) (int64, error),
	bump func(context.Context) (int64, error),
) (int64, error) {
	key := seqKey(convID)

	// 快路径:键已存在 → INCR 单命令。
	if _, err := rdb.Get(ctx, key).Int64(); err == nil {
		if seq, ierr := rdb.Incr(ctx, key).Result(); ierr == nil {
			return seq, nil
		}
	}

	// 键缺失:查 PG 初始值 → Lua 原子「GET or SET + INCR」。
	init, err := loadInit(ctx)
	if err != nil {
		return 0, err
	}
	seq, err := seqLua.Run(ctx, rdb, []string{key}, init).Int64()
	if err != nil {
		// Redis 故障:降级回 DB 行锁路径(Node 同款 SQL)。
		return bump(ctx)
	}
	return seq, nil
}

// loadNextSeqFromPG 读 PG 当前 next_seq(会话不存在返回 0,首条消息 INCR 后为 1)。
func loadNextSeqFromPG(ctx context.Context, convID string) (int64, error) {
	var next int64
	err := store.PG().QueryRow(ctx,
		"SELECT next_seq FROM conversations WHERE id = $1", convID).Scan(&next)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return next, err
}

// bumpSeqDB DB 行锁发号(降级路径,与 Node message.ts:42-47 同语义)。
func bumpSeqDB(ctx context.Context, convID string) (int64, error) {
	var next int64
	err := store.PG().QueryRow(ctx,
		"UPDATE conversations SET next_seq = next_seq + 1 WHERE id = $1 RETURNING next_seq",
		convID).Scan(&next)
	return next, err
}

// ---- 幂等缓存(V3 §4.1:clientMsgId 去重前置到 Redis,DB 唯一约束兜底) ----

// CheckIdempotency 查幂等缓存:命中返回 true(调用方查库取首次结果,不再 INCR/INSERT)。
func CheckIdempotency(ctx context.Context, convID string, senderID int64, clientMsgID string) (bool, error) {
	n, err := store.Redis().Exists(ctx, idemKey(convID, senderID, clientMsgID)).Result()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// MarkIdempotent 写入幂等缓存(SET NX + 短 TTL;命中失败(已存在)也视为成功)。
func MarkIdempotent(ctx context.Context, convID string, senderID int64, clientMsgID string) {
	_ = store.Redis().SetNX(ctx, idemKey(convID, senderID, clientMsgID), "1", 5*time.Minute).Err()
}

// ---- checkpoint:定期把 Redis 发号位点 GREATEST 写回 PG ----

var (
	knownConvs   = make(map[string]struct{})
	knownConvsMu sync.Mutex
)

func rememberConv(convID string) {
	knownConvsMu.Lock()
	knownConvs[convID] = struct{}{}
	knownConvsMu.Unlock()
}

func snapshotConvs() []string {
	knownConvsMu.Lock()
	defer knownConvsMu.Unlock()
	out := make([]string, 0, len(knownConvs))
	for k := range knownConvs {
		out = append(out, k)
	}
	knownConvs = make(map[string]struct{})
	return out
}

// StartCheckpointLoop 启动定期 checkpoint goroutine(每 interval 把本进程发过号的会话位点写回 PG)。
// 位点写入用 GREATEST 单调,乱序/并发 checkpoint 不会倒退。
func StartCheckpointLoop(ctx context.Context, interval time.Duration, logger *slog.Logger) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := CheckpointAll(ctx); err != nil {
					logger.Warn("seq checkpoint 失败", "err", err)
				}
			}
		}
	}()
}

// CheckpointAll 把本进程近期发过号的会话位点从 Redis 写回 PG(GREATEST 单调)。
func CheckpointAll(ctx context.Context) error {
	rdb := store.Redis()
	for _, convID := range snapshotConvs() {
		v, err := rdb.Get(ctx, seqKey(convID)).Int64()
		if err != nil {
			if errors.Is(err, redis.Nil) {
				continue
			}
			return fmt.Errorf("读 %s: %w", seqKey(convID), err)
		}
		if _, err := store.PG().Exec(ctx,
			"UPDATE conversations SET next_seq = GREATEST(next_seq, $2) WHERE id = $1",
			convID, v); err != nil {
			return fmt.Errorf("checkpoint %s: %w", convID, err)
		}
	}
	return nil
}
