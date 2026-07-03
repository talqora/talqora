# 音视频「被叫直接接受打不通、刷新后才通」· 完整复盘(reset() 清空 ICE 候选缓冲)

> 一句话:**服务端 TURN、VPN 这两层都排干净后,通话仍是"直接点接受建不起来、刷新一次再接受才通"。真正的最后一层根因在前端一行代码——被叫点接受时 `reset()` 走 `cleanup()`,把"接受前主叫已经 trickle 过来、正暂存等待的 ICE 候选"清空了。被叫因此永远不知道主叫的传输地址,只能单向,通话建不起来。**
>
> 关联文档:
> - 服务端 coturn 三层坑 → [`docs/debug/音视频异网络打不通-WebRTC与自建TURN完整排障复盘.md`](./音视频异网络打不通-WebRTC与自建TURN完整排障复盘.md)
> - VPN/代理污染 WebRTC → [`docs/技术细节/VPN代理为何毁掉WebRTC-fakeip与TUN模式深度分析.md`](../技术细节/VPN代理为何毁掉WebRTC-fakeip与TUN模式深度分析.md)
> - 开着 VPN 也能通的传输层方案 → [`docs/技术方案/音视频-开着VPN也能通-可行性研究与方案.md`](../技术方案/音视频-开着VPN也能通-可行性研究与方案.md)

---

## 0. 摘要(TL;DR)

- **现象**:一对一音视频,**被叫直接点"接受"建不起来通话**;**刷新一次浏览器后再点接受,先显示"重连中",约 2 秒后成功接通**。
- **根因(前端,单点)**:被叫在 `acceptCall` 里调用 `WebRTCManager.reset()`,`reset()` 内部先 `cleanup()` 再 `initialize()`。`cleanup()` 有一句 `this.pendingIceCandidates = []` —— 它**把"remoteDescription 还没设、正暂存等待"的对端候选全清空了**。这些正是**主叫在被叫接听前就 trickle 过来的早到候选**。清空后新建的 `RTCPeerConnection` 再也拿不到它们 → 被叫不知道往哪发媒体 → 单向 → 连通性检查双向不通 → 通话失败。
- **为什么刷新能通**:刷新丢掉内存里的 `pendingOffer`,`acceptCall` 改走 **rejoin(重新协商)分支**——被叫发新 offer、双方**从零干净地重新收集并交换候选**,绕开了"候选被清空"这条坑。代价是要多一轮协商,这就是"先重连中、2 秒后才通"。
- **修复**:`reset()` 跨 `cleanup()/initialize()` **保留** `pendingIceCandidates`,待 `handleOffer` 设完 `remoteDescription` 后再统一补入新 PC。3 行改动 + 一条回归测试(mock `RTCPeerConnection`,去掉修复即变红)。
- **最大教训**:**这个 bug 被前两层(coturn 配置、VPN)完美地"藏"了两天**——三个独立根因叠加,任何一层没修干净都表现为"异网络打不通",极易误判为同一个问题。**"同 WiFi 也复现"才是把矛头从网络/服务端拨回前端代码的关键信号。**

---

## 1. 现象与精确复现

用户给出的黄金复现路径(一字不改):

> 发起音视频通话,无法点击接受(直接接受建不起来),刷新一次浏览器后点击接受,成功接受但状态为"重连中",两秒钟后,通话成功实现。

拆成两条对照路径:

| 路径 | 操作 | 结果 |
|---|---|---|
| **A · 直接接受** | 来电振铃 → 直接点"接受" | ❌ 建不起来(媒体单向/卡住) |
| **B · 刷新后接受** | 来电振铃 → 刷新浏览器 → 点"接受" | ✅ 通,但先"重连中"约 2s 再接通 |

**这个对照本身就是最强线索**:同样两台设备、同样网络、同样服务端,**唯一变量是"接受前有没有刷新"**。刷新只影响**前端内存状态**(尤其是 `pendingOffer` 这份内存里的 offer),不影响服务端、不影响网络。所以根因**必然在前端、且和"刷新会清掉的那份内存状态"强相关**。

> 补充:此前一直以为是"网络/服务端"问题,是因为异网络场景同时叠了 coturn 配置坑和 VPN 污染。等那两层排干净、**同 WiFi 也能复现"直接接受打不通"**时,才确认这是一个与网络无关的前端时序 bug。

---

## 2. 概念扫盲(读完不必另开搜索)

### 2.1 offer/answer 与 SDP:先"谈能力",再"谈地址"

WebRTC 建连分两件事:

1. **媒体协商(SDP offer/answer)**:主叫 `createOffer()` 生成一段 **SDP**(Session Description Protocol,描述"我要几路音视频、什么编解码、加密参数"),发给被叫;被叫 `setRemoteDescription(offer)` 收下,再 `createAnswer()` 回一段 answer。这一步谈的是**媒体能力**,还没谈"走哪条网络路"。
2. **网络协商(ICE candidate)**:两端各自收集 `host/srflx/relay` 候选(见前两篇文档),通过信令交换,做连通性检查,选出能双向通的地址对。

**关键前后依赖:候选必须挂到"某一路媒体"上,而"有几路媒体"是 SDP 定义的。所以 `addIceCandidate()` 必须在 `setRemoteDescription()` 之后才能成功**——remoteDescription 没设,PeerConnection 还不知道有哪些 m-line(媒体行),候选无处安放,浏览器会直接报错。

### 2.2 Trickle ICE:边收集边发,不等齐

早期 WebRTC 要"把所有候选收集齐了再随 SDP 一起发",建连慢。现在标准做法是 **Trickle ICE**(RFC 8838):**每发现一个候选就立刻通过信令发给对端**,对端边收边尝试。好处是建连快;副作用是**候选和 SDP 是两条异步流、到达顺序不保证**——**候选完全可能先于 remoteDescription 到达对端**。

### 2.3 候选缓冲(pending candidates):标准且必需的模式

正因为 2.2,**每个 WebRTC 实现都要有一个"候选缓冲区"**:

- 收到对端候选时,若本端**还没 `setRemoteDescription`**(或 PC 还没建),**不能直接 `addIceCandidate`(会抛错),而要先暂存**;
- 等 `setRemoteDescription` 完成,再把暂存的候选**逐个补进** PC。

我们的实现就是这套(`web/src/utils/webrtc.ts`):

- `addIceCandidate()`:没有 `peerConnection` 或 `peerConnection.remoteDescription` 为空 → `this.pendingIceCandidates.push(candidate)` 暂存(webrtc.ts:621-633)。
- `processPendingIceCandidates()`:遍历暂存、逐个 `addIceCandidate`、再清空(webrtc.ts:661-673)。
- `handleOffer()`:`setRemoteDescription(offer)` 之后调用 `processPendingIceCandidates()`(webrtc.ts:488、530)。

**这套缓冲本身是对的。bug 不在缓冲逻辑,而在"缓冲区在错误的时机被清空了"。**

### 2.4 被叫为什么会"接听前"就收到主叫的候选

时间线(一对一呼叫):

```
主叫                                        被叫
 │ createOffer / setLocalDescription         │
 │ ── emit call:invite(含 offer) ──────────▶ │  收到来电,振铃(status=ringing)
 │ (setLocalDescription 触发 ICE 收集)        │  ← 此时被叫还没点接受,没 setRemoteDescription
 │ ── emit call:ice-candidate ×N ──────────▶ │  收到候选 → 无 remoteDescription → 暂存!
 │ ── emit call:ice-candidate ×N ──────────▶ │  继续暂存……
 │                                           │  【用户点"接受"】→ acceptCall → reset() → handleOffer
```

**主叫一 `setLocalDescription` 就开始吐候选并立刻 trickle**;而被叫**要等用户点接受才会 `setRemoteDescription`**。这中间的几百毫秒~几秒,**主叫的候选全部先到、全部被被叫暂存**。这批"早到候选"就是本 bug 的受害者。

### 2.5 `RTCPeerConnection` 生命周期与我们的 `reset()`

`WebRTCManager` 用一个 `reset()` 表示"推倒重来":`cleanup()`(关闭旧 PC、清所有状态)+ `initialize()`(建新 PC)。被叫接听前用它确保"干净开始"。**问题是 `cleanup()` 里连 `pendingIceCandidates` 也一并清了**,而此刻缓冲区里正躺着主叫的早到候选。

---

## 3. 一次"被叫接受"在代码里的完整旅程

结合 `web/src/hooks/useCall.ts` + `web/src/utils/webrtc.ts`:

```
1. 来电到达:socket 收到 call:invite
   → callStore.receiveCall:status='ringing', pendingOffer=offer(存在内存)

2. 振铃期间:socket 收到主叫 trickle 的 call:ice-candidate(多条)
   → useCall 里 webrtcRef.current.addIceCandidate(candidate)   (useCall.ts:272)
   → 此时被叫无 remoteDescription → 全部 push 进 pendingIceCandidates  (webrtc.ts:629-632)

3. 用户点"接受":acceptCall()                                   (useCall.ts:566)
   → pendingOffer 存在 → 走"直接接受"分支
   → webrtcRef.current.reset()                                  (useCall.ts:597)  ★ 事故点
       reset(): cleanup() → this.pendingIceCandidates = []      (webrtc.ts:742)  ★ 候选被清空
                initialize() → new RTCPeerConnection(...)
   → handleOffer(pendingOffer)                                  (useCall.ts:614)
       setRemoteDescription(offer)                              (webrtc.ts:488)
       processPendingIceCandidates()                            (webrtc.ts:530)
       → 但 pendingIceCandidates 已是 []!主叫早到候选全丢 → 什么都没补进新 PC
```

**结果**:被叫新 PC 只有自己收集的候选、有主叫的 SDP(知道要几路媒体),**却完全不知道主叫的任何传输地址**。ICE 无从对起 candidate pair → 被叫**发不出媒体**(coturn 侧被叫 relay `sp=0`)→ 通话建不起来。

---

## 4. 根因:`cleanup()` 清空缓冲,`reset()` 无差别继承

事故的三行(修复前):

```ts
reset(): void {
  this.cleanup();      // 里面有 this.pendingIceCandidates = []  ← 把早到候选也清了
  this.initialize();
}
```

`cleanup()` 的语义是"通话结束/失败时释放一切",清空候选缓冲**在那个语境下是对的**。但 `reset()` 复用了 `cleanup()`,于是**把"结束语义"错误地用在了"接听前重建"语义上**——接听前我们**恰恰需要保留**那批早到候选。这是**一次不加区分的复用**导致的语义污染。

---

## 5. 三个观测逐一对上(为什么正好是"直接不通/刷新通/先重连中")

| 观测 | 解释 |
|---|---|
| **直接接受建不起来** | reset() 清空主叫早到候选 → 被叫拿不到对端地址 → 单向 → 失败(§3、§4) |
| **媒体单向、coturn 被叫侧 `sp=0`** | 被叫没有对端候选可发 → 一个字节都发不出去;主叫侧有被叫候选,能单向发一点 |
| **刷新后接受能通** | 刷新清空内存,`pendingOffer` 变 `null`(callStore.restoreCall)→ `acceptCall` 走**另一条分支**(useCall.ts:576):不复用旧 offer,而是被叫 `dispatch(reconnectingCall())` + `rejoinCall(role:'callee')`,主叫收到 `call:rejoin` 后重建、重新发 offer,**双方从零重新收集并交换全部候选**——这条路没有"早到候选被清空"的问题 |
| **接通前先"重连中"约 2 秒** | rejoin 分支先把 status 置 `reconnecting`(即"重连中"),再走一整轮"新 offer→answer→重新 ICE 收集→连通性检查→connected",这轮协商约 1–2s |

> 换句话说:**刷新路径之所以"能通",不是因为它更对,而是因为它把整个协商推倒重来、绕过了缓冲区被清空的时刻。它是"用一次完整重协商掩盖了 bug",代价就是那 2 秒和一次莫名其妙的"重连中"。**

---

## 6. 修复与取舍

### 6.1 采用的修复(最小、对症)

```ts
reset(): void {
  // 保留「接受前对端已 trickle 过来、但因本端还没 setRemoteDescription 而暂存的 ICE 候选」。
  const preservedCandidates = this.pendingIceCandidates;
  this.cleanup();      // 先清理(内部会把 pendingIceCandidates 置空)
  this.initialize();   // 再建新 PC
  this.pendingIceCandidates = preservedCandidates; // 还原,待 handleOffer 设完 remoteDescription 后应用
}
```

要点:
- **捕获的是数组引用**。`cleanup()` 里是 `this.pendingIceCandidates = []`(**重新赋值**,webrtc.ts:742),不是原地清空;所以我们在 `cleanup()` 前存下旧引用,旧数组不受影响,`initialize()` 后再挂回去。
- 之后 `handleOffer` → `setRemoteDescription` → `processPendingIceCandidates()` 会**自然地**把这批候选补进新 PC(它本就是为"补暂存候选"而生的)。
- **不会重复添加**:早到候选走 `processPendingIceCandidates` 补一次;接受**之后**才到的候选,此时 `remoteDescription` 已设,`addIceCandidate` 直接进 PC。两批不相交。

### 6.2 为什么不用其它方案

| 方案 | 做法 | 为什么不选 |
|---|---|---|
| **A(采用)保留缓冲** | reset() 跨 cleanup/initialize 保留候选 | 最小、对症、语义清晰;命中"缓冲本就该跨重建存活" |
| B. 接受后请求主叫重发候选 | 被叫接听后 emit 一个"请重发候选"信令,主叫再 trickle 一遍 | 要改信令协议 + 服务端 + 两端;主叫得缓存自己发过的候选;复杂度远超收益 |
| C. 一律走 rejoin 重协商 | 直接接受也强制走刷新那条重协商路 | 就是"用 2 秒重连中掩盖 bug",每通电话都慢一拍、都闪一下"重连中",体验差;且没解决根因 |
| D. cleanup() 不清候选 | 把清空从 cleanup() 里删掉 | 破坏 cleanup 的"结束即释放"语义,通话真正结束时会残留候选内存 → 泄漏隐患 |

> 结论:**A 把"保留候选"的责任精确放在唯一需要它的 `reset()` 上,不动 `cleanup()` 的结束语义**,是外科手术式改动。

### 6.3 与"自适应 relay 升级"的关系

上一提交(`8eff563`)加的**自适应 relay 升级**(P2P 优先、失败降级 relay-over-TCP/TLS,应对 VPN/对称 NAT)**保留不动**。它和本 bug 是**正交**的两件事:relay 升级解决"路走不通",候选保留解决"根本没拿到对端的路"。**即使升级到 relay-only,候选被清空一样打不通**——所以本修复是"路能不能建立"的前置。

---

## 7. 回归测试:没有真实浏览器怎么守这个 bug

WebRTC 强依赖浏览器的 `RTCPeerConnection`,单测环境(happy-dom)没有。做法(`web/src/utils/webrtc.test.ts`):

1. **mock 全局**:`vi.stubGlobal('RTCPeerConnection', MockPeerConnection)`、`RTCIceCandidate` 同理;Mock 只实现被这条路径用到的最小表面(`setRemoteDescription/createAnswer/setLocalDescription/getSenders/addIceCandidate/close` + 事件属性)。
2. **mock 掉 `./iceServers`**:给一条 TURN,避免真去拉短期凭据。
3. **用一个跨实例的 `addIceCandidateSpy`** 统计候选是否最终补进 PC(reset() 会换新 PC,断言要能看到**新 PC** 上的调用)。
4. **测试流程还原事故**:`new WebRTCManager()` → `addIceCandidate(早到候选)`(此刻无 remoteDescription → 暂存)→ `reset()` → `handleOffer(offer)` → **断言暂存的候选最终都被 `addIceCandidate` 应用**。

**红/绿验证**:临时把 `reset()` 改回"不保留"的旧版 → 测试报 `expected to be called 2 times, but got 0 times`(候选全丢,正是 bug);恢复修复 → 绿。**这条测试精确地钉住了这个根因,防回归。**

> Web vs Native 提示:iOS/Android 原生 SDK 也有等价的候选缓冲(`RTCPeerConnection` 的 remoteDescription 未设时缓存 candidate),同样的"重建时别丢缓冲"教训在原生侧照样成立;区别只是原生能用真 SDK 做集成测试,Web 端单测得 mock。

---

## 8. 为什么这个 bug 藏了两天:三层独立根因叠加

这是本次排障最值得记的一课。**"异网络音视频打不通"这一个表象,背后其实是三个互相独立、又互相掩盖的根因**:

| 层 | 根因 | 表现 | 何时暴露 |
|---|---|---|---|
| 服务端 | coturn 三层配置(486 配额 / 403 denied-peer-ip / 508 端口段) | 异网络必须 relay,relay 分配/权限被卡 | 开 verbose 看 coturn 日志 |
| 测试环境 | 测试机开 VPN(TUN/fake-ip),污染候选、吞 UDP | 异网络更打不通,候选里全是 198.18.x | webrtc-internals 看到死地址候选 |
| **前端(本篇)** | **reset() 清空早到候选缓冲** | **连同 WiFi 直接接受也打不通** | **前两层排净后、同 WiFi 复现时** |

**它们叠加时,任何一层没修干净都表现为"打不通",极易被当成同一个问题反复在错误的层里打转**(排 coturn 排了三层、又怀疑 VPN)。**真正把矛头从"网络/服务端"拨回"前端代码"的,是一个反直觉的观测:同 WiFi(根本不需要 TURN、不经 relay)、不开 VPN,"直接接受"依然打不通,而"刷新后接受"能通。** 这个"变量只剩前端内存状态"的对照,一步锁定了前端时序 bug。

> 方法论沉淀:**当一个表象有多个可能层次(服务端/网络/客户端)时,要主动构造"能排除某几层"的最小对照实验**(如"同 WiFi + 不开 VPN"排除网络与 relay)。否则多根因叠加会让你在错误的层里无限打转。

---

## 9. 业界对比

- **标准 trickle ICE 的候选缓冲是通用刚需**:libwebrtc、simple-peer、mediasoup-client 等都有"remoteDescription 前缓存 candidate、之后 flush"的逻辑。差别在于**成熟库把缓冲区的生命周期和 PC 的重建解耦得更干净**——缓冲区通常挂在"这次协商会话"上,而不是被一个复用的 `cleanup()` 顺手清掉。我们的 bug 本质是**把会话级状态(候选缓冲)和资源级清理(cleanup)耦合了**。
- **为什么很多教程不会踩**:大量 demo 是"被叫自动接听"(收到 offer 立即 setRemoteDescription),早到候选窗口极短甚至没有;而**真实 IM 有"人工振铃-接听"的长间隔**,早到候选窗口被拉长到几秒,缓冲区里积压大量候选,一旦在接听瞬间被清空,后果就被放大。**这是"人在环路里"的产品形态特有的坑。**
- **微信等成熟 RTC**:走 always-relay + 服务端信令重放,协商更"服务端主导",客户端重建时不会丢候选(服务端会补);我们是纯 P2P 信令中转,客户端状态机自己扛,更容易在状态迁移里丢东西。

---

## 10. 经验教训(浓缩)

1. **一个表象可能是多根因叠加**——别假设"打不通"只有一个原因;每修一层都要重新构造对照实验确认是否还有下一层。
2. **"改变量最小的对照"是定位利器**——"同 WiFi + 不开 VPN + 唯一差别是刷不刷新",一步把范围锁进前端内存状态。
3. **别把"结束语义"的清理复用到"重建语义"里**——`cleanup()`(结束即释放)被 `reset()`(接听前重建)复用,顺手清掉了重建时还需要的会话状态。复用清理函数前先问:**这次调用真的想清掉里面的每一样吗?**
4. **"能通"不等于"对"**——刷新路径能通,是靠一次完整重协商掩盖了 bug(代价是 2 秒 + "重连中"闪现)。看到"绕一下就好了",要追问"为什么绕一下就好了",往往能反挖出根因。
5. **浏览器强耦合的逻辑也能且应该测**——mock 掉 `RTCPeerConnection` 的最小表面,就能把"reset() 别丢候选"这种时序 bug 钉成回归测试。

---

## 11. 验证清单与后续

- [ ] 部署后**同 WiFi 直接接受**:应一次接通,无需刷新、无"重连中"。
- [ ] **异网络直接接受**:结合 coturn 修复,应能接通;`chrome://webrtc-internals` 选中的 candidate pair `state=connected`。
- [ ] coturn `peer usage` **双向非 0**(`rp>0 且 sp>0`)——媒体真的双向中继了。
- [ ] 主叫端 webrtc-internals:被叫应有对端候选、candidate pair 成对。
- [ ] 验证通过后关掉服务器 coturn 的 `verbose`(排障期临时开的,噪音大)。
- [ ] 观察:自适应 relay 升级是否还会被触发(若候选保留修复到位,正常网络应直连成功、不再频繁降级)。
