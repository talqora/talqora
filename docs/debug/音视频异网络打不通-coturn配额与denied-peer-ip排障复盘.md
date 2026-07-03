# 音视频异网络打不通 排障复盘 —— coturn 配额(486)与 denied-peer-ip(403)

> 现象:同 WiFi 两台设备音视频能通,跨网络(尤其一端手机流量)打不通。历经多轮、多个错误假设才定位。
> 根因:**server 基建本身是通的(relay 能分配、能中继),却被自己的两道"保护"配置卡死** —— 配额把真正通话用的 relay 挡掉(486),黑名单把合法 peer 权限挡掉(403)。
> 结论文件:技术方案见 [`docs/技术方案/音视频通话-NAT穿透与自建TURN方案.md`](../技术方案/音视频通话-NAT穿透与自建TURN方案.md)。

---

## 1. 现象与背景

- **现象**:`initiateCall` 后,同一 WiFi 下两设备能建立音视频;换成异网络(对端手机流量/异运营商)长期打不通。
- **背景**:项目自建 coturn(STUN+TURN 一体),前端登录后从 `/api/turn-credentials` 拉短期 HMAC 凭据,`webrtc.ts` 用它建 `RTCPeerConnection`。
- 为什么"同 WiFi 通、异网络不通"值得注意:同 WiFi 走 **host 候选**(局域网直连),**不需要 relay**;异网络必须靠 **srflx(STUN 打洞)或 relay(TURN 中继)**。所以症状本身就指向"srflx/relay 这条路断了"。

## 2. 关键概念(排障用得到)

- **ICE 候选**:`host`(局域网 IP)/`srflx`(STUN 反射的公网映射)/`relay`(TURN 中继地址)。
- **TURN 两步**:`ALLOCATE`(在 TURN 上开一个 relay 端口)→ `CreatePermission`/`ChannelBind`(授权某个对端地址能经此 relay 收发)。两步都过,媒体才走得通。
- **coturn 配额**:`user-quota`(单用户并发 allocation 上限)、`total-quota`(全服上限)。超了对 `ALLOCATE` 回 **486 Allocation Quota Reached**。
- **`denied-peer-ip`**:relay 的对端地址黑名单(防 SSRF 式滥用)。命中则 `CreatePermission` 回 **403 Forbidden IP**。
- **`peer usage` 字节计数**:coturn 会话结束时打印 `rp/rb/sp/sb`(relay 侧收/发包与字节)。**这是"媒体到底有没有真的中继过"的唯一 ground truth**:双向非 0 才是真通。

## 3. 排查历程(含走过的弯路,诚实记录)

按时间线,每步 假设 → 验证 → 结论:

| # | 假设 | 验证 | 结论 |
|---|---|---|---|
| ① | 只配了 Google STUN、无 TURN,国内连不上又无兜底 | 读 `webrtc.ts` | **部分成立**:自建 coturn 补 TURN。修了但仍不通 |
| ② | relay 候选落到 docker 网桥(172.x)对外不可达 | coturn 起在 host 网络会把网桥/回环也当 relay 地址 | **成立**:锁 `listening-ip/relay-ip=10.0.0.5`、`external-ip=公网/私网`。必要修复,但**仍不通** |
| ③ | 前端根本没拉到 TURN 凭据 | 一度 nginx 0 命中 | **证伪**:后续看到两端都 `GET /api/turn-credentials → 200`,凭据没问题 |
| ④ | 微信内置浏览器 WebRTC 残缺 | nginx UA 里确有 `MicroMessenger/XWEB` | **证伪**:用户两端都换 Chrome,仍不通 |
| ⑤ | 需要看会话级细节才能定位 | coturn 默认只吐 `allocation count` DEBUG 刷屏,把决定性 INFO 藏了 | **开 `verbose` + 重启** → 拿到实锤数据 |

> 教训预告:③④ 这两个弯路耗了不少时间。默认日志级别不给会话细节,导致只能靠猜;**应更早开 verbose**。

## 4. 根因(verbose 日志实锤)

开 `verbose` 后一通异网络 Chrome↔Chrome 测试,日志里两类错误直接指认根因,二者独立、叠加致命:

### 4.1 `486 Allocation Quota Reached`(362 次)

```
session ...: user <...:1>: incoming packet ALLOCATE processed, error 486: Allocation Quota Reached
```

- **机制**:前端 `iceCandidatePoolSize: 10` 让**每建一个 PeerConnection 就预取一池 relay 候选**;通话流程里 `reset()` 会重建 PC;旧 allocation 要到 stale 超时才释放。于是**单用户短时间内的 allocation 数远超 `user-quota=12`**,coturn 对**真正通话要用的那个 ALLOCATE** 回 486 → 拿不到 relay 候选 → 异网络无中继可用 → 打不通。
- **佐证**:峰值并发 allocation 冲到 **193**(已 > `total-quota=100`)。

### 4.2 `403 Forbidden IP`(CreatePermission)

```
session ...: user <...:0>: incoming packet CREATE_PERMISSION processed, error 403: Forbidden IP
```

- **机制**:`denied-peer-ip` 把整段私网/CGNAT/链路本地(`10/8`、`100.64/10`、`169.254/16`、`172.16/12`、`192.168/16` …)都封了。WebRTC 会为对端**每个候选**建 permission,而手机 CGNAT 的 srflx、家庭 LAN、iOS 链路本地等**合法候选**命中黑名单 → 403 → 媒体权限建不起来。
- **佐证**:少数会话 `peer usage` 非 0 但**单向且量极小**(`sp=48,rp=0` 或 `rp=4,sp=0`),几个包后转 `stale` 关闭 —— ICE 始终没能建成稳定的**双向** relay 对。

**一句话根因**:relay 能分配、能中继(基建没坏),但**配额把真 relay 挡了、黑名单把 peer 权限挡了**。完美解释"同 WiFi(host,不需 relay)通、异网络(必须 relay)不通"。

## 5. 修复

### 5.1 coturn `docker/coturn/turnserver.conf`(已热更 + 入仓)

- `user-quota 12 → 100`、`total-quota 100 → 500`:给"候选池 + reset 重建"留足瞬时余量。
- `denied-peer-ip` 从"整段私网黑名单"收敛为 **5 条外科规则**,只封确实敏感、且正常 peer 不会作为合法目标的地址:
  - 回环 `127.0.0.0/8`、`::1`(host 网络下 coturn 与宿主共享 loopback)
  - 云元数据 **单 IP** `169.254.169.254`(会泄露临时密钥)
  - 本机 VPC 段 `10.0.0.0/22`(宿主 `eth0=10.0.0.5/22`,防打同 VPC 邻居/内部服务)
  - docker 网桥 `172.17.0.0–172.20.255.255`(容器内 postgres/redis/server/gateway/agent)
  - 放开常规私网/CGNAT/链路本地:它们本就**不可从服务器路由**,封了只会误伤合法候选、换不来任何安全收益。

### 5.2 前端 `web/src/utils/webrtc.ts`(入仓,需部署生效)

- `iceCandidatePoolSize: 10 → 0`:不预取候选池,按需为真实 PC 收集,单用户 allocation 数骤降,从源头消掉配额风暴。(配额已放宽,即使旧 bundle 也不再撞 486;此项是把根因从两头都堵死。)

## 6. 验证

- **方法**:coturn `verbose` 下再打一通异网络电话,核对:
  1. **无 486 / 无 403**;
  2. `peer usage` **双向非 0**(`rp>0` 且 `sp>0` = 媒体真的来回中继过);
  3. `chrome://webrtc-internals` 里选中的 candidate pair 为 `relay`(或匹配的 `srflx`)、ICE state = `connected`。
- **当前状态**:两个根因已由日志**实锤**,修复已落地(coturn 热更 + 入仓,前端待部署);**end-to-end 最终确认待下一通测试的 verbose 日志**。确认后即关闭 verbose。

## 7. 经验教训

- **默认日志级别会骗人**:coturn 默认只吐 `allocation count` DEBUG,把 486/403 这种决定性 INFO 藏了。排 TURN 早开 `verbose`,别靠猜。
- **`peer usage` 字节是"媒体是否真中继"的唯一硬证据**:allocation 成功 ≠ 通话通;必须看 `rp/sp` 双向非 0。
- **"保护"配置会误伤自己**:`user-quota`、`denied-peer-ip` 都是防滥用项,但**默认值 / 粗粒度**会把合法流量当攻击挡掉。安全项要按真实拓扑**收敛**,不要一刀切封整段私网。
- **`iceCandidatePoolSize` + TURN 是反模式**:预取池对 TURN 会成倍放大 allocation、撞配额;有 TURN 时应设 0。
- **别被"基建健康"误导**:STUN 可达、端口开放、relay 能分配,都不等于通;瓶颈常在配额/ACL 这种"最后一米"。
- **逐层证伪**:凭据未拉取、微信浏览器……每个假设都要用数据证实/证伪,避免在错误方向反复空转。

## 8. 后续

- 验证通过后关闭 coturn `verbose`。
- 前端 `iceCandidatePoolSize=0` 随下次部署生效。
- 同步更新技术方案文档中 `turnserver.conf` 片段的 `user-quota` 与 `denied-peer-ip`,避免误导。
