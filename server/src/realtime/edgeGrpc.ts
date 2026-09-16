// gRPC 流服务(ourchat.edge.v1.Realtime/Stream):gateway(Go) 与 server(Node) 之间的内部实时通道。
// 承接:业务上行帧(复用 handleUplink,与 HTTP 端点同一份逻辑)、断连通知(复用 callRelay.handleDisconnect)。
// 下行仍走 Redis gw:downlink(过渡期),目标态由本服务把 downlink 帧写回流(演进方案文档 §4.4/§8)。
//
// 鉴权:流 metadata 的 x-gateway-token 必须等于 GATEWAY_INTERNAL_TOKEN。
// 监听地址:EDGE_GRPC_ADDR(默认 127.0.0.1:3008),仅内网可达;env EDGE_GRPC_ENABLED=false 可关闭。
import * as grpc from '@grpc/grpc-js';
import {
  RealtimeService,
  EdgeFrame,
  UplinkAck,
} from '../contracts/gen-edge/ourchat/edge/v1/realtime.js';
import { handleUplink } from './handleUplink.js';
import { handleDisconnect } from './callRelay.js';

const INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || 'dev-internal-token';

// ack 信封里可能带 bigint(seq),经全局 toJSON polyfill 转 number(database/bigint-json.ts)。
function bodyToBytes(body: unknown): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  return Buffer.from(JSON.stringify(body), 'utf8');
}

// 统一构造 UplinkAck:proto3 标量必填,未用字段补零值(编码时空值省略,与不设置等价)。
function makeAck(p: {
  ok: boolean;
  clientMsgId: string;
  userId: number;
  seq?: number;
  serverMsgId?: number;
  error?: string;
  rawResponse?: Uint8Array;
}): UplinkAck {
  return {
    ok: p.ok,
    clientMsgId: p.clientMsgId,
    userId: p.userId,
    seq: p.seq ?? 0,
    serverMsgId: p.serverMsgId ?? 0,
    error: p.error ?? '',
    rawResponse: p.rawResponse ?? new Uint8Array(0),
  };
}

// 从 message.ack 信封解出 seq/serverMsgId(UplinkAck 的观测字段,非关键路径)。
function extractAckMeta(body: unknown): { seq: number; serverMsgId: number } {
  const env = body as { type?: string; data?: { seq?: bigint | number; serverMsgId?: bigint | number } } | undefined;
  if (env?.type !== 'message.ack' || !env.data) return { seq: 0, serverMsgId: 0 };
  return { seq: Number(env.data.seq ?? 0), serverMsgId: Number(env.data.serverMsgId ?? 0) };
}

/** 处理一条上游帧并回 ack。身份来自网关注入的帧头,不信任帧内自报。 */
async function processFrame(call: grpc.ServerDuplexStream<EdgeFrame, EdgeFrame>, frame: EdgeFrame): Promise<void> {
  if (frame.uplink) {
    const u = frame.uplink;
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(u.rawFrame).toString('utf8'));
    } catch {
      call.write({
        ack: makeAck({ ok: false, clientMsgId: u.clientMsgId, userId: u.userId, error: '上行帧不是合法 JSON' }),
      });
      return;
    }

    const result = await handleUplink(raw, { userId: Number(u.userId), deviceId: u.deviceId });

    if (result.status === 204) {
      // 无回投语义(read.report / call 204):仅确认收敛,网关不回投 WS。
      call.write({ ack: makeAck({ ok: true, clientMsgId: u.clientMsgId, userId: u.userId }) });
      return;
    }

    if (result.status === 200) {
      const meta = extractAckMeta(result.body);
      call.write({
        ack: makeAck({
          ok: true,
          clientMsgId: u.clientMsgId,
          userId: u.userId,
          seq: meta.seq,
          serverMsgId: meta.serverMsgId,
          rawResponse: bodyToBytes(result.body),
        }),
      });
      return;
    }

    // 4xx/5xx:错误收敛(网关回投带 clientMsgId 的 message.error,客户端可即时重试/收敛)。
    const msg = (result.body as { message?: string } | undefined)?.message ?? '消息发送失败';
    call.write({
      ack: makeAck({ ok: false, clientMsgId: u.clientMsgId, userId: u.userId, error: msg }),
    });
    return;
  }

  if (frame.closed) {
    // 断连通知:与 HTTP /internal/gateway/disconnect 等价(fire-and-forget,不回帧)。
    try {
      await handleDisconnect(Number(frame.closed.userId), frame.closed.deviceId);
    } catch (err) {
      console.error('gRPC 断连通知处理失败:', err);
    }
  }
}

/** 启动 gRPC 流服务。失败(端口占用等)返回错误,由调用方决定是否退出。 */
export function startEdgeGrpc(addr: string, log?: (msg: string) => void): grpc.Server {
  const server = new grpc.Server();
  server.addService(RealtimeService, {
    stream: (call: grpc.ServerDuplexStream<EdgeFrame, EdgeFrame>) => {
      // 鉴权:gateway 经 PerRPCCredentials 注入 x-gateway-token。
      const token = call.metadata.get('x-gateway-token')[0];
      if (String(token ?? '') !== INTERNAL_TOKEN) {
        call.emit('error', { code: grpc.status.UNAUTHENTICATED, message: '内部令牌校验失败' } as grpc.ServiceError);
        return;
      }

      call.on('data', (frame: EdgeFrame) => {
        // 帧并发处理:同用户消息顺序由服务端 seq 发号保证,处理乱序无害;幂等由 DB 唯一约束兜底。
        void processFrame(call, frame).catch((err) => {
          console.error('gRPC 上行帧处理异常:', err);
        });
      });
      call.on('error', (err: Error) => {
        const code = (err as grpc.ServiceError).code;
        if (code !== grpc.status.CANCELLED) {
          console.error('gRPC 流异常:', code, err.message);
        }
      });
      call.on('end', () => call.end());
    },
  });

  server.bindAsync(addr, grpc.ServerCredentials.createInsecure(), (err) => {
    if (err) {
      console.error(`gRPC 流服务绑定失败(${addr}):`, err.message);
      return;
    }
    log?.(`gRPC 流服务已启动:${addr}`);
  });
  return server;
}
