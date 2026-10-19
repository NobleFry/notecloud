#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# NoteCloud 开发环境基础设施管理（Docker 方案，首选）
#
#   bash deploy/scripts/devstack.sh up             启动 MySQL 8.4
#   bash deploy/scripts/devstack.sh up --profile tools   额外启动 Adminer
#   bash deploy/scripts/devstack.sh up --profile mail    额外启动 Mailpit
#   bash deploy/scripts/devstack.sh down           停止（保留数据）
#   bash deploy/scripts/devstack.sh reset          停止并删除数据卷（危险）
#   bash deploy/scripts/devstack.sh ps / logs / mysql / wait / url
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.dev.yml"
ENV_FILE="$ROOT/.env"

log()  { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── 前置检查 ─────────────────────────────────────────────────────
[[ -f "$ENV_FILE" ]] || die "缺少 $ENV_FILE —— 先执行: cp .env.example .env && 填写数据库密码"

if ! command -v docker >/dev/null 2>&1; then
  die "未找到 docker。安装方式见 docs/DEV.md（需要你本人执行 sudo）： 
     sudo pacman -S --needed docker docker-compose docker-buildx
     sudo systemctl enable --now docker
     sudo usermod -aG docker \$USER   # 之后重登录或执行 newgrp docker"
fi

if ! docker info >/dev/null 2>&1; then
  die "docker 守护进程不可访问。可能原因：
     1) 服务未启动:  sudo systemctl start docker
     2) 当前 shell 还没有 docker 组权限:  执行 'newgrp docker' 或注销重新登录"
fi

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# 从 .env 读一个变量（不 source 整个文件，避免密码里的特殊字符被 shell 解释）
envvar() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

wait_healthy() {
  local port; port="$(envvar MYSQL_PORT)"; port="${port:-3307}"
  log "等待 MySQL 就绪 (127.0.0.1:$port) ..."
  local i
  for i in $(seq 1 90); do
    if [[ "$(docker inspect -f '{{.State.Health.Status}}' notecloud-mysql-dev 2>/dev/null || echo none)" == "healthy" ]]; then
      ok "MySQL 已就绪"; return 0
    fi
    sleep 2
  done
  dc logs mysql | tail -40
  die "MySQL 在 180 秒内未就绪，上面是容器日志"
}

case "${1:-help}" in
  up)
    shift
    log "启动开发基础设施 ..."
    dc up -d "$@"
    wait_healthy
    port="$(envvar MYSQL_PORT)"; port="${port:-3307}"
    db="$(envvar MYSQL_DATABASE)"; user="$(envvar MYSQL_USER)"
    ok "MySQL:    mysql://${user}:****@127.0.0.1:${port}/${db}"
    if [[ " $* " == *" tools "* ]]; then ok "Adminer:  http://127.0.0.1:8080"; fi
    if [[ " $* " == *" mail "*  ]]; then ok "Mailpit:  http://127.0.0.1:8025"; fi
    ;;
  down)    shift; dc down "$@" ;;
  reset)
    shift
    printf '这会删除 notecloud-dev-mysql-data 卷里的全部数据，输入 yes 确认: '
    read -r ans; [[ "$ans" == "yes" ]] || die "已取消"
    dc down -v "$@"
    ok "数据卷已删除，下次 up 会重新初始化"
    ;;
  restart) shift; dc restart "$@" ;;
  ps|status) dc ps ;;
  logs)    shift; dc logs -f --tail=100 "$@" ;;
  wait)    wait_healthy ;;
  url)
    port="$(envvar MYSQL_PORT)"; port="${port:-3307}"
    db="$(envvar MYSQL_DATABASE)"; user="$(envvar MYSQL_USER)"
    echo "mysql://${user}@127.0.0.1:${port}/${db}"
    ;;
  mysql)
    port="$(envvar MYSQL_PORT)"; port="${port:-3307}"
    db="$(envvar MYSQL_DATABASE)"; user="$(envvar MYSQL_USER)"
    pw="$(envvar MYSQL_PASSWORD)"
    log "连接 $db (Ctrl-D 退出)"
    exec docker exec -it notecloud-mysql-dev mysql -h 127.0.0.1 -u"$user" -p"$pw" "$db"
    ;;
  check)
    log "自检：版本 / 字符集 / ngram 分词器"
    port="$(envvar MYSQL_PORT)"; port="${port:-3307}"
    dc exec -T mysql mysql -h 127.0.0.1 -uroot -p"$(envvar MYSQL_ROOT_PASSWORD)" -e \
      "SELECT VERSION() AS version;
       SHOW VARIABLES LIKE 'character_set_server';
       SHOW VARIABLES LIKE 'collation_server';
       SHOW VARIABLES LIKE 'ngram_token_size';"
    ;;
  *)
    sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
esac
