package service

import (
	"context"
	"encoding/json"

	"github.com/our-chat/biz/internal/store"
)

// downlink.go:gw:downlink 频道下行(payload 对齐 contracts/ws.ts 的 buildDownlink)。
// 网关订阅后按 userId/targetDeviceId/exceptDeviceId 代投,frame 原样转发给客户端。

// DownlinkChannel 下行频道(与 Node push.ts/internal.ts 同一频道)。
const DownlinkChannel = "gw:downlink"

// DownlinkFrame 客户端最终收到的 WS 帧信封 {type,data}。
type DownlinkFrame struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// downlinkPayload 频道载荷(ws.ts:17-22;未用的过滤字段不出现在 JSON 里)。
type downlinkPayload struct {
	UserID         int64          `json:"userId"`
	Frame          DownlinkFrame  `json:"frame"`
	TargetDeviceID string         `json:"targetDeviceId,omitempty"`
	ExceptDeviceID string         `json:"exceptDeviceId,omitempty"`
}

// DownlinkOpts 投递过滤选项(target/except 互斥,由调用方保证)。
type DownlinkOpts struct {
	TargetDeviceID string
	ExceptDeviceID string
}

// PublishDownlink 把一条下行帧 publish 给指定用户(handleUplink.ts:20-26 同语义)。
func PublishDownlink(ctx context.Context, userID int64, typ string, data any, opts *DownlinkOpts) error {
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

// EmitToUser best-effort 推送(push.ts:34-38;失败只记日志不影响主流程)。
func EmitToUser(ctx context.Context, userID int64, event string, payload any) {
	if err := PublishDownlink(ctx, userID, event, payload, nil); err != nil {
		logDownlinkError(err)
	}
}
