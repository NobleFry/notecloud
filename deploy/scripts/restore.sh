#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# 从备份恢复（数据库 + 附件）
#
#   bash deploy/scripts/restore.sh backups/notecloud-20261019-120000.tar.gz
#
# 会覆盖当前数据库与附件。执行前会要求输入 yes 二次确认。
# 中途失败也会把 API 重新拉起来（trap），不会把站点留在停止状态。
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.prod.yml"

log() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

ARCHIVE="${1:-}"
[[ -n "$ARCHIVE" ]] || die "用法: $0 <备份文件.tar.gz>"
[[ -f "$ARCHIVE" ]] || die "找不到文件：$ARCHIVE"
[[ -f "$ENV_FILE" ]] || die "缺少 $ENV_FILE"

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

TMP="$(mktemp -d)"
API_STOPPED=0

restore_api() {
  if [[ "$API_STOPPED" == "1" ]]; then
    log "恢复 API 服务 ..."
    dc start api >/dev/null 2>&1 || true
    API_STOPPED=0
  fi
}

cleanup() {
  rm -rf "$TMP"
  # 无论成功还是失败，都不要把 API 留在停止状态
  restore_api
}
trap cleanup EXIT

log "解包 ..."
tar -xzf "$ARCHIVE" -C "$TMP"
[[ -f "$TMP/db.sql" ]] || die "备份里没有 db.sql"

printf '\033[33m!\033[0m 这会覆盖当前数据库与附件。输入 yes 继续：'
read -r answer
[[ "$answer" == "yes" ]] || die "已取消"

log "停止 API（避免恢复过程中有写入）..."
dc stop api >/dev/null 2>&1 || true
API_STOPPED=1

log "恢复数据库 ..."
dc exec -T mysql sh -c \
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < "$TMP/db.sql"

if [[ -f "$TMP/uploads.tar.gz" ]]; then
  log "恢复附件 ..."
  # 注意：/data/uploads 是 volume 挂载点，rm 它会报 "Device or resource busy"。
  # 只能清空它下面的内容。
  dc run --rm --no-deps -T api sh -c \
    'mkdir -p /data/uploads && find /data/uploads -mindepth 1 -delete && tar -C /data -xzf -' \
    < "$TMP/uploads.tar.gz"
fi

restore_api

ok "恢复完成"
echo
dc ps
