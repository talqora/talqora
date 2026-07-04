# our-chat 本地开发编排
#
# 一键启动:  make dev
#   首次自动:建集中 env + 软链 server/.env + 装依赖 + 生成 Prisma Client + 起中间件,
#   随后并发跑 server(:3007)/ gateway(:8090)/ web(:5173),合并输出,Ctrl-C 一起停。
# 其它:      make middleware(只起中间件) · make down(停中间件) · make env(只建 env)

DEV_COMPOSE := docker/docker-compose.dev.yml
ENV_DEBUG   := docker/.env.debug

# iOS 发布构建(Tuist + xcodebuild)。工程/工作区是 Tuist 产物(不入库),故先 generate。
IOS_DIR       := mobile-swift
IOS_WORKSPACE := OurChat.xcworkspace
IOS_SCHEME    := OurChat
IOS_ARCHIVE   := build/OurChat.xcarchive

.PHONY: dev middleware down env deps proto proto-check ios-release

# 一键起全部:env/依赖就绪 → 起中间件 → 等 PG → 并发跑三个业务(Ctrl-C 一起退出)
dev: env deps middleware
	@printf '⏳ 等待 PostgreSQL'; \
	until docker compose -f $(DEV_COMPOSE) exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do printf '.'; sleep 1; done; echo ' ✓'
	@echo '▶ server:3007 · gateway:8090 · web:5173(Ctrl-C 全部停止)'
	@trap 'kill 0' INT TERM EXIT; \
	( cd server && pnpm dev ) & \
	( set -a; . $(ENV_DEBUG); set +a; cd gateway && go run ./cmd/gateway ) & \
	( cd web && pnpm start ) & \
	wait

# 只起中间件(postgres + redis + minio)
middleware:
	docker compose -f $(DEV_COMPOSE) up -d

# 停中间件
down:
	docker compose -f $(DEV_COMPOSE) down

# 生成集中 dev env + 软链 server/.env(幂等;test -f X || cmd = 不存在才建)
env:
	@test -f $(ENV_DEBUG) || { cp docker/.env.debug.example $(ENV_DEBUG); echo "✓ 已生成 $(ENV_DEBUG)(请填 JWT_SECRET)"; }
	@test -e server/.env  || { ln -s ../docker/.env.debug server/.env; echo "✓ 已软链 server/.env → ../docker/.env.debug"; }

# 首次装依赖 + 生成 Prisma Client(已就绪则跳过)
deps:
	@test -d server/node_modules || (cd server && pnpm install)
	@test -d web/node_modules || (cd web && pnpm install)
	@test -d server/src/generated/prisma || (cd server && pnpm db:generate)

# 从 proto/ 单一契约源生成四端类型(server/web/gateway/mobile-swift)
proto:
	buf generate

# CI:校验 proto 规范 + 生成物是否最新(不一致则失败)
proto-check:
	buf lint
	buf generate
	git diff --exit-code -- \
		server/src/contracts/gen \
		web/src/contracts/gen \
		gateway/internal/contracts/gen \
		mobile-swift/Sources/Contracts/Gen

# 构建 iOS 发布包:Tuist 生成工程 → Release 归档 →(有 ExportOptions.plist 则)导出 ipa。
# 前置:装好 Xcode 与 tuist;真机分发需在工程里配好签名(团队/描述文件)。
# 产物:归档 mobile-swift/build/OurChat.xcarchive;ipa mobile-swift/build/ipa/。
ios-release:
	cd $(IOS_DIR) && tuist generate --no-open
	cd $(IOS_DIR) && xcodebuild archive \
		-workspace $(IOS_WORKSPACE) \
		-scheme $(IOS_SCHEME) \
		-configuration Release \
		-destination 'generic/platform=iOS' \
		-archivePath $(IOS_ARCHIVE) \
		-allowProvisioningUpdates
	@if [ -f $(IOS_DIR)/ExportOptions.plist ]; then \
		cd $(IOS_DIR) && xcodebuild -exportArchive \
			-archivePath $(IOS_ARCHIVE) \
			-exportPath build/ipa \
			-exportOptionsPlist ExportOptions.plist \
			-allowProvisioningUpdates && \
		echo '✓ ipa 已导出 → $(IOS_DIR)/build/ipa'; \
	else \
		echo '⚠ 未找到 $(IOS_DIR)/ExportOptions.plist,已产出归档但跳过 ipa 导出'; \
		echo '  归档:$(IOS_DIR)/$(IOS_ARCHIVE)(可在 Xcode Organizer 手动签名分发)'; \
		echo '  或添加 ExportOptions.plist(method: app-store/ad-hoc/development)后重跑本命令导出 ipa'; \
	fi
