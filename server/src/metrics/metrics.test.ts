import { describe, it, expect } from 'vitest';
import {
  register,
  metricsText,
  observeMessageDuration,
  incConnections,
  decConnections,
  wsConnections,
} from './metrics.js';

describe('metrics', () => {
  it('observeMessageDuration 后 register.metrics() 文本里出现 histogram bucket', async () => {
    observeMessageDuration(0.02);
    const text = await register.metrics();
    expect(text).toContain('server_message_duration_seconds_bucket');
  });

  it('incConnections/decConnections 正确增减 gauge', async () => {
    const before = (await wsConnections.get()).values[0]?.value ?? 0;
    incConnections();
    incConnections();
    decConnections();
    const after = (await wsConnections.get()).values[0]?.value ?? 0;
    expect(after).toBe(before + 1);
  });

  it('metricsText 返回非空的 Prometheus 文本', async () => {
    const text = await metricsText();
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});
