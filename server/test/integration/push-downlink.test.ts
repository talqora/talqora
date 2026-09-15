// dotenv 必须先于任何会构造 PrismaClient 的 import 执行。
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { emitToUser, persistAndBroadcastMessage } from '../../src/realtime/push.js';
import { redis, createSubscriber } from '../../src/database/redis.js';
import { prisma, createUser, cleanup } from './helpers.js';

// 推送器改造验证:socket.io 停用后,emitToUser 与 persistAndBroadcastMessage 的下行
// 必须 publish 到 gw:downlink(网关代投),而不是依赖 socket.io adapter。
describe('推送器走网关 downlink(集成,真 PG+Redis)', () => {
  let a: { id: bigint; username: string };
  let b: { id: bigint; username: string };
  let conv: string;

  const sub = createSubscriber();
  const downlinks: Array<{
    userId: number;
    frame: { type: string; data?: unknown };
  }> = [];

  const waitDownlinks = async (n: number, ms = 1000): Promise<void> => {
    const start = Date.now();
    while (downlinks.length < n && Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeAll(async () => {
    a = await createUser();
    b = await createUser();
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

  it('emitToUser → publish downlink 指定事件给指定用户', async () => {
    downlinks.length = 0;
    emitToUser(Number(a.id), 'friendListChanged', { peerId: Number(b.id) });
    await waitDownlinks(1);
    expect(downlinks).toHaveLength(1);
    expect(downlinks[0].userId).toBe(Number(a.id));
    expect(downlinks[0].frame).toEqual({
      type: 'friendListChanged',
      data: { peerId: Number(b.id) },
    });
  });

  it('persistAndBroadcastMessage → 落库 + downlink 扇出 receiveMessage 给双方', async () => {
    downlinks.length = 0;
    const clientMsgId = randomUUID();
    const { message, deduped } = await persistAndBroadcastMessage({
      conversationId: conv,
      senderId: a.id,
      clientMsgId,
      content: '推送器改造验证',
      type: 'text',
    });
    expect(deduped).toBe(false);

    await waitDownlinks(2);
    const got = downlinks.filter((d) => d.frame.type === 'receiveMessage');
    expect(new Set(got.map((d) => d.userId))).toEqual(new Set([Number(a.id), Number(b.id)]));

    // 真落库,且下行的 data 与落库行一致。
    const rows = await prisma.message.findMany({ where: { conversationId: conv } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id.toString()).toBe(message.id.toString());
  });

  it('同 clientMsgId 重发 → 去重,不重复扇出下行', async () => {
    downlinks.length = 0; // 清掉上一用例的扇出残留
    const clientMsgId = randomUUID();
    const input = {
      conversationId: conv,
      senderId: a.id,
      clientMsgId,
      content: '去重验证',
      type: 'text',
    };
    await persistAndBroadcastMessage(input);
    await waitDownlinks(2); // 等齐首发扇出的两条,避免残余下行混入重发窗口

    downlinks.length = 0;
    const { deduped } = await persistAndBroadcastMessage(input);
    expect(deduped).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(downlinks.filter((d) => d.frame.type === 'receiveMessage')).toHaveLength(0);

    const rows = await prisma.message.findMany({ where: { conversationId: conv } });
    expect(rows).toHaveLength(2);
  });
});
