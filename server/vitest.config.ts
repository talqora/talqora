import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // 集成测试共享真 PG/Redis 且多个文件订阅同一 gw:downlink 频道,
    // 并行跑会互相收到对方的 pub/sub 消息导致断言串扰 → 串行执行文件。
    fileParallelism: false,
  },
});
