// helpers 单元测试:persisted 行归一 + run 终态判定。
//
// 这是 live / persisted 双形状归一的核心 —— 归一错了 UI 读 data.payload 就崩。
// 从 __fixtures__ 取样本(persisted DB 行),不 inline 自造。

import { describe, expect, it } from 'vitest';
import { isTerminalStatus, normalizeRunEvent } from './helpers';
import { persistedRunEventRows } from '../../__fixtures__/agentServer';

describe('normalizeRunEvent', () => {
  it('把 persisted DB 行(eventType/payload 顶层)归一成 { id, type, data:row }', () => {
    const evt = normalizeRunEvent(persistedRunEventRows.finalAnswer);
    // type 取自 eventType(不是 type)
    expect(evt.type).toBe('final_answer');
    // id 取自 sequenceNo 的 string
    expect(evt.id).toBe('3');
    // data 是整条行 → data.payload 可用(与 live 事件统一)
    expect((evt.data?.payload as { content: string }).content).toBe('persisted answer');
  });

  it('tool_called 行:data.payload 下含 name / args', () => {
    const evt = normalizeRunEvent(persistedRunEventRows.toolCalled);
    expect(evt.type).toBe('tool_called');
    const payload = evt.data?.payload as { name: string; args: Record<string, unknown> };
    expect(payload.name).toBe('retrieve_knowledge');
    expect(payload.args).toEqual({ query: 'X' });
  });
});

describe('isTerminalStatus', () => {
  it('completed / failed / succeeded 为终态', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('succeeded')).toBe(true);
  });
  it('running / queued / undefined 非终态', () => {
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});
