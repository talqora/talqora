package service

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/our-chat/biz/internal/store"
)

// ratelimit.go:会话热点限流(V3 §4.3「单会话消息率超限时按会话限流」)。
// 单会话消息率在 1s 窗口内超阈值 → 拒绝(保护发号与扇出路径,热点会话不拖垮全站)。
// 多副本安全:Redis 全局计数;Redis 故障 fail-open(保护性限流不应叠加中间件故障)。

// convRateLimitMax 会话消息率阈值(0=未启用);由 main 装配。
var convRateLimitMax atomic.Int64

// convRateWindowSec 限流窗口秒数(默认 1s)。
var convRateWindowSec atomic.Int64

// SetConvRateLimit 装配会话限流参数(max<=0 表示禁用)。
func SetConvRateLimit(max int, window time.Duration) {
	convRateLimitMax.Store(int64(max))
	sec := int64(window / time.Second)
	if sec < 1 {
		sec = 1
	}
	convRateWindowSec.Store(sec)
}

// convRateLua 原子计数:INCR;首值(计数=1)时设 TTL,窗口滑动由 TTL 近似实现。
// 计数超限即拒绝,不区分"谁发的"——保护的是会话级扇出/写入总量。
var convRateLua = redis.NewScript(`
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return n
`)

func convRateKey(convID string) string { return "conv:rate:" + convID }

// CheckConvRate 会话热点限流判定:返回 true 表示应拒绝本消息。
// 窗口内计数超过阈值时拒绝;Redis 故障返回 false(fail-open)。
func CheckConvRate(ctx context.Context, convID string) bool {
	max := convRateLimitMax.Load()
	if max <= 0 {
		return false
	}
	win := convRateWindowSec.Load()
	n, err := convRateLua.Run(ctx, store.Redis(), []string{convRateKey(convID)}, win).Int()
	if err != nil {
		return false
	}
	return n > int(max)
}
