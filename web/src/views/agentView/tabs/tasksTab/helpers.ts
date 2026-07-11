// 任务 tab 的纯函数助手:live / persisted 两种事件形状归一 + run 终态判定。
//
// 为什么要归一:
//   - live 事件(streamRun 回调)已是 { id, type, data },data 是整条 run_event 行(含 .payload)。
//   - persisted 事件(GET /agent/sessions/:id 里 run.events)是原始 DB 行:
//       { id, runId, sequenceNo, eventType, payload, createdAt } —— 字段是 eventType(非 type)、
//       payload 在顶层。
//   把 persisted 行归一成 { id: String(sequenceNo), type: eventType, data: row },因为 data=row
//   本身就带 .payload,AssistantBubble/StepRow 读 data.payload 对 live / persisted 就统一了。
import type { RunEvent } from '../../type';

// 持久化的原始 DB run_event 行(与 live 的 { id, type, data } 不同)。
export interface PersistedRunEventRow {
  id?: number | string;
  runId?: string;
  sequenceNo?: number;
  eventType?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

// persisted 行 → UI 统一形状。data 设为整行(含 .payload),与 live 一致。
export function normalizeRunEvent(row: PersistedRunEventRow): RunEvent {
  return {
    id: String(row.sequenceNo ?? row.id ?? ''),
    type: String(row.eventType ?? ''),
    data: row as Record<string, unknown>,
  };
}

// run 是否已到终态(不再有后续事件,无需续播)。
// agent-server 里 agent_task 走 succeeded,历史/兼容也接受 completed;失败为 failed。
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'succeeded']);
export function isTerminalStatus(status: string | undefined): boolean {
  return TERMINAL_STATUSES.has(status ?? '');
}
