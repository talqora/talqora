// Prisma Client 单例。应用层唯一 DB 入口,所有 SQL 都经此走(model API 或 $queryRaw)

import './bigint-json.js';
import { performance } from 'node:perf_hooks';
import { PrismaClient } from '../generated/prisma/index.js';
import { observeDbQueryDuration } from '../metrics/metrics.js';

// 跨 hot-reload 复用同一个实例,避免每次 nodemon/tsx watch 重启都新建连接池
const globalForPrisma = globalThis as unknown as {
  __prisma__?: PrismaClient;
};

const basePrisma: PrismaClient =
  globalForPrisma.__prisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma__ = basePrisma;
}

// db_query_duration_seconds 埋点:用 Prisma Client Extension 包一层,拦截每次「model 方法调用
// 或 $queryRaw/$executeRaw」,计时后转发给原始 query()。$extends 返回的对象结构上仍是
// PrismaClient(保留 $transaction/$queryRaw/$disconnect 等顶层方法,事务内 tx 也是同款扩展客户端),
// 换出的只是这里的导出对象本身——其余文件仍是 `import { prisma } from '.../database/prisma.js'`,
// 用法不变,不需要跟着改。
export const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const start = performance.now();
        try {
          return await query(args);
        } finally {
          observeDbQueryDuration(model ?? 'raw', operation, (performance.now() - start) / 1000);
        }
      },
    },
  },
});
