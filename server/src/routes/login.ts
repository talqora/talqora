import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { prisma } from '../database/prisma.js';
import { config } from '../config/config.js';
import {
  setAuthCookies,
  clearAuthCookies,
  generateCsrfToken,
  CSRF_COOKIE,
  TOKEN_COOKIE,
  REMEMBER_MAX_AGE,
  SESSION_MAX_AGE,
} from '../utils/authCookies.js';
const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password, remember } = req.body ?? {};
    // 入参校验：缺失或非字符串直接 400，避免把 undefined 传入 Prisma 触发校验异常
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
      return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(400).json({ success: false, message: '用户不存在' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ success: false, message: '密码错误' });

    // 勾选记住我签发 7 天，否则 1 小时；cookie maxAge 与之对齐
    const expiresIn = remember ? config.jwtExpiresIn : '1h';
    const maxAge = remember ? REMEMBER_MAX_AGE : SESSION_MAX_AGE;
    const token = jwt.sign(
      { id: Number(user.id), username: user.username },
      config.jwtSecret,
      { expiresIn } as jwt.SignOptions,
    );

    // token 写入 HttpOnly cookie（前端 JS 读不到），并下发可读的 csrf token
    const csrfToken = generateCsrfToken();
    setAuthCookies(res, token, csrfToken, maxAge);

    // Web 用 HttpOnly cookie 鉴权;原生/移动端从响应体取 token,自行存储并以 Authorization: Bearer 携带(双鉴权)。剔除密码。
    const { password: _password, ...userInfo } = user;
    res.json({ success: true, data: { ...userInfo, token } });
  } catch (error) {
    console.error('登录失败:', error);
    res.status(500).json({ success: false, message: '服务器内部错误' });
  }
});

// Token刷新接口：基于现有 cookie 重签并重设 cookie
router.post('/refresh', async (req, res) => {
  try {
    // 双鉴权:原生端用 Authorization: Bearer(免 CSRF);Web 用 cookie + CSRF。
    const authHeader = req.headers.authorization;
    const viaBearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ');
    const token = viaBearer
      ? authHeader.slice('Bearer '.length).trim()
      : req.cookies?.[TOKEN_COOKIE];
    if (!token) {
      return res.status(401).json({ success: false, message: '缺少刷新令牌' });
    }

    // 仅 cookie 鉴权需双提交 CSRF 校验(刷新是变更类请求);Bearer 走显式头,跳过。
    if (!viaBearer) {
      const headerCsrf = req.headers['x-csrf-token'];
      const cookieCsrf = req.cookies?.[CSRF_COOKIE];
      if (!cookieCsrf || !headerCsrf || headerCsrf !== cookieCsrf) {
        return res.status(403).json({ success: false, message: 'CSRF 校验失败' });
      }
    }

    // 验证token（即使过期也要能解析出用户信息）
    let decoded: any;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        decoded = jwt.decode(token);
      } else {
        return res.status(401).json({ success: false, message: 'Token无效' });
      }
    }

    // 用 == null 而非 !decoded.id:id 可能为 0(官方/测试号 涂将),0 是合法 id 但 falsy,
    // 用 !decoded.id 会把它误判为缺失,导致该账号 token 永远刷新失败。
    if (!decoded || decoded.id == null) {
      return res.status(401).json({ success: false, message: 'Token格式错误' });
    }

    // 验证用户是否仍然存在
    const user = await prisma.user.findFirst({
      where: { id: BigInt(decoded.id), NOT: { status: 'deleted' } },
      select: { id: true, username: true, email: true, nickname: true, avatar: true, status: true },
    });

    if (!user) {
      return res.status(401).json({ success: false, message: '用户不存在或已被禁用' });
    }

    // 重签并重设 cookie（默认续 1 小时），同时轮换 csrf token
    const newToken = jwt.sign(
      { id: Number(user.id), username: user.username },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    setAuthCookies(res, newToken, generateCsrfToken(), SESSION_MAX_AGE);

    res.json({ success: true, data: { user, token: newToken }, message: 'Token刷新成功' });
  } catch (error) {
    console.error('Token刷新失败:', error);
    res.status(500).json({ success: false, message: '服务器内部错误' });
  }
});

// 登出：清除鉴权 cookie
router.post('/logout', (_req, res) => {
  clearAuthCookies(res);
  res.json({ success: true, message: '已登出' });
});

export default router;
