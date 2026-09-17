#!/usr/bin/env node
// Node(3007) 与 Go(3009) 双跑逐接口字段级对比。
// 用法: node diff-api.mjs [nodeBase] [goBase]
// 规则: 两侧用同构请求(动态值如用户名分侧替换),递归比较响应 JSON:
//   - 键集合必须一致
//   - 每个键的值类型必须一致(number/string/bool/null/object/array)
//   - 时间字符串按格式归类比较(ISO 毫秒 UTC)
// 输出: 差异清单(逐条)。exit 0 = 无结构差异。
import { createHash } from 'node:crypto';

const NODE = process.argv[2] || 'http://localhost:3007';
const GO = process.argv[3] || 'http://localhost:3009';

const ts = Date.now();
const nodeUser = `diffn_${ts}`;
const goUser = `diffg_${ts}`;
const password = 'diff_pw_123456';

const results = [];
let nodeToken = '', goToken = '', nodeId = '', goId = '';

async function httpReq(base, method, path, { body, token, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { __raw: text }; }
  return { status: res.status, json, headers: res.headers };
}

// 递归类型骨架: {key: type} / 数组元素骨架
function shapeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? 'array[]' : ['array', shapeOf(v[0])];
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = shapeOf(val);
    return out;
  }
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(v)) return 'time';
    if (/^\d+$/.test(v)) return 'intstr';
    return 'string';
  }
  return typeof v;
}

function diffShapes(a, b, path = '$', out = []) {
  if (a === b) return out;
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of Object.keys(a)) {
      if (!(k in b)) out.push(`${path}.${k}: 仅 Node 有`);
    }
    for (const k of Object.keys(b)) {
      if (!(k in a)) out.push(`${path}.${k}: 仅 Go 有`);
    }
    for (const k of Object.keys(a)) {
      if (k in b) diffShapes(a[k], b[k], `${path}.${k}`, out);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: 数组长度 ${a.length} vs ${b.length}`);
    else for (let i = 0; i < a.length; i++) diffShapes(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  out.push(`${path}: 类型 ${a} vs ${b}`);
  return out;
}

async function compare(name, method, path, { body: bodyFn, token: tokenFn, skipStatus = false, pathFn } = {}) {
  try {
    const nb = bodyFn ? bodyFn('node') : undefined;
    const gb = bodyFn ? bodyFn('go') : undefined;
    const nt = tokenFn ? tokenFn('node') : undefined;
    const gt = tokenFn ? tokenFn('go') : undefined;
    const n = await httpReq(NODE, method, pathFn ? pathFn('node') : path, { body: nb, token: nt });
    const g = await httpReq(GO, method, pathFn ? pathFn('go') : path, { body: gb, token: gt });
    const diffs = diffShapes(shapeOf(n.json), shapeOf(g.json));
    const statusDiff = !skipStatus && n.status !== g.status ? [`HTTP 状态 ${n.status} vs ${g.status}`] : [];
    const all = [...statusDiff, ...diffs];
    if (all.length === 0) {
      console.log(`✓ ${name}  [${n.status}]`);
    } else {
      console.log(`✗ ${name}  [Node ${n.status} / Go ${g.status}]`);
      for (const d of all.slice(0, 6)) console.log(`    - ${d}`);
      if (all.length > 6) console.log(`    ... 共 ${all.length} 条差异`);
    }
    results.push({ name, diffs: all });
  } catch (e) {
    console.log(`✗ ${name}  请求异常: ${e.message}`);
    results.push({ name, diffs: [`请求异常 ${e.message}`] });
  }
}

// 值注入器:把请求体中的占位用户名按侧替换
function withUser(user, extra = {}) {
  return (side) => ({ username: side === 'node' ? nodeUser : goUser, ...extra, __side: side, __user: user });
}

async function main() {
  console.log(`== Node ${NODE} vs Go ${GO} 字段级对比 ==\n`);

  // ── 注册/登录/校验 ──
  await compare('POST /api/register', 'POST', '/api/register', {
    body: (side) => ({
      username: side === 'node' ? nodeUser : goUser,
      email: `${side}_${ts}@diff.test`,
      password,
      phone: '',
      nickname: 'diff 用户',
      avatar: '',
      bio: 'bio',
    }),
    skipStatus: false,
  });
  await compare('POST /api/register 重复(409)', 'POST', '/api/register', {
    body: (side) => ({
      username: side === 'node' ? nodeUser : goUser,
      email: `${side}_${ts}@diff.test`,
      password,
    }),
  });
  await compare('POST /api/register 校验失败(400)', 'POST', '/api/register', {
    body: () => ({ username: 'x', email: 'bad', password: '1' }),
  });
  await compare('GET /api/check-username', 'GET', `/api/check-username?username=${nodeUser}`, {
    body: null,
  });

  // 登录拿 token
  const nLogin = await httpReq(NODE, 'POST', '/api/login', { body: { username: nodeUser, password } });
  const gLogin = await httpReq(GO, 'POST', '/api/login', { body: { username: goUser, password } });
  nodeToken = nLogin.json?.data?.token || '';
  goToken = gLogin.json?.data?.token || '';
  nodeId = nLogin.json?.data?.id || '';
  goId = gLogin.json?.data?.id || '';
  diffShapes(shapeOf(nLogin.json), shapeOf(gLogin.json)).forEach((d) => console.log(`✗ POST /api/login: ${d}`));
  if (nLogin.status !== gLogin.status) console.log(`✗ POST /api/login: HTTP 状态 ${nLogin.status} vs ${gLogin.status}`);
  else console.log(`✓ POST /api/login  [${nLogin.status}]`);

  await compare('POST /api/login 密码错误(400)', 'POST', '/api/login', {
    body: () => ({ username: nodeUser, password: 'wrong-password' }),
  });

  // ── 用户 ──
  await compare('GET /user/profile', 'GET', '/user/profile', { token: (s) => (s === 'node' ? nodeToken : goToken) });
  await compare('POST /user/update', 'POST', '/user/update', {
    body: (s) => ({ id: s === 'node' ? String(nodeId) : String(goId), nickname: '新昵称', bio: '新bio' }),
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });

  // ── 会话与消息 ──
  await compare('GET /user/userConversations', 'GET', '/user/userConversations', {
    body: null,
    pathFn: (s) => `/user/userConversations?userId=${s === 'node' ? nodeId : goId}`,
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });
  await compare('GET /user/conversations 空', 'GET', '/user/conversations?userConversationIds=%5B%5D', {
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });
  await compare('GET /user/messages 缺参(400)', 'GET', '/user/messages', {
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });

  // 建立单聊会话(updateConversationTime)后拉消息/同步
  await compare('POST /user/updateConversationTime', 'POST', '/user/updateConversationTime', {
    body: (s) => ({ conversationId: `single_diff_${ts}`, userId: s === 'node' ? String(nodeId) : String(goId) }),
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });

  // 发消息(经 internal uplink,两侧同构)
  const cmid = `diff-msg-${ts}`;
  const nUp = await httpReq(NODE, 'POST', '/internal/gateway/uplink', {
    body: { type: 'message.send', data: { clientMsgId: cmid, conversationId: `single_diff_${ts}`, content: 'hello diff', type: 'text' } },
    headers: { 'X-Gateway-Token': 'dev-internal-token', 'X-User-Id': String(nodeId), 'X-Device-Id': 'diff-dev' },
  });
  const gUp = await httpReq(GO, 'POST', '/internal/gateway/uplink', {
    body: { type: 'message.send', data: { clientMsgId: cmid, conversationId: `single_diff_${ts}`, content: 'hello diff', type: 'text' } },
    headers: { 'X-Gateway-Token': 'dev-internal-token', 'X-User-Id': String(goId), 'X-Device-Id': 'diff-dev' },
  });
  const upDiff = diffShapes(shapeOf(nUp.json), shapeOf(gUp.json));
  if (nUp.status !== gUp.status) upDiff.push(`HTTP 状态 ${nUp.status} vs ${gUp.status}`);
  if (upDiff.length === 0) console.log(`✓ POST /internal/gateway/uplink  [${nUp.status}]`);
  else { console.log(`✗ POST /internal/gateway/uplink`); upDiff.forEach((d) => console.log(`    - ${d}`)); }

  await compare('GET /user/messages', 'GET', `/user/messages?conversationId=single_diff_${ts}`, {
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });
  await compare('GET /user/lastMessages', 'GET', `/user/lastMessages?userConversationIds=%5B%22single_diff_${ts}%22%5D`, {
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });
  await compare('GET /user/sync', 'GET', `/user/sync?conv=single_diff_${ts}&since=0&limit=50&device=diff-dev`, {
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });
  await compare('GET /user/sync 参数非法(400)', 'GET', '/user/sync?conv=x&since=abc', {
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });
  await compare('POST /user/read', 'POST', '/user/read', {
    body: () => ({ conversationId: `single_diff_${ts}`, uptoSeq: 1 }),
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });
  await compare('GET /user/mentions', 'GET', '/user/mentions', { token: (s) => (s === 'node' ? nodeToken : goToken) });
  await compare('GET /user/readCount', 'GET', `/user/readCount?conv=single_diff_${ts}&seq=1`, {
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });

  // ── 好友(第二对用户做全流程) ──
  const nodeB = `diffnb_${ts}`, goB = `diffgb_${ts}`;
  await httpReq(NODE, 'POST', '/api/register', { body: { username: nodeB, email: `nb_${ts}@diff.test`, password } });
  await httpReq(GO, 'POST', '/api/register', { body: { username: goB, email: `gb_${ts}@diff.test`, password } });
  const nBLogin = await httpReq(NODE, 'POST', '/api/login', { body: { username: nodeB, password } });
  const gBLogin = await httpReq(GO, 'POST', '/api/login', { body: { username: goB, password } });
  const nodeBToken = nBLogin.json?.data?.token || '', goBToken = gBLogin.json?.data?.token || '';
  const nodeBId = nBLogin.json?.data?.id || '', goBId = gBLogin.json?.data?.id || '';

  await compare('PUT /user/addFriend', 'PUT', '/user/addFriend', {
    body: (s) => ({ userId: s === 'node' ? String(nodeBId) : String(goBId), friendId: s === 'node' ? String(nodeId) : String(goId) }),
    token: (s) => (s === 'node' ? nodeBToken : goBToken),
  });
  {
    const n = await httpReq(NODE, 'GET', `/user/getFriendReqs?userId=${nodeId}`, { token: nodeToken });
    const g = await httpReq(GO, 'GET', `/user/getFriendReqs?userId=${goId}`, { token: goToken });
    const nv = Object.values(n.json?.data || {});
    const gv = Object.values(g.json?.data || {});
    const diffs = [];
    if (nv.length && gv.length) diffs.push(...diffShapes(shapeOf(nv[0]), shapeOf(gv[0]), 'data.*'));
    if (n.status !== g.status) diffs.push(`HTTP ${n.status} vs ${g.status}`);
    if (diffs.length === 0) console.log('✓ GET /user/getFriendReqs B视角(值骨架)');
    else { console.log('✗ GET /user/getFriendReqs B视角'); diffs.forEach((d) => console.log(`    - ${d}`)); }
    results.push({ name: 'getFriendReqs 值骨架', diffs });
  }
  await compare('PUT /user/replyFriendReq accepted', 'PUT', '/user/replyFriendReq', {
    body: (s) => ({ userId: s === 'node' ? String(nodeId) : String(goId), friendId: s === 'node' ? String(nodeBId) : String(goBId), status: 'accepted' }),
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });
  // 好友列表以动态 userId 为键,两侧 id 不同 → 对比「值骨架」而非键
  {
    const n = await httpReq(NODE, 'GET', `/user/getFriendList/${nodeId}`, { token: nodeToken });
    const g = await httpReq(GO, 'GET', `/user/getFriendList/${goId}`, { token: goToken });
    const nv = Object.values(n.json?.data?.friendId || {});
    const gv = Object.values(g.json?.data?.friendId || {});
    const ni = Object.values(n.json?.data?.friendInfo || {});
    const gi = Object.values(g.json?.data?.friendInfo || {});
    const diffs = [];
    if (n.json?.data?.friendId === undefined) diffs.push('Node 缺 friendId');
    if (g.json?.data?.friendId === undefined) diffs.push('Go 缺 friendId');
    if (nv.length && gv.length) diffs.push(...diffShapes(shapeOf(nv[0]), shapeOf(gv[0]), 'friendId.*'));
    if (ni.length && gi.length) diffs.push(...diffShapes(shapeOf(ni[0]), shapeOf(gi[0]), 'friendInfo.*'));
    if (n.status !== g.status) diffs.push(`HTTP ${n.status} vs ${g.status}`);
    if (diffs.length === 0) console.log('✓ GET /user/getFriendList A视角(已接受, 值骨架)');
    else { console.log('✗ GET /user/getFriendList A视角'); diffs.forEach((d) => console.log(`    - ${d}`)); }
    results.push({ name: 'getFriendList 值骨架', diffs });
  }
  await compare('PUT /user/updateRemark', 'PUT', '/user/updateRemark', {
    body: (s) => ({ userId: s === 'node' ? String(nodeId) : String(goId), friendId: s === 'node' ? String(nodeBId) : String(goBId), remark: '好友备注' }),
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });
  await compare('GET /user/searchUser 已是好友', 'GET', '/user/searchUser', {
    pathFn: (s) => `/user/searchUser?keyword=${s === 'node' ? nodeB : goB}&userId=${s === 'node' ? nodeId : goId}`,
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });
  await compare('GET /user/searchUser 不存在', 'GET', `/user/searchUser?keyword=no_such_user_${ts}&userId=${nodeId}`, {
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });
  // 好友列表/请求已由上方「值骨架」版本覆盖(动态 userId 键不做键级对比)

  // ── TURN ──
  await compare('GET /api/turn-credentials', 'GET', '/api/turn-credentials', {
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });

  // ── 上传 ──
  await compare('POST /api/upload/check 未命中', 'POST', '/api/upload/check', {
    body: () => ({ fileMD5: '0'.repeat(32) }),
    token: (s) => (s === 'node' ? nodeToken : goToken),
  });

  // ── OAuth ──
  await compare('GET /.well-known/openid-configuration', 'GET', '/.well-known/openid-configuration');
  await compare('GET /.well-known/jwks.json', 'GET', '/.well-known/jwks.json');
  await compare('POST /oauth/token 缺参', 'POST', '/oauth/token', {
    body: () => ({ grant_type: 'authorization_code' }),
  });
  await compare('GET /oauth/authorize 非法client(400 JSON)', 'GET', '/oauth/authorize?client_id=nope&redirect_uri=http://x&state=s');

  // OAuth 授权码全流程(PKCE S256)
  async function oauthFlow(base, token, side) {
    const clientId = 'our-chat-web';
    const redirect = 'http://localhost:5173/oauth/callback';
    const state = `st-${side}-${ts}`;
    const verifier = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abCdEfGhIjKlMnOpQrStUvWxYz0123';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    // 1. authorize(带会话 cookie)→ 302 → code
    const authRes = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&scope=openid%20profile&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&nonce=n1`,
      { redirect: 'manual', headers: { Cookie: `token=${token}` } },
    );
    const loc = authRes.headers.get('location') || '';
    const code = new URL(loc).searchParams.get('code');
    // 2. token 换发
    const tokRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: verifier }),
    });
    const tok = await tokRes.json();
    // 3. userinfo
    const uiRes = await fetch(`${base}/oauth/userinfo`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const ui = await uiRes.json();
    // 4. refresh
    const refRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tok.refresh_token }),
    });
    const ref = await refRes.json();
    return {
      tokenShape: shapeOf(tok), tokenStatus: tokRes.status,
      userinfo: ui, userinfoStatus: uiRes.status,
      refreshShape: shapeOf(ref), refreshStatus: refRes.status,
      hasIdToken: typeof tok.id_token === 'string',
    };
  }
  const nOAuth = await oauthFlow(NODE, nodeToken, 'node');
  const gOAuth = await oauthFlow(GO, goToken, 'go');
  const oauthDiffs = diffShapes(nOAuth.tokenShape, gOAuth.tokenShape)
    .concat(diffShapes(shapeOf(nOAuth.userinfo), shapeOf(gOAuth.userinfo)))
    .concat(diffShapes(nOAuth.refreshShape, gOAuth.refreshShape));
  if (nOAuth.tokenStatus !== gOAuth.tokenStatus) oauthDiffs.push(`token HTTP ${nOAuth.tokenStatus} vs ${gOAuth.tokenStatus}`);
  if (nOAuth.userinfoStatus !== gOAuth.userinfoStatus) oauthDiffs.push(`userinfo HTTP ${nOAuth.userinfoStatus} vs ${gOAuth.userinfoStatus}`);
  if (nOAuth.hasIdToken !== gOAuth.hasIdToken) oauthDiffs.push(`id_token 存在性 ${nOAuth.hasIdToken} vs ${gOAuth.hasIdToken}`);
  if (oauthDiffs.length === 0) console.log('✓ OAuth 授权码全流程(PKCE/token/userinfo/refresh)');
  else { console.log('✗ OAuth 授权码全流程'); oauthDiffs.slice(0, 8).forEach((d) => console.log(`    - ${d}`)); }
  results.push({ name: 'OAuth 全流程', diffs: oauthDiffs });

  // ── RUM / 内部 ──
  await compare('POST /api/rum 参数非法(400)', 'POST', '/api/rum', {
    body: () => ({ name: 'BAD', value: 1, rating: 'good' }),
  });
  await compare('POST /internal/gateway/uplink 令牌错误(401)', 'POST', '/internal/gateway/uplink', {
    body: () => ({ type: 'message.send' }),
    headers: { 'X-Gateway-Token': 'wrong-token' },
  });

  // ── 汇总 ──
  const failed = results.filter((r) => r.diffs.length > 0);
  console.log(`\n== 汇总: ${results.length - failed.length}/${results.length} 通过, ${failed.length} 有差异 ==`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
