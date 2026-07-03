# 四端 IDL 统一落地复盘 —— REST 实体迁 OpenAPI

> 范围:复盘"把 our-chat 的 **REST 接口契约**从 proto 统一到 **OpenAPI**"这件事——为什么做、根因、各端怎么落地、过程中翻出并修了哪些真问题、验证到什么程度、还差什么。与选型三篇(《跨端 IDL 与代码生成选型分析》《实时通信契约边界》《buf 与 OpenAPI 对比》)互补:那三篇是"该选什么",本篇是"实际做了什么 + 发现"。proto 的去向单独见《proto 去向与治理》。
> 结论先行:**问题不在 buf、也不在 proto,而在"用二进制 IDL 工具链配 JSON 传输,且 Swift 是 Protobuf 阵营的弱项"**。解法是让 **OpenAPI 当 REST 实体的单一契约源**,iOS 用官方 `swift-openapi-generator` 拿到惯用 Codable(从最痛变最省)。两个**消费端(iOS、web)真迁移并过编译/单测**;server 是生产方,用**契约测试**校验真实响应符合契约;gateway 不消费 REST 实体。事件/流式域留 proto。

---

## 0. 术语表(先读)

| 术语 | 全称 / 含义 | 通俗解释 |
|---|---|---|
| **IDL** | Interface Definition Language | 与语言无关的接口/数据定义,写一次生成各端代码。 |
| **codegen 插件** | — | 真正把 IDL 翻成某语言代码的程序。**同一份 IDL,换插件 = 换产物形状**。 |
| **ts-proto** | `protoc-gen-ts_proto` | 把 proto 生成**惯用 TS interface**(JSON 友好)。web/server 用它,顺。 |
| **SwiftProtobuf** | `buf.build/apple/swift` | 把 proto 生成**二进制消息类**(非 Codable、`xxxId`→`xxxID`)。为二进制/gRPC 设计,对 JSON-REST 别扭。 |
| **swift-openapi-generator** | Apple 官方 | 读 OpenAPI 生成**惯用 Codable + 客户端**。Swift 在 OpenAPI 阵营的一等公民。 |
| **OpenAPIRuntime** | Apple 官方 | swift-openapi-generator 产物依赖的小运行时(承载生成类型/传输)。 |
| **openapi-typescript** | — | 读 OpenAPI 生成 TS 类型(`components['schemas']`)。 |
| **DTO** | Data Transfer Object | 专门收发网络数据的结构体;iOS 迁移前手写了一批。 |
| **信封(envelope)** | — | 本项目 REST 统一外壳 `{ success, data, message }`;OpenAPI 只描述 `data` 的类型,解信封逻辑不变。 |
| **契约测试(contract test)** | — | 用真实处理器输出断言其符合契约的测试,闭合"生产方实际响应 ↔ 消费方所用类型"。 |
| **nullable** | — | 字段可为 `null`。proto3 标量默认非空,但 DB/线上常发 `null` —— 二者有出入(本次关键坑)。 |
| **单一真相(single source of truth)** | — | 同一实体只有一处权威定义,各端由它生成,杜绝多份手写/多端漂移。 |

---

## 1. 问题:为什么要做这件事

迁移前的现状(由审查得出):

1. **同一 REST 实体存在"两份被消费的类型定义"**:iOS 一份(手写 DTO,旁边还躺着没人用的 SwiftProtobuf `.pb.swift`)、web 一份(ts-proto 生成)。改线上字段时,iOS 手写结构会**悄悄漂移**——这正是 IDL 要防的事,却在 iOS 这端失守。
2. **iOS 的 proto 生成物是纯死代码**:`.pb.swift` 零业务引用,还为此白链 SwiftProtobuf 依赖;iOS 实际走手写 DTO。
3. **连生成的字段名都分叉**:SwiftProtobuf 把 `client_msg_id` 生成 `clientMsgID`(大写 ID),web 的 ts-proto 是 `clientMsgId`(小写)。同一 IDL,两端属性名不一致。

**触发问题的根本**:用 Protobuf(二进制 IDL)描述 JSON-REST 传输,而 **Swift 在 Protobuf 阵营没有一等的"出惯用 Codable"生成器**(只有为二进制设计的 SwiftProtobuf)。于是 iOS 要么手撕 DTO(漂移),要么吞下别扭的二进制类。

---

## 2. 根因:各端 codegen 插件不同

`buf.gen.yaml` 同一份 proto、各端不同插件:

| 端 | 插件 | 产物 | JSON-REST 体验 |
|---|---|---|---|
| server / web | `ts-proto`(`onlyTypes,forceLong=number`) | 惯用 JSON interface,int64→number | 顺 |
| gateway | protocolbuffers/go | 惯用 Go struct | 顺(但其实不消费 REST) |
| **mobile-swift** | **SwiftProtobuf** | **二进制消息类**(非 Codable、命名分叉、`Int64`/`Struct`/`Timestamp` 笨重) | **别扭** |

**实测佐证**:用 SwiftProtobuf 生成的 `Ourchat_Message_V1_Message(jsonString:)` 能解线上 JSON,但要再映射成 UI 模型、字段名 `senderID` 与 web 分叉、`@unchecked Sendable` + 存储类给 Swift 6 严格并发添噪。**能用但形状别扭**——这就是 iOS 弃之手写 DTO 的根因。

---

## 3. 解法:OpenAPI 当 REST 实体单一契约源

- **`openapi/openapi.yaml`** 成为 **REST 实体的唯一定义**(User/Message/FileInfo/Conversation/UserConversation/Friend/FriendInfo/FriendRequest/SearchUserResult/UploadResult 等)。
- 各端从它生成:iOS `swift-openapi-generator`(惯用 Codable)、web/server `openapi-typescript`。
- **关键收益**:iOS 从"Protobuf 阵营最痛"变成"OpenAPI 阵营最省"——`swift-openapi-generator` 是 Apple 官方,出 `Codable`,直接落进现有 `APIResponse<Decodable>` 解码路径,**手写 DTO 整批删除**,`senderId` 也不再是 `senderID`。
- **边界**:只迁 REST 实体;**事件/流式域留 proto**(见《proto 去向与治理》)。

---

## 4. 各端落地(实际做了什么)

| 端 | 角色 | 动作 | 门禁 |
|---|---|---|---|
| **mobile-swift** | 消费方 | `swift-openapi-generator` 生成 `Types.swift`;加 `Aliases.swift`(`APIUser`/`APIMessage`…);**6 个 client(Upload/Me/Search/FriendRequest/Contacts/Chat)全改用生成 Codable**;**删 8 个 `.pb.swift` + SwiftProtobuf 依赖**,换 `OpenAPIRuntime`;加 ISO8601 date 解码策略 | **84 单测 ✓** |
| **web** | 消费方 | `openapi-typescript` 生成 `schema.d.ts` + `index.ts` 具名再导出;**`globalType/{user,message,chat,friend}.ts` + `friendStore.ts` 的 REST 实体改从 OpenAPI 取**;修 `useCall`/`chatView`/`directoryView` 等消费方的真实空值适配 | **tsc 0 + 53 单测 ✓** |
| **server** | **生产方** | Prisma+zod,不消费客户端类型;加 `test/contract.openapi.test.ts` **用真实处理器输出断言符合生成类型**(int64→number、Date→ISO、nullable) | **typecheck + 163 单测 ✓** |
| **gateway** | WS 中继 | **零 REST 消费**,不生成 OpenAPI | go build ✓ |

> 真正"消费" REST 实体类型的只有 **iOS、web 两端**;server 是生产方(契约测试闭环),gateway 不消费。所以"四端统一"=**两消费端迁 OpenAPI + 生产方契约校验 + 中继确认无需接**。

---

## 5. 过程中翻出并修的真问题(复盘重点)

迁移不是"换皮",自主测试/审查把几处**真实正确性问题**暴露了:

### 5.1 nullable 准确性(最关键)
proto 把 `email/avatar/nickname` 等声明成**非空 string**,但服务端实际下发 **nullable**(DB 可空)。OpenAPI **如实标 nullable**。于是把 web 切到 OpenAPI 类型时,**级联触发了消费方的真实空值未处理**(`useCall` 建 `CallUser` 时 `nickname/avatar` 可能 null、`chatView` 的 `fileInfo` 字段可空、`directoryView` 的 `friendInfo` 可空)。这是**正确性提升**(proto 之前的"非空"是失真),逐处用 `?? ''`/默认值/守卫修掉。

### 5.2 lastMessages 是原生 SQL snake_case
`/user/lastMessages` 走 `$queryRaw`,返回**原生 snake_case 行**(`conversation_id`…),与其余 Prisma camelCase 不同。直接当 `Message`(camelCase)解会缺字段。**单独建 `MessagePreview` schema**(只取 content/type/timestamp,其余键被忽略),精确匹配该接口实际产出。

### 5.3 生成 Date 字段需 ISO8601 解码策略
生成类型的 `timestamp/createdAt/...` 是 `Foundation.Date`,而普通 `JSONDecoder` 默认按**数字**解 Date,遇 ISO 字符串会炸。**给 APIClient 的 decoder 加自定义 `.iso8601`(含毫秒兜底)策略**。并补了"服务端完整 message(含 `extra:{}`、`fileInfo:{}`、`editHistory:[]`、毫秒时间戳)能正确 decode"的高风险用例。

### 5.4 字段超集与 required 取舍
web 会**构造**完整实体对象(带 `isEdited/isDeleted/editHistory/nextSeq/lastReadSeq/...` 等 proto 字段),OpenAPI schema 起初缺这些 → TS "excess property" 报错。**把 schema 补成实体超集**(这些字段确实存在,补为可选);并把 `Conversation.id` 由可选改回 required(真实数据恒有,顺手修 iOS 测试桩)。

### 5.5 信封不进 OpenAPI
`{success,data,message}` 外壳**不让 OpenAPI 描述**,只描述 `data` 的类型,沿用现有 `sendUnwrapping` 解信封——最省、零改造解码主路径。

---

## 6. 验证(到什么程度)

| 层级 | 做了 | 没做 |
|---|---|---|
| 编译 | iOS/web/server/gateway 全过 | — |
| 单测 | iOS 84、web 53、server 163 全绿 | — |
| **契约闭环** | server 契约测试:`userConversations`/`messages` 的**真实处理器输出**符合生成类型(走了 `bigint→number` 序列化) | 仅覆盖 2/约12 端点;其余靠各端单测里的代表性 JSON |
| 端到端运行时 | — | **未做**:没有真 DB/Redis/模拟器跑"登录→拉消息→收发"完整链路 |

> 诚实边界:验证到**编译 + 单测 + 契约测试**这一层;**端到端运行时未验证**(环境限制)。"生成类型解真实响应"由代表性 JSON(对照路由源码写)+ 1 个真实输出契约测试保证,非抓真流量逐端点校验。

---

## 7. 单一真相纪律 + 未尽事项

**纪律(沉淀到 `openapi/README.md`):**
- 改 REST 实体形状 → 只改 `openapi/openapi.yaml`,各端再生成。
- 改事件类型 → 改 `proto/`,`buf generate`(已锁版本,确定性)。
- 二者**零重叠**:REST 实体只在 OpenAPI;事件只在 proto。

**未尽事项:**
1. **server 还可更进一步("真接入"升级)**:目前 server 是"契约测试校验输出";更彻底是 **`zod → OpenAPI`**——服务端已用 zod 校验入参,用 `zod-to-openapi` 让 **OpenAPI 由 zod 派生**,使"运行时校验"与"跨端契约"**同源**(本仓特有红利,见《buf 与 OpenAPI 对比》§4.3)。本次未做。
2. **契约测试覆盖度**:从 2 端点扩到全部 REST 端点,用真实输出逐个校验。
3. **端到端**:补一条 live 链路验证(起服务 + 真实登录→拉消息→收发)。
4. **gateway/server 的事件 gen** 里未消费的历史类型可按需再裁(无害,非必须)。

---

## 8. 一页结论

- **病根**:二进制 IDL(Protobuf)配 JSON 传输,且 **Swift 是 Protobuf 阵营弱项**(无一等 Codable 生成器、命名分叉)。
- **解法**:**OpenAPI 当 REST 实体单一源**,iOS 用 `swift-openapi-generator`(从最痛变最省),消除"两份被消费的类型"。
- **落地**:iOS、web 两消费端真迁 + 过编译/单测;server 契约测试闭环;gateway 不消费;事件域留 proto。
- **不是换皮**:迁移翻出并修了 nullable 失真、lastMessages snake_case、Date 解码、字段超集等**真实正确性问题**。
- **边界**:验证到编译+单测+契约测试;端到端未验;server `zod→OpenAPI` 与契约全覆盖是后续增量。
