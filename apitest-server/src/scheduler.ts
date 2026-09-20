import { pool } from "./db.js";
import type { Redis } from "ioredis";
import { evaluateAlertEvent, notifyPipelineResult, notifySuiteResult } from "./lib/alerts.js";
import { EVENT_CHANNEL, publishEvent, type ExecutionEvent } from "./lib/events.js";
import {
  EXECUTION_RETENTION_MONTHS,
  PARTITION_MAINTENANCE_TICK_MS,
  runPartitionMaintenance,
} from "./lib/executionArchive.js";
import { abortPipelineRunAfterLease } from "./lib/pipelineRun.js";
import { createRedis } from "./lib/queue.js";
import { runScheduleTick, SCHEDULE_MISS_GRACE_MS, SCHEDULE_TICK_MS } from "./lib/schedule.js";

/**
 * 调度器进程（P3-4，计划 6.3）：与 API、worker 并列的第三个进程。
 *
 * 四件事：
 * - **cron tick**（10 秒）：认领到期调度 → `lib/trigger.ts` → 写 `schedule_runs`。
 *   目标是套件或 CI 任务（P4.5-12），分派在 `lib/schedule.ts` 的 `fire()` 一处。
 * - **漏跑判定**：超过宽限期的到期时刻记 `skipped` 并快进 `next_run_at`（边界 2）。
 * - **告警派发**：订阅 `executions:events`，终态事件上评估规则并投递（边界 9/10；
 *   评估主体在 P3-5 的 lib/alerts.ts，这里是订阅与错误隔离的管线）。套件与仓库任务的
 *   **结果通知**共用这一条订阅（P3-11 / P4.5-12）。
 * - **Runner 租约回收**（P4.5-3）：`pipeline_runs.lease_expires_at` 过期的在途 run 判
 *   `aborted`（advisory lock 互斥，多实例安全）。
 * - **执行分区维护**（P10-2）：预建未来季分区、把到期的冷分区脱离出去（同上，advisory
 *   lock 互斥）。落在这里而不是第四个进程，理由与租约回收完全一样——形状就是「定时扫一遍
 *   目录并推进状态」。
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
    /**
     * 仓库任务的终态通知（P4.5-12，8.7 的范围扩项）。**在这里而不是在 complete 里调**：
     * `pipeline` 终态事件已经在两条路径上发了（`completePipelineRun` 与租约回收器），
     * 挂在事件上等于两条路径自动都覆盖，不用各插一次——那正是「一处漏掉就静默不通知」
     * 的经典形状。
     *
     * 它**不进告警规则评估**：`evaluateAlertEvent` 的窗口统计只看 `kind IN ('flow','suite')`
     * 的索引行（lib/alerts.ts 的 windowAggregate），把仓库执行掺进项目级成功率是一次口径
     * 变更（P4.5 边界 2：覆盖率与统计口径一个字不改），不在本批范围内。
     */
    if (event.kind === "pipeline") {
      /* 终态白名单在 notifyPipelineResult 里（canceled 不通知、aborted/timed_out 通知）：
         判据与文案在同一处，这里不重复一份会漂移的状态表。 */
      void notifyPipelineResult(event).catch((error) => console.error("[scheduler] pipeline notification failed", error));
      return;
    }
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

/*
 * ── 租约回收器（P4.5-3，8.2 约定 4）────────────────────────────────────────
 *
 * 放在已有的 scheduler 进程里而不是新起第四个进程：它已经在做「定时扫一遍 DB 并推进
 * 状态」这件事，形状完全一样。判据是 `pipeline_runs.lease_expires_at`（边界 5）——
 * 心跳每次续到 now()+90s，过期即「持有租约的 Runner 没了」，判 `aborted` 而不是
 * `failed`：失败是被测脚本/环境的结论，aborted 是平台基础设施的事实，两者混了会把
 * 排查方向带偏（验收门槛 5）。
 *
 * **不动 `timed_out`**：超时是 Runner 自己 kill 进程树后报的终态（P4.5-5），回收器只管
 * 「连报都没人来报」的那一类。`cancelling` 过期同样判 aborted——取消信号没人来取，
 * 说明取信号的机器已经没了。
 */

/** 与 worker 的 REAP_LOCK_KEY（8_013_301）不同键：互斥范围按「谁在扫哪张表」划。 */
const PIPELINE_REAP_LOCK_KEY = 8_013_401;
/** 回收拍频：最坏检测延迟 = 剩余租约（<90s）+ 一拍 15s，远小于「等下一个心跳」的任何替代方案。 */
const PIPELINE_REAP_TICK_MS = 15_000;

async function reapExpiredLeases() {
  const client = await pool.connect();
  let reaped: { id: string; projectId: string }[] = [];
  try {
    await client.query("BEGIN");
    /* 事务级 advisory lock：同一时刻只有一个 scheduler 实例真正执行（多实例部署安全），
       且随事务结束自动释放，进程崩了也不会把锁留下（worker.reapStale 同款）。 */
    const lock = await client.query("SELECT pg_try_advisory_xact_lock($1) AS acquired", [PIPELINE_REAP_LOCK_KEY]);
    if (!lock.rows[0].acquired) { await client.query("ROLLBACK"); return; }
    /* 归一写入（execution_index kind='runner'）与 aborted 落库同一份实现
       （lib/pipelineRun.ts）——被回收的 run 等不到 complete，索引行必须在这里补。 */
    reaped = await abortPipelineRunAfterLease(client);
    /* 必须显式提交：pg 的 release 不回滚，事务挂在池子里会把后续拿到这条连接的查询
       全部静默并入同一个事务（worker.ts 用一次事故换来的教训）。 */
    await client.query("COMMIT");
    if (reaped.length) console.warn(`[scheduler] aborted ${reaped.length} pipeline run(s) after lease expiry`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  /* 终态事件在 commit 之后发（P4.5-4）：事务回滚时不该存在「已 aborted」的界面状态。 */
  for (const run of reaped) {
    void publishEvent({ kind: "pipeline", projectId: run.projectId, pipelineRunId: run.id, status: "aborted" }).catch(() => {});
  }
}

const pipelineReapTick = setInterval(() => {
  void reapExpiredLeases().catch((error) => console.error("[scheduler] pipeline lease reap failed", error));
}, PIPELINE_REAP_TICK_MS);
pipelineReapTick.unref();
/* 启动立刻扫一拍：停机期间过期的租约不该再等 15 秒。 */
void reapExpiredLeases().catch((error) => console.error("[scheduler] pipeline lease reap failed", error));

const tick = setInterval(() => {
  void runScheduleTick().catch((error) => console.error("[scheduler] tick failed", error));
}, SCHEDULE_TICK_MS);
/* tick 是维护动作，不该拖住进程退出。 */
tick.unref();

/*
 * ── 执行分区维护（P10-2，计划 14.1）────────────────────────────────────────
 *
 * 两件事：**预建**当前季与之后两季的分区，**归档**整季都超出保留窗口的冷分区（DETACH +
 * 改名，永不自动 DROP）。`EXECUTION_RETENTION_MONTHS` 缺省 0 时只做前者。
 *
 * 拍频是 6 小时，因为分区是季级的：这一拍存在的唯一意义是「别把建下一季分区这件事拖到
 * 跨季那一刻」。真跨季时即使拍全挂了也不会写失败——066 建了 DEFAULT 兜底分区。
 */
async function partitionMaintenanceTick() {
  const { created, archived, blocked } = await runPartitionMaintenance();
  if (created.length) console.log(`[scheduler] created execution partition(s): ${created.join(", ")}`);
  /* 归档是会改变「哪些历史还查得到」的动作，用 warn：它值得在日志里显眼。 */
  if (archived.length) console.warn(`[scheduler] archived execution partition(s): ${archived.join(", ")} — 数据仍在库里，清理走 DELETE /api/v1/system/execution-partitions/:name`);
  /* 不是故障（写入仍落进兜底分区），但这一季永远不会被自动归档，要有人来搬行。 */
  if (blocked.length) console.error(`[scheduler] execution partition(s) blocked by rows already in executions_default: ${blocked.join(", ")} — 需人工把这批行搬出兜底分区后才建得出来`);
}

const partitionTick = setInterval(() => {
  void partitionMaintenanceTick().catch((error) => console.error("[scheduler] partition maintenance failed", error));
}, PARTITION_MAINTENANCE_TICK_MS);
partitionTick.unref();
/* 启动立刻跑一拍：停机跨季时下一季的分区还没建，不该再等 6 小时（虽然 DEFAULT 接得住）。 */
void partitionMaintenanceTick().catch((error) => console.error("[scheduler] partition maintenance failed", error));

/* 启动立刻跑一拍，而不是先空等 10 秒：刚起来的第一拍往往要处理停机期间积压的
   到期时刻（宽限期内的触发、超期的记 skipped）。 */
void runScheduleTick().catch((error) => console.error("[scheduler] tick failed", error));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(tick);
    clearInterval(pipelineReapTick);
    clearInterval(partitionTick);
    alertSubscriber.disconnect();
    await pool.end();
    process.exit(0);
  });
}

console.log(`[scheduler] ticking every ${SCHEDULE_TICK_MS / 1000}s (miss grace ${SCHEDULE_MISS_GRACE_MS / 1000}s), listening on ${EVENT_CHANNEL}`);
console.log(
  EXECUTION_RETENTION_MONTHS > 0
    ? `[scheduler] execution partition maintenance every ${PARTITION_MAINTENANCE_TICK_MS / 3_600_000}h, archiving quarters older than ${EXECUTION_RETENTION_MONTHS} month(s)`
    : `[scheduler] execution partition maintenance every ${PARTITION_MAINTENANCE_TICK_MS / 3_600_000}h, archiving disabled (EXECUTION_RETENTION_MONTHS=0)`,
);
