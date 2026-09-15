// Go 连接网关的内部端点。网关只管连接,业务仍在 Node:网关把客户端上行帧透传到这里,
// 由 Node 复用既有落库/发号/幂等/读扩散逻辑处理,再把下行 publish 到 gw:downlink 由网关代投(docs 16 §5.4)。
//
// 鉴权:X-Gateway-Token 必须等于共享内部令牌,杜绝该端点被外部直接调用伪造身份。
// 身份:senderId 取自 X-User-Id(网关已验签),不信任帧内自报的 senderId;设备取 X-Device-Id。
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Prisma } from '../generated/prisma/index.js';
import { sendMessageInput } from '../contracts/message.js';
import {
  persistMessage,
  getConversationMembers,
  markMentions,
} from '../services/message.js';
import { filterOnline } from '../realtime/presence.js';
import { handleCallEvent, handleDisconnect } from '../realtime/callRelay.js';
import { redis } from '../database/redis.js';

const router = Router();

const INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || 'dev-internal-token';
const DOWNLINK_CHANNEL = 'gw:downlink';

// 把一条下行帧 publish 给指定用户(网关订阅 gw:downlink 后投给该用户在其副本的全部连接)。
const publishDownlink = (userId: number, type: string, data: unknown): Promise<number> =>
  redis.publish(DOWNLINK_CHANNEL, JSON.stringify({ userId, frame: { type, data } }));

// 从客户端上报的 mentions 里只保留「确实是本会话成员」的 id,杜绝跨会话伪造 @(与 socket.ts 同源约束)。
const parseMentionIds = (raw: unknown, participants: bigint[]): bigint[] => {
  if (!Array.isArray(raw)) return [];
  const memberSet = new Set(participants.map((p) => p.toString()));
  const out: bigint[] = [];
  for (const v of raw) {
    const s = String(v);
    if (/^\d+$/.test(s) && memberSet.has(s)) out.push(BigInt(s));
  }
  return out;
};

router.post('/gateway/uplink', async (req: Request, res: Response) => {
  if (req.header('X-Gateway-Token') !== INTERNAL_TOKEN) {
    return res.status(401).json({ type: 'message.error', message: '内部令牌校验失败' });
  }
  const userId = Number(req.header('X-User-Id'));
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ type: 'message.error', message: '缺少合法的用户身份' });
  }
  const deviceId = String(req.header('X-Device-Id') ?? '');

  const frame = req.body as { type?: string; data?: unknown };
  const frameType = frame?.type;
  if (!frameType) {
    return res.status(400).json({ type: 'message.error', message: '缺少帧类型 type' });
  }

  // ===== 发消息:落库 + 读扩散扇出(网关侧唯一业务分支之外的既有权重路径) =====
  if (frameType === 'message.send') {
    // 兼容两种上行帧形态:
    //  ① {type:'message.send', data:{...消息载荷}} —— 推荐:信封 type 与消息载荷分离,
    //     消息自身的 type(如 'text')不会被信封的 'message.send' 覆盖(gateway 客户端用此形态)。
    //  ② 直接整帧即消息载荷(早期 PoC 形态)—— 兼容保留,此时消息 type 会等于信封 'message.send'。
    const payload = (frame.data ?? frame) as unknown;
    const parsed = sendMessageInput.safeParse(payload);
    if (!parsed.success) {
      return res.status(400).json({
        type: 'message.error',
        data: {
          message: '消息参数非法',
          clientMsgId: (frame as { clientMsgId?: string })?.clientMsgId,
        },
      });
    }
    const data = parsed.data;

    try {
      const senderId = BigInt(userId);
      const participantIds = await getConversationMembers(data.conversationId, senderId);
      const { message, deduped } = await persistMessage({
        conversationId: data.conversationId,
        senderId,
        clientMsgId: data.clientMsgId,
        content: data.content,
        type: data.type,
        mentions: data.mentions as Prisma.InputJsonValue,
        extra: data.extra as Prisma.InputJsonValue,
        fileInfo: data.fileInfo as Prisma.InputJsonValue,
        participantIds,
      });

      // 去重命中不重复扇出(对方已收过首次广播),仅回 ack 让发送方收敛本地状态。
      if (!deduped) {
        const isGroup = data.conversationId.startsWith('group_');
        const targets = isGroup
          ? await filterOnline(participantIds)
          : new Set(participantIds.map(Number));
        await Promise.all(
          [...targets].map((uid) => publishDownlink(uid, 'receiveMessage', message))
        );

        const mentioned = parseMentionIds(data.mentions, participantIds);
        if (mentioned.length) {
          await markMentions(data.conversationId, message.seq, mentioned);
          const onlineMentioned = await filterOnline(mentioned);
          await Promise.all(
            [...onlineMentioned].map((uid) =>
              publishDownlink(uid, 'mention', {
                conversationId: data.conversationId,
                seq: message.seq,
                serverMsgId: message.id,
              })
            )
          );
        }
      }

      return res.json({
        type: 'message.ack',
        data: {
          clientMsgId: data.clientMsgId,
          seq: message.seq,
          serverMsgId: message.id,
        },
      });
    } catch (err) {
      console.error('网关上行处理失败:', err);
      return res.status(500).json({
        type: 'message.error',
        data: { message: '消息发送失败', clientMsgId: data.clientMsgId },
      });
    }
  }

  // ===== 通话信令:忙线裁决/属主路由/grace 重连,状态机在 services/callSession =====
  if (frameType.startsWith('call:')) {
    try {
      const result = await handleCallEvent(
        frameType,
        userId,
        deviceId,
        (frame.data ?? {}) as Record<string, unknown>,
      );
      if (result.status === 204) return res.status(204).end();
      return res.status(result.status).json(result.body);
    } catch (err) {
      console.error('网关信令处理失败:', err);
      return res.status(500).json({ type: 'call:error', message: '信令处理失败' });
    }
  }

  return res.status(400).json({ type: 'message.error', message: `不支持的上行类型: ${frameType}` });
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
