# iOS 发起音视频通话「主叫正常、对端收不到」完整排障复盘

> 根因一句话:**iOS 端 socket.io 客户端配了 `.forceWebsockets(true)`,强制只用 WebSocket 直连,导致它在这套 socket.io v4 服务器上根本没完成 Engine.IO 握手、从未连上;`call:start` 因此从没发到服务端,被叫自然收不到。去掉 `.forceWebsockets(true)`(回到和 Web 一样的「先 polling 握手、再升级 WS」)即通。**
>
> 关联:媒体层(coturn/TURN/VPN)问题见 [`音视频异网络打不通-WebRTC与自建TURN完整排障复盘.md`](./音视频异网络打不通-WebRTC与自建TURN完整排障复盘.md) 与 [`音视频被叫接受打不通-reset清空ICE候选缓冲复盘.md`](./音视频被叫接受打不通-reset清空ICE候选缓冲复盘.md)。**本篇是信令层、且是 iOS 原生端特有的连接层问题**,和前两篇正交。

---

## 0. 摘要(TL;DR)

- **现象**:iOS App 发起语音/视频通话,主叫界面显示「正在呼叫…」一切正常,但对端(Web)**完全收不到通话邀请**,不振铃。
- **根因**:iOS 的 `SocketManager` 配了 `.forceWebsockets(true)`。这让 socket.io-client-swift **跳过默认的 HTTP long-polling 握手、直接开 WebSocket**;在这套 socket.io **v4**(Engine.IO v4)服务器 + nginx 部署下,该直连没能完成 Engine.IO 握手,**iOS 的 socket 从未连接成功**。
- **连锁后果**:socket 没连上 → `socket.emit("call:start")` 打进一个没连上的连接(静默丢弃)→ 服务端从没收到 `call:start` → 从没 `io.to(room(calleeId))` 转发 → 被叫永远收不到。
- **为什么极难定位**:
  1. **主叫 UI「正在呼叫」是同步渲染的**,和「信令是否真发出去」完全解耦——UI 正常 ≠ 信令发出去了;
  2. **服务端握手失败是静默的**(`next(new Error(...))` 不打日志),连不上在服务器侧看不到任何报错;
  3. **Web 端完全正常**,极易误导为「服务端没问题、是通话逻辑的锅」。
- **定位关键**:上服务器查 **Redis presence**——发现**只有 Web 的 user 在线,iOS 从始至终不在 presence 里**,一步把矛头从「路由/鉴权/通话逻辑」拨到「iOS 根本没连上」。
- **修复**:删掉 `.forceWebsockets(true)`(让 iOS 走和 Web 一样的传输协商),iOS socket 立即连上,通话打通。

---

## 1. 现象与背景

- **架构**:1:1 音视频走 WebRTC,**信令(谁打给谁、SDP/ICE 交换)走 socket.io**(server:3007,nginx 反代 `/socket.io/`)。Web 端早已跑通;本次是把能力搬到 iOS 原生端(TCA + socket.io-client-swift)。
- **现象**:iOS 拨号 → 主叫显示「正在呼叫…」→ 对端(Web,已登录在线)**毫无反应**。反复测试都如此,不是偶发。
- **为什么这是信令层、不是媒体层**:被叫**连振铃都没有**。媒体(TURN/coturn)只有在双方交换完 SDP/ICE、开始传流时才涉及;连邀请都没送到,说明卡在**信令**,和 coturn 无关。

---

## 2. 关键概念扫盲(读完不必另开搜索)

### 2.1 socket.io ≠ WebSocket:它是分层的

很多人以为「socket.io 就是 WebSocket 的封装」,这不准确。socket.io 是**两层协议叠加**:

- **Engine.IO(传输层)**:负责「建立并维持一条底层连接」。它支持两种**传输(transport)**:
  - **HTTP long-polling**:用普通 HTTP 请求轮询收发,兼容性最好、穿透力最强(能过几乎所有代理/防火墙);
  - **WebSocket**:全双工长连接,效率高。
- **Socket.IO(应用层)**:在 Engine.IO 之上加了 namespace、房间(room)、事件(`emit`/`on`)、ack、二进制、自动重连等。

**`socket.emit("call:start", …)` 是 Socket.IO 层的事件,但它必须先有 Engine.IO 那条底层连接**。底层没连上,`emit` 就无处可去。

### 2.2 Engine.IO 握手:为什么默认「先 polling、再升级 WS」

Engine.IO 的标准建连流程(也是 Web JS 客户端的默认行为):

1. 客户端先用 **HTTP long-polling** 发起握手 → 服务端返回一个 **`sid`(session id)** + 支持的升级列表(`upgrades: ["websocket"]`);
2. 客户端拿着这个 `sid`,再发起 **WebSocket 升级**,把这条 polling 会话「升级」成 WebSocket;
3. 之后走 WebSocket 全双工。

**为什么要先 polling**:polling 用普通 HTTP,几乎不会被任何中间设备(代理、nginx、企业防火墙)拦;先用它稳稳建立会话拿到 `sid`,再尝试升级到更高效的 WS,升级失败还能退回 polling。**这是「稳」的设计**。

### 2.3 `forceWebsockets(true)` 干了什么、跳过了什么

socket.io 客户端可以配 `forceWebsockets`(iOS 的 socket.io-client-swift、JS 的 `transports: ['websocket']` 同理):**跳过 polling 那一步,一上来就直接开 WebSocket**。

- 好处:省一次 polling 往返,建连略快。
- 代价:**放弃了 polling 的兜底与「先拿 sid 再升级」的稳妥握手**,把成败全压在「一次性直连 WS 并在 WS 上完成 Engine.IO 握手」这条路上。这条路对**协议版本、代理、客户端实现**都更敏感——**本次就栽在这**。

### 2.4 EIO3 vs EIO4(socket.io v2 vs v3/v4)

Engine.IO 有版本:**EIO3**(socket.io v2)、**EIO4**(socket.io v3/v4)。两者握手报文格式、升级语义有差异。服务端 socket.io **v4** 默认只认 **EIO4**(除非显式 `allowEIO3: true`)。客户端必须用对应协议。

> 本次**不是**版本不匹配:iOS 的 socket.io-client-swift 16.x 默认 `version = .three`(即 EIO4),和服务端 v4 匹配。坑不在版本,在 `forceWebsockets` 这条**直连 WS 的握手路径**在 EIO4 下没走通。

### 2.5 握手鉴权:`handshake.auth.token`(原生)vs cookie(Web)

socket.io 握手时要验身份。本项目服务端 `extractHandshakeToken` **优先读 `handshake.auth.token`(原生端把 JWT 放这里),回落 HttpOnly cookie(Web 浏览器自动带)**。iOS 用 `socket.connect(withPayload: ["token": token])` 把 token 放进 `handshake.auth`,服务端认得。**鉴权机制本次是好的**,不是坑。

### 2.6 presence(在线注册表)——信令层排障的黄金指标

服务端把每条在线连接镜像进 Redis:`presence:{userId}`(ZSET,成员=deviceId)+ `:meta`(HASH,值=`replica:socketId`)。**「谁此刻连着」一查便知**。这就是本次一击定位的抓手——正如媒体层排障靠 coturn 的 `peer usage`,信令层排障靠 **presence**。

---

## 3. 数据流:一次 iOS 发起通话本应怎么走

```
iOS 主叫                                    server(socket.io)                Web 被叫
  │ (socket 必须已连上!)                        │                               │
  │ emit call:start{to:{id},offer,…} ──────────▶│ io.use 验签 → socket.userId    │
  │                                             │ 忙线裁决 tryCreateSession       │
  │                                             │ io.to(room(calleeId)).emit ───▶│ 振铃(handleCallStart)
```

**大前提是第一行**:iOS 的 socket 得先连上。本次就断在这——**iOS 的 socket 压根没建立**,后面全不发生。

---

## 4. 排查历程(时间线,含所有弯路)

诚实记录弯路,因为弯路本身是教训。

| # | 假设 | 验证手段 | 结论 |
|---|---|---|---|
| ① | `call:start` 载荷字段和服务端路由对不上 | 读 server `socket.on('call:start')`:`Number(event.to.id)`;对比 iOS `sendCallStart` 发 `to:{id,…}` | **证伪**:字段形状匹配,服务端能取到 calleeId |
| ② | iOS 连的是 localhost(真机够不到) | 读 `APIEnvironment.current` | **证伪**:是 `.prod = https://tujiang.tech` |
| ③ | 被叫振铃路径把来电悄悄丢了 | 读 MainFeature:`guard let localUser = try? await currentUser() else { continue }` | **部分成立但非根因**:这是真实健壮性 bug(网络拉资料失败会丢来电),已改用 JWT 同步 id;但 `/user/profile` 其实是好的,改完仍不通 → 不是本次根因 |
| ④ | 服务端没部署 `handshake.auth.token` 支持(有个 pending todo) | `docker exec our-chat-server cat /app/dist/utils/socketAuth.js` 看**部署的编译产物** | **证伪**:部署的代码已优先读 `handshake.auth.token`,todo 标记是过期的 |
| ⑤ | socket.io 协议版本不匹配(EIO3 vs EIO4) | 读 socket.io-client-swift 源码默认 `version` | **证伪**:默认 `.three`(EIO4),与服务端 v4 匹配 |
| ⑥ | CORS 拦了原生端(无 Origin) | 读服务端 socket.io `cors.origin` | **证伪**:`if (!origin || …)` 明确放行无 Origin 的原生请求 |
| ⑦ | **iOS 根本没连上 socket** | **上服务器查 Redis `presence:*` + Node 连接日志** | **实锤**:presence 里**只有 Web 的 user,从始至终没有 iOS 连接**;日志无任何 iOS `用户连接`,也无 `转发通话邀请失败`、无忙线会话 |
| ⑧ | iOS 连不上是因为 `forceWebsockets` | 去掉 `.forceWebsockets(true)`,回到默认传输协商 | **成立**:iOS 立即连上 presence、通话打通 |

> **转折点在 ⑦**:前面全是「静态读代码逐层排除」,越排越像「哪哪都对却就是不通」。**直到上服务器看运行时的 presence,才发现根本矛盾——iOS 就没连上**。这一步把方向从「路由/鉴权/通话逻辑」彻底拨到「连接层」。
>
> **弯路 ③④ 最耗时**:③ 是个真 bug(顺手修了、有价值),但不是本次症结;在它身上停留、反复怀疑 `/user/profile`,是因为还没拿到「iOS 不在 presence」这个决定性事实。**教训:与其在客户端静态推理,不如先上服务端看「到底连没连、发没发到」。**

---

## 5. 根因深度剖析:为什么 `forceWebsockets` 让原生端连不上 v4 服务器

把证据合起来:

- Web(JS 客户端,**默认 polling→升级 WS**)连得好好的;
- iOS(socket.io-client-swift,**`forceWebsockets(true)` 直连 WS**)从没连上;
- **去掉 `forceWebsockets` 后 iOS 立刻连上**。

唯一变量就是 `forceWebsockets`。机制:

- **默认路径(Web 用的)**:先用 HTTP polling 完成 Engine.IO 握手、拿到 `sid`,再带着 `sid` 升级到 WebSocket。稳,且和服务端 v4 的 EIO4 握手完全对齐。
- **`forceWebsockets` 路径(iOS 原配置)**:跳过 polling,**一上来就开 WebSocket 直连**,要求在这条 WS 上一次性完成 EIO4 握手。这条路在**「socket.io-client-swift 的 forceWebsockets 实现 × socket.io v4 服务端 × nginx 反代」**这套组合下**没能完成握手**——底层连接没建立起来。
- **关键推论**:修复动的是**传输层配置**(去掉 forceWebsockets),而**不是鉴权**。如果卡在鉴权(token 没送到),换传输不会有用(`handshake.auth.token` 与传输无关,polling/ws 都会带)。**改传输就修好 = 故障在传输/握手层,连接压根没建立**,而非「连上了但被鉴权拒」。这也解释了服务器侧为何一条 iOS `用户连接` 日志都没有——连 `io.on('connection')` 都没进到(那是握手成功后才触发的)。

> **本质是 Web vs Native 的差异**:JS 客户端默认「polling 优先、稳妥升级」;而 iOS 这边被显式配成了「WS 直连」,放弃了兜底。原生端 socket.io 的这类配置坑,恰恰是「Web 能跑不代表原生能跑」的典型。

---

## 6. 两个「帮凶」:为什么这么难看出来

### 6.1 主叫 UI「正在呼叫」是同步的,骗人

通话状态机里 `.startCall` **同步**就把 `phase = .outgoing`,然后才在异步 effect 里 `连 TURN → 采集媒体 → createOffer → sendCallStart`。所以**哪怕 socket 没连、`call:start` 根本没发出去,主叫也照样立刻显示「正在呼叫…」**,直到 60s 无应答超时。**「主叫看起来正常」= 完全不能证明信令发出去了**。这是本次最大的认知陷阱。

### 6.2 服务端握手失败是静默的

服务端 `io.use` 里鉴权/握手不过是 `next(new Error(...))`——**socket.io 只把错误发回客户端,服务端默认不打日志**。所以「iOS 连不上」在服务器日志里**看不到任何报错**,只是**悄无声息地没有那条连接**。排障时「没有日志」比「有错误日志」更难,因为你不知道是「没发生」还是「发生了没记」。

---

## 7. 诊断方法论(可复用)

1. **信令层的黄金指标是 presence + 连接日志**(对应媒体层的 coturn `peer usage`)。「通话不通」先别猜逻辑,先上服务器看**双方到底连没连**。presence 里少了一方 = 一步定位。
2. **静默失败要主动「点灯」**:客户端把 `.log(true)` 打开 + 加 `connect/error/disconnect/statusChange` 回调,让真机控制台直接吐握手/传输/错误;服务端在 `io.use` 失败分支补日志。**没有日志时,第一件事是制造日志。**
3. **看运行时状态胜过无尽静态推理**:第 ④ 步「查部署的编译产物」、第 ⑦ 步「查 presence」都是**看服务器此刻真实状态**,比在客户端反复读代码高效得多。
4. **UI 状态不可信作为「信令已发」的证据**:同步 UI 和异步网络解耦,主叫「正在呼叫」只说明进了状态机,不说明包发出去了。
5. **Web 正常 ≠ 服务端/协议没问题**:Web 和 Native 的客户端实现、默认传输、鉴权载体都不同;原生端要单独验「连接层」。

---

## 8. 修复清单

| 项 | 改动 | 为什么 | 状态 |
|---|---|---|---|
| iOS socket 传输 | **删除 `.forceWebsockets(true)`** | 回到默认 polling→升级 WS(和 Web 一致),完成 EIO4 握手 | ✅ 根因修复 |
| iOS socket 诊断 | `.log(true)` + `connect/error/disconnect/statusChange` 回调 | 让「连不上」不再静默,真机控制台可见 | ✅ 已加(定位后应把 `.log` 改回 `false`、诊断回调按 `#if DEBUG` 门控) |
| 被叫振铃健壮性 | 来电路径改用 `currentUserId()` 同步 id,不做网络拉取 | 拉资料失败/弱网不再把来电悄悄丢掉(应答只需 from:id) | ✅ 顺带修(真实 bug,非本次根因) |
| 主叫起呼健壮性 | `currentUser()` 失败 catch 退回同步 id | 拉资料失败也能起呼,不再点了没反应 | ✅ 顺带修 |

---

## 9. 取舍与反思

- **`forceWebsockets` 该不该用**:在「网络干净、服务端 WS 直连支持完善」的环境,它省一次往返。但它**牺牲了 polling 的兜底**,对协议版本/代理/客户端实现更敏感。**默认(polling 优先)是更稳的选择**,尤其原生端 + 经 nginx。除非有明确理由且验证过,别默认开 `forceWebsockets`。
- **原生端接第三方实时库,别假设「Web 配置照抄就行」**:Web 与 Native 的 socket.io 客户端在传输默认值、鉴权载体(cookie vs auth payload)、协议协商上都有差异,**连接层必须在原生端单独验证一遍**。
- **可观测性欠账**:握手失败静默 + 无连接诊断,直接把一个「一行配置」的问题拖成长时间排障。**实时连接的建连/断连/错误应默认可观测**(至少 DEBUG 下)。
- **UI 与网络解耦的双刃**:同步先行的乐观 UI 体验好,但排障时会误导。关键动作(如已把邀请发出)可考虑在「确实 emit 成功」后再更文案,或至少日志留痕。

---

## 10. 经验教训(浓缩)

1. **「通话不通」先查 presence**——双方连没连,一步分清「连接层 / 路由层 / 逻辑层」。
2. **主叫 UI 正常不代表信令发出去了**——同步 UI 和异步 emit 是两回事。
3. **没有日志时,先制造日志**——静默失败是最贵的失败。
4. **看服务器运行时状态 > 客户端静态推理**——presence、部署的编译产物,都是「此刻真相」。
5. **Web 能跑 ≠ 原生能跑**——socket.io 原生端的传输/握手配置(尤其 `forceWebsockets`)要单独验。
6. **一行配置也能是根因**——别因为「代码逻辑都对」就排除连接层。

---

## 11. 后续待办

- [ ] 定位完成后:iOS socket `.log(true)` 改回 `.log(false)`;`🔌[socket]` 诊断回调用 `#if DEBUG` 门控(别把调试噪音带进生产,遵循「调试工具 DEV 门控」约定)。
- [ ] 真机 ↔ Web 端到端复测:双向语音/视频、静音/免提/摄像头、断线重连、拒接/挂断/忙线。
- [ ] 考虑给服务端 `io.use` 失败分支补一行日志(握手被拒时不再完全静默)。
