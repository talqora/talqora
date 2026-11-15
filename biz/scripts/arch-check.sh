#!/usr/bin/env bash
# 架构守卫:api 层不得直接连库或写 SQL;service 层不得出现 HTTP 概念。
# 已知存量违规登记在 arch-baseline.txt(只许删,不许加)。
set -uo pipefail
cd "$(dirname "$0")/.."
BASE="scripts/arch-baseline.txt"
fail=0

collect_api() {
  grep -rn -E 'internal/db|(SELECT|INSERT INTO|UPDATE |DELETE FROM)' internal/api --include='*.go' \
    | grep -v '_test.go' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//' || true
}

filter_baseline() {
  local out="$1"
  [ -f "$BASE" ] || { printf '%s\n' "$out"; return; }
  while IFS= read -r p; do
    case "$p" in ''|'#'*) continue;; esac
    out=$(printf '%s\n' "$out" | grep -v -- "$p" || true)
  done < "$BASE"
  printf '%s\n' "$out"
}

api_hits=$(collect_api)
baselined=$(printf '%s\n' "$api_hits" | grep -c . || true)
new_hits=$(filter_baseline "$api_hits" | grep -c . || true)

if [ "${new_hits:-0}" -gt 0 ]; then
  echo "✖ api 层出现数据访问/SQL(请下沉到 internal/repo):"
  filter_baseline "$api_hits"
  fail=1
fi

svc_hits=$(grep -rn -E '\bgin\.|net/http' internal/service --include='*.go' | grep -v '_test.go' || true)
if [ -n "$svc_hits" ]; then
  echo "✖ service 层出现 HTTP 概念(gin/net/http):"
  echo "$svc_hits"
  fail=1
fi

if [ -s "$BASE" ]; then
  echo "⚠ 基线内待迁移文件 $((baselined)) 处(不阻断构建):"
  grep -vE '^#|^$' "$BASE" | sed 's/^/   - /'
fi

[ "$fail" = 0 ] && echo "✓ arch-check 通过(无新增违规)"
exit "$fail"
