#!/usr/bin/env bash
# 快速启动/重启：迁移 → API + worker + 前端。
# 用法:
#   ./start.sh                        # 启动全部(已在运行的跳过)
#   ./start.sh --restart              # 重启全部
#   ./start.sh --restart api worker   # 只重启指定服务 (api | worker | web)
#   ./start.sh --skip-migrate         # 跳过迁移(迁移不变时更快)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER="$ROOT/apitest-server"
WEB="$ROOT/apitest-web"
LOG_DIR="$ROOT/.dev-logs"
PID_FILE="$ROOT/.dev-pids"
mkdir -p "$LOG_DIR"

RESTART=0
SKIP_MIGRATE=0
RESTART_SERVICES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --restart) RESTART=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    *)
      if [ "$RESTART" -eq 1 ]; then
        RESTART_SERVICES+=("$1")
      else
        echo "未知参数: $1 (支持 --restart [服务名...] / --skip-migrate)" >&2
        exit 1
      fi
      ;;
  esac
  shift
done

if [ "$RESTART" -eq 1 ]; then
  if [ "${#RESTART_SERVICES[@]}" -gt 0 ]; then
    echo "[restart] 重启: ${RESTART_SERVICES[*]}"
    # 复用 stop.sh 的停止逻辑, 服务名透传
    "$ROOT/stop.sh" "${RESTART_SERVICES[@]}"
  else
    echo "[restart] 重启全部服务"
    # bash 3.2 下空数组在 set -u 中展开会报错, 所以全量走无参分支
    "$ROOT/stop.sh"
  fi
fi

# Postgres/Redis 由外部常驻(如 OrbStack / docker 手动拉起), 脚本不再负责。
# 需要脚本代管时, 取消下面两行注释:
# echo "[1/3] Postgres + Redis (docker compose)"
# docker compose -f "$SERVER/compose.yaml" up -d --wait

if [ "$SKIP_MIGRATE" -eq 0 ]; then
  echo "[1/3] 数据库迁移"
  (cd "$SERVER" && pnpm migrate)
else
  echo "[1/3] 跳过迁移"
fi

# 记录在 pidfile 里且进程还活着, 才算"已在运行"
is_up() {
  local name="$1" pid
  pid="$(grep "^$name=" "$PID_FILE" 2>/dev/null | cut -d= -f2 | tail -1)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_one() {
  local name="$1" dir="$2"; shift 2
  if is_up "$name"; then
    echo "[2/3] $name 已在运行, 跳过"
    return
  fi
  echo "[2/3] 启动 $name"
  # 替换同名旧记录, 避免 pidfile 无限增长
  sed -i '' "/^$name=/d" "$PID_FILE" 2>/dev/null || true
  # 后台进程带 nohup, 终端退出后仍存活; 日志落在 .dev-logs/
  (cd "$dir" && nohup "$@" >"$LOG_DIR/$name.log" 2>&1 & echo "$name=$!" >> "$PID_FILE")
}

echo "[2/3] 应用进程"
start_one api    "$SERVER" pnpm dev
start_one worker "$SERVER" pnpm worker
start_one web    "$WEB" pnpm dev -- --host 0.0.0.0 --port 5173

wait_port() {
  local name="$1" port="$2" log="$3" waited=0
  until lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    if [ "$waited" -ge 60 ]; then
      echo "[3/3] $name 启动超时, 日志: $log" >&2
      return 1
    fi
    sleep 1; waited=$((waited + 1))
  done
  echo "[3/3] $name 就绪 (http://localhost:$port)"
}

echo "[3/3] 等待就绪"
wait_port "API"  3000 "$LOG_DIR/api.log" || true
wait_port "前端" 5173 "$LOG_DIR/web.log" || true
# worker 不监听端口, 用日志确认
sleep 1
if grep -q "consuming" "$LOG_DIR/worker.log" 2>/dev/null; then
  echo "[3/3] worker 就绪"
else
  echo "[3/3] worker 可能未就绪, 日志: $LOG_DIR/worker.log" >&2
fi

echo
echo "全部启动完成"
echo "  前端   http://localhost:5173"
echo "  后端   http://localhost:3000"
echo "  日志   $LOG_DIR"
echo "  停止   ./stop.sh"
