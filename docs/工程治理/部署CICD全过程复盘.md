# 部署 CICD 全过程复盘：从镜像仓库到「服务器本地构建」

> 一句话：把"推代码即自动部署到国内服务器"这条链路，从反复翻车做到稳定绿。
> 本文是整个 CICD 任务的**完整全过程复盘**，合并了 `docs/debug/` 下原来两篇排障记录
> （`部署链路排障-GitHubActions与Docker镜像源`、`部署排障二-国内拉不动GHCR与Milvus…`），
> 并补齐了最终"放弃镜像仓库、改服务器本地构建"重构的全过程。
>
> 覆盖两个仓库：`our-chat`（IM：server/gateway/web）与 `agent-server`（AI 后端：node-server/worker + milvus/etcd），
> 二者同机部署、经 external 网络 `oc-shared` 互通。很多坑是共享的，故合并一处记。

---

## 0. 背景与约束：为什么"国内自动部署"这件事格外难

**拓扑**：腾讯云**国内单服务器**（ubuntu）。`our-chat` 与 `agent-server` 同机 co-host，经 external docker 网络 `oc-shared` 互通（nginx 同源反代 `/agent/` → `agent-node-server:3101`；agent 经此访问 our-chat 的 JWKS 验签）。

**触发**：push `main`（our-chat）/ `master`（agent）→ GitHub Actions → 自动部署。目标是"提交即上线、零手工"。

**核心矛盾（贯穿全文）**：**CI runner 在海外、服务器在国内，中间隔着 GFW**。凡是要跨这道墙的东西——外网镜像仓库、大镜像层、长连接——都不稳定。整条链路的演进史，本质就是"**把需要跨墙的东西一步步减到最少**"。

**术语扫盲**（后文反复出现）：
- **GFW**：国内出口网络对境外连接的干扰（DNS 污染、TLS 重置、对特定 CDN 限速/阻断）。表现常是 `i/o timeout`、`connection reset`、`TLS connection non-properly terminated`、或"连得上但 0 进度"。
- **Docker 镜像（image）**：分层（layer）只读文件系统快照的叠加。每层用内容哈希（sha256）寻址，可缓存、可复用。**镜像必须从"构建处"搬到"运行处"**——要么推到 registry 再拉，要么就在运行处本地构建。
- **registry / manifest / blob**：镜像仓库。`manifest` 是镜像清单（描述有哪些层、配置）；`blob` 是层的真实数据（通常几十~几百 MB，往往放在单独的对象存储/CDN）。**manifest 通 ≠ blob 通**——这是后面 GHCR 那个坑的关键。
- **daemon `registry-mirrors`**：Docker 守护进程级的"镜像加速源"，对 `docker pull` **仅代理 Docker Hub（`docker.io`）**，不碰 quay/gcr/ghcr。对 compose 透明、不绑定具体 mirror、不改仓库代码。
- **build context / build-arg**：`docker build` 时打包发给守护进程的那一坨源码目录叫 build context；`--build-arg` 是构建期变量（如换 npm 源、注入前端编译期 origin）。

---

## 1. 方案演进总览（四个时代）

| 时代 | 镜像怎么到服务器 | 为什么换掉 |
|---|---|---|
| ① GHCR | CI 构建推 `ghcr.io/fdahk/*`，服务器拉 | **GHCR 的 blob CDN 国内被墙**：manifest 通、层 0 进度 |
| ② Docker Hub | CI 推 `docker.io/fdahk/*`，服务器经 `registry-mirrors` 拉 | 公益镜像源对**大层/新 tag** 抖动、偶发卡死 |
| ③ 腾讯 TCR | CI 推同云 TCR，服务器同云内网拉 | **runner→国内推大镜像层**会断（`use of closed network connection`）：server 778MB/agent 1.24GB 推不过去 |
| ④ **服务器本地构建**（终局） | 不推镜像；runner 把**源码** scp 到服务器，**就地 `docker compose build`** | 跨墙的只剩 ~MB 源码；依赖走国内源、基础镜像走 daemon mirror，**全程不跨墙传大层** |

一句话主线：**①②③ 都是"想方设法把大镜像运过墙"，最后认清这条路在国内不稳，④ 干脆不运镜像、只运源码、在运行处生产镜像。**

下面按踩坑的先后，分波次记。

---

## 2. 第一波：CI 自己能不能跑（配置 / 语法）

### 坎 1：预检报「缺少 Variable」
**现象**：deploy 的预检步骤 `❌ 缺少 Variable：WEB_PUBLIC_ORIGIN / OAUTH_ACTIVE_KID / S3_*`。

**根因**：这些值用 `${{ vars.X }}`（GitHub Actions **Variables**）读，但 environment『pro』只配了 **Secrets**。GitHub 把 Secrets 和 Variables 分成两个独立页，`vars.*` 读不到 Secrets 页的值。

**修复 + 决策**：**不维护两套来源——全部统一放 Secrets**，workflow 不再用 `vars`。所有 `${{ vars.X }}` → `${{ secrets.X }}`，预检合并为单一 Secrets 校验。代价：`POSTGRES_USER/DB` 这种非机密放进 Secrets 后 CI 日志会被打码，功能无影响。

### 坎 2：`Invalid workflow file` —— `secrets` 不能用于 matrix
**现象**：改完坎 1 后 workflow 直接解析失败：`Unrecognized named-value: 'secrets'`，位置在 `strategy.matrix.include`。

**根因**：`secrets` 上下文**在 `strategy.matrix` 中不可用**（matrix 在 job 装配早期求值）。之前用 `vars.*` 恰好能进 matrix，所以没报错；一换 `secrets` 就炸。

> 速记：`secrets` 可用于 job/step 的 `if`/`env`/`with`/`run`，但**不可用于** `strategy.matrix`、`concurrency`、`runs-on` 等装配早期字段。拿不准就放 step 的 `with`/`env`。

**修复**：把 build-arg 移出 matrix，放到构建 step 的 `with.build-args`，按 `matrix.name` 条件注入：
```yaml
build-args: ${{ matrix.name == 'web' && format('VITE_SERVER_ORIGIN={0}', secrets.WEB_PUBLIC_ORIGIN) || '' }}
```
（这套写法在 ④ 时代被整体删掉了——本地构建不再有 build job。但教训仍通用。）

---

## 3. 第二波：基础镜像能不能拉（服务器网络层）

### 坎 3：服务器拉不到 Docker Hub 基础镜像（i/o timeout）
**现象**：SSH 拉取步骤里 GHCR 应用镜像在拉，但 `postgres:16-alpine`/`redis:7-alpine` 走 `registry-1.docker.io` **超时**。

**根因**：国内服务器直连 Docker Hub 受阻。这是**服务器网络层**问题，改 workflow 没用。

**修复**：给服务器 Docker daemon 配镜像加速源（一次性、对 compose 透明）：
```jsonc
// /etc/docker/daemon.json（若已有文件，只合并 registry-mirrors，勿整体覆盖）
{ "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1ms.run", "https://dockerproxy.com"] }
```
`systemctl daemon-reload && systemctl restart docker`（会短暂重启机上所有容器）。镜像源会偶发失效，配多个备选，`docker pull` 自动顺延。

### 坎 3b：etcd 拉不到 —— `registry-mirrors` 只管 Docker Hub
**现象**：agent 部署卡在 `quay.io/coreos/etcd:v3.5.18` i/o timeout。

**根因**：**`registry-mirrors` 是 Docker 的硬规则——只对 `docker.io` 生效，不代理 `quay.io`/`gcr.io`/`ghcr.io`**。etcd 来自 quay.io，完全没走加速、直连被墙。

**修复**：换 daocloud 的 quay 代理：
```yaml
image: ${ETCD_IMAGE:-quay.m.daocloud.io/coreos/etcd:v3.5.18}
```
> 记住：`registry-mirrors` ≠ 万能加速，只管 Docker Hub。quay/gcr/ghcr 要各自找代理或换源。

---

## 4. 第三波：应用镜像能不能拉回国内（**核心根因：GHCR blob 被墙**）

这一波是 ①GHCR 时代反复失败的真正主因，前面几条某种意义上都是被它的表象带偏的。

### 4.1 先扫平的两个次要坑

**agent 镜像构建失败（prisma + 多阶段构建）**：运行镜像曾用 `pnpm install --prod`（跳过 devDependencies → 缺 prisma CLI），且只 `COPY dist`（没拷 `prisma/`）→ 启动时 `prisma migrate deploy` 无从执行。又有顺序坑：`pnpm install` 的 `postinstall`(=`prisma generate`) 需要 schema 先就位，但 `COPY . .` 在 install 之后 → generate 找不到 schema。**修法**：install 前先 `COPY prisma ./prisma`；runtime 复用 builder 的全量 `node_modules` + 拷 `prisma/` + 装 `openssl`。（详见 agent-server 仓库对应 debug 文档。只影响 agent。）

**部署超时**：`appleboy/ssh-action` 的 `command_timeout` 默认 **10m**，milvus standalone 镜像约 1.5G，10 分钟拉不完被杀。**修法**：放宽 `command_timeout` + 在服务器一次性预拉 milvus 进缓存。

**`compose pull` 卡死/快失败**：`docker compose pull` 会对编排里**所有**镜像（**含已缓存的基础镜像**）去镜像源做 manifest 复检；第三方源一抖动，要么任意一个失败带崩整次 pull，要么挂起到超时（`--ignore-pull-failures` 只容忍"失败"不救"挂起"）。**修法**：不做整体 pull，改 `up -d --pull missing`——**只拉本地没有的镜像**，已缓存基础镜像根本不碰镜像源。

### 4.2 核心根因：GHCR 的 blob 在国内被墙
**现象**：部署在"生成 .env"后快速失败、无拉取输出。隔离测试 `docker pull ghcr.io/fdahk/agent-server-node:<sha>`：manifest 拿得到（打印 `Pulling from…`），但所有层卡在 `Pulling fs layer`，**105 秒 0 字节、0 层完成**；同时 `curl https://ghcr.io/v2/` 0.09s 就 401（API 端点是通的）。

**根因**：**GHCR 的 registry API 和镜像层 blob 是分开托管的**——`ghcr.io`（API/manifest）国内可达，但层数据走 GitHub 的 **blob CDN，这个 CDN 在国内被墙/极慢**。即：runner 在海外构建并推 GHCR 没问题，但**国内服务器从 GHCR 拉回来**这步被卡死。两套部署都挂在这同一根线上。（daocloud 的 GHCR 代理 `ghcr.m.daocloud.io` 对该镜像返回 403，也走不通。）

**旁证**：老项目 `paaawow`（同在国内腾讯云）应用镜像名是 `paaawow_backend-backend`（无 registry 前缀）——这是 `docker compose build` **服务器本地构建**的签名，源码来自 **Gitee**（国内 git），从不从 GHCR 拉，自然没这问题。这其实已经预示了终局方案 ④。

**方案对比（当时选 ② Docker Hub）**：

| 方案 | 做法 | 取舍 |
|---|---|---|
| **② Docker Hub + 现成镜像源**（当时采用） | CI 推 `docker.io/fdahk/*`，服务器经 `registry-mirrors` 拉 | 改动最小、复用已稳路径、实测拉通；镜像须 public、有限速 |
| ① 腾讯 TCR 内网 | CI 推 TCR，同云内网拉 | 最快、无限速；要开通+凭据 |
| ④ 服务器本地 build | 源码进 Gitee/服务器 `git pull` + 本地 build | 老项目证明可行；回退到"服务器构建" |
| ⑤ 给 docker 配境外代理拉 GHCR | daemon HTTP proxy | 要养境外机、把稳定性绑代理上，不推荐 |

选 ② 的关键证据：`milvusdb/milvus`（1.5G）和 `traefik/whoami` 都经该机 daocloud 镜像源拉通 → 说明镜像源代理任意 `<命名空间>/<镜像>`，自建的 `fdahk/*` 走同一条路。

---

## 5. 第四波：容器终于起来后的"最后一公里"

镜像拉下来、容器建起来，才暴露这些运行期坑。

### 坎 5：milvus 连不上 COS —— 端口 `:9000` vs `:443`
**现象**：`Head "https://oc-milvus-….cos.ap-guangzhou.myqcloud.com:9000/": dial tcp …:9000: i/o timeout`，连带 datacoord/datanode 起不来、milvus unhealthy。

**根因（讲透）**：
- **MinIO** 是开源自托管对象存储，S3 API **默认端口 9000**。milvus standalone 的"标准"部署自带一个 minio 容器（监听 9000），所以 **milvus 的对象存储客户端默认就按"连 9000 上的 MinIO"配**（`minio.port` 默认 `9000`）。
- **腾讯 COS** 是云对象存储，走标准 HTTPS、端口 `443`，没有 9000。
- 我们用 COS 顶替自托管 MinIO。`MILVUS_COS_ENDPOINT` 只给了主机名、没给端口 → milvus 不覆盖默认 `9000` → 实际去连 `<bucket>.cos…:9000` → 超时。
- 一个看似能救场其实不行的点：`MINIO_USE_SSL=true` **只决定用不用 TLS，不会把端口推导成 443**。

**修复**：endpoint 必须带端口：`MILVUS_COS_ENDPOINT = cos.ap-guangzhou.myqcloud.com:443`。这是"面向自托管 MinIO 的客户端"接"云对象存储（COS/OSS/S3）"的**通用坑**——端口要手动对齐到云服务的 443。

> ⚠️ 这是 **GitHub Secret 里的值**（agent environment pro）。服务器 `.env` 每次按 Secret 重写，不带 `:443` 下次部署又退回 9000。

### 坎 6：node-server 被判 unhealthy —— 健康检查打错路径
**现象**：日志 `Nest application successfully started`，但容器 `unhealthy`；worker `depends_on 健康` → 永远不启动。

**根因**：健康检查打 `http://localhost:3101/api`，应用没有裸 `/api` 路由 → 404；`wget` 遇 4xx **默认退出码非 0** → 判失败。

**修复**：打真正返回 200 的端点 `wget -qO- http://localhost:3101/api/health || exit 1`。
> 教训：健康检查 URL 必须命中 2xx 端点；`wget`/`curl` 对 4xx 默认算失败。

### 坎 7：our-chat-server 崩溃重启 —— 私钥**文件**权限 + 容器非 root 用户
**现象**：`EACCES: permission denied, open '/app/keys/oauth-private-prod.pem'`，`restart: unless-stopped` 无限重启。

**根因**：部署脚本把 OAuth 私钥写盘后 `chmod 600`（仅属主 `ubuntu` uid 1000 可读），但 **server 容器以非 root 用户 `app`（`USER app`，uid≠1000）运行**，`:ro` 挂进容器后 `app` 既非属主也无 other 读权限 → EACCES。

**修复**：`chmod 644 keys/oauth-private-prod.pem`（others 可读）。单租户 + `:ro` 可接受。
> 取舍：更"安全"是按容器 uid chown，但容器 `app` 的 uid 对宿主不确定、镜像可能变，跨 uid 最稳就是 644。**记住这个主题——它在第六波又以"目录版"复发了（坎 C）。**

---

## 6. 第五波：Docker Hub 也不稳 → 迁腾讯 TCR → TCR 也推不动大镜像

②Docker Hub 用着用着发现：公益镜像源对**大层 / 每次新 sha 的新 tag**（对 daocloud 是 cache-miss，要现回源 Docker Hub）反复抖动，"刚推完立即部署"常因源没缓存新 tag 而失败，要重试。于是为弱网加了**重试续传**的拉取循环（`until docker compose pull; do sleep; done`，docker 失败重试会续传已下层），并迁到 **③腾讯 TCR**（同云广州，服务器同云内网拉又快又稳）。

但 TCR 暴露了**反方向**的墙：
- **构建缓存推 TCR 失败**：曾用 registry 构建缓存 `cache-to=type=registry,mode=max`（把全部中间层推 TCR 复用）。runner 在海外、TCR 在国内，这是**海外→国内的大上传**，实测 **1h+ 仍 `use of closed network connection`**。回退为 `type=gha`（runner 内部缓存，快；7 天过期会偶尔重建依赖层，但同云拉取快，可接受）。
- **大应用镜像 push 直接断**：用 `docker manifest inspect` 核对，gateway(31MB)/web(76MB) 推上去了，但 **server(778MB)/agent(1.24GB) 没推上去**——runner→国内上传大层时连接被掐断。

**结论（关键认知）**：**跨 GFW 传大镜像，两个方向都不稳**——拉（GHCR blob 被墙、Docker Hub 源抖）、推（runner→国内 TCR 大层断）。继续在"把大镜像运过墙"上打转是死路。

---

## 7. 第六波（终局）：服务器本地构建 build-on-server

**决策**：镜像在**运行处**生产，跨墙的只留**源码（~MB）**。这正是老项目 paaawow 一直在做的，也是国内务实做法（虽是"CI build + registry"业界标准的反模式，但被 GFW 逼出来的合理取舍）。

**做法**：
- compose 三/一个应用服务 `image:` → `build:`（本地构建，tag `*:local`）；基础镜像仍走 daemon `registry-mirrors` 拉并缓存。
- 构建期依赖走国内源（compose build-arg 注入）：node 用 `NPM_REGISTRY=https://registry.npmmirror.com`，go 用 `GOPROXY_URL=https://goproxy.cn,direct`。
- web 的编译期 origin（`VITE_SERVER_ORIGIN`/`VITE_AGENT_API_BASE`）由 `WEB_PUBLIC_ORIGIN` 派生，部署脚本 `export` 后注入 build。
- 删掉两个 workflow 的整个 build job 与所有 registry 登录/拉取逻辑。

然后接连踩了三个坑（A→B→C），才真正绿。

### 坑 A：服务器 `git clone` github 被 GFW 重置
第一版让**服务器自己 git clone github** 取源码。结果：
```
Cloning into 'repo'...
fatal: unable to access 'https://github.com/fdahk/our-chat.git/':
  GnuTLS recv error (-110): The TLS connection was non-properly terminated.
```
两个仓库都中招。国内服务器 clone github 的 git-over-HTTPS 被 GFW 重置（之前只验过 HTTP 200 可达，没验真正的 git 克隆——疏忽）。

**修复**：**不在服务器 clone**。runner 在 GitHub 内网，`actions/checkout` 极快；改由 runner checkout 后，用 `appleboy/scp-action` 把**构建上下文**（our-chat: `server,gateway,web,docker`；agent: `apps/node-server,docker`，仅 ~MB 文本源码、无 node_modules/dist）经**已打通的 SSH 通道** scp 到 `${DEPLOY_PATH}`。彻底去掉"国内访问 github"的依赖。
> 为什么 scp 这条能行、而前面推镜像不行：scp 的是 ~MB 小源码，走的是部署本来就在用的 SSH 通道；此前失败的是**几百 MB 的镜像层**，量级差两个数量级。

### 坑 B：runner→服务器 SSH 会话扛不住长构建（最隐蔽）
scp 通了，部署却又**第 8 秒 `exit 1`、且无任何脚本输出**。诡异：脚本明明已跑到生成 `.env`（时间戳为证）。

SSH 上去排查发现关键事实：**GitHub 报失败 9 分钟后，那个 drone-ssh 部署进程还在服务器上跑 `docker compose build`**，镜像也在陆续构建出来。

**根因**：**runner（海外）→服务器（国内）的单条 SSH 会话扛不住几分钟的长构建**——构建在拉基础镜像时控制通道**静默无流量**，GFW 约 8 秒就把这条连接重置；GitHub 那头判 step 失败，但**远端 build 脱了缰、变成孤儿继续在服务器跑完**（这就是"镜像莫名出现"的来由）。本地构建本身没问题，**问题是把多分钟长任务挂在一条跨墙长连接上**。

**修复（核心）**：把 build+up **脱离 SSH 会话**后台跑 + **轮询结果**：
- 服务器侧逻辑收进**提交进仓库**的 `docker/ci-deploy.sh`（生成 `.env`/私钥 → 后台 build+up → 轮询）+ `docker/deploy-build.sh`（实际 `compose build --progress plain && up && prune`）。
- `ci-deploy.sh` 用 `setsid` 把 `deploy-build.sh` **脱离会话**后台执行（`setsid bash -c 'bash deploy-build.sh >deploy.log 2>&1; echo $? >deploy.rc' </dev/null &`）——**SSH 断了 build 也跑完**，结果码落 `deploy.rc`。
- 主会话进入**轮询循环**：每 10s 检查 `deploy.rc`、并 `tail deploy.log`。这个周期性输出**给 SSH 通道喂流量、防止空闲被 GFW 重置**，同时把构建日志实时回显（可观测）。即便会话仍被重置，build 也不丢（只是这步显示失败）。
- ssh-action **只调一条 `bash ci-deploy.sh`**：避开 `drone-ssh` 在 `script_stop:true` 下**逐行包裹** `DRONE_SSH_PREV_COMMAND_EXIT_CODE` 的行为破坏脚本里的 heredoc/循环等复合结构（这也是之前"无输出"难定位的帮凶）。
- `--progress plain` 让 BuildKit 输出逐行可读（非 TTY 下也不丢日志）。

> 可观测性教训：`drone-ssh` 会吞掉远端复杂脚本的输出，"8s exit 1 无输出"极难定位。让失败可见（日志落盘 `deploy.log` + plain progress + 必要时直接 SSH 读日志）比猜测高效得多。

### 坑 C：keys **目录**权限 700 —— 私钥权限坑的"目录版"复发
build+up 终于 `rc=0`、web/gateway healthy，但 `our-chat-server` 又崩溃重启，还是 `EACCES … oauth-private-prod.pem`。

**根因**：坎 7 修的是私钥**文件**（644）。这次是**目录**：`keys/` 在受限 umask 下被 `mkdir` 成 `700`（`drwx------`），容器内 `app`（uid 10001）属于 "other"、对目录无 `x` → **穿不过目录去 open 里面的文件**，即便文件本身 644 也 EACCES。
> 为什么"50 分钟前还好"：那时跑的是更早的镜像/配置；新的本地构建镜像确定以 `USER app` 跑，才稳定触发目录穿越问题。

**修复**：`ci-deploy.sh` 里显式 `chmod 755 keys`（目录 o+x 可穿越；文件仍 644）。单租户 + `:ro` 可接受。
> 主题归纳：**容器以非 root uid 运行时，挂进去的密钥要同时满足"文件可读 + 各级目录可穿越"**。文件 644、目录 755（或 711）。这个坑前后踩了两次（文件→目录）。

---

## 8. 最终架构（现状，已验证稳定绿）

```
push main/master
  └─ GitHub Actions(runner, 海外)
       ├─ actions/checkout                      # 在 GitHub 内网取源码，快
       ├─ 预检必填 Secrets(environment: pro)
       ├─ scp 构建上下文 → 服务器 ${DEPLOY_PATH}  # 仅 ~MB 文本源码，走 SSH 通道
       └─ ssh → cd ${DEPLOY_PATH}/docker && bash ci-deploy.sh
            ├─ 生成 .env / OAuth 私钥 / chmod 755 keys / 建 oc-shared 网络
            ├─ setsid 脱离会话后台跑 deploy-build.sh：
            │     docker compose build --progress plain      # 本地构建，依赖走国内源、基础镜像走 daemon mirror
            │     docker compose up -d --remove-orphans       # 滚动重启；server 启动自动 prisma migrate deploy
            │     docker image prune -f
            └─ 主会话轮询 deploy.rc + tail deploy.log(每 10s, 喂通道防重置)
```

- **不再依赖任何镜像仓库**（GHCR/Docker Hub/TCR 全部弃用；TCR 实例可删停按量计费）。
- **跨墙的只剩 ~MB 源码**；依赖 npmmirror/goproxy、基础镜像 daemon mirror，全程不传大层。
- **配置分层**：① 通用非机密 → compose `${VAR:-默认}`；②机密 + ③因环境而异 → GitHub Secrets（environment `pro`），CI 部署时在服务器生成 `.env`+私钥，服务器零手工维护。

**验证**：https://tujiang.tech → HTTP 200（HTTPS 正常）；our-chat web/server/gateway 与 agent node-server/worker 全 healthy；两仓部署 `rc=0`，全自动、弱网可扛。

---

## 9. 贯穿全程的几条主线（提炼）

1. **跨 GFW 的东西越少越好**：从"传大镜像（两个方向都不稳）"一路退到"传 ~MB 源码"。这是整条演进的灵魂。
2. **弱网长任务别挂在一条长连接上**：长 build 必须脱离 SSH 会话（`setsid`）后台跑 + 轮询；周期性输出喂通道防空闲重置。
3. **权限坑踩了两次（文件→目录）**：容器非 root uid 时，密钥要"文件 644 + 目录 755"，缺一不可。
4. **`rc=0` ≠ 服务健康**：`up` 返回 0 只代表容器建起来了；真健康要看容器 healthcheck / `docker logs`。健康检查要打 2xx 端点。
5. **`registry-mirrors` 只代理 Docker Hub**：quay/gcr/ghcr 各自找代理。
6. **manifest 通 ≠ blob 通**：GHCR API 可达但层 CDN 被墙——分开看。
7. **可观测性是排障地基**：`drone-ssh` 吞输出、`compose build` 默认 TTY 进度——要主动让失败可见（plain progress、日志落盘、直接读日志）。

---

## 10. 排查方法论速记 + 人工维护清单

**看 CI 哪一步红来定位**：
- 预检红 → 配置缺失（Secrets/environment）。
- 整个 workflow 不跑 → 语法/上下文可用域（`secrets` 不能进 matrix）。
- build 红 → Dockerfile/构建上下文。
- deploy(ssh) 红 → 服务器/网络/镜像；**先分清是"拉/推不动（网络）"还是"跑不起来（运行期）"**。
- **跨墙连接的典型信号**：`i/o timeout` / `connection reset` / `GnuTLS recv error -110` / "连得上但 0 进度" / "8s 无输出就 exit"——都往 GFW + 长连接/大流量上想。
- 容器起来但 unhealthy/重启 → `docker logs <容器>`，区分"依赖连不上(COS/DB)"、"健康检查路径错"、"权限 EACCES（文件 or 目录）"。

**需人工维护的（服务器零手工的例外，配在各自 environment `pro` 的 Secrets）**：
- SSH 接入：`SSH_HOST`/`SSH_USER`/`SSH_PRIVATE_KEY`（`SSH_PORT`/`DEPLOY_PATH` 不配走默认）。
- our-chat：`POSTGRES_PASSWORD`/`JWT_SECRET`/`GATEWAY_INTERNAL_TOKEN`/`OAUTH_PRIVATE_KEY_B64`/`OAUTH_ACTIVE_KID`/`WEB_PUBLIC_ORIGIN`/`S3_*`（`POSTGRES_USER`/`DB` 可选）。
- agent-server：`POSTGRES_PASSWORD`/`JWT_SECRET`/`LLM_API_KEY`/`OAUTH_ISSUER`/`MILVUS_COS_*`（**`MILVUS_COS_ENDPOINT` 务必带 `:443`**）。
- 已**不再需要**任何 registry 凭据（`TCR_*`/`DOCKERHUB_*` 全废）。

> 服务器 `.env`、私钥都由 CI 每次部署按 Secret 重新生成 → **改这些值改 Secret，不要手改服务器**（手改下次部署会被覆盖）。一次性的服务器配置只有 daemon `registry-mirrors`（不进 workflow，避免每次重启 docker + 依赖 sudo）。
