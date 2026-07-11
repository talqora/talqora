// agent-server 客户端。
//
// Base URL 通过 env 注入,跨源由 agent-server 自己 CORS 白名单管理,前端不再走
// vite proxy 折中(理由见 docs/agent-server接入选型复盘.md)。
//   - dev: 在 .env.development 配 VITE_AGENT_API_BASE=http://localhost:3101/api
//   - prod: 在 .env.production 配 VITE_AGENT_API_BASE=https://agent.your-domain.com/api
//   - 没配时回退 http://localhost:3101/api(本地约定默认值)
//
// 鉴权(微信式一键登录):token 不在本文件铸造,由 agentAuth.ensureAgentToken()
// 复用 our-chat 已登录会话,经 BFF 铸一枚 agent-server-scoped 的 RS256 token,
// 存 localStorage 'agentServer.token'。本文件只负责读写该 token(getToken/setToken)
// 并在每个请求带上 Authorization,401 自动清空让上层引导回 our-chat 重登。
//
// SSE 走 fetch + ReadableStream(EventSource 不能带自定义 header,token 改走
// query param ?access_token=...,agent-server 已兼容)。

import type {
  AgentConversation,
  AgentDocument,
  AgentMessage,
  AgentRun,
  AgentTaskResp,
  AgentTaskSession,
  AgentUser,
  ChatStreamEvent,
  RunEvent,
  UploadDocResp,
} from './type';

// vite 编译期内联 import.meta.env.VITE_*。
// 不直接 export 是因为测试要能覆盖,见 __mocks__ 或 vi.stubGlobal('import.meta', ...) 模式。
export const BASE: string =
  (import.meta.env.VITE_AGENT_API_BASE as string | undefined) ?? 'http://localhost:3101/api';

const TOKEN_KEY = 'agentServer.token';

// ── token 读写 ─────────────────────────────────────────────────────
export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else   localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

// ── fetch 包装:统一加 Authorization,401 自动清 token ─────────────
async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    setToken(null);
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── 鉴权 ───────────────────────────────────────────────────────────
// token 铸造在 agentAuth.ensureAgentToken();这里只验活(拿当前 token 取用户)。
export async function agentMe(): Promise<AgentUser> {
  return request('/auth/me');
}

// ── 健康检查 ──────────────────────────────────────────────────────
export async function agentHealth(): Promise<{
  status: 'ok' | 'degraded';
  details: Record<string, { status: string; latencyMs?: number; error?: string }>;
}> {
  return request('/health');
}

// ── 文档 ───────────────────────────────────────────────────────────
export async function listDocuments(): Promise<AgentDocument[]> {
  return request('/documents');
}

export async function getDocument(id: number): Promise<AgentDocument> {
  return request(`/documents/${id}`);
}

export async function deleteDocument(id: number): Promise<void> {
  await request(`/documents/${id}`, { method: 'DELETE' });
}

export async function uploadDocument(file: File): Promise<UploadDocResp> {
  const form = new FormData();
  form.append('file', file);
  return request('/documents', { method: 'POST', body: form });
}

// ── 对话 ───────────────────────────────────────────────────────────
export async function listConversations(): Promise<AgentConversation[]> {
  return request('/conversations');
}

export async function createConversation(title?: string): Promise<AgentConversation> {
  return request('/conversations', {
    method: 'POST',
    body: JSON.stringify({ title: title ?? '新对话' }),
  });
}

export async function getConversation(id: number): Promise<AgentConversation> {
  return request(`/conversations/${id}`);
}

export async function deleteConversation(id: number): Promise<void> {
  await request(`/conversations/${id}`, { method: 'DELETE' });
}

// 对话流式发送 ── 调用方拿到 AsyncIterable,for-await 逐 token 渲染
export async function* streamChat(
  conversationId: number,
  query: string,
  topK = 6,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent, void, void> {
  const token = getToken();
  const res = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, topK }),
    signal,
  });

  if (res.status === 401) { setToken(null); throw new Error('unauthorized'); }
  if (!res.ok || !res.body) throw new Error(`chat stream ${res.status}`);

  // 服务端帧的 data 在 token/done 上自带 type,在 error 上仅 { message }(只在 SSE
  // event: 行里出现 'error')。这里以 event 名为权威,统一补全 ChatStreamEvent.type。
  for await (const frame of readSSE(res.body)) {
    if (frame.event === 'error') {
      const m = (frame.data as { message?: string }) ?? {};
      yield { type: 'error', message: m.message ?? 'unknown error' };
      continue;
    }
    // event 是 'token' / 'done' 时,data 本身就是合法的 ChatStreamEvent(自带 type)
    yield frame.data as ChatStreamEvent;
  }
}

export async function listConversationMessages(id: number): Promise<AgentMessage[]> {
  const conv = await getConversation(id);
  return conv.messages ?? [];
}

// ── 任务会话 ───────────────────────────────────────────────────────
// 与对话 CRUD 对齐:列表不带 runs,详情带 runs(整段 transcript)。
export async function listTaskSessions(): Promise<AgentTaskSession[]> {
  return request('/agent/sessions');
}

export async function createTaskSession(title?: string): Promise<AgentTaskSession> {
  return request('/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: title ?? '新任务会话' }),
  });
}

export async function getTaskSession(id: number): Promise<AgentTaskSession> {
  return request(`/agent/sessions/${id}`);
}

export async function deleteTaskSession(id: number): Promise<void> {
  await request(`/agent/sessions/${id}`, { method: 'DELETE' });
}

// ── Agent 任务 ─────────────────────────────────────────────────────
// sessionId 现为必填:任务必须归属某个任务会话(便于持久化 + 续播)。
export async function submitAgentTask(task: string, sessionId: number): Promise<AgentTaskResp> {
  return request('/agent/tasks', {
    method: 'POST',
    body: JSON.stringify({ task, sessionId }),
  });
}

export async function getRun(runId: string): Promise<AgentRun> {
  return request(`/runs/${runId}`);
}

// 跟 RunEventType 同步;新增 type 后两边都要加。
// agent-server 用 NestJS @Sse() 发送 MessageEvent { id, type, data },落到 SSE
// 协议会写成 `event: <type>\ndata: <json>\n\n` ── 带 `event:` 头的事件 EventSource
// 不会触发默认 onmessage(它只接 `event: message` 或无 event 行),必须 addEventListener
// 各个具体名字。这是当初没读 Nest @Sse 实现拍脑袋写错的核心 bug。
const RUN_EVENT_TYPES: ReadonlyArray<RunEvent['type']> = [
  'run_started',
  'run_completed',
  'run_failed',
  'progress',
  'tool_called',
  'tool_result',
  'final_answer',
  'ingestion_parsed',
  'ingestion_chunked',
  'ingestion_embedded',
];

// Run 事件流(EventSource 不能带 header,token 走 query)。
export function streamRun(
  runId: string,
  onEvent: (e: RunEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  const token = getToken();
  const qs = new URLSearchParams();
  if (token) qs.set('access_token', token);
  const url = `${BASE}/runs/${runId}/stream${qs.toString() ? `?${qs}` : ''}`;
  const es = new EventSource(url, { withCredentials: false });

  const dispatch = (evtType: RunEvent['type']) => (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      onEvent({ id: e.lastEventId || '', type: evtType, data });
    } catch { /* skip malformed */ }
  };

  for (const t of RUN_EVENT_TYPES) es.addEventListener(t, dispatch(t));
  if (onError) es.onerror = onError;
  return () => es.close();
}

// 解析后的 SSE 帧。event / id 来自帧首部行,data 来自 `data:` 行(多行合并 + JSON.parse)。
// JSON 失败时 data 退化为 `{ raw }`,保留原始文本以便调试。
export interface SSEFrame {
  event?: string;
  id?: string;
  data: unknown;
}

// 从 fetch 响应体读 text/event-stream。
// export 以便单元测试直接覆盖(SSE 分帧/跨 chunk/坏 JSON/event 行 都是 bug 重灾区)。
//
// 历史教训:早期版本只读 `data:` 行、丢弃 `event:` 行,导致 NestJS 发的
// `event: error\ndata: {"message":"..."}` 错误帧 type 字段丢失,UI 错误处理静默失效。
// 现在统一返回结构化帧,把消费侧的事件分发权交给上层。
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE 帧以 \n\n 分隔
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frameText = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        let event: string | undefined;
        let id: string | undefined;
        const dataLines: string[] = [];

        for (const line of frameText.split('\n')) {
          if (!line || line.startsWith(':')) continue;          // 注释行
          const colon = line.indexOf(':');
          if (colon < 0) continue;                              // 不合规
          const field = line.slice(0, colon);
          // SSE 规范:冒号后可有单个空格,其余按字面保留
          const v = line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = v;
          else if (field === 'id') id = v;
          else if (field === 'data') dataLines.push(v);
        }

        if (dataLines.length === 0) continue;
        const raw = dataLines.join('\n');
        let data: unknown;
        try { data = JSON.parse(raw); } catch { data = { raw }; }
        yield { event, id, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
