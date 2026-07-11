# Agent 任务会话持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 web agent 模块的"任务 tab"加会话持久化——多次任务运行归组成可命名、可列举、可回看、可续播的"任务会话",端到端对称复刻现有"对话(conversations)"架构。

**Architecture:** 新增 `TaskSession` 实体(FK 关联 `Run`,级联删)+ agent-server `task-sessions` 模块(镜像 `conversations`)+ `AgentTaskSession` 一等 proto 契约;前端重写 `tasksTab` 为"会话列表 + 详情 transcript + 流式 + 断线续播"。跨 `our-chat`(proto/web)+ `agent-server`(backend)两仓,分支 `feat/agent-task-session-persistence`。

**Tech Stack:** proto3 + buf codegen;NestJS + Prisma(PostgreSQL)+ class-validator + BullMQ;React + Redux 项目(本功能用组件态,照 conversationsTab)+ Vitest + i18next。

**参照物(执行者必读,照抄范式):**
- 后端:`agent-server/apps/node-server/src/modules/conversations/{conversations.service.ts,conversations.controller.ts,dto/create-conversation.dto.ts,conversations.module.ts}`
- 前端:`our-chat/web/src/views/agentView/tabs/conversationsTab/{index.tsx,style.module.scss}`、`api.ts`(对话段)
- 契约:`our-chat/proto/ourchat/agent/v1/agent.proto`(`AgentConversation` 定义)、生成物 `web/src/contracts/gen/ourchat/agent/v1/agent.ts`

**关键约定:** 两仓 proto 必须逐字节一致;每个后端服务方法都做 `userId` 归属校验;前端列表/详情/提交三态齐全(loading/empty/error,empty≠error);commit 走中文 `type(scope): 描述`,无 AI 署名;两仓各自频繁小步提交。

---

## Task 1: 契约 — proto 加 `AgentTaskSession` + `session_id`(两仓同步 + buf generate)

**Files:**
- Modify: `/Users/mac/our-chat/proto/ourchat/agent/v1/agent.proto`
- Modify: `/Users/mac/agent-server/proto/ourchat/agent/v1/agent.proto`(与上完全一致)
- Regen(命令产出):`/Users/mac/our-chat/web/src/contracts/gen/ourchat/agent/v1/agent.ts`(+ server/gateway 若覆盖)

- [ ] **Step 1: 读现有 proto,定位 `AgentConversation` / `AgentRun` / CreateTask 相关 message**

Run: `sed -n '1,200p' /Users/mac/our-chat/proto/ourchat/agent/v1/agent.proto`
先确认字段号风格、`AgentRun`(已含 `repeated RunEvent events`)、任务提交请求 message 名(可能是 `CreateTaskReq`/`AgentTaskReq`)与 `AgentTaskResp`。

- [ ] **Step 2: 加 `AgentTaskSession` message + 给任务提交请求加 `session_id` + 加建会话请求**

在 agent.proto 里(字段号接现有风格;下面为语义,字段号按文件实际最大值续):
```proto
// 任务会话:归组多次 agent 任务运行(对齐 AgentConversation)
message AgentTaskSession {
  int32 id = 1;
  string title = 2;
  string created_at = 3;
  string updated_at = 4;
  repeated AgentRun runs = 5; // 仅取详情时填充;列表不带
}

// 建任务会话请求
message CreateTaskSessionReq {
  string title = 1;
}
message ListTaskSessionsResp { repeated AgentTaskSession sessions = 1; }
```
并在现有任务提交请求 message(如 `CreateTaskReq`)加:`int32 session_id = <next>;`

- [ ] **Step 3: 两仓 proto 同步**

把 Step 2 的改动 **逐字节** 复制到 `/Users/mac/agent-server/proto/ourchat/agent/v1/agent.proto`。
Run: `diff /Users/mac/our-chat/proto/ourchat/agent/v1/agent.proto /Users/mac/agent-server/proto/ourchat/agent/v1/agent.proto`
Expected: 无差异(exit 0)。

- [ ] **Step 4: buf lint + generate(our-chat)**

Run: `cd /Users/mac/our-chat && buf lint && buf generate`
Expected: lint 无 error;`web/src/contracts/gen/ourchat/agent/v1/agent.ts` 出现 `export interface AgentTaskSession`。
Run: `grep -n 'AgentTaskSession' web/src/contracts/gen/ourchat/agent/v1/agent.ts`

- [ ] **Step 5: buf generate(agent-server,若其有独立 codegen)**

Run: `cd /Users/mac/agent-server && (buf generate 2>/dev/null || echo "agent-server 无 buf codegen,后端用 Prisma 类型,跳过")`
说明:agent-server 后端不消费生成的 TS 契约(它用 `@prisma/client` 类型 + 手写 DTO),proto 仅作契约同步与文档;若无 codegen 目标则仅保持 proto 文件同步即可。

- [ ] **Step 6: web 类型编译自检**

Run: `cd /Users/mac/our-chat/web && npx tsc --noEmit -p tsconfig.json 2>&1 | head`
Expected: 不因 gen 变更报错(新增 interface 不破坏现有)。

- [ ] **Step 7: Commit(两仓各自)**

```bash
cd /Users/mac/our-chat && git add proto web/src/contracts/gen && git commit -m "feat(contract): agent 契约加 AgentTaskSession + 任务提交带 session_id"
cd /Users/mac/agent-server && git add proto && git commit -m "feat(contract): agent 契约加 AgentTaskSession + 任务提交带 session_id(与 our-chat 同步)"
```

---

## Task 2: agent-server — Prisma schema 加 `TaskSession` + `Run.taskSessionId`

**Files:**
- Modify: `/Users/mac/agent-server/apps/node-server/prisma/schema.prisma`
- Generated: 新 migration 目录 `prisma/migrations/*_add_task_sessions/`

- [ ] **Step 1: 加 `TaskSession` model + `Run.taskSessionId` FK + `User.taskSessions`**

在 schema.prisma:
```prisma
// User model 内加反向关系:
//   taskSessions TaskSession[]

// ============ 任务会话(归组 agent 任务运行)============
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

// Run model 内加:
//   taskSessionId Int?         @map("task_session_id")
//   taskSession   TaskSession? @relation(fields: [taskSessionId], references: [id], onDelete: Cascade)
//   @@index([taskSessionId])
```

- [ ] **Step 2: 生成并应用 migration**

Run: `cd /Users/mac/agent-server/apps/node-server && npx prisma migrate dev --name add_task_sessions`
Expected: 新建 `task_sessions` 表 + `runs.task_session_id` 列 + 外键;Prisma client 重生成。
（若本地无 DB 连接:改用 `npx prisma migrate diff` 生成 SQL 或在有 `DATABASE_URL` 的环境跑;记录到 plan 执行日志。）

- [ ] **Step 3: 验证 Prisma client 类型**

Run: `npx prisma generate && node -e "const {PrismaClient}=require('@prisma/client'); new PrismaClient().taskSession; console.log('taskSession model ok')"`
Expected: 打印 `taskSession model ok`(无 undefined 报错)。

- [ ] **Step 4: Commit**

```bash
cd /Users/mac/agent-server && git add apps/node-server/prisma && git commit -m "feat(db): 加 TaskSession 表 + Run.taskSessionId 外键(级联删)"
```

---

## Task 3: agent-server — `task-sessions` 模块(service + controller + DTO + 测试)

**Files:**
- Create: `apps/node-server/src/modules/task-sessions/task-sessions.service.ts`
- Create: `apps/node-server/src/modules/task-sessions/task-sessions.controller.ts`
- Create: `apps/node-server/src/modules/task-sessions/dto/create-task-session.dto.ts`
- Create: `apps/node-server/src/modules/task-sessions/task-sessions.module.ts`
- Create: `apps/node-server/src/modules/task-sessions/task-sessions.service.spec.ts`
- Modify: `apps/node-server/src/app.module.ts`(imports 加 `TaskSessionsModule`)

**镜像 `modules/conversations` 的每个对应文件。差异点:**
- 实体从 `conversation/message` 换成 `taskSession/run`。
- `get(userId,id)`:`include: { runs: { include: { events: { orderBy:{sequenceNo:'asc'} } }, orderBy: { createdAt: 'asc' } } }`。
- 路由前缀 `@Controller('agent/sessions')`(注意:agent-server 全局无 `/api` 前缀由反代加;沿用 conversations 的 controller 前缀风格——conversations 是 `@Controller('conversations')`,故这里用 `@Controller('agent/sessions')`)。
- DTO:`CreateTaskSessionDto { @IsOptional() @IsString() @MaxLength(255) title?: string }`。

- [ ] **Step 1: 写 service 失败测试** `task-sessions.service.spec.ts`

照 `conversations.service` 若有 spec 则仿其;否则用 prisma mock。核心用例:
```ts
// create: 传 userId+title → prisma.taskSession.create 被调、返回行
// list: 按 userId 过滤、updatedAt desc
// get: 命中且 userId 匹配 → 返回含 runs(每 run 含 events);userId 不匹配 → throw NotFoundException
// delete: ensureOwned 通过 → prisma.taskSession.delete;不属己 → NotFoundException
```
Run: `cd /Users/mac/agent-server/apps/node-server && npx jest task-sessions.service --silent`
Expected: FAIL(模块不存在)。

- [ ] **Step 2: 写 DTO / service / controller / module**

- `create-task-session.dto.ts`:如上 DTO。
- `task-sessions.service.ts`:`create/list/get/ensureOwned/delete`,逐一照 `conversations.service.ts` 改实体;`get` 的 include 见上。
- `task-sessions.controller.ts`:`@Controller('agent/sessions')` + `POST /`(create)、`GET /`(list)、`GET /:id`(get)、`DELETE /:id`(delete),都注 `@CurrentUser()`,把 `user.userId` 透传 service;照 `conversations.controller.ts` 的装饰器/守卫风格。
- `task-sessions.module.ts`:providers `[TaskSessionsService]`,controllers `[TaskSessionsController]`,imports Prisma(照 conversations.module)。

- [ ] **Step 3: 注册进 AppModule**

`app.module.ts` 的 `imports` 数组加 `TaskSessionsModule`(紧挨 `ConversationsModule`)。

- [ ] **Step 4: 测试转绿**

Run: `npx jest task-sessions.service --silent`
Expected: PASS。
Run: `npx tsc --noEmit`(或项目 build)Expected: 无类型错。

- [ ] **Step 5: Commit**

```bash
cd /Users/mac/agent-server && git add apps/node-server/src/modules/task-sessions apps/node-server/src/app.module.ts && git commit -m "feat(agent): task-sessions 模块(会话 CRUD + 归属校验,镜像 conversations)"
```

---

## Task 4: agent-server — 提交任务带 `sessionId`(agent.controller + run-engine + DTO)

**Files:**
- Modify: `apps/node-server/src/modules/agent/dto/create-task.dto.ts`
- Modify: `apps/node-server/src/modules/agent/agent.controller.ts`
- Modify: `apps/node-server/src/shared/run-engine/run-engine.service.ts`
- Modify: `apps/node-server/src/modules/agent/agent.module.ts`(若需注入 TaskSessionsService,或改注入 PrismaService 做 ensureOwned)
- Test: `apps/node-server/src/modules/agent/agent.controller.spec.ts`(新建或扩展)

- [ ] **Step 1: 写失败测试(agent.controller)**

用例:
```ts
// 提交带合法 sessionId → createRun 收到 taskSessionId、入队、返回 { runId }、会话 updatedAt 被 touch
// 提交 sessionId 不属当前 user → 抛 NotFoundException(不建 run、不入队)
// 首次提交且会话 title 仍是默认"新任务会话" → 用 task 前 255 字回填 title
```
Run: `npx jest agent.controller --silent` Expected: FAIL。

- [ ] **Step 2: 改 DTO**

`create-task.dto.ts` 加:`@IsInt() @IsPositive() sessionId!: number;`(保留原 `task` 校验)。

- [ ] **Step 3: 改 run-engine.createRun 支持 taskSessionId**

```ts
async createRun(input: { userId: number; kind: RunKind; task: string; refId?: string; taskSessionId?: number }): Promise<Run> {
  return this.prisma.run.create({
    data: {
      runId: `run-${randomUUID()}`,
      userId: input.userId, kind: input.kind, task: input.task,
      refId: input.refId ?? null,
      taskSessionId: input.taskSessionId ?? null,
      status: 'queued',
    },
  });
}
```

- [ ] **Step 4: 改 agent.controller.createTask**

注入 `TaskSessionsService`(或 PrismaService)。流程:
```ts
const session = await this.taskSessions.ensureOwned(user.userId, dto.sessionId); // 越权→404
const run = await this.runEngine.createRun({ userId: user.userId, kind: 'agent_task', task: dto.task.slice(0,255), taskSessionId: session.id });
await this.runsQueue.add('agent', { runId: run.runId, userId: user.userId });
// touch + 首次回填标题
await this.prisma.taskSession.update({
  where: { id: session.id },
  data: { updatedAt: new Date(), ...(session.title === '新任务会话' ? { title: dto.task.slice(0,255) } : {}) },
});
return { runId: run.runId };
```
(把需要的 provider 加进 `agent.module.ts` imports/providers。)

- [ ] **Step 5: 测试转绿 + build**

Run: `npx jest agent.controller --silent` Expected: PASS。
Run: `npx tsc --noEmit` Expected: 无错。

- [ ] **Step 6: Commit**

```bash
cd /Users/mac/agent-server && git add apps/node-server/src/modules/agent apps/node-server/src/shared/run-engine && git commit -m "feat(agent): 提交任务归属到 sessionId(建 run 挂会话 + touch/回填标题)"
```

---

## Task 5: web — api.ts + type.ts(任务会话 CRUD + 提交带 sessionId)

**Files:**
- Modify: `web/src/views/agentView/api.ts`
- Modify: `web/src/views/agentView/type.ts`
- Test: `web/src/views/agentView/api.test.ts`(若存在则扩展,否则新建,照现有 agentView 测试)

- [ ] **Step 1: 写失败测试(api)**

用 `vi.fn()` mock fetch,断言:
```ts
// listTaskSessions() → GET  {BASE}/agent/sessions,返回数组
// createTaskSession('x') → POST {BASE}/agent/sessions body {title:'x'}
// getTaskSession(1) → GET {BASE}/agent/sessions/1
// deleteTaskSession(1) → DELETE {BASE}/agent/sessions/1
// submitAgentTask('t', 5) → POST {BASE}/agent/tasks body {task:'t',sessionId:5}
```
Run: `cd web && npx vitest run src/views/agentView/api` Expected: FAIL。

- [ ] **Step 2: 实现 api 函数**

在 api.ts 的"Agent 任务"段加(复用现有 `request<T>`):
```ts
export async function listTaskSessions(): Promise<AgentTaskSession[]> { return request('/agent/sessions'); }
export async function createTaskSession(title?: string): Promise<AgentTaskSession> {
  return request('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: title ?? '新任务会话' }) });
}
export async function getTaskSession(id: number): Promise<AgentTaskSession> { return request(`/agent/sessions/${id}`); }
export async function deleteTaskSession(id: number): Promise<void> { await request(`/agent/sessions/${id}`, { method: 'DELETE' }); }
```
改 `submitAgentTask`:
```ts
export async function submitAgentTask(task: string, sessionId: number): Promise<AgentTaskResp> {
  return request('/agent/tasks', { method: 'POST', body: JSON.stringify({ task, sessionId }) });
}
```

- [ ] **Step 3: type.ts 再导出 `AgentTaskSession`**

在 `export type { ... } from '../../contracts/gen/ourchat/agent/v1/agent';` 列表加 `AgentTaskSession`。

- [ ] **Step 4: 测试转绿**

Run: `npx vitest run src/views/agentView/api` Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /Users/mac/our-chat && git add web/src/views/agentView/api.ts web/src/views/agentView/type.ts web/src/views/agentView/api.test.ts && git commit -m "feat(agent-web): api 加任务会话 CRUD + 提交带 sessionId"
```

---

## Task 6: web — 重写 `tasksTab`(列表 + 详情 transcript + 流式 + 续播)+ i18n

**Files:**
- Modify: `web/src/views/agentView/tabs/tasksTab/index.tsx`(重写)
- Modify: `web/src/views/agentView/tabs/tasksTab/style.module.scss`(加左列/列表样式,照 conversationsTab/style)
- Modify: `web/src/locales/zh.ts`、`web/src/locales/ts.ts`(补 `agent.tasks.*`)
- Test: `web/src/views/agentView/tabs/tasksTab/index.test.tsx`(新建)

**结构 = conversationsTab 的骨架 + tasksTab 的气泡渲染:**
- 状态:`sessions: AgentTaskSession[]`、`activeId: number|null`、`items: ChatItem[]`(由选中会话的 `runs[]` 映射而来 + 实时提交追加)、`submitting`、`loadingList`/`loadErr`。
- mount → `loadSessions()`(三态)。
- 选中 → `getTaskSession(id)` → 把 `runs[]` 映射成 `ChatItem[]`:每 run → `{kind:'user',text:run.task}` + `{kind:'assistant',runId,events:run.events,done: run.status is terminal}`;若某 run 非终态(queued/running)→ `streamRun(runId)` 续播(照 submit 里的追加逻辑)。切换/卸载关闭所有 SSE(`closersRef`)。
- 提交 → `submitAgentTask(text, activeId)`(activeId==null 时禁用)→ 现有流式追加逻辑。
- 复用现有 `AssistantBubble`/`StepRow`(不动)。
- 左列 UI + 「新建」+ 删除 + 三态,照 conversationsTab；样式从 conversationsTab/style.module.scss 迁移对应类。

- [ ] **Step 1: i18n 补键**

`locales/zh.ts` 的 `agent.tasks` 加:`list:'任务会话', new:'新建', empty:'还没有任务会话', pickOne:'选择或新建一个任务会话', firstTaskHint:'输入一个任务开始', confirmDelete:'确定删除该任务会话?', loadFail:'加载失败', createFail:'新建失败', deleteFail:'删除失败'`。`locales/ts.ts` 补对应繁体。

- [ ] **Step 2: 写失败测试** `index.test.tsx`

mock `../../api`。用例:
```ts
// 1. 挂载 → 调 listTaskSessions;返回空 → 显示 empty 文案(非 error)
// 2. listTaskSessions reject → 显示/ toast error(与 empty 区分)
// 3. 选中会话 → 调 getTaskSession(id);返回含 2 个 run(1 终态含 final_answer)→ 渲染出用户气泡文本 + 答案文本
// 4. 选中含非终态 run 的会话 → streamRun 被以该 runId 调用(续播)
// 5. 有 activeId 时提交 → submitAgentTask 收到 (text, activeId);无 activeId → 提交禁用/不调
```
Run: `cd web && npx vitest run src/views/agentView/tabs/tasksTab` Expected: FAIL。

- [ ] **Step 3: 重写 index.tsx**

按上"结构"实现;`runs→ChatItem[]` 映射函数抽成纯函数便于测试;`RunEvent` 的 `data.payload` 读法与现有 `AssistantBubble` 一致(持久化 event 的 payload 结构与 SSE 帧一致——都是整条 run_event,字段在 `payload` 下,注意 gen 的 `RunEvent` 形状,若持久化返回的是 `{sequenceNo,eventType,payload}` 而 SSE 帧是 `{id,type,data:{payload}}`,在映射时统一成组件期望的 `{type,data:{payload}}`)。

- [ ] **Step 4: 迁移样式**

从 `conversationsTab/style.module.scss` 拷 `wrap/convList/convHead/newBtn/convScroll/convItem/convItemActive/convTitle/delBtn/empty/backBtn` 等类到 tasksTab 的 scss(或按需重命名),保证左列 + 右侧布局与对话 tab 一致、响应式一致。

- [ ] **Step 5: 测试转绿 + lint**

Run: `cd web && npx vitest run src/views/agentView/tabs/tasksTab` Expected: PASS。
Run: `npm run lint` Expected: 0 error。

- [ ] **Step 6: Commit**

```bash
cd /Users/mac/our-chat && git add web/src/views/agentView/tabs/tasksTab web/src/locales && git commit -m "feat(agent-web): tasksTab 重写为会话列表+详情 transcript+流式+断线续播"
```

---

## Task 7: 闭环 — 全量门禁 + code-review + 手验

- [ ] **Step 1: agent-server 全量门禁**

Run: `cd /Users/mac/agent-server/apps/node-server && npx jest --silent && npx tsc --noEmit`(或项目既有 `npm run lint && npm test`)Expected: 全绿。

- [ ] **Step 2: web 全量门禁**

Run: `cd /Users/mac/our-chat/web && npm run lint && npm test` Expected: 全绿。

- [ ] **Step 3: buf lint(契约)**

Run: `cd /Users/mac/our-chat && buf lint` Expected: 无 error。

- [ ] **Step 4: code-review 自检**

对本分支全 diff 跑 `/code-review`(或人工过一遍):归属校验无遗漏、三态齐全、SSE 清理无泄漏、无越权路径、无 `as unknown as`、类型一致。

- [ ] **Step 5: 手验关键路径(dev 环境)**

起 agent-server + web dev,验:新建会话→连续提交多任务→实时思考+答案→**刷新**→列表在、点开看完整 transcript、进行中任务续播到终态→删除会话级联清空→多用户隔离。

- [ ] **Step 6: 两仓同步收尾**

确认两仓 commit 都在 `feat/agent-task-session-persistence`,历史清晰;暂不 push(等用户指示)。

---

## Self-Review(对照 spec)

- 契约 §4 → Task 1 ✓;schema §5.1 → Task 2 ✓;后端模块 §5.2 → Task 3 ✓;提交带 sessionId §5.3 → Task 4 ✓;web api §6 → Task 5 ✓;tasksTab 重写 + i18n §6 → Task 6 ✓;续播 §7 → Task 6 Step 3 ✓;测试 §9 → 各 Task 内 TDD + Task 7 门禁 ✓;验收 §11 → Task 7 Step 5 手验 ✓。
- 无占位符;实体/方法名(`TaskSession`/`taskSessionId`/`listTaskSessions`/`getTaskSession`/`submitAgentTask(text,sessionId)`/`ensureOwned`)前后一致。
- 风险点已标注:Prisma migration 需 DB 连接(Task 2 Step 2);持久化 event 形状 vs SSE 帧形状需在映射统一(Task 6 Step 3)。
