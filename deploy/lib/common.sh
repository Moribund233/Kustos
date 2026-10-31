#!/usr/bin/env bash
# =============================================================================
# Kustos 部署脚本公共库
#
# install.sh / mgt.sh / kustos.sh 共用的路径推导、色彩与日志、.env 读写、
# Docker 前置检查、compose 包装、健康等待与全局命令安装。
#
# 约定：
#   - 调用方已 `set -euo pipefail`，本库不得引用未定义变量；
#   - 日志一律写 stderr，避免污染调用方的 $(...) 捕获；
#   - 只依赖 bash + docker + coreutils，不引入额外运行时。
# =============================================================================

# 仓库根：deploy/lib/common.sh → deploy/ → 仓库根
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.yml"
MONITORING_COMPOSE_FILE="$PROJECT_ROOT/docker-compose.monitoring.yml"
# compose 项目名固定，避免因为调用目录不同产生多套容器/卷
COMPOSE_PROJECT="${KUSTOS_COMPOSE_PROJECT:-kustos}"

# ---------------------------------------------------------------------------
# 色彩（仅在 tty 上启用，日志重定向到文件时不带转义序列）
# ---------------------------------------------------------------------------
if [[ -t 2 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
else
  C_RESET="" C_BOLD="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW="" C_BLUE=""
fi

# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------
log_info() { printf '%s[INFO]%s %s\n' "$C_BLUE" "$C_RESET" "$*" >&2; }
log_ok() { printf '%s[ OK ]%s %s\n' "$C_GREEN" "$C_RESET" "$*" >&2; }
log_warn() { printf '%s[WARN]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
log_error() { printf '%s[FAIL]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }

# 致命错误：打印并退出。调用方不必再写 `exit 1`。
die() {
  log_error "$*"
  exit 1
}

# ---------------------------------------------------------------------------
# .env 读写
#
# 读写都按「键在行首」定位；值里允许出现 = / 空格 / 引号，不做转义处理，
# 与 docker compose 的 .env 解析保持一致（不展开变量）。
# ---------------------------------------------------------------------------

# 读取单个键的值；不存在时输出空串且不报错。
env_get() {
  local key="${1:?env_get 需要键名}"
  [[ -f "$ENV_FILE" ]] || return 0
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -z "$line" ]] && return 0
  local value="${line#*=}"
  value="${value%$'\r'}"
  # 去掉成对的首尾引号
  if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

# 写入/覆盖单个键（文件不存在则创建，权限固定 600）。
set_env_key() {
  local key="${1:?set_env_key 需要键名}"
  local value="${2-}"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$ENV_FILE" ]]; then
    grep -v -E "^${key}=" "$ENV_FILE" > "$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
  chmod 600 "$ENV_FILE"
}

# 仅补全缺失键：`ensure_env_keys KEY=VALUE [KEY2=VALUE2 ...]`。
# 已存在的键（即使值为空）保持原样，避免覆盖用户设置。
ensure_env_keys() {
  local pair key value
  for pair in "$@"; do
    key="${pair%%=*}"
    value="${pair#*=}"
    if [[ ! -f "$ENV_FILE" ]] || ! grep -q -E "^${key}=" "$ENV_FILE"; then
      set_env_key "$key" "$value"
    fi
  done
}

# ---------------------------------------------------------------------------
# 前置检查
# ---------------------------------------------------------------------------
require_docker() {
  command -v docker >/dev/null 2>&1 \
    || die "未找到 docker。请先安装 Docker Engine 20.10+：https://docs.docker.com/engine/install/"
  if ! docker info >/dev/null 2>&1; then
    die "无法连接 Docker 守护进程（当前用户无权限或服务未启动）。尝试: sudo systemctl start docker"
  fi
}

require_compose_v2() {
  if ! docker compose version >/dev/null 2>&1; then
    die "未找到 Docker Compose V2（docker compose 子命令）。旧版 docker-compose 不受支持。"
  fi
}

require_python() {
  command -v python3 >/dev/null 2>&1 \
    || die "未找到 python3：.env 生成与初始化脚本需要它（Debian/Ubuntu: apt install python3）"
}

# 校验 .env 中 compose 的必需变量（与 compose 里的 ${VAR:?} 保持同源）。
# 可用 KUSTOS_REQUIRED_ENV 覆盖（空格分隔）。
require_env() {
  local required="${KUSTOS_REQUIRED_ENV:-POSTGRES_PASSWORD KUSTOS_SECURITY_SECRET_KEY KUSTOS_ADMIN_PASSWORD KUSTOS_COLLAB_INTERNAL_SECRET KUSTOS_GIT_HOOK_SECRET}"
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE 不存在，请先运行: python3 deploy/generate_env.py --prod"
  local key missing=()
  for key in $required; do
    [[ -n "$(env_get "$key")" ]] || missing+=("$key")
  done
  if ((${#missing[@]} > 0)); then
    die ".env 缺少必需变量: ${missing[*]}（可运行 python3 deploy/generate_env.py 补全）"
  fi
}

# ---------------------------------------------------------------------------
# compose 包装
#
# 统一 -p（项目名）与 -f（主文件）。调用方自己传了 -f/--file 时不再注入，
# 例如 `compose -f docker-compose.monitoring.yml up -d` 只启动监控栈。
# ---------------------------------------------------------------------------
compose() {
  local -a base=(-p "$COMPOSE_PROJECT")
  local arg has_file=false
  for arg in "$@"; do
    if [[ "$arg" == "-f" || "$arg" == "--file" ]]; then
      has_file=true
      break
    fi
  done
  [[ "$has_file" == true ]] || base+=(-f "$COMPOSE_FILE")
  docker compose "${base[@]}" "$@"
}

# 镜像前缀：为空表示本地构建（kustos-*），非空表示私有仓库（<prefix>-*）。
image_prefix() {
  if [[ -n "${KUSTOS_IMAGE_PREFIX:-}" ]]; then
    printf '%s' "$KUSTOS_IMAGE_PREFIX"
    return 0
  fi
  env_get KUSTOS_IMAGE_PREFIX
}

# 构建或拉取业务镜像；tag 由 .env 的 KUSTOS_IMAGE_TAG 决定。
build_images() {
  local prefix tag
  prefix="$(image_prefix)"
  tag="$(env_get KUSTOS_IMAGE_TAG)"
  tag="${tag:-latest}"
  if [[ -n "$prefix" ]]; then
    log_info "拉取镜像 ${prefix}-*:${tag} ..."
    compose pull app collab gateway git-cgi sshd || die "镜像拉取失败"
  else
    log_info "本地构建镜像 kustos-*:${tag} ..."
    compose build || die "镜像构建失败"
  fi
}

# 等待容器健康。参数：容器名 超时秒数。
# 无 healthcheck 的容器按 running 视为就绪；容器退出/死亡立即失败。
wait_healthy() {
  local name="${1:?wait_healthy 需要容器名}"
  local timeout="${2:-180}"
  local status elapsed=0
  log_info "等待 ${name} 就绪（最多 ${timeout}s）..."
  while ((elapsed < timeout)); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo "missing")"
    case "$status" in
      healthy | running)
        log_ok "${name} 已就绪"
        return 0
        ;;
      exited | dead)
        die "${name} 已退出（${status}），请查看: docker logs ${name}"
        ;;
      unhealthy)
        die "${name} 健康检查失败，请查看: docker logs ${name}"
        ;;
    esac
    sleep 1
    elapsed=$((elapsed + 1))
  done
  die "等待 ${name} 超时（${timeout}s），请查看: docker logs ${name}"
}

# 安装全局 kustos 命令（软链到 /usr/local/bin）。无 sudo 权限时返回 1，由调用方降级为警告。
install_global_cli() {
  local src="$PROJECT_ROOT/deploy/kustos.sh"
  local target="/usr/local/bin/kustos"
  [[ -f "$src" ]] || return 1
  chmod +x "$src" 2>/dev/null || true
  if [[ -w "$(dirname "$target")" ]]; then
    ln -sf "$src" "$target" || return 1
  elif sudo -n true >/dev/null 2>&1; then
    sudo -n ln -sf "$src" "$target" || return 1
  else
    log_warn "无写入 /usr/local/bin 的权限（需要 sudo），已跳过全局命令安装"
    return 1
  fi
  log_ok "已安装全局命令: kustos → $src"
}

# ---------------------------------------------------------------------------
# 交互辅助
# ---------------------------------------------------------------------------

# 读一行输入，空输入取默认值；输出到 stdout 供 $(...) 捕获。
prompt_value() {
  local label="${1:?prompt_value 需要标签}"
  local default="${2-}"
  local value=""
  printf '%s [%s]: ' "$label" "$default" >&2
  IFS= read -r value || value=""
  printf '%s' "${value:-$default}"
}

# 是/否提问，返回码 0=是，1=否。默认值 y 时显示 [Y/n]。
prompt_yes_no() {
  local question="${1:?prompt_yes_no 需要问题}"
  local default="${2:-n}"
  local hint="[y/N]" answer=""
  [[ "$default" == "y" ]] && hint="[Y/n]"
  printf '%s %s ' "$question" "$hint" >&2
  IFS= read -r answer || answer=""
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy] ]]
}

# 危险操作确认：默认否。
confirm() {
  prompt_yes_no "$1" "n"
}

# 首装交互判定：倒计时内按 Enter 进入自定义配置。
# 返回 0 = 用默认部署；1 = 进入自定义；非交互终端一律 0。
interactive_prompt_or_default() {
  local seconds="${1:-5}"
  if [[ ! -t 0 ]]; then
    return 0
  fi
  printf '%s%s 秒内按 Enter 进入自定义配置，否则使用默认部署…%s ' "$C_DIM" "$seconds" "$C_RESET" >&2
  local answer=""
  if IFS= read -r -t "$seconds" answer; then
    return 1
  fi
  printf '\n' >&2
  return 0
}
