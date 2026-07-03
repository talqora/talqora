import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { prisma } from '../src/database/prisma.js';
import app from '../src/app.js';

const findUniqueMock = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => findUniqueMock.mockReset());

describe('POST /api/register 参数校验', () => {
  it('缺少用户名/邮箱/密码 → 400', async () => {
    const res = await request(app).post('/api/register').send({ username: 'ab' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
  });

  it('用户名过短 → 400', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ username: 'a', email: 'a@b.com', password: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('用户名长度');
  });

  it('邮箱格式错误 → 400', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ username: 'valid_name', email: 'not-email', password: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('邮箱格式');
  });
});

describe('GET /api/check-username', () => {
  it('缺少用户名 → 400', async () => {
    const res = await request(app).get('/api/check-username');
    expect(res.status).toBe(400);
    expect(res.body.exists).toBe(false);
  });

  it('用户名可用 → exists:false', async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await request(app).get('/api/check-username').query({ username: 'freename' });
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
  });

  it('用户名已存在 → exists:true', async () => {
    findUniqueMock.mockResolvedValue({ id: 1n });
    const res = await request(app).get('/api/check-username').query({ username: 'taken' });
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
  });
});

describe('GET /api/check-email', () => {
  it('邮箱格式不正确 → exists:false', async () => {
    const res = await request(app).get('/api/check-email').query({ email: 'bad' });
    expect(res.body.exists).toBe(false);
  });

  it('邮箱可用 → exists:false', async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await request(app).get('/api/check-email').query({ email: 'a@b.com' });
    expect(res.body.exists).toBe(false);
  });
});
