import crypto from 'crypto';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceServersResult {
  iceServers: IceServer[];
  ttl: number;
}

export interface TurnOptions {
  /** 与 coturn 共享的 HMAC 密钥;为空表示未启用 TURN(降级为空 iceServers) */
  secret: string;
  /** TURN/STUN 主机名(如 tujiang.tech) */
  host: string;
  stunPort: number;
  tlsPort: number;
  /** 凭据有效期(秒) */
  ttlSec: number;
  userId: string | number;
  /** 当前 unix 秒(可注入,便于测试);默认取 Date.now() */
  now?: number;
}

/**
 * 生成一组 WebRTC ICE servers:coturn 的 STUN + 带短期 HMAC 凭据的 TURN。
 *
 * 凭据机制(coturn `use-auth-secret` / TURN REST API):
 *   username   = <到期unix时间戳>:<用户id>
 *   credential = base64( HMAC-SHA1(secret, username) )
 * coturn 用同一 secret 校验时效与签名。密钥只在服务端与 coturn 之间,绝不下发给客户端。
 *
 * 未配 secret/host 时返回空 iceServers(前端退化为仅 host 候选,即当前行为,不报错)。
 */
export function buildTurnIceServers(opts: TurnOptions): IceServersResult {
  const { secret, host, stunPort, tlsPort, ttlSec, userId } = opts;
  if (!secret || !host) {
    return { iceServers: [], ttl: 0 };
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const expiry = now + ttlSec;
  const username = `${expiry}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');

  return {
    iceServers: [
      { urls: [`stun:${host}:${stunPort}`] },
      {
        urls: [
          `turn:${host}:${stunPort}?transport=udp`,
          `turn:${host}:${stunPort}?transport=tcp`,
          // TLS/5349:穿只放行 443/5349 的严格防火墙
          `turns:${host}:${tlsPort}?transport=tcp`,
        ],
        username,
        credential,
      },
    ],
    ttl: ttlSec,
  };
}
