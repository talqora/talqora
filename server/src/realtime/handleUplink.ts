// 网关上行帧的共用业务处理:被 HTTP 端点(/internal/gateway/uplink)与 gRPC 流服务(edgeGrpc)
// 共同复用——两条入口只差传输层,业务/落库/发号/幂等/扇出逻辑唯一一份(26-9-16 演进方案)。
// 身份(userId/deviceId)由网关注入(HTTP 头 / gRPC 帧头),不信任帧内自报的 senderId。
import type { Prisma } from '../generated/prisma/index.js';
import { sendMessageInput, readReportInput } from '../contracts/message.js';
import { buildDownlink } from '../contracts/ws.js';
import {
  persistMessage,
  getConversationMembers,
  markMentions,
} from '../services/message.js';
import { isConversationMember, advanceLastRead } from '../services/read.js';
import { filterOnline } from './presence.js';
import { handleCallEvent } from './callRelay.js';
import { redis } from '../database/redis.js';

const DOWNLINK_CHANNEL = 'gw:downlink';

// 把一条下行帧 publish 给指定用户(网关订阅 gw:downlink 后投给该用户在其副本的全部连接)。
export const publishDownlink = (
  userId: number,
  type: string,
  data: unknown,
  opts?: { exceptDeviceId?: string },
): Promise<number> =>
  redis.publish(DOWNLINK_CHANNEL, JSON.stringify(buildDownlink(userId, type, data, opts)));

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

export interface UplinkContext {
  userId: number;
  deviceId: string;
}

// 处理结果对齐 HTTP 语义:204=不回投(仅确认);200=回投 body;其余=错误。
export interface UplinkResult {
  status: number;
  body?: unknown;
}

/** 处理一条网关上行帧(message.send / read.report / call:*)。 */
export async function handleUplink(frame: unknown, ctx: UplinkContext): Promise<UplinkResult> {
  const env = frame as { type?: string; data?: unknown } | undefined;
  const frameType = env?.type;
  if (!frameType) {
    return { status: 400, body: { type: 'message.error', message: '缺少帧类型 type' } };
  }

  // ===== 发消息:落库 + 读扩散扇出(网关侧唯一业务分支之外的既有权重路径) =====
  if (frameType === 'message.send') {
    // 兼容两种上行帧形态:
    //  ① {type:'message.send', data:{...消息载荷}} —— 推荐:信封 type 与消息载荷分离;
    //  ② 直接整帧即消息载荷(早期 PoC 形态)—— 兼容保留。
    const payload = (env.data ?? frame) as unknown;
    const parsed = sendMessageInput.safeParse(payload);
    if (!parsed.success) {
      return {
        status: 400,
        body: {
          type: 'message.error',
          message: '消息参数非法',
          data: { clientMsgId: (frame as { clientMsgId?: string })?.clientMsgId },
        },
      };
    }
    const data = parsed.data;

    try {
      const senderId = BigInt(ctx.userId);
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

      return {
        status: 200,
        body: {
          type: 'message.ack',
          data: {
            clientMsgId: data.clientMsgId,
            seq: message.seq,
            serverMsgId: message.id,
          },
        },
      };
    } catch (err) {
      console.error('网关上行处理失败:', err);
      return {
        status: 500,
        body: { type: 'message.error', data: { message: '消息发送失败', clientMsgId: data.clientMsgId } },
      };
    }
  }

  // ===== 已读上报:单调推进用户级 lastReadSeq,再推 read.sync 给同用户其它设备 =====
  if (frameType === 'read.report') {
    const parsed = readReportInput.safeParse(env.data);
    if (!parsed.success) {
      return { status: 400, body: { type: 'message.error', message: '已读上报参数非法' } };
    }
    const { conversationId, uptoSeq } = parsed.data;
    const userIdBig = BigInt(ctx.userId);
    try {
      if (!(await isConversationMember(userIdBig, conversationId))) {
        return { status: 403, body: { type: 'message.error', message: '无权操作该会话' } };
      }
      const { advanced } = await advanceLastRead(userIdBig, conversationId, uptoSeq);
      // 单调未推进(乱序旧值)时无需扰动其它端。
      if (advanced) {
        await publishDownlink(ctx.userId, 'read.sync', { conversationId, uptoSeq }, {
          exceptDeviceId: ctx.deviceId,
        });
      }
      return { status: 204 };
    } catch (err) {
      console.error('已读上报处理失败:', err);
      return { status: 500, body: { type: 'message.error', message: '已读上报失败' } };
    }
  }

  // ===== 通话信令:忙线裁决/属主路由/grace 重连,状态机在 services/callSession =====
  if (frameType.startsWith('call:')) {
    try {
      return await handleCallEvent(
        frameType,
        ctx.userId,
        ctx.deviceId,
        (env.data ?? {}) as Record<string, unknown>,
      );
    } catch (err) {
      console.error('网关信令处理失败:', err);
      return { status: 500, body: { type: 'call:error', message: '信令处理失败' } };
    }
  }

  return { status: 400, body: { type: 'message.error', message: `不支持的上行类型: ${frameType}` } };
}
