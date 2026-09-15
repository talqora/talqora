import { describe, it, expect } from 'vitest';
import {
  wsEnvelope,
  downlinkPayload,
  buildDownlink,
  type WsEnvelope,
} from '../src/contracts/ws.js';

describe('wsEnvelope — 客户端帧信封契约', () => {
  it('合法信封 {type, data} 通过', () => {
    const ok = wsEnvelope.safeParse({ type: 'message.send', data: { clientMsgId: 'c1' } });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.type).toBe('message.send');
  });

  it('data 可省略(仅 type 的帧,如 heartbeat)', () => {
    const ok = wsEnvelope.safeParse({ type: 'heartbeat' });
    expect(ok.success).toBe(true);
  });

  it('缺 type 拒绝', () => {
    expect(wsEnvelope.safeParse({ data: {} }).success).toBe(false);
  });

  it('type 非字符串拒绝', () => {
    expect(wsEnvelope.safeParse({ type: 123 }).success).toBe(false);
  });

  it('type 为未知字符串也放行(信封层不枚举业务类型)', () => {
    expect(wsEnvelope.safeParse({ type: 'future.event', data: 1 }).success).toBe(true);
  });
});

describe('downlinkPayload — gw:downlink 载荷结构', () => {
  it('最小载荷 {userId, frame} 通过', () => {
    const ok = downlinkPayload.safeParse({
      userId: 7,
      frame: { type: 'receiveMessage', data: { id: 1 } },
    });
    expect(ok.success).toBe(true);
  });

  it('可选 targetDeviceId / exceptDeviceId 通过', () => {
    const ok = downlinkPayload.safeParse({
      userId: 7,
      frame: { type: 'call:rejoin' },
      targetDeviceId: 'dev-A',
      exceptDeviceId: undefined,
    });
    expect(ok.success).toBe(true);
  });

  it('userId 缺失或非整数拒绝', () => {
    expect(downlinkPayload.safeParse({ frame: { type: 'x' } }).success).toBe(false);
    expect(downlinkPayload.safeParse({ userId: '7', frame: { type: 'x' } }).success).toBe(false);
  });
});

describe('buildDownlink — 构造 helper', () => {
  it('基础形态:无过滤字段时不携带 undefined 键', () => {
    const p = buildDownlink(7, 'receiveMessage', { id: 1 });
    expect(p).toEqual({ userId: 7, frame: { type: 'receiveMessage', data: { id: 1 } } });
  });

  it('exceptDeviceId 形态(同用户其它设备,排除本端)', () => {
    const p = buildDownlink(7, 'read.sync', { conversationId: 'c1', uptoSeq: 3 }, { exceptDeviceId: 'dev-A' });
    expect(p).toEqual({
      userId: 7,
      frame: { type: 'read.sync', data: { conversationId: 'c1', uptoSeq: 3 } },
      exceptDeviceId: 'dev-A',
    });
  });

  it('targetDeviceId 形态(属主设备精确投递)', () => {
    const p = buildDownlink(7, 'call:rejoin', {}, { targetDeviceId: 'dev-B' });
    expect(p.targetDeviceId).toBe('dev-B');
    expect('exceptDeviceId' in p).toBe(false);
  });

  it('信封类型推导:frame 结构满足 WsEnvelope', () => {
    const p = buildDownlink(7, 'mention', { seq: 1 });
    const frame: WsEnvelope = p.frame;
    expect(frame.type).toBe('mention');
  });
});
