# talqora 业务层（`biz/`）

> 范围：`biz/` 这个 Go 模块化单体——HTTP 面（gin）、gRPC edge 流面、`service` 领域逻辑、`store` 数据访问、`oauth` IdP。网关见 [03-talqora网关与基础设施](./03-talqora网关与基础设施.md)，部署配置见 [01-部署配置与密钥](./01-部署配置与密钥.md)。
>
> 证据来源：只读代码 + 实际执行（`go vet ./...`、`go test ./...`、`go test -cover`、最小复现程序）。凡标「已实测」的结论都附了复现方法。
>
> 卫生状况先说明：`go vet ./...` 零告警；`go test ./...` 全绿（`service` 28.7%、`api` 3.8% 语句覆盖率）；全仓无 `TODO`/`FIXME`。下面的问题都不是「代码写得脏」，而是**边界与契约层面漏掉的检查**。

## 0 一段话总评

`biz` 的分层是对的，问题全部出在「谁有权访问哪个会话」这条线上。

七个与会话相关的端点分成两半：`/user/userConversations`、`/user/sync`、`/user/read`、`/user/readCount` 都校验了归属，而 `/user/messages`、`/user/conversations`、`/user/lastMessages` 一个都没校验——那三个的 SQL 里 `WHERE conversation_id = $1` 就是全部条件。会话 ID 是可预测字符串（`single_<小id>_<大id>`、`group_<id>`），所以任何登录用户都能读到任意两人的私聊内容。

写侧反过来：实时通道的 `read.report` 校验了成员，`message.send` 没校验。

再叠上第三个问题：Web 端按 OpenAPI 发数字 `userId`，Go 侧把它绑成 `string`，bind 错误又被 `_ = c.ShouldBindJSON` 吞掉——好友与建会话四个功能在 Web 端正恒 403，而且不会报错，只会「点了没反应」。

四个 S 级问题里有三个是同一个根因：**没有一个统一的「会话访问控制」入口，每个 handler 各自决定要不要检查**。补四个 `if` 只是止血，真正的修法是抽一个所有会话相关端点都必经的校验函数。

其余 9 个 I 级问题集中在发号（多副本键重建竞态）、缓存（四个无界 `sync.Map`）、限流（`X-Forwarded-For` 可伪造）与上传（单请求 100MB 全量入内存）四处，都属于「当前量级下不出事、量涨 10 倍先坏这里」的类型，正好是校招计划证据线二要回答的问题。

## 1 问题清单

### 严重

#### BZ-S1 三个读端点没有会话归属校验，任意用户可读任意会话消息（已核实）

**现象。** 任意已登录用户传一个 `conversationId`，就能拿到该会话的全部消息、元信息与最后一条消息。

**证据。**

| 端点 | 代码位置 | 实际执行的 SQL 过滤条件 | 是否有归属校验 |
|---|---|---|---|
| `GET /user/messages` | `biz/internal/api/chat_routes.go:117`（全量分支 `:127`，分页分支 `:157-166`） | `WHERE conversation_id = $1` | **无** |
| `GET /user/conversations` | `biz/internal/api/chat_routes.go:86` | `WHERE id = ANY($1::text[])` | **无** |
| `GET /user/lastMessages` | `biz/internal/api/chat_routes.go:223` | `WHERE conversation_id = ANY($1::text[])` | **无** |
| `GET /user/userConversations` | `biz/internal/api/chat_routes.go:53` | `WHERE user_id = $1`，且先比对 `CurrentUser().ID` | 有（`:55`） |
| `GET /user/sync` | `biz/internal/api/sync_routes.go:72` | — | 有 |
| `POST /user/read` | `biz/internal/api/sync_routes.go:138` | — | 有 |
| `GET /user/readCount` | `biz/internal/api/sync_routes.go:177` | — | 有 |

`handleMessages` 的入参校验只有「非空」这一处：

```117:122:biz/internal/api/chat_routes.go
func handleMessages(c *gin.Context) {
	conversationID := c.Query("conversationId")
	if conversationID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "缺少 conversationId 参数"})
		return
	}
```

**原理。** 会话 ID 不是随机值，是**可推导的确定性字符串**：单聊是 `single_<minId>_<maxId>`（`service/message.go:247-262` 的 `DeriveParticipants` 就靠这个规则反解双方），群聊是 `group_<groupId>`。用户 ID 是自增 BIGINT，遍历成本极低。所以「知道会话 ID 就等于有权限」在这里完全等价于「没有权限控制」。

**后果。** 任意注册用户（注册接口本身是开放的，见 `auth_routes.go:30`）可以：

1. 遍历 `single_1000_1001` … `single_10300_10301`，读出全站私聊历史；
2. 遍历 `group_1` … `group_N`，读出全部群消息；
3. 通过 `/user/lastMessages` 批量拿每个会话的最新一条，做全站内容快照。

这是**不可接受级别的数据泄露**，且不需要任何特殊手段，一个 `curl` 循环即可。

**修复。**

1. 在 `service` 里加一个公共入口（已有 `IsConversationMember`，`service/read.go:15`），在 `api` 层包成中间件：

   ```
   RequireConversationMember(convIDFromQuery) → 非成员一律 403
   ```

2. 三个端点全部挂上；`handleLastMessages` 与 `handleConversations` 接收的是**数组**，必须逐个校验并在响应里静默剔除无权项（不要返回「哪几个无权」，避免信息泄露）。
3. 根本做法：把「当前用户 → 可访问会话集合」变成一个显式概念（例如 `user_conversations` 上的视图或 `service.AccessibleConversations(userID)`），所有会话查询都带 `AND conversation_id = ANY(可访问集合)`。这样即使以后新增端点忘了校验，SQL 层也不会越权。

**验证。** 用两个账号 A、B，A 请求 `conversationId=single_<B>_<C>`（C 为第三人）：修复前返回 200 + 消息列表，修复后返回 403。把这条写成端到端用例（见 [07 分册](./07-测试与质量门禁.md)）。

#### BZ-S2 好友/会话写接口把 `userId` 绑成 `string`，Web 传数字导致恒 403（已实测）

**现象。** Web 端「加好友」「改备注」「回复好友请求」「点发消息建会话」四个功能全部失败，且前端不报错（因为调用点没有 `.catch`，见 WEB-I1）——表现为「点了没反应」。

**证据。**

Go 侧四处把 `userId` 声明为 `string`，并用 `_ = c.ShouldBindJSON(&body)` 丢弃绑定错误：

| 位置 | 结构体定义 | 吞错 | 后续校验 |
|---|---|---|---|
| `handleAddFriend` | `biz/internal/api/friend_routes.go:141` | `:144` | `:145` 字符串比较 |
| `handleUpdateRemark` | `friend_routes.go:191` | `:195` | `:196` |
| `handleReplyFriendReq` | `friend_routes.go:302` | `:306` | `:308` |
| `handleUpdateConversationTime` | `chat_routes.go:197` | `:199` | `:200` |

Web 侧按 `number` 发送（`web/src/globalApi/friendApi.ts:25-27、33-35、37-39`，`chatApi.ts:29-31`）：

```25:27:web/src/globalApi/friendApi.ts
export const addFriend = ({userId, friendId}: {userId: number, friendId: number}) => {
    return put<void, { userId: number; friendId: number }>(`/user/addFriend`, { userId, friendId });
}
```

契约自身也矛盾：`openapi/openapi.yaml:189` 把 `userId` 定义为 `integer`，而 `:234` 定义为 `string`。

**原理（已实测）。** Go `encoding/json` **不允许**把 JSON number 解进 `string` 字段，会返回 `*json.UnmarshalTypeError` 且该字段保持零值。用一个最小程序验证：

```go
type body struct {
    UserID   string `json:"userId"`
    FriendID string `json:"friendId"`
}
json.Unmarshal([]byte(`{"userId":10301,"friendId":10302}`), &b)
// 输出：err=json: cannot unmarshal number into Go struct field body.userId of type string
//       userId="" friendId=""
```

`ShouldBindJSON` 返回了这个错误，但被 `_ =` 丢弃。于是 `strconvFormatInt(CurrentUser(c).ID) != body.UserID` 变成 `"10301" != ""` → 恒真 → **恒 403**。同一处理里 `friendID, _ := strconv.ParseInt(body.FriendID, ...)` 也会得到 `0`。

**后果。** 四个功能完全不可用。更糟的是**故障不可见**：HTTP 状态是 403 且 body 是规范 JSON，监控上看不出异常，前端也吞掉了 rejection。

**修复。**

1. 四处改为 `UserID int64` / `FriendID int64`，并**不再吞错**：

   ```go
   if err := c.ShouldBindJSON(&body); err != nil {
       invalidParams(c, ...); return
   }
   ```
2. 统一 OpenAPI：`userId`/`friendId` 全部 `integer, format: int64`，并给 `updateRemark`、`updateConversationTime` 补上定义（当前缺失，见 LEG-I3）。
3. 补一条跨层契约测试：用 Web 真实的 payload（数字）打 `httptest`，断言 200。这条测试同时会覆盖 BZ-S1。

**验证。** 修复后 `PUT /user/addFriend {"userId":<自己>,"friendId":<他人>}` 返回 `success:true`；并且在 `go test ./internal/api/` 里有一条以此 payload 为输入的用例。

#### BZ-S3 `message.send` 不校验发送者是会话成员，可向任意会话注入消息（已核实）

**现象。** 实时上行帧 `message.send` 只校验 `clientMsgId` 与 `conversationId` 非空、长度合法（`realtime/handleUplink.go:67-84`），拿到 `conversationId` 就直接落库并扇出。

**证据。**

```122:131:biz/internal/realtime/handleUplink.go
senderID := uctx.UserID
participants, err := service.GetConversationMembers(ctx, in.ConversationID, senderID)
if err != nil {
    ...500...
}

res, err := service.PersistMessage(ctx, service.PersistMessageInput{
    ConversationID: in.ConversationID,
    SenderID:       senderID,
    ...
```

`GetConversationMembers` 只**返回**成员列表，不做校验：群聊走 `SELECT user_id FROM group_members WHERE group_id = $1`，为空时回落 `[senderID]`（`service/message.go:217-244`）。`PersistMessage`（`service/message.go:97-186`）也没有任何授权判断，而且 `ensureConversation`（`:74-89`）会在会话不存在时**直接创建**。

同一个文件里 `read.report` 是有校验的：

```220:226:biz/internal/realtime/handleUplink.go
member, err := service.IsConversationMember(ctx, uctx.UserID, in.ConversationID)
...
if !member {
    return UplinkResult{Status: 403, Body: map[string]any{"type": "message.error", "message": "无权操作该会话"}}
}
```

**原理。** 上行帧的身份来自网关握手时验签的 JWT（`biz/internal/realtime/handleUplink.go:16-20` 的 `UplinkContext`，不可伪造），所以「谁在发」是可信的；缺的是「他能往这个会话发吗」。群聊场景下 `participants` 是**真实成员列表**，所以攻击者发一条消息会落库并被扇出给所有真实群成员——这既是注入，也是骚扰。

**后果。**

1. 任意用户可向任意群/单聊注入消息，且以真实成员为接收人；
2. 可凭空创建会话（`ensureConversation`），配合 `/user/sync` 的群聊分支还能读到部分内容；
3. 污染消息表与 `seq`：注入会消耗 `seq`，导致真实客户端看到空洞并触发补拉，放大读流量。

**修复。** 在 `handleMessageSend` 的 `participants` 取回之后插入成员校验（复用一个 `/read.report` 已在用的函数），并去掉 `GetConversationMembers` 在群成员为空时回落 `[senderID]` 的行为——那个回落让「向不存在的群发消息」变成了合法操作。

**验证。** 用非成员账号发 `message.send` 到 `group_1`：修复前返回 200 + `message.ack`，修复后返回 403 且不落库（`SELECT count(*) FROM messages WHERE conversation_id='group_1'` 不变）。

#### BZ-S4 通话信令缺少被叫存在性与身份校验（已核实）

**现象。** `call:start` 只检查 `calleeID > 0`；`call:accept` 完全不检查接听者是不是被叫本人。

**证据。**

- `call:start`：`biz/internal/realtime/callRelay.go:25-26` 仅 `parseID` + `calleeID > 0`，随后直接 `TryCreateSession` 并 `PublishDownlink(calleeID, "call:start", ...)`（`:53`）。没有校验 callee 是否存在、是否是好友、是否在黑名单。
- `call:accept`：`callRelay.go` 的 `case "call:accept"` 分支调用 `service.MarkAccepted(ctx, callID, uctx.DeviceID)`——只传 `callID` 与设备号，**没有传 `uctx.UserID`**，因此无法判断接听者身份；随后把 `toID`（来自帧内、攻击者可控）作为投递目标：`_ = service.PublishDownlink(ctx, toID, "call:accept", rawJSON(data), nil)`。

**原理。** `callId` 由客户端生成并放进帧里，格式在 `perf/call-rejoin-probe.mjs:13` 可见：`call_<小id>_<大id>_<时间戳>`。它可预测、可枚举。一旦猜到别人正在振铃的 `callId`，就能用任意账号「接听」这次通话，并把 `call:accept` 投给任意 `toID`。

**后果。** 三方中间人可劫持信令；补上 WebRTC 的 SDP/ICE 交换后，实际媒体也可能被引导到攻击者。此外，非好友之间可以任意呼叫（骚扰），且被叫是否在线、是否存在都不影响发起。

**修复。**

1. `call:start` 校验：被叫存在（`SELECT 1 FROM users WHERE id=$1 AND status<>'offline'?` 至少要存在）、双方是 accepted 好友（`friendships` 双向行）、被叫未在黑名单。
2. `MarkAccepted` 签名加上 `calleeID`，SQL 带 `WHERE call_id=$1 AND callee_id=$2 AND status='ringing'`，`RowsAffected==0` 即拒绝。
3. `call:accept` 的投递目标改为「从会话里读出的主叫 ID」，而不是帧内 `to`。

**验证。** 用非被叫账号发 `call:accept`，`callId` 取自另一对用户的真实通话：修复前主叫收到 `call:accept`，修复后返回 403 且主叫收不到。

### 重要

#### BZ-I1 发号快路径的「防回卷」在多副本下会产生重复号（已核实逻辑，未实测）

**现象。** `nextSeq` 的防回卷分支在检测到 Redis 键重建时**先 `DEL` 再回慢路径重新装载**，两个副本同时命中时会各自装载出同一个值。

**证据。** `biz/internal/service/seq.go:63-78`：

```63:78:biz/internal/service/seq.go
if _, ok := seqInitialized.Load(convID); ok {
    seq, err := rdb.Incr(ctx, key).Result()
    if err == nil {
        if last, ok2 := convLastSeq.Load(convID); !ok2 || seq > last.(int64) {
            ...
            return seq, nil
        }
        slog.Warn("seq 疑似键重建,回慢路径重新装载", "conv", convID, "seq", seq)
        _ = rdb.Del(ctx, key).Err()
    }
    seqInitialized.Delete(convID)
}
```

**原理。** 假设副本 A、B 的 `convLastSeq[conv]` 都是 100，Redis 重启后键丢失：

1. A `INCR` → 1，`1 <= 100` 判为重建，`DEL`，慢路径从 PG 装载 100，`Lua SET 100 + INCR` → 101；
2. B 在 A 的 `DEL` 之前 `INCR` → 2，同样判为重建，也执行 `DEL`；如果这次 `DEL` 落在 A 完成 `SET 100` 之后，就会把 A 刚建好的键删掉；
3. B 慢路径再从 PG 装载 100 → **也拿到 101**。

第 2 步的 `DEL` 还有第二种伤害：它可能删掉其它副本刚刚正确初始化的键，把「一次重建」放大成「反复重建」。

**后果。** 同一会话出现重复 `seq`。客户端靠 `seq > since` 做增量同步，重复 `seq` 会导致其中一条**永久不可见**（`seq > since` 恒不成立）。这正好是校招计划证据线一要证明的「消息不重不乱」的反面。

**修复。** 慢路径不要「先删再装载」，改成一个原子 Lua：`SET key (GREATEST(现有值, 装载值))` 之后再 `INCR`，把「判重建 + 重置基线 + 自增」收敛成一次脚本执行；或者在慢路径上用 `SET key init NX`（仅当键不存在时装载）+ `INCR`，避免主动删除。

#### BZ-I2 四个进程内缓存无界增长（已核实）

**证据。**

| 缓存 | 位置 | 清理策略 |
|---|---|---|
| `seqInitialized` | `service/seq.go:90` | 无 |
| `convLastSeq` | `service/seq.go:93` | 无 |
| `convExistsCache` | `service/message.go:69` | 无 |
| `ucExistsCache` | `service/message.go:70` | 无 |

只有 `idemLocal`（`service/seq.go:155-181`）有容量护栏（超过 100 万整体清空）。

**原理与后果。** `convExistsCache` 与 `ucExistsCache` 的键是 `convID` 与 `"userId:convID"`。单聊会话数量随用户数平方增长——1 万用户就是最多 5 千万个潜在单聊，`ucExistsCache` 会随活跃用户对线性增长且永不释放。多副本部署下每个副本各存一份。

当前量级（3 个测试账号、几个群）不会暴露，量涨 10 倍时这会是「内存曲线只涨不跌」的第一嫌疑。这正是面试里「量涨 10 倍先坏哪里」要回答的问题，现在没有答案。

**修复。** 换成一个有界 LRU（例如 `hashicorp/golang-lru/v2/expirable`），或直接删掉本地缓存只走 Redis（多一次 RTT 换内存确定性）。至少在 `main.go` 里暴露一个 `/debug/cache-size`，把基数变成可观测指标。

#### BZ-I3 `X-Forwarded-For` 可伪造，登录限流可绕过（已核实）

**证据。** `biz/internal/api/middleware.go:175-189` 的 `clientIP` 无条件取 `X-Forwarded-For` 第一段；而 nginx 侧用的是 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`（`docker/nginx/conf.d/default.conf:35` 等），`$proxy_add_x_forwarded_for` 的语义是**在客户端自带值之后追加**，所以第一段永远是客户端自己写的。

同时 `router.go:23` 显式 `r.SetTrustedProxies(nil)`，即 gin 不相信任何代理——但 `clientIP` 又绕过了 gin 的判断直接读 header，两者自相矛盾。

**后果。** 攻击者每次请求带一个随机的 `X-Forwarded-For: <随机IP>`，每次都被当成新 IP，登录/注册限流（`middleware.go:148-170`）完全失效。暴力破解密码、批量注册账号都只受网络带宽限制。

**修复。** 二选一：

- **A（推荐）**：`SetTrustedProxies` 只信任 nginx 容器网段，然后直接用 `c.ClientIP()`（gin 会正确处理 `X-Forwarded-For` 的最右可信段），删掉自定义 `clientIP`；
- **B**：nginx 用 `proxy_set_header X-Forwarded-For $remote_addr;`（覆盖而非追加），业务层再读第一段。

两者不能混用——现在正是「nginx 追加 + 业务层读第一段」这个最坏组合。

#### BZ-I4 上传把整个文件读进内存，单请求可达 100MB（已核实）

**证据。**

- `biz/internal/api/router.go:32`：`r.MaxMultipartMemory = 100 << 20`（100MB 常驻内存阈值）；
- `biz/internal/api/upload_routes.go:47`：单文件上限 `100*1024*1024`；
- `biz/internal/api/upload_routes.go:57`：`data, err = io.ReadAll(f)` —— 全量读入 `[]byte`；
- 分片上传同样是 `io.ReadAll`（`upload_routes.go:163`）。

nginx 侧已把 `client_max_body_size` 调到 100m（`docker/nginx/nginx.conf:14`），所以请求能真的到达业务层。

**后果。** 10 个并发 100MB 上传 = 1GB 堆内存瞬时占用，容器（无内存 limit 设置，见 01 分册）会被 OOM killer 干掉。这不是理论风险：`docker-compose.prod.yml` 里 biz 没有 `mem_limit`，宿主机内存就是上限。

**修复。** 改成流式：`io.Copy` 到临时文件或直接 `PutObject` 分片，边写边累计字节数，超限立即中断并返回 413。图片转码（`imaging` 库）也应先检查尺寸再解码，避免「解压炸弹」。

#### BZ-I5 扇出路径有两处无效放大（已核实）

**证据与原理。**

1. **单聊不做在线收敛。** `realtime/handleUplink.go:150-160` 与 `service/push.go:52-64` 都用「会话 ID 首字符是否为 `g`」判断群聊；单聊分支直接把**全部成员**放进目标集合，不调 `FilterOnline`。于是给一个离线用户发单聊消息，仍会 `PUBLISH` 到 `gw:downlink`，网关找不到连接后计入 `Downlink_dropped`（`gateway/internal/hub/hub.go:135-138`）。当前用户量下无害，但它让「下行投递率」这个指标的分母失真——而校招计划证据线三要靠这个指标做 SLO。
2. **群扇出的 pipeline 里逐条 `json.Marshal`。** `service/downlink.go:119-132` 的 loop 内每个用户都 `json.Marshal(payload)` 一次，而 payload 只有 `userId` 不同。2000 人群 = 2000 次序列化同一份消息体。应该在循环外先序列化消息帧，再用字符串拼接或 `json.RawMessage` 组合。

**修复。** 单聊也走 `FilterOnline`（两次 pipeline 往返，换取指标准确）；群扇出把公共帧提到循环外。顺带把「群/单聊判断」从首字符改成 `strings.HasPrefix(convID, "group_")`，与 `GetConversationMembers` 的 `parts[0]=="group"` 保持一致（见 BZ-N1）。

#### BZ-I6 生产连接数据库强制明文，连接池上限写死（已核实）

**证据。** `biz/internal/store/store.go:52-77`：

```55:67:biz/internal/store/store.go
if !strings.Contains(url, "sslmode=") {
    ...
    url = url + sep + "sslmode=disable"
}
...
cfg.MaxConns = 32
```

**原理与后果。**

- 生产 `DATABASE_URL` 由 compose 拼成 `postgresql://user:pass@postgres:5432/db`（`docker/docker-compose.prod.yml:72`），不含 `sslmode`，于是被自动补成 `sslmode=disable`。同机 docker 网络内可以接受，但**这个默认值让「要求 TLS」变成无法配置**——将来数据库迁到托管服务（RDS 等）时会静默降级为明文，且没有任何告警。
- `MaxConns = 32` 硬编码：单副本 32 连接，`postgres:16` 默认 `max_connections=100`。两个副本就接近上限，再加一个迁移任务或压测机就会撞 `too many connections`。这个数字应当来自环境变量，并与 `postgres` 的 `max_connections` 一起写进容量模型。

**修复。** `sslmode` 只在 `IsProduction == false` 时补 `disable`；生产缺失就直接报错。`MaxConns` 提到 config（`DB_MAX_CONNS`）。这两项都属于「配置即契约」，与 01 分册的结论一致。

#### BZ-I7 8 处吞掉 `ShouldBindJSON` 错误（已核实）

**证据。**

```
auth_routes.go:285    chat_routes.go:199    friend_routes.go:144
friend_routes.go:195  friend_routes.go:306  sync_routes.go:124
upload_routes.go:184  upload_routes.go:286
```

**原理。** 吞掉绑定错误意味着「请求体畸形」与「字段缺失」与「字段类型不对」三种情况全部退化成「用零值继续执行」。BZ-S2 就是这条路走到黑的产物：错误本来是明确的 `UnmarshalTypeError`，被抹掉之后变成一句无信息量的「403 无权」。

**修复。** 统一改成「绑定失败即 400 + `issues`」，与 `sync_routes.go` 里已经存在的 zod 风格错误信封对齐（`invalidParams`）。

#### BZ-I8 CORS 拒绝返回 500（已核实）

**证据。** `biz/internal/api/middleware.go:63-70`：非白名单 Origin 记 warn 日志后 `AbortWithStatusJSON(http.StatusInternalServerError, ...)`。

**原理。** CORS 拒绝是**客户端策略问题**（403 语义），不是服务端故障（5xx 语义）。返回 500 会把「有人在别的站点调我们的接口」混进服务端错误率，污染 SLI——而校招计划证据线三要用「消息发送成功率 99.9%」做 SLO，错误分类不干净会让燃烧率告警误报。

注释说明这是为了「对齐 Express 版经 errorHandler 变 500」的历史行为。历史兼容可以保留，但应当**同时**打一个独立指标（如 `cors_rejected_total`），让 5xx 里能把这部分摘出来。

#### BZ-I9 读写分离下的「读己所写」不一致（已核实设计，影响待评估）

**证据。** `store.NewRO` 在配置了 `PG_READONLY_URL` 时使用独立连接池（`store/store.go:36-49`），下列读都走 RO：

- `service/message.go:217-222`（`GetConversationMembers` 群成员，`store.RO().Query`）
- `service/read.go:15-24`（`IsConversationMember`）

而写走 `store.PG()`。注释里已经注意到 5 处「写后读」要留在写库（见提交 `7d95bf6`），但 `IsConversationMember` 没有列进去。

**原理。** 用户刚被拉进群 → 写库已有 `user_conversations` 行 → 副本尚未追上 → `IsConversationMember` 返回 false → `sync`/`read` 返回 403。表现为「刚进群，历史消息刷不出来」，刷新几次又好了。

**后果。** 概率性、难复现、用户投诉「时好时坏」。当前生产未配副本（`PG_READONLY_URL` 为空则回退写库），所以是**潜在**问题；一旦按 V3 计划开读写分离就会立刻出现。

**修复。** 授权类查询（`IsConversationMember`）必须走写库——它决定「能不能访问」，宁可慢一点也不能读旧值。纯展示类查询（会话列表、历史消息）继续走 RO 并接受延迟。

### 一般

| 编号 | 问题 | 证据 | 修复 |
|---|---|---|---|
| BZ-N1 | 群聊判断用首字符 `'g'`，与 `GetConversationMembers` 的 `parts[0]=="group"` 规则不一致 | `realtime/handleUplink.go:152`、`service/push.go:53` | 统一抽 `isGroupConv(convID)` |
| BZ-N2 | `PersistMessage` 里 `defer tx.Rollback` 与显式 `tx.Rollback` 重复调用 | `service/message.go:128、146、155、173` | 只保留 `defer`，显式调用处改为注释说明；pgx 的二次 Rollback 是 no-op，但读代码的人会以为漏了分支 |
| BZ-N3 | `CheckpointAll` 遇第一个错误就 `return`，后续会话位点全部不写 | `service/seq.go:228-245` | 改成收集错误继续跑，最后聚合返回 |
| BZ-N4 | 死代码：`var _ = fmt.Sprintf`、`bodyParser := &limitedBodyParser{}` 只为保留 import | `api/middleware.go:211`、`api/router.go:33-34` | 删除未使用的 import 与类型；`limitedBodyParser` 的注释说明限制在别处生效，那就不要留空壳 |

## 2 整改顺序

| 顺序 | 事项 | 关联 | 工时 |
|---|---|---|---|
| 1 | 抽 `RequireConversationMember` 并挂到 `messages` / `conversations` / `lastMessages` | BZ-S1 | 1.5h |
| 2 | `message.send` 加成员校验；去掉群成员为空的 `[senderID]` 回落 | BZ-S3 | 1h |
| 3 | `call:start` 校验被叫与好友关系；`MarkAccepted` 带 `calleeID` | BZ-S4 | 1h |
| 4 | 四处 `userId` 改 `int64` + 校验 bind；同步 OpenAPI | BZ-S2 | 1.5h |
| 5 | 8 处 `_ = ShouldBindJSON` 全部改为 400 | BZ-I7 | 0.5h |
| 6 | `clientIP` 改为信任代理链（或 nginx 覆盖 XFF） | BZ-I3 | 0.5h |
| 7 | 上传改流式；`sslmode` 与 `MaxConns` 提到配置 | BZ-I4、BZ-I6 | 3h |
| 8 | 发号慢路径改原子 Lua；缓存换 LRU | BZ-I1、BZ-I2 | 4h |
| 9 | 扇出优化（单聊收敛 + 帧复用）；CORS 独立指标 | BZ-I5、BZ-I8 | 2h |
| 10 | 授权查询留写库；一般项清理 | BZ-I9、N1–N4 | 1h |

第 1–5 项合起来 5.5 小时，把四个 S 级问题全部关掉，且第 4、5 项天然产出可复用的测试用例。

## ★ 关键理解点

- **正向：授权检查要收敛成「一个入口」，而不是「每个 handler 记得写」。** 本项目四个读端点三个漏检、两个写路径一个漏检，根因不是粗心，是授权逻辑散落在每个 handler 里、由作者逐次决定。抽成中间件之后，「新增端点忘了校验」这件事在结构上就不可能发生——这才叫修好了，而不是补好了。
- **反向：类型不一致的契约比没有契约更危险。** 没有契约时人会谨慎地对字符串；有契约但两处自相矛盾（`openapi.yaml:189` 是 integer、`:234` 是 string）时，前后端各取一半，两边都「按契约实现」，还都能通过各自的类型检查。防线只能放在运行时：跨层契约测试用真实 payload 打真实 handler。
- **边界：读写分离的边界在「授权」与「展示」之间，不在「快」与「慢」之间。** 授权查询读旧值等于给了一个可能错误的权限判断；展示查询读旧值最差是「刷新一下就好」。区分这两类，比给所有查询都加 `FOR UPDATE` 更有用。
- **对比：进程内缓存 vs Redis。** 本地 `sync.Map` 省下的是一次 RTT（几十微秒），代价是内存无界 + 多副本不一致 + 需要自己实现淘汰。在单会话 QPS 已经打到 200/s 的场景里，一次 Redis RTT 并不构成瓶颈；先证明 RTT 是瓶颈，再引入本地缓存，并同时准备淘汰策略。
