# Go 长连接网关深度剖析 · 作用、架构与底层原理

> 面向 `gateway/`(Go 1.22 + gorilla/websocket)这套约 800 行手写代码的连接网关。目标:讲清它**在整套 IM 里到底承担什么职责、为什么要把它从 Node 业务进程里独立出来、每一条职责的底层机制如何运作、以及关键设计的取舍**。所有结论以仓库现有代码为准,并诚实标注当前落地状态(它现在是"方向 + PoC",web 端仍走 Socket.io)。

---

## 0. 摘要(TL;DR)

- **一句话定位**:网关是 IM 的**连接平面(connection plane)**——只负责"把海量 WebSocket 长连接稳定地扛住、鉴权、保活,并在客户端与业务之间搬运消息帧",**业务平面(落库/发号/幂等/读扩散)全部留在 Node**。它是一个**无状态、可水平扩副本**的搬运工,不是业务服务。
- **它的职责可 MECE 拆成四块**(下文逐块讲透):
  1. **接入与鉴权** —— 先验签后升级、配额准入;
  2. **连接生命周期与保活** —— 每连接双 goroutine、心跳、同设备踢旧、优雅关闭;
  3. **消息搬运(只搬不懂)** —— 上行透传 Node 落库、下行跨副本扇出;
  4. **稳定性与可观测** —— 背压逐出慢消费者、Prometheus 指标。
- **为什么要独立出来**:长连接的成本模型和无状态 HTTP 完全不同(每连接常驻内存/文件描述符/goroutine、要保活、要背压)。把它从 Node 剥离,一是**用 Go 的并发模型(goroutine + channel)天然扛 C100K 级连接**,二是**让"连接稳定性"与"业务逻辑"各自独立伸缩、独立故障**——网关被慢客户端打爆,不该连累业务;业务重启,不该断掉所有长连接。
- **底层三个支点**:① **无状态 + Redis presence**(连接索引在本进程,可发现状态在 Redis,所以能随意扩副本);② **有界 send channel + 非阻塞入队 + 慢消费者逐出**(背压,单个慢客户端绝不拖垮整机);③ **Redis pub/sub 背板做跨副本下行投递**(任意 Node 实例落库后 publish,持有该用户连接的网关副本代投)。
- **诚实边界(当前状态)**:网关已部署(nginx 把 `/ws` 路由给它、与 Socket.io **共享同一套 Redis presence**),但 **web 前端目前仍用 Socket.io**(`web/src/utils/socket.ts`),网关的**上行目前只实现了 `message.send` 一种帧**。它是既定演进方向("长连接统一走 Go 网关")与已跑通的 PoC,**尚未完成从 Socket.io 的切换**。

---

## 1. 先问"为什么需要它":长连接与无状态 HTTP 的成本不是一回事

要理解网关的价值,先理解**长连接为什么是特殊负担**。

普通 HTTP 请求是**无状态、短命**的:来一个请求、处理、回响应、连接可复用或关闭,服务器几乎不为"某个用户"常驻任何东西。而 IM 要"服务端能随时推给你"(收消息、来电、@提醒),必须维持一条**从登录到离线一直挂着的长连接**(WebSocket)。这带来四类无状态 HTTP 没有的负担:

| 负担 | 说明 | 规模化后果 |
|---|---|---|
| **常驻资源** | 每条连接占 1 个文件描述符(fd)、内核收发缓冲、应用侧读写缓冲与协程/线程 | 10 万连接 = 10 万 fd + 数 GB 内存,轻易打爆单进程 |
| **保活** | TCP 连接可能"半死不活"(对端掉电、NAT 超时),服务端必须主动探测(心跳/ping) | 不探测就攒下大量"幽灵连接",占资源又投递失败 |
| **背压** | 服务端推得快、客户端读得慢(弱网),数据会在服务端积压 | 单个慢客户端能把服务端内存吃光,拖垮所有人 |
| **可发现性** | 多实例部署时,"用户 A 的连接在哪台机?" 必须能查 | 否则跨实例的消息推不到人 |

**Node 用 Socket.io 也能做这些,但有两个结构性理由把连接平面独立成 Go 网关:**

1. **并发模型**:Node 是单线程事件循环,长连接的读写、心跳、JSON 序列化都挤在一个 loop 上;C100K 级连接下,任何一段 CPU 密集(大 JSON、加解密)都会阻塞所有连接。**Go 的 goroutine 是轻量级协程(初始栈 ~2KB,由 runtime 调度到多核)**,每条连接开两个 goroutine(读、写)也才几十万个,天生适配"海量连接、每条低频"的场景,且**多核并行**。
2. **故障与伸缩隔离**:连接稳定性(扛连接数、抗慢客户端)与业务逻辑(落库、发号)是**两种完全不同的负载曲线**。独立后,网关按"连接数"扩副本、业务按"消息吞吐"扩副本,互不牵连;业务进程重启不必断开长连接,网关被攻击/打爆也不直接波及业务落库。

> 结论:**网关的存在意义 = 把"维持长连接"这件重资源、需保活、需背压的脏活,从业务进程里剥离,交给一个为此优化的、无状态可扩的 Go 进程。** 这是几乎所有大型 IM(微信、钉钉、Slack)都有独立"接入层/长连接层"的同一个理由。

---

## 2. 概念扫盲(读完不必另开搜索)

- **WebSocket**:在一次 HTTP 请求里通过 `Upgrade: websocket` 头把连接"升级"成全双工、长期保持的双向通道。之后双方可随时互发**帧(frame)**,不再是"请求-响应"。本项目客户端帧是 JSON(如 `{type:"message.send", ...}`)。
- **长连接(persistent connection)**:建立后长期不关闭的连接,用于服务端主动推送。与之相对是"请求完就断"的短连接。
- **连接网关 / 接入层(gateway / ingress access layer)**:专门承载并管理海量长连接的服务,自身不做业务,是客户端与业务后端之间的"连接中枢"。
- **无状态(stateless)**:进程自身不保存"不可重建的关键状态"。本网关的 `hub` 只是**本进程内的 fd 索引**(哪条连接在我手里),这个索引进程一重启就没了、也无所谓——真正"用户 A 在线、在哪台副本"这种**可发现状态全写在 Redis**。所以任意副本可随时增删。
- **presence(在线注册表)**:记录"哪个用户的哪个设备当前在线、连在哪台副本上"的共享数据结构,存在 Redis。业务侧据此做"只推给在线的人"(读扩散)。
- **backplane(背板)**:多副本之间用来互相转发消息的通道。本项目用 **Redis pub/sub** 的 `gw:downlink` 频道做背板——业务侧 publish,所有网关副本订阅,持有目标连接的副本负责代投。
- **pub/sub(发布/订阅)**:一方 `publish` 到频道,所有 `subscribe` 该频道的一方都会收到。用于"我不知道目标连接在哪台副本,那就广播给所有副本,谁有谁投"。
- **背压(backpressure)**:下游(客户端)消费慢时,对上游(服务端推送)施加的"反向压力",避免无限积压。本网关的实现是**有界队列 + 满了就逐出慢连接**。
- **慢消费者(slow consumer)**:读得比服务端推得慢的客户端(常见于弱网)。不处理它,它的积压会吃光服务端内存。
- **有界 channel / 有界队列**:容量固定的缓冲区(本项目每连接 `send` channel 默认 256)。"有界"是背压的支点——满了才能触发"这是慢消费者"的判定。
- **goroutine / channel(Go 并发原语)**:goroutine 是 Go 的轻量协程,`go f()` 即启动;channel 是 goroutine 间**类型安全的管道**,`ch <- x` 发送、`<-ch` 接收。本网关"读循环把帧塞 channel、写循环从 channel 取帧发出"就是经典的 channel 解耦。
- **心跳 / ping-pong**:定期互发探测帧确认对端存活。本项目**两层**:WebSocket **协议层** ping/pong(网关发 ping,客户端自动回 pong)+ **应用层** `{type:"heartbeat"}`(客户端主动发,用于续约 presence)。
- **JWT / HS256 / 验签 vs 签发**:JWT 是带签名的令牌;**HS256** 是用一把**对称密钥**做 HMAC-SHA256 签名。**签发**是用密钥生成 token(Node 做),**验签**是用同一把密钥核对签名(网关做)。网关**只验签不签发**。
- **扇出(fan-out)**:一条下行消息要投给"该用户在本副本的所有连接"(手机、网页多端同收),一变多,即扇出。

---

## 3. 它在整体架构里的位置(数据流)

```
                         ┌──────────────── nginx(唯一 ingress,443)────────────────┐
   浏览器 / App           │  /api /oauth /user  → server:3007 (业务 HTTP)            │
      │  wss://.../ws     │  /socket.io/        → server:3007 (Socket.io 实时,现役)  │
      └──────────────────▶│  /ws                → gateway:8090 (原生 WS,本文主角)     │
                          └──────────────────────────────────────────────────────────┘
                                     │                                   │
        (上行 uplink:HTTP POST)      │                                   │ (下行:订阅 Redis)
   gateway ── /internal/gateway/uplink ──▶ Node(server) ── publish ──▶ Redis: gw:downlink
        │  X-Gateway-Token 内部令牌         落库/发号/幂等/读扩散                 │
        │  X-User-Id 网关验签身份                                               ▼
        │                                                          gateway 各副本订阅 → RouteToUser
        └──────────── 共享 ────────────▶ Redis: presence:{uid} / :meta ◀──────── Socket.io 也写同一套
```

三条关键链路:
1. **接入**:客户端 `wss://host/ws` → nginx 升级并反代到 `gateway:8090`(`docker/nginx/conf.d/default.conf` 的 `/ws` 块)。
2. **上行(客户端→服务端)**:网关收到帧,**HTTP POST 透传**给 Node 的 `/internal/gateway/uplink`(`internal/upstream/upstream.go`),Node 落库后**同步返回 ack**,网关回投给发送方。
3. **下行(服务端→客户端)**:Node 落库后按在线名单 `publish` 到 Redis `gw:downlink`(`server/src/routes/internal.ts`),网关**订阅**该频道(`internal/backplane/backplane.go`),把帧路由给"目标用户在本副本的所有连接"。

**presence 是两条实时通道的共享地基**:网关(`internal/presence/presence.go`)与 Node 的 Socket.io(`server/src/realtime/presence.ts`)**写同一套 Redis 键**(`presence:{userId}` ZSET + `presence:{userId}:meta` HASH),键结构必须逐字节一致——这样 Node 的"只推在线用户"(`filterOnline`)才能同时看见挂在网关和挂在 Socket.io 上的连接。

---

## 4. 底层作用原理(逐条讲透)

按第 0 节的 MECE 四块展开。

### 4.1 接入与鉴权:先验签、后升级(顺序是有意的)

`internal/ws/server.go` 的 `ServeHTTP`:

1. **先取 `token` cookie 验签**(`auth.Verify`)。**不过就直接 `401`,连协议升级都不做**(server.go:51-64)。为什么这个顺序:WebSocket 升级(`Upgrade`)本身有开销且会占用连接,**鉴权失败的请求不该浪费一次升级**;而且升级后再拒绝,客户端体验是"连上又被踢",不如握手阶段干脆地 401。
2. **验签通过才 `upgrader.Upgrade`**(server.go:66),把 HTTP 连接升级为 WS。
3. **配额准入**:`hub.NewConn` 若超过 `MaxConns` 硬上限,返回 `ErrOverQuota`,网关回一个 `CloseTryAgainLater`(1013)优雅关闭帧,不硬断(server.go:78-85)。
4. **登记 presence**(server.go:89),把连接镜像进 Redis,并打握手结果指标。

> `CheckOrigin` 当前返回 `true`(server.go:46),是 PoC 放行——生产应按 `CLIENT_ORIGINS` 白名单校验 `Origin` 头,这是已知待收敛项。跨站的兜底目前靠 `token` cookie 是 `HttpOnly + SameSite`(不能被 JS 跨站读取/自动带到第三方)。

### 4.2 身份可信:只认服务端验签,绝不信客户端自报

这是安全的命门。`internal/auth/jwt.go` 的 `Verify`:

- 用**与 Node 共享的 `JWT_SECRET`(HS256 对称密钥)**核对 token 签名——这把密钥只在服务端(Node 签发、网关验签),客户端拿不到,所以**无法伪造合法 token**。
- **强制 `alg=HS256`**:回调里显式断言签名方法是 `*jwt.SigningMethodHMAC`,否则报错(jwt.go:23-25)。这是防**算法降级攻击**的关键——历史上大量 JWT 漏洞源于服务端接受 `alg=none`(无签名)或把非对称公钥当 HMAC 密钥用。这里把算法钉死,杜绝这类混入。
- 身份从 token 的 `id` claim 解出(Node 的 `jsonwebtoken` 把数字编为 JSON number,Go 侧解为 `float64` 再转 `int64`,jwt.go:36-40)。

**之后整条连接的 `userID` 全部以这个验签结果为准**:上行透传给 Node 时,用户身份走 `X-User-Id` 头由网关注入(`upstream.go:40`),**Node 不信任帧里客户端自报的 `senderId`**。这样即便客户端伪造 `{senderId: 别人}`,也冒充不了别人——发消息人只能是握手时验签出来的那个人。

> 术语澄清:网关这里用的是 **HS256 对称共享密钥**(和 Node 同一把 `JWT_SECRET`),校验的是**用户登录 token**。这与"跨服务鉴权走 JWKS(非对称公钥)"是**两个不同层面**:JWKS 是给下游服务(如 agent-server)验 our-chat 签发的 token 用的;网关↔客户端这条用的是登录会话的对称 token。

### 4.3 每连接双 goroutine:readLoop / writeLoop —— Go 并发模型如何天然适配长连接

`hub.Start`(hub.go:130-133)对每条连接起**两个 goroutine**:

```go
go c.writeLoop()
go c.readLoop()
```

- **readLoop**(conn.go:61-79):阻塞 `ReadMessage` 收上行帧 → `dispatch`。设了**单帧 1MB 上限**(`SetReadLimit`,防超大帧打爆内存)与**读截止时间**(`SetReadDeadline`,配合心跳判死)。任何读错(断开/超时)统一走 `defer c.close()` 收尾。
- **writeLoop**(conn.go:117-140):一个 `select` 同时等两件事——① 从 `send` channel 取下行帧写出;② `ticker` 到点发协议 ping 保活。**所有对该连接的写都集中在这一个 goroutine**,天然串行化,避免并发写同一 WS 连接(gorilla/websocket 不允许并发写)。

**为什么这个"每连接双协程 + channel 解耦"是长连接的标准范式**:读和写是两个独立的、都可能阻塞的方向(读等客户端发、写等有东西可发),用两个 goroutine 各自阻塞、互不干扰;它们之间用 `send` channel 传递下行帧,把"谁往这条连接推"(hub 扇出)与"实际写 socket"(writeLoop)**解耦**。Go 的 goroutine 足够轻,10 万连接 = 20 万 goroutine,runtime 调度到多核毫无压力——这正是 Node 单事件循环难以优雅做到的。

### 4.4 保活:应用层 heartbeat + 协议层 ping/pong 双层

判断"连接是不是还活着",本项目用**两层冗余**:

- **协议层**:writeLoop 每 `heartbeatTimeout * 2/5` 发一次 WS **PingMessage**(conn.go:118-119、133-137);客户端(浏览器/库)会**自动回 pong**,网关的 `PongHandler` 收到 pong 就**把读截止时间往后推**(conn.go:67-70)。间隔取超时的 0.4,保证一个超时窗口内至少探测一次。
- **应用层**:客户端主动发 `{type:"heartbeat"}`,网关在 `dispatch` 里同样推后读截止 + **续约 presence TTL**(conn.go:89-97)。

只要在 `heartbeatTimeout`(默认 60s)内没有任何 pong 或 heartbeat,`ReadDeadline` 到期 → `ReadMessage` 报错 → readLoop 退出 → `close()` 收尾。**协议层探"TCP 通不通",应用层探"客户端逻辑活不活 + 续 presence",两层各司其职**。

### 4.5 无状态 + presence:hub 只是 fd 索引,可发现状态在 Redis

`hub.Hub`(hub.go:21-32)持有 `conns map[int64]map[string]*Conn`(userID → deviceId → 连接),**这只是本进程当前握着哪些 fd 的索引**,进程一挂就没了。真正"用户在不在线、连在哪台副本"全在 Redis presence(`presence.go`):

- `presence:{uid}` **ZSET**:member=deviceId,score=过期时刻(ms);
- `presence:{uid}:meta` **HASH**:field=deviceId,value=`{replica}:{socketId}`——`replica` 就是**这条连接挂在哪台网关副本**。

`Register`(上线)/`Refresh`(心跳续约,只推后 score)/`Remove`(优雅断开摘除)三个操作(presence.go:35-55),配合 ZSET score 做**惰性过期**:非优雅断开(掉电)时来不及 Remove,Node 读 presence 时按 score 过滤掉过期成员即可,不留幽灵。

> 这套设计的回报:**网关彻底无状态 → 可随意水平扩副本、滚动重启、被 LB 任意打散**。"连接的可发现性"这个跨副本难题,被外置到 Redis 解决,而不是让网关自己维护集群状态。

### 4.6 上行:透传 Node 落库,网关不碰业务、不碰 DB

`dispatch`(conn.go:81-115)对非心跳帧的处理是**透传**:`upstream.Forward` 把原始帧 **HTTP POST** 给 Node `/internal/gateway/uplink`,带三个头——`X-Gateway-Token`(内部令牌,防该端点被外部直接调用)、`X-User-Id`(网关验签身份)、`X-Device-Id`。**同步等 Node 的 ack**(10s 超时),再把 ack/error 回投发送方(conn.go:112-113)。

Node 侧 `server/src/routes/internal.ts` 才是业务:校验内部令牌 → 用 `X-User-Id` 作 `senderId` → zod 校验 → `persistMessage`(落库 + **发号 seq** + **clientMsgId 幂等去重**)→ 按会话成员 `filterOnline` 过滤在线者 → 逐个 `publishDownlink`(扇出)→ 返回 `message.ack`。

**为什么网关不直接落库**:落库/发号/幂等/读扩散是**业务逻辑**,已在 Node 有完整实现(且和 Socket.io 路径复用同一套 service)。让网关也写 DB,就得在两种语言里各维护一份业务规则,极易漂移。**网关只做"搬运工",业务永远单一权威在 Node**——这是"连接平面 / 业务平面"分层的核心纪律。

> 现状:Node 的 uplink 目前**只接受 `message.send`**,其余 type 明确 `400` 拒绝(internal.ts:50-52)。这是 PoC 边界,不是设计上限。

### 4.7 下行:跨副本投递(backplane 订阅 + 扇出)

难点:Node 落库后要推给用户 A,但**A 的连接可能在任意一台网关副本上**,Node 不知道是哪台。解法是 **Redis pub/sub 背板**:

- Node `publishDownlink`(internal.ts:24-25):`publish gw:downlink {userId, frame}`——**广播给所有网关副本**,不关心 A 在哪台。
- 每台网关 `backplane.Run`(backplane.go:27-51):订阅 `gw:downlink`,收到就 `h.RouteToUser(userId, frame)`。
- `RouteToUser`(hub.go:97-119):在**本副本**的索引里找该用户的所有连接(多端),**扇出**;本副本没有该用户连接就记 `dropped` 指标(说明 A 在别的副本,别的副本会投)。

一个工程细节:**订阅连接必须独立于命令连接**(main.go:41-42 用了 `subRdb` 单独客户端)。Redis 协议规定一旦进入订阅态,该连接就不能再发普通命令,所以 presence 读写(命令)和 gw:downlink 订阅必须用两条 Redis 连接。

### 4.8 背压:整套设计的稳定性核心

这是网关**最有工程含量**的一环,直接决定"一个弱网/恶意慢客户端能不能拖垮整机"。

支点是**每连接一个有界 `send` channel**(容量 `SendBuffer`,默认 256)。下行投递用**非阻塞入队**(conn.go:37-44):

```go
func (c *Conn) enqueue(payload []byte) bool {
    select {
    case c.send <- payload: return true   // 缓冲没满,入队成功
    default:               return false   // 缓冲满了 → 慢消费者
    }
}
```

`select-default` 是关键:**绝不阻塞写**。若某连接读得慢、`send` 满了,`enqueue` 立刻返回 `false`,`RouteToUser` 据此**逐出这条慢连接**(`c.close()`,hub.go:113-117)并记 `evicted` 指标——**但不影响同用户的其它正常连接,更不阻塞整个 backplane 扇出循环**。

**对比三种可选策略,为什么选"逐出":**

| 策略 | 慢客户端满了怎么办 | 后果 |
|---|---|---|
| **阻塞写(无界/阻塞入队)** | 扇出循环卡在这条慢连接上 | 一个慢客户端**卡住整台网关**的下行,灾难 |
| **丢最旧帧(ring buffer)** | 丢队首,继续塞 | 消息**乱序/丢失**,IM 不可接受;且仍占内存 |
| **逐出(本项目)** | 直接踢下线,让客户端重连补拉 | 牺牲这一条慢连接,**保住整机**;重连后按 seq 增量补齐 |

选逐出的前提是**上层有可靠补偿**:消息有 `seq` 发号,客户端重连后能按序增量拉取,所以"踢掉慢连接、让它重连补齐"不丢消息,只是这条连接短暂中断。**这把"局部弱网"的代价限制在该连接自身,不外溢**。`test/backpressure_test.go` 专门验收了这条路径:一个"只连不读"的慢客户端在持续大帧下行下被逐出,而进程继续正常运转。

### 4.9 配额:MaxConns 硬上限,防 fd / 内存爆

`NewConn` 在加锁临界区里先查 `countLocked() >= maxConns`(hub.go:59-62),超了直接拒。**这是防"资源耗尽型"故障的准入闸**:每条连接吃 fd + 内核缓冲 + 两个 goroutine + 一个 send channel,不设上限,连接洪峰能把单进程的 fd 或内存打爆,进而**所有人一起挂**。设了上限,超额的新连接被优雅拒绝(`CloseTryAgainLater`),存量连接不受影响——**宁可拒新,不可拖垮存量**。上限接近时,`gateway_connections` 指标会预警,该扩副本。

### 4.10 同设备重连踢旧:防幽灵连接

`NewConn`(hub.go:63-74):同 `(userID, deviceId)` 再次连上时,**用新连接覆盖索引里的旧连接,并 `old.close()` 踢掉旧的**。为什么:弱网下客户端常"旧连接还没被服务端判死、就已经重连了新的",若不踢旧,同一设备会攒下多条"幽灵连接"(旧的那条永远收不到、还占资源、还会导致下行重复投递)。`unregister` 里还有一处防御(hub.go:87):**仅当索引里仍是这条连接时才删**,避免"旧连接的延迟 close 误删了新连接"。

### 4.11 可观测:Prometheus 指标体系

`internal/metrics/metrics.go` 暴露 6 个指标,`/metrics` 供 Prometheus 抓取。它们不是装饰,是**判断网关健康与背压是否在生效**的一线信号:

| 指标 | 类型 | 读它看什么 |
|---|---|---|
| `gateway_connections` | Gauge | 当前活跃连接;接近 `MaxConns` = 该扩副本 |
| `gateway_handshakes_total{result}` | Counter | ok/unauthorized/over_quota;unauthorized 激增 = 被刷或密钥不一致 |
| `gateway_uplink_total{result}` | Counter | 上行透传成败 |
| `gateway_downlink_total{result}` | Counter | delivered/dropped/evicted 的下行分布 |
| `gateway_evicted_total` | Counter | 慢消费者逐出数;上扬 = 背压在生效(有人读得慢) |
| `gateway_uplink_duration_seconds` | Histogram | 上行收帧→Node ack 的 p99,是消息可靠性的关键 SLI |

### 4.12 优雅关闭

`main.go:44、81-91`:`signal.NotifyContext` 捕获 SIGINT/SIGTERM → `srv.Shutdown`(10s 超时,停止收新连接、给存量请求收尾)→ 关闭两条 Redis 连接。backplane 的 goroutine 随 `ctx` 取消而退出(backplane.go:34)。这样部署滚动更新时不会粗暴切断。

---

## 5. 关键设计决策与取舍(方案对比)

> 每条都给"我们的选择 + 为什么 + 代价",而非罗列可能性。

| 决策点 | 候选方案 | 选择 | 理由 / 代价 |
|---|---|---|---|
| **连接平面用什么** | 继续 Node/Socket.io ↔ 独立 Go 网关 | **Go 网关** | Go goroutine 天然扛海量连接 + 多核并行;连接稳定性与业务独立伸缩/故障隔离。代价:多一个服务、多一套跨进程协议(uplink/downlink) |
| **WS 协议栈** | Socket.io(带房间/自动重连/降级)↔ 原生 WebSocket(gorilla) | **原生 WS** | 网关只做搬运,不需要 Socket.io 的房间/广播抽象(那些放在 Node);原生 WS 更轻、更可控、无协议开销。代价:重连/降级要客户端自己实现 |
| **状态放哪** | 有状态网关(会话粘连到副本)↔ 无状态 + Redis presence | **无状态 + Redis** | 可随意扩副本/重启/被 LB 打散;跨副本可发现性外置给 Redis。代价:每次上下线/心跳一次 Redis 往返 |
| **慢客户端** | 阻塞写 ↔ 丢最旧帧 ↔ **逐出** | **逐出** | 把局部弱网代价限制在单连接,保住整机;依赖 seq 发号让重连补齐不丢消息。代价:慢连接被短暂中断 |
| **上行怎么落库** | 网关直连 DB ↔ gRPC 到 Node ↔ **HTTP 透传 Node** | **HTTP 透传** | 业务单一权威在 Node、复用既有 service,不在两种语言里各写一份业务;HTTP 简单够用。代价:一次进程间 HTTP 往返(已是热路径,给了有界超时) |
| **跨副本下行** | 直连副本 ↔ 消息队列(Kafka)↔ **Redis pub/sub** | **Redis pub/sub** | presence 已用 Redis,复用同一基础设施零新增依赖;广播语义正好匹配"不知道在哪台副本"。代价:pub/sub 是**尽力投递、不持久化**(离线消息靠 DB + 重连拉取兜底,不靠背板) |
| **鉴权算法** | 接受多算法 ↔ **钉死 HS256** | **钉死 HS256** | 杜绝 alg=none / 非对称密钥混入的降级攻击。代价:无,纯收益 |

---

## 6. 与 Socket.io 的关系 & 当前落地状态(诚实边界)

**两条实时通道当前并存**,且**共享同一套 Redis presence**:

- **现役**:web 前端用 `socket.io-client` 连 `/socket.io/`(→ Node),实时消息走 Socket.io + Redis adapter(多实例广播)。这是目前**真正承载线上流量**的通道。
- **方向 / PoC**:Go 网关挂在 `/ws`,握手/鉴权/presence/背压/下行投递/指标**全部跑通并有测试**(smoke + backpressure),但**上行只实现了 `message.send`**,且**没有客户端在用它**(web 仍在 Socket.io)。

它俩能并存不打架,正是因为**写同一套 presence 键**——Node 的读扩散 `filterOnline` 同时看得见两边的在线连接。**演进路径**是:逐步把 Node 里各类实时帧(消息、已读、输入中、通话信令、presence 变更…)都在网关 uplink/downlink 补齐,客户端从 `socket.io-client` 切到原生 `/ws`,最终"长连接统一走 Go 网关",Socket.io 退役。

> 这也解释了为什么本文把网关定位为"连接平面的**目标形态**":它的架构是终态设计,但**功能覆盖还是 message.send 这一个 PoC 切片**。评估它要分清"架构完成度"(高)与"业务覆盖度"(目前低)。

---

## 7. 设计里沉淀的坑与教训

这些约束不是凭空来的,多数对应过真实故障或明确攻击面(仓库注释标为 docs 16 的对应条目):

1. **fd/内存爆** → `MaxConns` 配额准入(§4.9)。不设上限,连接洪峰打爆单进程。
2. **慢消费者拖垮整机** → 有界 channel + 非阻塞入队 + 逐出(§4.8)。这是最容易被忽视、后果最严重的一类。
3. **幽灵连接** → 同设备重连踢旧 + `unregister` 的"仍是本连接才删"防御(§4.10)。
4. **Redis 订阅态不能发命令** → 订阅用独立连接 `subRdb`(§4.7)。混用会报错。
5. **presence 键必须与 Node 逐字节一致**(§4.5)。不一致 → 两侧互相看不见对方连接 → 消息漏投。
6. **JWT 降级攻击** → 钉死 HS256、拒 alg=none(§4.2)。
7. **身份不能信客户端自报** → userId 走网关验签、经 `X-User-Id` 注入,Node 不信帧内 senderId(§4.2、§4.6)。
8. **优雅关闭** → signal + http.Shutdown,滚动更新不粗暴断连(§4.12)。
9. **待收敛**:`CheckOrigin` 目前放行(§4.1),生产应按 `CLIENT_ORIGINS` 白名单校验 Origin。

---

## 8. 一句话总结

> **Go 网关 = IM 的"连接平面"。它把"扛住海量长连接、鉴权、保活、背压、跨副本搬运消息"这些重资源、需稳定性纪律的脏活,从 Node 业务进程里独立出来,用 Go 的 goroutine+channel 高效实现,并靠"无状态 + Redis presence + pub/sub 背板 + 慢消费者逐出"这四个支点做到可水平扩、抗弱网、不拖垮业务。业务永远单一权威在 Node,网关只搬不懂。** 当前它是这条路线已跑通的终态架构 + message.send 的 PoC 切片,尚未从 Socket.io 完成切换。
