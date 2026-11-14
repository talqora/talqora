# mkcert 证书安装 SOP（本地 HTTPS 与局域网调试）

> 适用场景：用手机 / 平板 / 另一台电脑访问本机 `vite` dev server，且需要用到摄像头、麦克风或 WebSocket。
>
> 结论先说：**不是「必须装 mkcert」，而是「客户端必须信任签发这张证书的那个 CA」。** mkcert 只是把「自己当 CA + 一键签发」这两件事做顺手的工具。本文给出在本项目里从零到可用的完整步骤，以及两个容易卡住的地方（证书 SAN 不含当前 IP、WS Origin 白名单）。

---

## 0 一句话结论

- **只在本机浏览器访问 `https://localhost:5173`**：不需要装证书。`localhost` 本身就是安全上下文，且 `vite-plugin-mkcert` 会自己搞定本机信任。
- **局域网设备（手机）访问 `https://192.168.x.x:5173`**：必须把本机 mkcert 的根证书 `rootCA.pem` 装到**那台设备**上，否则浏览器报「证书不受信任」。只在本机跑 `mkcert -install` 是不够的。
- **为什么不能用 http 凑合**：`http://192.168.x.x:5173` 不是安全上下文，`navigator.mediaDevices` 直接不可用，音视频通话、语音消息全部失效。这与「cookie 能不能带」无关——本项目 dev 下 cookie 本来就不加 `Secure`（`biz/internal/api/cookies.go` 的 `SetAuthCookies(..., secure = IsProduction)`），所以 http 下登录态是好的，**坏的是媒体采集**。

---

## 1 原理：为什么局域网设备必须单独装证书

### 1.1 浏览器的「安全上下文」判定

浏览器只在这几种情况下把页面当作 secure context：

| 来源 | 是否 secure context |
|---|---|
| `https://` 且证书链可信 | ✅ |
| `http://localhost` / `http://127.0.0.1` | ✅（特例放行） |
| `http://192.168.x.x` / `http://10.x.x.x` | ❌ |
| `https://192.168.x.x` 但证书不受信任 | ❌（拦截页，不执行脚本） |

`getUserMedia`（`web/src/utils/webrtc.ts` 里的 `getUserMedia` 调用）、`serviceWorker`、`crypto.subtle` 都要求 secure context。这就是局域网调试必须走 HTTPS 的根本原因。

### 1.2 自建 CA 的信任链是「一端一装」

mkcert 做的事：在开发机生成一套根证书（CA），把它装进**开发机**的系统信任库，之后用它签发带 `SAN` 的服务器证书。浏览器验证时要求「服务器证书 → 签发它的 CA → 系统信任库里有这个 CA」。

所以链路是：

```
开发机的 rootCA  ──签发──▶  dev server 证书(含 SAN: LAN IP)
      ▲
      └── 必须被「每个客户端」信任，否则链断
```

**开发机装 = 只有开发机信任。** 手机要访问，就得把同一个 `rootCA.pem` 装到手机上。

### 1.3 本项目里三个相关点

| 位置 | 现状 | 影响 |
|---|---|---|
| `web/vite.config.ts` | `plugins: [react(), mkcert(mkcertOptions)]`，`server.host = '0.0.0.0'` | 已支持局域网访问；证书由插件自动签发 |
| `gateway/internal/ws/server.go` 的 `checkOrigin` | 读 `CLIENT_ORIGINS`，**非空即严格相等匹配** | 局域网地址不在白名单 → WS 握手 403（见第 5 节） |
| `biz` 的 CORS | 非生产环境放行任意 Origin | HTTP 侧不用改 |

---

## 2 方案对比：是不是非 mkcert 不可

| 方案 | 客户端要不要装东西 | 浏览器表现 | 适合 |
|---|---|---|---|
| **mkcert** | 要（每台设备装一次根证书） | 无警告 | 日常开发，长期用 |
| `openssl` 自签 | 要，或每次点「继续访问」 | 红色警告，且部分 API 仍被拒 | 一次性验证 |
| 隧道（`cloudflared tunnel --url` / ngrok） | **不要** | 公网域名，正式证书 | 手机快速验证、跨网段（公司网/客户网） |
| 纯 http | — | — | 看页面可以，**音视频不行** |

**推荐顺序**：日常开发用 mkcert；临时给同事/客户演示、或公司网络禁跨设备访问时用隧道。

### 2.1 「不装证书，点警告继续」到底行不行

先纠正一个常见误解：**「地址栏是 https 开头」≠「安全上下文」**。浏览器的判定是「https **且** 证书链可信」；证书报错的页面上，Chrome 地址栏会持续显示「不安全」，该 origin 不进入可信来源集合。

用本机 Chrome（headless，`--dump-dom` 执行页面脚本）实测 `http://<局域网IP>:5178/`：

| 启动方式 | `isSecureContext` | `navigator.mediaDevices` |
|---|---|---|
| 默认 | `false` | **`undefined`** |
| `--unsafely-treat-insecure-origin-as-secure="http://<ip>:5178"` | `true` | `object`（`getUserMedia` 是 function） |

结论分两层：

- **「通信」这一半，你说得对。** 点了「继续前往」之后，页面能加载、HTTP 接口能调、同源的 `wss` 一般也能握手（Chrome 会复用本次会话对该 origin 的例外）。收发消息、拉历史、登录都正常。
- **「采集」这一半会坏。** 音视频依赖 `getUserMedia`，它要求真正的安全上下文。证书无效的页面在 Chrome 里通常拿不到 `navigator.mediaDevices`，表现是「点发起通话没有任何权限弹窗」。这与 WebRTC 是否走 P2P 无关——**本地这一端压根没采到流**，谈不上通信。

> 上表是 http 场景的实测。`https + 无效证书 + 点继续` 这一格我无法在无头浏览器里复现（headless 没有「继续」按钮），不同 Chrome 版本行为也有差异。**给你一个 10 秒自测**：点开页面后按 F12，Console 里敲
>
> ```js
> [window.isSecureContext, typeof navigator.mediaDevices]
> ```
>
> 得到 `[true, "object"]` 就说明这条路可行；得到 `[false, "undefined"]` 就别再折腾了，直接上第 3 节的 mkcert。

另外两个硬约束，让「点继续」这条路在手机上行不通：

- **iOS Safari 对无效证书基本不给放行入口**，只有「返回」，没有「继续前往」。iPhone 测试只能装证书或用可信域名。
- **Chrome Android 有 `chrome://flags`**，可以按 2.1 的办法把 `http://<局域网IP>:5173` 标记为可信，不用证书；但这是「每台设备、每次重装」都要做一遍。

### 2.2 不想装 CA 的两条替代路径

| 场景 | 做法 | 代价 |
|---|---|---|
| 只在自己电脑上调 | Chrome 打开 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`，填入 `http://<局域网IP>:5173`，重启浏览器。然后用 **http** 访问（此时不需要证书） | 换 IP 要重填；只对桌面 Chrome/Edge 有效 |
| 要给手机测 | `cloudflared tunnel --url http://localhost:5173`（或 ngrok），拿到一个 `https://xxx.trycloudflare.com` 公网地址 | 依赖外网；地址每次变；流量出公网（开发数据无所谓） |

两条都不需要动系统信任库。**但只要开始长期做局域网调试，mkcert 仍然是最省事的一次性投入。**

---

## 3 步骤一：在开发机安装 mkcert

### macOS

```bash
brew install mkcert
brew install nss          # 仅当你用 Firefox 时需要
mkcert -install           # ← 需要 sudo 密码，会写系统信任库
```

> **本机实测的坑**：这一步必须**在交互式终端里手动执行一次**。原因是 `vite-plugin-mkcert` 启动时会自动跑 `mkcert -install`，而它在非交互环境（CI、IDE 内置终端、脚本）里拿不到 sudo 密码，会直接失败：
>
> ```
> sudo: a terminal is required to read the password; either use the -S option ...
> ERROR: failed to execute "security add-trusted-cert"
> ```
>
> 表现是 `vite` 起不来。**先在交互式终端手动跑一次 `mkcert -install`**（可能提示「已安装」直接跳过）。
>
> 如果手动装过、插件仍然报 sudo（说明它每次都尝试重写系统信任设置），最稳的做法是绕过插件的安装步骤，直接用它生成的那两个文件路径自己签一次：
>
> ```bash
> mkcert -cert-file ~/.vite-plugin-mkcert/cert.pem \
>        -key-file  ~/.vite-plugin-mkcert/dev.pem \
>        localhost 127.0.0.1 0.0.0.0 "$(ipconfig getifaddr en0)"
> ```
>
> 之后 `pnpm start` 会直接复用这份证书（见 4.2：IP 变了要重跑这条命令）。

### Windows

```powershell
# 任选其一
winget install FiloSottile.mkcert
choco install mkcert
scoop install mkcert
```

然后以**管理员** PowerShell 执行 `mkcert -install`。

> 本项目的 `web/vite.config.ts` 对 Windows 有专门处理：会探测 WinGet 安装路径
> `%LOCALAPPDATA%\Microsoft\WinGet\Packages\FiloSottile.mkcert_...\mkcert.exe`，
> 存在则显式传给插件；否则交给插件自行下载。

### Linux

```bash
sudo apt install libnss3-tools     # Debian/Ubuntu，Firefox 需要
# 二进制：https://github.com/FiloSottile/mkcert/releases
mkcert -install
```

### 验证安装成功

```bash
mkcert -CAROOT
# 应输出一个目录，例如 /Users/<you>/Library/Application Support/mkcert
ls "$(mkcert -CAROOT)"
# rootCA.pem（要分发给客户端的就是这个）、rootCA-key.pem（绝对不能外传）
```

---

## 4 步骤二：让 vite 用上证书

### 4.1 现状：插件已自动接好

`web/package.json` 已含 `vite-plugin-mkcert@^1.17.10`，`vite.config.ts` 里已有：

```ts
const mkcertOptions = fs.existsSync(winMkcertPath) ? { mkcertPath: winMkcertPath } : {}
...
plugins: [react(), mkcert(mkcertOptions)],
server: { host: '0.0.0.0', ... }
```

启动后插件会在 `~/.vite-plugin-mkcert/` 下生成：

| 文件 | 作用 |
|---|---|
| `rootCA.pem` | **根证书，要装到局域网客户端** |
| `rootCA-key.pem` | 根证书私钥，等同于中间人能力，**禁止外传/提交** |
| `cert.pem` | dev server 用的服务器证书 |
| `dev.pem` | 服务器证书私钥 |
| `mkcert` | 指向系统 mkcert 的软链 |

### 4.2 关键：证书的 SAN 是「生成那一刻」的本机 IP

实测本机现状：

```
$ openssl x509 -in ~/.vite-plugin-mkcert/cert.pem -noout -text | grep -A1 "Alternative Name"
  X509v3 Subject Alternative Name:
      DNS:localhost, IP Address:127.0.0.1, IP Address:30.31.9.29, IP Address:192.168.255.10, IP Address:0.0.0.0

$ ipconfig getifaddr en0
30.31.9.19          ← 当前 IP 是 .19，证书里是 .29
```

证书里没有 `30.31.9.19` → 手机访问 `https://30.31.9.19:5173` 会报 `ERR_CERT_COMMON_NAME_INVALID`（即使根证书已装对）。

**换网络、换 WiFi、DHCP 续租导致 IP 变了之后，必须重新生成证书：**

```bash
rm -f ~/.vite-plugin-mkcert/cert.pem ~/.vite-plugin-mkcert/dev.pem
cd web && pnpm start        # 插件会用当前 IP 重新签发
```

> 插件把本机所有网卡 IP 都作为 SAN 传给 mkcert（实测命令里带了多个 IP），所以只要 IP 在生成时存在就能访问；生成后再变 IP 就失效。

### 4.3 不想用插件（手动指定证书）

如果团队统一用一份固定 CA：

```ts
// vite.config.ts
server: {
  host: '0.0.0.0',
  https: {
    key: fs.readFileSync('/path/to/dev.key'),
    cert: fs.readFileSync('/path/to/dev.crt'),
  },
}
```

证书需满足：SAN 含目标 IP/域名、SHA-256 签名、有效期 ≤ 825 天（iOS 硬性要求）。用 `mkcert <ip> localhost` 生成最省事。

---

## 5 步骤三：局域网客户端信任根证书

### 5.1 先确认要装哪个文件

在**开发机**上执行：

```bash
cp "$(mkcert -CAROOT)/rootCA.pem" ~/Desktop/our-chat-devCA.pem
```

把这个 `rootCA.pem` 传到手机上（AirDrop / 邮件附件 / 局域网 HTTP 下载均可）。**只传 `rootCA.pem`，不要传 `rootCA-key.pem`。**

### 5.2 iOS / iPadOS

1. 用「文件」App 或 Safari 打开 `rootCA.pem` → 允许下载描述文件
2. **设置 → 已下载描述文件 → 右上角「安装」**（需要输入锁屏密码）
3. **设置 → 通用 → 关于本机 → 证书信任设置** → 找到 `mkcert ...` → 打开「**启用完全信任**」

> 第 3 步最容易漏。只做第 2 步的话，Safari 仍会报不受信任。

### 5.3 Android

1. 把 `rootCA.pem` 传到手机（改后缀为 `.crt` 更容易被识别）
2. **设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书** → 选择文件
3. 系统会提示「网络可能被监控」——这是自建 CA 的正常提示，确认即可

> Android 7+ 的**普通 App 默认不信任用户安装的 CA**（只有浏览器信任）。如果要在浏览器里测页面，没问题；如果要用原生 App 走 HTTPS，需要 App 侧配 `networkSecurityConfig`（`mobile-swift` 不受此限，iOS 不受影响）。

### 5.4 macOS / Windows 客户端

- macOS：双击 `rootCA.pem` → 钥匙串「系统」→ 找到证书 → 双击 → 信任 → 「始终信任」
- Windows：双击 → 安装证书 → 本地计算机 → 受信任的根证书颁发机构

---

## 6 步骤四：让后端接受局域网 Origin（最容易漏的一步）

**HTTPS 通了、登录也通了，但页面一直「重连中」**——99% 是这一步。

`docker/.env.debug` 里现在是：

```
CLIENT_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,https://localhost:5173,https://127.0.0.1:5173
```

`gateway` 拿它当 **WebSocket 握手的 Origin 白名单**（`gateway/internal/ws/server.go` 的 `checkOrigin`）：白名单非空时，Origin 必须**完全相等**，否则拒绝升级，握手返回 403，并计 `gateway_handshakes_total{result="origin_rejected"}`。

所以要把局域网地址加进去（假设本机 IP 是 `192.168.1.23`）：

```bash
# docker/.env.debug（.env.debug.example 同步）
CLIENT_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,https://localhost:5173,https://127.0.0.1:5173,https://192.168.1.23:5173
#                                                                                        ^^^^^^^^^^^^^^^^^^^^^^^^ 新增
```

改完重启：

```bash
# make dev 的话 Ctrl-C 后重跑；单独起 gateway 的话重启它
make dev
```

> `biz` 的 CORS 在非生产环境放行任意 Origin，所以 HTTP 侧不用动。只有 gateway 的 WS 白名单是严格匹配。

---

## 7 验证清单（按顺序，任一步失败就停在那一步）

```bash
# 1) 开发机上：证书链本身是否可信
curl --cacert ~/.vite-plugin-mkcert/rootCA.pem -o /dev/null -w "%{http_code}\n" https://<LAN_IP>:5173/
#    期望 200；若报 certificate verify failed，说明 SAN 不含该 IP（回到 4.2 重新生成）

# 2) 开发机上：证书里到底有哪些地址
openssl x509 -in ~/.vite-plugin-mkcert/cert.pem -noout -text | grep -A1 "Alternative Name"

# 3) 手机浏览器打开
#    https://<LAN_IP>:5173/  → 应无证书警告，能看到登录页

# 4) 手机控制台（Safari 需在开发机 Safari「开发」菜单里连；Chrome 用 chrome://inspect）
#    navigator.mediaDevices    → 不能是 undefined
#    window.isSecureContext    → 必须是 true

# 5) 登录后看 WS
#    浏览器 DevTools → Network → WS → 连接状态 101 Switching Protocols
#    服务端指标：gateway_handshakes_total 按 result 分组，ok 增长、origin_rejected 不增长
curl -s http://localhost:8090/metrics | grep gateway_handshakes_total
```

---

## 8 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `vite` 启动报 `sudo: a terminal is required` / `failed to execute "security add-trusted-cert"` | 插件自动跑 `mkcert -install`，非交互终端拿不到 sudo 密码 | 在交互终端手动跑一次 `mkcert -install`，之后不再需要 |
| 手机提示「证书不受信任」，但根证书已装 | iOS 少了「证书信任设置 → 完全信任」；Android 装到了「用户证书」而 App 不信任 | iOS 补第 3 步；Android 改用浏览器验证 |
| `ERR_CERT_COMMON_NAME_INVALID` / `ERR_CERT_AUTHORITY_INVALID` | 证书 SAN 不含当前 IP（换网后旧证书） | 删 `cert.pem`+`dev.pem` 重启 vite 重新签发 |
| 页面能打开、登录成功，但一直「重连中」 | `CLIENT_ORIGINS` 没加局域网地址，WS 握手 403 | 第 6 节 |
| 手机根本连不上 `:5173` | 开发机防火墙拦截 / 不在同一网段 / 公司网络隔离 | 关掉防火墙对应端口；或用隧道方案 |
| 换了 WiFi 后全挂 | IP 变了，证书 SAN 与白名单都失效 | 重新生成证书 + 更新 `CLIENT_ORIGINS` |
| Firefox 报不受信任 | 没装 `nss` | `brew install nss` 后重新 `mkcert -install` |

---

## 9 安全注意

- **`rootCA-key.pem` 等同于中间人能力**。拿到它的人可以为任意域名签证书并被你的设备信任。不要拷给别人、不要进仓库、不要放共享盘/网盘。本项目的 `.gitignore` 已忽略 `keys/*.pem` 与 `docker/keys/`，但 `~/.vite-plugin-mkcert/` 在仓库外，需要自己看住。
- 这台机器如果不再做开发，执行 `mkcert -uninstall` 把 CA 从系统信任库移除。
- 不要用这套 CA 给任何公网服务签证书——它只应存在于开发和测试环境。
- 手机测试完可以移除描述文件：iOS「设置 → 通用 → VPN与设备管理」，Android「设置 → 安全 → 加密与凭据 → 用户凭据」。

---

## ★ 关键理解点

- **正向：HTTPS 不是目的，「安全上下文」才是。** 判断标准是浏览器认不认这个来源，而不是有没有加密。`http://localhost` 和 `https://任意域名` 都能进安全上下文；`http://192.168.x.x` 不能。所以局域网调试绕不开「让那台设备信任你的证书」。
- **反向：信任是「每端一份」的，不会自动扩散。** 常见的误解是「我在电脑上 `mkcert -install` 了，手机怎么还报错」。CA 装进的是**这台机器**的信任库，手机有它自己的信任库。分发 `rootCA.pem` 是必须步骤，不是可选步骤。
- **边界：证书的 SAN 是快照，不是规则。** 证书签发那一刻把 IP 写死了，之后换网络、换 DHCP 租约都不会自动更新。所以局域网调试的失败模式往往是「昨天还好好的」——先查 IP 变没变。
- **对比：TLS 通了 ≠ 应用可用。** 本例里 TLS、登录、HTTP API 全部正常，唯一坏掉的是 WS 握手，原因是应用层的 Origin 白名单，与证书毫无关系。排查时要把「传输层」和「应用层」分开看：DevTools 里 WS 显示 403 就是应用层拒绝，不是证书问题。
