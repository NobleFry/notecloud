#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# 安装系统依赖：Docker Engine + Compose v2 + openssl + curl
#
#   bash deploy/scripts/install-deps.sh          # 需要 sudo
#   bash deploy/scripts/install-deps.sh --check   # 只检查，不改系统
#
# 支持：Debian / Ubuntu（及其衍生版）、Arch / Manjaro
# 其它发行版会给出提示并退出（不自作主张改系统）。
#
# 为什么不用 `curl https://get.docker.com | sh`：
#   那等于把 root 权限交给一个远程脚本。这里用官方 apt 仓库 / 官方包管理器，
#   每一步都可审计。
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

log()  { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ── 现状检查 ─────────────────────────────────────────────────────
report() {
  local missing=0

  if have docker; then
    printf '  docker        : %s\n' "$(docker --version 2>/dev/null | head -1)"
  else
    printf '  docker        : \033[31m缺失\033[0m\n'; missing=1
  fi

  if docker compose version >/dev/null 2>&1; then
    printf '  compose       : %s\n' "$(docker compose version 2>/dev/null | head -1)"
  else
    printf '  compose       : \033[31m缺失\033[0m\n'; missing=1
  fi

  if have openssl; then
    printf '  openssl       : %s\n' "$(openssl version 2>/dev/null | head -1)"
  else
    printf '  openssl       : \033[31m缺失\033[0m\n'; missing=1
  fi

  if have curl; then
    printf '  curl          : ok\n'
  else
    printf '  curl          : \033[31m缺失\033[0m\n'; missing=1
  fi

  if docker info >/dev/null 2>&1; then
    printf '  守护进程      : 可用\n'
  else
    printf '  守护进程      : \033[33m不可用（未启动 或 当前用户不在 docker 组）\033[0m\n'
    missing=1
  fi

  return "$missing"
}

# ── 识别发行版 ──────────────────────────────────────────────────
[[ -f /etc/os-release ]] || die "找不到 /etc/os-release，无法识别发行版"
# shellcheck disable=SC1091
. /etc/os-release
DISTRO_ID="${ID:-unknown}"
DISTRO_LIKE="${ID_LIKE:-}"

log "发行版：${PRETTY_NAME:-$DISTRO_ID}"
echo "当前环境："
if report; then
  ok "依赖已齐备，无需安装"
  exit 0
fi

[[ "$CHECK_ONLY" == "1" ]] && die "有缺失项（--check 模式，未做任何修改）"

# ── 需要 root ────────────────────────────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
  log "需要 root 权限，尝试用 sudo 重新执行 ..."
  exec sudo -E bash "$0" "$@"
fi

# 谁在调用（sudo 下 $USER 是 root，要取真实用户）
TARGET_USER="${SUDO_USER:-${USER:-root}}"

install_debian_like() {
  local repo_id="$1"

  log "安装基础工具 ..."
  apt-get update -qq
  apt-get install -y ca-certificates curl gnupg

  log "添加 Docker 官方 apt 仓库（${repo_id}）..."
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL "https://download.docker.com/linux/${repo_id}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi

  local codename arch
  codename="${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}"
  [[ -n "$codename" ]] || die "无法确定发行版代号（VERSION_CODENAME），请手动安装 Docker"
  arch="$(dpkg --print-architecture)"

  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${repo_id} ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  log "安装 Docker Engine 与 Compose 插件 ..."
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  systemctl enable --now docker
}

install_arch() {
  log "安装 Docker（pacman）..."
  pacman -Sy --needed --noconfirm docker docker-compose docker-buildx
  systemctl enable --now docker
}

case "$DISTRO_ID" in
  debian|ubuntu)
    install_debian_like "$DISTRO_ID"
    ;;
  arch|manjaro|endeavouros)
    install_arch
    ;;
  *)
    if [[ "$DISTRO_LIKE" == *debian* || "$DISTRO_LIKE" == *ubuntu* ]]; then
      # 衍生版（linuxmint、pop 等）用上游仓库
      if [[ "$DISTRO_LIKE" == *ubuntu* ]]; then
        install_debian_like ubuntu
      else
        install_debian_like debian
      fi
    else
      die "不支持的发行版：${DISTRO_ID}。请参考 docs/DEPLOY.md §0 手动安装 Docker 24+ 与 compose v2"
    fi
    ;;
esac

# ── 把调用者加入 docker 组 ──────────────────────────────────────
if [[ -n "$TARGET_USER" && "$TARGET_USER" != "root" ]]; then
  if id -nG "$TARGET_USER" | grep -qw docker; then
    ok "$TARGET_USER 已在 docker 组"
  else
    log "把 $TARGET_USER 加入 docker 组 ..."
    usermod -aG docker "$TARGET_USER"
    NEED_RELOGIN=1
  fi
fi

# ── 收尾 ────────────────────────────────────────────────────────
echo
if ! docker info >/dev/null 2>&1; then
  warn "当前 shell 还没有 docker 权限（组变更只对新会话生效）"
  echo
  echo "  执行下面任一操作后重跑部署脚本："
  echo "    newgrp docker          # 当前终端临时生效"
  echo "    注销并重新登录          # 永久生效"
  echo
  exit 0
fi

ok "依赖安装完成"
echo
docker --version
docker compose version
