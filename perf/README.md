# perf — IM server(Socket.io)实时路径压测 harness

给监测平台(Prometheus/Grafana 等)的 `server_ws_connections`、`server_message_duration_seconds` 等指标造负载用。只压 `server/`(Express + Socket.io,基址 `http://localhost:3007`),不涉及 gateway/web/mobile。

## 前置条件

先按 `server/CLAUDE.md` 把 server 及其依赖(Postgres、Redis)起来:

```bash
cd server
npm run dev          # 或对应的启动脚本;确认监听在 http://localhost:3007
```

server 没起来时本目录的脚本不会自动跑,只做过语法/依赖校验(见"已知限制")。

## 安装

```bash
cd perf
npm install
```

## 运行

```bash
cd perf
CONNS=200 RATE=5 DURATION=30 RAMP=5 node harness.mjs
# 或
npm run bench
```

## 环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `BASE` | `http://localhost:3007` | server 基址 |
| `CONNS` | `200` | 并发 socket 连接数(= bench 用户数) |
| `RATE` | `5` | 每条连接每秒发送 `message.send` 的消息数;`<=0` 时跳过消息负载,只测连接负载 |
| `DURATION` | `30` | 稳态压测时长(秒) |
| `RAMP` | `5` | 每秒新增连接数(建连爬坡速率,避免瞬时打满) |
| `REG_CONCURRENCY` | `20` | 注册/登录阶段的并发度(bcrypt 12 轮哈希较重,不建议一次性全量并发) |
| `BENCH_PASSWORD` | `bench_pw_123456` | 所有 bench 用户的固定密码(6-255 位,满足 server 校验) |
| `ACK_TIMEOUT_MS` | `5000` | 单条消息等待 `message.ack`/`message.error` 的超时,超时计入 `message.ack_timeout` 错误 |

## 输出指标解读

```
用户注册/登录成功: 200
Socket 连接成功: 198 / 尝试 200
连接建立耗时(ms): p50=12 p95=45 p99=120 min=5 max=310 (n=198)
消息发送数: 29400, 收到 ack 数: 29380
消息 RTT(ms): p50=8 p95=22 p99=60 min=2 max=980 (n=29380)
错误分类计数:
  connect_error:xhr poll error: 2
  message.ack_timeout: 20
```

- **连接建立耗时**:从客户端发起 `io(...)` 连接到收到 socket.io `connect` 事件的耗时,反映握手(含 JWT 验签、Redis presence 登记)开销。
- **消息发送数 / 收到 ack 数**:`message.send` 是自研可靠上行协议(见 `server/src/utils/socket.ts`),服务端落库成功后主动 `emit('message.ack', {clientMsgId, seq, serverMsgId})`,失败则 `emit('message.error', ...)`。二者不是 socket.io 回调式 ack,harness 用 `clientMsgId` 做匹配。
- **消息 RTT**:从 `emit('message.send', ...)` 发出到收到对应 `message.ack` 的耗时,近似端到端处理延迟(含落库事务)。
- **错误分类计数**:
  - `login_failed` / `register_failed` / `*_http_error`:HTTP 阶段的注册登录失败(server 未起、密码策略变化等排查方向)。
  - `connect_error:<msg>`:socket.io 握手失败(常见如 JWT 过期/`CLIENT_ORIGINS` CORS 白名单不含压测来源——注意本 harness 用 `transports:['websocket']` 走纯 WS 不经 HTTP 握手协商,一般不受 CORS origin 校验影响,但仍会受 `io.use` 里的 JWT 校验)。
  - `message.error`:服务端 zod 校验未过或落库异常,主动回的 `message.error`。
  - `message.ack_timeout`:发出后 `ACK_TIMEOUT_MS` 内未收到 `message.ack`/`message.error`,可能是服务端过载或丢包。

## 已知限制 / 关键事实来源

- **登录/注册契约**(已 Read 源码确认,非猜测):
  - `POST /api/register` body 至少 `{username, email, password}`(`server/src/routes/register.ts`):username 2-50 位、仅字母数字下划线中文,email 需合法格式且 ≤100 位,password 6-255 位。返回体**不含 token**。
  - `POST /api/login` body `{username, password}`(`server/src/routes/login.ts`),返回 `{ success, data: { ...userInfo, token } }`,**token 字段名就是 `token`**,连 socket 用的就是它。
- **Socket 握手鉴权**:`server/src/utils/socket.ts` 的 `io.use` 经 `extractHandshakeToken` 从 `handshake.auth.token` 取 JWT(见 `server/src/utils/socketAuth.ts`),harness 用 `auth: { token, deviceId }` 完全对齐;`deviceId` 缺省回落 `socket.id`。
- **`message.send` 字段与 ack 机制**(`server/src/contracts/message.ts` + `server/src/utils/socket.ts`):字段为 `{clientMsgId, conversationId, content, type, mentions?, extra?, fileInfo?}`(`senderId` 会被服务端忽略,以握手身份为准)。**没有 socket.io 回调式 ack**——服务端是主动 `emit('message.ack', ...)` / `emit('message.error', ...)` 两个独立事件,harness 按 `clientMsgId` 匹配来测 RTT。
- **`heartbeat` 不能当 RTT 探针**:读 `server/src/utils/socket.ts` 确认 `socket.on('heartbeat', ...)` 只做 presence TTL 续约,**不回包**,因此弃用它作为 RTT 备选,统一用 `message.ack`。
- **conversationId 不需要走好友/建会话 API,零额外调用即可发消息**:读 `server/src/services/message.ts` 确认 `persistMessage` 用 `INSERT ... ON CONFLICT (id) DO NOTHING` 在首条消息时自动建会话;`getConversationMembers`/`deriveParticipants` 对 `single_<u1>_<u2>` 格式的 conversationId 直接从 id 字符串解析双方 id,不查 DB 成员关系。因此 harness 把相邻两个 bench 用户配对,直接用 `single_<minId>_<maxId>` 发 `message.send` 即可,**未走 `server/src/routes/friend.ts` 的 addFriend/replyFriendReq 流程**(那条路径是给真实产品语义用的双向好友关系 + 自动寒暄消息,压测不需要)。落单的连接(CONNS 为奇数时)自聊 `single_<id>_<id>`。
- **连接负载是底线,消息负载是尽力而为**:若某次 server 变更导致 conversationId 规则/message.send 契约改变,harness 的阶段2(建连)与阶段3(发消息)是解耦的——阶段3 内部 try/catch 且有 `message.ack_timeout` 兜底,不会导致整个 harness 卡死或误报阶段2 失败;`RATE<=0` 可直接关闭消息负载只压连接数。
- **不做的事**:没有引入 Artillery 作为主路径(仅作为可选加分放在 `artillery-socketio.yml`,且明确标注 socket.io v4 协议兼容性未验证,推荐仍用 `harness.mjs`)。没有验证真实压测跑通(未启动 server/DB),仅做了 `node --check` 语法校验与 `npm install` 依赖校验。

## 纯 Node 基线测试(gateway 不参与)

留存"引入 Go 层之前"纯 Node 性能记录的标准流程(报告与数据在 `docs/监测设施/测试报告/26-9-14/`):

| 工具 | 用途 |
|---|---|
| `node-run.mjs` | 跑 harness + 每 2s 采样 server 资源(RSS/连接/eventloop/堆/GC/CPU) + 服务内直方图分位(消息/HTTP/DB/GC) → 落 JSON。用法 `node node-run.mjs <label> [CONNS RATE DURATION RAMP]` |
| `ramp-probe.mjs` | 连接爬坡探顶:阶梯加压并保持连接,成功率/eventloop 阈值判定拐点。**参数走 env** `env START=2000 STEP=2000 MAX=10000 HOLD_MS=5000 node ramp-probe.mjs` |
| `storm-reconnect.mjs` | 惊群重连:N 连接同瞬间全断→全连,测成功率/耗时/资源尖峰。用法 `node storm-reconnect.mjs [CONNS RAMP]` |
| `fanout-bench.mjs` | 群扇出:直写 DB 建群 + N 成员在线,测 fan-out 扩散 span/端到端 e2e。用法 `node fanout-bench.mjs [MEMBERS ROUNDS GROUP_ID]` |
| `http-bench.mjs` | HTTP API 层并发压测(health/login/userConversations/messages/lastMessages/sync/mentions 的吞吐/时延/错误)。用法 `node http-bench.mjs [CONCURRENCY DURATION]` |
| `gen-node-report.mjs` | 读 `26-9-14/data/*.json` 生成自包含 HTML 基线报告(跟随系统深浅色) |

前置:`node-run.mjs`/`ramp-probe.mjs`/`storm-reconnect.mjs`/`http-bench.mjs` 依赖 Prometheus(:9090)采资源指标与 `lsof`/`ps` 读进程 RSS;`fanout-bench.mjs` 依赖 docker 直写 DB 建群。跑之前确认 server 已按 `docs/监测设施/测试报告/26-9-14/README.md` 的 runbook 启动(gateway 不要启动)。

## Go gateway 路径压测(26-9-16 A/B 对比,gateway 参与)

gateway 路径工具链:原生 WebSocket 连 gateway /ws(query `deviceId`+`token`),协议严格对齐 `web/src/ws/wsClient.ts`(信封 `{type,data}`、`message.send`→`message.ack` 按 clientMsgId 匹配计 RTT、5s 超时同键重发上限 3 次、25s 心跳续约 presence、指数退避断线重连)。**不是裸发帧**。

| 工具 | 用途 |
|---|---|
| `harness-gw.mjs` | gateway 路径压测主程序(登录 → WS 建连 → 可靠上行,统计口径与 harness.mjs 完全一致,含 p999) |
| `ab-run.mjs` | A/B 编排器:跑 harness(socketio 或 gateway)+ 每 2s 采样(Prometheus 连接/eventloop/goroutine/GC/CPU + `ps` 两进程 RSS)+ 服务内直方图分位(uplink/downlink/HTTP/GC)→ JSON 到 `测试报告/<期目录>/data/`(env `OUT_SUBDIR`,默认 `26-9-16`)。用法 `node ab-run.mjs <socketio|gateway> <label> [CONNS RATE DURATION RAMP]` |
| `gw-ramp-probe.mjs` | gateway 连接爬坡探顶。**参数走 env** `START/STEP/MAX/HOLD_MS`(如 `env START=2000 STEP=2000 MAX=10000 HOLD_MS=5000 node gw-ramp-probe.mjs`),落 `s6_ramp_gateway.json` |
| `gw-storm-reconnect.mjs` | gateway 惊群重连。`node gw-storm-reconnect.mjs [CONNS=300] [RAMP=50]`,落 `s7_storm_gateway.json` |
| `gw-fanout-bench.mjs` | gateway 群扇出(直写 DB 建群 + fan-out span/e2e)。`node gw-fanout-bench.mjs [MEMBERS=100] [ROUNDS=20] [GROUP_ID]`,落 `fanout_bench_gateway.json` |
| `gen-report.mjs` | 读 `测试报告/<期目录>/data/*_socketio.json` + `*_gateway.json` 生成 A/B 对比 HTML(自包含、**跟随系统深浅色**)。期目录用 env `REPORT_SUBDIR` 指定(默认 `26-9-16`) |

gateway 路径先决条件:server 以 `REALTIME_MODE=gateway`(默认)启动 + gateway(:8090)按 `docker/.env.debug` 启动;Prometheus 抓两侧 /metrics。监测栈见 `docker/monitoring/`。

## 报告与产物规范(每期必遵守)

- **报告必须兼容深色模式**:生成的 HTML 报告(gen-report.mjs / gen-node-report.mjs)必须跟随系统 `prefers-color-scheme`——`<meta name="color-scheme" content="light dark">` + CSS 变量双主题(浅色默认、`@media (prefers-color-scheme:dark)` 覆盖),SVG 图表内颜色一律用 `var(--grid)`/`var(--muted)`/`var(--text)` 与 `series-a`/`series-b`/`leg` 类,**禁止硬编码浅色**(如 `#fff` 底、`#333` 字、`#eee` 网格)。深色模式用户看不清浅色硬编码报告,这是硬性要求。
- **每期产物归档**:一期测试的产出(data/*.json、md 报告、HTML 报告)统一放 `docs/监测设施/测试报告/<日期>/`(与 26-9-14/26-9-16 同结构),不要散在 `测试报告/` 根目录;生成报告时用 `REPORT_SUBDIR=<日期> node gen-report.mjs` 指向当期目录。
- 生成后自检:`color-scheme` meta、dark 媒体查询、SVG 中无硬编码浅色三样齐全再交付。
