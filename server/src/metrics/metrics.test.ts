import { describe, it, expect } from 'vitest';
import {
  register,
  metricsText,
  observeMessageDuration,
  incConnections,
  decConnections,
  wsConnections,
  observeHttpRequestDuration,
  observeDbQueryDuration,
  incOnlineUsers,
  decOnlineUsers,
  observeBroadcastRecipients,
  incCallEvent,
  incActiveCalls,
  decActiveCalls,
  incWsDisconnect,
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

  it('observeHttpRequestDuration 后 register.metrics() 文本里出现 http_request_duration_seconds', async () => {
    observeHttpRequestDuration('GET', '/user/:id', 200, 0.01);
    const text = await register.metrics();
    expect(text).toContain('http_request_duration_seconds_bucket');
    expect(text).toContain('method="GET"');
    expect(text).toContain('route="/user/:id"');
    expect(text).toContain('status="200"');
  });

  it('observeDbQueryDuration 后 register.metrics() 文本里出现 db_query_duration_seconds', async () => {
    observeDbQueryDuration('User', 'findMany', 0.005);
    const text = await register.metrics();
    expect(text).toContain('db_query_duration_seconds_bucket');
    expect(text).toContain('model="User"');
    expect(text).toContain('operation="findMany"');
  });

  it('incOnlineUsers/decOnlineUsers 正确增减 server_online_users', async () => {
    incOnlineUsers();
    incOnlineUsers();
    decOnlineUsers();
    const text = await register.metrics();
    expect(text).toContain('server_online_users 1');
  });

  it('observeBroadcastRecipients 后 register.metrics() 文本里出现 server_broadcast_recipients', async () => {
    observeBroadcastRecipients(5);
    const text = await register.metrics();
    expect(text).toContain('server_broadcast_recipients_bucket');
  });

  it('incCallEvent 按 event 标签计数 server_call_events_total', async () => {
    incCallEvent('start');
    incCallEvent('start');
    incCallEvent('end');
    const text = await register.metrics();
    expect(text).toContain('server_call_events_total{event="start"} 2');
    expect(text).toContain('server_call_events_total{event="end"} 1');
  });

  it('incActiveCalls/decActiveCalls 正确增减 server_active_calls', async () => {
    incActiveCalls();
    incActiveCalls();
    decActiveCalls();
    const text = await register.metrics();
    expect(text).toContain('server_active_calls 1');
  });

  it('incWsDisconnect 按 reason 标签计数 server_ws_disconnects_total', async () => {
    incWsDisconnect('transport close');
    const text = await register.metrics();
    expect(text).toContain('server_ws_disconnects_total{reason="transport close"} 1');
  });
});
