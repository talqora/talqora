import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from '../src/database/prisma.js';
import { config } from '../src/config/config.js';
import app from '../src/app.js';

const findFirstMock = prisma.user.findFirst as unknown as ReturnType<typeof vi.fn>;

const sign = (payload: object) => jwt.sign(payload, config.jwtSecret);

beforeEach(() => {
  findFirstMock.mockReset();
});

describe('GET /user/profile', () => {
  it('缺少凭据 → 401', async () => {
    const res = await request(app).get('/user/profile');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it('Bearer 鉴权 → 200,回当前用户资料且不含密码', async () => {
    findFirstMock.mockResolvedValue({
      id: 7n,
      username: 'neo',
      email: 'neo@x.io',
      nickname: '尼奥',
      avatar: 'https://x/a.png',
      status: 'online',
    });
    const token = sign({ id: 7, username: 'neo' });
    const res = await request(app)
      .get('/user/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      id: 7,
      username: 'neo',
      nickname: '尼奥',
      avatar: 'https://x/a.png',
    });
    expect(res.body.data).not.toHaveProperty('password');
  });
});
