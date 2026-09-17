#!/usr/bin/env bash
# 本地开发启动:biz 业务服务(宿主机直跑,连 docker 中间件)。
# env 以 docker/.env.debug 为基础,补齐 .env.debug 缺失但源码引用的键。
# 用法: ./dev.sh [PORT] [EDGE_GRPC_ADDR]   (默认 3007 / 127.0.0.1:3008;双跑对比用 3009)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/biz"

# 1. 基础 env(不覆盖已存在的环境变量,与 dotenv 行为一致)
if [ -f "$ROOT/docker/.env.debug" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ROOT/docker/.env.debug"
  set +a
fi

# 2. .env.debug 缺失、Node 源码引用的键(见 prompts/26-9-16 §三.4)
export PORT="${1:-${PORT:-3007}}"
export EDGE_GRPC_ADDR="${2:-${EDGE_GRPC_ADDR:-127.0.0.1:3008}}"
export EDGE_GRPC_ENABLED="${EDGE_GRPC_ENABLED:-true}"
export OAUTH_PRIVATE_KEY_FILE="${OAUTH_PRIVATE_KEY_FILE:-$ROOT/server/keys/oauth-private-dev.pem}"
export AUTH_RATE_LIMIT_MAX="${AUTH_RATE_LIMIT_MAX:-10}"
export AUTH_RATE_LIMIT_WINDOW_MS="${AUTH_RATE_LIMIT_WINDOW_MS:-900000}"
export OAUTH_WEB_REDIRECT_URI="${OAUTH_WEB_REDIRECT_URI:-http://localhost:5173/oauth/callback}"
export TURN_SECRET="${TURN_SECRET:-}"
export TURN_HOST="${TURN_HOST:-}"

exec go run ./cmd/biz
