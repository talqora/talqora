# biz — our-chat 业务层(Go 重写)

Node(`server/`)业务层的 Go 重写:模块化单体、多副本无状态、客户端协议零改动。
实时链路:客户端 → **gateway(Go)** `/ws` → gRPC 双向流(`ourchat.edge.v1.Realtime/Stream`,userId 哈希分片)→ **biz** → PG/Redis/MinIO;下行经 Redis `gw:downlink` 由网关代投。

## 快速开始

```bash
# 前置:PG/Redis/MinIO(colima) + gateway(:8090, GATEWAY_UPSTREAM=grpc)
cd biz
go build -o bin/biz ./cmd/biz
./scripts/dev.sh            # env 以 docker/.env.debug 为基础(端口默认 3007, gRPC 默认 127.0.0.1:3008)
```

双跑对比(与 Node 并存):
```bash
./scripts/dev.sh 3009 127.0.0.1:30081   # 备用端口;或 EDGE_GRPC_ENABLED=false 只起 HTTP
node scripts/diff-api.mjs               # Node(3007) vs Go(3009) 字段级 diff
```

## 关键 env(全集见 internal/config;.env.debug 缺失键已补齐)

| 键 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3007 | HTTP 监听 |
| `EDGE_GRPC_ADDR` / `EDGE_GRPC_ENABLED` | `127.0.0.1:3008` / true | gRPC 流服务 |
| `JWT_SECRET` | 必填 | 与 gateway/Node 共享,缺失 fail-fast |
| `AUTH_RATE_LIMIT_MAX` / `_WINDOW_MS` | 10 / 900000 | 压测放开:1000000/60000(与三期 runbook 一致) |
| `TURN_SECRET/HOST/STUN_PORT/TLS_PORT/TTL_SEC` | 空/空/3478/5349/86400 | 空 secret 降级空 iceServers |
| `OAUTH_*` | 见 .env.debug | `OAUTH_ACTIVE_KID` 缺失 fail-fast |

## 发号(V3:Redis INCR)

- 键 `conv:seq:{convId}`;首次 GET 缺失 → 从 PG `conversations.next_seq` 装载 → Lua 原子 `GET or SET + INCR`;Redis 失联降级回 DB 行锁(`UPDATE ... RETURNING`,Node 同款 SQL)。
- 幂等:Redis `msg:idem:{conv}:{sender}:{cmid}` SET NX EX 300s 前置缓存 + DB `uniq_msg_idem` 唯一约束兜底;去重命中不重复扇出。
- checkpoint:每 60s 把近期发号位点 `GREATEST` 写回 PG;优雅关闭终检。

## 通话忙线裁决(修复 Node 缺陷)

Node `callSession.tryCreateSession` 是 GET-then-SET(read-modify-write 非原子,两副本并发 call:start 可双接);
Go 版用 Lua 原子裁决:`GET call:user:{callee} ≠ callId → 拒绝;否则 SET 会话+双索引`。并发单测验证恰好一人成功。

## 迁移(golang-migrate)

- `migrations/` 由存量 Prisma 迁移一次性转换(`scripts/convert-prisma-migrations.sh`,6 个 up + 空 down)。
- 启动自动基线:库有 `_prisma_migrations` 且 golang-migrate 未接管 → `force 6` 后增量 up;全新库从头重放。
- 此后迁移唯一入口 = golang-migrate;`schema.prisma` 仅作 Node 对照参考。

## 技术底座(偏离点见报告)

gin / pgx-v5+手写 SQL / golang-migrate / go-redis-v9 / golang-jwt-v5(会话 HS256)/
**go-jose v4**(OAuth JOSE;jwx v4 全版本依赖 Go1.26 实验包 encoding/json/v2,默认工具链无法构建)/
bcrypt cost 12 / grpc-go(buf 生成 `internal/contracts/gen`) / minio-go-v7 +
**aws-sdk-go-v2**(分片会话;minio-go v7 已私有化手控 multipart API)/
prometheus client_golang / slog JSON / stdlib testing + testify。

## 测试

```bash
go test ./...   # 单测:发号并发/忙线原子性/JWT/PKCE/令牌往返/限流/TURN
go vet ./...
```

集成与压测:复用 `perf/` 工具链(客户端零改动),冒烟 = gw-probe + harness-gw 20×5×10 零错误。
