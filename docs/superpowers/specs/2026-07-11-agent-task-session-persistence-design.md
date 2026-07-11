# 设计:Agent 任务会话持久化(B 方案)

> 日期:2026-07-11 · 分支:`feat/agent-task-session-persistence`(our-chat + agent-server 两仓同名)
> 状态:已与用户确认(决策:**FK 关联 + proto 一等契约**)

## 1. 目标与背景

web 的 agent 模块里,**任务(tasks)tab 当前是纯内存**(`useState<ChatItem[]>`,刷新即丢)——没有历史、不能回看。对照物是同模块的**对话(conversations)tab**,它有完整的"会话列表 + 加载历史 + 流式"持久化闭环。

后端 `agent-server` 其实**已经把每次任务运行完整持久化**了:`Run`(kind=`agent_task`)+ `RunEvent`(事件溯源),`GET /runs/:id/stream` 支持 `Last-Event-ID` 断线重连回放,`GET /runs/:id` 取快照。缺的只是**把多次运行归组成一个可命名、可列举的"任务会话"**,以及前端的列表/详情/续播 UI。

**本设计 = 端到端对称复刻"对话"架构**,把 `Conversation/Message` 换成 `TaskSession/Run`。

一条"任务会话" = 一个可命名线程,按时间累积多个 `(任务 → 运行)` 对;刷新后从后端拉回整条 transcript,进行中的运行自动续播。

## 2. 架构对照

| 层 | 对话(已有,参照) | 任务会话(本设计新增) |
|---|---|---|
| 数据表 | `Conversation` → `Message[]` | `TaskSession` → `Run[]`(Run 已带 `RunEvent[]`) |
| 后端模块 | `modules/conversations` | `modules/task-sessions`(镜像) |
| 契约 | `AgentConversation` | `AgentTaskSession` |
| 前端 | `tabs/conversationsTab` | 重写 `tabs/tasksTab` |
| 提交 | `POST /conversations/:id/messages`(SSE) | `POST /agent/tasks`(加 `sessionId`)+ 既有 `GET /runs/:id/stream` |

## 3. 已确认的关键决策

- **决策 1 — Run↔TaskSession 用真 FK**:`Run.taskSessionId Int?` + `@relation(onDelete: Cascade)` + `@@index`。删会话 → 级联删 runs → 级联删 run_events。不复用 `refId`(其语义是摄取的 documentId,且无级联)。
- **决策 2 — `AgentTaskSession` 进 proto**:与 `AgentConversation` 平级的一等实体,走统一契约(`proto/ourchat/agent/v1/agent.proto`,两仓同步 + `buf generate`),不手写在 `type.ts`。

## 4. 契约变更(proto)

`proto/ourchat/agent/v1/agent.proto`(our-chat 与 agent-server 两份同步):
```proto
message AgentTaskSession {
  int32  id = 1;
  string title = 2;
  string created_at = 3;
  string updated_at = 4;
  repeated AgentRun runs = 5;   // 仅"取详情"填充;列表接口不带 runs
}
```
- `AgentRun` 已含 `events: RunEvent[]`,直接复用为 transcript 单元。
- `CreateTask` 请求增 `session_id`(必填);新增 `CreateTaskSession { title? }` 请求体。
- 跑 `buf lint` + `buf generate`(两仓)重生成 `web/src/contracts/gen/...`(以及 server/gateway,若 codegen 覆盖)。

## 5. 后端(agent-server)

### 5.1 schema(Prisma migration)
```prisma
model TaskSession {
  id        Int      @id @default(autoincrement())
  userId    Int      @map("user_id")
  title     String   @db.VarChar(255)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  user User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  runs Run[]
  @@index([userId, updatedAt])
  @@map("task_sessions")
}
// Run 增:
//   taskSessionId Int?  @map("task_session_id")
//   taskSession   TaskSession? @relation(fields: [taskSessionId], references: [id], onDelete: Cascade)
//   @@index([taskSessionId])
// User 增 runs 反向已存在;加 taskSessions TaskSession[]
```

### 5.2 新模块 `modules/task-sessions/`(镜像 `conversations`)
- `task-sessions.service.ts`:`create / list / get(含 runs.include(events),升序) / ensureOwned / delete`,全部 `userId` 归属校验(照 `conversations.service` 范式)。
- `task-sessions.controller.ts`:
  - `POST /agent/sessions`(`{ title? }`,默认"新任务会话")
  - `GET  /agent/sessions`(按 `updatedAt desc`,不带 runs)
  - `GET  /agent/sessions/:id`(会话 + `runs[]`,每 run `include events` 升序 = 整条 transcript)
  - `DELETE /agent/sessions/:id`(级联)
- DTO `create-task-session.dto.ts` `{ title?: string }`(class-validator)。
- 注册进 `AppModule`。

### 5.3 改 `agent.controller` `POST /agent/tasks`
- `CreateTaskDto` 增 `sessionId: number`(必填,`@IsInt`)。
- 处理:`ensureOwned(userId, sessionId)` → `createRun({ userId, kind:'agent_task', task: task.slice(0,255), refId? })` 需支持 `taskSessionId` → 入队 → `touch` 会话 `updatedAt`;**首次提交且标题仍是默认值时,用任务文本前 255 字回填标题**。返回 `{ runId }` 不变。
- `run-engine.createRun` 增 `taskSessionId?: number` 入参(写进 `Run.taskSessionId`)。
- `GET /runs/:id/stream`、`run-engine` 全套**不动**。

## 6. 前端(web,重写 `tabs/tasksTab`)

严格照 `conversationsTab` 骨架:
- **左侧**:会话列表 + 「新建」+ 删除。三态 **loading / empty / error**(web CLAUDE.md 硬规范,empty≠error)。
- **选中**:`getTaskSession(id)` 拉详情 → `runs[]` 铺成现有"用户气泡(run.task)+ 助手气泡(思考过程折叠 + final_answer)"transcript(复用现有 `AssistantBubble`/`StepRow`,数据源由内存 events 换成持久化 events)。
- **提交**:`submitAgentTask(text, sessionId)` → `runId` → `streamRun` 实时追加(照搬现有 `tasksTab.submit`)。
- **切换会话**:关闭旧 SSE(照 `conversationsTab` abort 模式)。
- `api.ts` 增:`listTaskSessions / createTaskSession / getTaskSession / deleteTaskSession`;`submitAgentTask` 加 `sessionId`。
- `type.ts` 从 gen 契约再导出 `AgentTaskSession`。
- i18n:`agent.tasks.*` 补 `list / new / empty / pickOne / confirmDelete / loadFail / createFail / deleteFail`(对齐 `agent.chat.*`),`zh` + `ts` 两份。

## 7. 断线续播(闭环收尾)

拉详情后,若**最后一个 run 非终态**(`queued/running`),自动 `streamRun(runId)` 续播——利用后端 `Last-Event-ID` 回放能力。刷新/切走再回来能接着看进行中的任务。

## 8. 错误处理与边界

- 列表/详情/提交全部覆盖 loading/empty/error;网络失败给人话 + 可重试;empty 不长得像 error。
- 越权 `sessionId` → 后端 404;前端 toast。
- 提交时 `activeSessionId == null` → 禁用提交(照 conversationsTab `activeId==null` 逻辑)。
- 切换会话中止旧 SSE,避免旧会话事件串渲到新会话。

## 9. 测试计划

- **agent-server**:`task-sessions.service` CRUD + 归属校验单测;`POST /agent/tasks` 带/缺/越权 `sessionId` 用例;`createRun` 写入 `taskSessionId`。
- **web**:`tasksTab` 列表三态、选中拉详情渲染 transcript、提交后流式追加、进行中续播;`api.ts` 新函数请求路径/参数。照现有 agentView 测试风格。
- **门禁**:agent-server lint/test 绿;web `npm run lint && npm test` 绿;`buf lint` 绿。

## 10. 实施顺序(跨两仓,同步)

1. **契约**:改 proto(两仓)→ `buf generate`(两仓)。
2. **agent-server**:schema + migration → `task-sessions` 模块 → 改 `agent.controller`/`run-engine` → 测试。
3. **web**:`api.ts` + `type.ts` → 重写 `tasksTab` + 样式 → i18n → 测试。
4. **闭环**:两仓各自 lint/test 绿 → code-review 自检 → 两仓同步提交(`--no-ff` 合并纪律按项目规范)。

## 11. 验收标准(成功定义)

- 新建任务会话、在其中连续提交多个任务、每个任务实时流式出思考过程 + 答案。
- **刷新页面后**:会话列表还在;点开任一会话能看到完整历史 transcript;进行中的任务继续续播直到终态。
- 删除会话级联清空其 runs + events。
- 多用户隔离:只能看/操作自己的会话。
- 两仓 lint + test + buf lint 全绿。
