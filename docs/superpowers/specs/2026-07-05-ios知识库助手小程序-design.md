# iOS 知识库助手小程序 · 设计文档

> 目标:在 iOS(SwiftUI + TCA)里新增一个**"知识库助手"小程序**——home 下拉进入,首次一键授权(IdP),之后进入 3-tab 功能页(对话 / 知识库(文档)/ 任务),后端复用**已就绪**的 agent-server(RAG 对话 + 文档 + agentic 任务),鉴权走 our-chat 作为 IdP 的 `/oauth/agent-token`。**原生实现,不用 WebView;复用的是后端业务逻辑,不是 web UI。**

---

## 1. 背景与目标

- **现状**:agent-server(NestJS,RAG + 自建 ReAct agent,JWKS 验签)已部署;our-chat 是 IdP;web 端已有 agentView(对话/文档/任务),iOS **完全没接**。iOS 网络层只有一发一收(无 SSE),也没用过 WebView。
- **目标(本次全量)**:iOS 原生「知识库助手」小程序,含入口、授权门、对话(SSE 流式)、文档管理、agent 任务,与 agent-server 端到端打通。
- **成功标准(可测)**:
  1. home 下拉出现小程序面板,点"知识库助手"全屏进入;
  2. 首次进入显示授权页,点「一键授权」→ 无跳转、无重新登录 → 进功能页;之后再进直接进(静默续期);
  3. **对话**:选/建会话 → 提问 → 界面**流式**逐字显示回答 + 来源引用;
  4. **知识库**:看到已上传文档及其状态,能上传新文档并看到解析进度,能删除;
  5. **任务**:提一个开放任务 → 看到工具调用过程(可折叠)→ 最终答案;
  6. token 15 分钟过期后自动静默续期,用户无感;主 App 登出后小程序失效、提示回登录。

## 2. 范围

**做**:入口(home 下拉面板)、授权门、对话/文档/任务三 tab、agent 鉴权与 token 管理、iOS 网络层新增 SSE 流式能力、三态/错误/重连、单测。
**不做**:通用小程序容器框架(只做这一个入口,YAGNI);web 端改动(web 已实现);agent-server / our-chat 服务端改动(后端已就绪,只"接入");ima 的"个人/共享/订阅知识库"体系(我们的"知识库"= 上传文档集合,不臆造后端没有的模型)。

## 3. 已就绪的后端(接入事实,勿改)

### 3.1 授权:our-chat IdP 首方端点(原生友好)
- `POST /oauth/agent-token`(our-chat 服务端,**不是** agent-server):
  - 请求:带主 App 登录态 `Authorization: Bearer <ourchat-login-jwt>`;**Bearer 免 CSRF**(`server/src/middleware/auth.ts` 对 Bearer 跳过 CSRF);无 body。
  - 响应:`{ "access_token": "<RS256 JWT>", "token_type": "Bearer", "expires_in": 900 }`。JWT `aud:["agent-server"]`、`iss:<our-chat>`、`sub:<userId>`,**15 分钟**。
  - agent-server 用 JWKS(`/.well-known/jwks.json`)验签,首次见到 `(iss,sub)` 零touch建号。
  - 参考实现:`server/src/oauth/agentToken.ts`;web 用法:`web/src/views/agentView/agentAuth.ts`(`ensureAgentToken` 缓存 + 提前 30s 续期)。

### 3.2 agent-server API(经 nginx `/agent/` 反代)
> **base 已定死** = `${APIEnvironment.current.baseURLString}/agent/api`,生产即 **`https://tujiang.tech/agent/api`**。依据:① `docker/docker-compose.prod.yml:129` web 生产 `VITE_AGENT_API_BASE=${WEB_PUBLIC_ORIGIN}/agent/api`;② nginx `location /agent/` `rewrite ^/agent/(.*)$ /$1` 去前缀、透传 `Authorization`、`proxy_buffering off`+`proxy_read_timeout 3600s` 适配 SSE;③ agent-server `main.ts` `setGlobalPrefix('api')`(控制器 `@Controller('conversations')` → `/api/conversations`)。**iOS 与 web 走同一条 nginx 路径**,故下表端点在 iOS 侧完整形如 `https://tujiang.tech/agent/api/conversations`。

| 用途 | 端点 | 说明 |
|---|---|---|
| 验证/取用户 | `GET /auth/me` | 授权后验 token、拿 user |
| 会话列表 | `GET /conversations` | 含消息 |
| 新建会话 | `POST /conversations` `{title?}` | 默认"新对话" |
| 会话详情 | `GET /conversations/:id` | 全部消息 |
| 删除会话 | `DELETE /conversations/:id` | 204 |
| **发消息(RAG)** | `POST /conversations/:id/messages` `{query, topK?}` | **SSE**:`event:token{value}` 增量 / `event:done{messageId,citations:[{chunkId,documentId,score}]}` / `event:error` |
| 文档列表 | `GET /documents` | 状态 uploaded→parsing→chunking→embedding→ready/failed、chunk 数、大小、错误 |
| 上传文档 | `POST /documents`(multipart,≤100MB) | 返回 `{documentId, runId}`(异步入库) |
| 删除文档 | `DELETE /documents/:id` | 204,清 Milvus 向量 |
| 提交任务 | `POST /agent/tasks` `{task}`(≤2000 字) | 202 `{runId}` |
| 任务事件流 | `GET /runs/:runId/stream` | **SSE**:run_started/tool_called/tool_result/final_answer/run_failed,支持 `Last-Event-ID` 重连 |
| 任务快照 | `GET /runs/:runId` | 非流式,崩溃后补齐 |

- 鉴权:所有 agent API `Authorization: Bearer <agent-token>`。**iOS 用 URLSession 而非浏览器 EventSource,SSE 也能带 Authorization 头**,故**不需要 web 那套 `?access_token=` query 兜底**。

## 4. 架构总览

```
MainFeature(root, 登录态)
 ├─ ChatsView ──下拉手势──▶ 小程序面板(MiniAppLauncher,视觉参考微信小程序区,1 个入口)
 │                                   │ 点"知识库助手"
 │           @Presents miniApp  ◀────┘
 └─ .fullScreenCover ─▶ MiniAppFeature(容器)
        ├─ 未授权(本地标记 false)→ AgentAuthFeature/View(授权页 + 一键授权)
        │        └ AgentAuthClient.authorize() → POST /oauth/agent-token → 存 token+置标记 → GET /auth/me 验证
        └─ 已授权 → KnowledgeAssistantFeature(TabView 3 tab)
              ├ AgentChatFeature      (会话列表 + 会话详情[消息流 + SSE 问答 + 引用])
              ├ AgentDocumentsFeature (文档列表[三态] + 上传[multipart+runId 轮询] + 删除)
              └ AgentTasksFeature     (提任务 + runs SSE[工具过程折叠 + 最终答案])
   依赖:AgentAuthClient(token) · AgentAPIClient(REST + SSE)
```

## 5. 组件设计

### 5.1 入口:`MiniAppLauncher`(home 下拉)
- 在 `ChatsView` 顶部加下拉手势(下拉超过阈值 → 展开一个可关闭的"小程序"面板;视觉对齐微信小程序区/Image#1,含 1 个"知识库助手"图标+名)。
- 点入口 → 向 `MainFeature` 发 action → `@Presents var miniApp: MiniAppFeature.State?` → `.fullScreenCover` 呈现(挂 root,和通话呈现同思路:登录态下任意 tab 可唤起)。
- YAGNI:面板只是一个轻量视图 + 一个入口,**不做多程序注册/生命周期框架**。

### 5.2 鉴权:`AgentAuthClient`(新 @DependencyClient)
```swift
@DependencyClient struct AgentAuthClient: Sendable {
    var authorize: @Sendable () async throws -> Void          // 首次:POST /oauth/agent-token → 存 token + 置"已授权"标记
    var ensureToken: @Sendable () async throws -> String      // 取有效 agent token:内存缓存未过期即复用;否则静默 re-mint
    var isAuthorized: @Sendable () -> Bool                     // 读本地"已授权"标记
    var clear: @Sendable () -> Void                            // 登出/失效:清 token + 标记
}
```
- token 存 Keychain 新 key `agentToken`;内存记 `expiresAt`(提前 ~30s 视为过期)。re-mint 用主 App 登录 token(经现有 `AuthenticatedAPIClient`/`SessionClient`)调 `/oauth/agent-token`。
- "已授权"标记:UserDefaults/Keychain 布尔(首次授权成功后置 true;`clear` 置 false)。
- 401(agent 侧)→ `clear` + 重新 `ensureToken`;主 App 登录态也失效 → 向上冒泡 → 提示回登录(不在小程序内做重新登录)。

### 5.3 网络:`AgentAPIClient`(新 @DependencyClient)+ SSE 解析
```swift
@DependencyClient struct AgentAPIClient: Sendable {
    var request: @Sendable (_ req: AgentRequest) async throws -> Data              // 普通 REST(JSON)
    var upload:  @Sendable (_ fileURL: URL, _ name: String) async throws -> UploadResult  // multipart
    var stream:  @Sendable (_ req: AgentRequest) -> AsyncThrowingStream<SSEEvent, Error>  // SSE
}
```
- REST:`URLSession.data`,自动 `Authorization: Bearer await ensureToken()`。
- **SSE:`URLSession.bytes(for:)`** 读字节流,喂给一个**纯函数 SSE 帧解析器**(`SSEParser`:按空行分帧,取 `event:`/`data:`)→ `AsyncThrowingStream<SSEEvent>`。Bearer 走 header(iOS 可带头)。无第三方依赖。
- `SSEEvent` 是 Sendable:`{ event: String, data: String }`;各 tab 各自把 `data`(JSON)解成领域事件(chat 的 token/done/error;runs 的 tool_called/final_answer 等)。

### 5.4 功能:`KnowledgeAssistantFeature`(TabView 3 tab)
- **AgentChatFeature**:会话列表(`GET/POST/DELETE /conversations`,三态)→ 进会话 → 消息流(历史 + 实时);发送 → `stream(POST /conversations/:id/messages)` → 逐 `token` 追加到占位 assistant 气泡,`done` 固定 messageId + 渲染引用角标,`error` 回滚。
- **AgentDocumentsFeature**:`GET /documents` 列表(状态徽章:解析中/就绪/失败,三态);上传 → 系统文件选择器 → `upload(POST /documents)` → 拿 runId → 轮询 `GET /documents`(或订阅 `/runs/:id/stream`)刷新状态;删除 `DELETE`。
- **AgentTasksFeature**:输入任务 → `POST /agent/tasks` → runId → `stream(GET /runs/:id/stream)`;把 tool_called/tool_result 折叠展示,final_answer 落终态;`Last-Event-ID` 断线重连,或 `GET /runs/:id` 补齐。

### 5.5 UI 规范
守 mobile-swift/CLAUDE.md 硬规范:动 UI 前加载 `mobile-ios-design`+`swiftui-pro` skill;`@Bindable var store`;44pt + `PressableButtonStyle`;`WeChatColor/Font/Spacing/Radius` 令牌;三态用 `AsyncStateView` 思路;明暗两套;输入区收键盘、`safeAreaInset`。视觉参考 ima(Image#2/#3)但按我们真实数据落地。

## 6. 数据流(对话主线时序)
```
进会话 → GET /conversations/:id 拉历史渲染
输入 query → 追加 user 气泡 + 一个空 assistant 占位 → ensureToken()
stream POST /conversations/:id/messages{query,topK}
  ← event:token{value} × N   → 逐字追加到占位气泡
  ← event:done{messageId,citations} → 固定 id + 渲染来源角标
  ← event:error → 占位气泡回滚为错误态,可重试
```

## 7. 错误处理与边界
- 三个列表全覆盖 loading/empty/error,empty≠error;网络失败人话 + 重试。
- 授权失败(agent 不可用 / base 配错 / 主 App 登录态失效):授权页给明确原因 + 重试;登录态失效冒泡回登录。
- SSE 断流:chat 视为该条失败可重发;runs 用 `Last-Event-ID` 重连 + `GET /runs/:id` 兜底。
- 上传:大小/类型前校验;失败重试;解析中/失败状态清晰。
- token 竞态:`ensureToken` 并发去重(单 in-flight mint)。

## 8. 测试策略
- **纯函数单测**:`SSEParser`(分帧/半包/多事件)、各 tab 的 data→领域事件解析、`AgentAuthClient` 的 token 缓存/过期/续期判定(抽成可测)。
- **Reducer TestStore**:AgentAuth(授权成功/失败/已授权直进)、AgentChat(发消息→token 流→done/error,用受控 AsyncStream 注入)、Documents(上传→状态轮询)、Tasks(runs 事件流)。
- **UI**:previewValue 依赖离线渲染各态 + 明暗;`swiftui-pro` review。
- **端到端**:真机连 agent-server(prod),逐条验收 §1 成功标准(需用户,含真实 LLM/文档)。

## 9. 新增文件布局(约定)
```
mobile-swift/Sources/
  Services/Agent/
    AgentAuthClient.swift        # /oauth/agent-token 取/缓存/续期 + 已授权标记
    AgentAPIClient.swift         # REST + upload + SSE(URLSession.bytes)
    SSEParser.swift              # 纯函数 SSE 帧解析(可单测)
    AgentDTO.swift               # Conversation/Message/Citation/Document/RunEvent 等 Sendable DTO
  Features/MiniApp/
    MiniAppFeature.swift         # 容器:授权门 ↔ 功能页 切换
    MiniAppView.swift
    Launcher/MiniAppLauncher*.swift   # home 下拉面板 + 入口
    Auth/AgentAuthFeature.swift + AgentAuthView.swift
    KnowledgeAssistant/
      KnowledgeAssistantFeature.swift + View  # TabView 3 tab
      Chat/AgentChatFeature.swift + Views      # 会话列表 + 会话详情
      Documents/AgentDocumentsFeature.swift + Views
      Tasks/AgentTasksFeature.swift + Views
  Features/Chats/ChatsView.swift   # 改:加顶部下拉手势 → 唤起 launcher
  Features/Main/MainFeature.swift  # 改:@Presents miniApp + fullScreenCover
```

## 10. 里程碑(一次 spec、按此拆提交)
1. **地基**:`SSEParser`(纯函数+单测)→ `AgentAuthClient`(/oauth/agent-token 取+缓存+续期+Keychain,单测)→ `AgentAPIClient`(REST+upload+SSE,base=`<origin>/agent/api`);**冒烟:授权 + `GET /agent/api/auth/me` 打通鉴权链路**。
2. **入口 + 授权门**:ChatsView 下拉 → MiniAppLauncher → MainFeature `fullScreenCover` 呈现 MiniApp;`AgentAuthFeature/View`(授权页 + 一键授权 + 已授权标记 + 验 /auth/me);reducer 单测。
3. **对话 tab(主线,最高价值)**:会话列表 + 会话详情 + SSE 流式问答 + 引用;单测 + 真机验一次问答。
4. **知识库(文档)tab**:列表三态 + 上传(multipart + runId 状态)+ 删除。
5. **任务 tab**:提任务 + runs SSE(工具过程折叠 + final_answer + 重连兜底)。
6. **打磨与验收**:错误/三态/重连全过一遍 + UX 自检(swiftui-pro)+ 真机端到端验收(需用户连 agent-server)。

每个里程碑一或多个"一事一提"的提交;每步代码与其测试同提交。

## 11. 风险与依赖
| 风险 | 缓解 |
|---|---|
| agent 首次零touch建号 / LLM 首字延迟较高 | UI 给"思考中"占位 + 流式;超时人话提示 |
| SSE 在弱网/断流下的健壮性 | 纯函数解析器覆盖半包;runs 用 Last-Event-ID+快照兜底;chat 失败可重发 |
| iOS 网络层首次引入流式 | 抽成独立 `AgentAPIClient`+`SSEParser`,与主 App 网络层解耦、可单测 |
| agent token 15 分钟 + 主 App 登录态耦合 | `ensureToken` 静默续期;主 App 登出联动 `clear` |
| 真机验收依赖 LLM/文档/agent-server 在线 | 里程碑 1-5 推到"编译绿+单测绿+可对 mock/真 agent 验";端到端由用户真机跑 |
| 与用户 Xcode 构建争用 DerivedData | 用户构建期间不跑 xcodebuild;需验证用独立 derivedDataPath 或让用户 Clean Build |
