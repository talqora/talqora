// ConversationsTab 组件测试。覆盖:
//   - empty 态 + pickOne 占位
//   - 选中对话拉历史
//   - 新建对话
//   - 流式发送:placeholder 出现 → token 累加 → done 固化 citations
//   - 流式 error 移除 placeholder
//
// 重点是流式状态机 ── streamChat 是 AsyncGenerator,组件靠 for-await 消费 + 累加 content,
// 这条路径手测覆盖不到,必须 unit 测。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import type { ChatStreamEvent } from '../../type';

vi.mock('../../api', () => ({
  listConversations:        vi.fn(),
  createConversation:       vi.fn(),
  getConversation:          vi.fn(),
  deleteConversation:       vi.fn(),
  listConversationMessages: vi.fn(),
  streamChat:               vi.fn(),
}));

import ConversationsTab from './index';
import {
  createConversation,
  deleteConversation,
  listConversationMessages,
  listConversations,
  streamChat,
} from '../../api';
import type { AgentConversation, AgentMessage } from '../../type';
import { conversationFixture, userMsgFixture } from '../../__fixtures__/agentServer';

const mList   = vi.mocked(listConversations);
const mCreate = vi.mocked(createConversation);
const mMsgs   = vi.mocked(listConversationMessages);
const mDel    = vi.mocked(deleteConversation);
const mStream = vi.mocked(streamChat);

const conv = (over: Partial<AgentConversation> = {}): AgentConversation =>
  ({ ...conversationFixture, ...over });

const msg = (over: Partial<AgentMessage>): AgentMessage =>
  ({ ...userMsgFixture, ...over });

// 把数组包成 AsyncGenerator,模拟 streamChat 的返回
function asGen(events: ChatStreamEvent[]) {
  return (async function* () { for (const e of events) yield e; })();
}

beforeEach(() => {
  [mList, mCreate, mMsgs, mDel, mStream].forEach((m) => m.mockReset());
  mList.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe('<ConversationsTab>', () => {
  it('初次渲染 empty + pickOne 占位', async () => {
    renderWithProviders(<ConversationsTab />);
    await waitFor(() => expect(mList).toHaveBeenCalled());
    expect(screen.getByText('还没有对话')).toBeInTheDocument();
    expect(screen.getByText(/选一个对话开始/)).toBeInTheDocument();
  });

  it('点新建 → 调 createConversation,列表多一项,自动选中', async () => {
    const user = userEvent.setup();
    mCreate.mockResolvedValue(conv({ id: 42, title: '新对话' }));
    mMsgs.mockResolvedValue([]);

    renderWithProviders(<ConversationsTab />);
    await waitFor(() => expect(mList).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /新建/ }));

    await waitFor(() => expect(mCreate).toHaveBeenCalled());
    expect(await screen.findByText('新对话')).toBeInTheDocument();
    // 自动选中 → firstMsgHint 出现
    expect(await screen.findByText(/问个问题试试/)).toBeInTheDocument();
  });

  it('选中已有对话拉历史', async () => {
    const user = userEvent.setup();
    mList.mockResolvedValue([conv({ id: 1, title: 'chat-1' })]);
    mMsgs.mockResolvedValue([
      msg({ id: 10, role: 'user', content: 'hello' }),
      msg({ id: 11, role: 'assistant', content: 'hi back' }),
    ]);

    renderWithProviders(<ConversationsTab />);
    await user.click(await screen.findByText('chat-1'));

    expect(await screen.findByText('hello')).toBeInTheDocument();
    expect(await screen.findByText('hi back')).toBeInTheDocument();
    expect(mMsgs).toHaveBeenCalledWith(1);
  });

  it('流式发送:用户消息立刻显,assistant token 逐步累加,done 后留住内容', async () => {
    const user = userEvent.setup();
    mList.mockResolvedValue([conv({ id: 1 })]);
    mMsgs.mockResolvedValue([]);
    mStream.mockReturnValue(asGen([
      { type: 'token', value: 'Hel' },
      { type: 'token', value: 'lo!' },
      { type: 'done', messageId: 999, citations: [
        { chunkId: 1, documentId: 5, score: 0.91, filename: 'a.pdf' },
      ]},
    ]));

    renderWithProviders(<ConversationsTab />);
    await user.click(await screen.findByText(/聊天 1/));

    const ta = await screen.findByPlaceholderText(/问点什么/);
    await user.type(ta, 'what is X?');
    await user.keyboard('{Enter}');

    // 用户消息出现
    expect(await screen.findByText('what is X?')).toBeInTheDocument();

    // assistant 累加完成
    expect(await screen.findByText('Hello!')).toBeInTheDocument();

    // citations 渲染
    expect(await screen.findByText(/a\.pdf/)).toBeInTheDocument();

    // 调用契约
    expect(mStream).toHaveBeenCalledWith(1, 'what is X?', 6, expect.anything());

    // done 后刷新对话列表(服务端首轮会回填标题/排序)
    await waitFor(() => expect(mList).toHaveBeenCalledTimes(2));
  });

  it('流式中途切换对话(abort)→ 不弹"发送失败"toast,占位不残留', async () => {
    const user = userEvent.setup();
    mList.mockResolvedValue([conv({ id: 1, title: '聊天 1' }), conv({ id: 2, title: '聊天 2' })]);
    mMsgs.mockResolvedValue([]);
    // 模拟真实链路:读到被 abort 的流时,Chrome 抛 TypeError("BodyStreamBuffer was aborted")
    // (不是 DOMException(AbortError))——修复点是按 signal.aborted 判定"主动中止"
    mStream.mockImplementation((_id, _q, _k, signal?: AbortSignal) =>
      (async function* () {
        yield { type: 'token', value: 'partial' } as ChatStreamEvent;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new TypeError('BodyStreamBuffer was aborted');
      })(),
    );

    renderWithProviders(<ConversationsTab />);
    await user.click(await screen.findByText(/聊天 1/));
    const ta = await screen.findByPlaceholderText(/问点什么/);
    await user.type(ta, 'q1');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('partial')).toBeInTheDocument();

    // 切到对话 2:组件 abort 当前流(设计如此,防旧会话 token 串台)
    await user.click(screen.getByText(/聊天 2/));

    // 主动中止不是失败:不得弹错误 toast;旧对话的占位内容也不应残留
    await waitFor(() => expect(screen.queryByText(/发送失败/)).not.toBeInTheDocument());
    expect(screen.queryByText('partial')).not.toBeInTheDocument();
  });

  it('删除正在生成的对话 → 先 abort 流(避免写回已删会话)', async () => {
    const user = userEvent.setup();
    mList.mockResolvedValue([conv({ id: 5, title: 'kill-me' })]);
    mMsgs.mockResolvedValue([]);
    mDel.mockResolvedValue(undefined);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    let seenSignal: AbortSignal | undefined;
    mStream.mockImplementation((_id, _q, _k, signal?: AbortSignal) => {
      seenSignal = signal;
      return (async function* () {
        yield { type: 'token', value: 'partial' } as ChatStreamEvent;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new TypeError('BodyStreamBuffer was aborted');
      })();
    });

    renderWithProviders(<ConversationsTab />);
    await user.click(await screen.findByText('kill-me'));
    const ta = await screen.findByPlaceholderText(/问点什么/);
    await user.type(ta, 'q');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('partial')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /delete/ }));
    await waitFor(() => expect(mDel).toHaveBeenCalledWith(5));
    await waitFor(() => expect(seenSignal?.aborted).toBe(true));
    await waitFor(() => expect(screen.queryByText(/发送失败/)).not.toBeInTheDocument());
  });

  it('流式 error:placeholder 被移除,用户消息保留', async () => {
    const user = userEvent.setup();
    mList.mockResolvedValue([conv({ id: 1 })]);
    mMsgs.mockResolvedValue([]);
    mStream.mockReturnValue(asGen([
      { type: 'token', value: 'partial' },
      { type: 'error', message: 'llm failed' },
    ]));

    renderWithProviders(<ConversationsTab />);
    await user.click(await screen.findByText(/聊天 1/));

    const ta = await screen.findByPlaceholderText(/问点什么/);
    await user.type(ta, 'q');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('q')).toBeInTheDocument();
    // placeholder 应该被移除 ── 找不到 partial 内容
    await waitFor(() => expect(screen.queryByText('partial')).not.toBeInTheDocument());
  });

  it('删除对话:confirm 后调 deleteConversation', async () => {
    const user = userEvent.setup();
    mList.mockResolvedValue([conv({ id: 5, title: 'kill-me' })]);
    mDel.mockResolvedValue(undefined);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));

    renderWithProviders(<ConversationsTab />);
    await screen.findByText('kill-me');

    await user.click(screen.getByRole('button', { name: /delete/ }));
    await waitFor(() => expect(mDel).toHaveBeenCalledWith(5));
  });
});
