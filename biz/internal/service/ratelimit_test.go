package service

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/our-chat/biz/internal/store"
)

// TestCheckConvRateLimit 窗口内计数超限拒绝,窗口滑动后恢复(经 TTL 过期近似)。
func TestCheckConvRateLimit(t *testing.T) {
	rdb := newTestRedis(t)
	store.SetRedisForTest(rdb)
	SetConvRateLimit(5, time.Second)
	t.Cleanup(func() { SetConvRateLimit(0, 0) })

	ctx := context.Background()
	for i := 0; i < 5; i++ {
		assert.False(t, CheckConvRate(ctx, "group_hot"), "第 %d 条不应拒绝", i+1)
	}
	assert.True(t, CheckConvRate(ctx, "group_hot"), "第 6 条应拒绝")
	// 其它会话不受影响
	assert.False(t, CheckConvRate(ctx, "group_cold"))

	// 窗口过期(1s TTL)后恢复
	require.NoError(t, rdb.Del(ctx, convRateKey("group_hot")).Err())
	assert.False(t, CheckConvRate(ctx, "group_hot"))
}

// TestCheckConvRateDisabled 未装配(0)时不启用,且不产生 Redis 调用。
func TestCheckConvRateDisabled(t *testing.T) {
	SetConvRateLimit(0, time.Second)
	t.Cleanup(func() { SetConvRateLimit(0, 0) })
	assert.False(t, CheckConvRate(context.Background(), "group_x"))
}
