# agent-server（Python RAG 服务）

> 范围：`/Users/jaytu/agent-server` 的 `apps/rag-server`（HTTP/SSE 门面 + Pulsar worker）、`packages/agent-core`（鉴权、run-engine、队列、LLM、向量检索）、`docker/`、`.github/`。
>
> 证据来源：只读代码 + 配置对照。跨仓结论已与 talqora 的 `docker/docker-compose.prod.yml`、`docker/nginx/conf.d/default.conf` 逐条比对。本文**不执行** `make test`/`make lint`（原因见 QA-S1：CI 从不跑它们，本地是否可跑本身是未验证状态，标为待确认）。
>
> 先说做得好的两处，因为后面的清单容易让人误判整体质量：**多租户隔离**把 `user_id` 过滤下沉到向量检索的唯一出口（`packages/agent-core/src/agent_core/vector.py:129-141`），`retrieval.py` 强制复用，agent 的工具函数全部按 `ctx.user_id` 过滤——这是最容易出越权的地方，做对了。**SSE 断线补发**实现了「先订阅后补发 + watermark 去重 + 终态收尾」（`apps/rag-server/src/rag_server/modules/runs/router.py:84-109`），顺序是对的。

## 0 一段话总评

服务拆分与职责边界是清楚的：`rag-http` 只做门面（鉴权、上传、SSE），`rag-worker` 消费 Pulsar 跑解析/切分/embedding/工具编排，`agent-core` 是共享库。事件溯源的 run-engine 是全仓设计最讲究的一块。

没跟上的地方有三个：

1. **跨仓容器名两头都错。** `OAUTH_JWKS_URI` 默认指向 `our-chat-server`（talqora 侧容器已改名 `our-chat-biz`），talqora 的 nginx 又把 `/agent/` 反代到 `agent-node-server`（本仓容器已改名 `agent-rag-http`）。两个方向同时断，AI 助手整体不可用，且两侧都会静默 502/401。
2. **健康检查恒 200。** `check_components` 的设计就是「任一依赖 down 也返回 200 + degraded」，compose 的 healthcheck 只判 HTTP 码，于是 PG/Redis/Milvus 全挂时容器依然 healthy，`rag-worker` 的 `depends_on: rag-http: service_healthy` 也失去意义。
3. **没有一条流水线跑测试。** 三个 workflow 分别是部署、proto 校验、私有包发布，没有 pytest/ruff/mypy。下面列的 5 个 S 级问题里，至少 3 个（序号同步竞态、上传全量入内存、联邦用户登录 500）只要有一条并发/边界用例就会暴露。

## 1 问题清单

### 严重

#### AS-S1 生产 JWKS 默认指向不存在的容器名（已核实）

**证据。** `docker/docker-compose.prod.yml:43`：

```
OAUTH_JWKS_URI: ${OAUTH_JWKS_URI:-http://our-chat-server:3007/.well-known/jwks.json}
```

talqora 侧的业务层容器是 `our-chat-biz`（talqora `docker/docker-compose.prod.yml:59`），`our-chat-server` 这个容器在 9 月 30 日切换到 Go 业务层时已被 `--remove-orphans` 删除。

**原理与后果。** 两个仓库经共享网络 `oc-shared` 按容器名互访，容器名在这里就是跨仓接口。默认值解析不到 → `JWKS` 拉取失败 → agent-server 无法验证 RS256 令牌 → 所有 `Bearer` 请求返回 401。**AI 助手整体不可用**，而错误信息是「invalid token」，排查方向会被带到鉴权逻辑而不是 DNS。

**修复。** 默认值改为 `http://our-chat-biz:3007/.well-known/jwks.json`，并把 `:-` 改为 `:?`（缺失即启动失败）。更好的做法是两边都在 `oc-shared` 网络上配稳定别名（`talqora-idp` / `agent-api`），跨仓配置只引用别名。详见 [01 分册 DP-S3](./01-部署配置与密钥.md)。

#### AS-S2 反向代理上游名与实际容器名不一致（已核实）

**证据。** talqora `docker/nginx/conf.d/default.conf:105`：`set $agent_upstream agent-node-server:3101;`；本仓 `docker/docker-compose.prod.yml:162`：`container_name: agent-rag-http`。

**后果。** `/agent/` 全部 502，前端 `agentView` 完全不可用。因为用的是 `resolver` + 变量 `proxy_pass`（惰性解析），nginx 仍能启动，所以故障表现为「页面能开、功能全 502」，而不是「全站挂掉」——后者反而更容易被发现。

**知识性备注。** `agent-node-server` 这个名字的唯一出处是遗留的 `docker/docker-compose.yml:123-128`（仍指向 `apps/node-server`，且该目录不在 CI 的 scp 清单里）。也就是说，**一个已废弃文件的容器名，正在决定生产环境的反代目标**。

**修复。** 改 nginx 为 `agent-rag-http:3101`，或在本仓 compose 给 `rag-http` 加网络别名 `agent-node-server`（不推荐，会继续掩盖命名漂移）。删除或归档遗留的 `docker/docker-compose.yml`。

#### AS-S3 健康检查恒返回 200，编排层自愈能力失效（已核实）

**证据。**

- `apps/rag-server/src/rag_server/modules/health/router.py:31-34`：`return JSONResponse(content=result)`，无 `status_code` 参数，默认 200。
- `packages/agent-core/src/agent_core/health.py:27-28` 的文档字符串直接写明设计意图：「任一项 down → 整体 degraded,但仍 200 返回 details」。
- `docker/docker-compose.prod.yml:176`：`test: ['CMD-SHELL', 'curl -fsS http://localhost:3101/api/health || exit 1']`，只判 HTTP 状态码。

**原理与后果。** Docker healthcheck 的语义是「这个容器现在能不能服务」，它只看退出码。返回 200 + `{"status":"degraded"}` 意味着「依赖全挂也算健康」：

1. `restart: unless-stopped` 永远不会因依赖故障触发重启；
2. `rag-worker` 的 `depends_on: rag-http: service_healthy`（`:207-208`，注释说「等迁移已 apply」）失去意义——它等的是一个恒真的条件；
3. 没有 alerting（见 [03 分册 GW-I6](./03-talqora网关与基础设施.md)），所以 `degraded` 没人会看到。

**修复。** 拆两个端点：

- `/api/health/live`：进程存活，恒 200，只给「要不要重启」用；
- `/api/health/ready`：任一依赖 down 返回 **503**，给 compose healthcheck 与负载均衡用。

`curl -fsS` 在 503 时会以非零退出，compose 立刻能感知。同时保留 `/api/health`（200 + details）给人工排查。

#### AS-S4 `jwt_secret` 有 `dev-secret` 默认值，生产可伪造任意身份（已核实）

**证据。** `packages/agent-core/src/agent_core/settings.py:36`：`jwt_secret: str = "dev-secret"`。鉴权双模实现里 HS256 分支接受该密钥（`packages/agent-core/src/agent_core/auth.py:61` 的 `hs_secret` 默认值、`:113-124` 的 `_verify_hs256`，`algorithms=["HS256"]`，且只要求 `exp`/`sub`，不校验 `iss`/`aud`）。

**原理。** 只要 CI 注入的 `JWT_SECRET` 为空（`docker/ci-deploy.sh:21` 用 `echo "JWT_SECRET=${JWT_SECRET}"`，`set -u` 只挡「未定义」不挡「空串」），服务就会以公开可知的密钥启动，并接受 HS256 令牌。任何知道源码的人都能签出一个 `sub=<任意用户>` 的令牌，冒充他人访问全部 API。

**后果。** 完全的身份伪造。而且因为 RS256 是主路径、HS256 是「开发兜底」，这个分支在生产上**不该存在**。

**修复。**

1. `env=production` 时断言 `len(jwt_secret) >= 32`，否则启动失败；
2. `env=production` 时禁用 HS256 分支（只接受 RS256 + JWKS）；
3. `ci-deploy.sh` 的 `${JWT_SECRET}` 改为 `${JWT_SECRET:?JWT_SECRET 未设置}`，让它硬失败。

#### AS-S5 上传先把整个文件读进内存，再校验大小（已核实）

**证据。**

```54:60:apps/rag-server/src/rag_server/modules/documents/router.py
    data = await file.read()
    document_id, run_id = await _service(ctx, producer).upload(
        user_id=user_id,
        ...
        data=data,
    )
```

大小校验在 service 层，**在读取之后**：`apps/rag-server/src/rag_server/modules/documents/service.py:67-68`（`if len(data) > self._settings.document_max_bytes`）。

**原理。** 攻击者上传一个 500MB 的 PDF，`await file.read()` 会先把 500MB 读进内存，然后才被告知「超过 10MB 上限」。`UploadFile` 超过 1MB 会落临时盘，但 `read()` 是全量读入。并发几个就能把容器打 OOM。

nginx 侧 `client_max_body_size 100m`（talqora `docker/nginx/nginx.conf:14`）把单请求限到 100MB，所以最坏情况是「100MB × 并发数」——仍然足以 OOM。

**修复。** 流式分块写盘并累计计数，超限立即 `413` 中断；或前置 Starlette 的 `request.form(max_files=..., max_fields=...)` + 明确的 `max_part_size`。这与 talqora 业务层的 BZ-I4 是同一个问题，两处应一起改。

### 重要

#### AS-I1 事件序号 `max(seq)+1` 是无锁先读后写，并发 emit 撞唯一约束导致整个 run 失败（已核实）

**证据。**

```181:190:packages/agent-core/src/agent_core/run_engine.py
    async def emit(self, run_id: str, event_type: str, payload: dict[str, Any]) -> RunEventRecord:
        """追加事件:落库(seq = max + 1)→ 广播(Redis)。"""
        sequence_no = await self._repo.last_sequence_no(run_id) + 1
        event = await self._repo.append_event(
            run_id=run_id,
            sequence_no=sequence_no,
            ...
```

数据库侧有唯一约束 `UniqueConstraint("run_id", "sequence_no", name="uq_run_events_sequence")`（`apps/rag-server/src/rag_server/db/models.py:204`）。

**原理。** 同一 run 有两个 emit 并发（例如两个 worker 抢到同一条消息重投、或 `step` 与 `complete` 竞态）→ 两者都读到 `max=7` → 都写 `8` → 第二个 `IntegrityError`。代码里没有捕获重试，异常冒泡使整个 run 进入 failed。

**后果。** 数据正确性错误 + 用户可见的「任务莫名失败」。而且它只在并发下出现，单机顺序测试永远测不出来——这正是 AS-S 级的 CI 缺失最该拦住的那类问题。

**修复。** 用单语句原子分配：

```sql
INSERT INTO run_events (run_id, sequence_no, ...)
SELECT :run_id, COALESCE(MAX(sequence_no), 0) + 1, ...
FROM run_events WHERE run_id = :run_id
```

或对 `runs` 行 `SELECT ... FOR UPDATE`。并捕获 `IntegrityError` 重试 3 次（幂等，因为 seq 会重新计算）。

#### AS-I2 `lazy="selectin"` 让列表接口拉全量关联数据（已核实设计，影响随数据量放大）

**证据。** `apps/rag-server/src/rag_server/db/models.py:115-120`（`Conversation.messages`）、`:159-164`（`TaskSession.runs`）、`:192-197`（`Run.events`）都声明为 `lazy="selectin"`。受害点：`modules/conversations/service.py:28-35`（列会话时预加载每个会话的**全部消息**）、`:47-55`（`ensure_owned` 只为判归属，却预加载全部消息，随后被 `router.py:116` 丢弃）。

**原理。** `selectin` 把 N+1 变成了「1 + 1」次查询，但代价是**总是全量加载**。`GET /api/conversations` 返回 20 个会话，每个会话有 5000 条消息 → 一次请求加载 10 万行，而这些数据在响应里根本用不到。

**后果。** 会话/消息量增长后，列表接口的延迟与内存线性上升。`ensure_owned` 那处更典型——纯鉴权查询却付出了全量加载的代价。

**修复。** 默认改 `lazy="raise"`，在真正需要的地方显式 `selectinload()`；`ensure_owned`/`get_run` 用 `noload()`。`lazy="raise"` 会让「不小心加载」变成显式错误，而不是静默变慢。

#### AS-I3 摄取逐 chunk 单独开事务提交（已核实）：

**证据。** `apps/rag-server/src/rag_server/modules/documents/ingestion.py:86`（循环内 `_create_chunk`）→ `:154-175`（每次 `async with self._sf()` + `commit()` + `refresh()`）。

**原理与后果。** 一份 1000 分片的文档 = 1000 次事务 + 1000 次 round-trip + 1000 次 `refresh`（额外一次 SELECT）。摄取耗时成倍放大，且中途失败会留下半份数据。

**修复。** `session.add_all()` 批量提交（batch=16 或 32，与 embedding 批次对齐），只在需要回传 id 时批量取回。

#### AS-I4 Pulsar 消费失败只 nack，无最大重投与死信（已核实）

**证据。** `packages/agent-core/src/agent_core/queue.py:144-152`：`except Exception: negative_acknowledge`。`RunJob.from_bytes` 的解析失败（`:46`）走同一路径。

**原理。** 一条毒消息（跨版本载荷、run 行被删导致 `processor.py:47-48` 抛 `RuntimeError`）会被无限重投。`Shared` 订阅下消费者并发有限，一条毒消息可以持续占用一个消费位，正常任务被饿死。

**修复。** 记录 `redelivery_count`，超过 N 次 `ack` 并投死信 topic；解析失败（不可恢复）直接 ack + 告警，因为重投一万次也不会成功。

#### AS-I5 没有任何 CI 跑测试或 lint（已核实）

**证据。** `.github/workflows/` 只有 `deploy.yml`、`proto.yml`、`publish-contracts.yml`；对三者全文搜索 `pytest|ruff|mypy` **零命中**。而 `Makefile:54-61` 定义了 `test` 与 `lint` 目标。

**原理与后果。** `make test` / `make lint` 只是本地君子协定。推送到 `master` 直接部署，AS-I1 这类「跑一次并发用例就会暴露」的问题可以无人察觉地上线。

**修复。** 新增 `ci.yml`：`uv sync --frozen --all-packages --dev` → `ruff check` → `ruff format --check` → `mypy` → `pytest`，并让 `deploy` 的 job `needs: [test]`。

#### AS-I6 `make test` 从仓库根跑 `uv run pytest`，但 pytest 只声明在子包 dev 组（待确认）

**证据。** `Makefile:54-56`：`test: uv run pytest`（在根执行）；根 `pyproject.toml:16` 的 `dependencies = []` 且**无 `[dependency-groups]`**；pytest 声明在 `apps/rag-server/pyproject.toml:29-32`。

**原理。** uv workspace 下，根项目的环境只包含根项目的依赖。`uv run pytest` 在根解析时很可能找不到 pytest（或用到全局环境的另一版本），于是「`make test` 跑不起来」→ 没人跑 → 加上 AS-I5，测试事实上不存在。

**修复。** 把 dev 工具上提到根 `pyproject.toml` 的 `[dependency-groups] dev`，或让 Makefile 显式 `uv run --package rag-server pytest`。修完在 README 里写明期望的输出行数，让「跑过了」有据可查。

#### AS-I7 CI 同步清单遗漏 `.dockerignore`，生产构建不受忽略规则约束（已核实）

**证据。** `.github/workflows/deploy.yml:66`：`source: 'apps/rag-server,packages/agent-core,pyproject.toml,uv.lock,docker'`——不含 `.dockerignore`。而 `.dockerignore:20-22` 明确排除 `.env`、`.env.*`。Dockerfile 的 `COPY apps/rag-server ./apps/rag-server`（`apps/rag-server/Dockerfile:26`）会带进整个目录。

**后果。** 服务器上的 `/opt/agent-server` 没有 `.dockerignore`，本地残留的 `.env`（含真实 `LLM_API_KEY`）、`storage/`、`__pycache__`、`.pytest_cache` 会被烤进镜像。**镜像体积与泄密风险同时上升**。

**修复。** 把 `.dockerignore` 加进 scp 清单；`ci-deploy.sh` 里断言它存在。

#### AS-I8 联邦用户 `password_hash=""` 走本地登录会 500 而不是 401（已核实）

**证据。** `apps/rag-server/src/rag_server/db/adapters.py:72`（`password_hash=""` 哨兵值）；`modules/auth/service.py:72`（`bcrypt.checkpw(pw, b"")`，`bcrypt` 对非法 hash 抛 `ValueError`，此处无 `try/except`）。

**后果。** 攻击者枚举到联邦用户的 `username`（形如 `oc_<subject>`，`federated.py:50`）后发一次本地登录，就能触发未捕获异常 → 500 + 完整堆栈日志。既可用于探测账号是否存在，也会污染错误率指标。

**修复。** `if not user.password_hash: raise _invalid_credentials()`，或 `except ValueError: raise _invalid_credentials()`。

### 一般

| 编号 | 问题 | 证据 | 修复 |
|---|---|---|---|
| AS-N1 | 支持 `?access_token=` 传令牌，会进 nginx access log / Referer / 浏览器历史 | `apps/rag-server/src/rag_server/deps.py:48-50` | 仅 SSE 保留但改为一次性短期 ticket；或改用 `fetch` 流 + header |
| AS-N2 | Redis 无 `socket_timeout`；健康探活的 `asyncio.gather` 无超时 | `packages/agent-core/src/agent_core/redis.py:17`、`health.py:18` | `socket_timeout=5, socket_connect_timeout=3`；每个 probe 包 `asyncio.wait_for(..., 3)` |
| AS-N3 | 镜像恒为 `:local`，`GIT_SHA` 传了不用，无法回滚 | `docker/docker-compose.prod.yml:161,195`、`.github/workflows/deploy.yml:73` | 按 SHA 打标签并保留最近 N 个；与 01 分册 DP-I2 同解 |

## 2 整改顺序

| 顺序 | 事项 | 关联 | 工时 |
|---|---|---|---|
| 1 | 跨仓容器名改对（JWKS 默认值 + nginx 上游） | AS-S1、AS-S2 | 1h |
| 2 | 健康检查拆 live/ready，`ready` 返回 503 | AS-S3 | 1h |
| 3 | `jwt_secret` 生产断言 + 禁用 HS256 + ci-deploy 硬失败 | AS-S4 | 1h |
| 4 | 上传流式化 | AS-S5 | 2h |
| 5 | 事件序号改原子分配 + 重试 | AS-I1 | 2h |
| 6 | 新增 CI 流水线（ruff/mypy/pytest） | AS-I5、AS-I6 | 3h |
| 7 | `.dockerignore` 进 scp；`lazy="raise"`；批量摄取；死信 | AS-I7、AS-I2、AS-I3、AS-I4 | 6h |
| 8 | 联邦用户登录 500；一般项 | AS-I8、N1–N3 | 2h |

第 1–5 项合计 7 小时，把 5 个 S 级问题全部关掉，并与 talqora 侧的修复合并成同一个「跨仓修一轮」的窗口。

## ★ 关键理解点

- **正向：跨仓接口不只是 API。** 容器名、网络别名、JWKS 地址、令牌的 `aud`/`iss`，都是两个仓库之间的契约，但它们不在 `proto/` 里，`buf` 校验管不到，两个仓库的 CI 也各管各的。守护这类契约的唯一办法是「跨仓冒烟测试」：部署后用一个刚签发的令牌打一次真实请求，失败即判定部署失败。
- **反向：健康检查返回 200 是一种「主动放弃自愈」。** 编排层没有别的信息来源，它只会看退出码。把 `degraded` 塞进 200 的响应体，等于告诉编排层「我很好」——而这恰好是最需要它采取行动的时刻。live 与 ready 分开是唯一正确的语义划分：前者回答「要不要重启我」，后者回答「要不要把流量给我」。
- **边界：`lazy="selectin"` 解决的是 N+1，代价是「总是全量」。** 它在「一对少」的场景里是优化，在「一对万」的场景里是灾难。ORM 的默认值应当选择「不小心就会报错」（`lazy="raise"`），而不是「不小心就慢十倍」。
- **对比：幂等重试 vs 唯一约束。** 唯一约束是**检测**重复的手段，不是**避免**重复的手段。AS-I1 里冲突是正确的（确实重复了），错误在于没有把它当成「重试信号」而是当成了「失败信号」。有唯一约束的地方，写入路径就应该默认「可能冲突、需要重试」。
