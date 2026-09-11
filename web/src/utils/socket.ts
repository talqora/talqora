// io 工厂函数和 Socket 类型，用于创建和类型标注 socket 连接
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from './runtime';
import { getDeviceId } from './device';

// 配置 options(socket连接配置项)
const options = {
  autoConnect: false, // 不自动连接，需要手动调用 connect()
  // 握手时带上 HttpOnly token cookie，供服务端验签派生身份（跨域也能携带）
  withCredentials: true,
  // 上报 per-tab deviceId,供服务端做通话多标签页/多设备并发裁决(用函数,每次重连都带最新值)
  auth: (cb: (data: Record<string, unknown>) => void) => cb({ deviceId: getDeviceId() }),
  // transports: ['websocket'], // 强制只用 websocket 协议
};

// 单例模式
class SocketService {
  private static instance: Socket | null = null;

  static getInstance(): Socket {
    if (!SocketService.instance) {
      // 参数：socket地址，配置项
      SocketService.instance = io(SOCKET_URL, options); // 创建 socket 实例
    }
    return SocketService.instance;
  }

  // 断开连接
  static disconnect() {
    if (SocketService.instance) {
      SocketService.instance.disconnect();
      SocketService.instance = null;
    }
  }
}

export default SocketService;

// ------ 实时消息 RTT 打点关联态 ------
// 发送方（chatView）与接收方（useGlobalMessageListener）是两个不同的组件/hook，
// 用 clientMsgId 关联"发出时刻"与"收到回显时刻"需要一处共享存储；这只是打点用的临时态，
// 不需要触发渲染、也不需要持久化，故不放 Redux，挂在本模块（两边本就都 import 它）。
const pendingSentAt = new Map<string, number>();

// 发送消息时调用：记录该 clientMsgId 对应的发出时刻。
export function markMessageSent(clientMsgId: string) {
  if (!clientMsgId) return;
  pendingSentAt.set(clientMsgId, Date.now());
}

// 收到消息回显时调用：若 clientMsgId 命中此前记录的发送，返回往返耗时（ms）并清除记录；
// 未命中（如对方发来的消息，或本地未打点的发送路径）返回 null，调用方据此决定是否上报。
export function takeMessageRtt(clientMsgId: string | null | undefined): number | null {
  if (!clientMsgId) return null;
  const sentAt = pendingSentAt.get(clientMsgId);
  if (sentAt === undefined) return null;
  pendingSentAt.delete(clientMsgId);
  return Date.now() - sentAt;
}
