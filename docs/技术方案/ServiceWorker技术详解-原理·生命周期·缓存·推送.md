# Service Worker 技术详解 —— 原理 · 生命周期 · 缓存 · 推送

> 范围:把 Service Worker(SW)这项 Web 平台能力**从底层原理到工程实践**讲透——它是什么、解决什么问题、运行模型、完整生命周期、请求拦截与缓存策略、事件全景、与页面通信、推送与通知、后台能力的边界、安全约束、常见坑、调试,以及在 our-chat 的落地位置。与《离线音视频来电-Web 方案》互补:那篇讲"用 SW 做离线来电",本篇讲"SW 本身到底是怎么回事"。
> 结论先行:**SW 是浏览器给网站的一段"可编程的、脱离页面的后台脚本"**——它像一个**装在浏览器里的代理**,坐在页面与网络之间,能拦截请求、读写缓存、在**页面关闭后被浏览器按需唤醒**处理推送/同步等事件。它**事件驱动、随时被杀、无持久内存、无 DOM**;想跨唤醒保存状态必须落 IndexedDB/Cache。理解它的关键是三件事:**作用域(scope)决定它管哪些请求、生命周期(install/activate/更新)决定哪个版本在生效、"随时终止"决定你不能把它当常驻进程用**。

---

## 0. 术语表(先读)

| 术语 | 全称 / 含义 | 通俗解释 |
|---|---|---|
| **Service Worker(SW)** | — | 注册在某源(origin)下、**独立于页面运行**的后台脚本;可拦截网络请求、收推送、被按需唤醒。 |
| **Web Worker** | — | 页面开的后台线程,**与页面同生命周期**;SW 是它的"特化+更持久"版本(能在页面关闭后活)。 |
| **作用域(scope)** | — | 一个 SW **能控制的 URL 前缀范围**。默认 = SW 脚本所在目录;`/sw.js` → 作用域 `/`(整站)。 |
| **控制(control)** | — | 页面被某个 SW"接管":该页面的请求会经过这个 SW 的 `fetch` 事件。`navigator.serviceWorker.controller` 指向它。 |
| **`register()`** | `navigator.serviceWorker.register(url, {scope})` | 页面告诉浏览器"用这个脚本当本源的 SW"。 |
| **install / activate** | 生命周期事件 | `install`:新 SW 首次装配(常用于预缓存);`activate`:新 SW 开始接管(常用于清理旧缓存)。 |
| **`event.waitUntil(promise)`** | — | 告诉浏览器"这个事件还没处理完,**别终止我**,等这个 promise resolve"。install/activate/push 都靠它延命。 |
| **`skipWaiting()`** | — | 新 SW 跳过"等旧版本退场"的等待,**立即进入 activate**。 |
| **`clients.claim()`** | — | 让**已经打开的页面**立刻被当前 SW 接管(否则要等下次导航才被控)。 |
| **Cache API** | `caches` / `CacheStorage` | SW 可编程的**响应缓存仓库**(存 `Request→Response`),与浏览器 HTTP 缓存**是两套东西**。 |
| **`fetch` 事件 / `respondWith`** | — | SW 拦截页面发出的请求;`event.respondWith(resp)` 用你给的响应"应答",可来自缓存或网络。 |
| **Clients API** | `self.clients` | SW 侧操作它控制的页面(枚举 `matchAll`、聚焦 `focus`、打开 `openWindow`、`postMessage`)。 |
| **Push API / `push` 事件** | — | 服务端经浏览器推送服务把消息投给 SW;SW 收 `push` 事件(须弹通知,见推送章)。 |
| **Notification API / `showNotification`** | — | 弹系统通知;SW 里只能用 `registration.showNotification`。 |
| **PWA** | Progressive Web App | "可安装到主屏"的网页应用;SW + Web App Manifest 是其两大基石。 |
| **安全上下文(secure context)** | — | SW/Push 只在 **HTTPS**(或 `localhost`)可用。 |

---

## 1. SW 是什么、解决什么问题

**一句话:SW 是浏览器给网站的一个"可编程网络代理 + 后台事件处理器"。** 它把两类以前网页做不到的能力交到开发者手里:

1. **可编程地控制网络与缓存** → 离线可用、秒开、精细缓存策略(PWA 的核心)。
2. **在页面关闭后被浏览器唤醒处理事件**(推送、后台同步)→ 离线通知/来电提醒、后台补传。

在 SW 之前:
- 想离线只有被废弃的 AppCache(声明式、坑多、不可编程)。
- 页面一关,网站就"没有任何代码在跑"了,收不到任何推送。

SW 用**事件驱动 + 按需唤醒**的模型补上这两块,同时用一系列限制(HTTPS、无 DOM、随时终止、必须用户可见的推送)把"后台能力"关进防滥用的笼子。

> **心智模型**:把 SW 想成"**装在浏览器里、代表你网站的一个小服务**"。页面是客户端,SW 是本地的一层代理服务;它平时睡觉(被浏览器终止),来事件(fetch/push)时被叫醒,处理完继续睡。

---

## 2. 运行模型:独立、事件驱动、无 DOM、随时被杀

- **独立线程/上下文**:SW 跑在 `ServiceWorkerGlobalScope`(`self`),**不是页面的 `window`**。**没有 DOM、没有 `window`、没有 `localStorage`、没有同步 XHR**。有:`fetch`、`caches`、`indexedDB`、`postMessage`、`importScripts`、`Notification`、`clients`。
- **每源单例、多页共享**:一个源(scheme+host+port)下同一作用域**只有一个** SW 实例,被该源所有受控页面共享。
- **事件驱动 + 随时终止**:SW **没有"一直运行"这回事**。浏览器在有事件(install/activate/fetch/push/message…)时唤醒它,处理完(且没有 `waitUntil` 挂着)**很快就把它终止**(常见几秒~几十秒)。因此:
  - **不能在 SW 里用全局变量保存跨唤醒的状态**(下次醒来是全新环境);要持久化用 **IndexedDB / Cache**。
  - **不能在 SW 里维持长连接(WebSocket)做保活**——它会被杀;这正是 §《离线来电 Web 方案》里"web 离线只能靠 Push、不能靠长连"的根因。
- **`event.waitUntil(p)` 是唯一的"延命"手段**:在事件里调用它,浏览器会等 `p` 完成再考虑终止 SW。异步活儿(写缓存、发通知)必须包在 `waitUntil` 里,否则可能没干完就被杀。

---

## 3. 注册与作用域(scope)

```js
// 页面里(main thread)
if ('serviceWorker' in navigator) {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
}
```

- **作用域决定 SW 管哪些 URL**:`scope: '/'` → 控制全站;`scope: '/app/'` → 只控制 `/app/**`。
- **作用域上限 = SW 脚本所在路径**:`/sw.js` 最多能要 `/` 作用域;`/js/sw.js` 默认作用域是 `/js/`,想要更大需服务端返回响应头 `Service-Worker-Allowed: /`。**所以 SW 文件通常放在站点根**。
- **一个源可注册多个不同作用域的 SW**;一个请求由**作用域最长匹配**的那个 SW 处理。
- **首次注册不控制当前页面**:注册成功后,**当前这次加载的页面并不会立刻被新 SW 接管**(它是"无控制"加载的);要下次导航,或在 SW 里 `clients.claim()` 才接管(见 §4)。

---

## 4. 生命周期(最容易踩坑的部分)

一个 SW 的状态流转:

```
(register)
   │
   ▼
installing ──(install 事件成功)──▶ installed / waiting ──(activate)──▶ activating ──▶ activated ──(被新版本取代)──▶ redundant
                                        ▲                                                 │
                                        └────────── 旧版本仍在控制页面时,新版本在此等待 ─┘
```

### 4.1 `install`:装配(常用于预缓存)

```js
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('static-v1').then((c) => c.addAll(['/', '/index.html', '/app.js', '/app.css']))
  );
});
```
- 新 SW 首次下载后触发一次;这里把**首屏必需的静态资源预缓存**,为离线兜底。
- `install` 成功 → 进入 **`installed/waiting`**。

### 4.2 "waiting":为什么新版本不立刻生效

- 若**已有一个 active SW 正在控制页面**,新装好的 SW **不会马上接管**,而是停在 `waiting`,**直到所有受它旧版本控制的页面都关闭**(全部标签页关掉再打开),新版本才 `activate`。
- **原理**:保证同一时刻**一个源只有一个 SW 版本在控制页面**,避免"半新半旧"导致缓存/逻辑不一致。
- 想**立即上位**:在 `install` 里调 `self.skipWaiting()`(跳过等待,直接 activate);但要小心"页面还是旧的、SW 已是新的"的版本错配,通常配合"提示用户刷新"。

### 4.3 `activate`:接管(常用于清理旧缓存)

```js
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== 'static-v1').map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())   // 让已打开的页面立刻受控
  );
});
```
- 新 SW 开始接管;删旧版本的缓存最合适放这里。
- `self.clients.claim()`:默认新 activate 的 SW 只控制**之后导航**的页面;调它可**立即接管当前已打开的页面**。

### 4.4 更新模型:浏览器怎么发现"SW 变了"

- 浏览器在**页面导航时、以及大约每 24h**,会重新拉取 SW 脚本,**字节比对**旧版本:**有一个字节不同**就认为是新版本 → 走 `install`(变成 waiting)。
- 因此**别给 `sw.js` 加长缓存**(否则更新不出去);SW 脚本本身应 `Cache-Control: no-cache` 或短 TTL。
- 常见"更新提示"做法:检测到 `reg.waiting` 存在 → 弹"有新版本,点刷新" → 用户点 → 给 waiting SW `postMessage('SKIP_WAITING')` → SW 里 `skipWaiting()` → `controllerchange` 后 `location.reload()`。

---

## 5. 请求拦截与缓存(SW 的招牌能力)

### 5.1 `fetch` 事件:代理页面的每个请求

```js
self.addEventListener('fetch', (event) => {
  // 不 respondWith 就等于放行给网络(默认行为)
  event.respondWith(handle(event.request));
});
```
- 受控页面发出的**同源请求、以及带 CORS 的跨源请求**都会进 `fetch` 事件。
- `event.respondWith(Response)`:你来决定这个请求怎么应答——从 Cache 拿、从网络拿、拼一个、或降级。
- **Cache API ≠ HTTP 缓存**:`caches` 是你**手动读写**的仓库(`caches.open(name)` → `cache.match/put/addAll`),生命周期你自己管;和浏览器根据响应头做的 HTTP 缓存互相独立。

### 5.2 常见缓存策略(按场景选)

| 策略 | 逻辑 | 适用 | 取舍 |
|---|---|---|---|
| **Cache First(缓存优先)** | 先查缓存,命中直接返回,否则回源并写缓存 | 版本化静态资源(带 hash 的 js/css/图) | 最快、可离线;但内容更新要靠改 URL |
| **Network First(网络优先)** | 先请求网络,失败再回缓存 | 经常变的接口/HTML | 新鲜度好;离线才用旧的 |
| **Stale-While-Revalidate** | 先返缓存(快),同时后台回源更新缓存 | 头像、列表等"稍旧也行"的资源 | 秒开 + 下次新;可能这次看到旧的 |
| **Cache Only** | 只读缓存 | 预缓存的离线壳 | 完全离线;需预缓存 |
| **Network Only** | 只走网络 | 不可缓存的写请求 | 无离线能力 |

> 工程上常按**请求类型分流**:HTML 用 network-first,带 hash 的静态资源用 cache-first,图片/头像用 stale-while-revalidate,API 写请求 network-only(必要时配合 Background Sync 补传)。

### 5.3 预缓存(precache)vs 运行时缓存(runtime)

- **预缓存**:`install` 时一次性 `addAll` 一批"离线壳"资源(app shell)。
- **运行时缓存**:`fetch` 里按策略动态写入(用户访问到哪缓存到哪)。
- 二者常并用:壳预缓存保证首屏离线可开,运行时缓存补充数据/资源。

---

## 6. 事件全景

| 事件 | 何时触发 | 典型用途 |
|---|---|---|
| `install` | 新 SW 装配 | 预缓存(`waitUntil` + `caches.addAll`) |
| `activate` | 新 SW 接管 | 清旧缓存、`clients.claim()` |
| `fetch` | 受控页面发请求 | 拦截 + 缓存策略 |
| `message` | 页面/其它 SW `postMessage` | 页面↔SW 通信(如"跳过等待") |
| `push` | 收到 Web Push | 弹通知(须 `waitUntil(showNotification)`) |
| `notificationclick` | 用户点通知/按钮 | `openWindow`/`focus` 页面、执行动作 |
| `notificationclose` | 通知被关 | 埋点/清理 |
| `pushsubscriptionchange` | 推送订阅变更/失效 | 重新订阅并上报服务端 |
| `sync`(Background Sync) | 网络恢复后 | 补传离线时排队的写请求 |
| `periodicsync` | 周期后台(权限严格、支持有限) | 定期后台刷新 |

---

## 7. 与页面通信

SW 无 DOM,要影响 UI 得和页面通信:

- **页面 → SW**:`navigator.serviceWorker.controller.postMessage(msg)`;SW 收 `message` 事件。
- **SW → 页面**:`self.clients.matchAll()` 拿到受控页面列表 → `client.postMessage(msg)`;页面 `navigator.serviceWorker.addEventListener('message', …)` 收。
- **Clients API**:`matchAll({ type:'window', includeUncontrolled:true })` 枚举窗口;`client.focus()` 聚焦;`clients.openWindow(url)` 开新窗(**只能在 `notificationclick` 等用户手势事件里调**)。
- **BroadcastChannel**:页面与 SW 也可用同名 `BroadcastChannel` 广播通信。

> our-chat 离线来电正是靠这条:SW 收 `push` → 弹通知 → 用户点接听 → `notificationclick` 里 `openWindow('/call?callId=…')` 或 `focus + postMessage(callId)` → 页面拿 callId 起通话。

---

## 8. 推送与通知(承接《离线来电 Web 方案》)

- **Push**:服务端用 **VAPID** 私钥经浏览器推送服务下发 → SW 收 `push` 事件。**约束:`push` 事件里必须弹一条用户可见通知**(订阅时 `userVisibleOnly: true`),浏览器**不允许纯静默后台推送**。
- **Notification**:SW 里 `self.registration.showNotification(title, { body, icon, actions, data, tag, requireInteraction })`;`actions` 让通知带按钮(如"接听/拒绝");`tag` 去重。
- **点击**:`notificationclick` → `event.waitUntil(clients.openWindow(...) / matchAll+focus)`。

```js
self.addEventListener('push', (event) => {
  const p = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(p.title, {
      body: p.body, data: p, tag: p.callId, requireInteraction: true,
      actions: [{ action: 'accept', title: '接听' }, { action: 'reject', title: '拒绝' }],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { callId } = event.notification.data;
  event.waitUntil((async () => {
    if (event.action === 'reject') { await fetch('/api/call/reject', { method:'POST', body: JSON.stringify({ callId }) }); return; }
    const all = await clients.matchAll({ type:'window', includeUncontrolled:true });
    const hit = all.find((c) => c.url.includes('/'));
    if (hit) { await hit.focus(); hit.postMessage({ type:'incoming-call', callId }); }
    else { await clients.openWindow(`/call?callId=${callId}&action=accept`); }
  })());
});
```

### 8.1 深入:Web Push 的**四方架构**(彻底厘清"谁跟谁通信")

很多人以为"服务器直接把消息推给浏览器"——**错**。Web Push 里有**四个角色**,应用服务器**从不直接连浏览器**:

```
① 应用服务器            ② 推送服务(Push Service)            ③ 浏览器/OS 的推送客户端        ④ Service Worker
  our-chat server         浏览器厂商运营的中间人               持有到②的"长连接"的那个进程       被唤醒收 push 事件
      │                    ┌───────────────┐                  ┌──────────────────┐
      │  HTTP POST 到       │ 面向服务器:HTTP │   长连接(私有协议) │ 收到消息→唤醒 SW  │
      └───endpoint────────▶│  端点(endpoint) │◀════════════════▶│                  │───▶ push 事件
         (VAPID鉴权+密文)   │ 面向设备:长连接 │                  └──────────────────┘
                           └───────────────┘
```

- **① 应用服务器(our-chat server)**:只会做一件事——**HTTP POST 到 `subscription.endpoint`**。它**不知道也不关心**目标浏览器在哪、开没开;它连的是"推送服务",不是浏览器。
- **② 推送服务(Push Service)**:**由浏览器厂商运营**的中间人,有两张脸:
  - 对**服务器**:暴露一个 **HTTP 端点**(就是订阅里的 `endpoint` URL,每台浏览器一个唯一地址)。
  - 对**设备**:与浏览器/OS 的推送客户端维持一条**长连接**,负责把消息投下去。
  - 各家不同:**Chrome/Chromium → Google FCM**(端点 `fcm.googleapis.com`);**Firefox → Mozilla autopush**;**Safari(iOS/macOS)→ Apple 的 Web Push(走 APNs)**;Edge 等各用各家。
- **③ 浏览器/OS 的推送客户端**:**持有那条长连接的进程**——这是回答"谁在监听服务器事件"的关键(见 8.3)。
- **④ Service Worker**:被③唤醒,收 `push` 事件(哪怕它此前已被终止)。

### 8.2 订阅从哪来:`endpoint` 是怎么生成的

```
页面: reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: VAPID_PUB })
  │  浏览器→它的推送服务②注册这台设备
  ▼
推送服务②分配:唯一 endpoint URL(这台浏览器在②上的"收件地址")+ 一对加密密钥(p256dh / auth)
  ▼
浏览器把它们打包成 PushSubscription 交回页面 → 页面 POST /api/push/register 存到 our-chat 库
```

**endpoint 就是"这台浏览器在推送服务上的收件地址"**;`p256dh`/`auth` 是**给这台浏览器专属的加密公钥**(见 8.5)。

### 8.3 一条 push 的完整旅程

```
our-chat server
  │  ① HTTP POST  endpoint
  │     headers: Authorization: vapid t=<JWT>,k=<VAPID公钥>;  TTL: 30;  Content-Encoding: aes128gcm
  │     body:    <用 p256dh/auth 加密后的密文>   ← 推送服务读不了明文
  ▼
推送服务②(FCM/Mozilla/Apple)
  │  ② 校验 VAPID(确认是 our-chat 发的)→ 按 endpoint 找到目标设备
  │  ③ 经【长连接】把密文投给目标浏览器/OS 的推送客户端③
  │     设备当前不在线 → 按 TTL 暂存排队,重连后补投(超 TTL 丢弃)
  ▼
浏览器/OS 推送客户端③
  │  ④ 用本地私钥解密 → 交给对应的浏览器 → 找到该 origin 的 SW
  │  ⑤ 若 SW 已被终止,【把它唤醒】
  ▼
Service Worker④:push 事件 → showNotification(...)（必须弹通知)
```

### 8.4 "谁在监听服务器事件"——那条长连接到底在**哪个进程**

**核心认知:持有长连接、真正"在监听"的,不是 our-chat server,也不一定是浏览器窗口进程,而是"③浏览器/OS 的推送客户端"。它在哪、关浏览器会不会把它一起关掉,决定了"浏览器关了还能不能收"。** 各平台:

| 平台 | 长连接由谁维持 | 到哪 / 什么协议 | 与浏览器窗口进程的关系 |
|---|---|---|---|
| **Android** | **Google Play 服务(GMS)** | Google 的 MCS(TCP/TLS 长连,`mtalk.google.com`) | **OS 级常驻,和 Chrome 进程解耦** |
| **iOS / macOS(Safari/PWA)** | **系统 APNs 守护进程(apsd)** | Apple APNs 协议 | **OS 级常驻,和 Safari 解耦** |
| **桌面 Chrome/Edge** | **浏览器自己的(后台)进程** | Google MCS(TCP 5228) | **随浏览器进程;开"后台运行"才在关窗口后保留** |
| **桌面 Firefox** | **Firefox 进程** | 到 `push.services.mozilla.com` 的 **WebSocket** | 随 Firefox 进程 |

**要点**:
- **移动端(Android/iOS)监听方是 OS 级推送守护进程**(GMS / apsd),它**独立于浏览器进程常驻**——所以"把浏览器从后台划掉/关掉窗口"照样能收,消息到守护进程后由它**反过来唤醒浏览器 → 唤醒 SW**。
- **桌面端监听方通常是浏览器自己的进程**——所以"关不关得到"取决于浏览器进程还在不在。

### 8.5 **浏览器本身也被关了,还能收吗?**(分平台直接回答)

- **Android**:**能**。连接在 GMS(系统服务),从最近任务划掉 Chrome、甚至 Chrome 没在跑,push 到 GMS → GMS **拉起** Chrome 的 SW 收 `push`。**例外**:被系统 **force stop**、或被厂商激进省电/电池优化**冻结**的 App 收不到(国产 ROM 常见);这属系统层限制,非 Web Push 本身。
- **iOS 已安装为 PWA(16.4+)**:**能**。连接在 apsd(系统),Safari 没开也能唤醒该 PWA 的 SW。**未"添加到主屏"的普通 Safari 标签页:不支持后台 push**。
- **桌面 Chrome / Edge**:**看设置**。开启"关闭窗口后继续在后台运行"(设置里 *Continue running background apps when Chrome is closed*)→ 浏览器留一个**后台进程 + 长连接** → **收得到**;若**彻底退出**(菜单 Quit,所有进程结束)→ 长连接断 → **收不到**,直到**重新打开浏览器**(重开后可能收到推送服务在 TTL 内**排队**的那几条)。
- **桌面 Firefox**:需 Firefox 进程在(含其后台机制);**完全退出则收不到**,直到重启。

**一句话总结**:
> **移动端**:监听方是 **OS 级推送守护进程**(Android=GMS、iOS=APNs),与浏览器解耦,**浏览器关了/划掉也能收**(除非被系统 force-stop/冻结)。
> **桌面端**:监听方通常是**浏览器自己的(后台)进程**,**彻底退出浏览器就断了**;开着"后台运行"才能在关窗口后继续收。

这也正是"web 离线来电"**在手机上体验更接近可用、在桌面上取决于浏览器是否后台运行**的根本原因。

### 8.6 送达语义:排队、TTL、尽力而为(不保证即时/必达)

- 设备离线/长连接断时,**推送服务按 `TTL` 暂存排队**,重连后补投;**超 TTL 丢弃**。来电这种时效性强的场景应把 TTL 设短(如 30s),避免"迟到的来电"。
- Web Push 是**尽力而为**:不保证秒达、不保证必达(设备深睡、被冻结、网络差都可能延迟或丢)。**适合"提醒/唤醒",不适合硬实时**。

### 8.7 安全:服务器凭什么能推、推送服务为何读不到内容

两层机制,别混:

- **VAPID(应用服务器身份鉴权,RFC 8292)**:our-chat server 用自己的 **VAPID 私钥**签一个 **JWT**(`aud`=推送服务源、`exp`、`sub`=联系方式),放进 `Authorization` 头。推送服务据此确认"这条 POST 确实是 our-chat 发的、且是这个 endpoint 的合法发送者",**防别人拿到你的 endpoint 乱发**。
- **载荷端到端加密(消息加密,RFC 8291)**:用订阅里的 `p256dh`(设备公钥)+ `auth` 做 ECDH+HKDF 派生密钥,**AES-128-GCM 加密正文**。**推送服务只是搬运工,读不到明文**;只有目标浏览器能解密。所以 callId、主叫昵称等即使经过 Google/Apple 的推送服务,内容也不被中间人看到(但**元数据**如"有一条推送、多大、给谁"对推送服务可见)。

> 对 our-chat 的含义:**离线来电的 payload 经第三方推送服务中转,但内容是加密的**;仍建议 payload 只放展示所需的最小字段(callId、主叫名/头像、callType),敏感信息与 SDP 不入 push。

---

## 9. 后台能力的边界(为什么 SW 不能当"常驻进程")

- **随时被杀 + 无持久内存**:处理完事件很快被终止;跨唤醒状态只能落 IndexedDB/Cache。
- **不能长连保活**:SW 里开 WebSocket 也会随 SW 被杀而断;**不能靠 SW 维持实时连接**。
- **Background Sync**:`sync` 事件在**网络恢复后**触发,用于"离线时排队的写请求,联网后补传",**不是定时器**,也不保证即时。
- **Periodic Sync**:周期性后台刷新,**权限严格、浏览器支持有限**,不能依赖它做实时。
- **推送必须用户可见**:`userVisibleOnly`,拿不到"静默后台执行"。

**综上**:SW 适合"**被动响应事件**(收请求、收推送、联网补传)",不适合"**主动常驻**(保活、定时轮询、维持长连)"。这条边界直接决定了 web 离线来电只能做到"Push 唤醒 + 通知",做不到 iOS CallKit 那种"被杀也能全屏接通"。

---

## 10. 安全与约束

- **仅 HTTPS(或 localhost)**:SW 能拦截所有请求,威力大,故强制安全上下文,防中间人植入恶意 SW。
- **同源**:SW 脚本必须与注册它的页面同源;作用域受脚本路径限制(§3)。
- **无第三方 SW 拦截跨源**:SW 只能处理自己源的请求(跨源资源除非带 CORS)。
- **更新不可长缓存**:`sw.js` 别设长 TTL,否则新版本发不出去。

---

## 11. 常见坑

1. **首次注册不接管当前页**:注册成功 ≠ 当前页受控;要 `clients.claim()` 或下次导航。调试时容易误以为"没生效"。
2. **改了 SW 不更新**:`sw.js` 被 HTTP 缓存 → 浏览器拉到旧字节 → 不触发更新。设 `no-cache`。
3. **waiting 卡住**:开着旧标签页,新 SW 永远 waiting。要么关光标签页,要么 `skipWaiting`(注意版本错配)。
4. **在 SW 里用全局变量存状态**:下次唤醒丢失。用 IndexedDB/Cache。
5. **异步没包 `waitUntil`**:通知/缓存写一半 SW 被杀。所有异步活儿包进 `waitUntil`。
6. **openWindow 不在用户手势里**:`push` 事件里直接 `openWindow` 会被拦;必须放 `notificationclick`。
7. **缓存了会变的 HTML/API 用 cache-first**:导致用户看到旧内容。按资源类型选策略(§5.2)。
8. **scope 放错目录**:`/js/sw.js` 默认只管 `/js/`,拦不到根路由请求。SW 放根或配 `Service-Worker-Allowed`。

---

## 12. 在 our-chat 的落地位置

- **现状**:web 端**尚无 SW**(核实 `web/` 无 sw / PushManager)。
- **首个用途 = 离线来电提醒**(见《离线来电 Web 方案》):只需 `push` + `notificationclick` + `pushsubscriptionchange` 三个事件,**不必**一上来就做全套离线缓存。
- **可选增量**:后续要 PWA(可安装、静态资源离线秒开)时,再加 `install` 预缓存 + `fetch` 缓存策略(建议用成熟库如 Workbox 生成,少手写易错的生命周期/缓存代码)。
- **不要用 SW 做**:实时消息保活、维持 socket——那是长连接的活,SW 会被杀;实时仍走页面内的 socket.io / gateway WS。

---

## 13. 调试

- **Chrome DevTools → Application → Service Workers**:看当前 SW 状态(installing/waiting/active)、`Update on reload`(每次刷新强制更新 SW,开发必开)、`Skip waiting`、`Unregister`。
- **Application → Cache Storage**:看 Cache API 里存了什么。
- **Application → Push / Notifications**:可手动触发测试推送。
- **`chrome://serviceworker-internals`**:更底层的 SW 列表与生命周期日志。
- 改 SW 逻辑后:开 `Update on reload` + 硬刷新,或手动 `Unregister` 重来,避免被旧版本干扰。

---

## 14. 方案对比与边界

### 14.1 SW vs Web Worker vs 主线程

| 维度 | 主线程(页面) | Web Worker | **Service Worker** |
|---|---|---|---|
| 生命周期 | 随页面 | 随页面 | **可在页面关闭后被唤醒** |
| DOM | ✓ | ✗ | ✗ |
| 拦截网络请求 | ✗ | ✗ | ✓(`fetch` 事件) |
| 收推送/后台事件 | ✗ | ✗ | ✓(`push`/`sync`) |
| 典型用途 | UI | CPU 密集计算 | 离线缓存、推送、代理 |

### 14.2 边界(一句话)

**SW 是"被动响应事件的可编程代理",不是"常驻后台服务"**。它给 web 带来了离线缓存与离线推送两大能力,但用一整套限制(HTTPS、无 DOM、随时终止、推送必可见、不能保活)把能力关进笼子——这些限制既是安全设计,也正好划定了 our-chat"web 离线来电只能到通知级"的天花板。
