import './database/bigint-json.js';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import helmet from 'helmet'; //安全响应头
import cors from 'cors'; //跨域中间件
import cookieParser from 'cookie-parser';
import { authRateLimiter } from './middleware/rateLimit.js';
import registerRouter from './routes/register.js';
import loginRouter from './routes/login.js';
import conversationRouter from './routes/chat.js';
import syncRouter from './routes/sync.js';
import uploadRouter from './routes/upload.js';
import userRouter from './routes/user.js';
import friendRouter from './routes/friend.js';
import uploadAdvancedRouter from './routes/uploadAdvanced.js';
import internalRouter from './routes/internal.js';
import turnRouter from './routes/turn.js';

const app = express(); //Express监听（http）服务器

// 信任前置 nginx 一层代理,使 req.ip 取到真实客户端 IP(限流按真实 IP 计数、XFF 正确)
app.set('trust proxy', 1);

// 安全响应头(nosniff / 隐藏 X-Powered-By / Referrer-Policy / HSTS 等);
// 本服务只返回 JSON,不直接发 HTML(SPA 由 nginx 托管),故沿用 helmet 默认即可。
app.use(helmet());

// 允许携带凭据的来源白名单。来自环境变量 CLIENT_ORIGINS（逗号分隔），
// 开发环境默认放行本机 Vite。注意：启用 cookie 凭据后，CORS 不能再用通配 '*'。
const allowedOrigins = (
  process.env.CLIENT_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,https://localhost:5173,https://127.0.0.1:5173'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// 跨域中间件：按白名单校验来源，并允许携带 cookie。
// 无 origin 的请求（同源代理转发、移动端原生、curl）放行。
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`不允许的跨域来源: ${origin}`));
    },
    credentials: true,
  })
);
// 解析 cookie（鉴权 token 从 HttpOnly cookie 读取）
app.use(cookieParser());
// 解析中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 文件不再落本地盘,改由对象存储托管(bucket 公有读),前端直接访问 publicUrl;
// 故不再需要 express.static 暴露本地 uploads 目录。

// Health 端点:容器编排健康检查 / load balancer 探针用
// 简单返回 200,不查 DB(避免 DB 抖动时 LB 把所有副本踢下线)。
// 如需 readiness(查 DB 是否可达),可另加 /ready 路由
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// 路由
// 认证端点(登录/注册)限流,挂在对应 router 之前
app.use('/api/login', authRateLimiter);
app.use('/api/register', authRateLimiter);
app.use('/api', registerRouter);
app.use('/api', loginRouter);
app.use('/api', turnRouter);
app.use('/user', conversationRouter);
app.use('/user', syncRouter);
app.use('/user/uploads', uploadRouter);
app.use('/user', userRouter);
app.use('/user', friendRouter);
app.use('/api/upload', uploadAdvancedRouter);
app.use('/internal', internalRouter);

// 错误处理中间件（需注册在所有路由之后）
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('全局错误处理:', err);
  res.status(500).json({
    success: false,
    message: '服务器内部错误',
  });
};
app.use(errorHandler);

export default app;
