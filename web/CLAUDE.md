# web/ — React Web 端（先读根 CLAUDE.md）

栈：React + Redux Toolkit + react-redux + redux-persist + antd + axios + **原生 WebSocket** + i18next + react-router-dom + crypto-js。
包管理器：**pnpm**（`pnpm-lock.yaml` 是唯一锁文件）。

## 命令
- 开发 `pnpm start`｜构建 `pnpm build`｜lint `pnpm lint`｜测试 `pnpm test` / `pnpm test:coverage`｜性能 `pnpm lhci` / `pnpm size`

## 要点
- 实时层唯一入口是 `src/ws/wsClient.ts`（原生 WebSocket 连 `gateway` `/ws`，25s 心跳、指数退避、`message.send`→`message.ack` 幂等重发）。**不要引入 socket.io-client**。
- 服务端状态 + 实时：`wsClient` + RTK；HTTP 走 `src/utils/http.ts`（HttpOnly cookie + 双提交 CSRF + 401 刷新队列）。
- 渲染三态：list/集合必须覆盖 loading / empty / error，empty 不能长得像 error。
- 完工门禁：`pnpm lint && pnpm test`
