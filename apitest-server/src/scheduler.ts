import { pool } from "./db.js";
import type { Redis } from "ioredis";
import { evaluateAlertEvent, notifySuiteResult } from "./lib/alerts.js";
import { EVENT_CHANNEL, type ExecutionEvent } from "./lib/events.js";
import { createRedis } from "./lib/queue.js";
import { runScheduleTick, SCHEDULE_MISS_GRACE_MS, SCHEDULE_TICK_MS } from "./lib/schedule.js";

/**
 * 调度器进程（P3-4，计划 6.3）：与 API、worker 并列的第三个进程。
 *
 * 三件事：
 * - **cron tick**（10 秒）：认领到期调度 → `lib/trigger.ts` → 写 `schedule_runs`。
 * - **漏跑判定**：超过宽限期的到期时刻记 `skipped` 并快进 `next_run_at`（边界 2）。
 * - **告警派发**：订阅 `executions:events`，终态事件上评估规则并投递（边界 9/10；
 *   评估主体在 P3-5 的 lib/alerts.ts，这里是订阅与错误隔离的管线）。
 *
 * 刻意不用 BullMQ repeatable jobs（6.0）：队列是「一次执行」的传递通道，调度是
 * 「何时造出一次执行」的决策。去重靠 `schedules.next_run_at` 的行级认领，多实例
 * 安全但推荐单实例——两个实例只是各自空转一半的拍，没有任何正确性收益。
 *
 * 进程无监听端口、无注册表心跳：调度器是否活着由 schedule_runs 的新鲜度回答
 * （全部调度都 stale 就是没在跑，P3-6 的列表页把这个事实显示出来），心跳表只会
 * 多出一个「进程活着但没人看它」的指标。
 */

const TERMINAL = new Set(["success", "failed", "canceled"]);

/**
 * 告警订阅。
 *
 * 一条独立的 Redis 订阅连接（订阅模式的连接不能再发普通命令），坏消息与评估异常
 * 都不能拖垮管线——丢了这一条事件只是这一条告警迟到，订阅挂了是所有告警都没有。
 */
function startAlertDispatch(): Redis {
  const subscriber = createRedis();
  void subscriber.subscribe(EVENT_CHANNEL);
  subscriber.on("message", (_channel: string, payload: string) => {
    let event: ExecutionEvent;
    try { event = JSON.parse(payload) as ExecutionEvent; } catch { return; }
    /* 只评估父执行的终态（边界 9）：进度事件不算数，叶子执行没有独立结论。取消也是
       终态——要不要为「被取消」告警是规则（P3-5）的事，管线先把事实递过去。 */
    if (event.kind !== "flow" && event.kind !== "suite") return;
    if (!TERMINAL.has(event.status)) return;
    void evaluateAlertEvent(event).catch((error) => console.error("[scheduler] alert evaluation failed", error));
    /* 套件级结果通知（P3-11）：与告警同一条订阅，互不影响——通知挂了不该拖垮告警，
       反之亦然，所以各自 catch。 */
    if (event.kind === "suite") {
      void notifySuiteResult(event).catch((error) => console.error("[scheduler] suite notification failed", error));
    }
  });
  return subscriber;
}

const alertSubscriber = startAlertDispatch();

const tick = setInterval(() => {
  void runScheduleTick().catch((error) => console.error("[scheduler] tick failed", error));
}, SCHEDULE_TICK_MS);
/* tick 是维护动作，不该拖住进程退出。 */
tick.unref();

/* 启动立刻跑一拍，而不是先空等 10 秒：刚起来的第一拍往往要处理停机期间积压的
   到期时刻（宽限期内的触发、超期的记 skipped）。 */
void runScheduleTick().catch((error) => console.error("[scheduler] tick failed", error));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(tick);
    alertSubscriber.disconnect();
    await pool.end();
    process.exit(0);
  });
}

console.log(`[scheduler] ticking every ${SCHEDULE_TICK_MS / 1000}s (miss grace ${SCHEDULE_MISS_GRACE_MS / 1000}s), listening on ${EVENT_CHANNEL}`);
