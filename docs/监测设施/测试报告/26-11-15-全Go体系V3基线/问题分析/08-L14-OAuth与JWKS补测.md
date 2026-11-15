# L14 补测：OAuth / OIDC 发现 / JWKS

> 严重度：**通过**（无性能问题），但发现 3 处配置/边界风险
> 状态：**已补测，链路 L14 关闭**
> 关联：报告 §七、分册 `06-未覆盖链路清单.md`

## 一、结论

| 项 | 结果 |
|---|---|
| 功能正确性 | ✅ 通过（字段自洽、公钥与私钥配对、缓存头正确） |
| 性能 | ✅ 充裕（约 **1.1 万 rps**，p99 3–4 ms，与 `/health` 同档） |
| 可用性 | ✅ 100% 200，无错误 |
| 跨仓契约 | ✅ 下游 `our-chat-biz:3007` 可解析 |
| 遗留风险 | ⚠️ 3 条：轮转窗口、无速率限制、下游 `iss` 校验可被静默跳过 |

**判定：L14 不是瓶颈，可以关闭。** 但三条风险都与"密钥轮转 / 生产配置"有关，属于**上线前必须确认**的项，不是性能问题。

## 二、被测端点

`biz/internal/oauth/handlers.go:35`：

```
GET  /.well-known/openid-configuration   Cache-Control: public, max-age=3600
GET  /.well-known/jwks.json              Cache-Control: public, max-age=600
GET  /oauth/authorize                    （交互式，不压）
POST /oauth/token · /revoke · /introspect
GET  /oauth/userinfo
POST /oauth/agent-token                  （需鉴权）
```

本轮只覆盖 L14 定义的两个公开端点。

## 三、功能正确性

### 3.1 发现文档字段自洽

| 字段 | 实测值 | 判定 |
|---|---|---|
| `issuer` | `http://localhost:3007` | ✅ 与各 endpoint 前缀一致（**生产必须改为 https 域名，见风险 3**） |
| `authorization_endpoint` | `<issuer>/oauth/authorize` | ✅ |
| `token_endpoint` | `<issuer>/oauth/token` | ✅ |
| `jwks_uri` | `<issuer>/.well-known/jwks.json` | ✅ 指向本服务，可解析 |
| `id_token_signing_alg_values_supported` | `["RS256"]` | ✅ 与 JWKS 的 `alg` 一致 |
| `code_challenge_methods_supported` | `["S256"]` | ✅ 强制 PKCE |
| `response_types_supported` | `["code"]` | ✅ 无隐式流（good） |
| `scopes_supported` | `openid, profile, email, agent-server` | ✅ 含跨仓 scope |
| `token_endpoint_auth_methods_supported` | `client_secret_basic, none` | ✅ 支持公共客户端 |

### 3.2 JWKS 与签名私钥配对（关键）

用 `keys/oauth-private-dev.pem` 推导公钥模数，与 JWKS 的 `n` 逐字节比对：

```
私钥模长        : 2048 bit
JWKS n 模长     : 2048 bit
n 与私钥公钥一致 : True
kid / alg / use : dev / RS256 / sig
e               : AQAB (=65537)
```

**逐字节一致** —— 说明下游拿这份 JWKS 能正确验签，不存在"公钥贴错"这类最致命的问题。

### 3.3 缓存头

| 端点 | Cache-Control | 评价 |
|---|---|---|
| discovery | `public, max-age=3600` | 合理（配置变更不频繁） |
| jwks | `public, max-age=600` | 合理，但**正是轮转窗口风险的来源**（见风险 1） |

## 四、性能

方法与 `http_bench` 完全一致（并发 20 × 10 s，直连 biz :3007）：

| 端点 | rps | p50 | p95 | p99 | 状态 |
|---|---|---|---|---|---|
| `GET /.well-known/openid-configuration` | **10,968** | 2 ms | 2 ms | **3 ms** | 100% 200（109,722 次） |
| `GET /.well-known/jwks.json` | **11,000** | 2 ms | 3 ms | **4 ms** | 100% 200（110,018 次） |

**对照同轮其它端点**：`/health` 10,857 rps（p99 4 ms）、`/user/sync` 3,196 rps、`/user/messages` **7 rps**。

两个 OAuth 端点与 `/health` 完全同档，说明它们是**纯内存返回**——这不是巧合，见 §5.2。

## 五、发现

### 5.1 端点无鉴权且无限流（可接受，但需依赖外层）

- 路由器只对 `/api/login`、`/api/register` 挂了限流（`router.go:49-51`），`/.well-known/*` 与 `/oauth/*` **都不限流**；
- 公开端点本就不该鉴权，且响应是静态字节（约 1 KB），单请求成本极低；
- 但**`/oauth/token` 也不限流**，这是相邻的真实风险：它可以被用来爆破 `client_secret` 或刷 token。

**建议**：`/oauth/token`、`/oauth/introspect` 加独立限流；公开端点靠 nginx `proxy_cache` + `Cache-Control` 吸收流量即可。

### 5.2 响应在挂载时预序列化（性能好，但轮转必须重启）

`handlers.go`：

```go
func makeJwksHandler(env *HandlerEnv) gin.HandlerFunc {
    serialized, _ := json.Marshal(BuildJwksResponse(env.Store))   // ← 只执行一次
    return func(c *gin.Context) {
        c.Data(http.StatusOK, "application/json", serialized)      // ← 每次只写字节
    }
}
```

- **好处**：解释了 1.1 万 rps 的来源，也意味着 JWKS 端点**不会随负载劣化**；
- **代价**：密钥轮转必须**重启进程**才生效（`LoadKeyStore` 也在启动时执行）。

这对当前部署形态（单实例、轮转靠重启）是自洽的，但要写进运维手册。

### 5.3 风险 1：轮转窗口内的验签失败

`BuildJwksResponse` 会遍历 `store.All`（含 `OAUTH_RETIRED_KIDS`），这是正确设计——轮转后新旧 kid **同时发布**，旧 token 仍可验签。

但下游有缓存：

```
T0    下游拉 JWKS（只有 kid=dev），缓存 600 s
T1    服务端轮转：active=dev2，dev→retired，重启
T2    服务端用 dev2 签发新 token
T3    下游仍在用 T0 的缓存 → 找不到 kid=dev2 → 验签失败（最多 600 s）
```

**这不是本服务的 bug，是 JWT 轮转的通用问题**，但必须提前定策略，三选一：

| 策略 | 做法 | 代价 |
|---|---|---|
| A. 提前发布（推荐） | 先把 dev2 加入 `OAUTH_RETIRED_KIDS` 却不切换 active，等 ≥ 600 s 后再切 | 需要两次发布 |
| B. 下游遇到未知 kid 时强制刷新 | 改 agent-server 的 JWKS 缓存逻辑 | 改下游代码 |
| C. 接受短暂失败 | 轮转选低峰期 | 有窗口期 401 |

### 5.4 风险 2：`issuer` 必须是生产值

开发环境 `issuer = http://localhost:3007`。轮转/上线时若 `OAUTH_ISSUER_BASE_URL` 没改成 `https://<域名>`：

- 发现文档里的所有 endpoint 都会是 `http://localhost:3007/...`；
- 签发的 token `iss` 也随之错误；
- **下游 `iss` 校验失败 → 全部鉴权 401**，但聊天功能正常，故障面很隐蔽。

`docker/docker-compose.prod.yml:11` 注明该值由 `WEB_PUBLIC_ORIGIN` 派生——**上线检查清单里必须有一项：`curl https://<域名>/.well-known/openid-configuration` 确认 issuer 是 https 域名。**

### 5.5 风险 3（跨仓）：下游 `iss` 校验可被静默跳过

`agent-server` 侧：

```python
# packages/agent-core/src/agent_core/auth.py:60-65, 106
issuer: str = ""
self._issuer = issuer or None
...
jwt.decode(..., issuer=self._issuer)     # None 时 PyJWT 跳过 iss 校验
```

**`OAUTH_ISSUER` 环境变量没配时，`iss` 校验被静默禁用**——不报错、不告警，任何 issuer 的 RS256 token 都会被接受（只要签名能在 JWKS 里找到对应 kid）。

叠加此前审计发现的 HS256 兜底（`dev-secret` 默认值），构成一条完整的绕过链。

**建议**：agent-server 启动时若 `OAUTH_ISSUER` 为空且需要 RS256 验签，应 **fail-fast 拒绝启动**，而不是降级为不校验。

## 六、跨仓契约核对

| 项 | talqora 侧 | agent-server 侧 | 一致？ |
|---|---|---|---|
| JWKS 地址 | `http://<host>:3007/.well-known/jwks.json` | 默认 `http://our-chat-biz:3007/.well-known/jwks.json` | ✅（`biz` 的 `container_name: our-chat-biz`，见 `docker-compose.prod.yml:59`） |
| 签名算法 | RS256 | RS256 优先，HS256 兜底 | ⚠️ 兜底见 5.5 |
| kid | `dev`（生产由 `OAUTH_ACTIVE_KID` 指定） | 从 JWKS 按 `kid` 匹配 | ✅ |
| issuer | 由 `WEB_PUBLIC_ORIGIN` 派生 | `OAUTH_ISSUER`，空则跳过校验 | ⚠️ 两侧都容易配错 |

## 七、改进清单

| 优先级 | 项 | 位置 |
|---|---|---|
| P1 | `OAUTH_ISSUER` 为空时 fail-fast（禁止静默跳过 iss 校验） | agent-server `auth.py` |
| P1 | 上线检查清单加"issuer 必须是 https 域名"一项 | 部署文档 |
| P2 | `/oauth/token`、`/oauth/introspect` 加限流 | `biz/internal/api/router.go` |
| P2 | 密钥轮转流程定为"提前发布公钥 → 等 600 s → 切 active" | 运维手册 |
| P3 | `/oauth/token` 类端点纳入下一轮压测 | `perf/http-bench.mjs` |

## 八、验证方法（改完后怎么复核）

1. **issuer**：`curl -s https://<域名>/.well-known/openid-configuration | jq -r .issuer` 应为 `https://<域名>`；
2. **JWKS 配对**：用本文档 §3.2 的脚本比对 `n`（应输出 `True`）；
3. **轮转**：按策略 A 演练一次，观察下游在切换期间是否出现 401；
4. **限流**：对 `/oauth/token` 施加 100 rps，确认触发 429 而非打满 CPU。

## 九、复现命令

```bash
# 功能
curl -s http://127.0.0.1:3007/.well-known/openid-configuration | python3 -m json.tool | head -20
curl -s http://127.0.0.1:3007/.well-known/jwks.json | python3 -m json.tool

# 公钥与私钥配对
python3 - <<'EOF'
import json, subprocess, base64
jw = json.load(open('/tmp/jwks.json'))['keys'][0]
hexmod = subprocess.run(['openssl','rsa','-in','keys/oauth-private-dev.pem','-noout','-modulus'],
                        capture_output=True, text=True).stdout.strip().split('=')[1]
print(base64.urlsafe_b64encode(bytes.fromhex(hexmod)).decode().rstrip('=') == jw['n'])
EOF

# 性能（本轮固化进 http-bench，下一轮可直接跑）
cd perf && ONLY="well-known" OUT_NAME=http_oauth_bench OUT_SUBDIR=<日期> node http-bench.mjs 20 10
```

## 十、对覆盖矩阵的影响

L14 从 ⛔ 未覆盖 → **✅ 已覆盖**（性能）**+ ⚠️ 3 条配置风险**（功能）。

同时本轮把这两个端点**固化进了 `perf/http-bench.mjs`**（`ONLY` 过滤 + `OUT_NAME` 改名），并按分册 06 的建议加了 `/user/messages?limit=50` 一档——下轮无需再手工补测。
