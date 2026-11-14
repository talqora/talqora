# biz — our-chat 业务层(Go)

模块化单体、多副本无状态、客户端协议零改动。**这是唯一的业务层实现**（Node + Socket.io 版已于 2026-09 下线并删除）。

实时链路：客户端 → **gateway(Go)** `/ws` → gRPC 双向流（`ourchat.edge.v1.Realtime/Stream`，userId 哈希分片）→ **biz** → PG/Redis/MinIO；下行优先经 gRPC 流定向投递，失败回退 Redis `gw:downlink` 由网关代投。

## 快速开始

```bash
# 前置:PG/Redis/MinIO(colima) + gateway(:8090, GATEWAY_UPSTREAM=grpc)
cd biz
go build -o bin/biz ./cmd/biz
./scripts/dev.sh            # env 以 docker/.env.debug 为基础(端口默认 3007, gRPC 默认 127.0.0.1:3008)
```

**在仓库根用 `make dev` 更省事**：一条命令起中间件 + biz + gateway + web。

双副本本地跑（验证租约/路由/幂等这类多副本行为时用）：

```bash
./scripts/dev.sh 3009 127.0.0.1:30081   # 备用端口;或 EDGE_GRPC_ENABLED=false 只起 HTTP
```

## 关键 env(全集见 internal/config;.env.debug 缺失键已补齐)

| 键 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3007 | HTTP 监听 |
| `EDGE_GRPC_ADDR` / `EDGE_GRPC_ENABLED` | `127.0.0.1:3008` / true | gRPC 流服务 |
| `JWT_SECRET` | 必填 | 与 gateway 共享，缺失 fail-fast |
| `AUTH_RATE_LIMIT_MAX` / `_WINDOW_MS` | 10 / 900000 | 压测放开:1000000/60000（与三期 runbook 一致） |
| `TURN_SECRET/HOST/STUN_PORT/TLS_PORT/TTL_SEC` | 空/空/3478/5349/86400 | 空 secret 降级空 iceServers |
| `OAUTH_*` | 见 .env.debug | `OAUTH_ACTIVE_KID` 缺失 fail-fast |

## 发号(V3:Redis INCR)

- 键 `conv:seq:{convId}`；首次 GET 缺失 → 从 PG `conversations.next_seq` 装载 → Lua 原子 `GET or SET + INCR`；Redis 失联降级回 DB 行锁（`UPDATE ... RETURNING`）。
- 幂等：Redis `msg:idem:{conv}:{sender}:{cmid}` SET NX EX 300s 前置缓存 + DB `uniq_msg_idem` 唯一约束兜底；去重命中不重复扇出。
- checkpoint：每 60s 把近期发号位点 `GREATEST` 写回 PG；优雅关闭终检。

## 通话忙线裁决

`tryCreateSession` 用 Lua 原子裁决：`GET call:user:{callee} ≠ callId → 拒绝；否则 SET 会话 + 双索引`。并发单测验证恰好一人成功。

## 迁移(golang-migrate)

- `migrations/` 是**唯一**迁移来源，embed 进二进制，启动时自动 apply。
- 历史衔接：若库仍带 `_prisma_migrations`（早期 Node 版跑过）而 golang-migrate 尚未接管，自动 `force 6` 到存量末尾再增量 up；全新库从头重放。这段逻辑只为兼容存量库，新环境不会命中。
- 代码侧迁移只走 `migrations/NNNN_<name>.{up,down}.sql`，不要再引入第二套迁移工具。

> 代码注释里出现的 `server/src/...`（如「对齐 message.ts:28-92」）是移植期的对照记录，
> 该目录已随 Node 业务层下线删除，**不要再去找这些文件**；行为以本目录代码与 `migrations/` 为准。

## 技术底座(偏离点见报告)

gin / pgx-v5 + 手写 SQL / golang-migrate / go-redis-v9 / golang-jwt-v5(会话 HS256) /
**go-jose v4**（OAuth JOSE；jwx v4 全版本依赖 Go1.26 实验包 encoding/json/v2，默认工具链无法构建）/
bcrypt cost 12 / grpc-go（buf 生成 `internal/contracts/gen`）/ minio-go-v7 +
**aws-sdk-go-v2**（分片会话；minio-go v7 已私有化手控 multipart API）/
prometheus client_golang / slog JSON / stdlib testing + testify。

## 测试

```bash
go test ./...   # 单测:发号并发/忙线原子性/JWT/PKCE/令牌往返/限流/TURN
go vet ./...
```

集成与压测：复用 `perf/` 工具链（客户端零改动），冒烟 = `gw-probe` + `harness-gw` 20×5×10 零错误。
