// dotenv 必须先于任何会构造 PrismaClient 的 import 执行。
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { redis, createSubscriber } from '../../src/database/redis.js';
import { prisma, createUser, cleanup } from './helpers.js';

// P5 Go 网关上行端点真库集成测试:内部令牌鉴权、复用落库、下行 publish 到 gw:downlink、幂等去重。
// 验证「网关只管连接、业务仍在 Node」的接缝:网关透传帧 → 这里落库 → publish 下行供网关代投。
describe('网关上行端点 /internal/gateway/uplink(集成,真 PG+Redis)', () => {
  const TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || 'dev-internal-token';
  let a: { id: bigint; username: string };
  let b: { id: bigint; username: string };
  let conv: string;
  const sub = createSubscriber();
  const downlinks: Array<{ userId: number; frame: { type: string; data: unknown } }> = [];

  beforeAll(async () => {
    a = await createUser();
    b = await createUser();
    // 单聊会话 id 形如 single_<小id>_<大id>;两端都应被解析为参与者。
    const [lo, hi] = [a.id, b.id].sort((x, y) => (x < y ? -1 : 1));
    conv = `single_${lo}_${hi}`;
    await sub.subscribe('gw:downlink');
    sub.on('message', (_ch, payload) => downlinks.push(JSON.parse(payload)));
  });

  afterAll(async () => {
    await sub.unsubscribe('gw:downlink');
    await sub.quit();
    await cleanup([conv], [a.id, b.id]);
    await prisma.$disconnect();
    await redis.quit();
  });

  // 等待 pub/sub 异步投递:轮询直到收到 ≥n 条下行或超时。
  const waitDownlinks = async (n: number, ms = 1000): Promise<void> => {
    const start = Date.now();
    while (downlinks.length < n && Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('内部令牌错误 → 401,不落库', async () => {
    const res = await request(app)
      .post('/internal/gateway/uplink')
      .set('X-Gateway-Token', 'wrong')
      .set('X-User-Id', String(a.id))
      .send({ type: 'message.send', clientMsgId: randomUUID(), conversationId: conv, content: 'x' });
    expect(res.status).toBe(401);
  });

  it('缺少合法用户身份 → 400', async () => {
    const res = await request(app)
      .post('/internal/gateway/uplink')
      .set('X-Gateway-Token', TOKEN)
      .set('X-User-Id', '0')
      .send({ type: 'message.send', clientMsgId: randomUUID(), conversationId: conv, content: 'x' });
    expect(res.status).toBe(400);
  });

  it('不支持的上行类型 → 400', async () => {
    const res = await request(app)
      .post('/internal/gateway/uplink')
      .set('X-Gateway-Token', TOKEN)
      .set('X-User-Id', String(a.id))
      .send({ type: 'unknown.type', data: {} });
    expect(res.status).toBe(400);
  });

  it('合法上行 → 落库 + 回 ack + 给双方各 publish 一条 receiveMessage 下行', async () => {
    downlinks.length = 0;
    const clientMsgId = randomUUID();
    const res = await request(app)
      .post('/internal/gateway/uplink')
      .set('X-Gateway-Token', TOKEN)
      .set('X-User-Id', String(a.id))
      .send({ type: 'message.send', clientMsgId, conversationId: conv, content: '网关发一条' });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('message.ack');
    expect(res.body.data.clientMsgId).toBe(clientMsgId);
    expect(Number(res.body.data.seq)).toBe(1);

    // 真落库:会话内 1 行,发送者为 a。
    const rows = await prisma.message.findMany({ where: { conversationId: conv } });
    expect(rows).toHaveLength(1);
    expect(rows[0].senderId.toString()).toBe(a.id.toString());

    // 单聊直推双方:gw:downlink 收到给 a、b 各一条 receiveMessage。
    await waitDownlinks(2);
    const got = downlinks.filter((d) => d.frame.type === 'receiveMessage');
    expect(new Set(got.map((d) => d.userId))).toEqual(new Set([Number(a.id), Number(b.id)]));
  });

  it('已读上报 → 204,并 publish read.sync(排除上报设备)', async () => {
    downlinks.length = 0;
    const res = await request(app)
      .post('/internal/gateway/uplink')
      .set('X-Gateway-Token', TOKEN)
      .set('X-User-Id', String(a.id))
      .set('X-Device-Id', 'devA')
      .send({ type: 'read.report', data: { conversationId: conv, uptoSeq: '1' } });
    expect(res.status).toBe(204);
    await waitDownlinks(1);
    const got = downlinks.find((d) => d.frame.type === 'read.sync');
    expect(got).toBeTruthy();
    expect(got!.userId).toBe(Number(a.id));
    expect(got!.exceptDeviceId).toBe('devA');
    expect(got!.frame.data).toEqual({ conversationId: conv, uptoSeq: 1 });
  });

  it('已读上报:非会话成员 → 403', async () => {
    const c = await createUser();
    const res = await request(app)
      .post('/internal/gateway/uplink')
      .set('X-Gateway-Token', TOKEN)
      .set('X-User-Id', String(c.id))
      .set('X-Device-Id', 'devC')
      .send({ type: 'read.report', data: { conversationId: conv, uptoSeq: '1' } });
    expect(res.status).toBe(403);
    await prisma.user.delete({ where: { id: c.id } });
  });

  it('同 clientMsgId 重发 → 幂等去重,回 ack 但不重复落库/不再扇出下行', async () => {
    const clientMsgId = randomUUID();
    const send = () =>
      request(app)
        .post('/internal/gateway/uplink')
        .set('X-Gateway-Token', TOKEN)
        .set('X-User-Id', String(a.id))
        .send({ type: 'message.send', clientMsgId, conversationId: conv, content: '重发同一条' });

    const r1 = await send();
    expect(r1.status).toBe(200);
    await waitDownlinks(downlinks.length + 1);

    downlinks.length = 0;
    const r2 = await send();
    expect(r2.status).toBe(200);
    // 去重命中:seq 与首次一致。
    expect(Number(r2.body.data.seq)).toBe(Number(r1.body.data.seq));
    // 给点时间确认「确实没有」新下行(去重路径不扇出)。
    await new Promise((r) => setTimeout(r, 200));
    expect(downlinks.filter((d) => d.frame.type === 'receiveMessage')).toHaveLength(0);

    // 会话内仍只有 2 行(首条 + 本用例首发),重发未新增。
    const rows = await prisma.message.findMany({ where: { conversationId: conv } });
    expect(rows).toHaveLength(2);
  });
});
