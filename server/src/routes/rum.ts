import { Router } from 'express';
import { z } from 'zod';
import { observeRumVital } from '../metrics/metrics.js';

const router = Router();

// 前端 web-vitals 信标上报体。外部输入(浏览器 beacon)必须 runtime 校验,不能只信类型。
const rumBeaconInput = z.object({
  name: z.enum(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']),
  value: z.number(),
  rating: z.enum(['good', 'needs-improvement', 'poor']),
  delta: z.number().optional(),
  id: z.string().max(128).optional(),
  navigationType: z.string().max(64).optional(),
  path: z.string().max(512).optional(),
  ts: z.number().optional(),
});

// web-vitals 上报:延迟类指标(LCP/INP/FCP/TTFB)原始单位是毫秒,换算为秒与其它
// duration 类指标(server_message_duration_seconds 等)对齐;CLS 本身是无量纲分值,原样上报。
router.post('/rum', (req, res) => {
  const parsed = rumBeaconInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: 'RUM 上报参数非法' });
    return;
  }
  const { name, rating, value } = parsed.data;
  const observedValue = name === 'CLS' ? value : value / 1000;
  observeRumVital(name, rating, observedValue);
  res.status(204).end();
});

export default router;
