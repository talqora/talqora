// 原生 WebSocket 客户端,对接 Go gateway(/ws)。原生 WS 只给一根双向管道,这里补齐
// 实时层必需能力:信封 {type,data}、心跳(25s,续约网关 presence TTL)、指数退避重连、
// 可靠上行(message.send → message.ack 匹配 clientMsgId,超时同键重发,服务端幂等)。
//
// socket.io 旧路径(utils/socket.ts)保留供回滚,本模块是 gateway 路径的唯一客户端实现。
import { getDeviceId } from '@/utils/device';

export type WsFrame = { type: string; data?: unknown };
export type WsFrameListener = (data: unknown) => void;

export interface SendMessageInput {
  clientMsgId: string;
  conversationId: string;
  content: string;
  type?: string;
  mentions?: Array<string | number>;
  extra?: Record<string, unknown>;
  fileInfo?: Record<string, unknown>;
}

// 心跳间隔与网关心跳超时(GATEWAY_HEARTBEAT_TIMEOUT_SEC=60)错开:25s 一报,60s 内必有一次续约。
const HEARTBEAT_INTERVAL_MS = 25_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const ACK_TIMEOUT_MS = 5_000;
const ACK_MAX_RETRIES = 3;

interface PendingAck {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  retries: number;
}

class WsClient {
  private ws: WebSocket | null = null;
  private url = '/ws';
  private listeners = new Map<string, Set<WsFrameListener>>();
  private pending = new Map<string, PendingAck>();
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private manualClose = false;

  /** 建立连接(幂等:重连会自动发生,无需重复调用)。url 缺省同源 /ws(nginx/vite proxy 代转 gateway)。 */
  connect(url = '/ws'): void {
    this.url = url;
    this.manualClose = false;
    this.open();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 发一条帧。连接未就绪时静默丢弃返回 false(可靠路径请用 sendMessage)。 */
  send(type: string, data?: unknown): boolean {
    if (!this.isConnected()) return false;
    this.ws!.send(JSON.stringify({ type, data }));
    return true;
  }

  /** 订阅某 type 的下行帧,回调收到信封 data(类型 T 由回调参数推断)。返回取消订阅函数。 */
  on<T>(type: string, fn: (data: T) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    // 收窄封装:对外保留回调的类型签名,内部统一按 unknown 分发。
    const wrapped: WsFrameListener = (data) => fn(data as T);
    set.add(wrapped);
    return () => this.off(type, wrapped);
  }

  off(type: string, fn: WsFrameListener): void {
    this.listeners.get(type)?.delete(fn);
  }

  /**
   * 可靠上行:发 message.send,等 message.ack(按 clientMsgId 匹配)。
   * 超时按同 clientMsgId 重发(服务端幂等去重),达到上限仍未确认则 reject。
   */
  sendMessage(input: SendMessageInput): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error('连接未就绪,消息未发送'));
        return;
      }
      const entry: PendingAck = {
        resolve,
        reject,
        timer: setTimeout(() => undefined, 0),
        retries: 0,
      };
      const sendNow = (): void => {
        if (!this.isConnected()) {
          this.pending.delete(input.clientMsgId);
          reject(new Error('连接已断开,消息未确认'));
          return;
        }
        this.ws!.send(JSON.stringify({ type: 'message.send', data: input }));
        entry.timer = setTimeout(() => {
          entry.retries += 1;
          if (entry.retries >= ACK_MAX_RETRIES) {
            this.pending.delete(input.clientMsgId);
            reject(new Error('消息发送确认超时'));
            return;
          }
          sendNow();
        }, ACK_TIMEOUT_MS);
      };
      this.pending.set(input.clientMsgId, entry);
      sendNow();
    });
  }

  /** 主动断开:停止心跳与重连,拒绝在途可靠上行。 */
  disconnect(): void {
    this.manualClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('已主动断开'));
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
    const sep = this.url.includes('?') ? '&' : '?';
    // deviceId 走 query 与 gateway 握手对齐(ws/server.go 的 deviceId query);每标签页稳定值,
    // 服务端据此做同设备重连踢旧与通话属主路由。
    this.ws = new WebSocket(`${this.url}${sep}deviceId=${encodeURIComponent(getDeviceId())}`);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.startHeartbeat();
    };

    this.ws.onmessage = (ev) => this.handleMessage(String(ev.data));

    this.ws.onerror = () => {
      // 错误后浏览器会接着触发 close,统一在 onclose 处理重连。
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.rejectAllPending(new Error('连接已断开'));
      if (!this.manualClose) this.scheduleReconnect();
    };
  }

  private handleMessage(raw: string): void {
    let frame: WsFrame;
    try {
      frame = JSON.parse(raw) as WsFrame;
    } catch {
      return; // 非法帧静默丢弃
    }

    // 可靠上行的确认帧(message.ack / message.error):按 clientMsgId 收敛 pending,不分发业务监听。
    if (frame.type === 'message.ack' || frame.type === 'message.error') {
      const data = (frame.data ?? {}) as { clientMsgId?: string; message?: string };
      const entry = data.clientMsgId ? this.pending.get(data.clientMsgId) : undefined;
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(data.clientMsgId!);
        if (frame.type === 'message.ack') entry.resolve();
        else entry.reject(new Error(data.message ?? '消息发送失败'));
      }
      return;
    }

    const set = this.listeners.get(frame.type);
    set?.forEach((fn) => {
      try {
        fn(frame.data);
      } catch (err) {
        console.error('ws 下行帧处理异常:', frame.type, err);
      }
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send('heartbeat');
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

// 全应用单例(与旧 SocketService 单例模式一致)。
export const wsClient = new WsClient();
export default wsClient;
