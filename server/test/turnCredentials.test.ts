import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { buildTurnIceServers } from '../src/utils/turnCredentials.js';

describe('buildTurnIceServers', () => {
  const base = { host: 'tujiang.tech', stunPort: 3478, tlsPort: 5349, ttlSec: 86400, userId: 42 };

  it('未配 secret → 空 iceServers(降级,不报错)', () => {
    expect(buildTurnIceServers({ ...base, secret: '' })).toEqual({ iceServers: [], ttl: 0 });
  });

  it('未配 host → 同样降级为空', () => {
    expect(buildTurnIceServers({ ...base, secret: 's', host: '' })).toEqual({ iceServers: [], ttl: 0 });
  });

  it('username = 到期时间戳:uid,到期 = now + ttl', () => {
    const now = 1000;
    const { iceServers, ttl } = buildTurnIceServers({ ...base, secret: 's3cr3t', now });
    expect(ttl).toBe(base.ttlSec);
    expect(iceServers[1].username).toBe(`${now + base.ttlSec}:42`);
  });

  it('credential = base64(HMAC-SHA1(secret, username)),与 coturn 校验口径一致', () => {
    const now = 1000;
    const secret = 's3cr3t';
    const { iceServers } = buildTurnIceServers({ ...base, secret, now });
    const turn = iceServers[1];
    const expected = crypto.createHmac('sha1', secret).update(turn.username!).digest('base64');
    expect(turn.credential).toBe(expected);
  });

  it('URL 覆盖 STUN + TURN(udp/tcp)+ TURNS(tls/5349)', () => {
    const { iceServers } = buildTurnIceServers({ ...base, secret: 's', now: 0 });
    expect(iceServers[0].urls).toEqual(['stun:tujiang.tech:3478']);
    expect(iceServers[1].urls).toEqual([
      'turn:tujiang.tech:3478?transport=udp',
      'turn:tujiang.tech:3478?transport=tcp',
      'turns:tujiang.tech:5349?transport=tcp',
    ]);
  });
});
