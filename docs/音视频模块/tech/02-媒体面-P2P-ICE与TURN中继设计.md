# 音视频模块 · 媒体面:P2P、ICE 与 TURN 中继

> 控制面见 [01 篇](./01-整体架构与信令状态机.md)。本篇只讲**媒体怎么从 A 到 B**,以及为什么当前实现要"先试 P2P,失败再整体升级到中继"。

## 0. TL;DR

- 媒体路径有三种,浏览器按 ICE 候选自动选最优:**host(同网直连)→ srflx(经 STUN 反射穿透 NAT)→ relay(经 TURN 中继)**。服务端不参与选择。
- TURN **不是默认路径**,而是兜底。默认 `iceTransportPolicy: 'all'` 让 P2P 优先(低延迟、零服务器带宽),失败才升级。
- 升级方式不是"改个参数",而是**重建 PeerConnection**:`iceTransportPolicy` 只能在构造 `RTCPeerConnection` 时确定。所以升级 = `setForceRelay(true)` → `reset()` → 重新 offer/answer。
- **必须双端都切 relay 才建得起来**。单端 relay-only、对端 all,ICE 检查仍可能匹配到一条不通的路径。所以主叫在 `call:rejoin` 里带 `relay: true` 标记,服务端原样转发,被叫收到后同步切。
- 候选缓冲(`pendingIceCandidates`)是**必需**的:trickle 候选常早于 `setRemoteDescription` 到达,直接 `addIceCandidate` 会抛错丢弃。
- `iceCandidatePoolSize: 0` 是**踩过坑后的选择**:候选池会为每个 PC 预分配 relay,叠加通话内 reset 重建 → 撞 coturn `user-quota` 486,真正需要中继时反而分配不到。
- 凭据用 **TURN REST API** 格式:`username = <expiry>:<userId>`,`credential = base64(HMAC-SHA1(secret, username))`。短期、绑用户、服务端可无状态校验。

---

## 1. 三种候选:媒体到底怎么走路

```text
① host(同网/同 NAT 内)
   A ────────── 局域网直连 ────────── B
   延迟最低,零服务器成本;跨网必失败

② srflx(STUN 反射)
   A ──STUN 问"我的公网地址"?──▶ coturn:3478
   A ◀── "你是 1.2.3.4:54321" ──
   A ══════ UDP 打洞 ══════▶ B
   靠 STUN 知道自己的 NAT 映射,双方互打洞;
   对称 NAT / 严格防火墙下打不通(VPN 的 TUN 模式必死,见 VPN 那篇)

③ relay(TURN 中继)
   A ══════▶ coturn ══════▶ B
   所有包经服务器转发;一定通,但吃服务器带宽 + 增加一跳延迟
```

`buildRtcConfiguration`(`web/src/utils/webrtc.ts:12-33`)默认给 `'all'`,即三种都收集、由 ICE 自己挑。**只有 `forceRelay` 为真且确实配了 TURN 时**才设 `iceTransportPolicy: 'relay'`——否则本地开发环境(TURN 为空)会连 host 候选都没有,同网都打不通。

---

## 2. 协商流程与候选缓冲

### 2.1 为什么需要 `pendingIceCandidates`

ICE 候选是**基于 SDP** 的:候选里的 `sdpMid` / `sdpMLineIndex` 指向 SDP 的某一行。没有 `setRemoteDescription`,浏览器不知道往哪个 m-line 挂候选,`addIceCandidate` 直接抛 `InvalidStateError`。

而 trickle ICE 的设计初衷就是"边收集边发",候选**必然**可能早于 answer 到达。所以:

```text
addIceCandidate(candidate):
  if (!peerConnection)              → 暂存    (webrtc.ts:621-627)
  if (!remoteDescription)           → 暂存    (webrtc.ts:630-635)
  else                              → 立即添加 (出错只 warn,不中断)
```

`processPendingIceCandidates()` 在 `setRemoteDescription` 之后统一冲刷(`:661-680`)。

### 2.2 一个真实事故:reset 把候选冲掉了

被叫点"接听"时会走 `reset()` 重建 PC。旧实现里 `cleanup()` 会**清空 `pendingIceCandidates`**——于是主叫在被叫接听前 trickle 过来的候选全丢了,被叫不知道往哪发包 → **媒体单向**。现象极具迷惑性:"直接接听打不通,但刷新页面走 rejoin 就通了"(因为那条路径重新协商过)。

修复(`webrtc.ts:765-779`):

```ts
const preservedCandidates = this.pendingIceCandidates;
const preservedStream = this.localStream;
this.cleanup({ keepStream: true });   // 清 PC,不停轨道,不清候选
this.initialize();
this.localStream = preservedStream;
this.pendingIceCandidates = preservedCandidates;
```

同一条修复里还保留了**本地媒体流**:通话中收到对端 rejoin 要重协商,如果重建时把轨道 stop 掉,本端就得重新 `getUserMedia`——权限弹窗/设备被占用会让重协商卡住,offer 拿不到 answer,12s 后被服务端 grace 结束。**这两条都不是理论风险,是实测根因。**

### 2.3 重协商时不要重复 addTrack

`createOffer()` 用 `getSenders()` 比对已有轨道,只添加缺失的(`webrtc.ts:406-419`)。重复 `addTrack` 同一 `MediaStreamTrack` 会抛 `InvalidAccessError`,且在 rejoin 场景下会创建多余的 transceiver,让 SDP 膨胀、协商变慢。

---

## 3. 自适应 relay 升级(本模块最核心的设计)

### 3.1 为什么不能"一直用 relay"

| 方案 | 延迟 | 服务器带宽 | 可用性 |
|---|---|---|---|
| 只用 P2P | 最低(通常 20-60ms) | 0 | 对称 NAT/VPN/严格防火墙下**打不通** |
| 只用 relay | +1 跳(多 30-80ms) | 每路 2-4 Mbps | 几乎一定通 |
| **自适应(当前)** | P2P 成功时最低 | 仅失败的那部分 | 两者兼得 |

### 3.2 触发条件与流程

```text
建连(默认 all)
   │
   ├─ connectionState → connected        ✅ 结束,走 P2P
   │
   └─ connectionState → failed
         │
         ▼
      escalateToRelay()                    useCall.ts:566-580
         │  relayEscalated 已为 true? → 直接返回(每通只升一次)
         │  setForceRelay(true)
         ▼
      ┌── 我是主叫 ──────────────────────────────┐
      │  rejoinCall({...}, relayOnly=true)        │
      │   → ensureIceServers()                    │
      │   → webRTC.reset()      (重建 PC)         │
      │   → getUserMedia()      (媒体可能已停)     │
      │   → createOffer()                         │
      │   → ws.send('call:rejoin', { offer, relay: true })
      └───────────────────────────────────────────┘
                    │
                    ▼ 服务端原样转发 call:rejoin
      ┌── 我是被叫(收到带 relay:true 的 rejoin)──┐
      │  relayEscalated = true                    │
      │  webRTC.setForceRelay(true)               │
      │  → reset() → handleOffer(offer) → 回 answer│
      └───────────────────────────────────────────┘
```

三个必须理解的约束:

1. **只有主叫重发 offer**。被叫只本地切 relay 然后等 rejoin。若双方同时发 offer 会 `glare`(双方都处于 `have-local-offer`,谁也设不了 remote)。当前实现靠"重连方永远是发 offer 的一方"这条规则规避(`useCall.ts:502`)。
2. **`relay` 标记未进 IDL**。它是客户端私有字段,靠 `rawJSON` 原样转发穿透服务端(`useCall.ts:289` 用窄化类型读取)。这是一处**契约外的隐式协议**——proto 改版或服务端做字段白名单时会静默失效。
3. **每通只升一次**。`relayEscalated` 是模块级变量,不随 PC 重建重置。避免"P2P 失败→relay→又失败→无限重建"的抖动。代价:如果第一次 relay 也失败(例如 coturn 挂了),这通电话只能靠用户手动挂断重拨。

### 3.3 为什么升级必须重建 PC

`iceTransportPolicy` 是构造参数,`RTCPeerConnection` 创建后**无法修改**。想从 `all` 变 `relay`,只能:

```text
new RTCPeerConnection({ iceTransportPolicy: 'relay' })
```

所以 `setForceRelay` 只是置标志(`webrtc.ts:756-759`),真正的生效点是下一次 `reset()`/`initialize()`。这一层间接性容易让人误以为"设了就生效"——注释里专门写明了。

---

## 4. TURN 凭据的签发与消费

### 4.1 服务端:HMAC 临时凭据

coturn 的 `static-auth-secret` 模式(TURN REST API)允许服务端**不存用户**就签发凭据:

```text
expiry     = now + ttlSec
username   = "<expiry>:<userId>"                      ← 明文,但被 HMAC 保护
credential = base64(HMAC-SHA1(secret, username))      ← 只有持 secret 者能算
```

实现:`biz/internal/api/auth_routes.go:400-430`(`buildTurnIceServers`)。返回结构:

| urls | 用途 |
|---|---|
| `stun:<host>:3478` | 拿 srflx 候选 |
| `turn:<host>:3478?transport=udp` | 中继,优先 UDP(延迟低) |
| `turn:<host>:3478?transport=tcp` | UDP 被墙/被限速时的退路 |
| `turns:<host>:5349?transport=tcp` | TLS 中继,穿严格防火墙 |

并带 `Cache-Control: no-store`——凭据是短期的,不能被中间层缓存。

### 4.2 客户端:缓存 + 提前刷新 + 失败降级

`web/src/utils/iceServers.ts` 三个设计点:

- **TTL 缓存 + 60s 提前量**:`Date.now() < expiresAt - 60_000` 才复用,避免边界拿到刚好过期的凭据。
- **并发去重**:`inflight` 让同一时刻的多次调用共享一次请求。通话建立时 `ensureIceServers()` 可能被多条路径同时调用。
- **失败不阻断**:拉取失败只 `console.warn`,保留旧缓存(可能为空)→ 退化为仅 host 候选。**宁可同网可通,也不让整个通话因凭据接口异常而无法建立。**

> 这是一个有意的降级取舍:凭据接口挂掉时,同网用户仍能通话,跨网用户失败。比"所有人都不许打"更合理。

### 4.3 coturn 侧配置

| 项 | 值 | 为什么 |
|---|---|---|
| `network_mode: host` | 必须 | relay 要在真实网络上动态开一段 UDP 端口;bridge 的 NAT 会把 relay 地址搞乱 |
| `listening-ip` / `relay-ip` | 锁真实私网网卡 | host 网络下 coturn 会把 docker 网桥(172.x)、回环也当候选 → 中继落在 172.x,对外不可达 |
| `external-ip` | `<公网>/<私网>` | 告诉 coturn 对外映射,否则 relay 候选给的是私网地址 |
| `min-port` / `max-port` | 49160 / 50159 | 每路 allocation 占 1 个 relay 端口 |
| `realm` | `tujiang.tech` | 凭据域 |
| `no-multicast-peers` | 开 | 防被当作内网扫描跳板 |
| 证书 | 复用 nginx 的 Let's Encrypt | `turns:` 必须有效证书 |

启动参数经 compose `command` 注入(`docker/docker-compose.prod.yml:171-183`),secret 不落进只读挂载的 conf。

---

## 5. 一个必须记录的配置漂移

`docker/coturn/turnserver.conf:24-25` 声明 `min-port=49160`、`max-port=50159`(1000 个端口),但同仓 `docker-compose.prod.yml:165` 的运维注释写着"需放行 **49160-49200** udp"。

两者不一致。coturn 从这个区间里分配 relay 端口,于是:

- 落到 49160-49200 的 allocation:正常;
- 落到 49201-50159 的 allocation:若云防火墙/安全组按注释只放行了 49160-49200 → **allocation 成功但媒体不通**,且 coturn 日志看起来是"正常"的;
- 表现:小规模测试一切正常(只用了前几个端口),并发一上来就开始"部分人通话无声",且极难复现。

**结论**:端口段是 coturn 容量与防火墙策略的**共同契约**,必须单点定义。要么把防火墙放到 50159,要么把 `max-port` 收到 49200。当前状态属于"配置在代码里,契约在注释里"。

---

## 6. 容量口径(不要拍脑袋)

| 资源 | 计算 | 当前配置下的上界 |
|---|---|---|
| relay 端口 | 范围大小 ÷ 每路占用 | 1000 ÷ 1 = **1000 个 allocation** |
| 双边中继通话 | allocation ÷ 2(双方都中继) | **约 500 路** |
| 带宽 | 路数 × 码率 × 2 | 视频 1.5 Mbps/方向 → 500 路 ≈ **1.5 Gbps** |
| CPU | 单线程转发 | `relay-threads` 未显式配置,单核可能先饱和 |

三条必须带上的限定:

1. **这是估算,不是实测**。真实并发取决于 NAT 类型分布——P2P 成功的那部分**完全不占服务器资源**。
2. **带宽通常先于端口成为瓶颈**。1.5 Gbps 对普通云主机是硬墙。
3. 上述结果**不能**写成"支持 N 人同时视频通话"。产品容量还取决于客户端上下行带宽、码率协商、以及(最重要的)实际 P2P 成功率。

压测侧对应的信令场景与估算口径见 [`docs/监测设施/prompts/压测分析SOPV3.md`](../../监测设施/prompts/压测分析SOPV3.md) §5.2。

---

## 7. 故障决策表

| 症状 | 大概率在哪一层 | 先看什么 |
|---|---|---|
| 双方都听不到 | 信令没通 | WS 是否连、`call:start` 是否下发、`server_call_events_total` 有没有 `start` |
| 一方能听到一方不能(媒体单向) | ICE 候选 / SDP 方向 | `chrome://webrtc-internals` 看候选类型与 `selectedCandidatePair`;查是否 reset 丢了候选 |
| 同网正常、跨网不通 | NAT 穿透 | 有无 srflx/relay 候选;STUN 是否可达;是否开着 VPN(`04` 篇) |
| 小规模正常、并发上来部分无声 | coturn 端口/配额 | 端口段与防火墙是否一致;coturn 日志有无 486/508 |
| 接通后立刻断 | 会话被清 | 是否 `callId` 格式不匹配导致 `call:end` 广播失败后 TTL 过期;grace 是否误触发 |
| 刷新页面后接不回来 | rejoin 重协商 | 见 [03 篇](./03-通话可靠性与多端一致性.md) |

排障全过程见 [`../debug/音视频异网络打不通-WebRTC与自建TURN完整排障复盘.md`](../debug/音视频异网络打不通-WebRTC与自建TURN完整排障复盘.md)。
