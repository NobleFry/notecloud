#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# 重置任意账号的密码（运维逃生口）
#
#   bash deploy/scripts/reset-password.sh you@example.com
#   bash deploy/scripts/reset-password.sh you@example.com 'MyNewPass123'
#
# 为什么需要它：项目没有接 SMTP，所以没有"忘记密码"邮件。
# 所有管理员都进不去时，只能靠这个脚本从宿主机改库。
# 改完会吊销该账号的全部会话。
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.prod.yml"

log() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

EMAIL="${1:-}"
NEW_PASSWORD="${2:-}"
[[ -n "$EMAIL" ]] || die "用法: $0 <email> [新密码]"
[[ -f "$ENV_FILE" ]] || die "缺少 $ENV_FILE"

if [[ -z "$NEW_PASSWORD" ]]; then
  NEW_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-16)"
fi

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

log "用容器内的 argon2 计算密码哈希 ..."
HASH="$(
  dc exec -T -e PW="$NEW_PASSWORD" api \
    node --input-type=module -e "
      import { hash } from '@node-rs/argon2';
      process.stdout.write(
        await hash(process.env.PW, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 })
      );
    " | tr -d '\r\n'
)"

[[ -n "$HASH" ]] || die "哈希计算失败"

log "更新密码并吊销会话 ..."
SQL="UPDATE users SET passwordHash = '${HASH}' WHERE email = '${EMAIL}';"
SQL="${SQL}
UPDATE sessions s JOIN users u ON u.id = s.userId
  SET s.revokedAt = NOW()
  WHERE u.email = '${EMAIL}' AND s.revokedAt IS NULL;"

printf '%s\n' "$SQL" | dc exec -T mysql sh -c \
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'

ok "已重置 ${EMAIL} 的密码"
echo
echo "  邮箱: ${EMAIL}"
echo "  密码: ${NEW_PASSWORD}"
echo
echo "登录后请立刻在「安全设置」里改掉。"
