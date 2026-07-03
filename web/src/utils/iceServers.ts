// WebRTC ICE servers 运行时获取:登录后从服务端 /api/turn-credentials 拉取
// coturn 的 STUN + 带短期 HMAC 凭据的 TURN(见 server 端 utils/turnCredentials 与技术方案文档)。
//
// 不再在前端硬编码 Google STUN:国内基本连不上,且无 TURN 兜底 → 异网络/对称 NAT(手机流量)打不通。
// 凭据短期、绑用户,故按 ttl 缓存、临期重取;拉取失败则退化为空(仅 host 候选,即改造前行为),不阻断通话。
import http from './http';

interface TurnCredentialsResp {
  iceServers: RTCIceServer[];
  ttl: number; // 秒;0 表示服务端未启用 TURN
}

let cached: RTCIceServer[] = [];
let expiresAt = 0; // epoch ms;0 表示无有效缓存
let inflight: Promise<RTCIceServer[]> | null = null;

const REFRESH_SKEW_MS = 60_000; // 临期提前量,避免边界拿到刚好失效的凭据

/** 同步取当前缓存的 iceServers(供建 PeerConnection 时读取);可能为空。 */
export function getIceServers(): RTCIceServer[] {
  return cached;
}

/**
 * 确保有一份有效的 iceServers:命中未过期缓存直接返回,否则从服务端拉取一份带短期凭据的。
 * 并发去重(同一时刻多次调用共享一次请求)。失败不抛错、退化为已有缓存(可能为空)。
 * 通话前(建 PeerConnection 之前)await 一次即可拿到最新凭据。
 */
export async function ensureIceServers(): Promise<RTCIceServer[]> {
  if (cached.length && Date.now() < expiresAt - REFRESH_SKEW_MS) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = (await http.get('/api/turn-credentials')) as unknown as TurnCredentialsResp;
      cached = Array.isArray(data?.iceServers) ? data.iceServers : [];
      expiresAt = data && data.ttl > 0 ? Date.now() + data.ttl * 1000 : 0;
    } catch (err) {
      console.warn('[iceServers] 拉取 TURN 凭据失败,退化为仅 host 候选:', err);
      // 不动已有缓存;从未成功过则保持空数组
    } finally {
      inflight = null;
    }
    return cached;
  })();
  return inflight;
}
