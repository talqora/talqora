# 音视频异网络打不通 · 完整排障复盘(WebRTC / 自建 TURN)

> 一句话:**服务端 TURN 基建本身是通的,却被自己的三道"保护/优化"配置层层卡死** —— 配额(486)挡掉真 relay、黑名单(403)挡掉合法 peer 权限、端口段太小(508)分不出 relay socket。三者叠加,异网络通话永远建不起来。
>
> 关联文档:方案设计见 [`docs/技术方案/音视频通话-NAT穿透与自建TURN方案.md`](../技术方案/音视频通话-NAT穿透与自建TURN方案.md)。

---

## 0. 摘要(TL;DR)

- **现象**:同 WiFi 两设备能音视频;跨网络(尤其一端手机流量)长期打不通。
- **三层根因(按发现顺序)**:
  1. `486 Allocation Quota Reached` —— `user-quota=12` 太小,被前端候选池 + `reset` 重建的分配洪流打爆。
  2. `403 Forbidden IP` —— `denied-peer-ip` 把整段私网/CGNAT/链路本地都封了,误伤合法 peer 候选。
  3. `508 no available ports` —— relay 端口段只有 40 个(49160-49200),被分配需求耗尽,分不出 relay socket。
- **修复**:①② 已改并热更+入仓(`user-quota 12→100`、`total-quota 100→500`、`denied-peer-ip` 收敛为 5 条);前端 `iceCandidatePoolSize 10→0` 已部署;③ 端口段 `49160-49200 → 49160-50159` + 云防火墙同步放行。
- **最大教训**:**默认日志级别会骗人**(coturn 默认把 486/403/508 都藏了),排 TURN 要先开 `verbose`;**`peer usage` 双向字节非 0 才是"媒体真的通了"的唯一硬证据**。

---

## 1. 背景与现象

- **项目**:WeChat-style IM,音视频走 WebRTC。信令(谁打给谁、交换 SDP/ICE)走自有 Socket.io;媒体(音视频流)端到端 P2P,打不通时经自建 coturn 中继。
- **部署**:coturn 与 web/server 同机(腾讯 Lighthouse,`tujiang.tech`),`network_mode: host`,复用 nginx 的 Let's Encrypt 证书做 TURNS。
- **现象**:`initiateCall` 后,同一 WiFi 下两设备能建立音视频;换成异网络(对端手机流量 / 异运营商)长期打不通。
- **为什么"同 WiFi 通、异网络不通"是关键线索**:同 WiFi 走 **host 候选**(局域网直连),**不需要任何穿透**;异网络必须靠 **srflx(STUN 打洞)或 relay(TURN 中继)**。症状本身就把矛头指向"srflx/relay 这条路断了"。

---

## 2. 概念扫盲(名词 + 原理,读完不必另开搜索)

### 2.1 信令 vs 媒体:两条独立的路

WebRTC 有两条正交的通道:

- **信令(signaling)**:交换"要不要通话、编解码能力(SDP)、网络候选(ICE candidate)"。**走谁都行的通道**——本项目走 Socket.io(server 中转)。
- **媒体(media)**:真正的音视频 RTP 流,**端到端 P2P**,要穿过两端各自的 NAT。

> **信令通 ≠ 媒体通**。"电话能响、看不到画面"就是信令通了、媒体没通。本次故障全程信令是好的(能振铃、能接听),坏在媒体。

### 2.2 NAT 与 NAT 类型:为什么要"穿透"

家用/运营商网络里设备用**私网 IP**,出网时被网关做**地址转换(NAT)**。两台设备各在一个 NAT 后,彼此看不到对方私网地址,得"穿透"。NAT 按"对不同目的地是否复用同一出口端口"分四类,决定 srflx 能不能用:

| NAT 类型 | 特征 | STUN(srflx)是否有效 |
|---|---|---|
| Full Cone(全锥) | 同一内部端口→固定外部端口,谁都能回 | ✅ |
| Restricted Cone(受限锥) | 外部端口固定,但只收发过的对端能回 | ✅(打洞后) |
| Port-Restricted(端口受限锥) | 同上,且限制到对端端口 | ✅(打洞后) |
| **Symmetric(对称)** | **对每个目的地址用不同外部端口** | ❌ srflx 对不上,**只能 TURN** |
| **CGNAT** | 运营商级 NAT(4G/5G 大量使用),常是对称 + 多层 | ❌ 基本只能 TURN |

**手机流量 = 大概率对称 NAT/CGNAT = 必须 TURN relay**。这就是"异网络尤其手机打不通"的物理根源。

### 2.3 ICE:把 STUN/TURN 缝合起来的穿透框架

**ICE**(Interactive Connectivity Establishment)不是协议而是"策略框架"。它做三件事:

1. **收集候选(gather candidates)**,三类:
   - `host`:设备自己的局域网 IP(同 LAN 直达)。
   - `srflx`(server-reflexive):经 **STUN** 拿到的"公网出口映射地址",用于跨网打洞。
   - `relay`:经 **TURN** 在中继服务器上分配的地址,打洞失败时兜底。
2. **通过信令交换候选**(每发现一个就发给对端,叫 trickle ICE)。
3. **连通性检查(connectivity check)**:两端对所有 `本地候选 × 对端候选` 的**候选对(candidate pair)**互发 STUN Binding 请求,能一来一回的对才可用,选出最优对(nomination)投入媒体。

> 关键:**连通性检查必须双向都通**。只有 A→B 通、B→A 不通,这个 pair 就废——这正是本次"媒体单向"的表现。

### 2.4 STUN:只"照镜子",不转发

**STUN**(Session Traversal Utilities for NAT):设备问 STUN 服务器"我在你眼里的公网地址是啥",拿到 srflx。**只照镜子、不转发媒体**;对对称 NAT 无效(镜子里的端口和真正发媒体时用的端口对不上)。

### 2.5 TURN:真正的中继(打不通的兜底)

**TURN**(Traversal Using Relays around NAT):两端都把媒体发给 TURN 服务器,TURN 转发给对方。代价是媒体过服务器、吃带宽;好处是**任何 NAT 都能通**。TURN 有严格的握手四步(理解这些才看得懂日志):

1. **Allocate**:客户端请求"给我开一个 relay 地址/端口"。coturn 在 `min-port~max-port` 段里开一个 UDP socket,回一个 relay 地址(本项目=公网 IP:某端口)。→ **端口段太小就在这步 508**。
2. **CreatePermission**:客户端告诉 relay"允许来自对端地址 X 的包"(安全:relay 默认不收未授权来源)。→ **对端地址被黑名单命中就在这步 403**。
3. **ChannelBind**(可选优化):给某对端地址绑一个 2 字节 channel 号,省掉每包 36 字节的 header。
4. **Send/Data**:媒体经 relay 来回转发。

> 一句话:**Allocate 成功 ≠ 通**。还得 CreatePermission 成功、且两端的 relay/srflx 之间连通性检查双向通,媒体才走得起来。

### 2.6 TURN 鉴权:短期 HMAC(`use-auth-secret`)与"正常的 401"

不能给前端烤死账号密码(公开 bundle = 对全网公开你的 TURN)。业界标准是 coturn 的 `use-auth-secret`(TURN REST API,Twilio 同款):

- 服务端与 coturn **共享一个 `TURN_SECRET`**(不下发客户端)。
- 客户端要用 TURN 时,向服务端换一枚**短期凭据**:`username = "<到期unix时间戳>:<用户id>"`,`credential = base64(HMAC-SHA1(TURN_SECRET, username))`。
- coturn 用同一 secret 校验时效 + 重算 HMAC 比对。

> **⚠ 排障陷阱:日志里成片的 `error 401: Unauthorized` 是"正常"的。** TURN 长期凭据机制要求**第一个请求不带凭据 → coturn 回 401 带 realm/nonce → 客户端带凭据重试**。日志里 `user <>`(空用户)的 401 就是这个挑战握手,不是鉴权失败。真失败会是"用户名/密码不符"且**始终**拿不到 allocation。

### 2.7 coturn 的三道"保护"配置(本次三个坑的出处)

| 配置 | 作用 | 触发的错误 | 我们的坑 |
|---|---|---|---|
| `user-quota` / `total-quota` | 单用户/全服并发 allocation 上限,防滥用 | **486 Allocation Quota Reached** | `user-quota=12` 太小 |
| `denied-peer-ip` | relay 对端地址黑名单,防把 TURN 当跳板打内网(SSRF) | **403 Forbidden IP** | 整段封私网/CGNAT/链路本地,误伤合法候选 |
| `min-port`/`max-port` | relay socket 端口段(须与云防火墙放行一致) | **508 no available ports** | 只给 40 个(49160-49200),太少 |

### 2.8 `peer usage`:媒体是否真中继的唯一硬证据

coturn 会话结束打印两行用量:

```
session ...: usage:      rp=.. rb=.. sp=.. sb=..   ← 客户端↔coturn 那一腿
session ...: peer usage: rp=.. rb=.. sp=.. sb=..   ← coturn↔对端 那一腿(relay 真转发量)
```

`rp/rb`=收包/字节,`sp/sb`=发包/字节。**`peer usage` 双向都非 0 才是"媒体真的来回中继过"**;若 `sp>0,rp=0`(只发不收)或全 0,就是单向/没通。这是从服务端判断通话是否成功的黄金指标。

### 2.9 前端 `iceCandidatePoolSize`:与 TURN 的反模式

`RTCConfiguration.iceCandidatePoolSize=N` 让浏览器**为每个 PeerConnection 预取一池候选**(想加速建连)。但**有 TURN 时它是反模式**:预取会为池里每一份都去 TURN 上 Allocate 一个 relay,`N=10` 就是一次预分配 ~10 个 relay;叠加通话内 `reset()` 重建 PC,单用户 allocation 数成倍暴涨 → 撞配额、耗端口。**有 TURN 应设 0**(按需分配)。

### 2.10 host 网络 + 1:1 NAT + `external-ip`(部署侧要点)

- coturn 用 `network_mode: host` 直接绑宿主端口、看真实网络(TURN relay 会动态开一段 UDP 端口,bridge 的端口映射+NAT 会把 relay 地址搞乱)。
- Lighthouse 是 **1:1 NAT**:网卡只看到私网 IP `10.0.0.5`,公网 IP `115.159.224.210` 由云做 DNAT。故 coturn 要 `listening-ip/relay-ip=10.0.0.5`(真实网卡,别落到 docker 网桥 172.x)、`external-ip=115.159.224.210/10.0.0.5`(对外广播公网、内部用私网)。
- **relay 端口段必须与云防火墙放行的 UDP 段一致**——这是本次第三个坑的耦合点。

---

## 3. 架构与数据流

```
                 ┌── 信令(SDP/ICE)── Socket.io ── our-chat server ──┐
   浏览器 A ─────┤                                                  ├───── 浏览器 B
                 └── 媒体:优先 P2P(host/srflx);打不通则 ─────────┘
                                 ↓ 经自建 coturn 中继(relay)↓
                         coturn(host 网络,external-ip=公网/私网)
   凭据:A/B 登录后 GET /api/turn-credentials → server 用 TURN_SECRET 现算短期 HMAC 凭据
```

- 前端流程(`web/src/utils/iceServers.ts` + `webrtc.ts` + `hooks/useCall.ts`):通话前 `await ensureIceServers()` 拉凭据 → `reset()` 用最新 iceServers 重建 `RTCPeerConnection` → 采集媒体 → createOffer/Answer → trickle ICE。
- 服务端凭据端点 `GET /api/turn-credentials`(`authenticateToken` 保护)返回 `{ iceServers, ttl }`。

---

## 4. 排查历程(时间线,含所有走过的弯路)

每步:**假设 → 验证 → 结论**。诚实记录弯路,因为弯路本身是教训。

| # | 假设 | 验证手段 | 结论 |
|---|---|---|---|
| ① | 只配了 Google STUN、无 TURN,国内连不上又无兜底 | 读 `webrtc.ts` | **部分成立**:自建 coturn 补 TURN。仍不通 |
| ② | relay 候选落到 docker 网桥(172.x)对外不可达 | host 网络下 coturn 把网桥/回环也当 relay 地址 | **成立**:锁 `listening-ip/relay-ip=10.0.0.5`、`external-ip`。**仍不通** |
| ③ | 前端根本没拉到 TURN 凭据 | 一度 nginx 0 命中 | **证伪**:后续看到两端都 `GET /api/turn-credentials → 200` |
| ④ | 微信内置浏览器 WebRTC 残缺 | nginx UA 里确有 `MicroMessenger/XWEB` | **证伪**:两端都换 Chrome 仍不通 |
| ⑤ | 需要会话级细节才定位 | coturn 默认只吐 `allocation count` DEBUG,藏了 486/403/508 | **开 `verbose` + 重启** → 拿到实锤 |
| ⑥ | 配额 + 黑名单卡死 | verbose 见 486×362、403 on CreatePermission | **成立**:改 `user-quota`、收敛 `denied-peer-ip`(热更) |
| ⑦ | 修完仍不通,还有一层 | verbose 见 `508: create_relay_ioa_sockets: no available ports` | **成立**:40 端口段耗尽 → 放宽端口段 + 云防火墙 |

> ③④ 两个弯路耗时最多。教训:**默认日志级别不给会话细节,导致只能靠猜;应在第一时间开 verbose。**
> 期间还澄清过一个前提误判:一度以为前端 `iceCandidatePoolSize=0` 没部署,**实测线上 bundle 才确认早已是 0** —— 避免了在错误前提上继续。

---

## 5. 根因深度剖析(三层)

### 5.1 `486 Allocation Quota Reached`(362 次)

```
session ...: user <...:1>: incoming packet ALLOCATE processed, error 486: Allocation Quota Reached
```

- **机制**:前端 `iceCandidatePoolSize:10` 让每建一个 PeerConnection 就预取一池 relay;通话内 `reset()`(cleanup+重建)会再造新 PC;旧 allocation 要到 stale 超时才释放。于是**单用户短时间内的 allocation 数远超 `user-quota=12`**,coturn 对**真正通话要用的那个 ALLOCATE** 回 486 → 拿不到 relay 候选。
- **佐证**:峰值并发 allocation 冲到 193(> `total-quota=100`)。

### 5.2 `403 Forbidden IP`(CreatePermission)

```
session ...: user <...:0>: incoming packet CREATE_PERMISSION processed, error 403: Forbidden IP
```

- **机制**:`denied-peer-ip` 把整段 `10/8`、`100.64/10`(CGNAT)、`169.254/16`、`172.16/12`、`192.168/16` 都封了。WebRTC 会为对端**每个候选**建 permission,而手机 CGNAT 的 srflx、家庭 LAN、iOS 链路本地等**合法候选**命中黑名单 → 403 → 媒体权限建不起来。
- 危险在:**过度的 SSRF 防护把正常用户的候选当成攻击目标挡了**。

### 5.3 `508 no available ports`(端口段耗尽,最后一层)

```
INFO: create_relay_ioa_sockets: no available ports
session ...: incoming packet ALLOCATE processed, error 508: Cannot create socket
```

- **机制**:relay 端口段只有 40 个(`min-port=49160`~`max-port=49200`)。即便 `iceCandidatePoolSize=0`,每通电话仍会为多种 TURN 传输(udp/tcp/tls)、audio+video、`reset()` 重建各分配 relay,再叠加反复测试 + coturn 分配后要等 stale 超时(分钟级)才释放端口 → 40 个瞬间占满 → 无法再创建 relay socket。
- **为什么表现为"媒体单向"**:端口一满,**一端分到了 relay、另一端 508 分不到** → 只有一侧有 relay 候选 → 媒体只能单向走(日志里 `sp>0, rp=0`),连通性检查双向不通 → 通话失败。
- **和防火墙的耦合**:relay 端口段必须与云防火墙放行的 UDP 段**一致**。放宽端口段必须**同步放宽 Lighthouse 防火墙**,且**先放行防火墙、再扩 coturn**,否则 coturn 会把 relay 分到未放行端口,反而更糟。
- fd 上限(524288)充足,排除文件描述符原因。

**三层合起来**:server 基建(STUN 可达、端口开放、relay 能分配、能中继)一直是好的,**通话却被配额挡、被黑名单挡、被端口段挡**。完美解释"同 WiFi(host,不需 relay)通、异网络(必须 relay)不通"。

---

## 6. 诊断方法论(可复用)

- **先开 `verbose`**:coturn 默认只吐 `allocation count` DEBUG,把 486/403/508 这些决定性 INFO 全藏了。排 TURN 第一步就该开 verbose 再复现。
- **看 `peer usage` 双向字节**:allocation 成功 ≠ 通;必须 `rp>0 且 sp>0`(媒体真来回)。单向或全 0 = 没通。
- **逐层证伪**:凭据未拉取、微信浏览器…每个假设都用**数据**证实/证伪,避免在错误方向空转。
- **分清服务端 vs 客户端边界**:能从 server 日志看的(分配/权限/端口/配额/字节量)先看透;真到"两端 ICE 为何没选中某 pair"才需要 `chrome://webrtc-internals`。
- **错误码直接查表**:401=正常 nonce 挑战;403=denied-peer-ip;438=nonce 过期;486=配额;508=端口/socket 创建失败。

---

## 7. 修复清单

| 项 | 改动 | 为什么 | 状态 |
|---|---|---|---|
| coturn 配额 | `user-quota 12→100`、`total-quota 100→500` | 给候选池+reset 的瞬时分配留余量,消 486 | ✅ 热更 + 入仓 |
| coturn 黑名单 | `denied-peer-ip` 收敛为 5 条(回环 + 云元数据单 IP `169.254.169.254` + 本机 VPC `10.0.0.0/22` + docker 网桥 `172.17-172.20`) | 放开常规私网/CGNAT/链路本地(本就不可从服务器路由,封了只误伤),消 403 | ✅ 热更 + 入仓 |
| 前端候选池 | `iceCandidatePoolSize 10→0` | 从源头减少无谓 relay 分配 | ✅ 已部署(线上 bundle 实测为 0) |
| relay 端口段 | `49160-49200`(40)→ `49160-50159`(1000)+ **Lighthouse 防火墙同步放行** | 40 个太少必被耗尽 → 508;放宽供给 | ✅ 防火墙已放行 + coturn 同步 |

---

## 8. 取舍与设计反思

- **"为了防火墙好配"把 relay 段收窄到 40 个,是过度优化 → 成瓶颈。** coturn 默认段是 1.6 万端口。取舍:窄段=防火墙规则简单但易耗尽;宽段=稳但暴露面大、防火墙规则要覆盖。合理折中是几百~上千端口。
- **三个坑本质同源:安全/防滥用配置用默认或粗粒度值,会误伤自己的正常流量。** `user-quota`、`denied-peer-ip`、窄端口段都是"保护",但都需**按真实拓扑与真实负载收敛**,而不是拍脑袋的小值/一刀切。
- **`iceCandidatePoolSize` 与 TURN 是反模式**:预取池对 TURN 成倍放大分配。有 TURN 一律设 0。
- **自建 TURN vs 托管(腾讯 TRTC)**:自建省钱、可控,但要自己扛配额/端口/防火墙/带宽这些运维细节(本次三个坑都在这)。要扛规模化视频再上托管 SFU/TRTC。

---

## 9. 经验教训(浓缩)

1. **默认日志会骗人**——排 TURN 先开 verbose,别靠猜。
2. **`peer usage` 双向非 0 才叫通**——allocation 成功不代表媒体通。
3. **"保护"配置会误伤自己**——quota/ACL/端口段都要按真实拓扑收敛。
4. **别被"基建健康"误导**——STUN 通、端口开、relay 能分配,都不等于通;瓶颈常在配额/ACL/端口这种"最后一米"。
5. **改前先核对现状**——一度以为前端没部署,实测线上 bundle 才发现早已是 `poolSize=0`,避免了在错误前提上继续。

---

## 10. 后续待办

- 复测确认 508 消失、`peer usage` 双向非 0(端口段放宽 + 防火墙已放行后)。
- 验证通过后关闭 coturn `verbose`(默认级别噪音低)。
- 视需要把端口段/配额的取舍写回技术方案文档,避免后人再踩。
