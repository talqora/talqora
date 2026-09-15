import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wsClient, type WsFrame } from './wsClient';

// 原生 WebSocket 的 fake:可编程触发 open/message/close,记录发出的帧。
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  url: string;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }

  // ---- 测试辅助 ----
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  simulateFrame(frame: WsFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  simulateClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  wsClient.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const last = (): FakeWebSocket | undefined =>
  FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

describe('wsClient — 连接与信封', () => {
  it('connect 建立连接并携带 deviceId query', () => {
    wsClient.connect('/ws');
    last()!.simulateOpen();
    expect(last()!.url.startsWith('/ws?deviceId=')).toBe(true);
    expect(wsClient.isConnected()).toBe(true);
  });

  it('send 编码 {type, data} 信封', () => {
    wsClient.connect('/ws');
    last()!.simulateOpen();
    wsClient.send('read.report', { conversationId: 'c1' });
    expect(last()!.sent).toEqual([JSON.stringify({ type: 'read.report', data: { conversationId: 'c1' } })]);
  });

  it('下行帧分发到对应 type 的监听器', () => {
    wsClient.connect('/ws');
    last()!.simulateOpen();
    const got: unknown[] = [];
    const off = wsClient.on('receiveMessage', (data) => got.push(data));
    last()!.simulateFrame({ type: 'receiveMessage', data: { id: 1 } });
    expect(got).toEqual([{ id: 1 }]);
    off();
    last()!.simulateFrame({ type: 'receiveMessage', data: { id: 2 } });
    expect(got).toHaveLength(1); // off 后不再收到
  });

  it('心跳:每 25s 发 heartbeat 帧', () => {
    wsClient.connect('/ws');
    last()!.simulateOpen();
    const before = last()!.sent.length;
    vi.advanceTimersByTime(25_000);
    expect(last()!.sent.slice(before)).toEqual([JSON.stringify({ type: 'heartbeat' })]);
  });
});

describe('wsClient — 可靠上行(message.send → message.ack)', () => {
  const input = () => ({
    clientMsgId: `c${Math.random().toString(36).slice(2)}`,
    conversationId: 'single_1_2',
    content: 'hi',
  });

  it('ack 匹配 clientMsgId 后 resolve,不回投到业务监听', () => {
    wsClient.connect('/ws');
    last()!.simulateOpen();
    const data = input();
    const p = wsClient.sendMessage(data);
    expect(last()!.sent).toEqual([JSON.stringify({ type: 'message.send', data })]);

    const leaked: unknown[] = [];
    wsClient.on('message.ack', (d) => leaked.push(d));
    last()!.simulateFrame({ type: 'message.ack', data: { clientMsgId: data.clientMsgId, seq: '1' } });
    return p.then(() => {
      expect(leaked).toHaveLength(0); // ack 是可靠上行协议,不进业务分发
    });
  });

  it('超时未 ack → 同 clientMsgId 重发,最终 ack 到达 resolve', () => {
    wsClient.connect('/ws');
    last()!.simulateOpen();
    const data = input();
    const p = wsClient.sendMessage(data);
    expect(last()!.sent).toHaveLength(1);

    vi.advanceTimersByTime(5_000); // 第一次超时 → 重发
    expect(last()!.sent).toHaveLength(2);
    expect(JSON.parse(last()!.sent[1])).toEqual({ type: 'message.send', data });

    last()!.simulateFrame({ type: 'message.ack', data: { clientMsgId: data.clientMsgId, seq: '1' } });
    return p;
  });

  it('重发达到上限 → reject', () => {
    wsClient.connect('/ws');
    last()!.simulateOpen();
    const data = input();
    const p = wsClient.sendMessage(data);
    const assertion = expect(p).rejects.toThrow(/超时/);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5_000);
    }
    expect(last()!.sent).toHaveLength(3); // 首发 + 2 次重发
    return assertion;
  });

  it('message.error → reject', () => {
    wsClient.connect('/ws');
    last()!.simulateOpen();
    const data = input();
    const p = wsClient.sendMessage(data);
    const assertion = expect(p).rejects.toThrow(/参数非法/);
    last()!.simulateFrame({ type: 'message.error', data: { clientMsgId: data.clientMsgId, message: '消息参数非法' } });
    return assertion;
  });

  it('断连时在途 sendMessage 立即 reject', () => {
    wsClient.connect('/ws');
    last()!.simulateOpen();
    const data = input();
    const p = wsClient.sendMessage(data);
    const assertion = expect(p).rejects.toThrow(/断开/);
    last()!.simulateClose();
    return assertion;
  });
});

describe('wsClient — 重连', () => {
  it('异常断开 → 指数退避重连(1s → 2s),成功后重置退避', () => {
    wsClient.connect('/ws');
    last()!.simulateOpen();
    const first = last();

    first!.simulateClose();
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2); // 第一次重连(1s)

    const second = last();
    second!.simulateClose();
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2); // 退避到 2s,1s 时还不再连
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(3); // 2s 到点重连
  });

  it('主动 disconnect → 不重连', () => {
    wsClient.connect('/ws');
    last()!.simulateOpen();
    const first = last();
    wsClient.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(first!.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
