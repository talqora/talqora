package service

import (
	"context"
	"errors"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestRedis(t *testing.T) *redis.Client {
	t.Helper()
	mr, err := miniredis.Run()
	require.NoError(t, err)
	t.Cleanup(mr.Close)
	return redis.NewClient(&redis.Options{Addr: mr.Addr()})
}

// TestNextSeqFreshKey 键缺失 → 装载 PG 初始值后自增(首条 seq = init+1)。
func TestNextSeqFreshKey(t *testing.T) {
	rdb := newTestRedis(t)
	ctx := context.Background()

	seq, err := nextSeqWith(ctx, rdb, "single_1_2",
		func(context.Context) (int64, error) { return 0, nil },
		func(context.Context) (int64, error) { return 0, errors.New("不应降级") },
	)
	require.NoError(t, err)
	assert.Equal(t, int64(1), seq)

	// 键已存在:后续直接 INCR
	seq, err = nextSeqWith(ctx, rdb, "single_1_2",
		func(context.Context) (int64, error) { return 999, nil },
		func(context.Context) (int64, error) { return 0, errors.New("不应降级") },
	)
	require.NoError(t, err)
	assert.Equal(t, int64(2), seq)
}

// TestNextSeqLoadFromPG 已有 PG 位点的装载(seq = next_seq+1)。
func TestNextSeqLoadFromPG(t *testing.T) {
	rdb := newTestRedis(t)
	ctx := context.Background()

	seq, err := nextSeqWith(ctx, rdb, "group_9",
		func(context.Context) (int64, error) { return 42, nil },
		func(context.Context) (int64, error) { return 0, errors.New("不应降级") },
	)
	require.NoError(t, err)
	assert.Equal(t, int64(43), seq)
}

// TestNextSeqRedisDown 快路径与 Lua 都失败 → 降级 DB 行锁路径。
func TestNextSeqRedisDown(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()
	mr.Close() // 模拟 Redis 失联

	seq, err := nextSeqWith(ctx, rdb, "single_1_2",
		func(context.Context) (int64, error) { return 0, nil },
		func(context.Context) (int64, error) { return 7, nil }, // DB 行锁返回 7
	)
	require.NoError(t, err)
	assert.Equal(t, int64(7), seq)
}

// TestNextSeqConcurrentFresh 并发首条消息:装载 + INCR 原子,seq 严格递增无重复。
func TestNextSeqConcurrentFresh(t *testing.T) {
	rdb := newTestRedis(t)
	ctx := context.Background()

	const n = 50
	results := make(chan int64, n)
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() {
			seq, err := nextSeqWith(ctx, rdb, "single_9_9",
				func(context.Context) (int64, error) { return 0, nil },
				func(context.Context) (int64, error) { return 0, errors.New("不应降级") },
			)
			if err != nil {
				errs <- err
				return
			}
			results <- seq
		}()
	}
	seen := map[int64]bool{}
	for i := 0; i < n; i++ {
		select {
		case err := <-errs:
			t.Fatalf("并发发号失败: %v", err)
		case seq := <-results:
			assert.False(t, seen[seq], "seq 重复: %d", seq)
			seen[seq] = true
		}
	}
	assert.Len(t, seen, n)
}

// TestNextSeqKeyRebuild 防回卷:Redis 键丢失(重启)后 INCR 从 0 重建,
// 快路径检测「结果不大于本地最后值」→ 回慢路径按 DB 实际最大值重新装载。
func TestNextSeqKeyRebuild(t *testing.T) {
	ctx := context.Background()
	convID := "single_51_52"

	// 前置:本进程已初始化过该会话,最后发号值 100。
	seqInitialized.Store(convID, struct{}{})
	convLastSeq.Store(convID, int64(100))
	t.Cleanup(func() {
		seqInitialized.Delete(convID)
		convLastSeq.Delete(convID)
	})

	// 全新 miniredis(模拟键丢失):裸 INCR 会返回 1。
	rdb := newTestRedis(t)

	// PG 侧装载值 = GREATEST(next_seq, max(messages.seq)) = 100(模拟已入库到 100)。
	loadCalls := 0
	seq, err := nextSeq(ctx, rdb, convID,
		func(context.Context) (int64, error) { loadCalls++; return 100, nil },
		func(context.Context) (int64, error) { return 0, errors.New("不应降级") },
	)
	require.NoError(t, err)
	assert.Equal(t, int64(101), seq, "键重建后必须从 DB 最大值继续,不得回卷")
	assert.Equal(t, 1, loadCalls, "应回慢路径重新装载")

	// 恢复快路径:后续 INCR 单调递增。
	seq2, err := nextSeq(ctx, rdb, convID,
		func(context.Context) (int64, error) { loadCalls++; return 0, nil },
		func(context.Context) (int64, error) { return 0, errors.New("不应降级") },
	)
	require.NoError(t, err)
	assert.Equal(t, int64(102), seq2)
	assert.Equal(t, 1, loadCalls, "快路径命中,不得重复装载")
}

// TestDeriveParticipants 单聊双方解析/异常回落。
func TestDeriveParticipants(t *testing.T) {
	assert.Equal(t, []int64{1, 2}, DeriveParticipants("single_1_2", 1))
	assert.Equal(t, []int64{2, 1}, DeriveParticipants("single_2_1", 1))
	assert.Equal(t, []int64{9}, DeriveParticipants("single_x_1", 9))
	assert.Equal(t, []int64{9}, DeriveParticipants("group_5", 9))
}

// TestParseMentionIDs 只保留会话成员交集,过滤非法/越权 id。
func TestParseMentionIDs(t *testing.T) {
	ids := ParseMentionIDs([]byte(`[2, "3", "abc", 999]`), []int64{2, 3, 4})
	assert.Equal(t, []int64{2, 3}, ids)
	assert.Nil(t, ParseMentionIDs([]byte(`not-json`), []int64{1}))
	assert.Empty(t, ParseMentionIDs(nil, []int64{1}))
}
