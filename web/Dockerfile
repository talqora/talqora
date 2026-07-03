# 构建阶段:编译前端静态产物
# 用 Debian 基镜(非 alpine)规避 sass-embedded 在 musl 上的原生二进制兼容问题
FROM node:22 AS builder
WORKDIR /app
RUN npm install -g pnpm@10
# 依赖源:默认官方;服务器本地 build 时由 compose 传 NPM_REGISTRY=npmmirror(国内快)。
ARG NPM_REGISTRY=https://registry.npmjs.org
# 先拷依赖清单,利用层缓存
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --registry="$NPM_REGISTRY"
COPY . .
# 生产构建期注入「用户实际访问的公开 origin」(经 nginx 同源反代到 server/gateway)。
# Vite 把 VITE_* 内联进 bundle;不传则回退到 当前主机:3007(生产不暴露,会请求失败),故 CI 必传。
# 例: http://1.2.3.4:8080  或  https://chat.example.com
ARG VITE_SERVER_ORIGIN=
ENV VITE_SERVER_ORIGIN=$VITE_SERVER_ORIGIN
# agent-server 同源接入(方案A):前端调 {公开origin}/agent/api,nginx 反代剥 /agent/ → agent 的 /api。
# 例: http://1.2.3.4:8080/agent/api  或  https://chat.example.com/agent/api
ARG VITE_AGENT_API_BASE=
ENV VITE_AGENT_API_BASE=$VITE_AGENT_API_BASE
RUN pnpm build

# 运行阶段:nginx 托管静态资源 + 反向代理
# nginx 配置不烤进镜像,改由 compose 从 docker/nginx/ 以 :ro 挂载(改路由无需重建镜像)
FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
