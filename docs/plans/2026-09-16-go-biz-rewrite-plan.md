# Go 全面重写业务层 · 实施计划

> 依据：`docs/监测设施/prompts/26-9-16-Go全面重写业务层.md`（任务）+ `docs/架构/go技术选型/Go业务层重写技术选型报告.md`（技术底座定稿）+ `docs/架构/系统架构图V3.md`（目标态）。
> 冲突裁决：一切以 `server/src/` 源码为准，发现差异在最终报告记录。

## 技术底座（定稿，不重议）

gin / pgx-v5+手写SQL / golang-migrate（存量一次性转换+force基线）/ go-redis-v9 / golang-jwt-v5（会话 HS256）/ jwx-v4（OAuth RSA/JWKS）/ bcrypt cost 12 / grpc-go（buf 生成 edge 契约）/ minio-go-v7 / prometheus client_golang / slog JSON / env 手写 / stdlib testing + testify。

## 关键语义锚点（已读源码确认）

| 项 | Node 权威实现 | Go 实现要点 |
|---|---|---|
| seq 发号 | `services/message.ts:42-47` DB 行锁 `UPDATE...RETURNING` | Redis `INCR conv:seq:{id}`；GET 缺失→查 PG `next_seq`→Lua 原子装载+INCR；降级回 DB 行锁；每 60s checkpoint 回 PG（GREATEST），关闭时终检 |
| 幂等 | `uniq_msg_idem` 唯一约束 | 前置 Redis 幂等缓存 `msg:idem:{conv}:{sender}:{cmid}` SET NX EX 300s 减跳号；撞约束查库返回首次（deduped 不扇出） |
| 扇出 | `push.ts:69-105` 落库成功后、非去重才扇出；群聊 filterOnline；@旁路 | 同语义；下行 publish `gw:downlink`（buildDownlink 载荷） |
| ack | `handleUplink.ts:119-129` `{type:'message.ack',data:{clientMsgId,seq,serverMsgId}}` | 同信封；gRPC UplinkAck.ok/seq/serverMsgId/rawResponse 对齐 |
| 忙线裁决 | `callSession.ts:49-73` GET-then-SET 非原子（缺陷） | Lua 原子：GET callee busy≠callId→0；否则 SET session+双索引，修复并报告 |
| 已读单调 | `read.ts:22-26` `WHERE lastReadSeq < upto` | 条件 UPDATE 同语义 |
| device sync | `read.ts:63-70` ON CONFLICT GREATEST | 同 SQL |
| presence 读侧 | `presence.ts` ZSET score=expireMs + meta HASH | 只读 filterOnline/getDevices（写侧在 gateway） |
| BigInt | 全局 toJSON→number | gRPC 帧 int64 原样；HTTP JSON 输出 number；时间统一 `2006-01-02T15:04:05.000Z` |
| cookie | `token` HttpOnly + `csrfToken` 可读，sameSite=strict | 同名同属性；CSRF 双提交校验仅 cookie 鉴权路径 |
| 信封 | `{success,data,message}`；错误 500 `{success:false,message:'服务器内部错误'}` | 逐条对齐文案/状态码 |

## 阶段分解（每阶段可编译+commit）

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 骨架 | biz/ 目录、buf 输出、go.mod、config/store/metrics/migrations 转换+force 逻辑、main 启动+优雅关闭 | go build/vet；空服务启动连 PG/Redis |
| P1 鉴权+用户 | register/login/refresh/logout/check-*/profile/update、auth 中间件（双鉴权+CSRF）、限流 | go test + curl 冒烟 |
| P2 社交+消息HTTP | friend 全部、chat 全部、sync/read/mentions/readCount | go test + curl |
| P3 实时 | seq 发号 INCR 落地、persistMessage、gRPC edge 流服务、handleUplink、扇出、presence 读、internal HTTP 端点、call 全信令+Lua 忙线、grace、TURN | 单测（发号/幂等/忙线原子）+ 与 gateway grpc 模式联调 |
| P4 上传+RUM | upload/uploadAdvanced/rum、minio 封装、图片压缩(imaging)、MD5 秒传 | curl multipart 冒烟 |
| P5 OAuth | 8 路由 + PKCE + rotation + jwx RSA/JWKS + seed client + 清理任务 | 授权码全流程 curl + 单测 |
| P6 测试闭环 | 单元测试补全、go vet、冒烟（colima 三件套+gateway+gw-probe+harness-gw 20×5×10） | 全绿、零错误 |
| P7 双跑对比 | Go:3009 vs Node:3007 逐接口字段级 diff 脚本 | 差异清单收敛 |
| P8 压测复测 | S0~S7 + r10~r30 全套 ≥3 轮取中位，OUT_SUBDIR=26-9-16-gobiz | p99 50~150ms、错误率<5% |
| P9 报告 | 三方对比表、发号归因、CPU/内存收益、失败模式、遗留问题；HTML 深色模式自检 | 归档 `docs/监测设施/测试报告/26-9-16-gobiz/` |

## 硬约束自查

- [ ] gateway/server/web/mobile/proto 零改动（buf.gen.yaml 仅增 biz 输出，不改既有）
- [ ] 客户端协议零改动（信封/ack 按 clientMsgId/心跳/重连）
- [ ] 指标名+buckets 对齐 `metrics.ts` 全集；nodejs_gc→go_gc 口径报告注明
- [ ] 迁移唯一入口 golang-migrate；schema.prisma 仅作 Node 对照参考
- [ ] 每阶段中文 commit，不推远端
