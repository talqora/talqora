# 让音视频通话"开着 VPN/代理也能用" · 可行性研究与落地方案

> 问题:排障发现"测试机开 VPN(TUN/fake-ip)会毁掉 WebRTC"(机制见 [`docs/技术细节/VPN代理为何毁掉WebRTC-fakeip与TUN模式深度分析.md`](../技术细节/VPN代理为何毁掉WebRTC-fakeip与TUN模式深度分析.md))。但**微信开任何 VPN 都能正常通话**——"让用户关 VPN"不是可接受的产品答案。本文研究:我们这套(浏览器 WebRTC + 自建 coturn)**能不能做到同等鲁棒,以及怎么做**。
>
> **结论先行:能。核心是把媒体从"UDP P2P 优先"改成"relay over TCP/TLS(优先 443)优先/兜底",这正是微信之流"哪都能用"的底层做法。** 不能保证 0.01% 的病态代理,但能覆盖到"开着主流 VPN 也能用"。

---

## 1. 先拆解:微信凭什么开 VPN 也能用

微信不是浏览器 WebRTC,是**原生 RTC 引擎**,但它"哪都能用"靠的几点,原理是通的、可以对齐:

1. **全程走自家边缘中继(always-relay),不赌 P2P。** 不依赖 srflx/host 候选质量;哪怕候选被污染,它只需要"连上自己的中继服务器"这一件事。
2. **多传输 + TCP/443(TLS)兜底。** UDP 不通就切 **TCP over 443**——长得和 HTTPS 一模一样,**VPN/代理/企业防火墙/对称 NAT 全都放行**。这是"哪都能用"的真正命门。
3. QUIC(UDP/443)、多路探测、快速切换等工程加成。

> **关键洞察:VPN(TUN)对 TCP 的转发是完整的(它本来就代理你所有 HTTPS);坏的只有 UDP。** 所以**只要把媒体走到 TCP/TLS 中继,就绕开了"UDP 被 TUN 吞"这条死路。** 微信能用 = always-relay + TCP/443 兜底,而不是靠 UDP 直连打洞。

---

## 2. 为什么浏览器 WebRTC 默认会"栽"在 VPN 上

WebRTC 默认是 **P2P 优先 + UDP 优先**的 ICE 过程:

- 先枚举 host(含 VPN 虚拟网卡的 `198.18.x` 死地址)、srflx(经代理出口、失真)、relay。
- 按优先级并行做连通性检查,**UDP 直连/UDP relay 优先级高**。
- 结果:一堆时间浪费在被污染的 host/srflx 和被 TUN 吞掉的 UDP relay 上,**很可能在稳定落到"TCP/TLS relay"这条能穿 VPN 的路之前就失败/超时**。

**所以问题不在"没有能穿 VPN 的路",而在"没优先走那条路 + 被垃圾候选拖垮"。**

---

## 3. 现状盘点(我们缺的正是"优先走 TCP/TLS relay")

当前 `/api/turn-credentials` 返回的 iceServers:

```jsonc
{ "urls": ["stun:tujiang.tech:3478"] },
{ "urls": [
    "turn:tujiang.tech:3478?transport=udp",   // UDP relay —— 被 TUN 吞
    "turn:tujiang.tech:3478?transport=tcp",   // TCP relay —— 能穿,但 3478 端口某些网络不放行
    "turns:tujiang.tech:5349?transport=tcp"   // TLS relay —— 能穿,但在 5349 而非 443
] }
```

三个缺陷:

1. **没强制/优先 relay** → host/srflx 的 `198.18.x` 垃圾候选污染 ICE。
2. **TURNS 在 5349 而非 443** → 最严格的网络/某些代理只干净放行 443(和 HTTPS 同端口最不可疑)。
3. **没有"UDP 失败 → 稳定降级到 TCP/TLS relay"的策略保证**。

---

## 4. 方案(分层,含取舍与落地)

### 方案 A · 强制/自适应 relay(前端,最快见效)

- `RTCConfiguration.iceTransportPolicy = 'relay'`:**只用 relay 候选,直接扔掉 host/srflx 的垃圾候选**;配合 turn-tcp/turns 就走 TCP relay,穿 VPN。
- **取舍**:所有通话(含同 WiFi)都过中继,吃服务器带宽 + 略增延迟。
- **更优:自适应**——先用默认(`all`,P2P 优先,正常网络低延迟)建连;**若 N 秒内 ICE 未 connected 或进入 failed,自动以 `iceTransportPolicy:'relay'` + 只保留 turns/turn-tcp 重连**。兼顾正常网络的低延迟与异常网络的鲁棒。这最接近微信"能直连就直连,不行就落中继"的体感。

### 方案 B · TURNS over 443(服务端,最关键的一层)

把 TURNS(TLS)放到 **443**,对代理/防火墙最友好(和 HTTPS 同端口、同握手,几乎不可能被区别对待)。难点是 **443 已被 nginx(HTTPS)占用**,三种落地:

- **b1(推荐)nginx `stream` + `ssl_preread` 按 SNI 分流**:同一个 443,`turn.tujiang.tech` 的 TLS 握手 → 转给 coturn(TURNS),`tujiang.tech` → 转给 nginx 的 HTTPS。`ssl_preread` 只读 SNI 不解密,原样转发,两者各用各的证书(可共用含两个域名的 SAN 证书)。
- b2. 给 coturn 单独一个公网 IP,直接 443 监听 TURNS。
- b3. coturn 抢宿主 443 —— 和 nginx 冲突,不可行。

对应 iceServers 增加 `turns:turn.tujiang.tech:443?transport=tcp`,并把它排在**最前/优先**。

### 方案 C · 候选过滤(兜底,治标)

- 前端 `onicecandidate` 里过滤掉 `198.18.x`、链路本地等明显死地址,减少 ICE 干扰。不如 A 干净,作为辅助。

### 方案 D · 生产级组合(推荐最终形态)

**方案 B(TURNS/443)提供"能穿一切"的传输** + **方案 A 的自适应**(默认直连、失败降级 relay-only-over-TLS-443 重连)。这就是微信级"哪都能用"的等价实现。

---

## 5. 这能"彻底"解决吗?(诚实边界)

| 拦路环境 | relay over TCP/TLS 443 能不能穿 | 说明 |
|---|---|---|
| VPN/代理(TUN/fake-ip) | ✅ | TCP/443 被代理当 HTTPS 正常转发 |
| 对称 NAT / CGNAT(手机流量) | ✅ | relay 本就为此设计 |
| 企业防火墙只放行 443 | ✅ | TURNS 443 = 看着就是 HTTPS |
| DPI 深度检测/SNI 封锁 | ⚠ 多数可 | TLS 握手正常;极端 DPI 可能封,罕见 |
| 病态代理连 TCP 443 都乱搞 | ❌ | 极少数,微信也未必扛得住 |

其它要一并确认/注意:

- **relay-relay 同机 hairpin**:两端都走我们**同一台** coturn 的 relay,coturn 要能把 relayA→relayB 内部互转。需确认 `external-ip=公网/私网` 让 coturn 正确识别自身、内部路由(排障中 `10.0.0.5` 那个疑点就在查这个)。若不行,备选是两台 coturn / 确保走 srflx-relay 混合对。
- **带宽**:always/降级 relay 后,视频一路约 1–2.5 Mbps × 双向都过服务器,吃 Lighthouse 带宽。规模化视频要上 SFU / 腾讯 TRTC。

**结论:能做到"开着主流 VPN 也能用",核心就三样——① relay over TCP/TLS,② 端口用 443,③ 前端自适应降级 relay-only。** 覆盖不了 0.01% 病态代理,但那已是微信同级别的边界。

---

## 6. 落地清单(按优先级)

1. **前端自适应降级**(方案 A):`useCall` 里通话建连超时/failed → 以 `iceTransportPolicy:'relay'` 重建重连。**改动最小、先上,立刻能验证"开 VPN 时强制走 TCP relay 能不能通"。**
2. **服务端 TURNS/443**(方案 B/b1):nginx `stream + ssl_preread` 按 SNI 把 443 分给 coturn TURNS;coturn 加 443 TLS 监听;凭据端点 iceServers 增加并前置 `turns:...:443?transport=tcp`。
3. **确认 relay 候选是公网地址**(external-ip 生效),排除 `10.0.0.5` 疑点。
4. **验证**:开着 VPN 两端复测;`chrome://webrtc-internals` 选中的 candidate pair 应为 `relay`(且 `tcp`/`tls`)、state `connected`;coturn `peer usage` 双向非 0。
5. 视需要把"生产用户开加速器/VPN 时,通话强制走 TURNS/443 relay"固化为默认策略。

---

## 7. 附:一句话记住

> **P2P + UDP = 快,但一遇 VPN/对称 NAT/防火墙就死;relay + TCP/TLS/443 = 慢一点,但哪都能用。** 微信选了后者兜底,我们也该有这条兜底路径 —— 而不是让用户关 VPN。
