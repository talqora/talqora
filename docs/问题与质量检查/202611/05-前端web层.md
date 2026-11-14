# 前端 web 层（`web/`）

> 范围：`web/src`（React 19 + Redux Toolkit + antd + 原生 WebSocket + vite），含与后端的契约一致性。
>
> 证据来源：只读代码。与后端相关的问题（如 `userId` 类型不一致）在 [02 分册 BZ-S2](./02-talqora业务层.md) 从服务端视角写过，本文只写前端这一侧的行为与责任。
>
> 先给结论性的正面判断：**架构切换是干净的。** 全仓 `socket.io-client` 在依赖表与源码中零残留；实时帧名（`message.send`/`receiveMessage`/`receiveFriendReq`/`friendListChanged`/`heartbeat`/`call:*`）与 `biz/internal/realtime` 和 `gateway/internal/hub/conn.go` 完全对得上；`wsClient.ts` 的心跳 25s、指数退避、`message.send`→`message.ack` 重发幂等与网关的 `GATEWAY_HEARTBEAT_TIMEOUT_SEC=60` 匹配。没有 `dangerouslySetInnerHTML`，所有 `target="_blank"` 都带 `noopener,noreferrer`，手写代码里也没有 `any`。这些是很多同类项目做不到的。

> **整改状态**：本文记录的是审计当时（2026-11-15）的代码状态，不代表当前状态。已完成的整改项与改动后的实测结果，统一见 [00-总览与整改顺序](./00-总览与整改顺序.md) 第 3 节。

## 0 一段话总评

前端的整体判断是：**新代码写得好，早期代码缺错误处理**。

`agentView`、`theme.tsx`、`useIsMobile`、`tasksTab` 这批较新的代码，effect 清理、依赖数组、懒加载都写对了，并且 `agentView` 是唯一有成套单测的模块。问题集中在 `chatView`、`useGlobalMessageListener`、`useCall` 这批早期代码上：**大量 `.then()` 不带 `.catch()`**。因为 `utils/http.ts` 的错误路径是 `Promise.reject`，这些调用点会产生 unhandledrejection——UI 没有错误态、不重试、数据半更新。BZ-S2 那个「加好友恒 403」的故障之所以表现为「点了没反应」，正是因为前端把 rejection 吞掉了。

第二个问题是 `utils/http.ts` 的 401 刷新队列：刷新失败时队列里的请求既不 resolve 也不 reject，**永久悬挂**——页面卡在 loading，队列常驻内存。

第三个是安全口子：agent-server 的令牌存在 `localStorage`，并作为 `access_token` 拼进 SSE 的 URL。项目已经把主站令牌迁到 HttpOnly cookie，这里是遗留的例外。

## 1 问题清单

### 严重

#### WEB-S1 401 刷新失败时请求队列永不收敛，页面永久卡在 loading（已核实）

**证据。**

```157:186:web/src/utils/http.ts
          if (isRefreshing) {
            return new Promise<void>((resolve, reject) => {
              failedQueue.push({ resolve, reject });
            }).then(() => http(originalRequest));
          }
          ...
            const ok = await refreshToken();
            if (ok) {
              processQueue();
              return http(originalRequest);
            }
            return Promise.reject(error);
          } catch (refreshError) {
            processQueue(refreshError);
            return Promise.reject(refreshError);
          } finally {
            isRefreshing = false;
          }
```

**原理。** `refreshToken()` 内部 `catch` 后返回 `false`（不是抛异常），所以走的是 `if (ok)` 为假的分支：`return Promise.reject(error)`——只 reject 了**当前**这一个请求，队列里所有排队的请求（`failedQueue`）既没 `resolve` 也没 `reject`。`finally` 只是把 `isRefreshing` 置回 false，不会唤醒队列。

**后果。** 用户令牌过期且刷新失败（例如 refresh token 也过期、或网络瞬断）时：并发发出的多个请求全部悬挂，`await` 它们的组件永远停在 loading 态；`failedQueue` 数组常驻内存不释放。用户看到的是「转圈，一直转」，刷新页面才能恢复。

**修复。** 把「无论成败都要处理队列」写进 `finally`：

```ts
finally {
  isRefreshing = false;
  processQueue(ok ? undefined : new Error('refresh failed'));
}
```

并给 `processQueue` 一个必填的 `error` 语义（成功传 `undefined`），避免以后新增分支又漏掉。

### 重要

#### WEB-I1 大量 `.then()` 不带 `.catch()`，失败静默（已核实）

**证据（部分）。**

| 位置 | 调用 |
|---|---|
| `web/src/views/chatView/index.tsx:75-77` | `getConversationMessages(...).then(...)` |
| `web/src/hooks/useGlobalMessageListener.ts:38,42,47,53,60,117` | 多处 `.then(...)` |
| `web/src/views/directoryView/index.tsx:80-107` | 好友请求相关批量 `.then` |
| `web/src/globalComponents/friendModal/index.tsx:74,105` | `.then(...)` |
| `web/src/views/settingView/index.tsx:54` | `updateUserInfo(...)` 既无 `await` 也无 `.catch` |

**原理。** `utils/http.ts:227` 对所有错误统一 `Promise.reject`。没有 `catch` 的 `.then` 链会产生 unhandled promise rejection：浏览器控制台一条红字，业务上什么都没有。

**后果。** 三类具体表现：

1. **假成功**：`settingView` 先 `dispatch(updateProfile)` 更新本地状态，再发请求；请求失败时本地已显示「已修改」，服务端没改，刷新后回退。
2. **静默 403**：BZ-S2 的四个功能失败时用户什么都看不到，只以为「按钮坏了」。
3. **空白态**：`chatView` 拉消息失败时 `initGlobalMessages` 不执行，界面停在上一会话的消息上。

**修复。** 统一一层薄封装（或直接用 `async/await + try/catch`），失败时 `toast.err`；并在 ESLint 里开 `@typescript-eslint/no-floating-promises`，让「忘了处理」在提交前就被拦住。这条规则是目前唯一能系统性解决该类问题的手段。

#### WEB-I2 agent-server 令牌存 `localStorage`，并作为 URL query 传递（已核实）

**证据。**

- `web/src/views/agentView/api.ts:11、39、43`：读写 `localStorage['agentServer.token']`；
- 同文件把令牌拼进 SSE 的查询串（`access_token=${token}`），与服务端 `apps/rag-server/src/rag_server/deps.py:48-50` 的 `?access_token=` 支持对应。

**原理。** `localStorage` 对任意同源 JS 可读，任何一处 XSS 都能直接取走长期令牌。URL query 会进入 nginx 的 `$request_uri` 日志、浏览器历史、`Referer`——三处都是令牌泄露面。

**后果。** 主站令牌已经迁到 HttpOnly cookie 并配了双提交 CSRF（这是对的），agent 这条链路又开了个旧口子，等于前面的工作打折。

**修复。** 短期：SSE 改用 `fetch` + `ReadableStream`（`readSSE` 已有实现基础），令牌走 `Authorization` header，不进 URL。中期：agent 请求也走同源 nginx 反代 + cookie 鉴权，`localStorage` 里不留任何令牌。

#### WEB-I3 `chatView` 是 26KB 巨型组件，且含未实现功能（已核实）

**证据。**

- `web/src/views/chatView/index.tsx`：单文件承担会话列表、消息渲染、文件上传、通话入口、资料卡、移动/桌面双布局。
- `:143`：搜索框 `console.log(value)` —— 搜索功能未实现，但控件在。
- `:169-171、:208-214`：表情、截图、聊天记录三个按钮是空实现。
- `:247-253`：重复实现 `formatFileSize`，`utils/upload.ts:87` 已有同名工具。
- `:80-83` 的 `parseConversationId` 与 `useGlobalMessageListener.ts:82`、`hooks/useCall.ts:572` **三处重复**会话 ID 的拼/拆规则。

**原理与后果。** 会话 ID 的解析规则（`single_<小>_<大>` / `group_<id>`）在三个文件里各写了一遍。这条规则一旦变化（例如官方账号从 id 0 迁到 10301 时就需要批量改写会话 ID，见 `biz/migrations/0008_*.up.sql`），三处必须同步改，漏一处就是「通话里认错人」。这类重复是当前前端最大的可维护性风险。

**修复。** 抽 `utils/conversation.ts`（`parseConvID` / `buildSingleConvID` / `isGroupConv`）三处复用；把 `chatView` 拆成 `useConversationRoute` + `MessageList` + `Composer`；未实现的按钮直接删掉或加 `disabled` + tooltip，不要留 `console.log`。

#### WEB-I4 lint 与单测不在任何 CI 中执行（已核实）

**证据。** `.github/workflows/` 只有 `deploy.yml`、`perf.yml`、`proto.yml`；`perf.yml:35-41` 只跑 `build`/`size`/`lhci`，不跑 `lint` 与 `test`。`web/package.json` 里有 `lint`、`test` 脚本但无人调用。`web/vitest.config.ts:38` 的 `coverage.include` 只有 `src/views/agentView/**`。

**后果。** `pnpm lint`、`pnpm test`（7 个测试文件，含 `wsClient.test.ts`、`webrtc.test.ts`）在合入前从不执行。覆盖率数字只反映 agentView，容易让人误判整体质量——真实情况是 `chatView`/`hooks` 一行测试都没有。

**修复。** 加 `ci.yml`：`pnpm lint && pnpm test`；`coverage.include` 放开到 `src/**` 并设一个初始阈值（比如 20%），只许升不许降。这与 [07 分册](./07-测试与质量门禁.md) 的两仓门禁是同一件事。

### 一般

| 编号 | 问题 | 证据 | 修复 |
|---|---|---|---|
| WEB-N1 | 所有 GET 都追加 `_t=Date.now()`，主动打掉 HTTP 缓存 | `web/src/utils/http.ts:113-118` | 依赖后端 `Cache-Control`/`ETag`；确需防缓存的接口单独加 |
| WEB-N2 | 生产缺省值写死 `localhost`/端口；`.env.example` 未覆盖关键变量 | `web/src/views/agentView/api.ts:33`（缺省 `http://localhost:3101/api` 会打进 bundle）、`web/src/utils/runtime.ts:11,36`（`VITE_SERVER_PORT` 缺省 `3007`） | 缺省值改为同源；启动时对缺失的 `VITE_*` fail-fast |
| WEB-N3 | 空文件却在被 import | `web/src/style/antD.scss`（0 字节，`main.tsx:6` import）、`web/src/views/chatView/api.ts`（0 字节）、`web/README.md`（0 字节） | 删除或补内容；import 空 scss 会制造「这里有全局样式」的错觉 |
| WEB-N4 | `useCall` 用模块级可变单例 + 6 项依赖的 effect，9 个 WS 监听器反复注册/注销 | `web/src/hooks/useCall.ts:42-47`（模块级 `currentCallId`/`durationTimer`/`reconnectGraceTimer`）、`:346-370`（9 个 `wsClient.on` 后依赖数组 6 项）、`:413-415`（3s `setTimeout` 未保存句柄） | 事件注册依赖收敛为 `[]` + `ref` 读最新状态；所有 timer 进 cleanup |
| WEB-N5 | 缺少「消息补拉」的统一入口，靠各组件各自实现 | `chatView/index.tsx:75`（进入会话拉全量）、`useGlobalMessageListener`（收帧后 dispatch） | 抽 `useMessageSync(convID)` 统一处理 `seq` 空洞检测与 `GET /user/sync` 补拉——这也是校招计划证据线一「客户端增量同步改造」要落的地方 |

## 2 整改顺序

| 顺序 | 事项 | 关联 | 工时 |
|---|---|---|---|
| 1 | `processQueue` 进 `finally` | WEB-S1 | 0.5h |
| 2 | 统一错误处理 + 开 `no-floating-promises` | WEB-I1 | 2h（规则打开后修告警另计 1h） |
| 3 | agent 令牌出 `localStorage`、出 URL | WEB-I2 | 3h |
| 4 | 抽 `utils/conversation.ts`，三处复用 | WEB-I3 | 1h |
| 5 | `chatView` 拆分 + 删未实现控件 | WEB-I3 | 4h |
| 6 | CI 加 lint + test；覆盖率放开 | WEB-I4 | 2h |
| 7 | 一般项 | WEB-N1–N5 | 3h |

第 1–2 项合计 2.5 小时，能同时解决「静默失败」和「卡死」两类用户可见问题；第 3 项是安全项，建议与 agent-server 的 AS-N1 一起做（两边是一对）。

## ★ 关键理解点

- **正向：`Promise.reject` 必须有接收方。** 一个「统一 reject」的 HTTP 层是正确的设计，但它要求**每个调用点**都处理 rejection。用 ESLint 规则把这件事变成编译期约束，比靠 code review 可靠得多——`no-floating-promises` 就是为此存在的。
- **反向：`catch` 里 return false 和 throw 是两种不同的语义。** `refreshToken()` 用 `return false` 表达失败，调用方必须显式检查；它不会像异常那样「自动向上冒」，于是很容易漏掉一条分支。要么全用异常，要么全用返回值，混用就是 WEB-S1 的成因。
- **边界：前端的「缓存」边界应当由后端声明。** 给所有 GET 加 `_t=Date.now()` 是一种「绕过缓存」的做法，它解决了「数据过期」，代价是「所有请求都不缓存」。正确做法是让后端用 `Cache-Control`/`ETag` 声明哪些可缓存——这需要后端配合，正好属于「前后端契约」的一部分。
- **对比：`localStorage` vs HttpOnly cookie。** 前者对同源 JS 完全开放，XSS 一次即失守；后者 JS 读不到，但需要 CSRF 防护（双提交）。主站已经选了后者并做对了，agent 链路还停在前者——安全口径不统一，等于按最弱的一环计算。
