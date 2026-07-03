import { TOKEN_COOKIE } from './authCookies.js';

// 从 Cookie 头取出指定 cookie 的值。
const parseCookie = (header: string | undefined, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
};

// Socket.io 握手鉴权令牌提取:优先 handshake.auth.token(原生/移动端 token 鉴权),
// 回落 HttpOnly cookie(Web)。与 REST 的 cookie+token 双鉴权对齐。
export const extractHandshakeToken = (handshake: {
  auth?: { token?: unknown };
  headers: { cookie?: string };
}): string | null => {
  const authToken = handshake.auth?.token;
  if (typeof authToken === 'string' && authToken) return authToken;
  return parseCookie(handshake.headers.cookie, TOKEN_COOKIE);
};
