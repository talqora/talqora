# 多阶段构建:
#   deps   - 装依赖(单独一层,利用 pnpm-lock 缓存)
#   dev    - 给本地 docker compose dev 用,带 tsx watch + bind mount
#   build  - 编译 TS + 生成 Prisma Client
#   runner - 生产运行时,只带必需产物

# ---- 基础:装依赖 ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl bash
RUN npm install -g pnpm@10
# 依赖源:默认官方;服务器本地 build 时由 compose 传 NPM_REGISTRY=npmmirror(国内快)。
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile --registry="$NPM_REGISTRY"

# ---- dev:热重载,本地 docker compose dev 用 ----
FROM deps AS dev
COPY . .
# 启动时先生成 Prisma Client(代码挂载后 generate 才能用最新 schema)
# 然后跑 migration + tsx watch
CMD ["sh", "-c", "pnpm db:generate && pnpm db:migrate:deploy && pnpm dev"]

# ---- build:编译产物 ----
FROM deps AS build
COPY . .
RUN pnpm db:generate \
  && pnpm build

# ---- runner:生产镜像 ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl wget \
  && addgroup -S app -g 10001 \
  && adduser -S app -G app -u 10001
COPY --from=build --chown=app:app /app/package.json ./
COPY --from=build --chown=app:app /app/pnpm-lock.yaml ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
# Prisma client(生成的 .js)需放到 dist 下,匹配编译后代码 ../generated 的相对路径
COPY --from=build --chown=app:app /app/src/generated ./dist/generated
USER app
EXPOSE 3007
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3007/health || exit 1
# 容器启动:apply migration(prisma migrate deploy,幂等/带库级锁)→ seed default client(server.ts 内部已做)→ listen
# 迁移随容器启动执行,部署即自动同步 DB schema(prisma 仅在有未应用迁移时变更,无则秒过)。
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/server.js"]
