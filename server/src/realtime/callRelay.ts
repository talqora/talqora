// 通话信令 + 断连 grace 的网关内端实现。逻辑自 utils/socket.ts 的 socket.io 处理器平移,
// 入口从「socket 事件」换成「网关上行透传帧 / 断连通知」,身份从握手 socket 换成网关注入的
// X-User-Id / X-Device-Id 头。状态机(callSession)与下行语义(忙线裁决/属主路由/grace 重连)不变。
//
// 下行投递统一 publish 到 gw:downlink,由网关按 userId / targetDeviceId / exceptDeviceId 代投。

import { buildDownlink } from '../contracts/ws.js';
import { redis } from '../database/redis.js';
import {
  clearSession,
  getSession,
  getUserCall,
  GRACE_MS,
  markAccepted,
  markRejoined,
  markReconnecting,
  tryCreateSession,
} from '../services/callSession.js';
import { decActiveCalls, incActiveCalls, incCallEvent } from '../metrics/metrics.js';

// 把一条下行帧 publish 给指定用户(网关订阅 gw:downlink 后按路由规则代投)。
const publishDownlink = (
  userId: number,
  type: string,
  data: unknown,
  opts?: { targetDeviceId?: string; exceptDeviceId?: string },
): Promise<number> =>
  redis.publish('gw:downlink', JSON.stringify(buildDownlink(userId, type, data, opts)));

type RelayResult = { status: number; body?: unknown };

// 处理一条通话信令上行帧(eventType 由信封 type 给出,event 为信封 data)。
// 返回 HTTP 状态码与响应体:
//  - 204 无回投(网关不回投空帧给发送方);
//  - 200 + 响应帧(仅回投操作端,如 call:busy / 会话已结束的 call:end)。
export async function handleCallEvent(
  eventType: string,
  userId: number,
  deviceId: string,
  event: Record<string, unknown>,
): Promise<RelayResult> {
  const callId = String(event.callId ?? '');

  switch (eventType) {
    case 'call:start': {
      incCallEvent('start');
      const calleeId = Number((event.to as { id?: unknown } | undefined)?.id);
      if (!callId || !Number.isFinite(calleeId) || calleeId <= 0) {
        return { status: 400, body: { type: 'call:error', message: '缺少 callId 或合法被叫' } };
      }
      const ok = await tryCreateSession({
        callId,
        callerId: userId,
        calleeId,
        callType: String(event.callType ?? 'voice'),
        callerDevice: deviceId,
      });
      if (!ok) {
        incCallEvent('busy');
        // 仅回主叫本设备,不打扰被叫。
        return { status: 200, body: { type: 'call:busy', callId } };
      }
      incActiveCalls();
      await publishDownlink(calleeId, 'call:start', event);
      return { status: 204 };
    }

    case 'call:accept': {
      incCallEvent('accept');
      await markAccepted(callId, deviceId);
      // answer 回投给 offer 方;并通知同一被叫用户的其它设备「已在别处接听」,停止振铃。
      const toId = Number(event.to);
      if (Number.isFinite(toId) && toId > 0) {
        await publishDownlink(toId, 'call:accept', event);
      }
      await publishDownlink(userId, 'call:handled', { callId, status: 'accepted' }, {
        exceptDeviceId: deviceId,
      });
      return { status: 204 };
    }

    case 'call:reject': {
      incCallEvent('reject');
      const s = await clearSession(callId);
      // 只有会话确实存在才对称 -1(与 call:start 的 +1 对称)。
      if (s) decActiveCalls();
      const callerId = s ? s.callerId : parseInt(callId.split('_')[1] ?? '', 10);
      if (Number.isFinite(callerId) && callerId > 0) {
        await publishDownlink(callerId, 'call:reject', event);
      }
      await publishDownlink(userId, 'call:handled', { callId, status: 'rejected' }, {
        exceptDeviceId: deviceId,
      });
      return { status: 204 };
    }

    case 'call:end': {
      incCallEvent('end');
      const s = await clearSession(callId);
      // 同上:只有会话确实存在才 -1,与 call:start 的 +1 对称。
      if (s) decActiveCalls();
      const [, u1, u2] = callId.split('_');
      const id1 = parseInt(u1 ?? '', 10);
      const id2 = parseInt(u2 ?? '', 10);
      if (Number.isFinite(id1) && id1 > 0) await publishDownlink(id1, 'call:end', event);
      if (Number.isFinite(id2) && id2 > 0 && id2 !== id1) await publishDownlink(id2, 'call:end', event);
      return { status: 204 };
    }

    case 'call:rejoin': {
      incCallEvent('rejoin');
      const s = await getSession(callId);
      if (!s) {
        // 会话已不存在:让重连方干净收场。
        return { status: 200, body: { type: 'call:end', callId } };
      }
      const side = userId === s.callerId ? 'caller' : 'callee';
      const updated = await markRejoined(callId, side, deviceId);
      const peerDevice = side === 'caller' ? updated?.calleeDevice : updated?.callerDevice;
      const peerId = side === 'caller' ? s.calleeId : s.callerId;
      if (peerDevice) {
        // 精确投给对端属主设备:新 offer 只该设备处理(属主路由)。
        await publishDownlink(peerId, 'call:rejoin', event, { targetDeviceId: peerDevice });
      } else {
        await publishDownlink(peerId, 'call:rejoin', event);
      }
      return { status: 204 };
    }

    case 'call:ice': {
      incCallEvent('ice');
      const [, u1, u2] = callId.split('_');
      const id1 = parseInt(u1 ?? '', 10);
      const id2 = parseInt(u2 ?? '', 10);
      // 转发给双方、排除发送方本设备(socket.to 语义)。
      if (Number.isFinite(id1) && id1 > 0) {
        await publishDownlink(id1, 'call:ice', event, { exceptDeviceId: deviceId });
      }
      if (Number.isFinite(id2) && id2 > 0 && id2 !== id1) {
        await publishDownlink(id2, 'call:ice', event, { exceptDeviceId: deviceId });
      }
      return { status: 204 };
    }

    default:
      return { status: 400, body: { type: 'message.error', message: `不支持的上行类型: ${eventType}` } };
  }
}

// 断连通知:某设备离线。平移 socket.io disconnect 处理器:
// 属主设备掉线 → 会话进入 reconnecting → 通知对端 → GRACE_MS 内无人 rejoin 则结束会话。
export async function handleDisconnect(userId: number, deviceId: string): Promise<void> {
  const callId = await getUserCall(userId);
  if (!callId) return;
  const res = await markReconnecting(callId, deviceId);
  if (!res) return; // 非属主设备(如另开的空闲标签页)掉线,忽略
  const { session, epoch } = res;
  const peerId = userId === session.callerId ? session.calleeId : session.callerId;
  await publishDownlink(peerId, 'call:peer-reconnecting', { callId });
  // grace 到点:重读 Redis,仍处 reconnecting 且 epoch 未变(无人 rejoin)→ 结束。
  // epoch 校验跨副本生效:别处副本的 rejoin 会自增 epoch,使此定时器失效。
  setTimeout(() => {
    void (async () => {
      const cur = await getSession(callId);
      if (cur && cur.status === 'reconnecting' && cur.graceEpoch === epoch) {
        await clearSession(callId);
        await publishDownlink(cur.callerId, 'call:end', { callId });
        await publishDownlink(cur.calleeId, 'call:end', { callId });
      }
    })().catch((err) => console.error('grace 结束处理失败:', err));
  }, GRACE_MS);
}
