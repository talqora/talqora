# 本地监测栈(Prometheus + Grafana)

抓取 `biz`(Go 业务层)与 `gateway`(Go 网关)的 `/metrics`,在 Grafana 里看连接数、消息延迟、下行直投/兜底比例、GC、goroutine 数、进程内存。

## 前提

`biz`、`gateway` 跑在**宿主机**(不在这个 compose 里),并已暴露:

- biz: `http://localhost:3007/metrics`(见 `biz/internal/metrics/metrics.go`,`PORT` 默认 3007)
- gateway: `http://localhost:8090/metrics`(见 `gateway/internal/metrics/metrics.go`,`GATEWAY_ADDR` 默认 `:8090`)

`make dev` 会把两者都拉起来。Prometheus/Grafana 跑在 docker 里,通过 `host.docker.internal` 访问宿主机上的这两个端口。

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
  - job 名 `server` 是历史遗留(该 job 曾指向 Node 后端),现抓取的是 biz,留给旧面板与查询兼容。
- Grafana: http://localhost:3001(账号 `admin`/`admin`,也开了匿名 Viewer 访问)
  - `realtime-system-authority.json` — 当前权威面板(10 行:连接/上行/消息/下行双通道/保护/通话/HTTP/DB/Go 运行时/副本面)
  - `realtime-node-vs-go.json` — 历史存档面板(Node vs Go 对比期使用,现已无 Node 侧数据,仅作归档)

## 端口选择

- Prometheus 用默认 `9090`。
- Grafana 用 `3001`(宿主机常见地开发端口 `3000` 可能被前端 dev server 占用,这里对外映射到 `3001`,容器内仍是标准 `3000`)。

## 如何改抓取目标

编辑 `docker/monitoring/prometheus.yml` 里对应 job 的 `static_configs.targets`,改完后 `docker compose -f docker/monitoring/docker-compose.monitoring.yml restart prometheus` 即可生效(不用重建镜像)。

若 biz/gateway 端口不是默认的 3007/8090(比如本地用了别的 `PORT`/`GATEWAY_ADDR`),同样改这里的 `targets`。

`prometheus.yml` 里的 `biz2` job 指向 `:3009`,用于双副本压测/故障演练;单副本部署时该 target 抓取失败属正常。

## 目录结构

```
docker/monitoring/
├── docker-compose.monitoring.yml   # prometheus + grafana 两个服务,独立 network our-chat-monitoring
├── prometheus.yml                  # scrape 配置:biz(:3007, job 名 server)、biz2(:3009)、gateway(:8090)
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/datasource.yml   # 自动接入 Prometheus 数据源
│   │   └── dashboards/dashboards.yml    # dashboard provider,指向 ./grafana/dashboards
│   └── dashboards/
│       ├── realtime-system-authority.json   # 权威面板(当前使用)
│       └── realtime-node-vs-go.json         # 历史对比面板(归档)
└── README.md
```

## 已知限制 / 未决问题

- `go_gc_duration_seconds` 是 `client_golang` 默认注册的 Summary(自带 `quantile` 标签,没有 `_bucket`),看板里直接取 `quantile="0.5"`/`quantile="1"`,**不能**对它用 `histogram_quantile`(那是给真正的 Histogram `_bucket` 系列用的)。
- `realtime-node-vs-go.json` 里的 Node 侧序列(`nodejs_*`)已无数据源,看板会出现空图,属预期。
- Grafana 匿名访问 + 弱密码(`admin`/`admin`)只适合本地,不要照搬到生产/公网环境。
- **未加 alerting 规则,只做可视化。** 需要告警时补 `rule_files` + `alerting`,不要依赖人盯看板。
