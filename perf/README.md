# perf — our-chat 实时路径压测 harness

给监测平台（Prometheus / Grafana）的 `gateway_*`、`server_*`、`http_request_duration_seconds` 等指标造真实负载。

被测对象固定为当前架构的两层：

- **`biz`（Go 业务层）** — HTTP 基址 `http://localhost:3007`；
- **`gateway`（Go 长连接网关）** — 原生 WebSocket `ws://localhost:8090/ws`。

协议严格对齐 `web/src/ws/wsClient.ts`：信封 `{type, data}`、`message.send` → `message.ack` 按 `clientMsgId` 匹配计 RTT、5s 超时同键重发上限 3 次、25s 心跳续约 presence、指数退避断线重连。**不是裸发帧。**

> 历史说明：Node + Socket.io 业务层已于 2026-09 下线，对应的 `harness.mjs` / `node-run.mjs` / `ramp-probe.mjs` / `storm-reconnect.mjs` / `fanout-bench.mjs` / `err-probe.mjs` / `gen-node-report.mjs` / `gen-report.mjs` / `artillery-socketio.yml` 已删除。历史数据与报告仍归档在 `docs/监测设施/测试报告/26-9-14/`，但**不再参与任何新测与分析口径**。

## 前置条件

```bash
# 仓库根：一键起中间件 + biz(:3007, gRPC :3008) + gateway(:8090) + web(:5173)
make dev
```

监测栈（可选，`ab-run.mjs` 与各 probe 采资源指标时需要）：

```bash
make -C docker/monitoring up -d    # Prometheus :9090 + Grafana
```

## 安装

```bash
cd perf
npm install          # 仅依赖 ws
```

## 主压测：harness-gw.mjs

```bash
cd perf
CONNS=200 RATE=5 DURATION=30 RAMP=5 node harness-gw.mjs
npm run bench        # 等同上一条的默认参数
```

| 变量 | 默认值 | 含义 |
|---|---|---|
| `BASE` | `http://localhost:3007` | biz HTTP 基址（注册/登录） |
| `GW` | `ws://localhost:8090/ws` | gateway WebSocket 地址 |
| `CONNS` | `200` | 并发连接数（= bench 用户数） |
| `RATE` | `5` | 每条连接每秒发送 `message.send` 的消息数；`<=0` 只压连接 |
| `DURATION` | `30` | 稳态压测时长（秒） |
| `RAMP` | `5` | 每秒新增连接数（避免瞬时打满） |
| `REG_CONCURRENCY` | `20` | 注册/登录并发度（bcrypt 12 轮较重，不建议全量并发） |
| `BENCH_PASSWORD` | `bench_pw_123456` | bench 用户固定密码 |
| `ACK_TIMEOUT_MS` | `5000` | 等待 `message.ack`/`message.error` 的超时 |
| `ACK_MAX_RETRIES` | `3` | 同 `clientMsgId` 重发上限（对齐 wsClient.ts） |
| `HEARTBEAT_INTERVAL_MS` | `25000` | 心跳间隔（对齐 wsClient.ts） |
| `CONNECT_TIMEOUT_MS` | `10000` | 建连超时 |

**输出解读**

- **连接建立耗时**：从发起 WS 握手到 `open` 的耗时，含 JWT 验签 + Redis presence 登记。
- **消息发送数 / ack 数**：`message.send` 是自研可靠上行，服务端落库后主动回 `message.ack {clientMsgId, seq, serverMsgId}`，失败回 `message.error`；harness 按 `clientMsgId` 匹配（不是 WS 回调式 ack）。
- **消息 RTT**：发出到收到对应 ack 的耗时，近似端到端处理延迟（含落库事务）。
- **错误分类**：
  - `login_failed` / `register_failed` / `*_http_error`：HTTP 阶段失败（biz 未起、密码策略变化）。
  - `connect_error:<msg>`：WS 握手失败（JWT 过期、`CLIENT_ORIGINS` 白名单不含压测来源、网关配额已满）。
  - `message.error`：业务校验未过或落库异常。
  - `message.ack_timeout`：`ACK_TIMEOUT_MS` 内无 ack/error，可能过载或丢包。

## 专项场景

| 工具 | 用途 | 用法 |
|---|---|---|
| `ab-run.mjs` | 编排器：跑 harness + 每 2s 采样（Prometheus + `ps`）+ 服务内直方图分位 → 落 JSON 到 `测试报告/<OUT_SUBDIR>/data/` | `node ab-run.mjs gateway <label> [CONNS RATE DURATION RAMP]` |
| `gw-ramp-probe.mjs` | 连接爬坡探顶，输出拐点与各级数据 → `s6_ramp_gateway.json` | `env START=2000 STEP=2000 MAX=10000 HOLD_MS=5000 node gw-ramp-probe.mjs` |
| `gw-storm-reconnect.mjs` | 惊群重连：N 连接同瞬间全断→全连 → `s7_storm_gateway.json` | `node gw-storm-reconnect.mjs [CONNS=300] [RAMP=50]` |
| `gw-fanout-bench.mjs` | 群扇出：直写 DB 建群 + N 成员在线，测扩散 span 与端到端 e2e → `fanout_bench_gateway.json` | `node gw-fanout-bench.mjs [MEMBERS=100] [ROUNDS=20] [GROUP_ID]` |
| `http-bench.mjs` | HTTP API 并发压测（health/login/userConversations/messages/lastMessages/sync/mentions） | `node http-bench.mjs [CONCURRENCY DURATION]` |
| `gw-probe.mjs` | 冒烟探针：注册/登录 → 连 gateway → 发一帧 → 等回显，验证 uplink/downlink/连接指标 | `node gw-probe.mjs` |
| `call-rejoin-probe.mjs` | 通话信令回归：主叫→被叫→断线→`call:rejoin`，验证 rejoin 重协商链路 | 见下方「凭据」 |
| `gen-report-v2.mjs` | 读 `测试报告/<REPORT_SUBDIR>/data/*_gateway.json` 生成单边深度 HTML（自包含、跟随系统深浅色） | `REPORT_SUBDIR=<日期> node gen-report-v2.mjs` |

`ab-run.mjs` 的第一个位置参数保留为 `gateway`（既有脚本与 SOP 均以该形式调用）；传入其它值会直接报错退出。

批量跑批：

```bash
perf/run-gw-ab.sh                       # 主场景 A/B 跑批
biz/scripts/run-gw-special-go.sh        # S6 爬坡 / S7 惊群 / 群扇出 / HTTP 专项
biz/scripts/run-gw-retest.sh            # 单项重测
```

## 凭据

`call-rejoin-probe.mjs` 等探针**不再内置账号口令**，改为从环境变量读取：

```bash
PROBE_USER=<压测账号>  PROBE_PASSWORD=<口令> \
PEER_USER=<对端账号>   PEER_PASSWORD=<口令>  node call-rejoin-probe.mjs
```

账号需事先在库里存在（可用 `POST /api/register` 注册）。**不要把真实口令写回脚本或提交进仓库。**

## 报告与产物规范（每期必遵守）

- **报告必须兼容深色模式**：生成的 HTML（`gen-report-v2.mjs`）必须跟随系统 `prefers-color-scheme`——`<meta name="color-scheme" content="light dark">` + CSS 变量双主题，SVG 内颜色一律用 `var(--grid)` / `var(--muted)` / `var(--text)` 与 `series-a` / `series-b` / `leg` 类，**禁止硬编码浅色**（`#fff` 底、`#333` 字、`#eee` 网格）。深色用户看不清浅色硬编码报告，这是硬性要求。
- **每期产物归档**：`data/*.json`、md 报告、HTML 报告统一放 `docs/监测设施/测试报告/<日期>/`，不要散在 `测试报告/` 根目录。
- **数据命名**：`<key>_gateway.json`，key ∈ `s0..s5` / `tp_r10..r30` / `s6_ramp` / `s7_storm` / `fanout` / `http`。
- **生成后自检**：`color-scheme` meta、dark 媒体查询、SVG 中无硬编码浅色，三样齐全再交付。

## 已知限制

- 阶段 2（建连）与阶段 3（发消息）解耦：`message.send` 契约变化不会导致整个 harness 卡死或误报建连失败。
- `conversationId` 直接用 `single_<minId>_<maxId>` 构造，依赖 biz 的 `ensureConversation` 首条消息自动建会话；落单连接（`CONNS` 为奇数）自聊 `single_<id>_<id>`。
- `ab-run.mjs` 的 `nodejs_*` 系列查询在 Go 业务层上恒为空（biz 不导出 Node 指标），对应数组留空，不影响 gateway 侧数据。
