// dotenv 必须先于任何会构造 PrismaClient 的 import 执行。
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { redis, createSubscriber } from '../../src/database/redis.js';

// 通话信令集成测试(真 Redis;信令不查 DB,用固定大 id 免建用户)。
// 验证「socket.io 信令逻辑平移到网关内部端点」:忙线裁决、属主路由、except 语义、断连 grace。
describe('网关信令与断连端点(集成,真 Redis)', () => {
  const TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || 'dev-internal-token';
  // 固定大 id,避开真实用户空间,无需 DB 建用户。
  const CALLER = 900_000_001;
  const CALLEE = 900_000_002;
  const OTHER = 900_000_003;
  const DEVA = 'dev-a';
  const DEVC = 'dev-c';
  const DEVD = 'dev-d';
  const ts = Date.now();
  const callId = `call_${CALLER}_${CALLEE}_${ts}`;

  const sub = createSubscriber();
  const downlinks: Array<{
    userId: number;
    frame: { type: string; data?: unknown };
    targetDeviceId?: string;
    exceptDeviceId?: string;
  }> = [];

  const uplink = (uid: number, device: string, type: string, data: unknown) =>
    request(app)
      .post('/internal/gateway/uplink')
      .set('X-Gateway-Token', TOKEN)
      .set('X-User-Id', String(uid))
      .set('X-Device-Id', device)
      .send({ type, data });

  const disconnect = (uid: number, device: string) =>
    request(app)
      .post('/internal/gateway/disconnect')
      .set('X-Gateway-Token', TOKEN)
      .set('X-User-Id', String(uid))
      .set('X-Device-Id', device);

  const waitDownlinks = async (n: number, ms = 1000): Promise<void> => {
    const start = Date.now();
    while (downlinks.length < n && Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeAll(async () => {
    await sub.subscribe('gw:downlink');
    sub.on('message', (_ch, payload) => downlinks.push(JSON.parse(payload)));
  });

  afterAll(async () => {
    await sub.unsubscribe('gw:downlink');
    await sub.quit();
    // 清理信令状态键(忙线索引/会话),避免污染其它用例与真实用户空间。
    await redis.del(
      `call:session:${callId}`,
      `call:user:${CALLER}`,
      `call:user:${CALLEE}`,
      `call:user:${OTHER}`,
    );
    await redis.quit();
  });

  it('内部令牌错误 → disconnect 端点 401', async () => {
    const res = await request(app)
      .post('/internal/gateway/disconnect')
      .set('X-Gateway-Token', 'wrong')
      .set('X-User-Id', String(CALLER))
      .set('X-Device-Id', DEVA);
    expect(res.status).toBe(401);
  });

  it('call:start 成功 → 下行振铃给被叫全部设备', async () => {
    downlinks.length = 0;
    const res = await uplink(CALLER, DEVA, 'call:start', {
      callId,
      to: { id: CALLEE },
      callType: 'voice',
    });
    expect(res.status).toBe(204); // 无回投帧:网关据此不向发送方回投空帧

    await waitDownlinks(1);
    const ring = downlinks.find((d) => d.frame.type === 'call:start');
    expect(ring).toBeDefined();
    expect(ring!.userId).toBe(CALLEE);
  });

  it('被叫忙线 → 上行响应回 call:busy(仅主叫),不再振铃', async () => {
    downlinks.length = 0;
    const res = await uplink(OTHER, 'dev-o', 'call:start', {
      callId: `call_${OTHER}_${CALLEE}_${ts}`,
      to: { id: CALLEE },
      callType: 'voice',
    });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('call:busy');
    await new Promise((r) => setTimeout(r, 200));
    expect(downlinks.filter((d) => d.frame.type === 'call:start')).toHaveLength(0);
  });

  it('call:accept → 下行 answer 给主叫 + call:handled 排除接听设备', async () => {
    downlinks.length = 0;
    const res = await uplink(CALLEE, DEVC, 'call:accept', {
      callId,
      to: CALLER,
      answer: { type: 'answer', sdp: 'fake' },
    });
    expect(res.status).toBe(204);

    await waitDownlinks(2);
    const answer = downlinks.find((d) => d.frame.type === 'call:accept');
    expect(answer).toBeDefined();
    expect(answer!.userId).toBe(CALLER);

    const handled = downlinks.find((d) => d.frame.type === 'call:handled');
    expect(handled).toBeDefined();
    expect(handled!.userId).toBe(CALLEE);
    expect(handled!.exceptDeviceId).toBe(DEVC); // 排除接听设备本身
  });

  it('call:rejoin(主叫换设备回来) → 下行精确投给对端属主设备', async () => {
    downlinks.length = 0;
    const res = await uplink(CALLER, 'dev-a2', 'call:rejoin', {
      callId,
      offer: { type: 'offer', sdp: 'fake' },
    });
    expect(res.status).toBe(204);

    await waitDownlinks(1);
    const rejoin = downlinks.find((d) => d.frame.type === 'call:rejoin');
    expect(rejoin).toBeDefined();
    expect(rejoin!.userId).toBe(CALLEE);
    expect(rejoin!.targetDeviceId).toBe(DEVC); // 属主设备精确投递
  });

  it('属主设备断连 → 下行 call:peer-reconnecting 通知对端', async () => {
    downlinks.length = 0;
    const res = await disconnect(CALLEE, DEVC); // 属主(接听设备)断开
    expect(res.status).toBe(204);

    await waitDownlinks(1);
    const rec = downlinks.find((d) => d.frame.type === 'call:peer-reconnecting');
    expect(rec).toBeDefined();
    expect(rec!.userId).toBe(CALLER);
  });

  it('非属主设备断连 → 无下行(忽略)', async () => {
    downlinks.length = 0;
    const res = await disconnect(CALLEE, DEVD); // 非属主标签页断开
    expect(res.status).toBe(204);
    await new Promise((r) => setTimeout(r, 200));
    expect(downlinks).toHaveLength(0);
  });

  it('call:end → 下行 call:end 给双方,忙线索引清理', async () => {
    downlinks.length = 0;
    const res = await uplink(CALLER, 'dev-a2', 'call:end', { callId });
    expect(res.status).toBe(204);

    await waitDownlinks(2);
    const ends = downlinks.filter((d) => d.frame.type === 'call:end');
    expect(new Set(ends.map((d) => d.userId))).toEqual(new Set([CALLER, CALLEE]));

    // 忙线索引已清:重发同会话 call:start 不再 busy(会话重建成功)。
    const res2 = await uplink(CALLER, DEVA, 'call:start', {
      callId,
      to: { id: CALLEE },
      callType: 'voice',
    });
    expect(res2.status).toBe(204);
  });
});
