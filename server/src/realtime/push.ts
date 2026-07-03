// 统一服务端推送器。
//
// 把「给某用户推事件」和「落库 + 读扩散广播消息」从 socket 连接闭包里抽出来,让任意上下文
// (socket 处理器、HTTP 路由如好友通过后的自动消息)都复用同一套推送/扩散,语义完全一致。
// io 由 initSocket 启动时注入(setIo);多副本下 io.to(room).emit 经 Redis adapter 透明跨副本扇出。
import type { Server } from 'socket.io';
import type { Prisma, Message } from '../generated/prisma/index.js';
import { persistMessage, getConversationMembers, markMentions } from '../services/message.js';
import { filterOnline } from './presence.js';

let ioRef: Server | null = null;

/** initSocket 启动时注入 io。 */
export function setIo(io: Server): void {
  ioRef = io;
}

/** 房间号:socket.io 的 Room 类型为 string,本项目历史上用数值房间(join/emit 两侧一致),此处仅类型桥接。 */
export const room = (id: number): string => id as unknown as string;

/** 给某用户的所有在线连接(跨副本)推一个事件。io 未就绪时静默跳过(不抛,避免拖垮调用方)。 */
export function emitToUser(userId: number | bigint, event: string, payload: unknown): void {
  ioRef?.to(room(Number(userId))).emit(event, payload);
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
  if (!deduped && ioRef) {
    // 读扩散扇出:消息只落 1 份,实时只推在线成员,离线成员靠 /sync 按各自 synced 补拉。
    // 单聊直推双方(成员仅 2 人);群聊先 filterOnline 收敛到在线子集,避免给离线成员做无谓跨副本 publish。
    const isGroup = input.conversationId.startsWith('group_');
    const targets = isGroup
      ? await filterOnline(participantIds)
      : new Set(participantIds.map(Number));
    for (const uid of targets) {
      ioRef.to(room(uid)).emit('receiveMessage', message);
    }

    // @提醒旁路:标记被 @ 成员 mentionSeq(供 /mentions 单独查),并给在线被 @ 者额外定向推 mention 高亮。
    const mentioned = parseMentionIds(input.mentions, participantIds);
    if (mentioned.length) {
      await markMentions(input.conversationId, message.seq, mentioned);
      for (const uid of await filterOnline(mentioned)) {
        ioRef.to(room(uid)).emit('mention', {
          conversationId: input.conversationId,
          seq: message.seq,
          serverMsgId: message.id,
        });
      }
    }
  }
  return { message, deduped };
}
