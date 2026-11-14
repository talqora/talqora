# RAG 服务 · Run 引擎与事件流

> 架构见 [01 篇](./01-整体架构与请求链路.md)。本篇讲**一个长任务怎么被表达、怎么被观测、断线怎么续**。

## 0. TL;DR

- 用**事件溯源**表达进度:`rag.runs` 存当前状态,`rag.run_events` 存不可变的追加事件(带自增 `sequence_no`)。当前状态可以从事件重放推出,但为了查询快也单独存了一份。
- 纪律是**先发事件、后改状态**。原因写在注释里:反过来的话,晚连入的 SSE 客户端可能读到 `completed` 却还没看到 `run_completed`,提前收尾漏掉终态事件。
- 序号分配是 `max(seq) + 1` **跨两个事务**,没有任何锁或重试。并发 `emit` 会撞唯一约束 `(run_id, sequence_no)` 报错——**这会直接毁掉整个 job,而不是自动重试**。
- SSE 支持 `Last-Event-ID` 断点续传:先订阅、再从 PG 补发历史、用 `watermark` 去重实时事件。这三步的顺序不能反。
- 没有 run 取消、没有超时、没有重试上限。卡住的 run 只能人工介入,毒消息会在队列里无限重投。
- Agent 循环最多 8 轮,到上限补一条 `final_answer` 并标 `truncated: true`——**明确告知"我说完了但没说完"**,而不是静默截断。

---

## 1. 数据模型

```text
rag.runs
  run_id            PK(字符串)
  user_id / task / ref_id / task_session_id
  status            queued | running | completed | failed
  progress_msg      当前进展的人类可读描述(255)
  error_msg         失败原因
  created_at / started_at / completed_at

rag.run_events
  id                PK(自增)
  run_id            FK → runs.run_id  ON DELETE CASCADE
  sequence_no       事件序号,从 1 开始
  event_type        run_started | step | run_completed | run_failed
  payload           JSONB
  created_at
  UNIQUE (run_id, sequence_no)      ← models.py:204
  INDEX  (run_id)
```

**唯一约束是这里最重要的设计**:它是"序号不能重"的最终防线。问题是——它只是**报错**,不提供自动修复(见 §3)。

`ref_id` 是"这个 run 在处理什么":摄取 run 里它是 `document_id`。这让 runs 表可以服务多种任务(摄取、agent 会话),而不必为每种任务建一张表。

---

## 2. 状态机与"先事件后状态"

```text
          create_run()
              │
              ▼
          ┌────────┐
          │ queued │──────────────┐
          └───┬────┘              │
    start()   │                   │
    emit run_started → running    │
              ▼                   │
          ┌─────────┐   fail()    │
          │ running │────────────▶│
          └────┬────┘             ▼
   complete()  │            ┌────────┐
   emit run_completed        │ failed │
               ▼            └────────┘
          ┌───────────┐
          │ completed │
          └───────────┘
```

`start` / `complete` / `fail` 三者的顺序都是**先 emit 事件,再 `update_status`**:

```python
async def complete(self, run_id, progress_msg=None):
    await self.emit(run_id, "run_completed", ...)   # ① 先事件
    await self._repo.update_status(..., status=COMPLETED)  # ② 后状态
```

注释里的理由值得完整引用:

> 顺序关键——若先落终态再发事件,晚连入的 SSE 可能读到 `completed` 却还没看到 `run_completed` 而提前收尾,漏掉终态事件。

**这是事件溯源里最容易写反的一处。** 直觉上"先改状态更安全"(至少状态是对的),但对消费者而言,**事件流才是真相**,状态只是一个快照。快照可以先于事件到达吗?在这个设计里——SSE 的处理是"先补发事件、再看 `terminal` 标志",所以如果状态先变 `completed`,客户端补发完历史事件后看到 `terminal=true` 就 `return`,而 `run_completed` 事件可能还没落库 → 客户端永远收不到终态。

代价:极端情况下(emit 成功但 update_status 失败)会出现"事件说完成了,状态还是 running"。这种不一致比反过来轻——前端已经收到 `run_completed`,会正常收尾;后台任务扫到 `running` 可以重试。

---

## 3. 序号分配的竞态(当前最重要的缺陷)

```python
# run_engine.py:183-189
sequence_no = await self._repo.last_sequence_no(run_id) + 1   # 事务 A:SELECT MAX
event = await self._repo.append_event(...)                    # 事务 B:INSERT
await self._bus.publish_run_event(...)
```

两个事务之间没有任何锁。并发场景:

```text
协程 1: SELECT MAX = 5
协程 2: SELECT MAX = 5          ← 同一瞬间
协程 1: INSERT seq=6  ✅
协程 2: INSERT seq=6  ❌ IntegrityError (uq_run_events_sequence)
```

### 3.1 为什么会真的发生

单 run 内看似"顺序执行"(摄取是一个 for 循环),但:

- **多个 run 并发**是常态(多人同时上传),不同 run 各有各的序号空间,互不影响——**这部分没问题**;
- 同一 run 内并发 emit 的场景:worker 在 `for batch` 循环里 emit,同时 HTTP 侧可能因为某个操作补发事件;未来若有"并行子任务写同一个 run",立刻踩中;
- **跨进程**:worker 重启后旧消息被重投,可能与新 worker 的 emit 并存。

### 3.2 后果有多严重

`IntegrityError` 会从 `emit` 一路抛到 `ingest` 的 `except`:

```python
except Exception as exc:
    await self._set_document_status(..., status="failed", error_msg=message)
    raise
```

→ 文档标记 `failed` → 队列 nack 重投 → 从头解析、重新 embedding。**一个偶发的唯一约束冲突,代价是整份文档重跑。**

### 3.3 三种修法

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 数据库原子自增** | `INSERT INTO run_events (...) SELECT COALESCE(MAX(sequence_no),0)+1 FROM run_events WHERE run_id=...` | 一条语句,天然原子 | 并发下仍可能撞(两个事务并发读同一快照),需配合唯一约束重试 |
| **B. 行锁** | `SELECT ... FROM runs WHERE run_id=? FOR UPDATE` 后再取 max 插入,同一事务 | 严格串行,绝对正确 | run 级锁,同 run 事件写入串行化(可以接受,本来就该有序) |
| **C. 唯一约束 + 重试** | 捕获 `23505` 重试 2-3 次 | 改动最小 | 不解决根因,只是把窗口等掉 |

**推荐 B + C 兜底**:同 run 的事件本来就该有序,用 `FOR UPDATE` 锁住 run 行是语义正确的;再保留唯一约束作为最后防线并加重试,防止实现漂移。

> 这个缺陷的性质和系统里其它几处一样:**单线程测试永远发现不了,只有并发才暴露**。压测/多用户场景才会现形。

---

## 4. SSE:断点续传怎么做对

### 4.1 协议

```text
GET /api/runs/{runId}/stream
  Header: Last-Event-ID: 42        (EventSource 自动带上)
  或     ?lastEventId=42           (手动重连/非 EventSource 客户端)

响应:
  event: step
  id: 43
  data: {"step":"embedding","done":32,"total":128}
  ...
  event: run_completed
  id: 129
  data: {...}
```

`id` 就是 `sequence_no`——它同时是 SSE 的断点标记**和**业务序号,一个概念两用,避免了两套编号对不上。

### 4.2 三步顺序不能错

```python
subscription = await event_bus.subscribe_run(run_id)   # ① 先订阅
watermark = since_seq
missed = await run_engine.get_events_since(run_id, since_seq)   # ② 再补发
for ev in missed:
    watermark = ev.sequence_no
    yield ...
    if terminal: return
if terminal: return                                     # ③ 已是终态则收尾
async for wire_ev in subscription.events():             # ④ 转实时
    if seq <= watermark: continue                       #    去重
    ...
```

- **① 必须在 ② 之前**。反过来的话,"补发查询结束"到"订阅生效"之间产生的事件会永久丢失——这是一段真实存在的时间窗(毫秒级),而且**只在高并发时才出现**,极难复现。
- **watermark 去重**:订阅先于补发,意味着补发期间到达的实时事件也被缓冲了,会和补发的历史重叠。用 `seq <= watermark` 跳过重复。
- **终端主动收尾**:补发完发现 run 已是终态(`terminal`),不必等实时消息——**否则客户端会挂在这个连接上直到 ping 超时**。

### 4.3 必须配的响应头

```python
headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"}
```

`X-Accel-Buffering: no` 是给 **nginx** 看的:告诉它不要缓冲这个响应。少了它,nginx 会攒够 buffer 才下发,SSE 变成"每 4KB 卡一下"的伪流式。跨仓部署时这条尤其关键——本服务的响应头要和 talqora 侧 nginx 的 `proxy_buffering` 设置配合。

`ping=15`:15s 一次注释帧,防止中间设备(负载均衡/代理)因空闲超时断开。

---

## 5. Agent 循环

```python
for i in range(settings.agent_max_iterations):   # 默认 8
    resp = llm.chat(messages, tools=...)
    if not resp.tool_calls:
        return resp.content
    for call in resp.tool_calls:
        try:
            result = tool.run(call)
        except Exception as e:
            result = f"工具执行失败: {e}"      # 降级为文本回喂
        messages.append(tool_result(result[:2000]))   # 截断 2000 字符
if 达到上限:
    emit final_answer + {"truncated": True}
```

四个设计点:

1. **8 轮上限**是防死循环的硬闸。没有它,模型可能"调工具→看不懂结果→再调"无限循环,烧钱烧 GPU。
2. **工具异常降级为文本**,而不是中断。模型能看到"工具失败了",自己决定换个方法或如实回答。比直接 500 好。
3. **工具结果截断 2000 字符**。工具返回的超长文本会迅速吃满上下文,必须截。
4. **`truncated: true`** —— 到上限时明确标记"不是我想说的全部"。**这一条是诚实性设计**:用户/前端能区分"完整回答"和"被截断的回答"。没有它,用户会以为模型只想到这些。

当前缺的:工具调用没有超时(一个卡住的工具会拖住整个 run)、没有 token 用量统计、没有并发限制。

---

## 6. 生命周期缺口

| 缺口 | 后果 | 建议 |
|---|---|---|
| **无 cancel 端点** | 用户传错 100MB 文档,只能等它跑完或重启 worker | 加 `POST /api/runs/{id}/cancel`,置状态 + worker 循环里检查 |
| **无 run 超时** | 卡在 `running` 的 run 永远不结束,前端 SSE 挂到天荒地老 | 加 `started_at + timeout` 的清理任务 |
| **Pulsar nack 无上限重投** | 毒消息(如损坏的 PDF)会无限重投,持续烧 CPU 并刷日志 | 重投计数 + 死信队列(DLQ) |
| **无 run 级并发限制** | 10 个人同时传大文档 → worker 串行处理,队列堆积 | 按 user 限流 / worker 多副本 |

其中**毒消息**最值得优先处理:它是唯一一个"会自己不断放大"的故障——每条重投都会完整跑一遍解析与 embedding,不仅浪费资源,还会持续覆盖 `error_msg`、反复失败、刷满日志。

---

## 7. 观测建议

现有 `run_events` 已经能推出:

- **总耗时** = `run_completed.created_at - run_started.created_at`;
- **各阶段耗时** = 相邻 `step` 事件的时间差;
- **吞吐** = `step(embedding)` 里的 `done/total` 随时间变化。

**这些现在只能靠在 DB 里查,没有指标暴露出去。** 最小改进:worker 侧 `prometheus_client` 暴露 `rag_ingest_duration_seconds{stage}`、`rag_embed_batches_total{result}`、`rag_runs_inflight`。有了这三个,"摄取慢"就不再需要靠日志猜。

---

## 8. 优先级

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | 序号分配加行锁 + 唯一约束重试 | 偶发冲突会毁掉整份文档的摄取 |
| P1 | 毒消息重投上限 + DLQ | 唯一会自我放大的故障 |
| P1 | run 超时清理 | 卡死的 run 无法自愈 |
| P2 | cancel 端点 + worker 循环检查取消标志 | 用户可控 |
| P2 | 阶段耗时指标 | 让"慢"可定位 |
| P3 | 工具调用超时 | 防单个工具拖死 run |
