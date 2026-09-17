package service

import (
	"context"
	"sync"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/our-chat/biz/internal/store"
)

// setupTestRedis 把全局 store.Redis() 指向 miniredis(测试隔离)。
func setupTestRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	mr, err := miniredis.Run()
	require.NoError(t, err)
	t.Cleanup(mr.Close)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	store.SetRedisForTest(client)
	return mr
}

// TestTryCreateSessionBusy 忙线裁决:被叫在另一通话 → false;空 → true。
func TestTryCreateSessionBusy(t *testing.T) {
	setupTestRedis(t)
	ctx := context.Background()

	s1 := &CallSession{CallID: "call_1_2_100", CallerID: 1, CalleeID: 2, CallType: "voice", Status: "ringing"}
	ok, err := TryCreateSession(ctx, s1)
	require.NoError(t, err)
	assert.True(t, ok)

	// 用户 2 已被占用,3 打给 2 → busy
	s2 := &CallSession{CallID: "call_3_2_200", CallerID: 3, CalleeID: 2, CallType: "voice", Status: "ringing"}
	ok, err = TryCreateSession(ctx, s2)
	require.NoError(t, err)
	assert.False(t, ok)

	// 同一 callId 重试(重发)→ 幂等成功
	ok, err = TryCreateSession(ctx, s1)
	require.NoError(t, err)
	assert.True(t, ok)
}

// TestTryCreateSessionConcurrent 并发 call:start 同一被叫:原子裁决,至多一人成功。
// (Node 版 GET-then-SET 非原子,两副本并发可双接;此测试验证 Go 版修复。)
func TestTryCreateSessionConcurrent(t *testing.T) {
	setupTestRedis(t)
	ctx := context.Background()

	const n = 20
	var wg sync.WaitGroup
	wins := make(chan bool, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s := &CallSession{
				CallID:    "call_" + itoa64(int64(100+i)) + "_2_1",
				CallerID:  int64(100 + i),
				CalleeID:  2,
				CallType:  "voice",
				Status:    "ringing",
			}
			ok, err := TryCreateSession(ctx, s)
			if err != nil {
				t.Errorf("TryCreateSession err: %v", err)
				return
			}
			wins <- ok
		}(i)
	}
	wg.Wait()
	close(wins)

	winners := 0
	for ok := range wins {
		if ok {
			winners++
		}
	}
	assert.Equal(t, 1, winners, "并发 call:start 必须恰好一个成功(忙线裁决原子性)")
}

// TestCallLifecycle 完整生命周期:start→accept→rejoin→reconnecting→grace 清理。
func TestCallLifecycle(t *testing.T) {
	setupTestRedis(t)
	ctx := context.Background()

	s := &CallSession{CallID: "call_1_2_9", CallerID: 1, CalleeID: 2, CallType: "voice", Status: "ringing"}
	ok, err := TryCreateSession(ctx, s)
	require.NoError(t, err)
	assert.True(t, ok)

	// accept:ringing → connected,绑接听设备
	got, err := MarkAccepted(ctx, "call_1_2_9", "dev-b")
	require.NoError(t, err)
	assert.Equal(t, "connected", got.Status)
	assert.Equal(t, "dev-b", *got.CalleeDevice)
	assert.NotNil(t, got.StartTime)

	// rejoin:恢复状态 + epoch 自增
	before := got.GraceEpoch
	got, err = MarkRejoined(ctx, "call_1_2_9", "caller", "dev-a2")
	require.NoError(t, err)
	assert.Equal(t, "connected", got.Status)
	assert.Equal(t, before+1, got.GraceEpoch)
	assert.Equal(t, "dev-a2", *got.CallerDevice)

	// 属主掉线 → reconnecting(记录 resumeStatus)
	got, err = MarkReconnecting(ctx, "call_1_2_9", "dev-a2")
	require.NoError(t, err)
	assert.Equal(t, "reconnecting", got.Status)
	assert.Equal(t, "connected", got.ResumeStatus)

	// 非属主设备掉线 → 忽略(nil)
	got, err = MarkReconnecting(ctx, "call_1_2_9", "dev-other")
	require.NoError(t, err)
	assert.Nil(t, got)

	// 清理:会话与双索引都删
	cleared, err := ClearSession(ctx, "call_1_2_9")
	require.NoError(t, err)
	assert.NotNil(t, cleared)
	callID, err := GetUserCall(ctx, 1)
	require.NoError(t, err)
	assert.Empty(t, callID)
	again, err := GetCallSession(ctx, "call_1_2_9")
	require.NoError(t, err)
	assert.Nil(t, again)
}
