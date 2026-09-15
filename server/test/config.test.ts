import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config/config.js';

describe('config', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('开发环境下无 JWT_SECRET 时回退为随机十六进制密钥', async () => {
    // 显式清空 JWT_SECRET(隔离 .env 填充的影响)后重载模块:应得到 randomBytes(32) 的 64 位 hex。
    vi.stubEnv('JWT_SECRET', '');
    vi.resetModules();
    const { config: cfg } = await import('../src/config/config.js');
    expect(typeof cfg.jwtSecret).toBe('string');
    expect(cfg.jwtSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('jwtExpiresIn 默认 7d', () => {
    expect(config.jwtExpiresIn).toBe(process.env.JWT_EXPIRES_IN || '7d');
  });
});
