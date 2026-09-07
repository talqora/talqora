// agent 契约类型来自 agent-server 发布的类型包(权威是 agent-server 的 proto,本端只消费)。
// 不再从 our-chat 本地 gen 引入——agent 域已从本仓 proto 移除,统一由 agent-server 维护。
import type { Citation } from '@talqora/agent-contracts';

export type {
  AgentUser,
  AgentDocument,
  UploadDocResp,
  Citation,
  AgentMessage,
  AgentConversation,
  RunEvent,
  AgentRun,
  AgentTaskResp,
  AgentTaskSession,
  ChatDoneEvent,
} from '@talqora/agent-contracts';

export type DocStatus =
  | 'uploaded'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'ready'
  | 'failed';

export type MessageRole = 'user' | 'assistant' | 'system';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

// 对话流事件:SSE event 名作判别(token 逐字 / done 完成带引用 / error 收尾)
export type ChatStreamEvent =
  | { type: 'token'; value: string }
  | { type: 'done'; messageId: number; citations: Citation[] }
  | { type: 'error'; message: string };

// Run 事件类型(SSE event 名):run 生命周期 + agent 工具调用 + 摄取步骤
export type RunEventType =
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'progress'
  | 'tool_called'
  | 'tool_result'
  | 'final_answer'
  | 'ingestion_parsed'
  | 'ingestion_chunked'
  | 'ingestion_embedded';
