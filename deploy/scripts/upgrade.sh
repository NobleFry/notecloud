#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# 一键升级：备份 → 构建 → 滚动重启 → 健康检查
#
#   bash deploy/scripts/upgrade.sh            # 只重建并重启
#   bash deploy/scripts/upgrade.sh --pull     # 先 git pull 再升级
#
# 迁移由容器入口自动执行（RUN_MIGRATIONS=true），失败会直接退出。
# 回滚：用 backup 产出的归档跑 restore.sh，并 git checkout 到上一个 tag。
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.prod.yml"

log() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "缺少 $ENV_FILE"

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

if [[ "${1:-}" == "--pull" ]]; then
  log "拉取代码 ..."
  git -C "$ROOT" pull --ff-only
fi

log "升级前先备份（出问题还能回去）..."
bash "$ROOT/deploy/scripts/backup.sh"

log "构建镜像（数据库结构变化会在容器启动时自动迁移）..."
dc build api web

log "重启服务 ..."
dc up -d --remove-orphans

log "等待 API 健康 ..."
healthy=0
for _ in $(seq 1 90); do
  cid="$(dc ps -q api 2>/dev/null || true)"
  if [[ -n "$cid" ]]; then
    status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)"
    if [[ "$status" == "healthy" ]]; then healthy=1; break; fi
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo
  dc logs --tail=60 api
  die "API 未在 180 秒内变为 healthy。日志见上；回滚方式：bash deploy/scripts/restore.sh <备份文件>"
fi

ok "升级完成"
dc ps
