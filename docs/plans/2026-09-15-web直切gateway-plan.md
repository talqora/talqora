# 实施计划：web 端实时路径全面切换到 Go gateway

> 依赖设计文档 `2026-09-15-web直切gateway连接层替换-design.md`（已批准）。
> 执行原则：每任务 TDD（先写失败测试→实现→绿→提交），单任务一 commit。

## 背景修正（相对设计文档的新事实）

- web 发消息用的是**旧协议 `sendMessage`**（`chatView/index.tsx:146,218`、`directoryView/index.tsx:112`），切 ws 时一并迁移到 `message.send` 可靠上行。
- web 端**无心跳**：gateway 靠应用层 heartbeat 续约 presence（TTL 60s），web 必须新增 25s heartbeat 帧，否则被判离线。
- `read.report` 上行：web 无使用方（已读走 REST `/user/read`，`sync.ts:63`，不推 read.sync）→ **本轮不做**（YAGNI），downlink 的 exceptDeviceId 能力保留供将来。
- 下行帧全集补充 `friendListChanged`（`friend.ts:226-227,253`）。

## 任务列表

### T1 server 契约：ws 信封与 downlink 载荷（server/src/contracts/ws.ts）
- 新增 zod schema：`wsEnvelope`（`{type, data}`）、`downlinkPayload`（`{userId, frame, targetDeviceId?, exceptDeviceId?}`）；类型导出。
- 测试：`server/test/unit/ws-contracts.test.ts`——合法/非法信封、target/except 互斥不校验（server 侧只负责构造）。
- 验证：`cd server && pnpm vitest run test/unit/ws-contracts.test.ts`
- commit: `feat(server): ws 信封与 downlink 载荷契约`

### T2 gateway downlink 路由过滤（targetDeviceId / exceptDeviceId）
- 改 `hub.go:RouteToUser(userID, payload)` → `RouteToUser(userID, payload, target, except)`：target 命中才投；except 跳过；快照过滤。
- `backplane.go` 载荷解析加两字段并透传。
- 测试：`gateway/internal/hub/hub_test.go`（fake Conn 即可：target 只投指定、except 不投、空过滤全投）。
- 验证：`cd gateway && go test ./internal/hub/ ./internal/backplane/`
- commit: `feat(gateway): downlink 按设备级路由过滤`

### T3 gateway 断连通知（POST /internal/gateway/disconnect）
- `upstream.go` 加 `NotifyDisconnect(ctx, userID, deviceID)`（fire-and-forget、3s 超时、失败仅 warn）。
- `conn.close()` 调用（`closeOnce` 内、presence 摘除后）。
- 测试：httptest mock server 断言收到请求与头部。
- 验证：`go test ./internal/upstream/ ./internal/hub/`
- commit: `feat(gateway): 断连通知 server`

### T4 gateway Origin 白名单 + 优雅关闭 1012
- `config.go` 加 `AllowedOrigins []string`（env `CLIENT_ORIGINS`，逗号分隔，与 server 同款）。
- `ws/server.go` CheckOrigin 校验白名单（空列表=全部放行，兼容 dev）。
- `main.go` 优雅关闭：对存量连接写 1012 close frame 再 shutdown（hub 提供 `ShutdownAll(code)`）。
- 测试：握手带非法 Origin 被拒（更新 smoke_test 或单测）。
- 验证：`go build ./... && go test ./...`
- commit: `feat(gateway): Origin 白名单与优雅关闭 1012`

### T5 server internal.ts 扩展（call:* 分支 + disconnect 端点）
- `/gateway/uplink` 新增 `call:start/accept/reject/end/rejoin/ice` 分支：逻辑平移自 `socket.ts:268-371`（忙线裁决、grace、epoch 均复用 `services/callSession.ts` 不动）。
- 新增 `POST /gateway/disconnect`：执行原 disconnect 业务（`socket.ts:375-410` 的 grace 处理），presence 摘除由 gateway 负责。
- 测试：`server/test/integration/gateway-uplink.test.ts` 扩展：call:start busy 裁决、disconnect 触发 peer-reconnecting 下行。
- 验证：`pnpm vitest run test/integration/gateway-uplink.test.ts`
- commit: `feat(server): internal 支持通话信令与断连通知`

### T6 server push.ts 改造（emitToUser / 扇出走 downlink）
- `emitToUser` → `publish gw:downlink {userId, frame:{type,data}}`（保留旧函数名，内部换实现；新增 `emitToUserDevice`/`emitToUserExcept` 支持 target/except）。
- `persistAndBroadcastMessage` 扇出循环改 downlink（receiveMessage/mention）。
- 测试：mock redis publish 断言载荷结构（unit）+ 全仓搜 `ioRef` 残留断言。
- 验证：`pnpm typecheck && pnpm vitest run`
- commit: `feat(server): 实时推送改走 gateway downlink`

### T7 server.ts 停挂 socket.io（保留代码）
- `server.ts` 不调 `initSocket`；优雅关闭改为 HTTP server close（socket.io 代码路径保留不删）。
- 验证：`pnpm typecheck && pnpm test` + 本地启动无 socket.io 监听。
- commit: `feat(server): 停挂 socket.io,实时路径切 gateway`

### T8 web ws 客户端模块（web/src/ws/wsClient.ts）
- 原生 WebSocket 封装：URL `WS_URL`（同源 `/ws`）、信封编解码、25s heartbeat、指数退避重连（1s→2s→…→30s 封顶）、下行事件分发（type → handler map）、可靠上行（`send(type,data)` 带 ack 等待 5s + 同 clientMsgId 重发 3 次）。
- 测试：vitest + mock WebSocket：心跳定时、重连退避、ack 超时重发、事件分发。
- 验证：`cd web && pnpm vitest run src/ws`
- commit: `feat(web): 原生 ws 客户端模块`

### T9 web 接线切换（store/hooks/views）
- `chatView/directoryView`：`sendMessage` → `wsClient.send('message.send', …)`（带 clientMsgId + ack）；RTT 打点改 ack 口径。
- `useGlobalMessageListener`：SocketService → wsClient；监听 receiveMessage/receiveFriendReq/friendListChanged；连接即无需 join。
- `useCall.ts`：call:* 上下行切 wsClient（9 种下行监听、6 种上行 send）。
- 旧 `utils/socket.ts`（socket.io）保留不删（回滚用）。
- 验证：`pnpm typecheck && pnpm lint && pnpm test`
- commit: `feat(web): 实时路径切换到 gateway ws`

### T10 dev 接线：vite proxy `/ws` → 8090（vite.config.ts）
- 验证：`pnpm dev` 手动连 `/ws`（或单测配置快照）。
- commit: `chore(web): dev proxy 接入 /ws`

### T11 架构图修订（docs/架构/系统架构图.md）
- 修图 2 JWKS 误标、图 0 补 gateway→server 边、图 3 改 ws 路径、图 6.1 补 Go 路径时序、图 4 标注 iOS 待办。
- commit: `docs: 架构图同步连接层替换目标态`

### T12 端到端验证 + 双端门禁
- `make dev` 全栈起：web 登录→发消息（双标签页）→已读/好友通知/通话信令全链路走 `/ws`。
- 验证断线重连：杀 gateway → 客户端重连 → 消息补拉 `/sync` 无损。
- 双端门禁：`cd server && pnpm typecheck && pnpm test`；`cd gateway && go build ./... && go test ./...`；`cd web && pnpm lint && pnpm test`。
- commit: 修复验证中发现的任何问题

## 依赖关系

```
T1 → T2/T5 → T3/T4(可与 T2 并行) 
T5 → T6 → T7（server 串行）
T8 → T9 → T10（web 串行）
全部 → T11 → T12
```
