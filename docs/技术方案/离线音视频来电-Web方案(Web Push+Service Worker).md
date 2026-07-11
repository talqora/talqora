# 离线音视频来电 —— Web 方案(Web Push + Service Worker + Notifications)

> 范围:让 our-chat **web 端**在**标签页关闭 / 浏览器最小化 / 用户离开页面(socket 已断)** 时,依然能收到音视频来电提醒。给出浏览器官方能力、端到端流程、本项目(socket.io 信令 + Redis presence + WebRTC)上的具体改动、与 iOS CallKit 的**能力差距(硬天花板)**、方案对比与落地步骤。
> 结论先行:**Web 能做到"离线弹一条系统通知来提醒来电",但做不到 iOS CallKit 那样的"系统级全屏来电 + 自动接通"**。技术路径是 **Web Push(VAPID)+ Service Worker + Notification**:服务端在 `call:start` 时用现有 presence 判被叫 web 端无活跃 socket,则发 Web Push → 浏览器唤醒 Service Worker → `showNotification` 弹带"接听/拒绝"的通知 → 用户点"接听" → `notificationclick` 打开/聚焦页面 → 页面建 socket + WebRTC,**复用现有 `call:accept` 信令**。Web 的定位是**"把人叫回页面来接"**,而非"页面里直接接通"。

---

## 0. 术语表(先读)

| 术语 | 全称 / 含义 | 通俗解释 |
|---|---|---|
| **Service Worker(SW)** | 浏览器后台脚本 | 一段**脱离页面、可在页面关闭后仍被浏览器按需唤醒**运行的脚本。Web Push 的接收方就是它。 |
| **Push API** | 浏览器推送接口 | 让网站能通过浏览器**推送服务**收到服务端消息,即使没有打开页面。 |
| **Web Push Protocol** | W3C/IETF 标准 | 服务端 → 浏览器推送服务(Google FCM / Mozilla / Apple 各自的 endpoint)→ 用户浏览器的下发协议。 |
| **VAPID** | Voluntary Application Server Identification | 一对**服务端公私钥**:公钥给浏览器订阅时用,私钥给服务端签发推送时用,证明"这条推送是我们网站发的"。 |
| **`PushSubscription`** | 订阅对象 | 浏览器订阅推送后返回的**收件地址**:含 `endpoint`(该浏览器的推送服务 URL)+ `keys`(加密公钥/auth)。**每个浏览器/设备一份**,要存服务端。 |
| **`PushManager.subscribe`** | 订阅 API | 页面用 VAPID 公钥订阅推送,拿 `PushSubscription`。 |
| **Notification API / `showNotification`** | 通知接口 | 弹系统通知。SW 里只能用 `registration.showNotification`(带 `actions` 按钮)。 |
| **`notificationclick`** | SW 事件 | 用户点通知(或其按钮)触发;在这里 `clients.openWindow` / `focus` 打开页面。 |
| **`userVisibleOnly: true`** | 订阅约束 | 浏览器**强制**:Web Push 必须"用户可见"(即必须弹通知),**不允许静默后台推送**。这是 Web 拿不到"静默唤醒建连"的根因。 |
| **VAPID** 之外的 **PWA** | Progressive Web App | "添加到主屏"的网页应用。**iOS Safari 的 Web Push 只对已安装的 PWA 开放(16.4+)**。 |
| **presence 注册表** | 本项目已有(`server/src/realtime/presence.ts`) | Redis 记「用户当前有哪些活跃设备连接」;判 web 端在不在线靠它。 |

---

## 1. 问题与现状

同 iOS:本项目**来电信令全走 socket.io**(`call:start` → `io.to(room(calleeId)).emit(...)`),只能投给**有活跃 socket 的页面**。web 端一旦**关标签页 / 切走太久 socket 断**,`call:start` 就落空,被叫不振铃。web 端目前**无 Service Worker、无 Web Push**(核实:`web/` 下无 sw / PushManager / VAPID)。

要"离线也能提醒来电",web 唯一的官方离线通道是 **Web Push + Service Worker**。

---

## 2. 浏览器能力与硬天花板(必须先认清 web ≠ iOS)

Web 与 iOS CallKit 是**两个能力层级**,写方案前必须让决策者理解差距,避免期望错位:

| 能力 | iOS(VoIP Push + CallKit) | **Web(Web Push + SW)** |
|---|---|---|
| 唤醒被关闭的 App/页面 | ✓ 唤醒被杀 App | ✓ 唤醒 SW(但只能弹通知) |
| 系统级**全屏来电 UI** | ✓(锁屏/后台全屏) | ✗ **只有一条系统通知**(标题+按钮) |
| **静默唤醒后台建连**(不打扰) | ✓ | ✗ `userVisibleOnly` 强制必须弹通知 |
| 自动接通(点一下即通话) | ✓ 接听即接管音频 | ✗ 必须**先 openWindow 打开页面**,再在页面里接 |
| 持续响铃 | ✓ 系统铃声 | △ 通知提示音**由系统/浏览器控制**,SW 不能持续播放自定义铃声 |
| 送达实时性 | 高(专用高优通道) | **不保证**(推送服务尽力投递,可能有秒级延迟) |
| 平台可用性 | iOS 全量 | 桌面 Chrome/Edge/Firefox OK;**iOS Safari 仅"已安装 PWA"且 16.4+**;各家推送服务差异大 |

**根因**:浏览器出于隐私/防滥用,**禁止网页做"静默后台唤醒 + 自动拉起 UI"**——`userVisibleOnly: true` 是强制的,推送必须对应一条用户可见通知,且**打开页面必须由用户点击手势触发**(`notificationclick` 里才允许 `openWindow`)。所以 web 的离线来电天然是**"通知 → 用户点 → 打开页面接"**,做不到"自动全屏接通"。

> 定位结论:**web 离线来电 = "把用户叫回页面"的提醒层**;真正接通仍需用户点通知 → 打开页面 → 页面内走现有通话。把它当"未接来电提醒 + 一键回到通话",而不是"网页版 FaceTime"。

---

## 3. 端到端流程

```
主叫(在线)
  │ emit('call:start', {callId, from, to, callType, offer})   ← 现有信令
  ▼
server (socket.ts: call:start handler)
  │ presence 判被叫 web 端是否有活跃 socket
  │   ├─ 在线 → io.to(room(calleeId)).emit('call:start')      ← 现有在线路径
  │   └─ web 离线 且有 Web Push 订阅 → web-push 发推           ← 新增
  ▼
浏览器推送服务(FCM / Mozilla / Apple,视浏览器而定)
  ▼
被叫浏览器(页面已关/最小化)
  │ 唤醒 Service Worker → 'push' 事件
  │ event.waitUntil(registration.showNotification("张三 邀请你视频通话",
  │     { actions:[{action:'accept',title:'接听'},{action:'reject',title:'拒绝'}], data:{callId,...}, requireInteraction:true }))
  ▼
系统通知(带 接听 / 拒绝 按钮)
  │ 用户点【接听】→ SW 'notificationclick'
  │   clients.openWindow(`/call?callId=...`) 或 focus 已有标签页(postMessage 传 callId)
  ▼
页面(被拉起/聚焦)
  │ ① 连 socket(带 JWT)  ② emit('call:accept')  ← 复用现有信令
  │ ③ 用 callId 找回这通;建 WebRTC(SDP/ICE，走 coturn)
  ▼
WebRTC P2P 媒体连通 → 通话中(复用现有 useCall / CallModal)
```

**与 iOS 一致的地方**:离线只替换"振铃"这一步(socket → Web Push + 通知);接听后信令(`call:accept`/`ice`/`end`)、WebRTC、通话 UI **全部复用现有**。

---

## 4. 改动清单(落到本项目)

### 4.1 Web 端(web/)

**(a) Service Worker(新增 `web/public/sw.js`,或用 Vite PWA 插件生成)**
- `push` 事件:解析 payload → `self.registration.showNotification(title, { body, icon, actions:[接听/拒绝], data:{callId,callerId,callType}, tag: callId, renotify:true, requireInteraction:true })`。用 `tag: callId` 去重(同一通只弹一个)。
- `notificationclick` 事件:
  - `action === 'accept'`:`clients.matchAll()` 找已开的本站标签页 → 有则 `focus()` + `postMessage({type:'incoming-call', callId})`;无则 `clients.openWindow('/call?callId=...&action=accept')`。
  - `action === 'reject'`:直接给服务端发一条"拒绝"(SW 内 `fetch('/api/call/reject')`,带 callId),不必开页面。
- `pushsubscriptionchange`:订阅变更时重新订阅并上报。

**(b) 页面注册与订阅(新增 `web/src/utils/webPush.ts`)**
- 登录后:`navigator.serviceWorker.register('/sw.js')`;`Notification.requestPermission()`(需用户手势触发,放在设置/首次登录引导里,别自动弹)。
- `registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: VAPID_PUBLIC })` → 拿 `PushSubscription` → `POST /api/push/register` 上报 `{ deviceId, platform:'web', subscription }`。
- 页面监听 SW 的 `message`(`incoming-call`)→ 用 callId 走现有 `useCall` 起接听。

**(c) 现有通话逻辑(useCall)**
- 接听入口从"只有 socket 的 `call:start`"扩展为"也接受来自 SW 的 `incoming-call` 消息";两条路最终都走同一套 `emit('call:accept')` + WebRTC。

### 4.2 服务端(server)

**(a) 订阅注册**:`POST /api/push/register` 存 web 的 `PushSubscription`(与 iOS 共用 `device_push_token` 表,`platform='web'`,`token` 字段存 subscription JSON)。
**(b) `call:start` 分叉(改 `socket.ts`)**:presence 判被叫**web 端离线**且有订阅 → 走 web-push;在线设备照旧 socket。（与 iOS 方案同一处分叉,只是离线通道按 `platform` 选 APNs / Web Push。）
**(c) 发推(新增 `server/src/realtime/webPush.ts`)**:用 `web-push` 库,VAPID 私钥签发;payload 精简 `{ callId, callerId, callerName, callerAvatar, callType }`(**不放 SDP**,体积/时效交给接通后信令);处理 `410/404`(订阅失效)→ 删。
**(d) 拒绝端点**:`POST /api/call/reject`(SW 直接调,免开页面就能拒接)。

### 4.3 数据库
与 iOS 方案共用 `device_push_token` 表(`platform` 区分 'ios'/'web';web 存 subscription JSON)。presence(易失在线态)判"要不要推",token/subscription 表(持久)提供"往哪推"。

---

## 5. 关键限制与坑(逐条对照 web 的天花板)

1. **必须 `userVisibleOnly: true`**:不能静默推送,每次推送**必弹通知**;做不到"后台悄悄建连自动接通"。这是产品形态的硬约束,需在设计上接受"通知式来电"。
2. **打开页面必须在 `notificationclick` 里**:浏览器只允许"用户点击手势"触发 `openWindow`;SW 不能自作主张打开页面。所以流程一定是"用户点接听 → 才打开/聚焦页面"。
3. **响铃体验弱**:通知提示音由系统控制,SW **不能持续播放自定义铃声**;要"持续响铃"只能等 openWindow 后由页面播放音频。可用 `requireInteraction:true` 让通知不自动消失、`renotify` 提醒,但仍非"持续振铃"。
4. **送达不保证低延时**:Web Push 经第三方推送服务尽力投递,可能有秒级延迟或(设备深度休眠时)不即时。不适合"必须秒级接通"的严苛场景;适合"未接来电提醒/叫人回来"。
5. **iOS Safari 限制**:iOS 上 Web Push **只对"添加到主屏"的 PWA**开放且需 16.4+;普通 Safari 标签页收不到。**iPhone 用户的可靠离线来电应走 App(CallKit)方案**,web 作为补充。
6. **权限流失**:用户可能拒绝通知权限或后续在系统里关掉;要检测 `Notification.permission` 并在被拒时降级(仅在线 socket 来电)。
7. **多端去重**:用户可能 web + iOS 都注册;发起时按 presence + platform 决定各端走 socket / APNs / Web Push;任一端接听 → 现有 `call:handled` 广播让其余端的通知关闭(SW 里可 `getNotifications({tag:callId})` 后 `close()`,需服务端再推一条"cancel" 或页面接通后经 SW 关)。
8. **HTTPS 必需**:SW 与 Push 仅在安全上下文可用(本项目已 HTTPS,满足)。
9. **VAPID 密钥保管**:私钥仅服务端持有;公钥内置前端。轮换 VAPID 会使旧订阅失效,需重订阅。

---

## 6. 方案对比

### 6.1 Web 侧离线通道候选

| 维度 \ 方案 | 长连接保活(SW 里维持 WS) | 轮询 | **Web Push + SW(本方案)** |
|---|---|---|---|
| 页面关了还能收 | ✗ SW 不允许长连保活、会被回收 | ✗ 页面关了没主体轮询 | ✓ 浏览器按需唤醒 SW |
| 省电/合规 | ✗ 违反浏览器后台策略 | ✗ 费电、延迟大 | ✓ 官方机制 |
| 实时性 | — | 差 | 中(尽力投递) |
| 结论 | 不可行 | 不可行 | **web 离线提醒唯一可行路** |

### 6.2 与 iOS 能力对照(帮决策)

见 §2 表。一句话:**iPhone 用户走 App(CallKit)拿"真·原生来电";web 端用 Web Push 拿"来电提醒 + 一键回到页面接"**。两者是分层互补,不是替代。

---

## 7. 落地步骤(建议顺序)

1. **生成 VAPID 密钥对**(服务端 `web-push generateVAPIDKeys`),公钥入前端、私钥入服务端配置。
2. **Web 端**:加 `sw.js`(push / notificationclick)、注册 + 订阅 + 上报;设置页做通知权限引导。
3. **服务端**:`/api/push/register`(与 iOS 共表)、`webPush.ts`、`socket.ts` 的 `call:start` 分叉按 platform 选通道、`/api/call/reject`。
4. **联调**:桌面 Chrome/Firefox 先通(关标签页 → 收通知 → 点接听 → 回页面接通);再验证 iOS PWA(可选);验证拒接、去重、订阅失效清理。
5. **产品对齐**:明确 web 是"通知式来电",文案与交互别承诺"自动接通"。

---

## 8. 边界与未尽

- Web 离线来电只做到**通知级提醒 + 一键回页面接**;**无系统级全屏来电、无自动接通、无持续自定义铃声**——这是浏览器能力上限,非实现取舍。
- **iPhone 上的可靠离线来电以 App(CallKit)方案为准**,web 作补充;桌面浏览器是 web 方案的主战场。
- 与 iOS 方案**共用服务端的"presence 判离线 → 按 platform 选推送通道"分叉**与 `device_push_token` 表,后端只写一套分发逻辑、按平台挑通道即可。
- 送达可靠性/铃声体验的进一步优化(如接通后页面持续响铃、通知与页面状态同步关闭)属增量。
