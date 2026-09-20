# 监测设施 · 压测分析 SOP V2(全 Go 体系)

> **用法**：开新会话后把本文档完整贴给 AI(或让其先读本文档再开工)。
> 承接 SOP V1(26-9-16 时代的 Node vs Go 双跑体系)。业务层已全部 Go 化(biz 替换 server Node),监测平台与分析方法升级到 V2。
> 本文档全部事实锚定 2026-09-18/09-20 实测与源码,**禁止凭记忆脑补**——开工前先按 §2 读源码核实。

---

## 一、角色与硬性要求(红线,逐条执行)

你是性能测试工程师,负责对 `our-chat`(仓库根 `/Users/jaytu/talqora`)的全 Go 实时消息链路做系统压测与对比分析。硬性要求:

1. **全程不改产品代码**(biz/gateway/web/mobile-swift 一律不动)。只允许改 `docker/monitoring/`(监测设施)、`docs/监测设施/`、`perf/`、`biz/scripts/`(工具)。
2. **报告必须兼容深色模式**。交付前自检三样齐全:①`<meta name="color-scheme" content="light dark">`;②`@media (prefers-color-scheme:dark)` 覆盖;③SVG 图表内无硬编码浅色(颜色用 `var(--grid)/var(--muted)/var(--text)` 与 `series-a/b/leg` 类)。
3. **每个阶段完成后 git commit(perf/ 与 docs/ 的改动),不推远端**。
4. **结论必须有证据**:每个性能判断锚定实测数据文件、指标查询或源码 `file:line`;禁止脑补;禁止锚定首个代码命中就下结论(涉及概念务必同时核对 gateway 与 biz 两侧源码)。
5. **公平性(parity)**:压测客户端必须实现与生产客户端等价的特性(ack 匹配 / 5s 超时同键重发×3 / 25s 心跳 / 断线重连),**不许用"少干活"的假快路径**;同环境、同参数、同 payload;每场景 ≥3 轮取中位;RTT 用往返口径(clientMsgId 关联),不信单向延迟。
6. 压测端与被测服务**同机**:绝对毫秒数有噪声,报告价值在**同机同负载下的相对对比与定性失败模式**,报告必须声明此前提。

## 二、架构速览(全 Go 拓扑,先读源码再动手)

```mermaid
flowchart TD
    subgraph client["压测客户端 perf/harness-gw.mjs(等价 web/src/ws/wsClient.ts)"]
        C1[ack 匹配/5s 超时同键重发×3/25s 心跳/断线重连]
    end
    subgraph gw["gateway Go :8090 /ws + /healthz + /metrics"]
        G1[WS 握手鉴权 JWT + 连接配额 MaxConns]
        G2[上行:gRPC 双向流,userId 哈希分片,每后端 4 流]
        G3[多后端 failover:目标不健康降级首个健康后端]
        G4[下行:接收 gRPC DownlinkFrame 或订阅 gw:downlink → RouteToUser]
        G5[慢消费者逐出 SendBuffer 满即踢]
    end
    subgraph biz["biz Go 副本 ×N(3007/3008, 3009/30081)"]
        B1[EdgeServer:gRPC Stream,health.v1,keepalive MinTime=20s]
        B2[会话热点限流 CONV_RATE_LIMIT_MAX=500/s/会话]
        B3[发号:Redis INCR + Lua 装载 + checkpoint 60s + 防回卷]
        B4[幂等:Redis SETNX 5min + DB 唯一约束兜底]
        B5[定向下行:presence.replica → gRPC 下行流直发]
        B6[回退:Redis gw:downlink pub/sub]
    end
    subgraph infra["中间件 colima"]
        M1[(PostgreSQL: messages 哈希 64 分区 + 只读池 store.RO)]
        M2[(Redis: seq/幂等/限流/presence/gw:downlink)]
        M3[(MinIO)]
    end
    subgraph mon["监测栈 docker compose monitoring"]
        P1[Prometheus :9090 job=server/biz2/gateway]
        P2[Grafana :3001 面板 realtime-system-authority]
    end

    C1 -->|WS 握手| G1
    G1 --> G2
    G2 -->|UplinkFrame| B1
    B1 -->|CheckConvRate| B2
    B2 -->|拒绝| B2r[429 message.error 带 clientMsgId]
    B1 --> B3
    B3 -->|快路径 INCR| M2
    B3 -->|Redis 故障降级 DB 行锁| M1
    B1 --> B4
    B1 -->|PersistMessage 分区表写入| M1
    B1 --> B5
    B5 -->|presence.replica 命中| G4
    B5 -.失败/未知副本.-> B6
    B6 -->|pub/sub 全副本广播| G4
    G4 -->|WS 帧回投| C1
    G2 -.流中断重建(退避 0.1→3.2s).-> G2
    P1 -.5s 抓取.-> gw
    P1 -.5s 抓取.-> biz
    P2 --> P1
```

- 连接实体在 gateway;biz 是模块化单体(HTTP gin + gRPC edge 双面),多副本无状态,**任何副本可处理任意用户消息**(状态全外置:seq/幂等/限流/通话态在 Redis/PG)。
- `server/`(Node) 目录仍在仓库但**不参与任何流量**;`REALTIME_MODE=socketio` 回滚开关保留但本轮不测。
- 必读源码(协议与指标权威):

| 对象 | 路径 |
|---|---|
| 客户端协议权威 | `web/src/ws/wsClient.ts` |
| 网关链路 | `gateway/internal/{ws,hub,upstream(grpc.go/multi.go),backplane}/` |
| biz 实时入口 | `biz/internal/realtime/{edge.go,handleUplink.go,edge_util.go,directdownlink.go}` |
| 发号/幂等/限流 | `biz/internal/service/{seq.go,message.go,ratelimit.go,presence.go,downlink.go}` |
| 指标全集 | `biz/internal/metrics/metrics.go`、`gateway/internal/metrics/metrics.go` |
| 监测配置 | `docker/monitoring/{prometheus.yml,grafana/dashboards/,grafana/provisioning/}` |
| 压测工具 | `perf/{harness-gw,gw-probe,gw-ramp-probe,gw-storm-reconnect,gw-fanout-bench,http-bench,ab-run,gen-report-v2}.mjs`、`perf/run-gw-ab.sh`、`biz/scripts/run-gw-special-go.sh` |

## 三、客户端协议契约(压测客户端必须实现的语义)

对齐 `web/src/ws/wsClient.ts`,缺一不可:

| 项 | 语义 |
|---|---|
| 信封 | `{type, data}`;上行 `{type:'message.send', data:{clientMsgId, conversationId, content, type:'text'}}` |
| 可靠上行 | 等 `message.ack`(按 `data.clientMsgId` 匹配)计 RTT;**5s 超时同键重发、上限 3 次**(服务端幂等);`message.error` 按 clientMsgId 收敛 |
| 心跳 | 每 **25s** 发 `{type:'heartbeat'}` 续约 presence(网关 TTL 60s,否则连接被判离线) |
| 重连 | 指数退避 1s×2^n 封顶 30s,重连成功继续收发;重连次数单列统计,不混入消息错误 |
| 握手 | `ws://localhost:8090/ws?deviceId=<每连接唯一>&token=<JWT>`(无 cookie 环境用 query) |
| 会话规则 | 相邻用户配对 `single_<minId>_<maxId>`;奇数落单自聊 `single_<id>_<id>`;无需建会话/好友 API |
| 统计口径 | 与 `perf/harness-gw.mjs` 完全一致:RTT p50/p95/p99/p999、发送数、ack 数、重发帧数、错误分类计数(`connect_error:*`/`connect_timeout`/`message.ack_timeout`/`message.error`/`send_not_connected`/`message.conn_lost`/`message.error_unmatched`) |

登录契约:`POST /api/login {username,password}` → `{success, data:{...userInfo, token, id}}`;`POST /api/register {username,email,password}`。bench 用户 `bench_user_<i>` / `bench_pw_123456` 已批量存在,先登录、失败再注册。

## 四、测试对象与指标全集(全 Go,双侧 metrics.go 实测)

**注意**:Node 时代指标已全部退役——`nodejs_eventloop_lag_seconds`、`nodejs_gc_pause_seconds` **不存在**;goroutine/GC/内存/CPU 用 Go runtime 默认指标,采样务必带 `job` 标签区分(`gateway` / `server`(biz 副本 1)/ `biz2`(副本 2))。

| 面 | 指标(来源) | 观测意义 |
|---|---|---|
| 连接面 | `gateway_connections`、`gateway_handshakes_total{result}`、`gateway_evicted_total`(gateway) | 配额水位/被刷/背压逐出 |
| 连接面 | `server_ws_connections`(=本副本 gRPC 流数)、`server_online_users`(恒 0 占位)(biz) | 流数水位 |
| 上行链路 | `gateway_uplink_total{result}`、`gateway_uplink_duration_seconds`(gateway) | 上行成败与端到端延迟 |
| 消息处理 | `server_message_in_total`、`server_message_out_total{result}`、`server_message_duration_seconds`(biz) | 收发速率与处理延迟 |
| **下行双通道** | `server_downlink_direct_total`、`server_downlink_fallback_total`(biz);`gateway_downlink_total{result=delivered\|dropped}`、`gateway_downlink_duration_seconds`(gateway) | direct/fallback 比例是定向下行健康度的核心证据 |
| 保护面 | `server_conversation_rate_limited_total`(biz) | 会话热点限流拒绝计数 |
| 通话面 | `server_call_events_total{event}`、`server_active_calls`(biz) | 通话信令与活跃通话 |
| HTTP 面 | `http_request_duration_seconds{method,route,status}`、`server_rum_web_vitals`(biz) | HTTP 吞吐延迟与前端 RUM |
| DB 面 | `db_query_duration_seconds{model,operation}`(biz,pgx 埋点) | 按 model 分线的查询速率与延迟 |
| Go 运行时 | `go_goroutines`、`go_gc_duration_seconds`(Summary,无 bucket)、`process_resident_memory_bytes`、`process_cpu_seconds_total`(macOS 无 /proc 时缺失,以 ps 采样为准) | 并发水位/GC 墙钟/内存/CPU |
| 副本面 | `rate(server_message_in_total[1m]) by (job)` | 多副本分流均衡性、kill 演练断崖 |

Grafana 权威面板 `docker/monitoring/grafana/dashboards/realtime-system-authority.json`(「Realtime: 系统权威监测」)已按上表组织 row;**旧面板 `realtime-node-vs-go.json` 一字不改、两者并存**。

## 五、关键业务流程监测点(异常形态长什么样)

```mermaid
sequenceDiagram
    autonumber
    participant H as harness
    participant GW as gateway
    participant B as biz
    participant PG as PostgreSQL
    participant R as Redis

    H->>GW: WS message.send(P1 上行)
    GW->>B: gRPC UplinkFrame(userId 哈希分片)
    B->>R: CheckConvRate(P0 限流) / NextSeq / 幂等 SETNX
    B->>PG: INSERT messages 分区表
    B-->>GW: UplinkAck
    GW-->>H: message.ack(P2 ack,RTT 往返口径)
    B->>R: presence.replica 查询(P3 下行)
    B->>GW: gRPC DownlinkFrame 定向直发
    Note over B,GW: direct 失败/副本未知 → Redis gw:downlink 回退
    GW->>H: WS 帧回投(P3 下行投递)
    H-->>GW: 25s heartbeat(P4 心跳,续约 presence)
    H--xGW: 断连(P5 断连,ConnClosed 通知 biz)
```

| 流程 | 看哪块面板 | 正常形态 | 异常形态与排查方向 |
|---|---|---|---|
| P0 限流 | 保护面 | `rate_limited` 平坦 0 | 计数突增=热点会话在打爆发号/扇出;单会话压测 >500/s 会被 429,需调高 `CONV_RATE_LIMIT_MAX`(坑 6) |
| P1 上行 | 上行链路 | `gateway_uplink_total{result=ok}` 与 in 一致 | `upstream_error` 陡增=上行流不可用(流建立窗口/biz 重启);先查 gateway 日志"上行流重建"频率 |
| P2 ack | 消息处理 | `message_out{ok}`≈`message_in`;处理延迟 p99 稳定 | ok 与 in 差值放大=限流拒绝/系统错误;延迟 p99 走高结合 DB 面分线定位 |
| P3 下行双通道 | 下行双通道 row(核心) | direct 占比 ≈100%,fallback≈0 | **fallback 陡增=定向下行异常**(副本失联/presence 无记录/流未建立);`gateway_downlink_total{dropped}` 走高=本网关无此用户连接 |
| P4 心跳 | 连接面 | 连接数平稳、无周期波动 | 连接数 90s 周期锯齿=keepalive 失配回归(客户端 ping 30s vs server MinTime 20s,坑 4) |
| P5 断连 | 连接面+上行链路 | `evicted_total` 仅慢消费者计数 | 断连激增区分:慢消费者逐出 vs 客户端主动断开 vs 流中断 |
| P6 HTTP | HTTP 面 | /health 高 rps、login 低 rps(bcrypt) | 消息类端点对比受 DB 数据累积漂移影响,环境一致性以无状态端点(/health/login/mentions)为准 |
| P7 读路径 | DB 面 | messages/lastMessages 分线延迟低(分区裁剪) | 分线走高=分区裁剪失效或读库竞争;messages 全量兼容路径仍在(无 limit 调用) |

## 六、标准测试流程(runbook)

### 阶段 0:环境启动

```bash
# 1. 中间件(colima,§7 坑 1 失联 SOP 常备)
docker ps   # PG/Redis/MinIO 三个 our-chat 容器 healthy

# 2. biz 双副本(迁移 embed 进二进制,先 build 再部署;关键 env 显式 export)
cd biz && go build -o /tmp/biz-server ./cmd/biz
PORT=3007  EDGE_GRPC_ADDR=127.0.0.1:3008  EDGE_GRPC_ENABLED=true REPLICA_ID=biz-1 \
  AUTH_RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_WINDOW_MS=60000 CONV_RATE_LIMIT_MAX=500 \
  JWT_SECRET=dev-secret-change-me DATABASE_URL=postgresql://postgres:postgres@localhost:5432/our_chat \
  REDIS_URL=redis://localhost:6379 S3_ENDPOINT=http://localhost:9000 /tmp/biz-server &   # :3007
PORT=3009  EDGE_GRPC_ADDR=127.0.0.1:30081 EDGE_GRPC_ENABLED=true REPLICA_ID=biz-2 \
  AUTH_RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_WINDOW_MS=60000 CONV_RATE_LIMIT_MAX=500 \
  JWT_SECRET=dev-secret-change-me DATABASE_URL=postgresql://postgres:postgres@localhost:5432/our_chat \
  REDIS_URL=redis://localhost:6379 S3_ENDPOINT=http://localhost:9000 /tmp/biz-server &   # :3009(单副本部署可省)

# 3. gateway(多后端 + gRPC 上行)
cd gateway && JWT_SECRET=dev-secret-change-me GATEWAY_UPSTREAM=grpc \
  EDGE_GRPC_ADDR=127.0.0.1:3008,127.0.0.1:30081 REDIS_URL=redis://localhost:6379 \
  REPLICA_ID=gw-1 go run ./cmd/gateway   # :8090

# 4. 监测栈
docker compose -f docker/monitoring/docker-compose.monitoring.yml up -d   # :9090/:3001
docker restart our-chat-prometheus   # prometheus.yml 改动后重启生效
curl -s http://localhost:9090/api/v1/targets   # 确认 job=server/biz2/gateway 全 up

# 5. 等 ~10s(gRPC 流建立窗口,坑 5)→ 冒烟
cd perf && node gw-probe.mjs
```

### 阶段 1:冒烟(交付红线)

```bash
# ① probe 通(uplink→downlink→ack 全链路)
node perf/gw-probe.mjs
# ② 定向下行指标:direct>0 且 fallback≈0(查两侧累计)
curl -s localhost:3007/metrics | grep -E '^server_downlink_(direct|fallback)_total'
curl -s localhost:3009/metrics | grep -E '^server_downlink_(direct|fallback)_total'
# ③ 小参数零错误
cd perf && CONNS=20 RATE=5 DURATION=10 node harness-gw.mjs   # 980 全 ack,零错误
```

### 阶段 2:主跑批 + 专项

```bash
cd perf
OUT_SUBDIR=<当天日期> ./run-gw-ab.sh   # 11 场景 ×3 轮取中位(S3/tp_r30 过载档可能压挂 colima,挂则按 §7.1 SOP 恢复断点续跑)
OUT_SUBDIR=<当天日期> bash ../biz/scripts/run-gw-special-go.sh   # S6 爬坡/S7 惊群/群扇出/HTTP
```

场景参数(沿用历史约定,保证各期同口径):S0 50×2×15 / S1 100×10×20 / S2 300×2×15 / S3 150×20×15 / S4 500×1×15 / S5 100×5×120 / tp_r10~r30 100×{10..30}×20;S6 `START=2000 STEP=2000 MAX=10000 HOLD_MS=5000`(env);S7 `gw-storm-reconnect.mjs 300 50` ×3;扇出 `gw-fanout-bench.mjs 100 20 9000002` ×3;HTTP `http-bench.mjs 20 10`。

### 阶段 3:分布式演练(必做,本轮红线)

1. **双副本分流验证**:压测期间 `rate(server_message_in_total[1m]) by (job)` 两副本均增长(副本面板)。
2. **kill biz2 failover**:`kill <pid>`(按 env PORT=3009 定位 pid,**禁端口匹配 kill**,坑 1.2)→ 短压测应**零失败**(红线:修复前同演练 53% 失败)→ 记录 `gateway` 日志降级路径。
3. **恢复 biz2**:重启后自动回归分流,零错误。
4. **下行比例记录**:direct/fallback 累计值落盘入报告。

### 阶段 4:归档与报告(单边深度口径,禁止 Node 对比)

```bash
cd perf && REPORT_SUBDIR=<日期> node gen-report-v2.mjs   # 单边深度 HTML(只含本期数据)
# 深色模式自检三样(§1.2)
```

- **归档结构**:`docs/监测设施/测试报告/<日期>/` 内放 `data/*.json`(含原始轮次 `*_rN.json`)、md 报告、`性能对比报告.html`。工具 env:输出数据用 `OUT_SUBDIR`,生成报告用 `REPORT_SUBDIR`(默认均为旧日期,新一期必须显式指定)。
- 数据命名约定:`<key>_gateway.json`(新测);key ∈ {s0..s5, tp_r10..r30, s6_ramp, s7_storm, fanout, http}。**不再拷贝/引用 `*_socketio.json` 历史基线**(Node 时代数据已退出分析口径,`gen-report-v2.mjs` 不读它)。
- **压测期间抓一次 Grafana 全面板截图**(「Realtime: 系统权威监测」)作为监测闭环证据,报告引用。
- 报告要求见 §8.2「深度报告必答清单」,逐条覆盖后才算完成。

## 七、已知坑(上期 17 类精选 + 必背 5 条)

### 7.1 必背 5 条(每条都可能毁掉一整轮)

1. **colima 宿主守护进程频繁崩溃**(上期累计 15 次,9-18 当天 8 次):`docker` 报 daemon 不可达 / `colima status` 报 empty value。**SOP**:`colima stop && colima start` → sleep 24s → `docker start our-chat-minio`(minio 不自动拉起)→ 重启 biz/gateway → 探针 → 压测**断点续跑**。减压:停掉非本任务容器(agent-* 系列大户);压测期间避免频繁重启业务进程。
2. **shell env 残留污染**:工具 shell 环境持久化,临时实例的 `CONV_RATE_LIMIT_MAX=3` 曾残留污染主实例(980 条消息 680 条被限流拒绝)。**每次启动显式 export 全部关键 env**;行为与配置不符先 `ps eww <pid> | tr ' ' '\n' | grep -E '^(PORT|EDGE|CONV|AUTH|REPLICA)'` 查进程 env(此步应排在排查第 1 位)。
3. **迁移 embed 进二进制**:biz 新增/改迁移后必须重新 `go build -o /tmp/biz-server ./cmd/biz`;迁移版本号先 `ls biz/migrations/` 避免重复(上次撞 0003);dirty 修复先确认事务回滚完整。
4. **gRPC 流建立窗口**:biz/gateway 重启后 5~10s 内消息会"上行流不可用"失败——重启后**等 ~10s、先 gw-probe 再压测**。
5. **keepalive 匹配**:gateway 客户端 ping `Time=30s`,biz server `MinTime=20s`;若调参破坏匹配会重现 90s 周期 GOAWAY 断连(上期已修)。回归时留意 gateway 日志"上行流重建"频率与连接数 90s 锯齿。

### 7.2 其余常踩坑

- **限流阈值**:`CONV_RATE_LIMIT_MAX=500`/s/会话——主场景每会话 ≤30/s 不受影响;要测热点限流需专门场景(单会话 500+ msg/s),或临时调高阈值。
- **bcrypt 12 轮登录慢**(1 万用户 ~12-15 分钟):S6 爬坡提前批量注册复用账号;`REG_CONCURRENCY=20` 勿调高。
- **群扇出需要 `GROUP_ID=9000002`**(直写 DB 建群);**HTTP bench 输出默认落到旧目录 `26-9-14/data/http_bench.json`**,跑完拷回当期归档并用 `git show` 还原旧目录。
- **messages 分区表已上线**(schema_migrations version=7):新环境从零建库由 biz 启动自动跑全量迁移;旧数据 359 万行已回填,**勿重复执行分区迁移**。
- **报告生成**:用 `gen-report-v2.mjs`(单边深度版,只读 `*_gateway.json`),旧 `gen-report.mjs`(A/B 对比版,依赖 `*_socketio.json` 基线)已随 Node 退役停用,不要再用。
- **杀进程**:`lsof -ti :端口` 返回多 PID 有误杀面——一律按二进制路径 `pkill -f "/tmp/biz-server"`;kill 单副本按 env(PORT)定位 pid。
- **慢消费者逐出**(`gateway_evicted_total`)报告里单列归因,不混进"消息失败"。
- **zsh 只读变量**:脚本变量避开 `UID`/`EUID`。
- **warm-up**:每场景登录+建连阶段不计入稳态统计;停发后宽限期 3s 收尾 ack,未收敛计入 ack_timeout(各期同口径)。

## 八、分析方法(V2:本期自洽诊断,不做跨技术栈对比)

**Node 已完全退出体系,分析报告(md 与 HTML)只专注本次压测数据本身做详细分析与诊断,禁止与 Node/socket.io 时代数据对比。**

### 8.1 分析框架

1. **本期自洽诊断**:所有结论从本期数据内部推导——分位分布形态、场景间交叉(吞吐 vs 延迟曲线、连接规模 vs 内存曲线)、轮间稳定性、尖峰定位。历史期(26-9-18 等)数据仅在"同架构上期对照"时可选引用,不构成报告主体。
2. **RTT 构成分解**:客户端 RTT(往返) ≈ `gateway_uplink_duration`(收帧→ack)+ 下行回投(`gateway_downlink_duration`)。用同场景两指标分位对照,定位延迟发生面(网关转发 vs biz 处理 vs DB vs 下行)。
3. **延迟-速率反相关检查**:低消息率场景(如 S2 2 msg/s、S4 1 msg/s)若 RTT 高于高吞吐场景,诊断为**空闲唤醒/冷缓存主导**(Go 调度 park/unpark、连接空闲后首帧唤醒、presence/成员查询冷 Redis/DB);高吞吐场景为**流水线饱和主导**。两种形态必须分开定性。
4. **拐点定位**:吞吐扫描档(tp_r10→r30)找 p99 超线性增长拐点,结合 `db_query_duration_seconds` 按 model 分线与 goroutine 峰值确认饱和面(写库/Redis/CPU);拐点档错误率仍为 0 时定性为"软排队而非拒绝"。
5. **内存剖面**:RSS 基线→峰值差、跨场景累积与 GC 回落(S6 结束档 vs 登录期峰值)、每连接成本(峰值增量/连接数)、goroutine/连接比。
6. **双副本视角**:`rate(server_message_in_total[1m]) by (job)` 分流均衡性;kill/failover 演练作为分布式健壮性证据(比性能数据更重要)。
7. **下行双通道视角**:direct/fallback 比例是定向下行健康度的核心证据;`gateway_downlink_duration` p99 支撑"下行不是延迟瓶颈"的结论。
8. **优化归因(仅当有代码改动时)**:若本轮压测前做了优化/代码改动,报告必须单独开设一节,针对改动点做"改动前行为假设 → 本期实测证据 → 影响面与收益/回归"的归因;无改动则明确声明"本轮无代码改动,为纯复测/监测闭环"。

### 8.2 深度报告必答清单(验收标准,逐条覆盖)

1. 每场景完整分位:p50/p95/p99/p999/min/max/n、发送/ack、错误分类(逐类)、重发帧数、重连次数。
2. 3 轮原始数据与中位选择;轮间波动幅度分析与高压档噪声定性(全部轮次零错误=健壮性)。
3. 场景间交叉诊断:①吞吐-RTT 曲线与拐点;②连接规模-RSS/goroutine 曲线与每连接成本;③延迟-速率反相关检查与定性(空闲唤醒 vs 流水线饱和)。
4. RTT 构成分解表(客户端 RTT vs 服务内直方图 p50/95/99 对照),指明延迟主导面。
5. 资源深度:双侧 RSS 基线→峰值、CPU Δ、goroutine、GC;S6 逐级爬坡表(建连分位/持有数/RSS/goroutine)与拐点。
6. DB 面证据:`db_query_duration_seconds` 按 model 分线(尖峰与 bucket 封顶注明);HTTP 端点逐一分位与最慢端点根因。
7. 监测面板证据:压测期间全面板截图 + Prometheus 查询值(downlink direct/fallback 比例、分流速率快照)。
8. 分布式演练四项记录与结论。
9. 遗留问题与下一批建议。
10. 测量诚实性声明(同机噪声前提、口径说明如 counter 重启清零)。

### 8.3 归因素材源

db_query_duration_seconds(按 model)、server_message_duration_seconds、gateway_uplink/downlink_duration_seconds、goroutine/GC、两侧 RSS/CPU(ps 采样,ab-run.mjs 自动落盘)、轮间 `*_rN.json`。

## 九、验收清单(交付前逐项打勾)

- [ ] 新 Grafana 面板 `realtime-system-authority.json` provision 成功,旧面板一字未动;压测期间全面板截图存档
- [ ] `prometheus.yml` 注释更新(server job 已 Go 化)+ biz2 抓取新增,三 target 全 up
- [ ] 冒烟:probe 通 + direct>0/fallback≈0 + harness 20×5×10 零错误
- [ ] 主跑批 11 场景 ×3 轮 + 专项(S6/S7/扇出/HTTP)全落盘(`<key>_gateway.json` + `_rN`)
- [ ] 分布式演练四项:分流/kill 零失败(红线)/恢复/下行比例
- [ ] md 报告:**只分析本期数据、无 Node 对比**;§8.2 深度必答清单 10 条逐条覆盖
- [ ] HTML 由 `gen-report-v2.mjs` 生成(单边深度),深色自检三样通过、图表有数据
- [ ] 如有代码改动:单独一节优化归因(改动假设→实测证据→影响面);无改动则明确声明纯复测
- [ ] 全部 commit,不推远端;旧期目录未被本期工具污染(git status 干净)

## 十、常用命令速查

```bash
# 单场景直跑(不落盘采样)
CONNS=100 RATE=10 DURATION=20 RAMP=25 node perf/harness-gw.mjs
# 单场景 + 资源采样落盘(推荐)
OUT_SUBDIR=<日期> node perf/ab-run.mjs gateway <label> [CONNS RATE DURATION RAMP]
# 指标速查
curl -s localhost:8090/metrics | grep -E '^gateway_(connections|uplink_total|downlink_total|evicted_total)'
curl -s localhost:3007/metrics | grep -E '^server_(message_in|message_out|downlink_(direct|fallback)|conversation_rate_limited)'
curl -s 'http://localhost:9090/api/v1/query?query=rate(server_message_in_total[1m])'   # Prometheus 查询
# 进程资源(macOS)
ps -o rss=,time= -p <pid>
# 查进程 env(行为与配置不符第一步)
ps eww <pid> | tr ' ' '\n' | grep -E '^(PORT|EDGE|CONV|AUTH|REPLICA)'
```

---

## 附:上期同架构数据(仅内部参照,不作为报告对比口径)

- 26-9-18(双副本+全优化,全 Go 同架构上期):11 场景全零错误;tp_r30 p99 61ms;S6 1 万连接 100%;kill 演练零失败。
- 分析报告只呈现本期数据;如需同架构上期参照,仅作一句提及,不构成对比主体。
