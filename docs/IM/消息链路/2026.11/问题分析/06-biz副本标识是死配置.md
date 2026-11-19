# 问题 06：biz 的 `REPLICA_ID` 是死配置

> 严重度：**P3（可维护性 / 误导）**——不影响运行，但会浪费排障时间，且掩盖了一个真实风险
> 状态：已确证（定义 + 赋值，零使用）
> 关联：[方向 J · 横向扩容](../10-横向扩容与连接池代理.md)

---

## 一、一句话结论

`biz` 的 `REPLICA_ID` 只被读取进 `Config` 结构体，**全仓没有任何地方使用它**。而"副本标识"在系统里是一个真实存在且关键的概念——只不过它属于 **gateway**（写进 `presence` 的 `"{replica}:{socketId}"`）。两处同名配置并存，会让人误以为 biz 的副本号参与下行路由，从而在排查"消息投错副本"时走错方向。

---

## 二、证据

### 2.1 只有定义与赋值

```bash
$ grep -rn "ReplicaID" biz/internal biz/cmd
biz/internal/config/config.go:65:	ReplicaID           string
biz/internal/config/config.go:112:		ReplicaID:       envOr("REPLICA_ID", host),
```

两处，**没有任何读取**。`main.go` 也没有把它塞进 logger / metrics / 任何依赖。

### 2.2 真正的副本标识在 gateway

`gateway/internal/presence/presence.go:36-42`：

```go
func (r *Registry) Register(ctx context.Context, userID int64, deviceID, socketID string) error {
    pipe := r.rdb.TxPipeline()
    pipe.ZAdd(ctx, zkey(userID), redis.Z{Score: r.expireAt(), Member: deviceID})
    pipe.HSet(ctx, mkey(userID), deviceID, r.replica+":"+socketID)   // ← replica 写进 presence
    ...
}
```

`r.replica` 来自 `GATEWAY_REPLICA_ID`（`gateway/internal/config/config.go:67`），默认 `gw-<hostname>`。

### 2.3 代码里已经警告过"共用 .env 会串号"

`gateway/internal/config/config.go:65-67` 的注释：

```go
// 独立于 biz 的 REPLICA_ID:两者共用一份 .env(dev)时,网关会误用业务层副本号,
// 多网关副本下会互相覆盖 presence:meta,导致定向下行路由到错误副本。
ReplicaID: envOr("GATEWAY_REPLICA_ID", "gw-"+host),
```

这段注释说明：**有人曾因为"以为 biz 的 REPLICA_ID 是网关副本号"而踩过坑**。既然 biz 侧根本不用它，这个坑完全可以靠删掉它来消除。

---

## 三、影响

| 维度 | 影响 |
|---|---|
| 排障 | 日志里没有副本标识，多副本时无法判断"这条 500 是哪个副本返回的"；而 `REPLICA_ID` 明明已经读进来了 |
| 部署 | 运维会以为"每个 biz 副本必须配不同的 REPLICA_ID"，配错也不报错（因为没人用） |
| 契约混淆 | 与 `GATEWAY_REPLICA_ID` 同名不同义，.env 共用时极易串号 |
| 容量规划 | `presence.replica` 的取值集合决定了"下行能投几个副本"，与 biz 副本数无关；混淆会导致对拓扑的错误理解 |

**无害但危险**：它不会引发故障，但会让"我配了 biz-1/biz-2"给人一种"副本已就位"的错觉。

---

## 四、根因

### 4.1 历史沿革

这个名字大概率是从 Node 版本继承的（当时的进程可能确实用 `REPLICA_ID` 标记自己），迁移到 Go 后，**presence 写入被整体搬到了 gateway**，biz 侧的标识就失去了用途，但配置项留了下来。

### 4.2 缺少"配置项是否被使用"的检查

一个配置项从"有用"变成"死代码"时，没有任何机制提示。这类问题会持续累积（`REPLICA_ID` 只是其中一个，`Registry.Replica` 之类同理）。

---

## 五、方案

### 5.1 方案 A：删除（最干净）

```go
// config.go
- ReplicaID string
- ReplicaID: envOr("REPLICA_ID", host),
```

- 优点：消除误解，减少一个必须配的变量；
- 缺点：如果将来想做"按副本排查"，又要加回来。

**注意**：删除前先确认部署脚本/文档没有依赖它（`README.md`、`docker/`、`Makefile` 都写了 `REPLICA_ID=biz-1`，需要同步清理或保留为"仅日志用"）。

### 5.2 方案 B：接上，但只用于诊断（推荐）

保留配置，把它变成"可观测性字段"：

```go
// main.go
logger = logger.With("replica", cfg.ReplicaID)

// /health 返回
{"status":"ok","replica":cfg.ReplicaID,"uptime":...}

// 关键指标加 label（副本数有限，基数可控）
metrics.MessageInTotal.WithLabelValues(cfg.ReplicaID)
```

- 优点：多副本排障立刻有了抓手；也顺带让"配了不同值"变得有意义；
- 缺点：给所有指标加 label 会增加改动面，**建议只给 2–3 个核心指标加**（消息量、错误数、goroutine 数）。

### 5.3 不要做的三件事

| 想法 | 为什么不行 |
|---|---|
| 把 `cfg.ReplicaID` 写进 `presence` | `presence` 的 replica 决定"去哪台网关投递"，必须是**网关**的标识。写 biz 的会导致所有下行路由到不存在的副本 |
| 用它做「同一用户粘在同一 biz」的分片 | biz 是无状态的，且上行分片由 gateway 的 `userId % N` 决定（`multi.go:39`），biz 侧不知道也不需要知道 |
| 用它做幂等键的一部分 | 幂等键是 `(conv, sender, clientMsgId)`，跨副本共享，加副本号会破坏幂等 |

---

## 六、坑点

### 坑 1：`.env` 共用导致的串号是真实故障

dev 环境常把 biz 与 gateway 的变量写进同一个 `.env`。如果 gateway 读的是 `REPLICA_ID`（而不是 `GATEWAY_REPLICA_ID`），两个网关副本会同时拿到 `biz-1`：

```
gw-A: HSET presence:U:meta device1 "biz-1:sockA"
gw-B: HSET presence:U:meta device1 "biz-1:sockB"   ← 覆盖
biz  : 查 replica = "biz-1" → 在 replicaStreams 里找不到 "biz-1" → 全部走 fallback
```

表现是"直发命中率突然掉到 0"，但服务看起来一切正常。**这也是保留 `GATEWAY_REPLICA_ID` 独立命名的唯一理由**，删 biz 的 `REPLICA_ID` 后这个风险自然消失。

### 坑 2：删配置要同步改文档与编排

`README.md` 的启动示例、`docker/` 的 compose、`Makefile` 的 dev 脚本都传了 `REPLICA_ID=biz-1/biz-2`。只删代码不删这些，会留下一堆"传了但没用"的参数，比原来更难懂。

### 坑 3：如果选方案 B，注意 label 基数

副本数是个位数，加 label 安全。但**不要**把 `hostname`（容器重建会变）当 label——会导致 Prometheus series 无限增长。用配置里的稳定值。

---

## 七、验证

| 项 | 方法 | 通过标准 |
|---|---|---|
| 死配置确认 | `grep -rn "ReplicaID" biz/` | 只有定义与赋值（方案 A 后为 0 处） |
| 方案 B 生效 | 起两个副本，分别请求 `/health` | 返回各自不同的 `replica` 字段 |
| 日志可区分 | 两个副本的日志 | 每条都带 `replica` 字段 |
| presence 未被污染 | `HGETALL presence:{uid}:meta` | 值形如 `gw-1:xxxx`，不出现 `biz-1` |

---

## 八、关联

| 文档 | 关系 |
|---|---|
| [方向 J · 横向扩容](../10-横向扩容与连接池代理.md) | 多副本部署时，副本标识的真实归属（gateway）与诊断价值（biz）都要讲清楚 |
| [问题 04 · 缺投递回执](./04-定向下行缺投递回执.md) | 两者都会让"投错副本"难以归因，建议一起做诊断增强 |
