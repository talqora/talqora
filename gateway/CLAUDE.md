# gateway/ — Go 长连接网关（先读根 CLAUDE.md）

栈：Go 1.25 + gorilla/websocket + golang-jwt v5 + gRPC + prometheus client。

## 要点
- 职责：承载 WebSocket 长连接、JWT 验签（HS256，与 biz 共享 `JWT_SECRET`）、上行经 gRPC 流交给 biz、下行路由；指标走 Prometheus。
- 不承担 HTTP 反代：生产由 nginx 直连 `biz:3007`，开发由 vite dev proxy 直连，本服务只暴露 `/ws`、`/metrics`、`/healthz`。
- JWT **只验签不签发**，签发在 biz 的 OAuth IdP（RS256 + JWKS）。
- 完工门禁：`go build ./... && go test ./...`（gofmt 已由 PostToolUse hook 自动跑）。
