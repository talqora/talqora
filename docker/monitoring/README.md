# 本地监测栈(Prometheus + Grafana)

抓取 `server`(Node)与 `gateway`(Go)的 `/metrics`,在 Grafana 里对比连接数、消息延迟、事件循环延迟、GC、goroutine 数、进程内存。

## 前提

`server`、`gateway` 在**宿主机**跑(不在这个 compose 里),并已暴露:

- server: `http://localhost:3007/metrics`(见 `server/src/metrics/metrics.ts`,`server/src/server.ts` 的 `PORT`)
- gateway: `http://localhost:8090/metrics`(见 `gateway/internal/metrics/metrics.go`,`GATEWAY_ADDR` 默认 `:8090`)

Prometheus/Grafana 跑在 docker 里,通过 `host.docker.internal` 访问宿主机上的这两个端口。

## 启动

```bash
docker compose -f docker/monitoring/docker-compose.monitoring.yml up -d
```

停止:

```bash
docker compose -f docker/monitoring/docker-compose.monitoring.yml down
```

## 访问地址

- Prometheus: http://localhost:9090(Targets 页 `Status -> Targets` 确认 `server`/`gateway` 两个 job 是 `UP`)
- Grafana: http://localhost:3001(账号 `admin`/`admin`,也开了匿名 Viewer 访问;首页 Dashboards 里找 `our-chat` 文件夹下的 `Realtime: Node(server) vs Go(gateway)`)

## 端口选择

- Prometheus 用默认 `9090`。
- Grafana 用 `3001`(宿主机常见地开发端口 `3000` 可能被前端 dev server 占用,这里对外映射到 `3001`,容器内仍是标准 `3000`)。

## 如何改抓取目标

编辑 `docker/monitoring/prometheus.yml` 里对应 job 的 `static_configs.targets`,改完后 `docker compose -f docker/monitoring/docker-compose.monitoring.yml restart prometheus` 即可生效(不用重建镜像)。

若 server/gateway 端口不是默认的 3007/8090(比如本地用了别的 `PORT`/`GATEWAY_ADDR`),同样改这里的 `targets`。

## 目录结构

```
docker/monitoring/
├── docker-compose.monitoring.yml   # prometheus + grafana 两个服务,独立 network our-chat-monitoring
├── prometheus.yml                  # scrape 配置:server(:3007)、gateway(:8090)
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/datasource.yml   # 自动接入 Prometheus 数据源
│   │   └── dashboards/dashboards.yml    # dashboard provider,指向 ./grafana/dashboards
│   └── dashboards/
│       └── realtime-node-vs-go.json     # 对比看板
└── README.md
```

## 已知限制 / 未决问题

- `go_gc_duration_seconds` 是 `client_golang` 默认注册的 Summary(自带 `quantile` 标签,没有 `_bucket`),看板里直接取 `quantile="0.5"`/`quantile="1"`,**不能**对它用 `histogram_quantile`(那是给真正的 Histogram `_bucket` 系列用的)。`nodejs_gc_pause_seconds` 是 Node 侧自建的真 Histogram,看板里对它用 `histogram_quantile` 求 p99,两侧统计口径不完全对等,仅作参考。
- Grafana 匿名访问 + 弱密码(`admin`/`admin`)只适合本地,不要照搬到生产/公网环境。
- 未加 alerting 规则,只做可视化。
