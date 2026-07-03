# proto 去向与治理 —— 事件域保留、agent-server、buf 生成确定性

> 范围:OpenAPI 迁移(REST 实体迁 OpenAPI)落地后,**回答 proto 还要不要、留哪些、对 agent-server 有无影响、为什么 buf 的 CI 会误红、怎么治本**。与选型三篇(《跨端 IDL 与代码生成选型分析》《实时通信契约边界》《buf 与 OpenAPI 对比》)互补:那三篇讲"该怎么选",本篇讲"迁移后 proto 的实际去向与治理"。
> 结论先行:**proto 不废弃,只"瘦身"**——REST 实体(User/Message/Conversation/Friend)迁到 OpenAPI 并从 proto 删除;**事件/流式域(call 信令、message 的 WS 上行、agent RAG-SSE、presence、read)永远留 proto**,因为 OpenAPI 描述不了事件流。**agent-server 零影响、不需改**(它有独立 proto、只用 agent 域、走 SSE)。CI 误红的真因是**远程插件没锁版本**导致 `buf generate` 非确定性,**锁版本即治本**(已锁 ts-proto v2.11.8 / protoc-gen-go v1.36.11)。

---

## 0. 术语表(先读)

| 术语 | 全称 / 含义 | 通俗解释 |
|---|---|---|
| **proto / Protobuf** | Protocol Buffers | Google 的 IDL + 序列化;`.proto` 定义消息,buf/protoc 配插件生成各端代码。 |
| **buf** | — | Protobuf 工程化工具:依赖、lint、breaking 检测、远程插件、BSR。 |
| **BSR** | Buf Schema Registry | buf 的远程插件市场;`remote: buf.build/...` 即调 BSR 上托管的生成插件。 |
| **远程插件(remote plugin)** | — | 托管在 BSR、`buf generate` 时按需拉取执行的生成插件(免本地装 protoc 插件)。 |
| **插件版本锁定** | — | 把远程插件写成 `…:vX.Y.Z` 固定版本,使生成输出**确定**、跨时间可复现。 |
| **WKT** | Well-Known Types | Protobuf 内置类型(`google.protobuf.Timestamp`/`Struct` 等),由插件随业务类型一并生成。 |
| **SSE** | Server-Sent Events | 基于 HTTP 的"服务端→客户端单向流式推送"。Agent/RAG 的 token 流就走它。 |
| **事件流 / 流式范式** | — | 服务端可主动推、一条连接多条异步消息(WS、SSE、pub/sub)。OpenAPI 的请求/响应模型装不下。 |
| **OpenAPI** | 原 Swagger | 描述 HTTP/JSON REST 接口的 IDL。**只覆盖"一问一答"**。 |
| **REST 实体** | — | 本项目指 User / Message / Conversation / Friend 这些"数据形状",经 REST 接口收发。 |
| **`buf generate` + `git diff --exit-code`** | — | CI 里"生成物是否最新"的校验:跑生成,再看产物有没有变化;有变化即判失败(红)。 |

---

## 1. proto 迁移后的去向:不废弃,瘦身到事件域

OpenAPI 迁移**只动 REST 实体**。落地后 proto 的域一分为二:

| proto 域 | 去向 | 原因 |
|---|---|---|
| `user` / `conversation` / `friend`(整文件) | **删除** | 纯 REST 实体,已迁 OpenAPI,无人再消费 |
| `message` 里的 `Message` 消息 | **删除** | REST 实体(receiveMessage/历史的形状),迁 OpenAPI |
| `message` 里的 `FileInfo` / `SendMessageInput` / `SendMessageAck` | **保留** | **WS 上行事件**(message.send/ack);`SendMessageInput` 复用 `FileInfo`,故 `FileInfo` 留 proto |
| `call`(`CallStart/Accept/Reject/End/Ice/Rejoin/Busy/Handled/PeerReconnecting…`) | **保留** | WebRTC **信令事件**(`call:*`),双向 + 服务端主动推 |
| `agent`(`AgentUser/AgentMessage/AgentConversation/Citation…`) | **保留** | Agent/RAG **SSE 流式** |
| `presence` / `read` | **保留** | 在线状态 / 已读 **事件** |

> 落地后我们仓 `proto/ourchat/` 实际剩:`agent / call / message(仅 WS) / presence / read` —— **全是事件/流式域**。

**一句话:proto 从"什么都装"收敛成"只装 OpenAPI 装不下的事件/流式契约"。**

---

## 2. 为什么事件/流式域必须留 proto(交互模型边界)

这点在《实时通信契约边界》讲透,这里只给结论与对应关系:

- **OpenAPI 的数据模型是"客户端发起、一问一答、传输层配对、按 URL+动词寻址"**,没有承载"服务端主动推 / 一条连接多条事件 / 事件名 / 方向"的结构。
- 本项目的事件/流式域:
  - `call:*` 信令 = **WebSocket 双向 + 服务端推**;
  - `message.send`/`ack` = **WS 上行 + 应用层 clientMsgId 配对**;
  - agent RAG = **SSE 服务端流式**;
  - presence/read = **事件广播**。
- 这些都在"事件流"范式里,**OpenAPI 描述不了**(换原生 WS 也一样,是范式问题不是库问题)。所以它们的契约**只能留在 proto**(或未来 AsyncAPI),与 REST 实体迁 OpenAPI **互不重叠、各管一摊**。

```
REST 接口(一问一答) ─→ OpenAPI(openapi/openapi.yaml)
数据形状(JSON Schema)─→ REST 与事件 payload 复用
事件/流式契约         ─→ proto(call/agent/message-WS/presence/read)
```

---

## 3. agent-server 分析:零影响,不需改

agent-server(独立仓 `/Users/mac/agent-server`,NestJS Agent/RAG)是**第二个消费方**,按"两仓同属一项目、契约统一"必须纳入核查。逐项核实如下:

| 核查项 | 结果 | 含义 |
|---|---|---|
| 它的 proto 源 | **自己仓独立一份** `proto/ourchat/agent/v1/agent.proto`,**只有 agent 域,无 REST 实体** | 与我们仓的 `proto/` 不共享文件 |
| 它的 buf 配置 | **自己的** `buf.yaml`(指自己 `proto`)+ `buf.gen.yaml`(ts-proto → `apps/node-server/src/contracts/gen`) | 独立生成,与我们仓 buf **零关联** |
| 它 import 的契约 | **仅 `contracts/gen/ourchat/agent/v1`**;`Message/User/Conversation/Friend` **一个都不引** | 不碰被迁/被删的 REST 实体 |
| 它的接口范式 | Agent/RAG 走 **SSE(流式)** | 本就该留 proto,OpenAPI 无关 |

**推论**:我们的迁移动的是 our-chat 仓的 REST 实体 + 删对应 proto;`agent.proto` 没动、agent-server 也不消费那些 REST 类型 → **对 agent-server 零影响,确实不用改**。

> 诚实补一句:这个"不用改"是**核查后确认的**,不是迁移时就考虑到的——当初下"四端完成"结论时**漏了主动核第二个仓**,属流程疏漏(已纠正,纳入本报告)。

---

## 4. 既有隐患:`agent.proto` 两仓副本重复

核查中发现:`ourchat/agent/v1/agent.proto` 在**两个仓各存一份副本**:
- our-chat:`proto/ourchat/agent/v1/agent.proto`
- agent-server:`proto/ourchat/agent/v1/agent.proto`

二者是**独立维护的两份**,改 agent 契约时**要手动同步两边**,否则漂移。这是**既有问题、非本次迁移引入**,但属"契约统一"还没做干净的地方。

**可选治理方案对比:**

| 方案 | 做法 | 取舍 |
|---|---|---|
| 维持两份副本(现状) | 各仓各放,改时手动同步 | 零改造;但易漂移,违背单一真相 |
| **共享 proto 模块** | 抽 `agent.proto` 到一个共享位置(git submodule / buf BSR 模块 / 私有包),两仓引用同一份 | 真单源;需建共享机制,两仓 buf 都改 `buf.yaml` 指向 |
| BSR 托管 | 把 agent 契约推到 Buf Schema Registry,两仓 `buf.yaml` 依赖该模块 | 最"正"、带版本与 breaking 检测;需 BSR 账号/流程 |

建议:若 agent 契约会持续演进,走 **BSR 托管或共享模块**;若稳定,维持两份 + 在改动 checklist 里强制"两仓同步"。

---

## 5. buf 生成确定性:CI 误红的真因与治本

### 5.1 现象
CI(`.github/workflows/proto.yml`)跑 `buf generate` 后 `git diff --exit-code` 判失败,diff 出现在 `google/protobuf/timestamp.ts`——**只是 WKT 的注释文案变了**(如"Must be between…" → "Must be from…")。

### 5.2 根因:远程插件没锁版本
`buf.gen.yaml` 里写的是 **不带版本**的远程插件:
```yaml
- remote: buf.build/community/stephenh-ts-proto   # ← 没有 :vX.Y.Z
- remote: buf.build/protocolbuffers/go            # ← 同上
```
`buf generate` 因此**每次拉最新**插件。插件一升级,即便 `.proto` 没改,**生成输出也会变**(WKT 注释、格式细节等)→ 与仓库里提交的 gen 不一致 → `git diff --exit-code` 红。

> 这是**非确定性生成**:同样的输入(.proto)+ 不同时间 = 不同输出。CI 把"输出漂移"误判成"开发者忘了提交生成物"。**与本次 OpenAPI 迁移无关**,是这套生成管线一开始就埋的脆弱性。

### 5.3 治本:锁版本
把插件锁到**当前提交 gen 所用的版本**(从 gen 文件头读出:`protoc-gen-ts_proto v2.11.8`、`protoc-gen-go v1.36.11`):
```yaml
- remote: buf.build/community/stephenh-ts-proto:v2.11.8
- remote: buf.build/protocolbuffers/go:v1.36.11
```
锁后 `buf generate` 输出**确定** = 提交的 gen → `git diff --exit-code` **恒过**。升级插件成为**显式、可评审**的动作(改版本号 + 一次性重生成提交),而非随机漂移。

| 维度 | 不锁版本(原) | 锁版本(治本) |
|---|---|---|
| 生成确定性 | ✗ 随插件更新漂移 | ✓ 确定可复现 |
| CI 稳定性 | ✗ 插件升级即误红 | ✓ 不误红 |
| 升级插件 | 隐式、不可控 | 显式改版本号 + 重生成,可评审 |
| breaking 风险 | 静默引入 | 锁定基线,升级时对比 |

> 同理 `止血`(直接提交漂移产物)只是把这次红消掉,下次插件再升又红——**不治本,不取**。

---

## 6. 两仓契约同步原则(沉淀)

- **改 REST 实体**:只改 `openapi/openapi.yaml`,各端再生成(our-chat 内)。
- **改事件/流式契约**:改 `proto/`(our-chat),`buf generate`;**若涉及 agent 域,两仓 `agent.proto` 必须同步**。
- **改 buf 生成管线**:锁定版本;升级插件 = 改版本 + 重生成 + 提交(显式)。
- **跨仓**:our-chat 与 agent-server 同属一项目;任何**共享契约**的改动两仓同步,不可只改一边(本次 agent-server 核查即落实此原则)。

---

## 7. 当前 proto 端到端状态(落地后)

| 端 | 是否消费 proto | 消费哪些域 | 备注 |
|---|---|---|---|
| our-chat web | 是 | `call`、`message`(WS:SendMessageInput/Ack)、`agent` | REST 实体已转 OpenAPI |
| our-chat server | 否(0 业务引用) | — | 生产方,Prisma+zod;proto gen 仅历史产物 |
| our-chat gateway | 否(0 业务引用) | — | WS 中继;go gen 存在但未用 |
| our-chat mobile-swift | **否** | — | 已删 SwiftProtobuf,REST 走 OpenAPI;事件域 socket 用手写解析 |
| **agent-server** | 是 | **仅 `agent`** | 独立 proto + 独立 buf,SSE 流式 |

> 观察:our-chat 的 `gateway` go gen 与 `server` ts gen 里仍含**事件域**类型,部分未被业务消费(类似历史死代码),但**保留无害**且 `buf generate` 会持续产出;真要清理可再裁,但不在本次范围。

---

## 8. 结论与建议

1. **proto 不废弃**——瘦身为"事件/流式契约层";REST 实体归 OpenAPI,二者零重叠。
2. **agent-server 不需改**——独立 proto、只用 agent 域、SSE 流式,与 REST 迁移正交。
3. **buf CI 误红已治本**——锁定 ts-proto v2.11.8 / protoc-gen-go v1.36.11,生成确定化。
4. **待办(可选)**:`agent.proto` 两仓副本 → 走 BSR/共享模块单源;our-chat 内未消费的事件 gen 可按需再裁。
