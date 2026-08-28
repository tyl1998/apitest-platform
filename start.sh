#!/usr/bin/env bash
# 快速启动/重启：迁移 → API + worker + 调度器 + 前端。
# 用法:
#   ./start.sh                        # 启动全部(已在运行的跳过)
#   ./start.sh --restart              # 重启全部
#   ./start.sh --restart api worker   # 只重启指定服务 (api | worker | scheduler | web)
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

# 企业内部 CA（*.example.net 等内网 https 域名）：Node 不读 macOS 系统钥匙串，
# 没有这份 PEM 时 fetch 会报 SELF_SIGNED_CERT_IN_CHAIN。文件存在才注入，
# 不存在则保持原生行为（公共 CA 站点不受影响）。
# macOS 公司机器：钥匙串里有 MDM 下发的企业 CA，缺文件时下面会自动导出（自愈）。
# Linux / 无钥匙串的机器：需要把 example-ca.pem 随部署带到同路径 —— CA 证书是
# 公开材料不是密钥，可以直接进部署包或仓库。
# 手动重新生成（企业 CA 轮换后）：
#   security find-certificate -a -c "example" -p /Library/Keychains/System.keychain \
#     | awk '/BEGIN CERT/,/END CERT/' > .dev-certs/example-ca.pem
CA_BUNDLE="$ROOT/.dev-certs/example-ca.pem"
if [ ! -f "$CA_BUNDLE" ] && command -v security >/dev/null 2>&1; then
  mkdir -p "$ROOT/.dev-certs"
  security find-certificate -a -c "example" -p /Library/Keychains/System.keychain 2>/dev/null \
    | awk '/BEGIN CERT/,/END CERT/' > "$CA_BUNDLE"
  # 非公司机器导出为空文件, 删掉以免注入空 PEM
  [ -s "$CA_BUNDLE" ] || rm -f "$CA_BUNDLE"
fi
if [ -f "$CA_BUNDLE" ]; then
  export NODE_EXTRA_CA_CERTS="$CA_BUNDLE"
  echo "[env] NODE_EXTRA_CA_CERTS=$CA_BUNDLE"
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
start_one api       "$SERVER" pnpm dev
start_one worker    "$SERVER" env WORKER_LABELS=default pnpm worker
# 调度器（P3-4）：第三个进程。cron 认领/漏跑判定/告警派发都在它里面；多实例安全但
# 推荐单实例。改后端调度逻辑后 ./start.sh --restart scheduler 即可单独回收它。
start_one scheduler "$SERVER" pnpm scheduler
start_one web       "$WEB" pnpm dev -- --host 0.0.0.0 --port 5173

# 执行分区（P2-8）：上面这个 worker 只服务 default 分区（本机所在网段）。指向别的网段的
# 环境需要在**那个网段的机器上**另起一个 worker，本脚本不自动拉起 —— 那台机器不在本地：
#
#   # 在生产网段的机器上（需能出站到本平台的 Redis 6379 与 Postgres 5432）
#   cd apitest-server
#   WORKER_LABELS=prod-dmz pnpm worker
#
# 本机想临时同时服务两个分区（仅开发便利，容量会按标签数均分）：
#
#   WORKER_LABELS=default,prod-dmz pnpm worker

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
# 调度器同样只看日志：启动行会打出 tick 与宽限期参数
if grep -q "ticking every" "$LOG_DIR/scheduler.log" 2>/dev/null; then
  echo "[3/3] 调度器就绪"
else
  echo "[3/3] 调度器可能未就绪, 日志: $LOG_DIR/scheduler.log" >&2
fi

echo
echo "全部启动完成"
echo "  前端   http://localhost:5173"
echo "  后端   http://localhost:3000"
echo "  日志   $LOG_DIR"
echo "  停止   ./stop.sh"
