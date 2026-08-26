#!/usr/bin/env bash
# 快速停止。用法:
#   ./stop.sh               # 停全部
#   ./stop.sh api worker    # 只停指定服务 (api | worker | web)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/.dev-pids"

# 服务名 → 兜底清理的模式。tsx watch 与 vite 进程树在 pidfile 之外也可能有活口。
pattern_of() {
  case "$1" in
    api)    echo "watch src/index.ts" ;;
    worker) echo "watch src/worker.ts" ;;
    web)    echo "--port 5173" ;;
  esac
}

FULL=0
NAMES=("$@")
if [ "${#NAMES[@]}" -eq 0 ]; then
  FULL=1
  NAMES=(api worker web)
fi

wanted() {
  local name="$1"
  for each in "${NAMES[@]}"; do
    [ "$each" = "$name" ] && return 0
  done
  return 1
}

# 从最深的孩子往上杀: pnpm → sh → tsx → node 是树, 只杀父会留下孤儿
kill_tree() {
  local pid="$1"
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
}

if [ -f "$PID_FILE" ]; then
  while IFS='=' read -r name pid; do
    [ -n "${pid:-}" ] || continue
    wanted "$name" || continue
    if kill -0 "$pid" 2>/dev/null; then
      echo "[stop] $name (pid $pid)"
      kill_tree "$pid"
      # 把这条记录从 pidfile 移除, 部分停止时其余记录保留
      sed -i '' "/^$name=/d" "$PID_FILE" 2>/dev/null || true
    fi
  done < "$PID_FILE"
  if [ "$FULL" -eq 1 ]; then
    rm -f "$PID_FILE"
    echo "[stop] 已清理 pid 记录"
  fi
else
  echo "[stop] 无 pid 记录, 走残留清理"
fi

# 兜底: pidfile 之外可能还有活口(如进程被手动重启过)
cleanup() {
  local pattern="$1" label="$2"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    pkill -TERM -f "$pattern" >/dev/null 2>&1 || true
    echo "[stop] 清理残留 $label"
  fi
}
for name in "${NAMES[@]}"; do
  case "$name" in
    api)    cleanup "watch src/index.ts" "API" ;;
    worker) cleanup "watch src/worker.ts" "worker" ;;
    web)    cleanup "--port 5173" "前端" ;;
  esac
done

# Postgres/Redis 由外部常驻, 需要手动停止时执行:
# docker compose -f "$ROOT/apitest-server/compose.yaml" down
echo "[stop] 已停止: ${NAMES[*]} (Postgres/Redis 保持运行)"
