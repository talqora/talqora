// 错误路径探针:socket.io 连接后发一条"缺 conversationId"的非法 message.send,
// 验证 server_message_out_total{result="error"} 计数与 message.error 回执。
import { io } from 'socket.io-client';

const HTTP = process.env.BASE || 'http://localhost:3007';
const PW = 'probe123456';

async function login(username) {
  const r = await fetch(`${HTTP}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  });
  const j = await r.json();
  if (!j?.success) throw new Error(`login 失败: ${JSON.stringify(j)}`);
  return j.data.token;
}

const token = await login('probe_a');
const socket = io(HTTP, { auth: { token, deviceId: 'err-probe' }, transports: ['websocket'] });

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('超时')), 5000);
  socket.on('connect', () => {
    console.log('[err-probe] 已连接,发送非法 message.send(缺 conversationId)');
    socket.emit('message.send', { clientMsgId: 'bad-1', content: 'x' }); // 无 conversationId
  });
  socket.on('message.error', (e) => {
    clearTimeout(timer);
    console.log('[err-probe] 收到 message.error:', JSON.stringify(e).slice(0, 120));
    resolve();
  });
  socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
});
socket.close();
setTimeout(() => process.exit(0), 300);
