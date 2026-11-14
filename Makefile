# our-chat 本地开发编排
#
# 一键启动:  make dev
#   首次自动:建集中 env + 装依赖(go mod download / pnpm install) + 起中间件,
#   随后并发跑 biz(:3007, gRPC edge :3008)/ gateway(:8090, grpc 上游)/ web(:5173),
#   合并输出,Ctrl-C 一起停。
# 其它:      make middleware(只起中间件) · make down(停中间件) · make env(只建 env)

DEV_COMPOSE := docker/docker-compose.dev.yml
ENV_DEBUG   := docker/.env.debug

# 兼容两种 compose 实现:docker compose 插件 / docker-compose 独立二进制(colima 默认只带后者)。
# 可用 `make COMPOSE="docker compose" dev` 显式覆盖。
COMPOSE ?= $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")

.PHONY: dev middleware down env keys deps proto proto-check

# 一键起全部:env/密钥/依赖就绪 → 起中间件 → 等 PG → 并发跑三个服务(Ctrl-C 一起退出)
dev: env keys deps middleware
	@printf '⏳ 等待 PostgreSQL'; \
	until $(COMPOSE) -f $(DEV_COMPOSE) exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do printf '.'; sleep 1; done; echo ' ✓'
	@echo '▶ biz:3007(+gRPC :3008) · gateway:8090 · web:5173(Ctrl-C 全部停止)'
	@trap 'kill 0' INT TERM EXIT; \
	( set -a; . $(ENV_DEBUG); set +a; \
	  export AUTH_RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_WINDOW_MS=60000; \
	  export OAUTH_PRIVATE_KEY_FILE=$(CURDIR)/keys/oauth-private-dev.pem; \
	  cd biz && go run ./cmd/biz ) & \
	( set -a; . $(ENV_DEBUG); set +a; cd gateway && go run ./cmd/gateway ) & \
	( cd web && pnpm start ) & \
	wait

# 只起中间件(postgres + redis + minio)
middleware:
	$(COMPOSE) -f $(DEV_COMPOSE) up -d

# 停中间件
down:
	$(COMPOSE) -f $(DEV_COMPOSE) down

# 生成集中 dev env(幂等;test -f X || cmd = 不存在才建)
env:
	@test -f $(ENV_DEBUG) || { cp docker/.env.debug.example $(ENV_DEBUG); echo "✓ 已生成 $(ENV_DEBUG)(请填 JWT_SECRET)"; }

# 生成开发用 OAuth 私钥(RSA 2048,PKCS#8)。biz 启动要求 OAUTH_ACTIVE_KID + 可读私钥,
# 缺了会 fail-fast。私钥在 keys/*.pem,已被 .gitignore 忽略,不进仓库。
keys:
	@test -f keys/oauth-private-dev.pem || { \
	  mkdir -p keys; \
	  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out keys/oauth-private-dev.pem; \
	  chmod 600 keys/oauth-private-dev.pem; \
	  echo "✓ 已生成 keys/oauth-private-dev.pem"; }

# 首次装依赖(已就绪则跳过)
deps:
	@test -d web/node_modules || (cd web && pnpm install)

# 从 proto/ 单一契约源生成契约代码(web/gateway/biz/mobile-swift)
# biz 用独立模板:managed go_package_prefix 是单值,必须按 module 隔离。
proto:
	buf generate
	buf generate --template buf.gen.biz.yaml

# CI:校验 proto 规范 + 生成物是否最新(不一致则失败)
proto-check:
	buf lint
	buf generate
	buf generate --template buf.gen.biz.yaml
	git diff --exit-code -- \
			web/src/contracts/gen \
			gateway/internal/contracts/gen \
			biz/internal/contracts/gen \
			mobile-swift/Sources/Contracts/Gen
