#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# 一键端到端冒烟测试
#
#   bash deploy/scripts/smoke.sh
#   SMOKE_PORT=3200 bash deploy/scripts/smoke.sh
#
# 做的事：重建 notecloud_test → 迁移 → 起一个临时 API 实例 → 跑 smoke.mjs → 清理
#
# 为什么每次都重建测试库：冒烟测试的第一个断言依赖"库里没有任何用户"
# （首个注册用户自动成为管理员）。不重建就会在注册这一步被 40310 拦下。
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
CONTAINER="${MYSQL_CONTAINER:-notecloud-mysql-dev}"
PORT="${SMOKE_PORT:-3100}"
LOG="${TMPDIR:-/tmp}/notecloud-smoke-api.log"
# 测试上传的文件写到临时目录，别污染开发环境的 data/uploads
UPLOAD_DIR_SMOKE="${TMPDIR:-/tmp}/notecloud-smoke-uploads"

log() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "缺少 $ROOT/.env"

# 从 .env 取一个值（不 source，避免密码里的特殊字符被 shell 解释）
envvar() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

DB_PW="$(envvar MYSQL_PASSWORD)"
ROOT_PW="$(envvar MYSQL_ROOT_PASSWORD)"
[[ -n "$DB_PW" && -n "$ROOT_PW" ]] || die ".env 里缺少 MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD"

docker inspect "$CONTAINER" >/dev/null 2>&1 || die "容器 $CONTAINER 不存在，先执行 pnpm dev:db"

API_PID=""
cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  rm -rf "$UPLOAD_DIR_SMOKE"
}
trap cleanup EXIT

if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  die "端口 $PORT 已被占用，换一个：SMOKE_PORT=3200 bash deploy/scripts/smoke.sh"
fi

log "重建测试库 notecloud_test ..."
docker exec "$CONTAINER" mysql -uroot -p"$ROOT_PW" -e "
  DROP DATABASE IF EXISTS \`notecloud_test\`;
  CREATE DATABASE \`notecloud_test\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  GRANT ALL PRIVILEGES ON \`notecloud_test\`.* TO 'notecloud'@'%';
  FLUSH PRIVILEGES;" 2>/dev/null
ok "测试库已重建（主库 notecloud 未受影响）"

TEST_URL="mysql://notecloud:${DB_PW}@127.0.0.1:3307/notecloud_test"

log "迁移测试库 ..."
DATABASE_URL="$TEST_URL" pnpm --filter @notecloud/api run db:deploy >/dev/null 2>&1
ok "迁移完成（含全文索引自愈）"

log "启动临时 API 实例 (:$PORT) ..."
DATABASE_URL="$TEST_URL" API_PORT="$PORT" NODE_ENV=test UPLOAD_DIR="$UPLOAD_DIR_SMOKE" \
  pnpm --filter @notecloud/api exec tsx src/index.ts >"$LOG" 2>&1 &
API_PID=$!

ready=0
for _ in $(seq 1 60); do
  if curl -sf --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == "1" ]] || { tail -30 "$LOG"; die "API 未能启动，日志见 $LOG"; }
ok "实例就绪"

BASE="http://127.0.0.1:$PORT/api/v1" node "$ROOT/deploy/scripts/smoke.mjs"
