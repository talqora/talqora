package realtime

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/our-chat/biz/internal/metrics"
	"github.com/our-chat/biz/internal/service"
)

// callRelay.go:通话信令 + 断连 grace,语义对齐 server/src/realtime/callRelay.ts。
// 下行经 gw:downlink(targetDeviceId/exceptDeviceId 与 buildDownlink 一致)。

// HandleCallEvent 处理一条通话信令上行帧(callRelay.ts:36-148)。
func HandleCallEvent(ctx context.Context, eventType string, uctx UplinkContext, data json.RawMessage) UplinkResult {
	callID := jsonField(data, "callId")

	switch eventType {
	case "call:start": {
		metrics.CallEventsTotal.WithLabelValues("start").Inc()
		calleeID, ok := parseID(jsonField(data, "to"))
		if callID == "" || !ok || calleeID <= 0 {
			return UplinkResult{Status: 400, Body: map[string]any{"type": "call:error", "message": "缺少 callId 或合法被叫"}}
		}
		callType := jsonField(data, "callType")
		if callType == "" {
			callType = "voice"
		}
		created, err := service.TryCreateSession(ctx, &service.CallSession{
			CallID:       callID,
			CallerID:     uctx.UserID,
			CalleeID:     calleeID,
			CallType:     callType,
			Status:       "ringing",
			StartTime:    nil,
			CallerDevice: strPtr(uctx.DeviceID),
			CalleeDevice: nil,
			GraceEpoch:   0,
		})
		if err != nil {
			return UplinkResult{Status: 500, Body: map[string]any{"type": "call:error", "message": "信令处理失败"}}
		}
		if !created {
			metrics.CallEventsTotal.WithLabelValues("busy").Inc()
			// 仅回主叫本设备,不打扰被叫(callRelay.ts:58-62)
			return UplinkResult{Status: 200, Body: map[string]any{"type": "call:busy", "data": map[string]any{"callId": callID}}}
		}
		metrics.ActiveCalls.Inc()
		_ = service.PublishDownlink(ctx, calleeID, "call:start", rawJSON(data), nil)
		return UplinkResult{Status: 204}
	}

	case "call:accept": {
		metrics.CallEventsTotal.WithLabelValues("accept").Inc()
		if _, err := service.MarkAccepted(ctx, callID, uctx.DeviceID); err != nil {
			return UplinkResult{Status: 500, Body: map[string]any{"type": "call:error", "message": "信令处理失败"}}
		}
		toID, _ := parseID(jsonField(data, "to"))
		if toID > 0 {
			_ = service.PublishDownlink(ctx, toID, "call:accept", rawJSON(data), nil)
		}
		_ = service.PublishDownlink(ctx, uctx.UserID, "call:handled",
			map[string]any{"callId": callID, "status": "accepted"},
			&service.DownlinkOpts{ExceptDeviceID: uctx.DeviceID})
		return UplinkResult{Status: 204}
	}

	case "call:reject": {
		metrics.CallEventsTotal.WithLabelValues("reject").Inc()
		s, err := service.ClearSession(ctx, callID)
		if err != nil {
			return UplinkResult{Status: 500, Body: map[string]any{"type": "call:error", "message": "信令处理失败"}}
		}
		if s != nil {
			metrics.ActiveCalls.Dec()
		}
		callerID := int64(0)
		if s != nil {
			callerID = s.CallerID
		} else if parts := strings.Split(callID, "_"); len(parts) > 1 {
			callerID, _ = strconv.ParseInt(parts[1], 10, 64)
		}
		if callerID > 0 {
			_ = service.PublishDownlink(ctx, callerID, "call:reject", rawJSON(data), nil)
		}
		_ = service.PublishDownlink(ctx, uctx.UserID, "call:handled",
			map[string]any{"callId": callID, "status": "rejected"},
			&service.DownlinkOpts{ExceptDeviceID: uctx.DeviceID})
		return UplinkResult{Status: 204}
	}

	case "call:end": {
		metrics.CallEventsTotal.WithLabelValues("end").Inc()
		s, err := service.ClearSession(ctx, callID)
		if err != nil {
			return UplinkResult{Status: 500, Body: map[string]any{"type": "call:error", "message": "信令处理失败"}}
		}
		if s != nil {
			metrics.ActiveCalls.Dec()
		}
		parts := strings.Split(callID, "_")
		if len(parts) > 2 {
			id1, err1 := strconv.ParseInt(parts[1], 10, 64)
			id2, err2 := strconv.ParseInt(parts[2], 10, 64)
			if err1 == nil && id1 > 0 {
				_ = service.PublishDownlink(ctx, id1, "call:end", rawJSON(data), nil)
			}
			if err2 == nil && id2 > 0 && id2 != id1 {
				_ = service.PublishDownlink(ctx, id2, "call:end", rawJSON(data), nil)
			}
		}
		return UplinkResult{Status: 204}
	}

	case "call:rejoin": {
		metrics.CallEventsTotal.WithLabelValues("rejoin").Inc()
		s, err := service.GetCallSession(ctx, callID)
		if err != nil {
			return UplinkResult{Status: 500, Body: map[string]any{"type": "call:error", "message": "信令处理失败"}}
		}
		if s == nil {
			// 会话已不存在:让重连方干净收场(callRelay.ts:113-116)
			return UplinkResult{Status: 200, Body: map[string]any{"type": "call:end", "data": map[string]any{"callId": callID}}}
		}
		side := "callee"
		peerID := s.CallerID
		if uctx.UserID == s.CallerID {
			side = "caller"
			peerID = s.CalleeID
		}
		updated, err := service.MarkRejoined(ctx, callID, side, uctx.DeviceID)
		if err != nil {
			return UplinkResult{Status: 500, Body: map[string]any{"type": "call:error", "message": "信令处理失败"}}
		}
		peerDevice := ""
		if updated != nil {
			if side == "caller" {
				if updated.CalleeDevice != nil {
					peerDevice = *updated.CalleeDevice
				}
			} else if updated.CallerDevice != nil {
				peerDevice = *updated.CallerDevice
			}
		}
		if peerDevice != "" {
			// 精确投给对端属主设备(属主路由,callRelay.ts:121-123)
			_ = service.PublishDownlink(ctx, peerID, "call:rejoin", rawJSON(data),
				&service.DownlinkOpts{TargetDeviceID: peerDevice})
		} else {
			_ = service.PublishDownlink(ctx, peerID, "call:rejoin", rawJSON(data), nil)
		}
		return UplinkResult{Status: 204}
	}

	case "call:ice": {
		metrics.CallEventsTotal.WithLabelValues("ice").Inc()
		parts := strings.Split(callID, "_")
		if len(parts) > 2 {
			id1, err1 := strconv.ParseInt(parts[1], 10, 64)
			id2, err2 := strconv.ParseInt(parts[2], 10, 64)
			if err1 == nil && id1 > 0 {
				_ = service.PublishDownlink(ctx, id1, "call:ice", rawJSON(data),
					&service.DownlinkOpts{ExceptDeviceID: uctx.DeviceID})
			}
			if err2 == nil && id2 > 0 && id2 != id1 {
				_ = service.PublishDownlink(ctx, id2, "call:ice", rawJSON(data),
					&service.DownlinkOpts{ExceptDeviceID: uctx.DeviceID})
			}
		}
		return UplinkResult{Status: 204}
	}

	default:
		return UplinkResult{Status: 400, Body: map[string]any{"type": "message.error", "message": "不支持的上行类型: " + eventType}}
	}
}

// HandleDisconnect 断连通知:属主设备掉线 → reconnecting → 通知对端 → grace 窗内无人 rejoin 则结束。
// (callRelay.ts:152-172;epoch 校验使在途 grace 定时器跨副本失效。)
func HandleDisconnect(ctx context.Context, userID int64, deviceID string, logger *slog.Logger) {
	callID, err := service.GetUserCall(ctx, userID)
	if err != nil || callID == "" {
		return
	}
	s, err := service.MarkReconnecting(ctx, callID, deviceID)
	if err != nil || s == nil {
		return // 非属主设备掉线,忽略(callRelay.ts:156)
	}
	peerID := s.CalleeID
	if userID == s.CalleeID {
		peerID = s.CallerID
	}
	_ = service.PublishDownlink(ctx, peerID, "call:peer-reconnecting", map[string]any{"callId": callID}, nil)

	// grace 到点:重读 Redis,仍 reconnecting 且 epoch 未变(无人 rejoin)→ 结束
	epoch := s.GraceEpoch
	go func() {
		time.Sleep(GraceMS * time.Millisecond)
		cur, err := service.GetCallSession(context.Background(), callID)
		if err != nil {
			logger.Warn("grace 重读会话失败", "callId", callID, "err", err)
			return
		}
		if cur != nil && cur.Status == "reconnecting" && cur.GraceEpoch == epoch {
			cleared, err := service.ClearSession(context.Background(), callID)
			if err != nil {
				logger.Warn("grace 清理会话失败", "callId", callID, "err", err)
				return
			}
			if cleared != nil {
				_ = service.PublishDownlink(context.Background(), cleared.CallerID, "call:end",
					map[string]any{"callId": callID}, nil)
				_ = service.PublishDownlink(context.Background(), cleared.CalleeID, "call:end",
					map[string]any{"callId": callID}, nil)
			}
		}
	}()
}

// GraceMS grace 宽限窗(与 service.GraceMS 一致)。
const GraceMS = service.GraceMS

// ---- helpers ----

func jsonField(data json.RawMessage, key string) string {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return ""
	}
	raw, ok := m[key]
	if !ok {
		return ""
	}
	// 尝试字符串
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	// 尝试数字(JSON number)
	var f float64
	if err := json.Unmarshal(raw, &f); err == nil {
		return strconv.FormatInt(int64(f), 10)
	}
	return string(raw)
}

// parseID 解析 to 字段:可能直接是数字,也可能是对象 {id}。
func parseID(field string) (int64, bool) {
	if field == "" {
		return 0, false
	}
	if strings.HasPrefix(field, "{") {
		var obj struct {
			ID any `json:"id"`
		}
		if err := json.Unmarshal([]byte(field), &obj); err != nil {
			return 0, false
		}
		switch t := obj.ID.(type) {
		case float64:
			return int64(t), true
		case string:
			n, err := strconv.ParseInt(t, 10, 64)
			return n, err == nil
		}
		return 0, false
	}
	n, err := strconv.ParseInt(field, 10, 64)
	return n, err == nil
}

func strPtr(v string) *string { return &v }

// rawJSON 把原始 JSON 对象直接作为 payload 传出(信令帧原样转发,callRelay.ts 同语义)。
func rawJSON(data json.RawMessage) map[string]json.RawMessage {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return nil
	}
	return m
}

// parseNonnegAny 非负整数宽松解析。
func parseNonnegAny(v any) (int64, bool) {
	switch t := v.(type) {
	case float64:
		if t >= 0 && t == float64(int64(t)) {
			return int64(t), true
		}
		return 0, false
	case string:
		n, err := strconv.ParseInt(t, 10, 64)
		return n, err == nil && n >= 0
	default:
		return 0, false
	}
}

func logWarn(msg string, err error)  { slog.Default().Warn(msg, "err", err) }
func logDownlinkWarn(err error)      { slog.Default().Warn("下行 publish 失败", "err", err) }
