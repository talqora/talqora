// TasksTab 测试(会话持久化)。覆盖:
//   (a) mount 调 listTaskSessions;空列表 → 显示 emptyList 文案(且 ≠ error 文案)
//   (b) listTaskSessions reject → error 态(retry 按钮出现)
//   (c) 选中会话 → 调 getTaskSession;persisted final_answer 渲染答案 + 用户气泡
//   (d) 选中含 running run 的会话 → streamRun 用该 runId 续播
//   (e) 有 activeId → submit 调 submitAgentTask(text, activeId);无 activeId → 输入框不渲染
//
// streamRun 是 EventSource 包装,这里直接 mock,手动 push 事件。
// 整个 ../../api 模块 mock 掉,数据从 __fixtures__ 取(不 inline 自造)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/render';

vi.mock('../../api', () => ({
  listTaskSessions:  vi.fn(),
  createTaskSession: vi.fn(),
  getTaskSession:    vi.fn(),
  deleteTaskSession: vi.fn(),
  submitAgentTask:   vi.fn(),
  streamRun:         vi.fn(),
}));

import TasksTab from './index';
import {
  getTaskSession,
  listTaskSessions,
  streamRun,
  submitAgentTask,
} from '../../api';
import {
  agentTaskRespFixture,
  completedRunFixture,
  taskSessionDetailFixture,
  taskSessionListFixture,
} from '../../__fixtures__/agentServer';

const mList   = vi.mocked(listTaskSessions);
const mGet    = vi.mocked(getTaskSession);
const mSubmit = vi.mocked(submitAgentTask);
const mStream = vi.mocked(streamRun);

beforeEach(() => {
  [mList, mGet, mSubmit, mStream].forEach((m) => m.mockReset());
  mList.mockResolvedValue([]);
  mStream.mockReturnValue(() => undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('<TasksTab>', () => {
  it('(a) mount 调 listTaskSessions;空列表显示 emptyList(≠ error)', async () => {
    renderWithProviders(<TasksTab />);
    await waitFor(() => expect(mList).toHaveBeenCalled());

    expect(await screen.findByText('还没有任务会话')).toBeInTheDocument();
    // empty 不能长得像 error:error 文案不应出现
    expect(screen.queryByText('加载失败')).not.toBeInTheDocument();
  });

  it('(b) listTaskSessions reject → error 态 + 重试按钮', async () => {
    mList.mockRejectedValue(new Error('boom'));
    renderWithProviders(<TasksTab />);

    expect(await screen.findByText('加载失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    // 不应显示 empty 文案
    expect(screen.queryByText('还没有任务会话')).not.toBeInTheDocument();
  });

  it('(c) 选中会话 → 调 getTaskSession,渲染 persisted 答案 + 用户气泡', async () => {
    const user = userEvent.setup();
    mList.mockResolvedValue([taskSessionListFixture]);
    // 只给一个已完成 run(避免续播分支干扰断言)
    mGet.mockResolvedValue({ ...taskSessionDetailFixture, runs: [completedRunFixture] });

    renderWithProviders(<TasksTab />);
    await user.click(await screen.findByText('任务会话 1'));

    await waitFor(() => expect(mGet).toHaveBeenCalledWith(1));
    // persisted final_answer.payload.content
    expect(await screen.findByText('persisted answer')).toBeInTheDocument();
    // 用户气泡 = run.task
    expect(screen.getByText('总结我最新上传的文档')).toBeInTheDocument();
  });

  it('(d) 选中含 running run 的会话 → streamRun 用该 runId 续播', async () => {
    const user = userEvent.setup();
    mList.mockResolvedValue([taskSessionListFixture]);
    mGet.mockResolvedValue(taskSessionDetailFixture); // 含 run-A(succeeded)+ run-B(running)

    renderWithProviders(<TasksTab />);
    await user.click(await screen.findByText('任务会话 1'));

    await waitFor(() => expect(mGet).toHaveBeenCalledWith(1));
    // 只对非终态 run-B 续播,run-A(succeeded)不订阅
    await waitFor(() =>
      expect(mStream).toHaveBeenCalledWith('run-B', expect.any(Function), expect.any(Function)),
    );
    expect(mStream).not.toHaveBeenCalledWith('run-A', expect.any(Function), expect.any(Function));
  });

  it('(e) 有 activeId 时 submit 调 submitAgentTask(text, activeId)', async () => {
    const user = userEvent.setup();
    mList.mockResolvedValue([taskSessionListFixture]);
    mGet.mockResolvedValue({ ...taskSessionListFixture, runs: [] });
    mSubmit.mockResolvedValue(agentTaskRespFixture);

    renderWithProviders(<TasksTab />);
    await user.click(await screen.findByText('任务会话 1'));
    await waitFor(() => expect(mGet).toHaveBeenCalledWith(1));

    const ta = await screen.findByPlaceholderText(/描述一个任务/);
    await user.type(ta, 'do the thing');
    await user.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(mSubmit).toHaveBeenCalledWith('do the thing', 1));
    // 提交后订阅 streamRun
    expect(mStream).toHaveBeenCalledWith(
      agentTaskRespFixture.runId, expect.any(Function), expect.any(Function),
    );
    // 用户气泡显示
    expect(await screen.findByText('do the thing')).toBeInTheDocument();
  });

  it('(e2) 无 activeId 时不渲染输入框(submit 不可达)', async () => {
    renderWithProviders(<TasksTab />);
    await waitFor(() => expect(mList).toHaveBeenCalled());

    // 未选会话 → pickOne 占位,输入框/提交按钮都不在
    expect(screen.getByText('选择或新建一个任务会话')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/描述一个任务/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
    expect(mSubmit).not.toHaveBeenCalled();
  });
});
