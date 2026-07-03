import express from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../database/prisma.js';
import { authenticateToken } from '../middleware/auth.js';
import { emitToUser, persistAndBroadcastMessage } from '../realtime/push.js';

const router = express.Router();

// 获取好友列表(好友 id + 备注 + 资料)── 只能获取自己的
router.get('/getFriendList/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  if (req.user!.id.toString() !== id.toString()) {
    return res.status(403).json({ success: false, message: '无权访问其他用户的好友列表' });
  }
  try {
    const userBigInt = BigInt(Number(id));
    const friendships = await prisma.friendship.findMany({
      where: { userId: userBigInt },
      select: { friendId: true, remark: true },
    });

    let friendList: {
      friendId: Record<string, string | null>;
      friendInfo: Record<string, { username: string; avatar: string | null; gender: string | null }>;
    } = { friendId: {}, friendInfo: {} };

    if (friendships.length > 0) {
      const friendIds = friendships.map((f) => f.friendId);
      const users = await prisma.user.findMany({
        where: { id: { in: friendIds } },
        select: { id: true, username: true, avatar: true, gender: true },
      });
      friendList = {
        friendId: friendships.reduce<Record<string, string | null>>((acc, f) => {
          acc[String(f.friendId)] = f.remark;
          return acc;
        }, {}),
        friendInfo: users.reduce<Record<string, { username: string; avatar: string | null; gender: string | null }>>((acc, u) => {
          acc[String(u.id)] = { username: u.username, avatar: u.avatar, gender: u.gender };
          return acc;
        }, {}),
      };
    }

    res.json({ success: true, data: friendList });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: '获取好友列表失败' });
  }
});

// 查询用户信息(按 id 或 phone)
router.get('/searchUser', authenticateToken, async (req, res) => {
  const { keyword, userId } = req.query as Record<string, string>;
  try {
    const numericKeyword = Number(keyword);
    const matched = await prisma.user.findFirst({
      where: {
        OR: [
          ...(Number.isFinite(numericKeyword) ? [{ id: BigInt(numericKeyword) }] : []),
          { phone: keyword },
          { username: keyword },
        ],
      },
      select: { id: true, avatar: true, username: true, gender: true },
    });
    if (!matched) {
      return res.json({
        success: false,
        message: '用户不存在',
        data: { exist: false, isFriend: false, friendInfo: null },
      });
    }
    const existing = await prisma.friendship.findUnique({
      where: {
        userId_friendId: {
          userId: BigInt(Number(userId)),
          friendId: matched.id,
        },
      },
    });
    if (existing) {
      return res.json({
        success: false,
        message: '已经是好友',
        data: { exist: true, isFriend: true, friendInfo: matched },
      });
    }
    res.json({ success: true, data: { exist: true, isFriend: false, friendInfo: matched } });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: '查询用户信息失败' });
  }
});

// 发起好友请求(双向写入,以 sent/pending 标记发起方与接收方)
router.put('/addFriend', authenticateToken, async (req, res) => {
  const { userId, friendId } = req.body;
  if (req.user!.id.toString() !== userId.toString()) {
    return res.status(403).json({ success: false, message: '无权代替其他用户发起好友请求' });
  }
  try {
    await prisma.friendship.createMany({
      data: [
        { userId: BigInt(Number(userId)), friendId: BigInt(Number(friendId)), status: 'sent' },
        { userId: BigInt(Number(friendId)), friendId: BigInt(Number(userId)), status: 'pending' },
      ],
    });
    // 服务端驱动:即时把好友请求推给接收方(带发起人资料,供其请求卡片渲染,不再依赖客户端 emit)。
    // 载荷形状对齐 getFriendReqs 的条目(接收方视角:userId=自己,friendId=发起人)。best-effort,失败不影响已写入。
    try {
      const requester = await prisma.user.findUnique({
        where: { id: BigInt(Number(userId)) },
        select: { username: true, avatar: true },
      });
      const now = new Date().toISOString();
      emitToUser(Number(friendId), 'receiveFriendReq', {
        id: 0,
        userId: Number(friendId),
        friendId: Number(userId),
        status: 'pending',
        remark: null,
        createdAt: now,
        updatedAt: now,
        username: requester?.username ?? '',
        avatar: requester?.avatar ?? '',
      });
    } catch (e) {
      console.error('推送好友请求失败:', e);
    }
    res.json({
      success: true,
      message: '发起好友请求成功',
      data: { isFriend: false, friendId },
    });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: '发起好友请求失败' });
  }
});

// 更新好友备注 ── 只能改自己对某位好友的备注
router.put('/updateRemark', authenticateToken, async (req, res) => {
  const { userId, friendId, remark } = req.body;
  if (req.user!.id.toString() !== userId.toString()) {
    return res.status(403).json({ success: false, message: '无权修改其他用户的好友备注' });
  }
  try {
    await prisma.friendship.update({
      where: {
        userId_friendId: {
          userId: BigInt(Number(userId)),
          friendId: BigInt(Number(friendId)),
        },
      },
      data: { remark: typeof remark === 'string' && remark.trim() ? remark.trim() : null },
    });
    res.json({ success: true });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: '更新好友备注失败' });
  }
});

// 获取自己收到的好友请求
router.get('/getFriendReqs', authenticateToken, async (req, res) => {
  const { userId } = req.query as Record<string, string>;
  if (req.user!.id.toString() !== userId.toString()) {
    return res.status(403).json({ success: false, message: '无权访问其他用户的好友请求' });
  }
  try {
    const rows = await prisma.friendship.findMany({
      where: { userId: BigInt(Number(userId)) },
      orderBy: { updatedAt: 'desc' },
    });
    // 请求方资料随请求一起返回:好友请求列表里对方多半还不是好友,本地 friendInfo 取不到,
    // 不带上 username/avatar 的话该卡片会渲染成空白(无名无头像)。
    const requesterIds = rows.map((r) => r.friendId);
    const requesters = requesterIds.length
      ? await prisma.user.findMany({
          where: { id: { in: requesterIds } },
          select: { id: true, username: true, avatar: true },
        })
      : [];
    const requesterMap = new Map(requesters.map((u) => [String(u.id), u]));
    const result = rows.reduce<Record<string, unknown>>((acc, r) => {
      const u = requesterMap.get(String(r.friendId));
      acc[String(r.friendId)] = { ...r, username: u?.username ?? null, avatar: u?.avatar ?? null };
      return acc;
    }, {});
    res.json({ success: true, data: result });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: '获取好友请求失败' });
  }
});

// 回复好友请求,双向更新状态;accepted 时创建 single 会话
router.put('/replyFriendReq', authenticateToken, async (req, res) => {
  const { userId, friendId, status } = req.body;
  if (req.user!.id.toString() !== userId.toString()) {
    return res.status(403).json({ success: false, message: '无权代替其他用户回复好友请求' });
  }
  try {
    if (status === 'accepted') {
      const conversationId = `single_${Math.min(userId, friendId)}_${Math.max(userId, friendId)}`;
      // 如果会话已存在则跳过(P2002 唯一冲突),整体过程仍 success
      await prisma.conversation
        .create({ data: { id: conversationId, convType: 'single' } })
        .catch(() => undefined);
    }
    await prisma.friendship.updateMany({
      where: { userId: BigInt(Number(userId)), friendId: BigInt(Number(friendId)) },
      data: { status },
    });
    await prisma.friendship.updateMany({
      where: { userId: BigInt(Number(friendId)), friendId: BigInt(Number(userId)) },
      data: { status },
    });

    // 副作用(best-effort,失败只记日志,不影响已完成的回复):通知双方刷新好友列表 + 微信式自动消息。
    if (status === 'accepted') {
      try {
        const conversationId = `single_${Math.min(userId, friendId)}_${Math.max(userId, friendId)}`;
        // 双方好友列表变化 → 前端重拉 getFriendList(A 的旧列表即时刷新)。
        emitToUser(Number(userId), 'friendListChanged', { peerId: Number(friendId) });
        emitToUser(Number(friendId), 'friendListChanged', { peerId: Number(userId) });
        // 建立关系即自动互发一条消息(和微信一致),经统一管线落库+广播 → 即时进双方对话列表。
        // 发起方(friendId=A)发「我是【A】」;接收方(userId=B,即本次回复者)发「我通过了…」。
        const requester = await prisma.user.findUnique({
          where: { id: BigInt(Number(friendId)) },
          select: { username: true },
        });
        await persistAndBroadcastMessage({
          conversationId,
          senderId: BigInt(Number(friendId)),
          clientMsgId: randomUUID(),
          content: `我是${requester?.username ?? ''}`,
          type: 'text',
        });
        await persistAndBroadcastMessage({
          conversationId,
          senderId: BigInt(Number(userId)),
          clientMsgId: randomUUID(),
          content: '我通过了你的朋友验证请求，现在我们可以开始聊天了',
          type: 'text',
        });
      } catch (e) {
        console.error('好友通过后推送/自动消息失败:', e);
      }
    } else {
      // 拒绝/拉黑等:通知发起方刷新,使其"已发送"状态收敛。
      emitToUser(Number(friendId), 'friendListChanged', { peerId: Number(userId) });
    }

    res.json({ success: true, message: '回复好友请求成功' });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: '回复好友请求失败' });
  }
});

export default router;
