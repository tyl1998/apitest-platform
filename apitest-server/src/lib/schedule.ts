import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { pool } from "../db.js";
import { triggerCiTaskRun, triggerSuiteRun } from "./trigger.js";

/**
 * 定时调度域（P3-4，计划 6.0 / 6.3，边界 1、2、3；P4.5-12 接入 CI 任务目标，计划 8.7）。
 *
 * 调度器是**进程**（src/scheduler.ts），这里是它的域逻辑：cron 解析、下次时刻、
 * 行级认领、触发与漏跑判定。刻意不用 BullMQ repeatable jobs：队列是「一次执行」的
 * 传递通道（载荷只有 id），调度是「何时造出一次执行」的决策，两件事混在一起会让
 * 「删调度」变成清队列、「漏跑判定」变成读队列内部状态（6.0）。
 *
 * 触发一律走 `lib/trigger.ts`（P3-3 的统一触发路径）——手动与定时不可能各有一套
 * 校验，定时那条没人盯着，缺一项检查就是夜里静默少跑（边界 5）。目标类型的分派只在
 * `fire()` 一处（`fireSuite` / `fireCiTask`），两条都只是「选哪个 trigger 函数」。
 */

/**
 * 一拍 10 秒（6.3）：cron 粒度到分钟，10 秒的判定误差远小于人对「整点跑」的预期。
 * 可调（SCHEDULER_TICK_MS，钳位 1s–60s）：调小只是空转，调大让「整点跑」的误差
 * 变大——所以两端都钳住，写错不至于出事。
 */
export const SCHEDULE_TICK_MS = Math.min(60_000, Math.max(1_000, Number(process.env.SCHEDULER_TICK_MS ?? 10_000)));

/**
 * 漏跑宽限期（边界 2）：默认 2 分钟，可调（SCHEDULER_MISS_GRACE_MS，钳位 30s–1h）。
 *
 * 到期时刻在宽限期内就照常触发（tick 自身的抖动、一次 GC 停顿都不算漏跑）；
 * 超过宽限期说明调度器当时根本不在——补跑等于同一刻对被测系统打 N 发，且产出
 * N 份没人会看的报告，所以只留一行 skipped 证据。钳位下限 30s：小于两拍的话，
 * 一次慢查询就会把正常触发误判成漏跑。
 */
export const SCHEDULE_MISS_GRACE_MS = Math.min(3_600_000, Math.max(30_000, Number(process.env.SCHEDULER_MISS_GRACE_MS ?? 120_000)));

/**
 * `after` 之后的第一拍（严格晚于 `after`，cron-parser 的 next() 本身就是这个语义）。
 *
 * 时区由 schedules.timezone 决定——用户按墙上时钟写 cron，「0 2 * * *」必须是凌晨
 * 两点，而不是 UTC 的两点。
 */
export function nextOccurrence(cron: string, timezone: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
}

/** 时区校验：P3-6 的保存路由与这里共用，坏时区要能作为错误回给用户。 */
export function validateScheduleTimezone(timezone: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return undefined;
  } catch {
    return `"${timezone}" is not a valid IANA time zone`;
  }
}

/**
 * cron 校验。P3-6 的保存 / 预览路由调用同一个函数——前端预览「下五次」与调度器
 * 认领时算的是同一份解析，两个答案会让用户以为配置没保存上。
 */
export function validateScheduleCron(cron: string, timezone: string): string | undefined {
  const expression = cron.trim();
  if (!expression) return "cron is required";
  try {
    /* 坏时区在 parse() 时不抛、在 next() 算第一个时刻时才抛——时区只在求值时参与
       运算。所以校验必须走到 next()，只 parse 一半会放行「cron-parser 收下但调度器
       每拍都炸」的配置。 */
    CronExpressionParser.parse(expression, { tz: timezone }).next();
    return undefined;
  } catch {
    return `"${expression}" is not a valid cron expression`;
  }
}

type DueSchedule = {
  id: string;
  projectId: string;
  name: string;
  targetType: string;
  targetId: string;
  environmentId?: string;
  cron: string;
  timezone: string;
  variables: Record<string, string>;
  nextRunAt: Date;
};

function toSchedule(row: Record<string, unknown>): DueSchedule {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    targetType: String(row.target_type),
    targetId: String(row.target_id),
    environmentId: row.environment_id ? String(row.environment_id) : undefined,
    cron: String(row.cron),
    timezone: String(row.timezone),
    variables: (row.variables ?? {}) as Record<string, string>,
    nextRunAt: new Date(String(row.next_run_at)),
  };
}

/** 写一行 schedule_runs。triggered/failed 带 triggered_at，skipped 不带（030 的形状）。 */
async function recordRun(
  schedule: DueSchedule,
  entry: { status: "triggered" | "skipped" | "failed"; executionIndexId?: string; pipelineRunId?: string; error?: string },
) {
  const triggered = entry.status !== "skipped";
  await pool.query(
    `INSERT INTO schedule_runs (id, schedule_id, project_id, planned_at, triggered_at, status, execution_index_id, pipeline_run_id, error)
     VALUES ($1, $2, $3, $4, ${triggered ? "now()" : "NULL"}, $5, $6, $7, $8)`,
    [
      randomUUID(), schedule.id, schedule.projectId, schedule.nextRunAt, entry.status,
      entry.executionIndexId ?? null, entry.pipelineRunId ?? null, entry.error ?? null,
    ],
  );
}

/**
 * cron 已不可解析时的停靠（唯一会动 next_run_at 之外的兜底路径）。
 *
 * 边界 3 说「触发失败不自动禁用」指的是**运行期**失败——分区没人、成员被删——那些
 * 下一拍还可能成功。不可解析的 cron 永远不会成功，每 10 秒重试只会刷出无穷的 failed
 * 行。所以停靠（next_run_at 置 NULL，移出到期扫描）而不是禁用：enabled 保持 true，
 * 配置页重新保存时 P3-6 的路由会重算 next_run_at。
 *
 * `updated_by` 刻意不写（P11 边界 3）：本文件三条 UPDATE 都只动调度器的运行簿记
 * （`next_run_at` / `last_run_at`），没有登录用户在这一刻改过配置。写了会把「调度器
 * 走到这一拍」显示成「某人刚改过」——而配置的归属由 P11-3 的 schedules 路由负责。
 */
async function park(schedule: DueSchedule, reason: string) {
  await pool.query("UPDATE schedules SET next_run_at = NULL WHERE id = $1 AND next_run_at = $2", [schedule.id, schedule.nextRunAt]);
  await recordRun(schedule, { status: "failed", error: reason });
}

/**
 * 行级认领（6.0）：`WHERE id = $1 AND next_run_at = $2`，rowCount 就是「我抢到了没有」。
 *
 * 多实例安全由此而来：两个调度器实例同拍扫到同一行，只有一个的 UPDATE 能匹配到
 * 旧的 next_run_at；抢不到的静默离开，没有第二套并发原语。认领即快进——先算好
 * 下一拍再触发，触发失败也不会重试同一时刻（边界 3：失败留痕，等下一拍）。
 */
async function claimAndAdvance(schedule: DueSchedule, advanced: Date, markRun: boolean): Promise<boolean> {
  const claimed = markRun
    ? await pool.query(
        "UPDATE schedules SET next_run_at = $2, last_run_at = now() WHERE id = $1 AND next_run_at = $3",
        [schedule.id, advanced, schedule.nextRunAt],
      )
    : await pool.query(
        "UPDATE schedules SET next_run_at = $2 WHERE id = $1 AND next_run_at = $3",
        [schedule.id, advanced, schedule.nextRunAt],
      );
  return Boolean(claimed.rowCount);
}

/** 触发一个到期时刻（宽限期内）。 */
async function fire(schedule: DueSchedule, now: Date) {
  /* 目标类型护栏：CHECK 在迁移 042 放宽成 ('suite','ci_task')，分派就在这一处（030:149 的
     注释说的就是这一刻）。第三个值仍然停靠而不是猜——库里出现 CHECK 之外的值只可能是有人
     手改过行，按未知处理比按套件跑一遍安全。 */
  if (schedule.targetType !== "suite" && schedule.targetType !== "ci_task") {
    await park(schedule, `unsupported schedule target type "${schedule.targetType}"`);
    return;
  }
  let advanced: Date;
  try {
    advanced = nextOccurrence(schedule.cron, schedule.timezone, now);
  } catch (error) {
    await park(schedule, `cron could not be parsed: ${error instanceof Error ? error.message : "invalid expression"}`);
    return;
  }
  if (!await claimAndAdvance(schedule, advanced, true)) return;

  /* 只把「触发本身」包进 try：触发成功后的取证（查索引 id、写证据行）失败是调度器
     自己的事故，记成 failed 会让一次已经跑起来的执行在调度页上读成没跑成。 */
  let evidence: { executionIndexId?: string; pipelineRunId?: string };
  try {
    evidence = schedule.targetType === "ci_task" ? await fireCiTask(schedule) : await fireSuite(schedule);
  } catch (error) {
    /* 边界 3：分区没有执行器（2004）、分区没有在线 Runner（同一个码）、套件解析成零成员、
       目标被删……都记 failed 带上原因，调度保持启用——认领时已快进，下一拍照常。
       这里**不**禁用、不重试。 */
    await recordRun(schedule, { status: "failed", error: error instanceof Error ? error.message : "schedule trigger failed" });
    return;
  }
  await recordRun(schedule, { status: "triggered", ...evidence });
}

/** 套件目标：触发级环境覆盖（边界 4）与变量覆盖（6.5）都在这一处进 trigger。 */
async function fireSuite(schedule: DueSchedule): Promise<{ executionIndexId?: string }> {
  const suiteExecutionId = await triggerSuiteRun({
    projectId: schedule.projectId,
    suiteId: schedule.targetId,
    environmentId: schedule.environmentId,
    variables: schedule.variables,
    trigger: { source: "scheduled", refId: schedule.id, refName: schedule.name },
  });
  /* triggerSuiteRun 回的是明细行 id；schedule_runs 指向父索引，报告页顺着它能一步
     跳到这次执行。 */
  const index = await pool.query("SELECT execution_index_id FROM suite_executions WHERE id = $1", [suiteExecutionId]);
  return { executionIndexId: index.rows[0] ? String(index.rows[0].execution_index_id) : undefined };
}

/**
 * CI 任务目标（P4.5-12）。走 `triggerCiTaskRun`——与手动触发、Webhook 完全同一个函数
 * （P3 边界 5 的单一触发路径）：无在线 Runner 的 2004、沙箱档可满足性、任务停用、缺
 * `git_url` 这些检查一处都不能绕，定时那条没人盯着，少一项就是夜里静默不跑。
 *
 * 三个刻意的缺省：
 * - **不带 `idempotencyKey`**。抢占键的形状会是 `(scheduleId, plannedAt)`，但认领已经用
 *   `next_run_at` 的行级 UPDATE 做到了「一个到期时刻只有一个实例能触发」（6.0），再加一层
 *   只是把同一个不变量说第二遍；更糟的是 `IdempotentReplayError` 不被 `failTrigger` 认作
 *   失败，落到这里的 catch 里会被记成一次 `failed` 触发——一条本该读作「已跑」的证据。
 * - **不带 `triggeredBy`**：没有点按钮的人。审计行的 `user_id` 为空、`trigger_source`
 *   是 `scheduled`，两者合起来才说得清「谁让它跑的」。
 * - **不传环境**：仓库里的脚本自己决定打哪个环境，平台不注入（`environment_id` 在 CI
 *   目标上无意义，前端也不显示那个选择器）。
 *
 * `variables` 当 `parameters` 用：键形约束（`VARIABLE_NAME_PATTERN`）与语义（「这次触发带
 * 什么」）两边完全同一条，为它在 `schedules` 上加第二列只会让「我该填哪个框」变成新问题。
 */
async function fireCiTask(schedule: DueSchedule): Promise<{ pipelineRunId: string }> {
  const run = await triggerCiTaskRun({
    projectId: schedule.projectId,
    ciTaskId: schedule.targetId,
    parameters: schedule.variables,
    trigger: { source: "scheduled", refId: schedule.id, refName: schedule.name },
  });
  /* 指向 run 而不是父索引：`execution_index` 行要等 run 到终态才写（lib/pipelineRun.ts），
     触发这一刻它还不存在（迁移 042 加那一列的全部理由）。 */
  return { pipelineRunId: run.id };
}

/** 漏跑（边界 2）：记一行 skipped，next_run_at 快进到当前之后的第一个时刻。 */
async function markMissed(schedule: DueSchedule, now: Date) {
  let advanced: Date;
  try {
    advanced = nextOccurrence(schedule.cron, schedule.timezone, now);
  } catch (error) {
    await park(schedule, `cron could not be parsed: ${error instanceof Error ? error.message : "invalid expression"}`);
    return;
  }
  if (!await claimAndAdvance(schedule, advanced, false)) return;
  await recordRun(schedule, {
    status: "skipped",
    /* planned_at 是那个没跑成的时刻本身——不留这行的话，「昨晚没跑」与「昨晚跑了
       但没失败」在界面上无法区分。 */
    error: `missed run: due ${schedule.nextRunAt.toISOString()} but past the ${Math.round(SCHEDULE_MISS_GRACE_MS / 1000)}s grace; not backfilled`,
  });
}

/**
 * 跑一拍：认领所有到期调度。
 *
 * 顺序处理而不是并发扇出：一拍内到期的几十条调度各自 trigger 一次（只是写行入队，
 * 毫秒级），并发化只会在同一时刻给数据库与队列添一个本不需要的峰值。
 */
export async function runScheduleTick(): Promise<void> {
  const due = await pool.query(
    "SELECT * FROM schedules WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now() ORDER BY next_run_at",
  );
  for (const row of due.rows) {
    const schedule = toSchedule(row);
    const now = new Date();
    if (schedule.nextRunAt.getTime() < now.getTime() - SCHEDULE_MISS_GRACE_MS) await markMissed(schedule, now);
    else await fire(schedule, now);
  }
}
