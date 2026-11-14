# talqora 网关与基础设施（`gateway/`）

> 范围：`gateway/`（无状态 Go 连接网关）、`biz` 侧的 gRPC edge 流与定向下行、`presence` 注册表、Prometheus/Grafana 基础设施。业务层 HTTP 缺陷见 [02-talqora业务层](./02-talqora业务层.md)，部署阻断见 [01-部署配置与密钥](./01-部署配置与密钥.md)。
>
> 证据来源：只读代码 + 实际执行（`go vet`、`go test`、`go test -race`）。既有 6 个测试包在 `-race` 下全绿——但下面的并发问题**都落在现有测试没有覆盖的路径上**（真实多副本、流重建、优雅关闭），所以「`-race` 通过」不能作为「无竞态」的证据。

## 0 一段话总评

网关的分层是清晰的：连接生命周期、背压、上行通道抽象、下行路由各占一个包，`Conn` 的读写双 goroutine + 有界 `send` channel 是标准做法，`gRPC` 流替代 HTTP 单消息也有明确收益（`gateway_uplink_duration_seconds` 从每消息一次 RTT 变成流内异步确认）。

问题集中在**并发所有权**这一个点上：同一条 gRPC 流会被多个 goroutine 同时 `Send`——上行 `forward` 在锁外写、`send`（断连通知）在锁内写、`biz` 侧的 `tryDirectDownlink` 也是锁外写——而 grpc-go 明确要求「同一条流的 `SendMsg` 不能在多个 goroutine 里并发调用」。代码里有一行注释断言「grpc-go 保证 SendMsg 并发安全」，这个断言是错的，而且它正好出现在唯一一处锁外 `Send` 的上方。

第二个问题在优雅关闭：`ShutdownAll` 只写一个 1012 close 帧就返回，既不等待 `send` 缓冲排空，compose 里也没有 `stop_grace_period`（Docker 默认 10 秒后 SIGKILL，而 Go 侧 shutdown 超时也是 10 秒）。校招计划「交付」模块的验收标准是「滚动发布期间消息零丢失」，按当前实现达不到。

第三个问题在可观测性：13 个指标、**没有链路追踪、没有一条告警规则**（`docker/monitoring/prometheus.yml` 只有 `scrape_configs`，无 `rule_files`/`alerting`）。Grafana 有两块看板，但没人会在半夜看板子——「看得见能恢复」这条证据线目前是空的。

## 1 问题清单

### 严重

#### GW-S1 同一条 gRPC 流被多个 goroutine 并发 `Send`（已核实）

**现象。** 三处代码都在没有互斥的情况下对同一条 `Realtime_StreamClient` 调用 `Send`：

| 位置 | 调用 | 是否持锁 |
|---|---|---|
| `gateway/internal/upstream/grpc.go:186` | `stream.Send(uf)`（每条上行消息） | **否**（锁在 `:167` 已释放） |
| `gateway/internal/upstream/grpc.go:194-197` | `send()`：`s.mu.Lock(); defer Unlock; s.stream.Send(f)` | 是 |
| `biz/internal/realtime/directdownlink.go:66` | `stream.Send(&edgev1.EdgeFrame{...})` | **否**（锁在 `:64` 已释放） |

而 `grpc.go:185` 上方的注释写的是：

```185:186:gateway/internal/upstream/grpc.go
// grpc-go 保证 SendMsg 并发安全;同用户帧顺序由服务端 seq 发号保证,上行乱序无害(方案文档 §4.4)。
if err := stream.Send(uf); err != nil {
```

**原理。** grpc-go 的 `ClientStream.SendMsg` 文档明确：可以在一个 goroutine 里 `SendMsg`、另一个 goroutine 里 `RecvMsg`，但**不允许在两个 goroutine 里同时 `SendMsg`**。这不是性能建议，是实现前提——底层 `transport.Stream` 的写入不保证帧的完整性与顺序，并发写会导致数据竞争或 `transport: SendMsg called after CloseSend` 一类的错误。

具体触发路径：

1. **上行内部并发**：`Conn.dispatchConcurrent`（`gateway/internal/hub/conn.go:198-223`）为每帧起一个 goroutine，每连接上限 64。同一用户的多条消息按 `userId % len(streams)` 落到**同一条流**，因此这 64 个 goroutine 会并发 `Send`。这不是罕见角落——一个用户连续发消息就会命中。
2. **上行与断连通知并发**：`Conn.close()`（`conn.go:90-92`）调 `upstream.NotifyDisconnect`，它与 `forward` 并发。
3. **上行与下行并发**：`biz` 的 `tryDirectDownlink` 在 `FanoutDownlink` 里被多个消息处理 goroutine 并发调用，锁只保护了「选哪条流」，不保护 `Send` 本身。

**后果。** 轻则单条帧写坏、业务层收到畸形 protobuf；重则整个 `ClientConn` 进入 `TRANSIENT_FAILURE`，`recvLoop` 判流断 → `failAll()` 拒绝该分片全部在途请求 → 该分片所有用户的在途消息全部报错。一个用户的高频发送可以影响同分片的其它用户（哈希分片把不同用户绑在同一条流上）。

**修复（三处都要改）。**

1. `forward`：把 `stream.Send` 移进 `s.mu` 临界区。为了不把网络写放在锁里太久，正确做法是引入**单写者**：每分片一个 `sendCh chan *EdgeFrame` + 一个专职写 goroutine，`forward` 只负责入队（有界，满则返回错误）。这样顺序也顺便被保证。
2. `send()`：同样改为入队，与 `forward` 共用写者。
3. `biz` 侧 `tryDirectDownlink`：给 `replicaEntry` 加一把「写锁」，或者给每个 stream 包一层带 `sync.Mutex` 的发送器。**注意**：`biz` 侧同一个 stream 也被 gRPC 框架自己的 `Send` 用于… 实际上 `biz` 是服务端，`stream.Send` 由业务 goroutine 调用，因此同样需要单写者。

**验证。** 写一个 `-race` 用例：对同一 `streamShard` 并发调用 100 次 `forward`，配合一个 fake `Realtime_StreamClient`（`Send` 里 `time.Sleep(1ms)` 并写共享计数器）；修复前 race detector 会直接报错，修复后无告警且帧序单调。

### 重要

#### GW-I1 `deliverAck` 与 `failAll` 之间存在「向已关闭 channel 发送」的 panic 窗口（已核实）

**证据。**

```264:275:gateway/internal/upstream/grpc.go
func (s *streamShard) deliverAck(ack *edgev1.UplinkAck) {
	key := fmt.Sprintf("%d:%s", ack.UserId, ack.ClientMsgId)
	s.mu.Lock()
	ch := s.pending[key]
	s.mu.Unlock()
	if ch != nil {
		select {
		case ch <- ack:
		default:
		}
	}
}
```

```278:286:gateway/internal/upstream/grpc.go
func (s *streamShard) failAll() {
	s.mu.Lock()
	pending := s.pending
	s.pending = make(map[string]chan *edgev1.UplinkAck)
	s.mu.Unlock()
	for _, ch := range pending {
		close(ch)
	}
}
```

**原理。** `deliverAck` 在 `:268` 释放锁之后、`:271` 实际发送之前有一个窗口。如果此时另一个 goroutine 执行 `failAll`，把它刚取出的那个 `ch` 关掉了，那么 `ch <- ack` 会命中**已关闭的 channel**——`select` 的 `default` 分支并不能防止这一点：向已关闭 channel 发送是**立即 panic**，不是阻塞。

`failAll` 的两个调用点是 `recvLoop`（`grpc.go:229`，流断时）和 `shutdown()`（`:293`，`Close()` 路径）。前者与 `deliverAck` 同 goroutine（安全），后者来自 `main` 的退出路径（**不同 goroutine → 真实竞态**）。

**后果。** 网关进程在优雅退出时 panic。panic 发生在 `Close()` 期间，此时 `main` 已经在收尾，栈会被打印但进程可能以非零码退出——部署脚本把这当成部署失败，触发不必要的回滚。

**修复。** 不要 `close(ch)`。`failAll` 改为向每个 channel 投一个「哨兵值」（例如 `&UplinkAck{Ok:false, Error:"上行流中断"}`，`forward` 的 `<-ch` 分支已经在检查 `ack == nil`，可以复用该语义）并保留 `buffer=1`。channel 由 GC 回收，无需显式关闭。

#### GW-I2 presence 摘除与新连接登记存在竞态，且 `meta` 丢失后无法自愈（已核实）

**证据。**

- `gateway/internal/hub/conn.go:85-88`：`close()` 内 `presence.Remove(userID, deviceID)`，会同时 `ZREM presence:{uid}` 与 `HDEL presence:{uid}:meta`（`gateway/internal/presence/presence.go:49-55`）。
- `gateway/internal/hub/hub.go:86-92`：`NewConn` 先替换 map 条目，再 `old.close()`（同步调用），之后 `ws/server.go:116` 才 `presence.Register`。**这条路径是安全的**——先删后登记。
- 但还有第二条路径：旧连接的 `readLoop` 因网络错误退出（`conn.go:106` 的 `return` → `defer c.close()`），与新连接握手**并发**。此时 `close()` 的 `Remove` 可能落在新连接 `Register` 之后。

**原理。** 心跳续约只补 ZSET，不补 meta：

```43:46:gateway/internal/presence/presence.go
func (r *Registry) Refresh(ctx context.Context, userID int64, deviceID string) error {
	return r.rdb.ZAdd(ctx, zkey(userID), redis.Z{Score: r.expireAt(), Member: deviceID}).Err()
}
```

所以一旦 meta 被误删，`presence:{uid}:meta` 里那条 `{replica}:{socketId}` 映射就**永久消失**，直到客户端重新建连。

**后果（不是消息丢失，是路由退化 + 通话失效）。**

1. `biz` 的 `ReplicaOf` 读不到 meta → 返回 `""` → `PublishDownlink` 退化为 Redis pub/sub 全副本广播（`service/downlink.go:51-88`）。功能仍然正确，但「定向下行占比 99.9998%」这个已对外宣称的数字会掉。
2. 更严重的是 `GetDevices`（`service/presence.go:79-104`）：它用 `HMGet` 逐个解析 meta，**解析不出来就 `continue` 静默跳过**。于是这台「在线但无 meta」的设备对 `call:rejoin` 的属主路由不可见 → 通话重连时找不到连接所在副本 → `perf/call-rejoin-probe.mjs` 覆盖的正是这条链路。

**修复。** 两种改法任选一种，推荐第一种：

1. **`Remove` 加身份校验**：把 `socketID` 也传进去，用 Lua 做「仅当 meta 值等于本次 socket 时才删除」的原子比较删除。`NewConn` 已经有 `socketID`，改造成本很低。
2. `Refresh` 顺带 `HSET` 回写 meta（幂等），让误删在一个心跳周期内自愈。

#### GW-I3 连接配额校验在协议升级之后，且每次建连都要 O(用户数) 全表扫描（已核实）

**证据。**

- `gateway/internal/ws/server.go:93` 先 `h.upgrader.Upgrade(w, r, nil)`，`:105` 才 `h.hub.NewConn(...)` 判配额。配额不足时的处理是**升级成功之后**再写 close 帧（`:108-110`）。
- `gateway/internal/hub/hub.go:77`：`if h.countLocked() >= h.maxConns`。
- `gateway/internal/hub/hub.go:150-156`：`countLocked` 遍历 `h.conns`（`map[int64]map[string]*Conn`）累加。

**原理与后果。**

- **顺序问题**：达到上限后，攻击者仍能完成 HTTP 101 升级（消耗一个 fd、一段读写缓冲、两个 goroutine 的栈）再被踢掉。每次都是一个完整的握手 + close 周期。`maxConns` 越大，这段浪费越大。
- **复杂度问题**：`countLocked` 是 `O(用户数)`。5 万连接（`GATEWAY_MAX_CONNS` 默认 50000）时，**每建立一条新连接都要遍历 5 万个 map 条目**。这在爬坡压测里会直接体现为「建连 QPS 上不去」，而且 `h.mu` 是写锁——它同时阻塞所有 `RouteToUser`（`hub.go:120-133` 用 `RLock`）。

**修复。** 加一个 `atomic.Int64` 计数器（`NewConn` 成功时 `Add(1)`、`close()` 里 `Add(-1)`，`metrics.Connections` 已经是同一个语义，可以直接复用 `prometheus` gauge 的值或用独立 atomic）；把配额检查提到 `Upgrade` 之前（`server.go:93` 之前先判一次，`NewConn` 里再判一次作为兜底，因为两次判断之间可能被并发插入）。

#### GW-I4 优雅关闭不排空，滚动发布会丢在途消息（已核实）

**证据。**

- `gateway/cmd/gateway/main.go:139-146`：`ShutdownAll`（写 1012 close 帧）→ `srv.Shutdown(10s)` → 关 gRPC、关 Redis → 退出。
- `ShutdownAll`（`hub/hub.go:161-176`）只调 `WriteControl` 发 close 帧，**不等待**任何 `Conn.send` 缓冲排空，也不调用 `c.close()`。
- `docker/docker-compose.prod.yml` 的 gateway 服务没有 `stop_grace_period`，Docker 默认 10 秒后 SIGKILL；Go 侧 shutdown 超时同样 10 秒。两者撞在同一时刻。
- `http.Server.Shutdown` 不跟踪 hijacked 连接（WebSocket 就是 hijacked），所以它对 WS 连接**不做任何等待**，会立刻返回。

**原理。** 一条已经落库、已 `PUBLISH`、已 `enqueue` 进 `Conn.send` 但还没被 `writeLoop` 写出的消息，在进程退出时直接消失。客户端收到的是 1012 close 帧，会重连并按 `seq` 补拉——**所以不会真的丢**，但会多一次往返，且在这段时间里消息不可见。校招计划交付模块的验收标准是「滚动发布期间消息零丢失、重连成功率 ≥ 99.9%」——「不丢但要补拉」和「零丢失」是两个说法。

**修复。**

1. `ShutdownAll` 改为「写 close 帧 → 等待所有 `Conn.send` 排空（带超时，比如 5s）→ 再返回」；`writeLoop` 需要一个 `drained` 信号。
2. compose 加 `stop_grace_period: 30s`，Go 侧 shutdown 超时降到 20s，留出余量。
3. 真正的 k8s 场景用 `preStop` + `terminationGracePeriodSeconds`（校招计划交付模块要做的事，但 Compose 下先把前两条做对）。

#### GW-I5 `biz` 的 edge 流每帧起一个 goroutine，没有并发上限（已核实）

**证据。** `biz/internal/realtime/edge.go:110-124`：

```119:123:biz/internal/realtime/edge.go
go func(f *edgev1.EdgeFrame) {
    if err := processFrame(stream, f, s); err != nil {
        s.logger.Error("gRPC 上行帧处理异常", "err", err)
    }
}(frame)
```

**原理。** 网关侧有 64 的每连接 in-flight 上限（`hub/conn.go:43`），但那是**客户端连接**维度，而且是网关自己的实现。业务层这一侧接受的是「一个网关副本 → 一条流」，一条流后面挂着成千上万个客户端连接。64 × 连接数 的上限在流这一层不存在。如果网关被攻破或自己出 bug（例如 GW-S1 导致帧重复），业务层会无界起 goroutine。

**后果。** 内存与 goroutine 数随负载非线性上升；`runtime.NumGoroutine()` 会成为 OOM 前的最后信号。当前压测（`perf/gw-*`）没有覆盖「单流打满」这个场景。

**修复。** 给每条流加一个有界 worker pool（例如 32 个 worker + 有界队列 1024），队列满时向该帧回 `message.error`（背压），而不是无限起 goroutine。同时把 worker 队列深度暴露成 Prometheus gauge。

#### GW-I6 可观测性只有指标，没有追踪、没有告警、没有 SLO（已核实）

**证据。**

| 项 | 现状 |
|---|---|
| 网关指标 | 7 个：`gateway_connections`、`gateway_handshakes_total`、`gateway_uplink_total`、`gateway_downlink_total`、`gateway_evicted_total`、两个 duration 直方图（`gateway/internal/metrics/metrics.go`） |
| 业务层指标 | 15 个（`biz/internal/metrics/metrics.go:15-96`） |
| 链路追踪 | **无**。全仓搜不到 `opentelemetry`/`otel`/`jaeger`/`tempo`/`trace_id` 的任何引用 |
| 告警规则 | **无**。`docker/monitoring/prometheus.yml` 只有 `global` + `scrape_configs`，没有 `rule_files`，也没有 `alerting` |
| SLO | **无**。没有任何地方定义「消息发送成功率」的目标值 |
| Grafana | 两块看板：`realtime-node-vs-go.json`、`realtime-system-authority.json` |

**原理。** 指标能回答「现在怎么样」，追踪才能回答「这一条为什么慢/为什么错」。当前一个用户报「消息发不出去」，排查路径是：看 Grafana 有没有异常 → 没有 → SSH 上机翻 `docker logs` → 在网关和业务层两份日志里靠 `userId` 手工拼接。没有 `requestId`/`traceId` 贯穿，就没有「1 分钟内定位全链路」的可能。

**后果。** 校招计划证据线三（「看得见、能恢复」）的三件产出——链路追踪、SLO + 燃烧率告警、故障演练——目前**一件都没有**。这是四个证据线里完成度最低的一条，也是最容易被面试官追问「你怎么知道它没坏」的地方。

**修复（按性价比排序）。**

1. **一次请求一个 traceID（半天）**：网关握手时生成 `reqId`，放进 `UplinkFrame` 的 metadata 透传到 `biz`，两侧日志都带上。这一步不需要引入 OTel，就能把「人工拼接」变成「一次 grep」。
2. **告警规则（半天）**：先只做四条——`gateway_uplink_total{result="upstream_error"}` 错误率、`server_message_duration_seconds` p99、`gateway_evicted_total` 增速、`up == 0`。写到 `docker/monitoring/rules/*.yml` 并在 `prometheus.yml` 里 `rule_files` 引用。
3. **SLO + 燃烧率（一天）**：定义「消息发送成功率 = `message_out_total{result="ok"} / message_in_total`」，目标 99.9%，双窗口（1h/5min）燃烧率。这部分正是校招计划 E7 要做的内容，现在先把指标口径澄清（见 BZ-I5 里说的分母失真问题）。

### 一般

| 编号 | 问题 | 证据 | 修复 |
|---|---|---|---|
| GW-N1 | `readLoop` 阻塞在 `c.sem <- struct{}{}` 时连接关闭，该 goroutine 要等在途请求超时（≤10s）才退出 | `hub/conn.go:196` | 入队前先 `select` 判 `closed`；或把 `sem` 换成带 ctx 的选择 |
| GW-N2 | `errorFrame` 的 `json.Marshal` 错误被 `_` 丢弃；`enqueue` 返回 false（慢消费者）时错误帧本身也丢失 | `hub/conn.go:216、251-260` | Marshal 用固定字面量模板避免错误；`enqueue` 失败时至少 `metrics.Downlink{evicted}` 已计数，补一条日志 |
| GW-N3 | `http.Server` 没有 `ReadHeaderTimeout`/`ReadTimeout`/`WriteTimeout` | `cmd/gateway/main.go:125` | 加 `ReadHeaderTimeout: 10s`（防慢速握手）；WS 连接不受这些超时影响，安全 |

## 2 整改顺序

| 顺序 | 事项 | 关联 | 工时 |
|---|---|---|---|
| 1 | gRPC 流改「单写者 + 有界队列」，三处 `Send` 全部收口 | GW-S1 | 3h |
| 2 | `failAll` 改哨兵值，不再 `close(ch)` | GW-I1 | 0.5h |
| 3 | `presence.Remove` 加 socketID 比较删除（Lua） | GW-I2 | 1.5h |
| 4 | 配额前置 + atomic 计数器替代 `countLocked` | GW-I3 | 1h |
| 5 | `ShutdownAll` 排空 + `stop_grace_period` | GW-I4 | 2h |
| 6 | 每条 edge 流加有界 worker pool | GW-I5 | 2h |
| 7 | traceID 贯穿 + 4 条告警规则 | GW-I6 | 8h |
| 8 | 一般项 | GW-N1–N3 | 1h |

第 1–2 项是同一个改动，做完之后 GW-S1 与 GW-I1 一起关掉。第 7 项对应校招计划证据线三的「链路追踪与 SLO」，工时已经与计划中的 8 小时对齐。

## ★ 关键理解点

- **正向：并发的正确性由「所有权」决定，不由「有没有加锁」决定。** `stream.Send` 三处调用里两处「加锁了」、一处没加，看起来是「有一处疏忽」。但真正的判据是「谁拥有这条流的写权限」——现在是三个 goroutine 共享所有权，所以即使三处都加锁，两次独立的 `Send` 之间仍可能交错（锁保护的是临界区，不是顺序）。改成单写者之后，「并发写」这件事在结构上不再存在。
- **反向：`select` + `default` 不是「安全发送」的通用写法。** 它只处理「发送会阻塞」，不处理「channel 已关闭」。对已关闭 channel 的发送是 panic，无法被 `select` 拦住。所以「用 `close(ch)` 广播取消」这条惯用法，要求接收方**只读不写**；一旦存在并发写者，就必须改用哨兵值。
- **边界：优雅关闭的边界是「缓冲区」，不是「连接」。** 大家容易关注「有没有通知客户端」，但真正决定丢不丢消息的是「`send` channel 里还有没有东西」。`ShutdownAll` 通知了客户端，却没管缓冲区；客户端看起来很优雅地重连了，消息却在服务端消失了。
- **对比：指标 vs 追踪。** 指标是聚合，能告诉你「p99 变差了」；追踪是单点，能告诉你「这一条卡在哪一跳」。只有指标时，排查是「猜测 + 缩小范围」；有追踪时，排查是「打开这一条」。这也解释了为什么「有 Grafana 看板」和「看得见」是两回事。
