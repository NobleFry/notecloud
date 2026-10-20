#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# NoteCloud 服务管理：检测 / 启动 / 停止 / 重启 / 日志
#
#   bash deploy/scripts/service.sh             # 查看状态（默认）
#   bash deploy/scripts/service.sh start       # 启动
#   bash deploy/scripts/service.sh stop        # 停止（保留容器与数据）
#   bash deploy/scripts/service.sh restart     # 重启
#   bash deploy/scripts/service.sh down        # 删除容器（保留数据卷）
#   bash deploy/scripts/service.sh logs [服务] [-f]
#   bash deploy/scripts/service.sh check       # 环境自检
#
# 退出码：status / check 正常为 0，异常为 1，环境缺失为 2。
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.prod.yml"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"

log()  { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

PORT=""
PUBLIC_URL=""

load_env() {
  [[ -f "$ENV_FILE" ]] || return 1
  PORT="$(grep -E '^HTTP_PORT=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  PORT="${PORT:-8080}"
  PUBLIC_URL="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  PUBLIC_URL="${PUBLIC_URL:-http://localhost:${PORT}}"
  return 0
}

need_env() {
  if ! load_env; then
    err "缺少配置文件：$ENV_FILE"
    printf '  先执行一次部署：bash deploy/scripts/install.sh\n' >&2
    exit 2
  fi
}

need_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    err "缺少 Docker 或 compose 插件"
    printf '  安装：bash deploy/scripts/install-deps.sh\n' >&2
    exit 2
  fi
  if ! docker info >/dev/null 2>&1; then
    err "docker 守护进程不可用"
    printf '  sudo systemctl start docker\n' >&2
    exit 2
  fi
}

# 返回容器的状态与健康值，例如 "running healthy"
container_state() {
  local svc="$1" cid
  cid="$(dc ps -q "$svc" 2>/dev/null || true)"
  [[ -n "$cid" ]] || { echo "none none"; return 0; }
  docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$cid" 2>/dev/null || echo "none none"
}

http_code() {
  curl -fsS -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || true
}

wait_api_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) state health
  log "等待服务就绪（最多 ${HEALTH_TIMEOUT} 秒）..."
  while (( SECONDS < deadline )); do
    read -r state health <<<"$(container_state api)"
    if [[ "$health" == "healthy" ]]; then
      ok "API 已就绪"
      return 0
    fi
    if [[ "$state" == "exited" || "$state" == "dead" ]]; then
      err "API 容器已退出，最近 50 行日志："
      dc logs --tail=50 api || true
      return 1
    fi
    sleep 2
  done
  err "等待超时（${HEALTH_TIMEOUT}s），最近 50 行日志："
  dc logs --tail=50 api || true
  return 1
}

# ── status ───────────────────────────────────────────────────────
cmd_status() {
  need_docker
  if ! load_env; then
    warn "缺少 $ENV_FILE，无法读取端口，仅显示容器状态"
  fi

  printf '\n\033[1mNoteCloud 服务状态\033[0m\n'
  printf '────────────────────────────────\n'

  local all_ok=1 svc state health
  for svc in mysql api web; do
    read -r state health <<<"$(container_state "$svc")"
    if [[ "$state" == "none" ]]; then
      printf '  %-6s \033[33m未运行\033[0m\n' "$svc"
      all_ok=0
    elif [[ "$health" == "healthy" || "$health" == "-" ]]; then
      printf '  %-6s \033[32m%-8s %-8s\033[0m\n' "$svc" "$state" "$health"
    else
      printf '  %-6s \033[33m%-8s %-8s\033[0m\n' "$svc" "$state" "$health"
      all_ok=0
    fi
  done

  if [[ -n "$PORT" ]]; then
    local api_code web_code
    api_code="$(http_code "http://127.0.0.1:${PORT}/api/v1/site/status")"
    web_code="$(http_code "http://127.0.0.1:${PORT}/")"

    if [[ "$api_code" == "200" ]]; then
      printf '  API    \033[32mHTTP %s\033[0m\n' "$api_code"
    else
      printf '  API    \033[31mHTTP %s\033[0m\n' "${api_code:-无响应}"
      all_ok=0
    fi
    if [[ "$web_code" == "200" ]]; then
      printf '  Web    \033[32mHTTP %s\033[0m\n' "$web_code"
    else
      printf '  Web    \033[31mHTTP %s\033[0m\n' "${web_code:-无响应}"
      all_ok=0
    fi
    printf '────────────────────────────────\n'
    printf '  地址   %s\n\n' "$PUBLIC_URL"
  fi

  [[ "$all_ok" == "1" ]] && return 0 || return 1
}

# ── start / restart ──────────────────────────────────────────────
cmd_start() {
  need_env
  need_docker
  log "启动服务 ..."
  dc up -d --remove-orphans
  wait_api_healthy || { cmd_status || true; return 1; }
  cmd_status || return 1
}

cmd_restart() {
  need_env
  need_docker
  log "重启服务 ..."
  dc restart
  wait_api_healthy || { cmd_status || true; return 1; }
  cmd_status || return 1
}

# ── stop / down ──────────────────────────────────────────────────
cmd_stop() {
  need_env
  need_docker
  log "停止服务（保留容器与数据卷）..."
  dc stop
  ok "已停止。重新启动：bash deploy/scripts/service.sh start"
}

cmd_down() {
  need_env
  need_docker
  log "删除容器（数据卷与 .env 保留）..."
  dc down --remove-orphans
  ok "容器已删除。重新启动会自动按现有数据卷恢复：bash deploy/scripts/service.sh start"
}

# ── logs ─────────────────────────────────────────────────────────
cmd_logs() {
  need_env
  need_docker
  local svc="api" follow=""
  if [[ $# -gt 0 && "$1" != "-f" ]]; then
    svc="$1"; shift
  fi
  [[ "${1:-}" == "-f" ]] && follow="--follow"
  case "$svc" in
    api|web|mysql) ;;
    *) err "未知服务：$svc（可选 api / web / mysql）"; exit 2 ;;
  esac
  dc logs --tail=100 $follow "$svc"
}

# ── check ────────────────────────────────────────────────────────
cmd_check() {
  local rc=0

  printf '\n\033[1mNoteCloud 环境自检\033[0m\n'
  printf '────────────────────────────────\n'

  if command -v docker >/dev/null 2>&1; then
    ok "docker：$(docker --version | cut -d, -f1)"
  else
    err "docker：未安装（bash deploy/scripts/install-deps.sh）"; rc=2
  fi

  if docker info >/dev/null 2>&1; then
    ok "docker 守护进程：运行中"
  else
    err "docker 守护进程：不可用（sudo systemctl start docker）"; rc=2
  fi

  if docker compose version >/dev/null 2>&1; then
    ok "compose：$(docker compose version --short 2>/dev/null || echo 可用)"
  else
    err "compose：缺少插件"; rc=2
  fi

  if [[ -f "$ENV_FILE" ]]; then
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    ok ".env：存在"
    if grep -qE '__CHANGE_ME__|__GENERATE__' "$ENV_FILE"; then
      err ".env：仍有未替换的占位符"; rc=1
    else
      ok ".env：密钥已生成"
    fi
    load_env
  else
    err ".env：缺失（运行 install.sh 生成）"; rc=2
  fi

  if [[ -f "$ENV_FILE" ]]; then
    if dc config -q >/dev/null 2>&1; then
      ok "compose 配置：有效"
    else
      err "compose 配置：解析失败（检查 .env 中的密码与引号）"; rc=1
    fi
  fi

  local mem_mb swap_mb
  mem_mb="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  swap_mb="$(awk '/SwapTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  if [[ "$mem_mb" -gt 0 && "$mem_mb" -lt 1800 ]]; then
    if [[ "$swap_mb" -ge 1024 ]]; then
      warn "内存：${mem_mb}MB（已有 ${swap_mb}MB swap，可运行但偏慢）"
    else
      warn "内存：${mem_mb}MB，且 swap 不足（建议 2GB swap，见 docs/DEPLOY.md §8）"
    fi
  else
    ok "内存：${mem_mb}MB"
  fi

  if [[ -n "$PORT" ]]; then
    if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
      if [[ "$(container_state web | cut -d' ' -f1)" != "none" ]]; then
        ok "端口 ${PORT}：由 web 容器占用"
      else
        warn "端口 ${PORT}：被其它进程占用（可用 --port 换端口重装）"
        rc=1
      fi
    else
      ok "端口 ${PORT}：空闲或未监听"
    fi
  fi

  local state health
  read -r state health <<<"$(container_state api)"
  if [[ "$state" == "none" ]]; then
    warn "服务：未启动（bash deploy/scripts/service.sh start）"
  elif [[ "$health" == "healthy" ]]; then
    ok "服务：api healthy"
  else
    err "服务：api ${state}/${health}"; rc=1
  fi

  printf '────────────────────────────────\n'
  if [[ "$rc" == "0" ]]; then
    ok "自检通过"
  else
    err "自检发现需要处理的问题"
  fi
  return "$rc"
}

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

cmd="${1:-status}"
[[ $# -gt 0 ]] && shift || true

case "$cmd" in
  status)  cmd_status ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  down)    cmd_down ;;
  logs)    cmd_logs "$@" ;;
  check)   cmd_check ;;
  -h|--help|help) usage ;;
  *) err "未知命令：$cmd"; usage; exit 2 ;;
esac
