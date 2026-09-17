package service

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/our-chat/biz/internal/store"
)

// call.go:通话会话权威状态(Redis),语义对齐 server/src/services/callSession.ts。
// 关键差异(修复 Node 缺陷,报告注明):tryCreateSession 的忙线裁决在 Node 是 GET-then-SET
// 非原子(两副本并发 call:start 可双接),Go 版用 Lua「GET 忙线 → SET 会话+双索引」原子完成。

// SessionTTL 会话兜底 TTL(1h,callSession.ts:10)。
const SessionTTL = 60 * 60

// GraceMS grace 宽限窗(12s,callSession.ts:12)。
const GraceMS = 12_000

// CallStatus 通话状态。
type CallStatus = string

// CallSide 通话侧。
type CallSide = string

// CallSession 通话会话(callSession.ts:17-28)。
type CallSession struct {
	CallID        string     `json:"callId"`
	CallerID      int64      `json:"callerId"`
	CalleeID      int64      `json:"calleeId"`
	CallType      string     `json:"callType"`
	Status        string     `json:"status"`
	StartTime     *int64     `json:"startTime"` // 毫秒时间戳
	CallerDevice  *string    `json:"callerDevice"`
	CalleeDevice  *string    `json:"calleeDevice"`
	GraceEpoch    int64      `json:"graceEpoch"`
	ResumeStatus  string     `json:"resumeStatus,omitempty"`
}

func callSessionKey(callID string) string { return "call:session:" + callID }
func callUserKey(userID int64) string     { return "call:user:" + strconv.FormatInt(userID, 10) }

// GetCallSession 读取会话,无则 nil(callSession.ts:33-36)。
func GetCallSession(ctx context.Context, callID string) (*CallSession, error) {
	raw, err := store.Redis().Get(ctx, callSessionKey(callID)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s CallSession
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func putCallSession(ctx context.Context, s *CallSession) error {
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return store.Redis().Set(ctx, callSessionKey(s.CallID), raw, SessionTTL*time.Second).Err()
}

// GetUserCall 用户当前通话索引,无则空(callSession.ts:43-45)。
func GetUserCall(ctx context.Context, userID int64) (string, error) {
	v, err := store.Redis().Get(ctx, callUserKey(userID)).Result()
	if err == redis.Nil {
		return "", nil
	}
	return v, err
}

// tryCreateLua 原子忙线裁决:被叫已在另一通通话 → 0;否则 SET 会话 + 双索引 → 1。
// (修复 callSession.ts:49-73 的 read-modify-write 竞态:两副本并发 call:start 不再双接。)
var tryCreateLua = redis.NewScript(`
local busy = redis.call('GET', KEYS[1])
if busy and busy ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
`)

// TryCreateSession 主叫发起:原子登记会话(ringing)+ 双方忙线索引。
// 返回 false 表示被叫忙线,调用方回 call:busy。
func TryCreateSession(ctx context.Context, s *CallSession) (bool, error) {
	raw, err := json.Marshal(s)
	if err != nil {
		return false, err
	}
	res, err := tryCreateLua.Run(ctx, store.Redis(),
		[]string{callUserKey(s.CalleeID), callSessionKey(s.CallID), callUserKey(s.CallerID)},
		s.CallID, raw, SessionTTL).Int()
	if err != nil {
		return false, err
	}
	return res == 1, nil
}

// MarkAccepted 被叫接听(callSession.ts:76-86):ringing 时绑定接听设备与起始时间。
func MarkAccepted(ctx context.Context, callID, calleeDevice string) (*CallSession, error) {
	s, err := GetCallSession(ctx, callID)
	if err != nil || s == nil {
		return s, err
	}
	if s.Status == "ringing" {
		s.CalleeDevice = strPtr(calleeDevice)
		if s.StartTime == nil {
			s.StartTime = int64Ptr(nowMillis())
		}
	}
	s.Status = "connected"
	return s, putCallSession(ctx, s)
}

// MarkRejoined 重连方回来(callSession.ts:89-107):更新属主设备,恢复重连前状态,epoch+1。
func MarkRejoined(ctx context.Context, callID string, side CallSide, device string) (*CallSession, error) {
	s, err := GetCallSession(ctx, callID)
	if err != nil || s == nil {
		return s, err
	}
	if side == "caller" {
		s.CallerDevice = strPtr(device)
	} else {
		s.CalleeDevice = strPtr(device)
	}
	if s.ResumeStatus != "" {
		s.Status = s.ResumeStatus
	} else {
		s.Status = "connected"
	}
	s.ResumeStatus = ""
	s.GraceEpoch++
	if err := putCallSession(ctx, s); err != nil {
		return nil, err
	}
	rdb := store.Redis()
	if err := rdb.Expire(ctx, callUserKey(s.CallerID), SessionTTL*time.Second).Err(); err != nil {
		return nil, err
	}
	if err := rdb.Expire(ctx, callUserKey(s.CalleeID), SessionTTL*time.Second).Err(); err != nil {
		return nil, err
	}
	return s, nil
}

// MarkReconnecting 属主设备掉线 → reconnecting(callSession.ts:111-124)。
func MarkReconnecting(ctx context.Context, callID, device string) (*CallSession, error) {
	s, err := GetCallSession(ctx, callID)
	if err != nil || s == nil {
		return s, err
	}
	isOwner := (s.CallerDevice != nil && *s.CallerDevice == device) ||
		(s.CalleeDevice != nil && *s.CalleeDevice == device)
	if !isOwner {
		return nil, nil
	}
	if s.Status != "reconnecting" {
		s.ResumeStatus = s.Status
	}
	s.Status = "reconnecting"
	s.GraceEpoch++
	return s, putCallSession(ctx, s)
}

// ClearSession 清理会话与双方索引,返回被清理的会话(callSession.ts:127-135)。
func ClearSession(ctx context.Context, callID string) (*CallSession, error) {
	s, err := GetCallSession(ctx, callID)
	if err != nil {
		return nil, err
	}
	rdb := store.Redis()
	if s != nil {
		if err := rdb.Del(ctx, callUserKey(s.CallerID)).Err(); err != nil {
			return nil, err
		}
		if err := rdb.Del(ctx, callUserKey(s.CalleeID)).Err(); err != nil {
			return nil, err
		}
	}
	if err := rdb.Del(ctx, callSessionKey(callID)).Err(); err != nil {
		return nil, err
	}
	return s, nil
}

func strPtr(v string) *string { return &v }
func int64Ptr(v int64) *int64 { return &v }
