package service

import (
	"context"
	"encoding/json"

	edgev1 "github.com/our-chat/biz/internal/contracts/gen/ourchat/edge/v1"
	"github.com/our-chat/biz/internal/metrics"
	"github.com/our-chat/biz/internal/store"
)

// downlink.go:下行投递双通道(V3 §4.3 定向下行落地):
//   - 主通道:按 presence.replica 经 gRPC 下行流定向发给持有连接的网关副本
//     (gateway RouteToUser 回投;注册表与发送器由 realtime 包注入);
//   - 兜底:Redis gw:downlink pub/sub(副本未知/离线/发送失败时回退,网关订阅代投);
//   - 两通道帧形态一致({type,data} 客户端最终 WS 帧),gateway 原样转发。

// DownlinkChannel 下行频道(与 Node push.ts/internal.ts 同一频道)。
const DownlinkChannel = "gw:downlink"

// DownlinkFrame 客户端最终收到的 WS 帧信封 {type,data}。
type DownlinkFrame struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// downlinkPayload 频道载荷(ws.ts:17-22;未用的过滤字段不出现在 JSON 里)。
type downlinkPayload struct {
	UserID         int64         `json:"userId"`
	Frame          DownlinkFrame `json:"frame"`
	TargetDeviceID string        `json:"targetDeviceId,omitempty"`
	ExceptDeviceID string        `json:"exceptDeviceId,omitempty"`
}

// DownlinkOpts 投递过滤选项(target/except 互斥,由调用方保证)。
type DownlinkOpts struct {
	TargetDeviceID string
	ExceptDeviceID string
}

// directDownlink 定向下行发送器(realtime.StartEdge 时注入;nil=未启用,全走 pub/sub)。
var directDownlink func(ctx context.Context, replica string, frame *edgev1.DownlinkFrame) bool

// SetDirectDownlink 注入定向下行发送器(仅 realtime 包调用)。
func SetDirectDownlink(fn func(ctx context.Context, replica string, frame *edgev1.DownlinkFrame) bool) {
	directDownlink = fn
}

// tryDirect 对单个用户尝试定向下行:查 presence replica → 组 DownlinkFrame → 定向发送。
// 成功返回 true;presence 无在线记录/无副本标识/发送失败返回 false(走 pub/sub 兜底)。
func tryDirect(ctx context.Context, userID int64, typ string, data any, opts *DownlinkOpts) bool {
	if directDownlink == nil {
		return false
	}
	replica, err := ReplicaOf(ctx, userID)
	if err != nil || replica == "" {
		return false
	}
	frameData, err := json.Marshal(DownlinkFrame{Type: typ, Data: data})
	if err != nil {
		return false
	}
	f := &edgev1.DownlinkFrame{UserId: userID, RawFrame: frameData}
	if opts != nil {
		f.TargetDeviceId = opts.TargetDeviceID
		f.ExceptDeviceId = opts.ExceptDeviceID
	}
	return directDownlink(ctx, replica, f)
}

// PublishDownlink 把一条下行帧投给指定用户(handleUplink.ts:20-26 同语义)。
// 定向优先,失败回退 pub/sub。
func PublishDownlink(ctx context.Context, userID int64, typ string, data any, opts *DownlinkOpts) error {
	if tryDirect(ctx, userID, typ, data, opts) {
		metrics.DownlinkDirectTotal.Inc()
		return nil
	}
	metrics.DownlinkFallbackTotal.Inc()
	payload := downlinkPayload{UserID: userID, Frame: DownlinkFrame{Type: typ, Data: data}}
	if opts != nil {
		payload.TargetDeviceID = opts.TargetDeviceID
		payload.ExceptDeviceID = opts.ExceptDeviceID
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return store.Redis().Publish(ctx, DownlinkChannel, raw).Err()
}

// FanoutDownlink 把同一帧批量投给多个用户(群扇出/单聊双方)。
// 定向成功者直发;其余回退 pub/sub pipeline 单次往返(O3 成果保留)。
func FanoutDownlink(ctx context.Context, userIDs []int64, typ string, data any) {
	if len(userIDs) == 0 {
		return
	}
	// 批量查 replica(2 次 pipeline 往返:在线判定 + meta 解析)
	replicas, _ := ReplicaOfBatch(ctx, userIDs)
	fallback := make([]int64, 0, len(userIDs))
	var frameData []byte
	for _, uid := range userIDs {
		rep, ok := replicas[uid]
		if ok && rep != "" {
			if frameData == nil {
				frameData, _ = json.Marshal(DownlinkFrame{Type: typ, Data: data})
			}
			if directDownlink != nil && directDownlink(ctx, rep, &edgev1.DownlinkFrame{UserId: uid, RawFrame: frameData}) {
				metrics.DownlinkDirectTotal.Inc()
				continue
			}
		}
		fallback = append(fallback, uid)
	}
	if len(fallback) == 0 {
		return
	}
	metrics.DownlinkFallbackTotal.Add(float64(len(fallback)))

	rdb := store.Redis()
	pipe := rdb.Pipeline()
	for _, uid := range fallback {
		payload := downlinkPayload{UserID: uid, Frame: DownlinkFrame{Type: typ, Data: data}}
		raw, err := json.Marshal(payload)
		if err != nil {
			logDownlinkError(err)
			continue
		}
		pipe.Publish(ctx, DownlinkChannel, raw)
	}
	if _, err := pipe.Exec(ctx); err != nil && !isRedisNil(err) {
		logDownlinkError(err)
	}
}

// EmitToUser best-effort 推送(push.ts:34-38;失败只记日志不影响主流程)。
func EmitToUser(ctx context.Context, userID int64, event string, payload any) {
	if err := PublishDownlink(ctx, userID, event, payload, nil); err != nil {
		logDownlinkError(err)
	}
}
