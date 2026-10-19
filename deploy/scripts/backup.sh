#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# 备份：数据库 + 附件
#
#   bash deploy/scripts/backup.sh
#   BACKUP_DIR=/mnt/nas/notecloud KEEP=30 bash deploy/scripts/backup.sh
#
# 产出：$BACKUP_DIR/notecloud-YYYYmmdd-HHMMSS.tar.gz
#   ├─ db.sql           mysqldump 全量
#   └─ uploads.tar.gz   附件目录
#
# ⚠️ 只 dump 数据库是不够的 —— 附件在磁盘上，漏了会让所有图片变死链。
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.prod.yml"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
KEEP="${KEEP:-14}"

log() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "缺少 $ENV_FILE"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --status running --quiet mysql >/dev/null 2>&1 \
  || die "MySQL 容器没在运行，先启动服务再备份"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/notecloud-$STAMP.tar.gz"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

log "导出数据库 ..."
dc exec -T mysql sh -c \
  'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --quick --routines --triggers "$MYSQL_DATABASE"' \
  > "$TMP/db.sql"

[[ -s "$TMP/db.sql" ]] || die "mysqldump 输出为空，备份中止"

log "打包附件 ..."
# 用一次性容器从 volume 里读，避免依赖 api 容器状态
dc run --rm --no-deps -T api sh -c 'tar -C /data -czf - uploads' > "$TMP/uploads.tar.gz"

log "归档 ..."
tar -czf "$FILE" -C "$TMP" db.sql uploads.tar.gz
chmod 600 "$FILE"

ok "备份完成：$FILE（$(du -h "$FILE" | cut -f1)）"

# 只保留最近 KEEP 份
if [[ "$KEEP" =~ ^[0-9]+$ ]] && (( KEEP > 0 )); then
  ls -1t "$BACKUP_DIR"/notecloud-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
    log "清理旧备份 $(basename "$old")"
  done
fi
