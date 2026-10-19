#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# NoteCloud 一键部署
#
#   bash deploy/scripts/install.sh
#   bash deploy/scripts/install.sh --domain note.example.com --port 443
#   bash deploy/scripts/install.sh --with-backup
#
# 它会做：
#   1. 检查 Docker / compose / 端口占用（加 --install-deps 可自动装 Docker）
#   2. 没有 .env 就生成一份（随机密码 + 随机 JWT 密钥）
#   3. 内存不足时补 2GB swap（--no-swap 可跳过），并降低 MySQL buffer pool
#   4. 构建并启动 nginx + api + mysql
#   5. 等 api 健康，失败就打印日志
#   6. 可选：装每日备份的 cron
#
# 不会做：申请 HTTPS 证书（需要域名与 80 端口，见 docs/DEPLOY.md §3）
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.prod.yml"

DOMAIN=""
PORT=""
WITH_BACKUP=0
SKIP_BUILD=0
INSTALL_DEPS=0
NO_SWAP=0

log()  { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)       DOMAIN="${2:?--domain 需要一个值}"; shift 2 ;;
    --port)         PORT="${2:?--port 需要一个值}"; shift 2 ;;
    --with-backup)  WITH_BACKUP=1; shift ;;
    --no-build)     SKIP_BUILD=1; shift ;;
    --no-swap)      NO_SWAP=1; shift ;;
    --install-deps) INSTALL_DEPS=1; shift ;;
    -h|--help)      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# ── 1. 环境检查与依赖安装 ───────────────────────────────────────
log "检查运行环境 ..."

need_docker=0
command -v docker >/dev/null 2>&1 || need_docker=1
docker compose version >/dev/null 2>&1 || need_docker=1

if [[ "$need_docker" == "1" ]]; then
  if [[ "$INSTALL_DEPS" == "1" ]]; then
    log "缺少 Docker / Compose，开始安装依赖 ..."
    bash "$ROOT/deploy/scripts/install-deps.sh"
    echo
    # 组权限对新会话才生效，当前 shell 通常还不能用
    docker info >/dev/null 2>&1 || die "依赖已安装，但当前 shell 还没有 docker 权限。

请执行下面任一操作后重跑本脚本：
    newgrp docker      # 当前终端临时生效
    注销并重新登录      # 永久生效"
  else
    die "缺少 Docker 或 compose 插件。两种方式：

  1) 自动安装（Debian / Ubuntu / Arch，需要 sudo）：
       bash deploy/scripts/install.sh --install-deps

  2) 只装依赖：
       bash deploy/scripts/install-deps.sh

  3) 手动安装参考 docs/DEPLOY.md §0"
  fi
fi

docker info >/dev/null 2>&1 || die "docker 守护进程不可用。

  · 没启动？    sudo systemctl start docker
  · 刚加入组？  newgrp docker 或重新登录
  · 自检：      bash deploy/scripts/install-deps.sh --check"

[[ -f "$COMPOSE_FILE" ]] || die "找不到 $COMPOSE_FILE"
command -v openssl >/dev/null 2>&1 || die "缺少 openssl（用来生成密钥）。Debian/Ubuntu: sudo apt-get install -y openssl"

MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
SWAP_MB="$(awk '/SwapTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"

LOW_MEM=0
if [[ "$MEM_MB" -gt 0 && "$MEM_MB" -lt 1800 ]]; then
  LOW_MEM=1
  warn "内存只有 ${MEM_MB}MB（建议 2GB 以上）"
fi

# 前端构建里 vue-tsc 峰值约 600MB，1GB 机器会把 Node 堆打满。
# 内存不足且没有 swap 时补一个 2GB swapfile；--no-swap 可跳过。
if [[ "$LOW_MEM" == "1" && "$SWAP_MB" -lt 1024 && "$NO_SWAP" == "0" ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    warn "swap 只有 ${SWAP_MB}MB，构建可能内存不足。请以 root 执行："
    warn "  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
    warn "  echo '/swapfile none swap sw 0 0' >> /etc/fstab"
  else
    log "swap 只有 ${SWAP_MB}MB，创建 2GB swapfile ..."
    if [[ -e /swapfile ]]; then
      swapon /swapfile 2>/dev/null || true
    else
      fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
      swapon /swapfile
    fi
    grep -qE '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap 已启用"
  fi
fi

# ── 2. 生成 / 检查 .env ─────────────────────────────────────────
gen_pw()   { openssl rand -base64 32 | tr -d '/+=' | cut -c1-24; }
gen_token() { openssl rand -base64 48 | tr -d '\n'; }

if [[ -f "$ENV_FILE" ]]; then
  log ".env 已存在，沿用（不覆盖）"
else
  log "生成 .env（随机数据库密码 + 随机 JWT 密钥）..."
  [[ -f "$ROOT/.env.example" ]] || die "缺少 .env.example"

  DB_PW="$(gen_pw)"
  ROOT_PW="$(gen_pw)"
  JWT="$(gen_token)"

  sed -e "s|__CHANGE_ME_ROOT__|${ROOT_PW}|g" \
      -e "s|__CHANGE_ME__|${DB_PW}|g" \
      -e "s|__GENERATE__|${JWT}|g" \
      "$ROOT/.env.example" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok ".env 已生成（权限 600）"
fi

# 端口：命令行 > .env > 默认 8080
if [[ -z "$PORT" ]]; then
  PORT="$(grep -E '^HTTP_PORT=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  PORT="${PORT:-8080}"
fi

# 对外地址：域名 > .env 的 PUBLIC_URL > 猜 IP
PUBLIC_URL=""
if [[ -n "$DOMAIN" ]]; then
  PUBLIC_URL="https://${DOMAIN}"
else
  PUBLIC_URL="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
fi

if [[ -z "$PUBLIC_URL" || "$PUBLIC_URL" == "http://localhost:8080" ]]; then
  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
  IP="${IP:-localhost}"
  PUBLIC_URL="http://${IP}:${PORT}"
  warn "没有指定域名，PUBLIC_URL 自动设为 ${PUBLIC_URL}"
fi

# 写回 .env（只改这两项，其它保持不动）
upsert_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

upsert_env HTTP_PORT "$PORT"
upsert_env PUBLIC_URL "$PUBLIC_URL"

if [[ "$LOW_MEM" == "1" ]]; then
  # 512MB buffer pool 在 1GB 机器上会和 Node 抢内存
  upsert_env MYSQL_BUFFER_POOL 256M
fi

# 占位符还没替换掉（用户手工 cp 了模板）
if grep -qE '__CHANGE_ME__|__GENERATE__' "$ENV_FILE"; then
  die ".env 里还有未替换的占位符（__CHANGE_ME__ / __GENERATE__）。请填好后重跑，或删掉 .env 让脚本重新生成"
fi

# ── 3. 端口占用 ─────────────────────────────────────────────────
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  die "端口 ${PORT} 已被占用。换一个：--port 8081"
fi

# ── 4. 构建 & 启动 ──────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "1" ]]; then
  log "跳过构建，直接启动 ..."
  dc up -d
else
  BUILD_ARGS=()
  if [[ "$LOW_MEM" == "1" ]]; then
    warn "低内存模式：构建跳过类型检查（CI 会检查），MySQL buffer pool 用 256MB"
    BUILD_ARGS+=(--build-arg TYPECHECK=0)
  fi
  log "构建镜像（首次约 3~6 分钟）..."
  dc build "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}"
  log "启动服务 ..."
  dc up -d
fi

# ── 5. 等健康 ───────────────────────────────────────────────────
log "等待 MySQL 与 API 就绪 ..."
healthy=0
for _ in $(seq 1 150); do
  cid="$(dc ps -q api 2>/dev/null || true)"
  if [[ -n "$cid" ]]; then
    st="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)"
    if [[ "$st" == "healthy" ]]; then healthy=1; break; fi
    # 已经退出就不用再等
    running="$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo false)"
    [[ "$running" == "false" ]] && break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo
  warn "API 没能在 300 秒内变为 healthy，最近 50 行日志："
  dc logs --tail=50 api || true
  echo
  die "部署失败。常见原因：数据库密码含特殊字符、JWT_SECRET 太短、端口被占用"
fi

ok "API 已就绪"

# ── 6. 可选：每日备份 ───────────────────────────────────────────
if [[ "$WITH_BACKUP" == "1" ]]; then
  if ! command -v crontab >/dev/null 2>&1; then
    warn "没有 crontab，跳过备份定时任务。可手动加到 systemd timer"
  else
    log "安装每日备份 cron（3:30，保留 14 份）..."
    CRON_LINE="30 3 * * * cd $ROOT && BACKUP_DIR=$ROOT/backups KEEP=14 bash deploy/scripts/backup.sh >> $ROOT/backups/backup.log 2>&1"
    mkdir -p "$ROOT/backups"
    ( crontab -l 2>/dev/null | grep -vF "deploy/scripts/backup.sh"; echo "$CRON_LINE" ) | crontab -
    ok "已安装（crontab -l 可查看）"
  fi
fi

# ── 7. 汇总 ─────────────────────────────────────────────────────
echo
printf '\033[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m\n'
printf '  NoteCloud 已启动\n'
printf '\033[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m\n'
echo
echo "  访问地址 : ${PUBLIC_URL}"
echo "  本机地址 : http://localhost:${PORT}"
echo "  配置文件 : ${ENV_FILE}"
echo "  数据卷   : notecloud-prod-mysql-data / notecloud-prod-uploads"
echo
echo "  首次打开会跳转 /setup，创建的第一个账号是站点管理员。"
echo
echo "  常用命令："
echo "    dc() { docker compose --env-file .env -f deploy/compose/docker-compose.prod.yml \"\$@\"; }"
echo "    dc ps"
echo "    dc logs -f api"
echo "    bash deploy/scripts/backup.sh"
echo "    bash deploy/scripts/upgrade.sh"
echo
if [[ -n "$DOMAIN" ]]; then
  warn "你指定了域名，但 HTTPS 证书还需要单独申请：见 docs/DEPLOY.md §3"
fi
