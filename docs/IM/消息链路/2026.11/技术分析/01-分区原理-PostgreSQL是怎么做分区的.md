# 01 · 分区原理：PostgreSQL 是怎么把一张表变成 64 张的

> 本文只讲**分区**（partitioning）：数据库内部切表。
> 目标：读完能回答四个问题——① 分区表在磁盘和系统目录里长什么样？② `INSERT` 时谁决定这一行去哪个子表？③ `SELECT` 时怎么做到只扫一片？④ 为什么分了区，写入吞吐一点没涨？

---

## 一、先看"表"在 PG 里到底是什么

要理解分区，先要理解**不分区**的表是什么。

### 1.1 一张表 = 一个目录条目 + 一组物理文件

```sql
CREATE TABLE messages (id bigserial, conversation_id text, ...);
```

PG 内部发生的事：

| 层 | 实体 | 说明 |
|---|---|---|
| 系统目录 | `pg_class` 一行 | 记录表名、列数、`relkind='r'`（普通表）、`relfilenode`（物理文件名） |
| 系统目录 | `pg_attribute` 若干行 | 每一列一行（名字、类型、编号） |
| 系统目录 | `pg_type` 一行 | 这个表的复合类型（每一行也是一个值） |
| 物理存储 | `base/<dboid>/<relfilenode>` | **堆文件**（heap），按 8 KB 页组织 |
| 物理存储 | `base/<dboid>/<index_relfilenode>` | 每个索引一个文件（B-tree） |
| 辅助 | `pg_class.relfrozenxid`、`pg_statistic` | MVCC 年龄、统计信息 |

关键点：**"表"在 PG 里不是"一个文件"，而是"一个目录条目 + 一组文件（堆 + N 个索引）"**。

### 1.2 行在文件里怎么放

```
堆文件 = [页0][页1][页2]...
页     = [页头 24B][行指针数组][空闲空间][元组...]
元组   = [xmin][xmax][ctid 相关字段][列数据...]
```

一行数据的位置由 `ctid = (页号, 行指针序号)` 定位。B-tree 索引的叶子存的是 `(索引键, ctid)`——**所以索引指向的是"哪一页的哪一行"，而不是主键值**。

这是后面所有讨论的基础：**索引与堆是"一对一绑定"的**，你把堆拆成 64 份，索引也必须跟着拆成 64 份。

---

## 二、分区表在系统目录里长什么样

### 2.1 三种 relkind

| 对象 | `relkind` | `relfilenode` | 有数据吗 |
|---|---|---|---|
| 分区**父表**（`messages`） | `'p'`（partitioned table） | **0** | ❌ 没有自己的堆文件 |
| 分区**子表**（`messages_p00`） | `'r'`（普通表） | 各自一个 | ✅ 数据都在这里 |
| 普通表 | `'r'` | 一个 | ✅ |

**父表不存数据**——它只是一个"逻辑入口 + 分区规则 + 约束"的载体。你 `SELECT * FROM messages` 时，执行器展开成对 64 个子表的扫描。

### 2.2 关键系统目录

| 目录 | 存什么 |
|---|---|
| `pg_class` | 父表与每个子表各一行 |
| `pg_inherits` | 父子关系（`inhparent=父表oid`, `inhrelid=子表oid`, `inhseqno`） |
| `pg_partitioned_table` | 分区策略：`partstrat='h'`（hash）/`'l'`（list）/`'r'`（range）、`partnatts`（键列数）、`partattrs`（键列号）、`partclass`（操作符类） |
| `pg_class.relpartbound` | 每个子表的**分区边界**定义（hash 分区是 `(MODULUS 64, REMAINDER n)`） |
| `pg_class.relpartcheck`（内部） | 子表的**分区约束**表达式，hash 分区是 `satisfies_hash_partition(...)` |

`\d+ messages` 看到的 `Partition key: HASH (conversation_id)` 就来自 `pg_partitioned_table`。

### 2.3 物理上其实是"64 套堆 + 64×N 套索引"

```
messages（relkind=p, relfilenode=0）
├── messages_p00（relkind=r）
│   ├── heap: base/16384/16xxx
│   ├── idx_messages_conv_seq
│   ├── idx_messages_conv_ts
│   ├── idx_messages_sender_ts
│   └── uniq_msg_idem
├── messages_p01
...
└── messages_p63
```

**注意：索引没有"全局版本"。** 每个子表各有一套索引文件。这一点直接推出后面 §5 的一个硬限制。

---

## 三、`INSERT` 时谁决定这行去哪（tuple routing）

这是分区最核心的机制，也是"为什么分区对写入几乎没有加速"的根源。

### 3.1 执行路径

```
ExecInsert(tuple)
  └─ 若有分区 → ExecFindPartition()
       ├─ 取出分区键的列值（conversation_id）
       ├─ compute_partition_hash_value()   ← 计算 64 位哈希
       ├─ index = hash % modulus            ← 0..63
       ├─ 在 PartitionDispatch 里查 boundinfo->indexes[index]
       ├─ 初始化该子表的 ResultRelInfo（缓存，首次较贵）
       └─ 返回子表
  └─ heap_insert(子表, tuple)               ← 真正的写入发生在子表
  └─ 对子表的每个索引 ExecInsertIndexTuples()
```

要点：

1. **哈希是在插入时算的**，每次插入都要算一次（微秒级，可忽略）；
2. **子表的 `ResultRelInfo` 会被缓存**（`es_result_relations` / `PartitionDirectory`），所以不是每次都重新打开表；
3. **真正的物理写入完全等价于"往一张普通表里插一行"**——分区只改变了目标表。

### 3.2 HASH 分区的哈希函数

PG 用的是内部扩展哈希：

```
hash = hash_combine64(hash_extended(kind, collation, value)) XOR HASH_PARTITION_SEED
partition = hash % modulus
```

| 细节 | 说明 |
|---|---|
| `HASH_PARTITION_SEED` | 固定常量 `0x7A5B22367996DCFD`，避免与应用层用的哈希函数重合 |
| 数据类型相关 | text 用 `hashtext` 系列，bigint 用 `hashint8` 系列 |
| 不是 `md5` / 不是 `crc32` | **所以应用层无法"猜"出某行在哪个分区，除非复刻这套函数** |

> 这就是为什么[分册 11 §3.1](../11-分库分片与Redis集群.md) 说"应用侧不要耦合 PG 的分区函数"：一旦你在应用里也写一套 `hash % 64`，两边就是两份实现，改分区数时必然对不上。

### 3.3 写入没有变快，只是写到了不同的文件

| 环节 | 不分区 | 分 64 区 |
|---|---|---|
| 算哈希 + 路由 | 无 | +微秒级 |
| `heap_insert` | 1 次 | 1 次（只是目标文件不同） |
| 索引插入 | 4 个索引 | 仍是 4 个（子表的） |
| **WAL 写入** | **1 份** | **仍是 1 份** ← 关键 |
| **fsync** | **每事务一次** | **仍是每事务一次** ← 关键 |
| buffer pool | 共享 | 共享 |

**分区不改变 WAL 与 fsync 的次数**，所以写入吞吐不变。它改变的是"数据与索引的分布"，从而影响：

- 单棵 B-tree 的高度与页分裂频率（更矮、更局部）；
- vacuum/analyze 的粒度；
- DDL 的影响面；
- 查询需要扫描的范围（裁剪时）。

---

## 四、`SELECT` 时怎么只扫一片（分区裁剪）

### 4.1 两个时机

| 时机 | 名称 | 能裁剪的条件 |
|---|---|---|
| **生成计划时** | plan-time pruning | 分区键条件是**常量**（字面量、`now()` 这类 stable 但在计划期可求值的） |
| **执行开始时** | exec-time / runtime pruning | 分区键条件里含**参数**（prepared statement 的 `$1`、nestloop 的内参） |

### 4.2 计划长什么样

```sql
EXPLAIN SELECT * FROM messages WHERE conversation_id = 'single_1_2';
```

能裁剪时：

```
Append  (cost=...)
  Subplans Removed: 63          ← 只看这一行就够了
  ->  Index Scan using messages_p37_conv_seq on messages_p37
        Index Cond: (conversation_id = 'single_1_2')
```

不能裁剪时：

```
Append
  ->  Index Scan on messages_p00 ...
  ->  Index Scan on messages_p01 ...
  ...（64 个）
```

`Subplans Removed` 这个数字就是"裁掉了多少片"。**这是判断裁剪是否生效的第一手证据。**

### 4.3 裁剪在内部是怎么做的

```
planner:
  prune_append_rel_partitions()
    └─ 对每个子表，用它的分区约束（relpartcheck / bound）与查询条件做矛盾判定
       ├─ 矛盾 → 从 Append 的子计划里删掉（plan-time 裁剪）
       └─ 不矛盾 → 保留
executor:
  ExecCreatePartitionPruneState()   ← 把分区描述、边界编译成可执行的裁剪结构
  ExecFindMatchingSubPlans()        ← 用实际参数值再裁一次（runtime 裁剪）
```

对 HASH 分区，`conversation_id = 'x'` 这种等值条件下，PG 可以直接算出 `hash('x') % 64 = 37`，于是**只保留第 37 号子表**——这是 O(1) 的裁剪，不需要逐个比较边界（这一点比 range 分区更快）。

### 4.4 什么时候裁剪会失效

| 情况 | 后果 |
|---|---|
| 条件里没有分区键（`WHERE sender_id = 5`） | 扫全部 64 片 |
| 分区键用了表达式（`WHERE lower(conversation_id) = 'x'`） | 除非建了对应表达式索引/分区键，否则无法裁剪 |
| 条件是多值集合（`= ANY($1)`） | 能裁到"命中的那些片"，但仍然是**多片扫描**；会话数越多，成本越接近线性（本项目 `lastMessages` 就是这种情况，52 ms 的来源不是"扫全表"，而是"N 个会话各一次索引扫描 + 归并"） |
| 类型不匹配导致隐式转换（`conversation_id = 123`） | 可能裁不掉 |

### 4.5 裁剪的收益上限

裁剪只减少**扫描的数据量**，不减少：

- 计划与执行器的初始化成本（分区越多，`Append` 节点与 prune state 越大）；
- 锁的数量；
- 连接数。

**分区数不是越多越好**：64 个是经验值（本项目的选择），上千个分区会让规划时间、relcache 内存、`pg_inherits` 遍历成本上升，而裁剪收益不增加。

---

## 五、索引与约束：为什么唯一索引必须含分区键

### 5.1 索引是"每个子表各一份"

```
messages_p00: (conv_seq), (conv_ts), (sender_ts), uniq_idem, PK(id, conv)
messages_p01: (conv_seq), (conv_ts), (sender_ts), uniq_idem, PK(id, conv)
...
```

**没有任何一个索引能跨越 64 个子表。** 这是物理事实：B-tree 叶子存的是 `(key, ctid)`，而 `ctid` 只在所属的堆文件里有意义。

### 5.2 由此推出：唯一约束只能是"分区内唯一"

如果 `UNIQUE(seq)` 建在父表上，PG 只能保证"每个子表内 seq 唯一"——两个不同的会话如果哈希到不同分区，可以各自有 `seq=1`。这在业务上是错的，在 PG 看来是"合法"的。

所以 PG 强制：**分区表上的唯一约束/主键必须包含所有分区键列**。

```sql
-- ✅ 合法：包含分区键 conversation_id
UNIQUE (conversation_id, seq)

-- ❌ 报错：没有包含分区键
UNIQUE (seq)
```

同理，`PRIMARY KEY` 也必须含分区键——本项目用 `PRIMARY KEY (id, conversation_id)`（`migrations/0007:25`）就是为了满足这条。

### 5.3 为什么"分区内唯一"在本项目恰好够用

我们要保证的不变量是"**同一个会话内 seq 唯一**"。而同一个会话必然哈希到同一个分区。所以：

```
UNIQUE (conversation_id, seq) 建在父表
  → PG 在每个子表建一个本地唯一索引
  → 因为同一 conversation_id 永远在同一分区，其所有 seq 都在同一棵索引里
  → 实际效果 = "会话内 seq 全局唯一"
```

**如果业务需要的是"全局 seq 唯一"（跨会话），分区表就做不到了**——那时只能靠发号器（Redis INCR）保证唯一，索引无法兜底。

### 5.4 `ON CONFLICT` 的仲裁目标

`INSERT ... ON CONFLICT (a,b,c) DO NOTHING` 要求 `(a,b,c)` 上有一个唯一索引作为仲裁。分区表上这个索引必须是"每个分区都有的本地唯一索引"，PG 会自动找对应的子索引。

这也解释了[问题 02](../问题分析/02-唯一索引缺冲突重试.md)：`ON CONFLICT ((conversation_id, sender_id, client_msg_id))` 只吸收**这个索引**的冲突；另一个唯一索引 `(conversation_id, seq)` 冲突时会**直接抛 23505**，不会被 `DO NOTHING` 吞掉。

---

## 六、锁、DDL 与维护

### 6.1 锁的粒度

| 操作 | 加锁对象 | 影响 |
|---|---|---|
| `SELECT/INSERT` | 子表（行级/页级） | 只影响命中的分区 |
| `ALTER TABLE messages_p07 ...` | 该子表 | **不阻塞其他分区** |
| `ALTER TABLE messages ...`（父表） | 父表 + **所有子表** | 阻塞全部 |
| `ATTACH/DETACH PARTITION` | 父表（旧版本 `ACCESS EXCLUSIVE`） | 阻塞全部写入 |

分区的一大实际收益就是这里：**DDL 与维护可以按分区做**，把"一次锁全表"变成"64 次锁一片"。

### 6.2 vacuum / analyze 也是按分区

- 每个子表有自己的 `relfrozenxid`、自己的 autovacuum 任务；
- 分区越多，autovacuum worker 越多（受 `autovacuum_max_workers` 限制），可能出现"某些分区长期轮不到"；
- `ANALYZE` 也是按分区采样——**分区越多，单分区的统计信息越容易失真**（尤其数据倾斜时）。

### 6.3 冷热分层的真正价值

如果分区键是**时间**（range 分区），可以做到：

```sql
-- 一条 DDL 删掉一个月的数据，不产生 dead tuple、不需要 vacuum
DROP TABLE messages_2025_10;
-- 或者把老分区挪到慢盘
ALTER TABLE messages_2025_10 SET TABLESPACE slow_disk;
```

**这是分区最有价值的场景之一**，但前提是分区键与"生命周期"对齐。本项目按 `conversation_id` 哈希分区，**没有这个能力**（想删某个时间段的数据，必须逐分区 `DELETE`）。

---

## 七、分区到底解决了什么、没解决什么

### 7.1 解决

| 收益 | 机制 |
|---|---|
| 等值查询只扫一片 | 分区裁剪（O(1) 算 hash） |
| 单表/单索引不再无限膨胀 | 数据分散到 64 套堆与索引 |
| DDL 与维护可按片做 | 锁粒度降到子表 |
| 冷热分层/快速删除（range 分区） | `DROP PARTITION` / `SET TABLESPACE` |
| 并行度 | `enable_partitionwise_join/aggregate` 可让不同分区并行处理 |

### 7.2 不解决

| 以为能解决 | 实际 |
|---|---|
| **写入吞吐** | ❌ WAL 与 fsync 只有一份 |
| **磁盘 IOPS** | ❌ 同一块盘 |
| **连接数上限** | ❌ `max_connections` 是整个实例的 |
| **跨分区唯一性** | ❌ 没有全局索引，只能靠"分区键含在唯一索引里"来变通 |
| **跨分区事务** | ⚠️ 同一实例内仍是本地事务（这点比分库好），但**没有分布式事务能力** |
| **热点会话** | ❌ 单个超热会话永远落在一个分区，分区帮不上 |

---

## 八、本项目的具体形态（对照）

| 项 | 值 | 在本文里的位置 |
|---|---|---|
| 策略 | `PARTITION BY HASH (conversation_id)` | §3.2 |
| 分区数 | 64（`messages_p00..p63`） | §4.5 |
| 主键 | `(id, conversation_id)` | §5.2 |
| 唯一索引 | `(conversation_id, sender_id, client_msg_id)` | §5.2 / §5.3 |
| 热查询 | 全部带 `conversation_id` 等值 | §4.2 裁剪生效 |
| 无分区键的查询 | `lastMessages` 用 `ANY(...)` 多值 | §4.4 多片扫描 |
| 写入路径 | 每条消息一次 INSERT，路由到 1 个分区 | §3.3 |

**一句话总结本项目**：分区让"读写都只碰 1/64 的数据与索引"，但没有让"每秒能提交多少次事务"变多——后者由 WAL 与 fsync 决定，属于实例级资源。

---

## 九、常见误解

### 误解 1："64 个分区 = 64 倍写入能力"

不是。64 个分区共享同一个 `postmaster`、同一份 WAL、同一个 `shared_buffers`、同一块磁盘。所有 INSERT 最终都要排队写 WAL。

**判据**：把所有分区放在一个 `TABLESPACE` 里，写入吞吐与不分区**几乎相同**（差异来自索引更矮，通常 < 10%）。

### 误解 2："分区了就不用管索引了"

恰恰相反：**索引数量变成了 64 倍**（4 个索引 × 64 片 = 256 个索引文件）。索引总数增加会带来：

- relcache / 系统目录压力；
- 备份/恢复的文件数变多；
- `pg_stat_user_indexes` 里 64 行同名索引（排查时要聚合）。

### 误解 3："分区键随便选，反正能裁剪"

分区键决定了：

- 哪些查询能裁剪（必须是热查询的等值条件）；
- 唯一约束能覆盖什么（必须含分区键）；
- 能不能做冷热分层（时间键才可以）；
- 是否会出现热点（用户 ID 可能倾斜，会话 ID 相对均匀）。

**选错分区键，分区就从"优化"变成"负担"。**

---

## 十、怎么自己验证（动手三分钟）

```sql
-- 1) 看分区树
SELECT * FROM pg_partition_tree('messages');

-- 2) 看某个会话落在哪一片
SELECT tableoid::regclass, count(*) FROM messages
WHERE conversation_id = 'single_1_2' GROUP BY 1;

-- 3) 裁剪是否生效（关键看 Subplans Removed）
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM messages WHERE conversation_id = 'single_1_2' ORDER BY seq DESC LIMIT 50;

-- 4) 不带分区键会怎样
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM messages WHERE sender_id = 1;

-- 5) 多值条件
EXPLAIN (ANALYZE, BUFFERS)
SELECT DISTINCT ON (conversation_id) * FROM messages
WHERE conversation_id = ANY(ARRAY['single_1_2','single_3_4']) ORDER BY conversation_id, timestamp DESC;
```

第 3 条应看到 `Subplans Removed: 63`；第 4 条应看到 64 个扫描节点（或一次全表 Append）。

---

## 十一、和其他概念的分界

| 概念 | 与本篇的关系 |
|---|---|
| [分表](./02-分表原理-应用层切表与数据库原生切表的差异.md) | 分表是"分区的手工版"：切法相同，但数据库不知道，路由要自己做 |
| [分库](./03-分库原理-从单实例到多实例到底变了什么.md) | 分区不跨实例；要跨实例必须分库 |
| [分片](./04-分片原理-分片键-路由-再平衡-热点.md) | 分区是分片的一种实现（片在同一实例内） |
| [副本](./05-副本原理-流复制与读写分离.md) | 副本是复制而非切分，与分区正交 |
