# 遗留 Node 业务层与文档漂移

> 范围：`server/`（Node + Express + Prisma + Socket.io 旧业务层）、根 `README.md` / `CLAUDE.md` / `web/CLAUDE.md` / `server/CLAUDE.md`、`buf.gen.yaml` 与 `.github/workflows/proto.yml`、`openapi/openapi.yaml`、`perf/` 的说明与脚本。
>
> 这类问题单独成册，因为它的危害不是「某一行代码错了」，而是**让人持续做错事**：改错目录、起错服务、按错的契约编码、跑错的压测、引用不存在的文档。
>
> 事实基线（已核实）：`docker/docker-compose.prod.yml` 的服务是 postgres/redis/**biz**/gateway/web/coturn；`Makefile:23-25` 起的是 biz/gateway/web；`docker/docker-compose.yml` 与 `docker/docker-compose.dev.yml` 也都没有 `server`。**Node 业务层已于 9 月 30 日下线，`server/` 目录不再参与任何运行路径。**

## 0 一段话总评

`server/` 已经不在任何部署编排里，但它仍然在四个地方起作用：部署脚本把它 scp 到生产机（同时漏掉真正要构建的 `biz/`）、`buf.gen.yaml` 把它当作 proto 生成目标、`proto.yml` 把它的生成物当作门禁、四份文档把它描述成「业务层」。

更危险的是它带着一套**独立的数据库迁移**（`server/prisma/migrations/`，最新到 `20260701120000_seed_official_account_tujiang`），而 Go 侧的迁移是 `biz/migrations/`（到 `0008_official_account_id_10301`）。两者已经分叉：Prisma 侧缺 `0007_messages_partition`（64 分区）与 `0008`（官方账号 id 迁移）。而 `server/src/server.ts:26` 启动第一件事就是 `applyPendingMigrations()`，`server/Dockerfile:51` 的 CMD 也是 `prisma migrate deploy && node dist/server.js`。**任何人误起一次 Node 服务，就会往生产库写入与 golang-migrate 冲突的 `_prisma_migrations` 记录，并绕过分区表迁移。**

再加上文档与事实相反：`README.md:7` 明说「`server/`(Node) — 仓库默认编排目前仍以它作为业务层」，`CLAUDE.md:16` 把 `server/` 列为业务后端、`web/CLAUDE.md:3` 说前端栈含 `socket.io-client`（该依赖已被删除）。新人或新的 AI 会话按文档操作，会去改 `server/`、会在 `web/` 里重新引入 socket.io。

## 1 问题清单

### 严重

#### LEG-S1 部署清单仍在搬 `server/` 却漏掉 `biz/`（已核实）

**证据。** `.github/workflows/deploy.yml:75`：`source: 'server,gateway,web,docker'`；而 `docker/docker-compose.prod.yml:54-58` 的 biz 服务构建上下文是 `../biz`。

**原理。** CI 的模型是「runner 上 checkout → scp 到服务器 → 服务器本地 `docker compose build`」。服务器能构建什么，完全取决于 scp 清单。

**后果。** 两种结果，第二种更危险：

1. 服务器上没有 `biz/` 目录 → `docker compose build` 失败 → 生产停在旧版本；
2. 服务器上有某次手工拷贝的旧 `biz/` → 构建**成功**，但生产跑的是旧代码，而部署脚本报告成功。

同时每次都把 Node 旧业务层（含 `node_modules` 排除后的源码、`prisma/`、42 个测试文件）搬到生产机：占空间、误导现场排查（`ps` 里能看到 server 目录，让人以为它在跑）。

**修复。** `source` 改为 `biz,gateway,web,docker`（这一条与 [01 分册 DP-S1](./01-部署配置与密钥.md) 是同一个修复）。删除 `server/` 目录，或将其归档到 `docs/legacy-node-business-layer/` 并去掉所有构建/生成能力。

#### LEG-S2 双迁移源已分叉，误起 Node 服务会污染生产库（已核实）

**证据。**

| 项 | Node 侧 | Go 侧 |
|---|---|---|
| 迁移目录 | `server/prisma/migrations/` | `biz/migrations/` |
| 最新一条 | `20260701120000_seed_official_account_tujiang` | `0008_official_account_id_10301` |
| 缺少的迁移 | `0007_messages_partition`（64 分区）、`0008`（官方 id 0→10301） | — |
| 迁移工具 | Prisma（`_prisma_migrations` 表） | golang-migrate（`schema_migrations` 表） |
| 启动即迁移 | `server/src/server.ts:26` `await applyPendingMigrations()`；`server/Dockerfile:51` `prisma migrate deploy && node dist/server.js` | `biz/cmd/biz/main.go:66` `migrate.Up(...)` |

**原理。** 两套工具各写各的版本表。Prisma 看到的是「已应用 20260701120000」，于是**不会**尝试应用 Go 侧的 `0007`/`0008`——但它也**不知道**它们存在。反过来，如果有人先跑过 Node 再跑 Go，golang-migrate 会从 `0001` 开始检查，发现 `messages` 表已存在而报错（或者更糟：某些迁移 `IF NOT EXISTS` 保护后静默跳过）。

**后果。** 数据层不可逆污染：`_prisma_migrations` 表凭空出现、`messages` 分区表未知、官方账号 id 依赖 `0008` 才正确。这类故障一旦发生，恢复方式是「从备份恢复」而不是「改一行代码」。

**修复。** 删除 `server/prisma/migrations` 与启动期自动迁移；迁移唯一来源保留 `biz/migrations`。如果出于「保留对照实现」的目的要留下 `server/src`，也必须删掉 `prisma/` 与 Dockerfile 里的 `migrate deploy`。

#### LEG-S3 文档把 `server/` 描述为业务层，与事实相反（已核实）

**证据。**

| 文件 | 行 | 现在的说法 | 事实 |
|---|---|---|---|
| `README.md` | 7 | 「`server/`(Node) — 仓库默认编排(`make dev`、`docker/docker-compose.prod.yml`)目前仍以它作为业务层」 | 两者都已切 `biz` |
| `README.md` | 16 | 服务表：`server/` 是「业务层(Node 版,现默认编排仍引用)」 | 同上 |
| `README.md` | 128 | 「方式一(仓库默认,业务层 Node)：`make dev` … 起 `server`(Node :3007)」 | `Makefile:23-25` 起的是 `biz` |
| `CLAUDE.md` | 16 | 服务地图：`server/` = 业务/信令后端 | 应为 `biz/` |
| `CLAUDE.md` | 18 | `web/` 栈含 `socket.io-client` | 依赖已删除，源码零残留 |
| `CLAUDE.md` | 25 | 「实时层：`server` 用 Socket.io(+Redis adapter)」 | 实时层是 `gateway/` 原生 WS |
| `web/CLAUDE.md` | 3、9 | 栈含 `socket.io-client`；「实时：socket.io-client + RTK」 | 已改为原生 WS（`web/src/ws/wsClient.ts`） |
| `server/CLAUDE.md` | 1-3 | 自述为业务后端 | 已下线 |

**原理。** `CLAUDE.md` 是给 AI 助手读的项目说明，`README.md` 是给人的入口说明。两者都指向废弃目录时，**每一轮新会话都会重新犯同一个错**：去改 `server/`、去加 socket.io 依赖、去按 Socket.io 的事件模型理解实时层。这不只是「文档旧了」，是持续产生返工。

**后果。** 具体危害已经发生过一次：`perf/README.md` 至今写「只压 `server/`（Express + Socket.io,基址 `http://localhost:3007`）」，而 `perf/` 下 18 个脚本里有 4 个仍以 socket.io 为目标（见 LEG-I2）。

**修复。** 按事实重写四份文件：

- 服务地图：`biz/`（Go 业务层）、`gateway/`（Go 长连接网关）、`web/`（React + 原生 WS）、`mobile-swift/`、`agent-server`（独立仓库）；
- 删除 `server/` 章节，改为一行「已下线，见 `docs/legacy-*`」；
- `web/CLAUDE.md` 去掉 `socket.io-client`，补充「实时层统一走 `ws/wsClient.ts`」；
- 校验方式：`grep -rn "socket.io" README.md CLAUDE.md web/CLAUDE.md` 应为零命中（`docker-compose` 里残留的 `/socket.io/` location 也一并删除，见 01 分册 DP-S2）。

### 重要

#### LEG-I1 proto 生成与门禁仍以 `server/` 为目标（已核实）

**证据。** `buf.gen.yaml:10`（`out: server/src/contracts/gen`）、`:42`（`out: server/src/contracts/gen-edge`）；`.github/workflows/proto.yml:10`（PR 触发路径含 `server/src/contracts/gen/**`）与 `:47-51`（校验这些目录的生成物是否最新）。

同时 Go 侧的真实生成目标是 `biz/internal/contracts/gen` 与 `gateway/internal/contracts/gen`（两者都在 `proto.yml:12-13` 的触发路径里，但门禁逻辑仍包括 server）。

**原理与后果。** 改一次 `.proto` 必须同时刷新四份生成物（server 两份 + biz + gateway），否则 PR 门禁失败。这是给一个不存在的服务付维护成本；而且 `gen-edge`（grpc-js 服务端代码）没有任何消费者。

**修复。** 从 `buf.gen.yaml` 移除 `server/` 的两个 target，`proto.yml` 的 freshness 列表同步移除，只校验 `biz`/`gateway`/`web`/`mobile-swift` 四处。

#### LEG-I2 `server/.github/workflows/` 下的 CI/CD 永不执行（已核实）

**证据。** `server/.github/workflows/ci.yml` 与 `server/.github/workflows/cd.yml` 存在；GitHub 只读取**仓库根**的 `.github/workflows/`，嵌套目录不会被识别。

**后果。** 这两个文件声称「含 vitest 122 用例」「构建并推送镜像到 GHCR」，实际上从未运行。`server/test/` 下 42 个测试文件（含 `contract.openapi.test.ts` 这类有价值的契约断言）因此永久不执行。更糟的是它制造了「server 有 CI」的假象——而仓库根的三条 workflow 里，没有一条跑测试（见 [07 分册](./07-测试与质量门禁.md)）。

**修复。** 删除这两个文件。如果要保留 `server/test` 里的契约断言（推荐保留 `contract.openapi.test.ts` 与 `ws-contracts`），先把它们移植到 `biz` 的测试里，再删目录。

#### LEG-I3 OpenAPI 契约自身有缺口与矛盾，且它是 iOS 的生成源（已核实）

**证据。**

- 路径总数 **14**，而在用的后端端点远多于此。`web` 在用的 `/user/updateRemark`（`web/src/globalApi/friendApi.ts:37`）与 `/user/updateConversationTime`（`web/src/globalApi/chatApi.ts:29`）**都不在契约里**。
- `userId` 类型自相矛盾：`openapi/openapi.yaml:189`（`addFriend` 请求体）是 `type: integer, format: int64`；`:234`（`replyFriendReq` 请求体）是 `type: string`。

**原理与后果。** OpenAPI 是 `mobile-swift` 的客户端生成源。生成出来的 Swift 客户端会按「`addFriend` 传整数、`replyFriendReq` 传字符串」实现——而 Go 侧两处都按 `string` 绑定（见 BZ-S2），于是 iOS 的 `addFriend` 会失败、`replyFriendReq` 反而可能成功。**同一份契约，三端三种行为。**

未纳入契约的端点在 `proto.yml` 的漂移检查之外，改动无人兜底。

**修复。** 补齐 14 条以外的在用端点；统一 `userId`/`friendId` 为 `integer, format: int64`；把「web 实际调用的 URL 集合 ⊆ openapi 路径集合」做成一条 CI 检查（用正则扫 `globalApi/*.ts` 的 URL，与 `openapi.yaml` 的 `paths` 求差集）。

### 一般

| 编号 | 问题 | 证据 | 修复 |
|---|---|---|---|
| LEG-N1 | `perf/` 的说明与 4 个脚本仍以 socket.io / `:3007` 为目标 | `perf/README.md:3`「只压 `server/`」、`perf/node-run.mjs:158`（`mode: 'socketio'`）、`storm-reconnect.mjs:15`、`http-bench.mjs:14`、`ramp-probe.mjs:16`（`BASE=http://localhost:3007`） | 统一改为 gateway `/ws` 与 biz HTTP；删除 socketio 模式。**注意**：其中 `call-rejoin-probe.mjs` 等探针含明文测试口令，见 01 分册 DP-S4 |
| LEG-N2 | 现有文档里的相对链接指向不存在的目录 | `01-部署配置与密钥.md` 引用 `../模块开发计划/01-业务层Go统一/02-开发计划-收尾与下线Node.md`、`../模块开发计划/07-部署与交付/开发计划.md`、`../模块开发计划/README.md`，而 `docs/模块开发计划/` 整个目录不存在 | 改写为指向本目录的分册，或先创建该目录再引用；**建议本目录内的所有整改动作都收敛到 00 分册的整改表，不再依赖外部计划目录** |

## 2 整改顺序

| 顺序 | 事项 | 关联 | 工时 |
|---|---|---|---|
| 1 | 删除 `server/prisma/migrations` 与启动期自动迁移 | LEG-S2 | 0.5h |
| 2 | 删除 `server/.github/` 两个 workflow | LEG-I2 | 0.1h |
| 3 | 移植 `contract.openapi.test.ts` 的断言到 biz（可选但推荐） | LEG-I2 | 2h |
| 4 | 删除 `server/` 目录（含 `Dockerfile`、`prisma/`、`test/`） | LEG-S1、S2 | 0.5h |
| 5 | `buf.gen.yaml` + `proto.yml` 去掉 server 目标 | LEG-I1 | 1h |
| 6 | 重写 README / CLAUDE.md / web/CLAUDE.md 的服务地图 | LEG-S3 | 2h |
| 7 | OpenAPI 补齐端点、统一类型、加漂移检查 | LEG-I3 | 3h |
| 8 | perf 说明与脚本切到 gateway/biz | LEG-N1 | 2h |

第 1–4 项合计约 3 小时，做完之后「误起 Node 服务污染生产库」这条不可逆风险消失。**顺序很重要：先删迁移，再删目录**——如果先删目录，`prisma/migrations` 会随目录一起消失（等效），但如果有人从 git 历史恢复，风险仍在，所以第 1 步应该是独立提交。

## ★ 关键理解点

- **正向：删代码是一项安全措施，不只是整理。** `server/` 留着看似无害（「反正在归档」），但它携带着一套会自动执行的迁移、一套会被 CI 搬运的目录、一份会被生成的契约代码。**每一个「自动」都是潜在的事故入口**。真正的归档要切断所有自动化，只留文本。
- **反向：两套迁移工具并存，等于没有迁移可信度。** 判断「当前 schema 是什么」需要同时查 `_prisma_migrations` 与 `schema_migrations`，而两者对不上时无法自动判定谁对。数据层的唯一真相来源必须唯一。
- **边界：文档的边界是「读者会照做」。** 判断一段文档该不该留，标准不是「它是否准确描述了历史」，而是「有人照着做会不会出错」。`README.md:7` 那句「目前仍以它作为业务层」如果被照做，就会去改一个已下线的服务。
- **对比：契约完备 vs 契约正确。** 补齐端点（完备）与统一类型（正确）是两件事。本项目当前两者都缺，但**正确性更紧急**——一个类型矛盾的契约会让三端各自实现出不同行为，而缺端点只是「没覆盖」。
