// 统一服务端推送器。
//
// 把「给某用户推事件」和「落库 + 读扩散广播消息」从 socket 连接闭包里抽出来,让任意上下文
// (内部端点、HTTP 路由如好友通过后的自动消息)都复用同一套推送/扩散,语义完全一致。
//
// 实时路径已切到 Go gateway:下行统一 publish 到 gw:downlink,由网关按 userId 代投
// (socket.io adapter 路径保留代码但已停挂,见 server.ts)。setIo 保留仅为兼容
// 停用中的 socket.ts 调用(socket.io 回滚用),推送不再依赖它。
import type { Server } from 'socket.io';
import type { Prisma, Message } from '../generated/prisma/index.js';
import { persistMessage, getConversationMembers, markMentions } from '../services/message.js';
import { filterOnline } from './presence.js';
import { buildDownlink } from '../contracts/ws.js';
import { redis } from '../database/redis.js';
import { observeBroadcastRecipients } from '../metrics/metrics.js';

// 下行频道:网关订阅后投给该用户在其副本的连接(与 routes/internal.ts 同一频道)。
const DOWNLINK_CHANNEL = 'gw:downlink';

const publishDownlink = (userId: number, type: string, data: unknown): Promise<number> =>
  redis.publish(DOWNLINK_CHANNEL, JSON.stringify(buildDownlink(userId, type, data)));

let ioRef: Server | null = null;

/** initSocket 启动时注入 io(仅 socket.io 回滚路径使用;实时路径已走 downlink)。 */
export function setIo(io: Server): void {
  ioRef = io;
}

/** 房间号:socket.io 的 Room 类型为 string,本项目历史上用数值房间(join/emit 两侧一致),此处仅类型桥接。 */
export const room = (id: number): string => id as unknown as string;

/** 给某用户的所有在线连接(跨副本)推一个事件。经 gw:downlink 由网关代投。 */
export function emitToUser(userId: number | bigint, event: string, payload: unknown): void {
  void publishDownlink(Number(userId), event, payload).catch((err) =>
    console.error('下行 publish 失败:', err)
  );
}

// 从 mentions(客户端上报的被 @ userId 列表)解析出「确实是本会话成员」的 bigint 集合。
// 客户端可能传非法/越权 id,只保留与会话成员的交集,杜绝跨会话伪造 @提醒。
function parseMentionIds(raw: unknown, participants: bigint[]): bigint[] {
  if (!Array.isArray(raw)) return [];
  const memberSet = new Set(participants.map((p) => p.toString()));
  const out: bigint[] = [];
  for (const v of raw) {
    const s = String(v);
    if (/^\d+$/.test(s) && memberSet.has(s)) out.push(BigInt(s));
  }
  return out;
}

export interface PersistAndBroadcastInput {
  conversationId: string;
  senderId: bigint;
  clientMsgId: string;
  content: string;
  type?: string;
  mentions?: Prisma.InputJsonValue;
  extra?: Prisma.InputJsonValue;
  fileInfo?: Prisma.InputJsonValue;
}

/**
 * 落库 + 读扩散扇出 receiveMessage(原 socket 闭包 persistAndBroadcast 抽出,语义不变)。
 * 落库成功且非去重命中时:向会话在线成员广播 receiveMessage(带 seq);被 @ 成员额外定向推 mention。
 * 去重命中(同 clientMsgId 重发)不重复广播,仅返回首次结果交调用方决定是否 ack。
 */
export async function persistAndBroadcastMessage(
  input: PersistAndBroadcastInput,
): Promise<{ message: Message; deduped: boolean }> {
  const participantIds = await getConversationMembers(input.conversationId, input.senderId);
  const { message, deduped } = await persistMessage({ ...input, participantIds });
  // 去重命中时不重复广播(对方已收到过首次广播),仅给调用方回结果。
  if (!deduped) {
    // 读扩散扇出:消息只落 1 份,实时只推在线成员,离线成员靠 /sync 按各自 synced 补拉。
    // 单聊直推双方(成员仅 2 人);群聊先 filterOnline 收敛到在线子集,避免给离线成员做无谓跨副本 publish。
    // 下行统一 publish gw:downlink 由网关代投(socket.io 停挂后不再走 adapter 扇出)。
    const isGroup = input.conversationId.startsWith('group_');
    const targets = isGroup
      ? await filterOnline(participantIds)
      : new Set(participantIds.map(Number));
    // 扇出规模:这条消息实际推给了多少个在线接收者(单聊恒为 1~2,群聊随在线成员数变化)。
    observeBroadcastRecipients(targets.size);
    await Promise.all(
      [...targets].map((uid) => publishDownlink(uid, 'receiveMessage', message))
    );

    // @提醒旁路:标记被 @ 成员 mentionSeq(供 /mentions 单独查),并给在线被 @ 者额外定向推 mention 高亮。
    const mentioned = parseMentionIds(input.mentions, participantIds);
    if (mentioned.length) {
      await markMentions(input.conversationId, message.seq, mentioned);
      await Promise.all(
        [...(await filterOnline(mentioned))].map((uid) =>
          publishDownlink(uid, 'mention', {
            conversationId: input.conversationId,
            seq: message.seq,
            serverMsgId: message.id,
          })
        )
      );
    }
  }
  return { message, deduped };
}
