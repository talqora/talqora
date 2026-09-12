// gateway 运行时埋点探针:注册/登录一个用户 → 用 Cookie token 连 gateway /ws(原生 WS)
// → 发一条 message.send 上行帧 → 等下行回显 → 退出。用于验证 gateway 的 uplink/downlink/连接指标。
// 依赖 ws(npm i ws)。用法:node gw-probe.mjs
import WebSocket from 'ws';

const HTTP = process.env.BASE || 'http://localhost:3007';
const WS = process.env.GW || 'ws://localhost:8090/ws';
const PW = 'probe123456';

async function reg(username, email) {
  const r = await fetch(`${HTTP}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password: PW }),
  });
  return r.status; // 200 新建 / 409 已存在都可接受
}

async function login(username) {
  const r = await fetch(`${HTTP}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  });
  const j = await r.json();
  if (!j?.success) throw new Error(`login 失败: ${JSON.stringify(j)}`);
  const d = j.data || {};
  const token = d.token;
  const id = d.id ?? d.userId ?? d.userInfo?.id;
  if (!token || id == null) throw new Error(`login 返回缺 token/id: ${JSON.stringify(d)}`);
  return { token, id: Number(id) };
}

async function main() {
  await reg('probe_a', 'probe_a@bench.local');
  await reg('probe_b', 'probe_b@bench.local');
  const a = await login('probe_a');
  const b = await login('probe_b');
  console.log(`[gw-probe] probe_a id=${a.id} probe_b id=${b.id}`);

  const convo = `single_${Math.min(a.id, b.id)}_${Math.max(a.id, b.id)}`;
  const ws = new WebSocket(`${WS}?deviceId=gw-probe`, {
    headers: { Cookie: `token=${a.token}` },
  });

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等下行回显超时(5s)')), 5000);
    ws.on('open', () => {
      console.log('[gw-probe] ws 已连接,发送 message.send 上行帧');
      ws.send(JSON.stringify({
        type: 'message.send',
        clientMsgId: `probe-${Date.now()}`,
        conversationId: convo,
        content: 'gateway probe hello',
        // 注意:message 的 type 字段与信封 type 同名,gateway PoC 直接透传整帧,这里不再单列
      }));
    });
    ws.on('message', (data) => {
      clearTimeout(timer);
      console.log('[gw-probe] 收到下行:', String(data).slice(0, 200));
      resolve('downlink-received');
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  try {
    const r = await done;
    console.log(`[gw-probe] 结果: ${r}`);
  } catch (e) {
    console.log(`[gw-probe] 未收到下行(uplink 仍应已计数): ${e.message}`);
  } finally {
    ws.close();
    setTimeout(() => process.exit(0), 500);
  }
}

main().catch((e) => { console.error('[gw-probe] 失败:', e); process.exit(1); });
