import { describe, it, expect } from 'vitest';
import { extractHandshakeToken } from '../src/utils/socketAuth.js';

describe('extractHandshakeToken — socket 握手双鉴权', () => {
  it('优先 handshake.auth.token(原生端 token 鉴权)', () => {
    expect(extractHandshakeToken({ auth: { token: 'AT' }, headers: { cookie: 'token=CK' } })).toBe('AT');
  });

  it('无 auth.token 回落 cookie(Web)', () => {
    expect(extractHandshakeToken({ headers: { cookie: 'token=CK; csrfToken=x' } })).toBe('CK');
  });

  it('auth.token 为空串/非字符串 → 回落 cookie', () => {
    expect(extractHandshakeToken({ auth: { token: '' }, headers: { cookie: 'token=CK' } })).toBe('CK');
    expect(extractHandshakeToken({ auth: { token: 123 }, headers: { cookie: 'token=CK' } })).toBe('CK');
  });

  it('两者都没有 → null', () => {
    expect(extractHandshakeToken({ headers: {} })).toBeNull();
  });
});
