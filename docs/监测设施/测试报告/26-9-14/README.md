# 26-9-14 · 纯 Node(socket.io) 性能基线（无 gateway）

> 分支 `feat/perf-monitoring`。这是"先无 go 层"的纯 Node 完整性能基线：**gateway(Go) 全程未启动、未参与任何流量**，
> 用于留存引入 Go 层之前的完整性能记录，作为后续 Node vs Go 对比的唯一对照基座。
> 报告见 `纯Node性能基线报告.html`（自包含，可长期归档），原始数据见 `data/`。

## 场景清单（全部走 socket.io 直连 server :3007；HTTP 层走 REST）

| 数据文件 | 场景 | 参数 |
|---|---|---|
| `data/s0_smoke.json` | S0 Smoke | 50 连接 × 2 msg/s × 15s |
| `data/s1_throughput.json` | S1 常规吞吐 | 100 连接 × 10 msg/s × 20s |
| `data/s2_conn_scale.json` | S2 连接规模 | 300 连接 × 2 msg/s × 15s |
| `data/s3_overload.json` | S3 过载压力 | 150 连接 × 20 msg/s × 15s |
| `data/s4_large_conn.json` | S4 大连接 | 500 连接 × 1 msg/s × 15s |
| `data/s5_stability.json` | S5 长时稳态 | 100 连接 × 5 msg/s × 120s |
| `data/tp_r10~r30.json` | 吞吐饱和扫描 | 固定 100 连接，RATE 10/15/20/25/30 各 20s |
| `data/s6_ramp.json` | S6 连接爬坡探顶 | 2000 起每级 +2000 → 10000，每级保持 5s |
| `data/s6_ramp_3000.json` | S6 爬坡(3000 备份) | 500 起每级 +500 → 3000 |
| `data/s7_storm.json` | S7 惊群重连 | 300 连接同瞬间全断→全连 |
| `data/fanout_bench.json` | 群扇出 | 100 成员在线，1 人发 20 条测 fan-out |
| `data/http_bench.json` | HTTP API 层 | 7 接口并发 20 × 10s |

## 复现 runbook

```bash
# 1) 中间件(已在跑时可跳过)
docker compose -f docker/docker-compose.dev.yml --env-file docker/.env.debug up -d
cd server && pnpm db:migrate:deploy

# 2) server(压测需放开 auth 限流;gateway 不要启动)
cd server && DOTENV_CONFIG_PATH=../docker/.env.debug \
  AUTH_RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_WINDOW_MS=60000 pnpm dev   # :3007

# 3) 监测栈(可选:不采样 Prometheus 也能跑 harness,但报告资源列会缺)
docker compose -f docker/monitoring/docker-compose.monitoring.yml up -d   # :9090/:3001

# 4) 压测(perf 目录)
cd perf && npm install
node node-run.mjs s1_throughput 100 10 20 25          # 场景 S0-S5 各跑一遍
for r in 10 15 20 25 30; do node node-run.mjs tp_r$r 100 $r 20 25; done   # 吞吐饱和扫描
env START=2000 STEP=2000 MAX=10000 HOLD_MS=5000 node ramp-probe.mjs       # S6 爬坡(注意 ramp-probe 读 env 而非 argv)
node storm-reconnect.mjs 300 50                        # S7 惊群
node fanout-bench.mjs 100 20 9000001                   # 群扇出(直写 DB 建群)
node http-bench.mjs 20 10                              # HTTP API 层

# 5) 生成报告
node gen-node-report.mjs
```

## 结论速览

- **吞吐饱和拐点 1500~2000 msg/s**：1500 零错误；2000 起 7.6% 失败且 RTT 断崖式排队到 ~2s；3000 失败率 62.5%。瓶颈在 DB 写路径（会话发号行锁 + Prisma 连接池），非 Node 事件循环。
- **中等负载（≤1500 msg/s）零错误**：100 连接 × 10 msg/s 下 RTT p50=33ms/p99=57ms/p999=94ms；2 分钟长稳无漂移。
- **连接容量 10000 轻松**：100% 建连成功，RSS 332MB（≈33KB/连接），上限未探到。
- **群扇出极快**：100 人 fan-out 扩散 span p99=3ms，端到端 p99=21ms。
- **惊群重连零失败**：300 连接同瞬间重连 100% 成功，无资源尖峰。
- **HTTP 两大瓶颈**：①`POST /api/login` 19.3 rps（bcrypt 12 轮 CPU 代价）；②`GET /user/messages` 73 rps（无 limit 全量返回历史消息）。
- **本基线显著优于旧 26-9-12 A/B 的 socketio 侧数据**（同参数 S1 RTT p99 392→57ms），旧测受同机 gateway 干扰、方法不当。

## 工具清单(perf/)

| 工具 | 用途 |
|---|---|
| `harness.mjs` | 压测主程序(注册/登录 → 建连 → message.send/RTT，含 p999) |
| `node-run.mjs` | 场景编排:跑 harness + 每 2s 采样资源 + 服务内直方图分位(消息/HTTP/DB/GC) → JSON |
| `ramp-probe.mjs` | 连接爬坡探顶(保持连接、阈值判定拐点；**参数走 env** START/STEP/MAX/HOLD_MS) |
| `storm-reconnect.mjs` | 惊群重连(同瞬间全断全连 + 资源尖峰采样) |
| `fanout-bench.mjs` | 群扇出(直写 DB 建群 + fan-out span/e2e) |
| `http-bench.mjs` | HTTP API 层并发压测(吞吐/时延/错误) |
| `gen-node-report.mjs` | 读 data/*.json 生成自包含 HTML 报告(跟随系统深浅色) |

## 已知坑

- `ramp-probe.mjs` 参数是**环境变量**（`START/STEP/MAX/HOLD_MS`），不是位置参数。
- 压测登录阶段极慢（bcrypt 12 轮 + libuv 线程池 4 线程）：1 万用户登录约 15 分钟。
- **过载压测（≈3000 msg/s）曾使 colima docker(PostgreSQL)短暂失联（P1001）**，属同机争抢的环境稳定性现象；恢复方式 `colima stop && colima start`。
- 群扇出依赖直写 DB 建群（server 暂无建群 API）；`GroupMember`/`UserGroup` 表结构见 `server/prisma/schema.prisma`。
