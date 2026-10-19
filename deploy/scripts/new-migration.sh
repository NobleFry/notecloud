#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# 创建一个迁移文件（不应用）
#
#   bash deploy/scripts/new-migration.sh add_attachments
#   pnpm db:deploy        # 应用
#
# 为什么不用 `prisma migrate dev`：
#   ngram 全文索引只能手写（schema 语法不支持 WITH PARSER ngram），
#   Prisma 会把它判为 drift。轻则每次生成 `DROP INDEX`，重则直接要求
#   reset 数据库（清空数据）。
#
# 本脚本用 `migrate diff` 生成 SQL，自动剔除其中的 DROP INDEX，
# 落到 prisma/migrations/<timestamp>_<name>/migration.sql。
# 应用后 db:deploy 会自动跑 ensure-indexes 补齐全文索引。
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="${1:-}"

log() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ -n "$NAME" ]] || die "用法: $0 <migration-name>（例如 add_attachments）"
[[ "$NAME" =~ ^[a-zA-Z0-9_-]+$ ]] || die "迁移名只能包含字母、数字、下划线和短横线"

cd "$ROOT/apps/api"

TMP_RAW="$(mktemp)"
TMP_CLEAN="$(mktemp)"

log "对比数据库与 schema ..."
pnpm exec prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --script > "$TMP_RAW" 2>/dev/null

# 剔除 ngram 全文索引的 DROP（由 ensure-indexes 维护，不属于迁移）
awk '
  /^-- DropIndex$/ { pending = 1; next }
  pending && /^DROP INDEX `[^`]*` ON `[^`]*`;$/ {
    if ($0 ~ /_ft_/) { pending = 0; next }
  }
  { pending = 0; print }
' "$TMP_RAW" > "$TMP_CLEAN"

if [[ ! -s "$TMP_CLEAN" ]] || ! grep -qE 'ALTER TABLE|CREATE TABLE|CREATE INDEX' "$TMP_CLEAN"; then
  ok "schema 与数据库已一致，没有需要生成的迁移"
  rm -f "$TMP_RAW" "$TMP_CLEAN"
  exit 0
fi

TS="$(date +%Y%m%d%H%M%S)"
DIR="prisma/migrations/${TS}_${NAME}"
mkdir -p "$DIR"
cp "$TMP_CLEAN" "$DIR/migration.sql"

cat >> "$DIR/migration.sql" <<'SQL'

-- ─────────────────────────────────────────────────────────────────
-- 本迁移由 deploy/scripts/new-migration.sh 生成（不是 prisma migrate dev）。
-- ngram 全文索引由 scripts/ensure-indexes.ts 在每次迁移后维护。
-- ─────────────────────────────────────────────────────────────────
SQL

rm -f "$TMP_RAW" "$TMP_CLEAN"

ok "已创建 $DIR/migration.sql"
echo
sed -n '1,40p' "$DIR/migration.sql"
echo
echo "下一步：  pnpm db:deploy"
