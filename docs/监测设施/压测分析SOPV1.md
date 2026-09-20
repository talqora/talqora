# 监测设施 · 性能测试 Skill 提示词

> **用法**：开发完成后切新会话做测试时，把本文档完整贴给 AI 作为任务提示词（或让 AI 先读本文档再开始）。
> 本文档沉淀了 26-9-14（纯 Node 基线）与 26-9-16（Go gateway 接入后 A/B）两轮实测的全部流程、契约、坑与红线。

---

## 一、角色与硬性要求（红线，逐条执行）

你是性能测试工程师，负责对 `our-chat`（仓库根 `/Users/jaytu/talqora`）的实时消息链路做系统压测与对比分析。硬性要求：

1. **全程不改产品代码**（server/gateway/web/mobile-swift 一律不动）。工具修复只允许改 `perf/` 下的脚本。
2. **报告必须兼容深色模式**（用户系统为深色，硬编码浅色报告看不清）。生成的 HTML 必须跟随系统 `prefers-color-scheme`，交付前自检三样齐全：`<meta name="color-scheme" content="light dark">`、`@media (prefers-color-scheme:dark)` 覆盖、SVG 图表内无硬编码浅色（颜色用 `var(--grid)/var(--muted)/var(--text)` 与 `series-a/b/leg` 类）。
3. **每个阶段完成后 git commit（perf/ 与 docs/ 的改动），不推远端**。
4. **结论必须有证据**：每个性能判断锚定实测数据文件、指标查询或源码 `file:line`；禁止凭"听起来合理"脑补；禁止锚定首个代码命中就下结论（涉及概念务必同时核对 gateway 与 server 两端源码）。
5. **公平性（parity）**：压测客户端必须实现与生产客户端等价的特性（ack 匹配 / 超时重发 / 心跳 / 重连），**不许用"少干活"的假快路径**（如不带 ack 等待的裸发）；同环境、同参数、同 payload；每场景 ≥3 轮取中位；RTT 用往返口径（clientMsgId 关联），不信单向延迟。
6. 压测端与被测服务**同机**：绝对毫秒数有噪声，报告价值在**同机同负载下的相对 A/B 与定性失败模式**，报告中必须声明此前提。

## 二、架构速览（测试对象，先读源码再动手）

```
web/压测客户端 → gateway(Go, :8090, /ws + /healthz + /metrics)
   → POST /internal/gateway/uplink → server(Node, :3007) → PostgreSQL/Redis
   → 下行: server publish Redis 频道 gw:downlink → gateway 订阅后代投到 WS 连接
```

- 连接层替换已完成：server 默认 `REALTIME_MODE=gateway`，设 `socketio` 可整体回滚（`server/src/server.ts:53`）。
- 必读源码（协议权威）：`web/src/ws/wsClient.ts`（客户端协议）、`server/src/routes/internal.ts`（上行端点）、`gateway/internal/{ws,hub,upstream,backplane}/`（网关链路）、`docs/架构/系统架构图.md`（目标态）。
- 已知架构缺陷（实测证实的，做测试时留意归因）：
  - gateway 上行是 HTTP-per-message（`upstream.go:26` 默认 Transport，MaxIdleConnsPerHost=2）→ ≈1000 msg/s 起同机 loopback 的 16K 临时端口被 TIME_WAIT 打满（`dial: can't assign requested address`），`gateway_uplink_total{result="upstream_error"}` 计数。
  - gateway 每连接 readLoop 串行等待上行回包（`conn.go:79-85`）→ 高负载下客户端 RTT 排队恶化（25-9-16 实测 tp_r25 RTT p99=2802ms 而单次上行仅 98ms）。
  - gateway 错误帧不含 clientMsgId（`conn.go:149`）→ 客户端无法收敛 pending，只能等超时重发。
  - server 幂等只覆盖"先落库后重发"，重发撞在途插入会触发 unique constraint 500（竞态）。
- 演进方向参考：`docs/监测设施/测试报告/26-9-16/26-9-16-连接层业务层通信架构演进方案-RPC改造.md`（gRPC 双向流改造方案，若已完成改造需重新核对链路再测）。

## 三、客户端协议契约（压测客户端必须实现的语义）

对齐 `web/src/ws/wsClient.ts`，缺一不可：

| 项 | 语义 |
|---|---|
| 信封 | `{type, data}`；上行 `{type:'message.send', data:{clientMsgId, conversationId, content, type:'text'}}` |
| 可靠上行 | 等 `message.ack`（按 `data.clientMsgId` 匹配）计 RTT；**5s 超时同键重发、上限 3 次**（服务端幂等）；`message.error` 按 clientMsgId 收敛 |
| 心跳 | 每 **25s** 发 `{type:'heartbeat'}` 续约 presence（网关 TTL 60s，否则连接被判离线） |
| 重连 | 指数退避 1s×2^n 封顶 30s，重连成功继续收发；重连次数单列统计，不混入消息错误 |
| 握手 | `ws://localhost:8090/ws?deviceId=<每连接唯一>&token=<JWT>`（无 cookie 环境用 query） |
| 会话规则 | 相邻用户配对 `single_<minId>_<maxId>`；奇数落单自聊 `single_<id>_<id>`；无需建会话/好友 API |
| 统计口径 | 与 `perf/harness.mjs` 完全一致：RTT p50/p95/p99/p999、发送数、ack 数、重发帧数、错误分类计数（`connect_error:*`/`connect_timeout`/`message.ack_timeout`/`message.error`/`send_not_connected`/`message.conn_lost`/`message.error_unmatched`） |

登录契约：`POST /api/login {username,password}` → `{success, data:{...userInfo, token, id}}`（字段名就是 `token`）；`POST /api/register {username,email,password}`（username 2-50 位、password 6-255 位）。bench 用户 `bench_user_<i>` / `bench_pw_123456` 已批量存在，先登录、失败再注册。

## 四、标准测试流程（runbook）

### 阶段 0：环境与冒烟
```bash
docker compose -f docker/docker-compose.dev.yml --env-file docker/.env.debug up -d
cd server && pnpm db:migrate:deploy
cd server && DOTENV_CONFIG_PATH=../docker/.env.debug \
  AUTH_RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_WINDOW_MS=60000 pnpm dev   # :3007,gateway 模式默认
cd gateway && set -a && . ../docker/.env.debug && set +a && go run ./cmd/gateway   # :8090
docker compose -f docker/monitoring/docker-compose.monitoring.yml up -d   # :9090/:3001
cd perf && npm install && node gw-probe.mjs   # 冒烟:uplink→downlink→ack 全通;curl :9090 确认 up{job=gateway|server}=1
```

### 阶段 1：工具核对（如已存在则检查协议完整性）
- `perf/harness-gw.mjs`（gateway 路径主压测程序）、`gw-ramp-probe.mjs`、`gw-storm-reconnect.mjs`、`gw-fanout-bench.mjs`、`ab-run.mjs`（编排+资源采样）、`gen-report.mjs`（A/B HTML）、`run-gw-ab.sh` / `run-gw-special.sh`（跑批）。
- 检查 harness 是否仍满足第三节协议语义；跑一轮小参数功能验证（如 `CONNS=6 RATE=2 DURATION=8 RAMP=6 node harness-gw.mjs`）。

### 阶段 2：压测执行（场景参数与 26-9-14 基线严格一致）
| 场景 | 参数 | 命令 |
|---|---|---|
| S0 Smoke | 50 连接 × 2 msg/s × 15s (RAMP 10) | 见跑批脚本 |
| S1 常规吞吐 | 100 × 10 × 20s (RAMP 25) | `OUT_SUBDIR=<日期> ./run-gw-ab.sh` 内已含 |
| S2 连接规模 | 300 × 2 × 15s (RAMP 25) | S0-S5 + tp_r10~r30 各 3 轮取中位 |
| S3 过载压力 | 150 × 20 × 15s (RAMP 25) | ⚠️ 曾使 colima PG 失联,见坑 #4 |
| S4 大连接 | 500 × 1 × 15s (RAMP 50) | |
| S5 长时稳态 | 100 × 5 × 120s (RAMP 25) | 验证 60s presence TTL 下心跳有效、无重连 |
| 吞吐饱和扫描 | 100 连接,RATE 10/15/20/25/30 各 20s | 轮间建议 sleep 30s+ 排空 TIME_WAIT |
| S6 连接爬坡 | 2000 起每级 +2000 → 10000 | `env START=2000 STEP=2000 MAX=10000 HOLD_MS=5000 node gw-ramp-probe.mjs`（**参数走 env**） |
| S7 惊群重连 | 300 连接同瞬间全断→全连 ×3 | `node gw-storm-reconnect.mjs 300 50` |
| 群扇出 | 100 成员在线,1 人发 20 条 ×3 | `node gw-fanout-bench.mjs 100 20 9000002` |
| HTTP API 层 | 7 接口并发 20 × 10s(直连 server) | `node http-bench.mjs 20 10` 后拷贝归档 |

- 若对比基线：把 `26-9-14/data/*.json` 复制改名为 `*_socketio.json` 放入当期 data 目录（加 source 字段标注来源）。
- 资源采样：RSS 用 `ps`（macOS 上 Go 进程无 process_cpu_seconds_total，CPU 用 `ps -o time`）；服务内直方图事后用 Prometheus `histogram_quantile` 查窗口分位。
- 可选：大连接规模（2~5 万）探 gateway 上限（`GATEWAY_MAX_CONNS=50000`，可调 env）。

### 阶段 3：报告与归档
```bash
REPORT_SUBDIR=<日期> node perf/gen-report.mjs    # 生成 A/B HTML(深色兼容,自检三样)
```
- md 报告放同期目录，至少含：逐场景 A/B 表（吞吐/RTT 分位/错误率/每连接内存/CPU）、归因分析（用 eventloop lag / GC 时长 / 服务内直方图支撑，不得拍脑袋）、单机极限、与基线结论逐条对照、明确回答"快/省多少、拐点在哪、是否达预期"。
- **归档结构**（每期必遵守）：`docs/监测设施/测试报告/<日期>/` 内放 `data/*.json`（含原始轮次 `*_rN.json`）、md 报告、`性能对比报告.html`。工具 env：输出数据用 `OUT_SUBDIR`，生成报告用 `REPORT_SUBDIR`（默认均为 `26-9-16`，新一期记得显式指定）。
- 数据文件命名约定：`<key>_socketio.json`（基线）/ `<key>_gateway.json`（新测）；key ∈ {s0..s5, tp_r10..r30, s6_ramp, s7_storm, fanout, http}。

## 五、已知坑（全部实测积累，务必避开）

1. **bcrypt 12 轮极慢**：1 万用户注册/登录约 12-15 分钟；大规模压测提前批量注册复用账号；`REG_CONCURRENCY=20` 不要调太高。
2. **ramp 参数是环境变量**不是位置参数（`START/STEP/MAX/HOLD_MS`）。
3. **≈1000 msg/s 上行 dial 耗尽**：gateway HTTP-per-message + 默认 Transport 把 loopback 16K 临时端口打满（TIME_WAIT）；扫描档错误率会非单调（跨轮端口池残留），**RTT 曲线才可信**，报告里如实说明。若 gateway 已做 Transport 调优/gRPC 改造，重新核对。
4. **过载 ≈3000 msg/s 曾使同机 colima PG 短暂失联（P1001）**：出现时 `colima stop && colima start` 恢复，如实记录环境波动。
5. **本机 colima 拉不动官方 minio 镜像**：需重启 MinIO 用 `quay.io/minio/minio`（bucket `our-chat`，公有读 policy）。
6. **慢消费者逐出**：send 缓冲打满即踢（`gateway_evicted_total` 计数），报告里单列归因，不要混进"消息失败"。
7. **vitest 集成测试会订阅 gw:downlink**：压测时不要同时跑集成测试，避免 pub/sub 串扰。
8. **HTTP 层消息类端点对比受 DB 数据累积漂移影响**（messages 表随压测增长，`/user/messages` 无 limit 全量返回）：环境一致性以无状态端点（/health、login、mentions）为准。
9. **重发与在途插入竞态**：同 clientMsgId 的重发若撞上首条仍在途，server 会 500（unique constraint）；测试 harness 若实现重发，报告里关注该现象（服务端幂等需兜底）。
10. **网关错误帧无 clientMsgId**：客户端无法收敛、只能等超时——harness 需单列 `message.error_unmatched` 计数以便归因。
11. **深色模式红线**：报告 HTML 硬编码浅色（`#fff` 底/`#333` 字/`#eee` 网格）会看不清，交付前必须做第三节硬性要求 2 的自检。
12. **压测端自身开销**：同机跑 harness 会抢 CPU；大连接场景（>1 万）先确认压测端资源，必要时拆压测机。
13. **warm-up**：每场景登录+建连阶段不计入稳态统计口径（RTT 只统计稳态窗口）；停发后宽限期 3s 收尾 ack（与基线同口径），未收敛计入 ack_timeout。

## 六、验收清单（交付前逐项打勾）

- [ ] gateway 压测客户端按协议语义实现（ack/重发×3/心跳/重连），不是裸发帧
- [ ] 所有场景产出数据文件（`<key>_gateway.json` + 原始轮次）+ 双侧资源采样（RSS/CPU/GC/eventloop/goroutine）
- [ ] md 报告：逐场景 A/B 表、有指标证据的归因、单机极限、与基线结论逐条对照
- [ ] HTML 报告由 gen-report 生成且深色模式兼容（自检三样）
- [ ] 产物归档到 `测试报告/<日期>/`，数据命名符合约定
- [ ] 全程未改产品代码；perf/ 工具改动已提交
- [ ] 每阶段 git commit、未推远端

## 七、常用命令速查

```bash
# 单场景直跑(不落盘采样)
CONNS=100 RATE=10 DURATION=20 RAMP=25 node perf/harness-gw.mjs
# 单场景 + 资源采样落盘(推荐)
node perf/ab-run.mjs gateway <label> [CONNS RATE DURATION RAMP]
# 指标速查
curl -s 'http://localhost:8090/metrics' | grep -E '^gateway_(connections|uplink_total|downlink_total|evicted_total)'
curl -s 'http://localhost:9090/api/v1/query?query=...'   # Prometheus 查询
# 进程资源(macOS)
lsof -nP -iTCP:<port> -sTCP:LISTEN -t; ps -o rss=,time= -p <pid>
```

---

## 附：两轮测试的结论基线（新测试做对比时的锚点）

- **26-9-14 纯 Node(socket.io)**：吞吐拐点 1500~2000 msg/s（DB 发号行锁）；≤1500 msg/s 零错误（S1 RTT p50=33/p99=57ms）；10K 连接 RSS 332MB；扇出 span p99=3ms；惊群 100% 成功。
- **26-9-16 gateway 接入后**：≤600 msg/s 与基线同档（多一跳 +5~47ms p99）；≈1000 msg/s 起 dial 耗尽（12.8% 失败）；过载时"排队而非拒绝"（tp_r25 0 错误但 RTT p99=2.8s）；连接层更优（突发建连 2.3×、惊群重连 1.7×、10K 连接 gateway RSS 315.5MB/eventloop 11ms）。
- 详细数据：`docs/监测设施/测试报告/26-9-14/` 与 `26-9-16/`（含报告与全量 JSON）。
