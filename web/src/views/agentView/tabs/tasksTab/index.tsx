// Agent 任务 tab(会话持久化)。左:任务会话列表(新建 / 删除);右:该会话的整段
// transcript(用户气泡 + 助手气泡:思考过程 tool_called/tool_result + final_answer 答案)。
//
// 三条持久化能力(对齐"对话 tab"):
//   1. 列表 + 详情:GET /agent/sessions、GET /agent/sessions/:id(带 runs)
//   2. 选中即加载整段历史:把 session.runs 映射成 ChatItem[]
//   3. 续播:刷新后对任何非终态 run 重新 streamRun 订阅,把后续事件继续追加渲染
//
// 事件形状归一见 helpers.normalizeRunEvent:
//   - live 事件(streamRun 回调)本就是 { id, type, data },data 是整条 run_event 行(含 .payload)
//   - persisted 事件是原始 DB 行 { eventType, payload, ... },归一后 data=行,UI 读 data.payload 统一
import { useCallback, useEffect, useRef, useState } from 'react';
import ChatComposer from '@/globalComponents/chatComposer';
import { useToast } from '@/globalComponents/toast';
import { useLang } from '@/i18n';
import {
  createTaskSession,
  deleteTaskSession,
  getTaskSession,
  listTaskSessions,
  streamRun,
  submitAgentTask,
} from '../../api';
import type { AgentTaskSession, RunEvent } from '../../type';
import { isTerminalStatus, normalizeRunEvent } from './helpers';
import styles from './style.module.scss';

interface UserItem { kind: 'user'; id: string; text: string }
interface AssistantItem { kind: 'assistant'; id: string; runId: string; events: RunEvent[]; done: boolean }
type ChatItem = UserItem | AssistantItem;

// 列表三态:empty 不能长得像 error(web 渲染三态约束)。
type ListState = 'loading' | 'ready' | 'error';

// 终态事件(用于 live 追加时判定 done)。与 isTerminalStatus 是两个维度:
// 前者看 run.status(持久化时已知),后者看流里到没到收尾事件。
const TERMINAL_EVENTS: RunEvent['type'][] = ['run_completed', 'run_failed', 'final_answer'];

function TasksTab() {
  const { t } = useLang();
  const toast = useToast();
  const [sessions, setSessions] = useState<AgentTaskSession[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [listState, setListState] = useState<ListState>('loading');
  const closersRef = useRef<Record<string, () => void>>({});
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 关闭并清空所有 SSE 订阅(切会话 / 卸载都要)。
  const closeAll = useCallback(() => {
    Object.values(closersRef.current).forEach((close) => close());
    closersRef.current = {};
  }, []);

  // live / 续播共用的事件追加:把某 runId 的助手气泡追加事件、按终态置 done。
  const appendEvt = useCallback((runId: string, evt: RunEvent) => {
    setItems((xs) =>
      xs.map((it) =>
        it.kind === 'assistant' && it.runId === runId
          ? { ...it, events: [...it.events, evt], done: it.done || TERMINAL_EVENTS.includes(evt.type) }
          : it,
      ),
    );
  }, []);

  const markDone = useCallback((runId: string) => {
    setItems((xs) =>
      xs.map((it) => (it.kind === 'assistant' && it.runId === runId ? { ...it, done: true } : it)),
    );
    closersRef.current[runId]?.();
    delete closersRef.current[runId];
  }, []);

  const loadSessions = useCallback(async () => {
    setListState('loading');
    try {
      setSessions(await listTaskSessions());
      setListState('ready');
    } catch (e) {
      setListState('error');
      toast.err(`${t('agent.tasks.loadFail')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [toast, t]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);

  // 切换会话 → 关掉旧订阅 + 清消息 + 拉历史 + 对非终态 run 续播。
  useEffect(() => {
    closeAll();

    if (activeId == null) { setItems([]); return; }
    let cancelled = false;

    getTaskSession(activeId)
      .then((session) => {
        if (cancelled) return;
        const runs = session.runs ?? [];
        const next: ChatItem[] = [];
        for (const run of runs) {
          next.push({ kind: 'user', id: `u-${run.runId}`, text: run.task ?? '' });
          next.push({
            kind: 'assistant',
            id: `a-${run.runId}`,
            runId: run.runId,
            events: (run.events ?? []).map(normalizeRunEvent),
            done: isTerminalStatus(run.status),
          });
        }
        setItems(next);

        // 续播:任何非终态 run 重新订阅,把后续事件继续追加。
        for (const run of runs) {
          if (isTerminalStatus(run.status)) continue;
          const runId = run.runId;
          const close = streamRun(
            runId,
            (evt) => { if (!cancelled) appendEvt(runId, evt); },
            () => { if (!cancelled) markDone(runId); },
          );
          closersRef.current[runId] = close;
        }
      })
      .catch((e) => {
        if (!cancelled) toast.err(`${t('agent.tasks.loadFail')}: ${e instanceof Error ? e.message : String(e)}`);
      });

    return () => { cancelled = true; };
    // appendEvt/markDone/closeAll 是稳定 useCallback;activeId 变化才重跑。
  }, [activeId, toast, t, appendEvt, markDone, closeAll]);

  // 新内容来 → 滚到底
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [items]);

  // 卸载时关闭所有 SSE
  useEffect(() => () => closeAll(), [closeAll]);

  const onCreate = async () => {
    try {
      const s = await createTaskSession();
      setSessions((xs) => [s, ...xs]);
      setActiveId(s.id);
    } catch (e) {
      toast.err(`${t('agent.tasks.createFail')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onDelete = async (id: number) => {
    if (!confirm(t('agent.tasks.confirmDelete'))) return;
    try {
      await deleteTaskSession(id);
      setSessions((xs) => xs.filter((s) => s.id !== id));
      if (activeId === id) { setActiveId(null); setItems([]); }
    } catch (e) {
      toast.err(`${t('agent.tasks.deleteFail')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const submit = async (text: string) => {
    if (activeId == null || submitting) return;
    const sessionId = activeId;
    setSubmitting(true);
    try {
      const { runId } = await submitAgentTask(text, sessionId);
      setItems((xs) => [
        ...xs,
        { kind: 'user', id: `u-${runId}`, text },
        { kind: 'assistant', id: `a-${runId}`, runId, events: [], done: false },
      ]);
      // 把当前会话乐观置顶(与对话 tab 保持 active 在前一致)。
      setSessions((xs) => {
        const cur = xs.find((s) => s.id === sessionId);
        return cur ? [cur, ...xs.filter((s) => s.id !== sessionId)] : xs;
      });

      const close = streamRun(
        runId,
        (evt) => appendEvt(runId, evt),
        () => markDone(runId),
      );
      closersRef.current[runId] = close;
    } catch (e) {
      toast.err(`${t('agent.tasks.submitFail')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`${styles.wrap} ${activeId != null ? styles.has_active : ''}`}>
      {/* 任务会话列表 */}
      <aside className={styles.sessList}>
        <div className={styles.sessHead}>
          <span>{t('agent.tasks.list')}</span>
          <button type="button" className={styles.newBtn} onClick={() => void onCreate()}>
            + {t('agent.tasks.new')}
          </button>
        </div>
        <div className={styles.sessScroll}>
          {listState === 'loading' && <div className={styles.empty}>…</div>}
          {listState === 'error' && (
            <div className={styles.listError}>
              {t('agent.tasks.loadFail')}
              <button type="button" className={styles.retryBtn} onClick={() => void loadSessions()}>
                {t('agent.tasks.retry')}
              </button>
            </div>
          )}
          {listState === 'ready' && sessions.length === 0 && (
            <div className={styles.empty}>{t('agent.tasks.emptyList')}</div>
          )}
          {listState === 'ready' && sessions.map((s) => (
            <div
              key={s.id}
              className={`${styles.sessItem} ${activeId === s.id ? styles.sessItemActive : ''}`}
              onClick={() => setActiveId(s.id)}
            >
              <div className={styles.sessTitle}>{s.title || `#${s.id}`}</div>
              <button
                type="button"
                className={styles.delBtn}
                onClick={(e) => { e.stopPropagation(); void onDelete(s.id); }}
                aria-label="delete"
              >
                <i className="iconfont icon-close" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* 右侧任务对话区 */}
      <section className={styles.chat}>
        {activeId == null
          ? <div className={styles.placeholder}>{t('agent.tasks.pickOne')}</div>
          : (
            <>
              {/* 移动端返回:回到会话列表(桌面端 CSS 隐藏) */}
              <button type="button" className={styles.backBtn} onClick={() => setActiveId(null)} aria-label="back" />
              <div className={styles.body} ref={bodyRef}>
                {items.length === 0 && (
                  <div className={styles.placeholder}>{t('agent.tasks.firstTaskHint')}</div>
                )}
                {items.map((it) =>
                  it.kind === 'user' ? (
                    <div key={it.id} className={`${styles.msgRow} ${styles.msgRowSelf}`}>
                      <div className={styles.userBubble}>{it.text}</div>
                    </div>
                  ) : (
                    <AssistantBubble key={it.id} item={it} />
                  ),
                )}
              </div>
              <ChatComposer
                onSend={(text) => void submit(text)}
                placeholder={t('agent.tasks.placeholder')}
                sending={submitting}
                sendLabel={t('agent.tasks.submit')}
              />
            </>
          )
        }
      </section>
    </div>
  );
}

function AssistantBubble({ item }: { item: AssistantItem }) {
  const { t } = useLang();
  const steps = item.events.filter((e) => e.type === 'tool_called' || e.type === 'tool_result');
  const finalEvt = item.events.find((e) => e.type === 'final_answer');
  const failed = item.events.some((e) => e.type === 'run_failed');
  // SSE / persisted 的 data 都是整条 run_event 行,真正的字段在 data.payload 下
  const finalPayload = (finalEvt?.data?.payload ?? {}) as Record<string, unknown>;
  const answer = typeof finalPayload.content === 'string' ? finalPayload.content : '';
  const toolCount = item.events.filter((e) => e.type === 'tool_called').length;

  return (
    <div className={styles.msgRow}>
      <div className={styles.bubble}>
        {steps.length > 0 && (
          <details className={styles.think} open={!item.done}>
            <summary className={styles.thinkSummary}>
              {t('agent.tasks.thinkProcess')} · {t('agent.tasks.steps', { count: toolCount })}
            </summary>
            <div className={styles.trace}>
              {steps.map((e, i) => <StepRow key={`${e.id}-${i}`} evt={e} />)}
            </div>
          </details>
        )}
        {answer ? (
          <div className={styles.answer}>{answer}</div>
        ) : failed ? (
          <div className={styles.err}>{t('agent.tasks.failed')}</div>
        ) : !item.done ? (
          <div className={styles.thinking}>{t('agent.tasks.thinking')}</div>
        ) : null}
      </div>
    </div>
  );
}

function StepRow({ evt }: { evt: RunEvent }) {
  // SSE / persisted 的 data 是整条 run_event 行,真正的字段在 data.payload 下
  const payload = (evt.data?.payload ?? {}) as Record<string, unknown>;
  if (evt.type === 'tool_called') {
    const name = String(payload.name ?? '');
    const argsObj = (payload.args ?? {}) as Record<string, unknown>;
    const args = Object.keys(argsObj).length > 0 ? JSON.stringify(argsObj) : '';
    return (
      <div className={styles.step}>
        <span className={styles.stepTool}>🔧 {name}</span>
        {args && <span className={styles.stepArgs}>{args}</span>}
      </div>
    );
  }
  const result = String(payload.result ?? '');
  return (
    <div className={styles.step}>
      <span className={styles.stepResultLabel}>↳</span>
      <pre className={styles.stepResult}>{result}</pre>
    </div>
  );
}

export default TasksTab;
