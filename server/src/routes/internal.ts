// Go 连接网关的内部端点(HTTP 模式,回滚兼容保留)。网关只管连接,业务仍在 Node:
// 网关把客户端上行帧透传到这里,由 Node 复用既有落库/发号/幂等/读扩散逻辑处理,
// 再把下行 publish 到 gw:downlink 由网关代投(docs 16 §5.4)。
// 业务处理逻辑已抽到 realtime/handleUplink.ts,与 gRPC 流服务(edgeGrpc)共用同一份实现。
//
// 鉴权:X-Gateway-Token 必须等于共享内部令牌,杜绝该端点被外部直接调用伪造身份。
// 身份:senderId 取自 X-User-Id(网关已验签),不信任帧内自报的 senderId;设备取 X-Device-Id。
import { Router } from 'express';
import type { Request, Response } from 'express';
import { handleUplink } from '../realtime/handleUplink.js';
import { handleDisconnect } from '../realtime/callRelay.js';

const router = Router();

const INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || 'dev-internal-token';

router.post('/gateway/uplink', async (req: Request, res: Response) => {
  if (req.header('X-Gateway-Token') !== INTERNAL_TOKEN) {
    return res.status(401).json({ type: 'message.error', message: '内部令牌校验失败' });
  }
  const userId = Number(req.header('X-User-Id'));
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ type: 'message.error', message: '缺少合法的用户身份' });
  }
  const deviceId = String(req.header('X-Device-Id') ?? '');

  const result = await handleUplink(req.body, { userId, deviceId });
  if (result.status === 204) return res.status(204).end();
  return res.status(result.status).json(result.body);
});

// ===== 断连通知:网关连接断开 → 通话 grace 重连窗 =====
router.post('/gateway/disconnect', async (req: Request, res: Response) => {
  if (req.header('X-Gateway-Token') !== INTERNAL_TOKEN) {
    return res.status(401).json({ type: 'message.error', message: '内部令牌校验失败' });
  }
  const userId = Number(req.header('X-User-Id'));
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ type: 'message.error', message: '缺少合法的用户身份' });
  }
  const deviceId = String(req.header('X-Device-Id') ?? '');
  await handleDisconnect(userId, deviceId);
  return res.status(204).end();
});

export default router;
