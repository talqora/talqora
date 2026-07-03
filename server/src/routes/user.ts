import express from 'express';
import { prisma } from '../database/prisma.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// 允许前端通过 /update 改动的字段白名单 ── 原 mysql2 `SET ?` 是 mass-assignment,
// 这里收缩成显式列名映射,顺便防止前端写入 password/status 等敏感字段。
// 字段名直接对应 schema.prisma 的 User model,Prisma 7 client 内部类型拆分让命名空间
// 类型不一致,这里用宽 Record + as 收口
const ALLOWED_FIELDS: Record<string, string> = {
  email: 'email',
  phone: 'phone',
  nickname: 'nickname',
  avatar: 'avatar',
  bio: 'bio',
  gender: 'gender',
  last_seen: 'lastSeen',
  lastSeen: 'lastSeen',
};

// 当前登录用户的资料。authenticateToken 已按 token 身份从库里取到现值并挂在 req.user
// (id/username/nickname/avatar/status),这里直接回。原生端启动后只持有 token,靠此接口拉资料。
router.get('/profile', authenticateToken, (req, res) => {
  res.json({ success: true, data: req.user });
});

router.post('/update', authenticateToken, async (req, res) => {
  const { id, ...data } = req.body as Record<string, unknown>;

  if (req.user!.id.toString() !== String(id)) {
    return res.status(403).json({ success: false, message: '无权修改其他用户信息' });
  }
  if (!id) {
    return res.status(400).json({ message: 'id不能为空' });
  }

  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const target = ALLOWED_FIELDS[k];
    if (target) {
      update[target] = v;
    }
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ message: '没有可更新的字段' });
  }

  try {
    await prisma.user.update({
      where: { id: BigInt(Number(id)) },
      data: update as never,
    });
    res.status(200).json({ message: '更新成功' });
  } catch (error) {
    console.error('更新失败:', error);
    res.status(500).json({ message: '更新失败' });
  }
});

export default router;
