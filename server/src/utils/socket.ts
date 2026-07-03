import { Server } from 'socket.io'; //基于WebSocket的实时通信库
import type { Server as HttpServer } from 'http';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Prisma } from '../generated/prisma/index.js';
import { config } from '../config/config.js';
import { extractHandshakeToken } from './socketAuth.js';
import { sendMessageInput, readReportInput } from '../contracts/message.js';
import { isConversationMember, advanceLastRead } from '../services/read.js';
import { register, refresh, remove, REPLICA_ID } from '../realtime/presence.js';
import { setIo, room, persistAndBroadcastMessage } from '../realtime/push.js';
import { redis } from '../database/redis.js';
import {
  tryCreateSession,
  markAccepted,
  markRejoined,
  markReconnecting,
  clearSession,
  getUserCall,
  getSession,
  GRACE_MS,
} from '../services/callSession.js';

// 握手验签后把用户身份挂到 socket 上，房间号即用户 id。
declare module 'socket.io' {
  interface Socket {
    userId?: number;
    // 设备标识:同一用户多端登录时区分物理连接。客户端可在握手时自报,缺省用 socket.id。
    deviceId?: string;
  }
}

interface TokenPayload {
  id: number;
  username: string;
}

// room(用户数字房间)统一从 realtime/push 导入,socket 与 HTTP 路由共用同一寻址。

// 设备级房间:用于把通话信令(accept/rejoin)精确投递到「拥有这通话的那台设备/标签页」,
// 而非用户的所有在线连接。deviceId 由客户端在握手自报(每标签页一个稳定 id)。
const deviceRoom = (deviceId: string): string => `device:${deviceId}`;

const allowedOrigins = (
  process.env.CLIENT_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const initSocket = (server: HttpServer): Server => {
  //创建WebSocket服务器，连接的建立依赖http，WebSocket的握手（连接建立）阶段，先通过http，然后升级为 WebSocket
  const io = new Server(server, {
    cors: {
      // 仅放行白名单来源，并允许携带 cookie（握手时浏览器需带上 HttpOnly token）
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`不允许的跨域来源: ${origin}`));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // 跨副本 backplane:接入 Redis adapter 后,io.to(room).emit 会透明地跨所有副本广播。
  // 内部即「按房间 pub/sub 代投」——别的副本订阅到消息后用本地 fd 投给在该房间的连接,
  // 因此多副本部署无需粘性会话(任意副本可代投,docs 16 §5.1/§6)。
  // pub/sub 各用一条独立连接(订阅态连接不能再发普通命令),与 presence 的命令连接隔离。
  io.adapter(createAdapter(redis.duplicate(), redis.duplicate()));

  // 把 io 注入统一推送器,让 HTTP 路由等非 socket 上下文也能推送(emitToUser / persistAndBroadcastMessage)。
  setIo(io);

  // 握手鉴权:cookie(Web)或 handshake.auth.token(原生端)取 JWT 验签,身份由服务端派生,绝不信任客户端自报的 userId。
  // 校验不过直接拒绝连接,杜绝匿名 socket 加入任意房间收发他人消息。
  io.use((socket, next) => {
    try {
      const token = extractHandshakeToken(socket.handshake);
      if (!token) return next(new Error('未认证：缺少登录凭据'));
      const decoded = jwt.verify(token, config.jwtSecret) as TokenPayload;
      socket.userId = decoded.id;
      next();
    } catch {
      next(new Error('认证失败：登录凭据无效或已过期'));
    }
  });

  // 监听WebSocket连接, 注：第二个参数前端不传默认1socket实例，只能获取到socket.id
  io.on('connection', (socket) => {
    console.log('用户连接:', socket.id, 'userId:', socket.userId);

    // 连接即自动加入「自己」的房间，房间号取服务端验签得到的 userId
    socket.join(room(socket.userId as number));

    // 设备标识取握手自报值,缺省回落 socket.id(每条连接唯一)。登记到 presence 注册表,
    // 让其它副本/扇出逻辑能查到「该用户此刻有哪些在线连接、在哪台副本」(docs 15 §5.1)。
    const handshakeDeviceId = (socket.handshake.auth?.deviceId ??
      socket.handshake.query?.deviceId) as string | undefined;
    socket.deviceId =
      typeof handshakeDeviceId === 'string' && handshakeDeviceId ? handshakeDeviceId : socket.id;
    // 加入设备级房间:通话信令按设备精确投递(属主路由)的目标。
    socket.join(deviceRoom(socket.deviceId));
    void register(socket.userId as number, {
      deviceId: socket.deviceId,
      replica: REPLICA_ID,
      socketId: socket.id,
    }).catch((err) => console.error('presence 登记失败:', err));

    // 心跳:仅续约该设备的 TTL。客户端按 ~25s 间隔发送(docs 16 §5.2)。
    socket.on('heartbeat', () => {
      void refresh(socket.userId as number, socket.deviceId as string).catch((err) =>
        console.error('presence 续约失败:', err)
      );
    });

    // 兼容前端的 join 事件，但忽略其传参，始终只加入自己的房间
    socket.on('join', () => {
      socket.join(room(socket.userId as number));
      console.log(`用户 ${socket.userId} 加入房间`);
    });

    // 落库 + 读扩散扇出统一走 realtime/push 的 persistAndBroadcastMessage(socket 与 HTTP 路由共用同一套扩散)。

    // 新协议:可靠上行。zod 校验 → 落库后回 message.ack(回带 seq/serverMsgId),
    // 客户端凭 ack 把本地"发送中"替换为"已发送";收不到则按同 clientMsgId 重发,服务端幂等去重。
    socket.on('message.send', async (raw) => {
      const parsed = sendMessageInput.safeParse(raw);
      if (!parsed.success) {
        socket.emit('message.error', { message: '消息参数非法', clientMsgId: (raw as { clientMsgId?: string })?.clientMsgId });
        return;
      }
      const data = parsed.data;
      try {
        const { message } = await persistAndBroadcastMessage({
          conversationId: data.conversationId,
          senderId: BigInt(socket.userId as number), // 发送者以握手验签身份为准,不信任入参
          clientMsgId: data.clientMsgId,
          content: data.content,
          type: data.type,
          mentions: data.mentions as Prisma.InputJsonValue,
          extra: data.extra as Prisma.InputJsonValue,
          fileInfo: data.fileInfo as Prisma.InputJsonValue,
        });
        socket.emit('message.ack', {
          clientMsgId: data.clientMsgId,
          seq: message.seq,
          serverMsgId: message.id,
        });
      } catch (err) {
        console.error('message.send 处理失败:', err);
        socket.emit('message.error', { message: '消息发送失败', clientMsgId: data.clientMsgId });
      }
    });

    // 已读上报(实时):单调推进用户级 lastReadSeq,再把 read.sync 推给【同用户的其它设备】,
    // 让另一端的红点一起清掉(docs 15 §5.3)。只发其它端:io.to(用户房间).except(本连接)——
    // 既不回声给操作端自己,也不发给会话对方(已读是用户私有状态)。adapter 保证跨副本送达。
    socket.on('read.report', async (raw) => {
      const parsed = readReportInput.safeParse(raw);
      if (!parsed.success) {
        socket.emit('read.error', { message: '已读上报参数非法' });
        return;
      }
      const { conversationId, uptoSeq } = parsed.data;
      const userId = BigInt(socket.userId as number);
      try {
        if (!(await isConversationMember(userId, conversationId))) {
          socket.emit('read.error', { message: '无权操作该会话', conversationId });
          return;
        }
        const { advanced } = await advanceLastRead(userId, conversationId, uptoSeq);
        // 单调未推进(乱序旧值)时无需扰动其它端。
        if (advanced) {
          io.to(room(socket.userId as number))
            .except(socket.id)
            .emit('read.sync', { conversationId, uptoSeq });
        }
      } catch (err) {
        console.error('read.report 处理失败:', err);
        socket.emit('read.error', { message: '已读上报失败', conversationId });
      }
    });

    // 旧协议:前端尚未迁移时兼容。无 clientMsgId 时服务端生成一个,确保仍走发号/落库,
    // 但无法跨重发去重(这是迁移到 message.send 的动机)。迁移完成后可移除。
    socket.on('sendMessage', async (msg) => {
      try {
        if (Number(msg.senderId) !== Number(socket.userId)) {
          socket.emit('error', { message: '非法的发送者身份' });
          return;
        }
        await persistAndBroadcastMessage({
          conversationId: String(msg.conversationId),
          senderId: BigInt(Number(socket.userId)),
          clientMsgId: typeof msg.clientMsgId === 'string' && msg.clientMsgId ? msg.clientMsgId : randomUUID(),
          content: String(msg.content ?? ''),
          type: String(msg.type ?? 'text'),
          mentions: (msg.mentions ?? []) as Prisma.InputJsonValue,
          extra: (msg.extra ?? {}) as Prisma.InputJsonValue,
          fileInfo: (msg.fileInfo ?? {}) as Prisma.InputJsonValue,
        });
      } catch (err) {
        console.error('消息处理失败:', err);
        socket.emit('error', { message: '消息发送失败' });
      }
    });

    // 好友请求改由 HTTP 路由(routes/friend.ts)服务端驱动推送 receiveFriendReq(见 realtime/push),
    // 不再走客户端 emit 的 sendFriendReq 中继(避免依赖前端 emit + 双推),此处不再监听。

    // ====== 语音通话信令(服务端权威会话:忙线裁决 / 设备属主路由 / grace 重连) ======

    // 通话发起(含 offer)。先做忙线裁决:被叫已在另一通通话则回 call:busy、不振铃;
    // 否则登记会话并把振铃投给被叫的所有在线设备/标签页。
    socket.on('call:start', async (event) => {
      try {
        const callerId = socket.userId as number;
        const calleeId = Number(event.to.id);
        const ok = await tryCreateSession({
          callId: event.callId,
          callerId,
          calleeId,
          callType: String(event.callType ?? 'voice'),
          callerDevice: socket.deviceId as string,
        });
        if (!ok) {
          socket.emit('call:busy', { callId: event.callId }); // 仅回主叫本设备,不打扰被叫
          return;
        }
        io.to(room(calleeId)).emit('call:start', event);
      } catch (error) {
        console.error('转发通话邀请失败:', error);
      }
    });

    // 通话接受(含 answer)。绑定接听设备 → connected;answer 回投给 offer 方;
    // 并通知同一被叫用户的其它设备/标签页「已在别处接听」,停止振铃。
    socket.on('call:accept', async (event) => {
      try {
        await markAccepted(event.callId, socket.deviceId as string);
        io.to(room(Number(event.to))).emit('call:accept', event);
        socket
          .to(room(socket.userId as number))
          .emit('call:handled', { callId: event.callId, status: 'accepted' });
      } catch (error) {
        console.error('转发通话接受失败:', error);
      }
    });

    // 通话拒绝:清会话 → 通知主叫;并让被叫其它设备停止振铃。
    socket.on('call:reject', async (event) => {
      try {
        const s = await clearSession(event.callId);
        const callerId = s ? s.callerId : parseInt(event.callId.split('_')[1]);
        if (Number.isFinite(callerId)) io.to(room(callerId)).emit('call:reject', event);
        socket
          .to(room(socket.userId as number))
          .emit('call:handled', { callId: event.callId, status: 'rejected' });
      } catch (error) {
        console.error('转发通话拒绝失败:', error);
      }
    });

    // 通话结束:清会话 → 广播给双方所有设备。
    socket.on('call:end', async (event) => {
      try {
        await clearSession(event.callId);
        const [, user1, user2] = event.callId.split('_');
        io.to(room(parseInt(user1))).emit('call:end', event);
        io.to(room(parseInt(user2))).emit('call:end', event);
      } catch (error) {
        console.error('转发通话结束失败:', error);
      }
    });

    // 刷新/断连后重新入会:校验会话仍在 → 更新该侧属主设备并恢复 connected →
    // 把新 offer 投给对端「属主设备」重协商;会话已不存在则让重连方干净收场。
    socket.on('call:rejoin', async (event) => {
      try {
        const s = await getSession(event.callId);
        if (!s) {
          socket.emit('call:end', { callId: event.callId });
          return;
        }
        const side = (socket.userId as number) === s.callerId ? 'caller' : 'callee';
        const updated = await markRejoined(event.callId, side, socket.deviceId as string);
        const peerDevice = side === 'caller' ? updated?.calleeDevice : updated?.callerDevice;
        const peerId = side === 'caller' ? s.calleeId : s.callerId;
        if (peerDevice) io.to(deviceRoom(peerDevice)).emit('call:rejoin', event);
        else io.to(room(peerId)).emit('call:rejoin', event);
      } catch (error) {
        console.error('转发重新入会失败:', error);
      }
    });

    // ICE候选交换:只转发给对方(socket.to 排除发送方自己),双方房间各发一次。
    socket.on('call:ice', (event) => {
      try {
        const [, user1, user2] = event.callId.split('_');
        socket.to(room(parseInt(user1))).emit('call:ice', event);
        socket.to(room(parseInt(user2))).emit('call:ice', event);
      } catch (error) {
        console.error('转发ICE候选失败:', error);
      }
    });

    // 断开连接:① presence 摘除该设备;② 若该设备是某通通话的属主,进入 grace 重连窗:
    //   通知对端「对方重连中」,GRACE_MS 内等 call:rejoin;超时仍未恢复则结束并广播 call:end。
    socket.on('disconnect', () => {
      void remove(socket.userId as number, socket.deviceId as string).catch((err) =>
        console.error('presence 摘除失败:', err)
      );

      const userId = socket.userId as number;
      const deviceId = socket.deviceId as string;
      void (async () => {
        const callId = await getUserCall(userId);
        if (!callId) return;
        const res = await markReconnecting(callId, deviceId);
        if (!res) return; // 非属主设备(如另开的空闲标签页)掉线,忽略
        const { session, epoch } = res;
        const peerId = userId === session.callerId ? session.calleeId : session.callerId;
        io.to(room(peerId)).emit('call:peer-reconnecting', { callId });
        // grace 到点:重读 Redis,仍处 reconnecting 且 epoch 未变(无人 rejoin)→ 结束。
        // epoch 校验跨副本生效:别处副本的 rejoin 会自增 epoch,使此定时器失效。
        setTimeout(() => {
          void (async () => {
            const cur = await getSession(callId);
            if (cur && cur.status === 'reconnecting' && cur.graceEpoch === epoch) {
              await clearSession(callId);
              io.to(room(cur.callerId)).emit('call:end', { callId });
              io.to(room(cur.calleeId)).emit('call:end', { callId });
            }
          })().catch((err) => console.error('grace 结束处理失败:', err));
        }, GRACE_MS);
      })().catch((err) => console.error('通话 grace 处理失败:', err));
    });
  });

  return io;
};
