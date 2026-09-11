import { Router } from 'express';
import { register, metricsText } from '../metrics/metrics.js';

const router = Router();

// Prometheus 抓取端点。刻意不挂在 /api 下、不加鉴权中间件:
// Prometheus server 匿名抓取,且抓取路径按惯例固定为根路径 /metrics。
router.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await metricsText());
});

export default router;
