// dotenv 必须在任何读取 process.env 的模块之前加载:宿主机本地开发读 .env;
// 容器内无 .env 文件时静默跳过,改走 compose 的 environment 注入(已存在的 env 不被覆盖)。
import 'dotenv/config';
import type { Server as HttpServer } from 'http';
import type { Server as SocketIOServer } from 'socket.io';
import app from './app.js';
import { initSocket } from './utils/socket.js';
import { prisma } from './database/prisma.js';
import { redis } from './database/redis.js';
import {
  applyPendingMigrations,
  loadKeyStore,
  mountOAuth,
  readIssuerConfigFromEnv,
  readKeyOptionsFromEnv,
  seedDefaultClient,
} from './oauth/index.js';

const PORT = process.env.PORT || 3007;

async function start(): Promise<void> {

  // OAuth IdP 模块:启动时加载 RSA 密钥 + 跑 migration + seed 默认 client。
  // 任一失败立即 fail-fast。端点(/.well-known/* + /oauth/*)在 listen 前挂上,
  // 确保不会出现 "service 启动了但 IdP 暂未就绪" 的窗口
  await applyPendingMigrations();
  await seedDefaultClient();
  const keyStore = await loadKeyStore(readKeyOptionsFromEnv());
  const issuerConfig = readIssuerConfigFromEnv();
  mountOAuth(app, keyStore, issuerConfig);
  console.log(
    `OAuth IdP ready: issuer=${issuerConfig.issuer}, active_kid=${keyStore.active.kid}`,
  );

  const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `端口 ${PORT} 已被占用(EADDRINUSE)。请结束占用该端口的进程或设置环境变量 PORT 使用其他端口。`,
      );
    } else {
      console.error('HTTP 服务器 listen 错误:', err);
    }
    process.exit(1);
  });

  // 实时路径已切到 Go gateway:Socket.io 服务端默认停挂(代码保留,回滚方式见下)。
  // 回滚:设 REALTIME_MODE=socketio 重新挂载 initSocket(推送已走 downlink 的部分需同步回退,
  // 见 docs/plans/2026-09-15-web直切gateway连接层替换-design.md 的回滚说明)。
  const io = process.env.REALTIME_MODE === 'socketio' ? initSocket(server) : null;

  // gateway↔server 的 gRPC 流通道(26-9-16 演进方案 P1):承接网关上行帧与断连通知。
  // gateway 默认 http 模式时此服务空转无连接,无害;EDGE_GRPC_ENABLED=false 可显式关闭。
  if (process.env.EDGE_GRPC_ENABLED !== 'false') {
    const { startEdgeGrpc } = await import('./realtime/edgeGrpc.js');
    startEdgeGrpc(process.env.EDGE_GRPC_ADDR || '127.0.0.1:3008', console.log);
  }

  registerGracefulShutdown(server, io);
}

// 容器滚动发布会发 SIGTERM:停止接收新连接、断开 socket、收尾 DB/Redis 后再退出,
// 避免在途请求被掐断与连接泄漏。超时兜底强制退出。
function registerGracefulShutdown(server: HttpServer, io: SocketIOServer | null): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`收到 ${signal},开始优雅关闭`);
    const force = setTimeout(() => {
      console.error('优雅关闭超时(10s),强制退出');
      process.exit(1);
    }, 10_000);
    force.unref();
    try {
      if (io) {
        // io.close() 会同时关闭其挂载的 HTTP server(停止收新请求并排空在途)
        await new Promise<void>((resolve) => io.close(() => resolve()));
      } else {
        // 纯 HTTP(实时在 gateway):直接关 HTTP server。
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await prisma.$disconnect();
      await redis.quit();
      console.log('已优雅关闭,退出');
      process.exit(0);
    } catch (err) {
      console.error('优雅关闭出错:', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('服务启动失败:', error);
  process.exit(1);
});
