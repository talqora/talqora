#!/usr/bin/env bash
# 把 server/prisma/migrations 的存量迁移一次性转换为 golang-migrate 格式:
#   <ts>_<name>/migration.sql → biz/migrations/NNNN_<name>.up.sql (+ 空 down.sql)
# 排序:目录名升序(0_initial 在最前,时间戳按序)。可重复执行(幂等,先清空再生成)。
# 用法: ./convert-prisma-migrations.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/../../server/prisma/migrations"
DST="$SCRIPT_DIR/../migrations"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

[ -d "$SRC" ] || { echo "源目录不存在: $SRC" >&2; exit 1; }

if [ "$DRY" -eq 0 ]; then
  mkdir -p "$DST"
  # 清空旧的转换产物(保留其他手写迁移? 不——存量转换期间 migrations 目录只含转换产物)
  find "$DST" -maxdepth 1 -type f \( -name '*.up.sql' -o -name '*.down.sql' \) -delete
fi

n=1
for d in "$SRC"/*/; do
  name="$(basename "$d")"
  sql="$d/migration.sql"
  [ -f "$sql" ] || { echo "跳过(无 migration.sql): $name" >&2; continue; }

  # 去时间戳前缀,0_initial 保留原名
  if [[ "$name" =~ ^[0-9]+_(.*)$ ]]; then
    base="${BASH_REMATCH[1]}"
  else
    base="$name"
  fi
  base="${base// /_}"  # 空格换下划线,保证文件名安全

  up="$(printf '%04d_%s.up.sql' "$n" "$base")"
  down="$(printf '%04d_%s.down.sql' "$n" "$base")"

  if [ "$DRY" -eq 1 ]; then
    echo "$up  ←  $name"
  else
    cp "$sql" "$DST/$up"
    : > "$DST/$down"   # 存量反向迁移无业务价值,空占位保格式完整
    echo "生成: $up (+ 空 down)"
  fi
  n=$((n + 1))
done
echo "共转换 $((n - 1)) 个迁移"
