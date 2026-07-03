# 音视频通话 NAT 穿透:自建 TURN(coturn)方案

> 现象:自己的手机和电脑能打通音视频,找异网络的朋友(尤其手机流量)就不行。
> 根因:ICE 只配了 STUN、且用的是国内基本连不上的 Google STUN,没有 TURN 中继兜底。
> 方案:在自有服务器上自建 coturn(STUN+TURN 一体),配 TLS + 短期 HMAC 凭据,前端改为从
> 服务端动态拉取 iceServers。本文是该方案的完整分析、设计与实施规范。

---

## 1. 概念扫盲(先建立心智模型)

- **P2P 与信令的分工**:WebRTC 的**信令**(谁打给谁、交换 SDP/ICE 候选)走我们自己的服务器(Socket.io);**媒体**(音视频流)是**端到端 P2P**,要在两台设备之间直接打通,必须穿过各自的 NAT。信令通 ≠ 媒体通——这就是"电话能响但看不到画面"的原因。
- **NAT**:家用/运营商网络里,设备用的是私网 IP,出网时被网关做地址转换(NAT)。两台设备各在一个 NAT 后面,彼此看不到对方的私网地址,需要"穿透"。
- **ICE**(Interactive Connectivity Establishment):穿透框架。它收集三类**候选地址(candidate)**,两端互相尝试连通:
  - **host**:设备自己的局域网 IP —— 同一个 WiFi/LAN 直接可达。
  - **srflx**(server-reflexive,靠 **STUN**):设备在公网出口被看到的 IP:port —— 用于跨网络"打洞"。
  - **relay**(靠 **TURN**):中继服务器上的地址 —— 打洞失败时兜底,**只要能连到 TURN 就一定能通**。
- **STUN**(Session Traversal Utilities for NAT):只帮设备"照镜子"拿到自己的公网映射地址(srflx),不转发媒体。对**锥形 NAT** 有效,对**对称 NAT** 无效。
- **TURN**(Traversal Using Relays around NAT):真正的**中继**。两端都把媒体发给 TURN,TURN 转发给对方。代价是媒体过服务器、耗带宽;好处是**任何 NAT 都能通**。
- **对称 NAT / CGNAT**:运营商移动网络(4G/5G)大量使用,对每个目的地址都用不同的出口端口 → STUN 拿到的映射对不上 → **打洞失败,只能靠 TURN**。

一句话:**STUN 管"大多数能打洞的情况",TURN 管"打不通的硬骨头(尤其手机)"。缺 TURN,异网络通话就是概率性失败。**

---

## 2. 现状与根因

`web/src/utils/webrtc.ts` 的 ICE 配置:
```ts
const rtcConfiguration: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },   // + stun1 / stun2
  ],
  iceCandidatePoolSize: 10,
};
```
两个叠加问题:
1. **没有 TURN**:手机运营商对称 NAT 打洞打不通,又无 relay 兜底 → ICE 失败,媒体建不起来。
2. **Google STUN 在国内被墙/极不稳**:`stun.l.google.com` 大陆连不上 → 连 srflx 候选都收集不到 → 退化成只有 host 候选 → **只有同局域网能通**。

这解释了"自己两台设备(同 WiFi,走 host)能通、异网络朋友(需要 srflx/relay)不通"。

---

## 3. 方案设计

在自有服务器(腾讯云,tujiang.tech)上自建 **coturn**,它同时提供 STUN 和 TURN。前端不再硬编码 iceServers,改为**登录后从服务端拉取**——服务端返回 coturn 的 STUN/TURN 地址与**短期凭据**。

### 3.1 整体架构

```
                    ┌─ 信令(SDP/ICE) ─ Socket.io ─ our-chat server ─┐
   浏览器 A ────────┤                                                ├──────── 浏览器 B
                    └─ 媒体:优先 P2P 直连(host/srflx);打不通则 ──┘
                                    ↓ 经自建 coturn 中继(relay)↓
                              coturn(与 web/server 同机,host 网络)
   凭据: A/B 登录后 GET /api/turn-credentials → server 用 TURN_SECRET 算短期 HMAC 凭据
```

- **媒体默认还是 P2P**(host/srflx 能通就不走中继),只有穿不透时才走 coturn relay。所以 relay 带宽只在"硬骨头"场景消耗。
- **coturn 与现有服务同机**,复用同一台服务器与同一张 Let's Encrypt 证书。

### 3.2 凭据机制:短期 HMAC(TURN REST API),不用长期账号密码

**为什么不用固定用户名/密码**:前端是公开 bundle,长期凭据一旦烤进去等于对全网公开——任何人都能拿你的 TURN 当免费中继(带宽被白嫖、甚至被当跳板)。

**采用 coturn 的 `use-auth-secret` 机制(业界标准,Twilio 同款)**:
- 服务端与 coturn 共享一个密钥 `TURN_SECRET`(不下发给客户端)。
- 客户端要用 TURN 时,向我们服务端要一枚**短期凭据**:
  - `username = "<到期unix时间戳>:<用户id>"`
  - `credential = base64( HMAC-SHA1(TURN_SECRET, username) )`
- coturn 校验:解析 username 里的时间戳判断是否过期,再用同一个 `TURN_SECRET` 重算 HMAC-SHA1 与 password 比对,一致才放行。
- 好处:**密钥只在服务端与 coturn 之间**;客户端拿到的凭据**带过期时间、可绑用户**;泄露也只在 TTL 内有效。

### 3.3 coturn 配置要点(`docker/coturn/turnserver.conf`)

```conf
listening-port=3478                 # STUN/TURN 明文(UDP+TCP)
tls-listening-port=5349             # TURNS(TLS over TCP),穿严格防火墙
fingerprint
use-auth-secret
static-auth-secret=${TURN_SECRET}   # 与服务端共享(部署时注入)
realm=tujiang.tech

# 关键①:Lighthouse 是 1:1 NAT,网卡只看到私网 IP,必须显式告知公网 IP,否则 relay 候选广播私网地址、外网连不上。
# 关键②(host 网络必踩):不锁 listening-ip/relay-ip 时,coturn 会把 docker 网桥(172.17-20.0.1)、回环也
#   当 listener/relay 地址,中继若落在 172.x → 对外不可达、通话打不通(实测现象:分配成功但媒体不通)。
#   故必须把 listening-ip/relay-ip 锁到真实私网网卡(默认路由 src,如 10.0.0.5),external-ip=公网/私网 映射。
#   这三项都由 compose command 从 .env 注入(TURN_LISTENING_IP 由 ci-deploy.sh 取默认路由 src 得到)。
listening-ip=${TURN_LISTENING_IP}
relay-ip=${TURN_LISTENING_IP}
external-ip=${TURN_EXTERNAL_IP}/${TURN_LISTENING_IP}

# relay 端口段(收窄,便于云防火墙放行 + 降低暴露面)
min-port=49160
max-port=49200

# TLS:复用 nginx 已有的 Let's Encrypt 证书(只读挂载)
cert=/etc/letsencrypt/live/tujiang.tech/fullchain.pem
pkey=/etc/letsencrypt/live/tujiang.tech/privkey.pem
no-tlsv1
no-tlsv1_1

# 安全硬化(重要):禁止把 TURN 当跳板中继到内网/回环/元数据,防 SSRF 式滥用
no-cli
no-multicast-peers
no-loopback-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff

# 限流(防带宽被打爆)
user-quota=12
total-quota=100
```

**为什么用 host 网络**:TURN relay 会动态在一段 UDP 端口上开中继,Docker bridge 的端口映射 + NAT 会把 relay 地址搞乱(客户端拿到的地址连不上)。`network_mode: host` 让 coturn 直接绑宿主端口、看到真实网络,是自建 TURN 的标准做法(单租户机可接受不隔离)。

### 3.4 服务端凭据端点

`GET /api/turn-credentials`(`authenticateToken` 保护,通话功能本就要登录):
```jsonc
{
  "iceServers": [
    { "urls": ["stun:tujiang.tech:3478"] },
    {
      "urls": [
        "turn:tujiang.tech:3478?transport=udp",
        "turn:tujiang.tech:3478?transport=tcp",
        "turns:tujiang.tech:5349?transport=tcp"   // TLS/5349,穿严格防火墙
      ],
      "username": "1782900000:42",
      "credential": "<base64 HMAC-SHA1>"
    }
  ],
  "ttl": 86400
}
```
- 用 Node `crypto` 算 `HMAC-SHA1(TURN_SECRET, username)`。
- 未配 `TURN_SECRET`(如本地开发)时,只返回 STUN 或空数组,不报错(优雅降级)。

### 3.5 前端改造

- 新增 `web/src/utils/iceServers.ts`:`fetchIceServers()` 走 axios `http`(withCredentials)拉 `/api/turn-credentials`,按 `ttl` 缓存、临期刷新;失败兜底返回空数组(退化为当前行为,不崩)。
- `webrtc.ts`:去掉硬编码 Google STUN;在**发起/接听通话、建 PeerConnection 之前** `await` 一次 ICE 拉取,用返回的 iceServers 建 `RTCPeerConnection`。凭据短期,故按通话即时取用最新的。

### 3.6 证书续期自动重载

证书在宿主机 `/etc/letsencrypt` 由 certbot 续期(约 60-90 天一次),但容器是只读挂载、证书已加载进内存:nginx 缓存旧证书需 reload,coturn 只在启动读证书需 restart。不处理的话,续期后 TURNS(5349)会开始用**过期证书** → 严格网络的 TLS 客户端失败。

做法:`docker/certbot-renew-hook.sh` 由 `ci-deploy.sh` 装到宿主机 `/etc/letsencrypt/renewal-hooks/deploy/`——certbot **每次续期成功后自动运行该目录下所有脚本**(无需改 certbot 命令)。钩子里:`nginx -t` 通过则热 `reload`;`docker restart our-chat-coturn` 加载新证书(coturn 无热加载能力故 restart,会短暂中断正走 relay 的通话——续期罕见且秒级,可接受)。钩子幂等容错:容器不在/配置坏就跳过,绝不让续期失败。

---

## 4. 配置分层(对齐项目既有 ①②③ 约定)

- **①通用非机密**(compose 默认值):`TURN_LISTEN_PORT=3478`、`TURN_TLS_PORT=5349`、relay 端口段、`TURN_REALM`(由 host 派生)。
- **②机密**:`TURN_SECRET`(GitHub Secret → CI 写入 .env,同时注入 coturn 与 server)。
- **③因环境而异**:`TURN_HOST`(= WEB_PUBLIC_ORIGIN 的 host,如 tujiang.tech)、`TURN_EXTERNAL_IP`(服务器公网 IP,取部署已知的 SSH_HOST 或专用 Secret)。

CI(`ci-deploy.sh` 生成 .env)追加 `TURN_SECRET / TURN_HOST / TURN_EXTERNAL_IP`;compose 新增 coturn 服务读这些值。

---

## 5. 端口与防火墙(需人工在云控制台放行)

coturn 要对公网开放,**必须在腾讯云 Lighthouse 控制台的防火墙/安全组放行入站**(仅改服务器 OS 防火墙不够,云平台那层也要开):
- `3478` **UDP + TCP**(STUN/TURN 明文)
- `5349` **TCP**(TURNS / TLS)
- `49160-49200` **UDP**(relay 端口段,与 turnserver.conf 的 min/max-port 一致)

> 这是唯一需要你手工做的一步(云控制台放行 + 确认 `TURN_EXTERNAL_IP` 是公网 IP)。

---

## 6. 验证

1. **单点验证 coturn**:用 Trickle ICE 测试页(`webrtc.github.io/samples/src/content/peerconnection/trickle-ice/`)填 `turn:tujiang.tech:3478` + 服务端生成的一枚凭据 → 应出现 **`relay` 候选**。出现 relay = coturn 通。
2. **端到端**:异网络(一端用手机流量)真机通话,`chrome://webrtc-internals` 看选中的 candidate pair 里有 **`relay`**(或匹配的 `srflx`)→ 打通。
3. **回归**:同 WiFi 仍走 host 直连(不劣化、不无谓中继)。

---

## 7. 取舍与边界

- **带宽**:relay 媒体过服务器,吃 Lighthouse 带宽(视频一路约 1–2.5 Mbps × 双向)。缓解:多数 WiFi 场景走 srflx 不走 relay;音频 relay 很轻;必要时限码率 / 用 `total-quota` 兜底。要扛规模化视频再上腾讯 TRTC。
- **安全**:短期 HMAC 凭据 + `denied-peer-ip` 内网黑名单 + `no-cli` + 配额,防白嫖与 SSRF 式滥用。
- **证书续期**:复用 Let's Encrypt。已装 certbot deploy-hook(见 §3.6),续期成功后自动 reload nginx + restart coturn(否则容器仍用旧证书,TURNS/5349 续期后失效)。
- **降级**:服务端未配 `TURN_SECRET` 或拉取失败时,前端退化为空 iceServers(仅 host,同当前行为),不阻断通话 UI。

---

## 8. 实施清单

1. `docker/coturn/turnserver.conf` + compose 新增 coturn 服务(host 网络、挂 conf 与证书、注入 secret/realm/external-ip)。
2. server:`/api/turn-credentials` 端点 + config 读 `TURN_SECRET/TURN_HOST/TURN_TTL/端口` + 单测(HMAC 正确性、无 secret 降级)。
3. 前端:`iceServers.ts` 动态拉取 + `webrtc.ts` 建连前注入,去掉 Google STUN。
4. CI:`.env` 生成注入 `TURN_SECRET/TURN_HOST/TURN_EXTERNAL_IP`;compose 端口;文档写清防火墙放行。
5. 证书续期钩子:`docker/certbot-renew-hook.sh` 由 `ci-deploy.sh` 装到 `/etc/letsencrypt/renewal-hooks/deploy/`(见 §3.6)。
6. 验证:Trickle ICE + webrtc-internals + 同 WiFi 回归。
