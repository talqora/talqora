# 离线音视频来电 —— iOS 方案(CallKit + PushKit VoIP Push)

> 范围:让 our-chat iOS 端在 **App 处于后台、被系统挂起、甚至被用户/系统杀掉、设备锁屏** 的情况下,依然能收到音视频来电并弹出**系统级原生来电界面**(与微信/FaceTime 同款全屏来电)。给出苹果官方能力、端到端流程、本项目(socket.io 信令 + Redis presence + WebRTC)上的具体改动、关键坑与合规红线、方案对比与落地步骤。
> 结论先行:**iOS 离线来电只有一条合规且可靠的路 —— PushKit 收 VoIP Push,收到后必须立即用 CallKit `reportNewIncomingCall` 弹原生来电**。普通 APNs 通知/静默推送都做不到"被杀也能振铃"。服务端在 `call:start` 时用现有 **presence 注册表判被叫是否有活跃 socket**,离线则改走 **APNs VoIP 推送**;用户在 CallKit 上接听后,App 被唤醒、建立 socket + WebRTC,**复用现有 `call:accept` 信令与通话状态机**,离线只是"把振铃这一步从 socket 换成 VoIP push"。

---

## 0. 术语表(先读)

| 术语 | 全称 / 含义 | 通俗解释 |
|---|---|---|
| **CallKit** | Apple 通话 UI 框架 | 提供**系统级来电/通话界面**(全屏来电、锁屏接听、通话记录、与系统电话互斥)。第三方 VoIP App 想有"原生来电"体验必须用它。 |
| **`CXProvider`** | CallKit 的会话提供者 | App 通过它向系统**上报来电/去电/结束**;系统据此弹 UI。 |
| **`reportNewIncomingCall`** | `CXProvider` 方法 | "有一通新来电"——调用它系统就弹原生来电界面。**iOS 13+ 硬性要求:收到 VoIP push 后必须"立即"调它**。 |
| **`CXCallController` / `CXAction`** | CallKit | App 侧发起/应答/挂断的动作(`CXAnswerCallAction`/`CXEndCallAction` 等);用户点系统 UI 的按钮,系统回调你的 `CXProviderDelegate`。 |
| **PushKit** | Apple 专用推送框架 | 专门收 **VoIP push**(和普通通知不同的高优先级推送通道)。 |
| **VoIP Push** | Voice-over-IP 推送 | 一种**能唤醒被杀 App**的特殊 APNs 推送;送达即唤起进程执行代码(不像普通通知只弹横幅)。**必须配合 CallKit**,否则 iOS 13+ 会崩溃/封禁该能力。 |
| **`PKPushRegistry`** | PushKit 注册器 | App 用它注册 VoIP 推送、拿 **VoIP push token**、收 push 回调。 |
| **APNs** | Apple Push Notification service | 苹果推送服务。所有 iOS 推送(含 VoIP)都经它下发。**直连 Apple,不经我们服务器的墙,中国大陆可达**。 |
| **token-based auth(.p8)** | APNs 基于密钥的鉴权 | 用一枚 **`.p8` 私钥 + Key ID + Team ID** 签 JWT 调 APNs,取代老的 `.p12` 证书;一把 key 管所有 App、不过期。 |
| **APNs topic** | 推送主题 | VoIP push 的 topic = **`<bundleId>.voip`**(本项目即 `com.ourchat.ios.voip`)。 |
| **`aps-environment`** | 推送 entitlement | App 的推送环境能力(`development`/`production`),必须在 entitlements + Provisioning Profile 里开。 |
| **`UIBackgroundModes: voip`** | 后台模式 | 声明 App 用 VoIP,系统才允许 PushKit 唤醒。本项目现在只有 `audio`,需加 `voip`。 |
| **presence 注册表** | 本项目已有(`server/src/realtime/presence.ts`) | Redis 里记「每个用户当前有哪些活跃设备连接」(ZSET+TTL)。**判被叫在不在线就靠它。** |
| **信令(signaling)** | — | WebRTC 建连前交换的元数据(SDP offer/answer、ICE 候选)。本项目走 socket.io 的 `call:*` 事件。 |
| **SDP / ICE** | Session Description Protocol / Interactive Connectivity Establishment | 前者描述媒体能力(编解码、轨道),后者用于穿透 NAT 找到可连通的地址(配合 coturn TURN)。 |

---

## 1. 问题:当前来电依赖 socket.io,App 不在线就收不到

现状(核实自代码):

- **信令全走 socket.io**:主叫 `emit('call:start')` → 服务端 `server/src/utils/socket.ts` 做忙线裁决后 `io.to(room(calleeId)).emit('call:start', event)` → 被叫设备的 socket 收到 → App 内弹自绘来电(`CallModal`/`CallFeature`)。
- **致命前提**:`io.to(room(calleeId))` 只能投给**当前有活跃 socket 连接**的设备。iOS App 一旦进后台被系统挂起(通常几十秒后)、或被杀、或锁屏,socket 断开 → **`call:start` 这条 emit 直接落空,被叫永远不振铃**。
- iOS 端**没有 CallKit / PushKit**(`Project.swift` 里 `UIBackgroundModes` 只有 `audio`,无 `voip`;无推送 entitlement)。

**一句话**:现在是"双方都开着 App 才能通话",要做到"像微信一样 App 在后台/被杀也能来电",必须引入**离线唤醒通道**。iOS 上这条通道苹果只认一种:**VoIP Push + CallKit**。

---

## 2. 苹果的能力与硬红线(为什么只能这么做)

### 2.1 为什么不能用普通通知 / 静默推送

| 方式 | 能否唤醒被杀 App | 能否弹原生来电 UI | 问题 |
|---|---|---|---|
| 普通 APNs 通知(alert) | ✗ 只弹横幅,不执行代码 | ✗ | 用户要手动点,不能自动建连;被杀时只是一条横幅 |
| 静默推送(`content-available`) | △ 后台可短暂执行,**被杀不唤醒**;系统严格限流 | ✗ | 不可靠、延迟大,苹果明确不建议做实时来电 |
| **VoIP Push + CallKit** | ✓ **被杀也唤醒**、高优先级 | ✓ 系统级全屏来电 | 唯一正解;但**收到必须立刻 `reportNewIncomingCall`** |

### 2.2 iOS 13+ 的硬约束(必须知道,否则封能力)

从 iOS 13 起,**每收到一个 VoIP push,App 必须在该回调返回前调用一次 `CXProvider.reportNewIncomingCall`**。否则:

- 系统直接**终止 App**;
- 多次违反,系统会**停止再向该 App 投递 VoIP push**(能力被吊销)。

**原理**:早期 VoIP push 被滥用来做后台保活/静默唤醒,苹果为杜绝此路,强制把 VoIP push 和"必须弹一通真实来电"绑死。因此**服务端只在"真的有来电"时才发 VoIP push**,客户端收到就**无条件弹 CallKit**。

### 2.3 CallKit 带来的额外好处

- **锁屏/后台全屏来电**、系统铃声、与系统电话互斥(打着电话来微信电话会被系统协调)。
- 通话进入系统"最近通话",支持从系统 UI 回拨(可选)。
- **音频会话由系统托管**:CallKit 会在接听时激活 `AVAudioSession`,与 WebRTC 音频轨对接更稳(避免自管音频会话的各种打断问题)。

---

## 3. 端到端流程(离线来电全链路)

```
主叫(在线)
  │ emit('call:start', {callId, from, to, callType, offer})   ← 现有信令,不变
  ▼
server (socket.ts: call:start handler)
  │ ① 忙线裁决(现有)
  │ ② presence 判被叫每台设备是否有活跃 socket(现有 presence 注册表)
  │      ├─ 有在线 socket → io.to(room(calleeId)).emit('call:start')   ← 现有在线路径
  │      └─ 该设备离线(iOS)→ 查设备的 VoIP token → 发 APNs VoIP Push   ← 新增
  ▼
APNs(直连 Apple)
  ▼
被叫 iPhone(App 后台/被杀/锁屏)
  │ PushKit 唤醒 App 进程 → didReceiveIncomingPushWith(回调)
  │ 【必须立即】CXProvider.reportNewIncomingCall(callId, 主叫昵称/头像, 视频?)
  ▼
系统弹【原生来电 UI】(全屏/锁屏/横幅)
  │ 用户点【接听】→ CallKit 回调 CXAnswerCallAction
  ▼
App 被拉起到前台(或后台激活)
  │ ① 连 socket(带 JWT)   ② emit('call:accept')   ← 复用现有信令
  │ ③ 用 push 里带的 callId 找回这通;建 WebRTC(SDP/ICE，走 coturn)
  ▼
双方 WebRTC P2P 媒体连通 → 通话中(复用现有 CallFeature 状态机 / CallView)
  用户在 CallKit 上挂断 → CXEndCallAction → emit('call:end') + 关 WebRTC(复用现有)
```

**要点**:离线来电**只替换"振铃唤醒"这一步**(socket emit → VoIP push + CallKit);接听后的信令(`call:accept`/`ice`/`end`)、WebRTC 建连、通话 UI **全部复用现有实现**。改动是"加一条离线唤醒旁路",不是重写通话。

---

## 4. 改动清单(落到本项目)

### 4.1 iOS 端(mobile-swift)

**(a) 工程能力(`Project.swift` / entitlements)**
- `UIBackgroundModes` 增加 `voip`(现有 `["audio"]` → `["audio","voip"]`)。
- 新增 entitlements:`aps-environment`(dev/prod);开启 Push Notifications capability。
- Apple Developer:App ID 打开 Push Notifications;生成 **APNs Auth Key(.p8)**(token 方式,一把管 dev+prod)。

**(b) PushKit 注册与 token 上报(新增 `Services/Push/VoIPPushClient.swift`)**
- 用 `PKPushRegistry`(`desiredPushTypes = [.voIP]`)注册,拿到 **VoIP push token**(Data → hex)。
- 登录后 / token 变化时,把 `{ userId, deviceId, platform: "ios", voipToken }` 上报服务端(新端点,见 4.2)。`deviceId` 复用 socket 握手用的同一个设备标识,保证 presence 与 push 目标一致。

**(c) CallKit 集成(新增 `Services/Call/CallKitProvider.swift`,TCA 依赖化)**
- 持有 `CXProvider`(配置 App 名、图标、`supportsVideo`、ringtone)。
- `didReceiveIncomingPushWith(.voIP)`:**同步**解析 push payload(`callId/callerId/callerName/callerAvatar/callType`),**立即** `provider.reportNewIncomingCall(with: UUID(callId), update:)`;失败也要报一通"已结束",不能不报(否则违反 2.2)。
- 实现 `CXProviderDelegate`:
  - `perform CXAnswerCallAction`:触发"接听"——起 socket、`emit('call:accept')`、把这通交给现有 `CallFeature`;在 `didActivate audioSession` 里让 WebRTC 使用系统音频会话。
  - `perform CXEndCallAction`:挂断——`emit('call:reject'/'call:end')`、关 WebRTC。
- **与现有 `CallFeature` 打通**:CallKit 是"来电 UI + 音频会话"层,`CallFeature` 是"WebRTC 状态机"层;新增一个协调者把 CallKit 动作映射到现有 `call:*` 信令与 `WebRTCSession`。在线来电(socket 收到 `call:start`)也可选统一走 CallKit 弹原生 UI(体验一致)。

**(d) 音频会话**
- 交给 CallKit:接听时系统激活 `AVAudioSession`,在 `provider(_:didActivate:)` 里配置 WebRTC 音轨;`didDeactivate` 收尾。避免和现有自管音频会话冲突。

### 4.2 服务端(server)

**(a) 设备推送 token 注册(新增 REST)**
- `POST /api/push/register`:`{ deviceId, platform, voipToken }`(鉴权取 userId,不信任入参)。存储:见 4.3。
- `POST /api/push/unregister`(登出/换设备)。
- token 失效由 APNs 反馈(410 Unregistered)时惰性删除。

**(b) `call:start` 分叉:在线走 socket,离线发 VoIP push(改 `socket.ts`)**
- 现有:`io.to(room(calleeId)).emit('call:start', event)`。
- 改为:先用 presence 列出被叫**在线设备集合**;对**不在该集合但有注册 VoIP token 的 iOS 设备**,发 APNs VoIP push。
  - 典型策略:**在线设备走 socket,离线 iOS 设备走 VoIP push**(一个用户可能 web 在线、iOS 离线,则 web 收 socket、iPhone 收 push,两端一起振铃,先接为准——复用现有 `call:handled` 广播让其它端停振铃)。
- push payload(**精简、不放完整 SDP**,只放唤醒接通所需):`{ callId, callerId, callerName, callerAvatar, callType }`;offer SDP 仍走接通后的 socket(或短期 Redis 暂存,接通后拉取)。原因:VoIP push 体积有限(APNs ≤ 4KB / 5KB),且 SDP 时效性交给接通后的信令更稳。

**(c) APNs 发送(新增 `server/src/realtime/apnsVoip.ts`)**
- HTTP/2 连接 APNs(`api.push.apple.com`);**token-based**:用 `.p8` + Key ID + Team ID 签 ES256 JWT 作 `authorization: bearer`。
- header:`apns-topic: com.ourchat.ios.voip`、`apns-push-type: voip`、`apns-priority: 10`、`apns-expiration`(短,如 30s——过期来电无意义)。
- 处理 APNs 响应:`410`/`BadDeviceToken` → 删该 token;`429`/`503` → 退避重试。

### 4.3 数据库(新增一张表)

`device_push_token`:
- `id`、`user_id`、`device_id`、`platform`('ios' | 'web')、`token`(iOS 存 VoIP token;web 存 subscription JSON,见 Web 方案)、`created_at`、`updated_at`、`last_seen_at`。
- 唯一键 `(user_id, device_id)`;`user_id` 上索引(按用户批量取 token)。
- 与 presence 的关系:presence 是**易失的在线态**(Redis,TTL),`device_push_token` 是**持久的"离线也能触达"通道**(DB)。二者互补:presence 判"要不要走 push",token 表提供"push 往哪发"。

---

## 5. 关键技术细节与坑

1. **收到 VoIP push 必须同步 `reportNewIncomingCall`(2.2)**。哪怕解析失败/来电已取消,也要报一通再立即 `reportCall(...ended)`;绝不能"什么都不做"返回。
2. **APNs topic 必须是 `<bundleId>.voip`**;`apns-push-type: voip` 必带,否则被当普通推送、不唤醒。
3. **token 方式(.p8)优于证书**:一把 key 同时用于 dev/prod,永不过期;证书方案要区分环境且一年一换,不取。
4. **中国大陆可达性**:APNs 是设备直连 Apple 边缘,不经我们服务器、不受常规墙影响,国内 iPhone 正常收 VoIP push。我们服务器→APNs 走 `api.push.apple.com:443`(HTTP/2),服务器出网需可达。
5. **多设备/多端并发振铃**:一个用户可能多台设备。发起时对"离线 iOS 设备"逐个 push、对"在线设备"走 socket;任一端接听 → 现有 `call:handled` 广播让其余端停止(CallKit 端调 `reportCall(...ended, reason: .answeredElsewhere)`)。
6. **主叫超时/被叫未接**:主叫侧超时(现有"无应答超时")→ `emit('call:end')`;服务端同时对已 push 的设备可发一条"取消"(可选:再发一个 VoIP push 让 CallKit 结束这通,或依赖 App 接通后自查 callId 已失效)。`apns-expiration` 设短,避免"迟到的来电"。
7. **音频会话协作**:必须在 `provider(_:didActivate:)` 里把 WebRTC 切到系统激活的 `AVAudioSession`,否则接通后没声音。这是 CallKit + WebRTC 集成最常见的坑。
8. **权限与隐私**:VoIP push 无需用户额外授权(不同于普通通知的 `UNUserNotification` 授权);但 App 首次会请求麦克风/摄像头权限(现有)。CallKit 来电 UI 会显示主叫名/头像,payload 里带的这些字段注意脱敏与体积。
9. **PushKit token 生命周期**:token 可能变化(重装/系统刷新),`pushRegistry(_:didUpdate:for:.voIP)` 每次都要上报;登出要 `unregister`,避免给已登出账号的设备推来电。

---

## 6. 方案对比

| 维度 \ 方案 | 普通 APNs 通知 | 静默推送(content-available) | **VoIP Push + CallKit(本方案)** |
|---|---|---|---|
| 被杀 App 能否唤醒 | ✗ | ✗(被杀不唤醒) | ✓ |
| 锁屏/后台原生来电 UI | ✗ | ✗ | ✓ 系统级全屏 |
| 实时性/优先级 | 中 | 低(严格限流) | 高(专用高优通道) |
| 合规风险 | 无 | 滥用会被限流 | **必须配 CallKit**,否则封能力 |
| 音频会话稳定性 | — | — | ✓ 系统托管 |
| 结论 | 只能做"有条横幅",不能自动接通 | 不可靠,不适合来电 | **iOS 离线来电唯一正解** |

---

## 7. 落地步骤(建议顺序)

1. **Apple Developer 配置**:App ID 开 Push;生成 APNs `.p8`(记 Key ID / Team ID);Provisioning Profile 更新。
2. **iOS 工程**:`Project.swift` 加 `voip` 后台模式 + push entitlement;接 `PKPushRegistry` 拿 token;接 `CXProvider`/`CXProviderDelegate`。
3. **服务端**:`device_push_token` 表 + `/api/push/register`;`apnsVoip.ts`(HTTP/2 + .p8 JWT);`socket.ts` 的 `call:start` 分叉(presence 判离线 → push)。
4. **联调**:先"App 后台"→ 再"App 被杀"→ 再"锁屏";验证接听后 socket + WebRTC 正常接管;验证多端并发、超时取消、token 失效清理。
5. **灰度**:先内部设备,观察 APNs 送达率、误报率、接通成功率。

---

## 8. 边界与未尽

- 本方案覆盖"离线**唤醒振铃**";接通后的媒体质量、弱网重连仍由现有 WebRTC/coturn 负责。
- **端到端加密的信令**不在本方案范围;push payload 只带非敏感的展示字段 + callId。
- CallKit 在**中国区**有历史合规提示(需符合工信部要求),上架前确认;技术能力本身可用。
- 若未来要"离线也能秒接通"(接听即媒体已就绪),可预取 ICE/TURN 凭据、把 offer 暂存 Redis 由接通后即时拉取,进一步压缩接通延迟——属增量优化。
