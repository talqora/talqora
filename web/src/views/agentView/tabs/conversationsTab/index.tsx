// 对话 tab。左:对话列表 + 新建;右:消息流 + 输入框(SSE 流式 RAG)。
//
// 流式逻辑要点:
//   - 发送时先把用户消息塞进本地 messages,同时塞一条 placeholder assistant 消息
//   - 收到 token 事件 → 追加到 placeholder 的 content
//   - 收到 done 事件 → 固化 messageId + citations,允许下一轮发送
//   - 收到 error 事件 → 移除 placeholder,toast 报错
import { useCallback, useEffect, useRef, useState } from 'react';
import ChatComposer from '@/globalComponents/chatComposer';
import { useToast } from '@/globalComponents/toast';
import { useLang } from '@/i18n';
import {
  createConversation,
  deleteConversation,
  listConversationMessages,
  listConversations,
  streamChat,
} from '../../api';
import type { AgentConversation, AgentMessage, Citation } from '../../type';
import styles from './style.module.scss';

type DraftMessage = AgentMessage & { pending?: boolean };

function ConversationsTab() {
  const { t } = useLang();
  const toast = useToast();
  const [convs, setConvs] = useState<AgentConversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<DraftMessage[]>([]);
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadConvs = useCallback(async () => {
    try { setConvs(await listConversations()); }
    catch (e) { toast.err(`${t('agent.chat.loadFail')}: ${e instanceof Error ? e.message : String(e)}`); }
  }, [toast, t]);

  useEffect(() => { void loadConvs(); }, [loadConvs]);

  // 切换对话 → 中止当前流(防止旧会话 token 串到新会话渲染)+ 清消息 + 拉历史
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    if (activeId == null) { setMessages([]); return; }
    let cancelled = false;
    listConversationMessages(activeId)
      .then((ms) => { if (!cancelled) setMessages(ms); })
      .catch((e) => toast.err(`${t('agent.chat.loadFail')}: ${e instanceof Error ? e.message : String(e)}`));
    return () => { cancelled = true; };
  }, [activeId, toast, t]);

  // 消息更新滚到底
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages]);

  // 卸载时 abort 进行中的 SSE
  useEffect(() => () => abortRef.current?.abort(), []);

  const onCreate = async () => {
    try {
      const c = await createConversation();
      setConvs((xs) => [c, ...xs]);
      setActiveId(c.id);
    } catch (e) {
      toast.err(`${t('agent.chat.createFail')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onDelete = async (id: number) => {
    if (!confirm(t('agent.chat.confirmDelete'))) return;
    try {
      await deleteConversation(id);
      setConvs((xs) => xs.filter((c) => c.id !== id));
      if (activeId === id) { setActiveId(null); setMessages([]); }
    } catch (e) {
      toast.err(`${t('agent.chat.deleteFail')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (activeId == null || !q || sending) return;
    setSending(true);

    const ts = new Date().toISOString();
    const userMsg: DraftMessage = {
      id: -Date.now(),
      conversationId: activeId,
      role: 'user',
      content: q,
      citations: [],
      createdAt: ts,
    };
    const placeholder: DraftMessage = {
      id: -(Date.now() + 1),
      conversationId: activeId,
      role: 'assistant',
      content: '',
      citations: [],
      createdAt: ts,
      pending: true,
    };
    setMessages((xs) => [...xs, userMsg, placeholder]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      for await (const evt of streamChat(activeId, q, 6, ctrl.signal)) {
        if (evt.type === 'token') {
          setMessages((xs) =>
            xs.map((m) => (m.id === placeholder.id ? { ...m, content: m.content + evt.value } : m)),
          );
        } else if (evt.type === 'done') {
          setMessages((xs) =>
            xs.map((m) =>
              m.id === placeholder.id
                ? { ...m, id: evt.messageId, citations: evt.citations, pending: false }
                : m,
            ),
          );
        } else if (evt.type === 'error') {
          toast.err(evt.message);
          setMessages((xs) => xs.filter((m) => m.id !== placeholder.id));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'unauthorized') toast.err(`${t('agent.chat.sendFail')}: ${msg}`);
      setMessages((xs) => xs.filter((m) => m.id !== placeholder.id));
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  return (
    <div className={`${styles.wrap} ${activeId != null ? styles.has_active : ''}`}>
      {/* 对话列表 */}
      <aside className={styles.convList}>
        <div className={styles.convHead}>
          <span>{t('agent.chat.list')}</span>
          <button type="button" className={styles.newBtn} onClick={() => void onCreate()}>
            + {t('agent.chat.new')}
          </button>
        </div>
        <div className={styles.convScroll}>
          {convs.length === 0 && <div className={styles.empty}>{t('agent.chat.empty')}</div>}
          {convs.map((c) => (
            <div
              key={c.id}
              className={`${styles.convItem} ${activeId === c.id ? styles.convItemActive : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              <div className={styles.convTitle}>{c.title || `#${c.id}`}</div>
              <button
                type="button"
                className={styles.delBtn}
                onClick={(e) => { e.stopPropagation(); void onDelete(c.id); }}
                aria-label="delete"
              >
                <i className="iconfont icon-close" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* 右侧消息区 */}
      <section className={styles.chat}>
        {activeId == null
          ? <div className={styles.placeholder}>{t('agent.chat.pickOne')}</div>
          : (
            <>
              {/* 移动端返回:回到对话列表(桌面端 CSS 隐藏;微信式 "<" 角标) */}
              <button type="button" className={styles.backBtn} onClick={() => setActiveId(null)} aria-label="back" />
              <div className={styles.body} ref={bodyRef}>
                {messages.length === 0 && (
                  <div className={styles.placeholder}>{t('agent.chat.firstMsgHint')}</div>
                )}
                {messages.map((m) => <MsgBubble key={m.id} msg={m} />)}
              </div>
              <ChatComposer
                onSend={(text) => void send(text)}
                placeholder={t('agent.chat.placeholder')}
                sending={sending}
              />
            </>
          )
        }
      </section>
    </div>
  );
}

function MsgBubble({ msg }: { msg: DraftMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`${styles.msgRow} ${isUser ? styles.msgRowSelf : ''}`}>
      <div className={`${styles.bubble} ${isUser ? styles.bubbleSelf : styles.bubbleOther}`}>
        <div className={styles.bubbleContent}>
          {msg.content || (msg.pending ? '…' : '')}
        </div>
        {msg.citations && msg.citations.length > 0 && (
          <Citations cs={msg.citations} />
        )}
      </div>
    </div>
  );
}

function Citations({ cs }: { cs: Citation[] }) {
  return (
    <div className={styles.cites}>
      {cs.map((c, i) => (
        <span key={`${c.chunkId}-${i}`} className={styles.cite} title={`doc ${c.documentId}`}>
          [{i + 1}] {c.filename || `chunk#${c.chunkId}`} · {c.score.toFixed(2)}
        </span>
      ))}
    </div>
  );
}

export default ConversationsTab;
