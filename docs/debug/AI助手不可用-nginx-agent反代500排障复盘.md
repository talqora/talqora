# AI 助手不可用排障复盘:nginx `/agent/` 反代一行指令顺序引发的 500

> 现象是"AI 助手无法使用,提示需要先登录 our-chat";真凶是 nginx `/agent/` 反代块里
> `set` 写在了 `rewrite ... break` **之后**,被 rewrite 模块的 `break` 吃掉,导致上游变量为空、
> `proxy_pass http://` 非法 → 500。本文记录从表象一路排除到这一行的完整过程、根因原理、
> 修复、验证,以及连带发现并补上的一个 CICD 缺口(挂载的 nginx 配置改动不会被 `up` 自动 reload)。

---

## 0. 一句话结论

前端"需要先登录 AI 助手"这句提示会在**两种**失败下触发:① 铸 token 失败,或 ② 铸 token 成功但随后向 agent-server 验活失败。本次是 ②——**铸 token 成功(HTTP 200),紧接着的 `GET /agent/api/auth/me` 返回 500**。而这个 500 不在应用层,是 **nginx `/agent/` 反代的配置求值错误**:`proxy_pass http://$agent_upstream` 里的 `$agent_upstream` 是空的。

根因:
```nginx
location /agent/ {
    resolver 127.0.0.11 valid=30s;
    rewrite ^/agent/(.*)$ /$1 break;              # break 中止 rewrite 模块后续指令
    set $agent_upstream agent-node-server:3101;   # ← 于是这行被跳过,变量永远为空
    proxy_pass http://$agent_upstream;            # ← 变成 proxy_pass http://  → 500
}
```
修复:把 `set` 挪到 `rewrite ... break` **之前**。

---

## 1. 现象与影响

- 用户在**线上 tujiang.tech**、**已登录 our-chat** 的状态下打开 `/agent`,AI 助手不可用,页面提示:
  「需要先登录 our-chat 才能使用 AI 助手,登录后刷新重试」。
- 影响面:AI 助手(RAG/Agent)整条功能不可用。IM 主功能(聊天/好友/音视频)不受影响——它们不经 `/agent/` 反代。

## 2. 排障过程:分层排除法

这次最值钱的不是那一行修复,而是**如何在看不到用户浏览器的情况下,一层层把范围缩到那一行**。

**第 1 层:那句提示到底在什么条件下弹?**
定位到 `web/src/views/agentView/agentAuth.ts` 的 `mint()`:向 `POST {SERVER_ORIGIN}/oauth/agent-token` 铸 token,`!res.ok` 就清 token 并让上层弹这句话。再结合 agentView 的测试用例发现:**铸 token 失败**、或**铸成功但 `/agent/api/auth/me` 验活失败**,都会弹同一句。→ 有两个嫌疑分支。

**第 2 层:服务端配置是否自洽?(排除"配置漂移")**
SSH 上线核对 agent 鉴权链路三要素,全部匹配:
- our-chat 铸的 token:`iss=https://tujiang.tech`、`aud=['agent-server']`、RS256(`kid=prod-202606`)。
- agent-server 校验:`OAUTH_ISSUER=https://tujiang.tech`、`audience=['agent-server']`、`OAUTH_JWKS_URI` 经 `oc-shared` 可达。
- 内外两路 JWKS(容器内 `our-chat-server:3007` 与经 nginx 的公网)返回**同一把公钥**。
→ 配置侧无问题,排除"部署导致 iss/aud/JWKS 漂移"。

**第 3 层:铸 token 到底成没成?(用日志与抓包定位分支)**
- 查 our-chat 审计日志:昨日多条 `agent_token_issued` 成功记录(user 1/2)。→ 铸 token 通路本身是好的。
- 让用户抓包,拿到决定性两条:
  - `POST /oauth/agent-token` → **200**(payload 解出来 iss/aud/kid 全对)。
  - `GET /agent/api/auth/me` → **500**,`content-type: text/html`,`content-length: 579`。
→ 锁定**分支 ②**:铸成功,死在 `/agent/api/auth/me`。

**第 4 层:500 在应用层还是代理层?(几条硬信号一起指认)**
- agent-node-server 日志:从启动到现在**只有启动日志,没有任何该 500 的报错**。而 NestJS 对未捕获的 500 默认会 `Logger` 打错误 → **错误没到应用**。
- 响应是 **`text/html`** 而不是 Nest 的 JSON(`{statusCode:500,...}`)→ **不是 Nest 异常过滤器产出的**。
- 容器内直连 `localhost:3101/api/auth/me`(绕过 nginx、无 token)→ **401**(应用本身健康)。
→ 三条信号共同指向:**500 来自 nginx `/agent/` 反代这一跳**,请求根本没进到 agent 应用。

**第 5 层:读 nginx 日志,实锤**
```
2026/07/01 05:00:10 [error] invalid URL prefix in "http://", request: "GET /agent/api/auth/me", host: "tujiang.tech"
"GET /agent/api/auth/me" 500 579
```
`invalid URL prefix in "http://"` —— `proxy_pass` 求值成了 `http://`(host 为空)。即 `$agent_upstream` 是空变量。回看配置,`set` 在 `rewrite ... break` 之后。收网。

## 3. 根因详解:为什么 `set` 会被"吃掉"

要讲清楚,得先讲两个 nginx 机制。

### 3.1 rewrite 模块指令的执行与 `break` 语义
`set`、`rewrite`、`if`、`return`、`break` 都属于 **`ngx_http_rewrite_module`**。它们不是"配置声明",而是在请求的 **rewrite 阶段按书写顺序像脚本一样顺序执行**的指令。

`break`(以及 `rewrite ... break` 里的 `break` 标志)的官方语义是:**停止执行当前这一组 `ngx_http_rewrite_module` 指令**。关键就在这:它停的是"rewrite 模块的后续指令",而 `set` 正是 rewrite 模块指令。所以:

```nginx
rewrite ^/agent/(.*)$ /$1 break;   # 执行到这:改写 URI + break → 之后的 rewrite 模块指令全部跳过
set $agent_upstream ...;           # 属于 rewrite 模块 → 被跳过,$agent_upstream 从未被赋值
```
未赋值的变量在 nginx 里求值为**空字符串**。于是 `proxy_pass http://$agent_upstream` = `proxy_pass http://`。

### 3.2 为什么要用 `set 变量 + proxy_pass http://$var + resolver` 这套写法
这不是随便写的,是为了**惰性 DNS 解析**:
- 当 `proxy_pass` 的目标是**字面量**(如 `proxy_pass http://agent-node-server:3101`)时,nginx **在启动/加载配置时就解析这个上游主机名**。agent 是**另一个 compose 项目**的容器,若它此刻没起,our-chat 的 nginx 会因为"解析不了 upstream"而**启动失败**——把 our-chat 的可用性耦合到了 agent 是否在线。
- 改成 `proxy_pass http://$变量` + `resolver`:目标含变量时,nginx **不在加载期解析,而在每次请求时用 resolver 动态解析**。agent 没起时,our-chat 照常启动,只在请求 `/agent/` 时才返回 502。解耦成功。
- 代价:这套写法**对指令顺序敏感**——变量必须在 `proxy_pass` 之前被真正赋值。一旦 `set` 被 `break` 跳过,就退化成 `http://` 非法 URL。

### 3.3 为什么是 500 而不是 502
两者容易混:
- **502 Bad Gateway** = 上游"可解析但连不上/回了坏响应"(agent 宕了、连接被拒等)。
- **500** 这里是 nginx 在**求值 `proxy_pass` 目标 URL 时发现它本身非法**(`http://` 没有 host)——属于配置求值错误,连"尝试连上游"都没到,直接 500。
所以"500 + invalid URL prefix"能一眼区别于"agent 挂了(502)"。

## 4. 修复

`docker/nginx/conf.d/default.conf`,把 `set` 提到 `rewrite` 之前:
```nginx
location /agent/ {
    resolver 127.0.0.11 valid=30s;
    set $agent_upstream agent-node-server:3101;   # 先赋值
    rewrite ^/agent/(.*)$ /$1 break;              # 再改写 + break
    proxy_pass http://$agent_upstream;            # http://agent-node-server:3101,URI 用改写后的 /api/...
}
```
顺序对了之后:`set` 先跑 → 变量得到 `agent-node-server:3101`;`rewrite ... break` 再跑,改写 `$uri` 为 `/api/auth/me` 并 break;`proxy_pass http://$agent_upstream`(变量式,不带 URI)→ 上游 `http://agent-node-server:3101`,携带改写后的 `/api/auth/me`。

## 5. 验证(生产)

nginx 配置是 **bind-mount**,不是烤进镜像,所以直接把修好的配置推到服务器 + `nginx -t` + `nginx -s reload`(无需重建容器):
- `nginx -t` ✓、reload ✓
- `GET /agent/api/auth/me`(无 token)→ **401**(此前 500)——反代已通,agent 正常拒绝无凭据请求。
- `GET /agent/api/health` → **200**——agent 经 nginx 可达。
→ 铸 token(200)→ 带 token 打 agent → agent 验签(配置已核实自洽)→ 200,整链打通。

## 6. 连带发现并修复的 CICD 缺口

修复过程中发现:**挂载的 nginx 配置改了,CICD 的 `docker compose up -d` 不会让它生效**。原因:web 镜像没变时 `up` 不重建容器,而 bind-mount 文件变更**不触发重建**,nginx 内存里仍是旧配置(compose 不感知挂载文件内容变化)。也就是说光靠"改配置 + 重新部署"救不了,必须 reload。

修复:在部署脚本(`docker/deploy-build.sh`,`up -d` 之后)加一步显式校验 + 热 reload:
```bash
docker exec our-chat-web nginx -t >/dev/null 2>&1 && docker exec our-chat-web nginx -s reload >/dev/null 2>&1 \
  && echo "nginx reloaded" || echo "nginx reload 跳过(配置未通过校验 / 容器刚重建已加载新配置)"
```
- `nginx -t` 先校验:坏配置就**跳过 reload**,保留运行中的旧配置,绝不因一次坏改动中断部署或让边缘挂掉。
- 幂等:容器若刚被重建(镜像变了),它已加载新配置,这次 reload 无害;容器没重建则正好把新配置热加载进去。

## 7. 经验教训

**可复用的诊断方法论(本次核心收获)**
1. **先把"报错文案"翻译成"触发条件"**:一句用户提示常对应多个失败分支(这里"需要先登录"= 铸 token 失败 ∪ 验活失败)。先列分支,再逐个证伪。
2. **用抓包/日志把范围锁到"具体哪一跳"**:`mint 200 → me 500` 一眼把范围缩到 agent 反代这一跳。
3. **判断"错误在应用层还是边缘层"的三条硬信号**:
   - 应用日志**有没有**这条错误(NestJS 会记 500;没记 = 没到应用)。
   - 响应 `content-type`:Nest 错误是 **JSON**,`text/html` 往往是 nginx/上游默认错误页。
   - **绕过边缘直连上游**复现(容器内 `localhost:3101` 直打)——能区分"应用坏"还是"代理坏"。
4. **500 vs 502 的区分**帮助定位:502=上游连不上;500 + `invalid URL prefix`=配置求值错误。

**nginx 具体坑**
- `rewrite ... break`(和 `break` 指令)会**中止当前 location 内 rewrite 模块的后续指令**,包括 `set`。**`set` 必须写在任何 `break` 之前**。
- `proxy_pass http://$变量` + `resolver` 是"惰性解析、解耦上游启动依赖"的标准手法,但**对指令顺序敏感**,变量为空即 500。
- **bind-mount 的配置改动不会被 `docker compose up` 自动加载**,需显式 `nginx -s reload`(或强制重建容器)。

**边界处理**
- 部署脚本里对 nginx reload 做了 `nginx -t` 前置校验 + 失败跳过,遵循"坏配置绝不中断边缘服务"的原则。
