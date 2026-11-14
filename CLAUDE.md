# our-chat — AI 工作入口

> 全局行为约束见 `~/.claude/CLAUDE.md`。本文件只给：定位 + 服务地图 + 跨服务约束 + Git 规范 + 文档规范 + 各服务入口。
> 重构计划与跨服务鉴权方案文档在 **agent-server 仓库** `docs/项目重构方案/`、`docs/跨服务鉴权方案/`。

## 这是什么
实时 IM + WebRTC 音视频通话。**本项目横跨两个仓库，同属一个项目**：
- `talqora`（本仓）：多语言 monorepo（`biz/`+`gateway/`+`web/`+`mobile-swift/`），分支 `dev`。
- `agent-server`（**独立仓库**）：Python RAG 微服务（`apps/rag-server` + `packages/agent-core`）。

> **两仓属同一项目**：契约统一、分支合并、分支纪律等项目级操作两仓必须同步，勿只动一边、勿遗忘 agent-server。

## 服务地图
| 服务 | 栈 | 说明 |
|---|---|---|
| `biz/` | Go(gin + gRPC edge) + pgx + go-redis | 业务/信令/OAuth IdP/发号，模块化单体、多副本无状态（唯一业务层实现） |
| `gateway/` | Go 1.25 + gorilla/websocket + gRPC + JWT + Prometheus | 长连接网关（见 `gateway/CLAUDE.md`） |
| `web/` | React + Redux Toolkit + antd + 原生 WebSocket + i18next | Web 端（见 `web/CLAUDE.md`） |
| `mobile-swift/` | iOS Swift | 移动端 |
| `agent-server` | Python + FastAPI + SQLAlchemy + Milvus + Pulsar | Agent/RAG 微服务（**独立仓库**，非本仓目录） |

> Node + Socket.io 版业务层（原 `server/`）已于 2026-09 下线并删除。看到任何以它为前提的文档/分支/脚本，一律视为过期。

## 跨服务约束
- **鉴权走 JWKS**：our-chat 自身是 IdP（签发 JWT），下游（agent-server 等）用 JWKS 公钥验签。改鉴权先读 `跨服务鉴权方案/方案D-非对称密钥JWKS.md`。
- **重构分阶段推进，不砍既有功能**；长连接统一走 Go `gateway/`。
- 实时层：客户端经 `gateway/` 原生 WebSocket 接入，上行经 gRPC 双向流到 `biz`，下行经 gRPC 流定向投递、失败回退 Redis pub/sub。
- 消息可靠性/时序见 `docs/架构/消息同步架构分析-为什么不用消息队列-三段式同步与队列边界.md`。

## Git 规范
- **分支合并一律 `git merge --no-ff`**，保留显式 merge commit（集成点拓扑）；**不要 fast-forward 压平**成线性历史，**不要 rebase 改写**已共享提交。
- 特性开发走专用分支（如 IDL→`feat/idl-contracts`、iOS→`ios`），不直接动 `main`/`master`；合并后专用分支可保留。
- 项目级合并（如 IDL）**两仓同步处理**：our-chat 与 agent-server 都要合，别只合一边。
- 不主动 push，除非显式要求。

## 文档规范
技术/设计/方案文档（尤其交付评审的）默认按"深"写，硬性三条：
- **术语详解**：出现的专业名词/缩写给全称 + 通俗解释（必要时配术语表），读者不必另开搜索。
- **原理讲透**：不止"做什么"，要讲"怎么做 / 为什么"——机制如何运作、底层原理、设计动机。
- **方案对比**：列候选方案的 tradeoff（表格优先：维度 × 方案），并说明为何选当前方案。
- 深度给在技术原理与权衡上；不写"大厂比我们强"之类无关营销修饰。
