import express from 'express';
import bcrypt from 'bcrypt';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../database/prisma.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { username, email, password, phone, nickname, avatar, bio } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ success: false, message: '用户名、邮箱和密码不能为空' });
    }
    if (username.length < 2 || username.length > 50) {
      return res.status(400).json({ success: false, message: '用户名长度必须在2-50个字符之间' });
    }
    if (email.length > 100) {
      return res.status(400).json({ success: false, message: '邮箱地址不能超过100个字符' });
    }
    if (password.length < 6 || password.length > 255) {
      return res.status(400).json({ success: false, message: '密码长度必须在6-255个字符之间' });
    }
    if (phone && phone.length > 20) {
      return res.status(400).json({ success: false, message: '手机号码不能超过20个字符' });
    }
    if (nickname && nickname.length > 50) {
      return res.status(400).json({ success: false, message: '昵称不能超过50个字符' });
    }
    if (avatar && avatar.length > 255) {
      return res.status(400).json({ success: false, message: '头像URL不能超过255个字符' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: '邮箱格式不正确' });
    }
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: '手机号格式不正确' });
    }
    if (!/^[a-zA-Z0-9_一-龥]+$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: '用户名只能包含字母、数字、下划线和中文',
      });
    }

    // 三个唯一字段冲突单独提示,比 Prisma P2002 通用错误更好读
    if (await prisma.user.findUnique({ where: { username } })) {
      return res.status(409).json({ success: false, message: '用户名已存在' });
    }
    if (await prisma.user.findUnique({ where: { email } })) {
      return res.status(409).json({ success: false, message: '邮箱已被注册' });
    }
    if (phone && (await prisma.user.findUnique({ where: { phone } }))) {
      return res.status(409).json({ success: false, message: '手机号已被注册' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const created = await prisma.user.create({
      data: {
        username,
        email,
        phone: phone || null,
        password: hashedPassword,
        nickname: nickname || username,
        avatar: avatar || '',
        bio: bio || '',
        status: 'online',
        lastSeen: new Date(),
      },
      select: {
        id: true,
        username: true,
        email: true,
        phone: true,
        nickname: true,
        avatar: true,
        bio: true,
        status: true,
        createdAt: true,
      },
    });

    res.status(201).json({
      success: true,
      message: '注册成功',
      data: {
        id: Number(created.id),
        username: created.username,
        email: created.email,
        phone: created.phone,
        nickname: created.nickname,
        avatar: created.avatar,
        bio: created.bio,
        status: created.status,
        createdAt: created.createdAt,
      },
    });
  } catch (error) {
    console.error('注册错误:', error);
    // 唯一约束兜底(并发场景与上面预检的 race)
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return res.status(409).json({
        success: false,
        message: '用户信息已存在，请检查用户名、邮箱或手机号',
      });
    }
    res.status(500).json({ success: false, message: '服务器内部错误，请稍后重试' });
  }
});

router.get('/check-username', async (req, res) => {
  try {
    const username = req.query.username as string | undefined;
    if (!username) {
      return res.status(400).json({ exists: false, message: '用户名不能为空' });
    }
    if (username.length < 2 || username.length > 50) {
      return res.json({ exists: false, message: '用户名长度必须在2-50个字符之间' });
    }
    const found = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    const exists = found !== null;
    res.json({ exists, message: exists ? '用户名已存在' : '用户名可用' });
  } catch (error) {
    console.error('检查用户名错误:', error);
    res.status(500).json({ exists: false, message: '服务器错误' });
  }
});

router.get('/check-email', async (req, res) => {
  try {
    const email = req.query.email as string | undefined;
    if (!email) {
      return res.status(400).json({ exists: false, message: '邮箱不能为空' });
    }
    if (email.length > 100) {
      return res.json({ exists: false, message: '邮箱地址不能超过100个字符' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.json({ exists: false, message: '邮箱格式不正确' });
    }
    const found = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    const exists = found !== null;
    res.json({ exists, message: exists ? '邮箱已被注册' : '邮箱可用' });
  } catch (error) {
    console.error('检查邮箱错误:', error);
    res.status(500).json({ exists: false, message: '服务器错误' });
  }
});

router.get('/check-phone', async (req, res) => {
  try {
    let phone = req.query.phone as string | undefined;
    if (phone?.trim() === '') phone = undefined;
    if (!phone) {
      return res.status(400).json({ exists: false, message: '手机号不能为空' });
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return res.json({ exists: false, message: '手机号格式不正确' });
    }
    const found = await prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    const exists = found !== null;
    res.json({ exists, message: exists ? '手机号已被注册' : '手机号可用' });
  } catch (error) {
    console.error('检查手机号错误:', error);
    res.status(500).json({ exists: false, message: '服务器错误' });
  }
});

export default router;
