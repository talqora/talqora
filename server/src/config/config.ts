import crypto from 'crypto';

const isProduction = process.env.NODE_ENV === 'production';

// JWT 密钥必须来自环境变量，绝不硬编码进源码。
// 生产环境缺失则直接 fail-fast，避免用弱默认值上线；
// 开发环境缺失则随机生成一个，并告警（进程重启后旧 token 会失效，仅用于本地）。
function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv;
  }
  if (isProduction) {
    throw new Error('缺少环境变量 JWT_SECRET：生产环境必须显式配置 JWT 密钥');
  }
  const generated = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[config] 未设置 JWT_SECRET，已为开发环境生成临时随机密钥；进程重启后已签发的 token 将失效。'
  );
  return generated;
}

// 取正整数环境变量,非法/缺失时回退默认值
function positiveIntEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

export interface AppConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  // WebRTC TURN(coturn)配置。secret 为空表示未启用(端点降级为空 iceServers,不报错)。
  turn: {
    secret: string;
    host: string;
    stunPort: number;
    tlsPort: number;
    ttlSec: number;
  };
}

export const config: AppConfig = {
  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  turn: {
    secret: process.env.TURN_SECRET?.trim() || '',
    host: process.env.TURN_HOST?.trim() || '',
    stunPort: positiveIntEnv(process.env.TURN_STUN_PORT, 3478),
    tlsPort: positiveIntEnv(process.env.TURN_TLS_PORT, 5349),
    ttlSec: positiveIntEnv(process.env.TURN_TTL_SEC, 86400),
  },
};

export default config;
