import { z } from 'zod';

// WebSocket 帧信封契约(gateway /ws 链路)。作为 server 与 web/gateway 对齐的单一真相:
// 上行帧 {type, data} 由网关透传;下行帧由 server publish 到 gw:downlink 由网关代投。

// 客户端 ⇄ 服务端统一信封。信封层不枚举业务类型(type 是开放字符串),
// 业务校验由各 type 对应的 schema 在分发处做(如 sendMessageInput)。
export const wsEnvelope = z.object({
  type: z.string().min(1).max(64),
  data: z.unknown().optional(),
});
export type WsEnvelope = z.infer<typeof wsEnvelope>;

// gw:downlink 频道载荷。frame 是客户端最终收到的 WS 帧(信封原样,网关不解析)。
// targetDeviceId: 仅投给指定设备(call:rejoin 属主路由);exceptDeviceId: 投给该用户
// 除指定设备外的全部连接(read.sync/call:handled 排除本端)。二者互斥,由调用方保证。
export const downlinkPayload = z.object({
  userId: z.number().int().positive(),
  frame: wsEnvelope,
  targetDeviceId: z.string().min(1).max(64).optional(),
  exceptDeviceId: z.string().min(1).max(64).optional(),
});
export type DownlinkPayload = z.infer<typeof downlinkPayload>;

// 构造下行载荷的 helper:未用的过滤字段不出现在 JSON 里(undefined 键)。
export function buildDownlink(
  userId: number,
  type: string,
  data?: unknown,
  opts?: { targetDeviceId?: string; exceptDeviceId?: string },
): DownlinkPayload {
  const payload: DownlinkPayload = { userId, frame: { type, data } };
  if (opts?.targetDeviceId) payload.targetDeviceId = opts.targetDeviceId;
  if (opts?.exceptDeviceId) payload.exceptDeviceId = opts.exceptDeviceId;
  return payload;
}
