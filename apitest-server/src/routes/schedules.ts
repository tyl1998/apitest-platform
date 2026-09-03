import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { normalizeIdempotencyKey } from "../lib/idempotency.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { validateVariableOverrides } from "../lib/resolve.js";
import { fail, success } from "../lib/response.js";
import {
  SCHEDULE_MISS_GRACE_MS, nextOccurrence, validateScheduleCron, validateScheduleTimezone,
} from "../lib/schedule.js";
import {
  environmentBelongs, failTrigger, IdempotentReplayError, triggerCiTaskRun, triggerSuiteRun,
} from "../lib/trigger.js";
import { isUuid } from "../lib/uuid.js";
import {
  SCHEDULE_TARGET_TYPES, mapSchedule, mapScheduleRun, mapSuiteExecution,
  type ScheduleTargetType,
} from "../models/types.js";

/**
 * 定时调度（P3-6，计划 6.2，边界 1~4；P4.5-12 加 CI 任务目标，计划 8.7）。
 *
 * 目标是**测试套件或 CI 任务**（`SCHEDULE_TARGET_TYPES`）。流程仍然不能被直接调度
 * （P3 边界 1）：要按时跑一条流程，把它放进一个只含它的套件——那样才有报告与统计口径。
 *
 * 调度是「何时用哪份配置触发那个目标」的声明，执行永远走 `lib/trigger.ts` 的统一
 * 触发路径（边界 5）；`next_run_at` 由本路由在写入时算好，运行期归调度器进程认领
 * （P3-4）。「立即跑一次」是手动触发（trigger_source=manual，计划 6.2 原文），因此
 * 不写 schedule_runs——那张表回答「调度自己有没有按时触发」，立即跑没有到期时刻。
 */

/** 软上限（6.0「明确不做」末条）：不是配额，是挡住误建的复制循环。 */
const SCHEDULE_MAX_PER_PROJECT = 50;

/** 预览返回的下几次执行时间个数（6.2：cron 可视化只做表达式 + 服务端预览）。 */
const PREVIEW_NEXT = 5;

/** 目标类型 → 那张表（代码常量二选一，不是输入拼接；见下面 assertTargetOwned）。 */
const TARGET_TABLES: Record<ScheduleTargetType, string> = { suite: "test_suites", ci_task: "ci_tasks" };

type ScheduleBody = {
  name?: string;
  /** 目标类型（P4.5-12）。创建时缺省为 `'suite'`——P3 起存量调用方都不带这个键。 */
  targetType?: string;
  /** 目标 id：套件 id 或 CI 任务 id，按 `targetType` 解释（迁移 030 起无外键的多态引用）。 */
  targetId?: string;
  cron?: string;
  timezone?: string;
  /** 触发级环境覆盖（边界 4）：null = 清掉，回到套件自己的配置。CI 目标上无意义。 */
  environmentId?: string | null;
  enabled?: boolean;
  /** 每次触发都带的变量覆盖（6.5 泳道第二层）；CI 目标下即任务 `parameters`。 */
  variables?: Record<string, string>;
};

/**
 * 校验 + 归一一份调度配置。partial=true 时只查出现的键（PUT 语义）；PUT 校验 cron
 * 必须对**合并后**的时区算——套件存的是 UTC、这次只改 cron，用默认时区验就会放行一个
 * 在真实时区里非法的表达式。cron 校验与调度器认领、preview 用的是
 * `lib/schedule.ts` 的同一个解析——三处若各说各话，用户在编辑器里预览的时刻和夜里
 * 实际跑的时刻就不是同一个。
 *
 * 目标类型与目标 id 一起校验（P4.5-12）：`targetType` 换了但 `targetId` 还指着旧那张表的
 * 行，就是一条悬空引用——每拍到点记一行 failed。所以 PUT 里只给一个的那种写法必须用合并后
 * 的值去查存在性，而不是只查请求体里出现的那个。
 */
async function validateSchedule(
  projectId: string,
  body: ScheduleBody,
  partial: boolean,
  existing?: { timezone: string; targetType: ScheduleTargetType; targetId: string },
): Promise<{ error?: string; name?: string; cron?: string; timezone?: string; targetType?: ScheduleTargetType; targetId?: string }> {
  const name = body.name?.trim();
  if (!partial || body.name !== undefined) if (!name) return { error: "schedule name is required" };
  const timezone = body.timezone?.trim() || existing?.timezone || "Asia/Shanghai";
  if (body.timezone !== undefined) {
    const invalidTz = validateScheduleTimezone(timezone);
    if (invalidTz) return { error: invalidTz };
  }
  const cron = body.cron?.trim();
  if (!partial || body.cron !== undefined) {
    if (!cron) return { error: "cron is required" };
    const invalidCron = validateScheduleCron(cron, timezone);
    if (invalidCron) return { error: invalidCron };
  }

  /* 目标：创建时缺省 'suite'（存量调用方不带这个键），更新时以已存行兜底。 */
  const targetType = (body.targetType?.trim() || existing?.targetType || "suite") as ScheduleTargetType;
  if (!(SCHEDULE_TARGET_TYPES as readonly string[]).includes(targetType)) {
    return { error: `targetType must be one of ${SCHEDULE_TARGET_TYPES.join(", ")}` };
  }
  const targetId = body.targetId !== undefined ? String(body.targetId) : existing?.targetId;
  if (body.targetType !== undefined || body.targetId !== undefined) {
    if (!targetId) return { error: "targetId is required" };
    if (!isUuid(targetId)) return { error: "targetId must be a UUID" };
    if (!await assertTargetOwned(projectId, targetType, targetId)) {
      return { error: `targetId must reference a ${targetType === "ci_task" ? "CI task" : "suite"} in this project` };
    }
  }

  if (body.environmentId !== undefined && body.environmentId !== null) {
    if (!isUuid(String(body.environmentId))) return { error: "environmentId must be a UUID" };
    if (!await environmentBelongs(projectId, body.environmentId)) return { error: "environment must belong to the project" };
  }
  const invalidVariables = validateVariableOverrides(body.variables);
  if (invalidVariables) return { error: invalidVariables };
  return { name, cron, timezone, targetType, targetId };
}

/** 目标必须在本项目里：借别项目的资源建调度等于跨项目触发。 */
async function assertTargetOwned(projectId: string, targetType: ScheduleTargetType, targetId: string): Promise<boolean> {
  /* 表名来自 TARGET_TABLES（代码常量），id 与 project 走参数——与 webhookTriggers.ts 的
     validateTarget 同一条纪律。 */
  const found = await pool.query(
    `SELECT 1 FROM ${TARGET_TABLES[targetType]} WHERE id = $1 AND project_id = $2`,
    [targetId, projectId],
  );
  return Boolean(found.rowCount);
}

/**
 * 写入时算下一拍：启用 = 当前时刻后的第一个 cron 时刻；禁用 = NULL（不进调度器的
 * 到期扫描，迁移 030 的约定）。
 */
function computeNextRunAt(cron: string, timezone: string, enabled: boolean): Date | null {
  return enabled ? nextOccurrence(cron, timezone, new Date()) : null;
}

/**
 * 带目标名的一行（目标被删后 LEFT JOIN 得到 NULL，调度仍读得通）。
 *
 * 两个 LEFT JOIN 各自带 `target_type` 判据（P4.5-12）：两张表的 id 都是 UUID，不加类型
 * 判据的话一个套件 id 与一个任务 id 理论上可以同时命中，`COALESCE` 挑到哪个成了运气。
 */
const SELECT_SCHEDULE = `SELECT s.*, COALESCE(ts.name, ct.name) AS target_name FROM schedules s
  LEFT JOIN test_suites ts ON s.target_type = 'suite' AND ts.id = s.target_id
  LEFT JOIN ci_tasks ct ON s.target_type = 'ci_task' AND ct.id = s.target_id`;

export async function scheduleRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; enabled?: string; targetType?: string; targetId?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/schedules", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["s.project_id = $1"];
    if (request.query.keyword?.trim()) { params.push(`%${request.query.keyword.trim()}%`); clauses.push(`s.name ILIKE $${params.length}`); }
    if (request.query.enabled === "true" || request.query.enabled === "false") { params.push(request.query.enabled === "true"); clauses.push(`s.enabled = $${params.length}`); }
    /* 按目标过滤（P3-11 起是套件详情页的定时面板，P4.5-12 起也是 CI 任务的定时抽屉）：
       两处都只看「这一个资源」的调度。`targetType` 与 `targetId` 是独立可选的两个过滤，
       非法值直接丢弃而不是 404——列表过滤是幂等读，坏值当「不过滤」处理。 */
    if (request.query.targetType && (SCHEDULE_TARGET_TYPES as readonly string[]).includes(request.query.targetType)) {
      params.push(request.query.targetType); clauses.push(`s.target_type = $${params.length}`);
    }
    if (request.query.targetId && isUuid(request.query.targetId)) { params.push(request.query.targetId); clauses.push(`s.target_id = $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM schedules s WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(`${SELECT_SCHEDULE} WHERE ${where} ORDER BY s.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    /**
     * 调度器活性提示（P3-4 批注：不建心跳表，用事实回答）。存在「启用且 next_run_at
     * 已超过宽限期还没被认领」的调度 = 调度器没有在打拍；全部到期时刻都还没到则既不能
     * 证明它活着、也不必怀疑——界面只在 overdue > 0 时提示。
     */
    const overdue = await pool.query(
      "SELECT COUNT(*)::int AS total FROM schedules WHERE project_id = $1 AND enabled AND next_run_at IS NOT NULL AND next_run_at < now() - make_interval(secs => $2)",
      [context.project.id, SCHEDULE_MISS_GRACE_MS / 1000],
    );
    return success(result.rows.map(mapSchedule), { page, pageSize, total: Number(count.rows[0].total), scheduler: { overdue: Number(overdue.rows[0].total) } });
  });

  app.post<{ Params: { id: string }; Body: ScheduleBody }>("/api/v1/projects/:id/schedules", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!request.body?.targetId) return fail(reply, 400, 1001, "targetId is required");
    const checked = await validateSchedule(context.project.id, request.body, false);
    if (checked.error) return fail(reply, 400, 1001, checked.error);

    /* 软上限：防误建循环（6.0 明确不做配额）。 */
    const existing = await pool.query("SELECT COUNT(*)::int AS total FROM schedules WHERE project_id = $1", [context.project.id]);
    if (Number(existing.rows[0].total) >= SCHEDULE_MAX_PER_PROJECT) {
      return fail(reply, 400, 1001, `a project may hold at most ${SCHEDULE_MAX_PER_PROJECT} schedules`);
    }

    const enabled = request.body.enabled ?? true;
    const nextRunAt = computeNextRunAt(checked.cron!, checked.timezone!, enabled);
    const result = await pool.query(
      `INSERT INTO schedules (id, project_id, name, target_type, target_id, environment_id, cron, timezone, enabled, variables, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING *`,
      [
        randomUUID(), context.project.id, checked.name!, checked.targetType!, checked.targetId!,
        request.body.environmentId ?? null, checked.cron!, checked.timezone!, enabled,
        JSON.stringify(request.body.variables ?? {}), nextRunAt,
      ],
    );
    /* 目标名单独读一次（INSERT 的 RETURNING 拿不到 join 列）。表名来自 TARGET_TABLES。 */
    const target = await pool.query(`SELECT name FROM ${TARGET_TABLES[checked.targetType!]} WHERE id = $1`, [checked.targetId!]);
    return reply.code(201).send(success(mapSchedule({ ...result.rows[0], target_name: target.rows[0]?.name })));
  });

  app.post<{ Params: { id: string }; Body: { cron?: string; timezone?: string } }>("/api/v1/projects/:id/schedules/preview", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const timezone = request.body?.timezone?.trim() || "Asia/Shanghai";
    const cron = request.body?.cron?.trim() ?? "";
    const invalidTz = validateScheduleTimezone(timezone);
    if (invalidTz) return fail(reply, 400, 1001, invalidTz);
    const invalidCron = validateScheduleCron(cron, timezone);
    if (invalidCron) return fail(reply, 400, 1001, invalidCron);
    /* 与调度器认领同一个解析函数（lib/schedule.ts）：预览说几点跑，它就几点跑。 */
    const next: string[] = [];
    let cursor = new Date();
    for (let index = 0; index < PREVIEW_NEXT; index += 1) {
      cursor = nextOccurrence(cron, timezone, cursor);
      next.push(cursor.toISOString());
    }
    return success({ cron, timezone, next });
  });

  app.get<{ Params: { id: string; scheduleId: string } }>("/api/v1/projects/:id/schedules/:scheduleId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.scheduleId)) return fail(reply, 404, 2001, "schedule not found");
    const result = await pool.query(`${SELECT_SCHEDULE} WHERE s.id = $1 AND s.project_id = $2`, [request.params.scheduleId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "schedule not found");
    return success(mapSchedule(result.rows[0]));
  });

  app.put<{ Params: { id: string; scheduleId: string }; Body: ScheduleBody }>("/api/v1/projects/:id/schedules/:scheduleId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.scheduleId)) return fail(reply, 404, 2001, "schedule not found");
    const existing = await pool.query("SELECT * FROM schedules WHERE id = $1 AND project_id = $2", [request.params.scheduleId, context.project.id]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "schedule not found");

    const before = existing.rows[0];
    const checked = await validateSchedule(context.project.id, request.body ?? {}, true, {
      timezone: String(before.timezone),
      targetType: String(before.target_type) as ScheduleTargetType,
      targetId: String(before.target_id),
    });
    if (checked.error) return fail(reply, 400, 1001, checked.error);

    const cron = checked.cron ?? String(before.cron);
    const timezone = request.body?.timezone?.trim() || String(before.timezone);
    const enabled = request.body?.enabled ?? Boolean(before.enabled);
    /**
     * 认领锚点必须跟着配置走：改 cron/时区/启停后仍用旧的 next_run_at，调度器会按
     * 旧时刻认领、按新 cron 快进——不是用户在编辑器里看到的那个时刻。所以任一相关
     * 字段变化都重算。禁用置 NULL（不进到期扫描）。
     */
    const recompute = request.body?.cron !== undefined || request.body?.timezone !== undefined || request.body?.enabled !== undefined;
    const nextRunAt = recompute ? computeNextRunAt(cron, timezone, enabled) : before.next_run_at;
    /* environmentId 三态：缺省 = 不动（保留下拉里的旧值），null = 清掉，字符串 = 换。 */
    const environmentId = request.body?.environmentId === undefined ? before.environment_id : request.body.environmentId;

    await pool.query(
      `UPDATE schedules SET name = COALESCE($1, name), target_type = $2, target_id = $3,
         environment_id = $4, cron = $5, timezone = $6, enabled = $7,
         variables = COALESCE($8::jsonb, variables), next_run_at = $9, updated_at = now()
       WHERE id = $10 AND project_id = $11`,
      [
        checked.name ?? null,
        /* 目标类型与 id 一起写合并后的值（P4.5-12）：两者缺省时合并结果就是已存行的值，
           所以这是一次无变化的写；分开成两个 COALESCE 反而能表达出「只换了类型」这种
           悬空组合，而那是 validateSchedule 刚刚挡掉的东西。 */
        checked.targetType!, checked.targetId!,
        environmentId, cron, timezone, enabled,
        request.body?.variables !== undefined ? JSON.stringify(request.body.variables) : null,
        nextRunAt, request.params.scheduleId, context.project.id,
      ],
    );
    const updated = await pool.query(`${SELECT_SCHEDULE} WHERE s.id = $1 AND s.project_id = $2`, [request.params.scheduleId, context.project.id]);
    return success(mapSchedule(updated.rows[0]));
  });

  app.delete<{ Params: { id: string; scheduleId: string } }>("/api/v1/projects/:id/schedules/:scheduleId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.scheduleId)) return fail(reply, 404, 2001, "schedule not found");
    /* schedule_runs 级联删除：调度没了，它的触发历史没有查询方；真正的执行历史在
       execution_index，靠无 FK 的 trigger_ref_* 活过这次删除。 */
    const result = await pool.query("DELETE FROM schedules WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.scheduleId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "schedule not found");
    return success({ id: result.rows[0].id });
  });

  /**
   * 触发历史（含漏跑 skipped 与触发失败 failed——那两种没有执行，边界 15）。
   *
   * `triggered` 只是拉起事实，不是执行结果（030 的设计：schedule_runs 只回答「调度
   * 自己有没有按时触发」）。2026-09-03 验收：绿色 triggered 标签被读成「执行成功」，
   * 而实际执行是 failed。这里顺两列引用把**执行的终态**带出来：
   * - CI 目标读 `pipeline_runs`（run 行触发时即存在，在途态如实可见）；
   * - 套件目标读 `execution_index`（它的行入队时就有）。
   * 目标被删 / 行异常缺席时列返回 undefined，前端回退显示「已触发」——调度证据本身
   * 仍要能读（迁移 042 的 ON DELETE SET NULL 语义）。
   */
  app.get<{ Params: { id: string; scheduleId: string }; Querystring: { status?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/schedules/:scheduleId/runs", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.scheduleId)) return fail(reply, 404, 2001, "schedule not found");
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id, request.params.scheduleId];
    const clauses = ["sr.project_id = $1", "sr.schedule_id = $2"];
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`sr.status = $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM schedule_runs sr WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(
      `SELECT sr.*, pr.status AS run_status, ei.status AS exec_status
         FROM schedule_runs sr
         LEFT JOIN pipeline_runs pr ON pr.id = sr.pipeline_run_id AND pr.project_id = $1
         LEFT JOIN execution_index ei ON ei.id = sr.execution_index_id AND ei.project_id = $1
        WHERE ${where}
        ORDER BY sr.planned_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return success(result.rows.map(mapScheduleRun), { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 立即跑一次：用这条调度的配置（目标、环境覆盖、变量覆盖）**现在**触发，但
   * trigger_source 是 manual（计划 6.2 原文）——它不是到期时刻，不写 schedule_runs，
   * 证据是那一次执行本身（报告/执行记录里可见）。
   *
   * 响应是**按 `targetType` 判别的联合**（P4.5-12）：套件路径产出一行 `suite_executions`、
   * CI 路径产出一行 `pipeline_runs`，两者的字段与后续跳转目标都不同。硬塞成一个形状要么
   * 丢掉一半字段、要么让前端猜自己拿到的是什么——判别式把这件事写在数据里。
   */
  app.post<{ Params: { id: string; scheduleId: string } }>("/api/v1/projects/:id/schedules/:scheduleId/run", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.scheduleId)) return fail(reply, 404, 2001, "schedule not found");
    const result = await pool.query("SELECT * FROM schedules WHERE id = $1 AND project_id = $2", [request.params.scheduleId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "schedule not found");
    const row = result.rows[0];
    const targetType = String(row.target_type);
    if (!(SCHEDULE_TARGET_TYPES as readonly string[]).includes(targetType)) {
      return fail(reply, 400, 1001, "this schedule target cannot be run");
    }
    const normalizedKey = normalizeIdempotencyKey(request.headers["idempotency-key"]);
    if (normalizedKey.error) return fail(reply, 400, 1001, normalizedKey.error);
    try {
      if (targetType === "ci_task") {
        /* 变量覆盖在 CI 目标下就是任务 `parameters`（与调度器 fireCiTask 同一条口径）；
           环境覆盖不传——仓库里的脚本自己决定打哪个环境。 */
        const run = await triggerCiTaskRun({
          projectId: context.project.id,
          ciTaskId: String(row.target_id),
          parameters: (row.variables ?? {}) as Record<string, string>,
          triggeredBy: context.user.id,
          idempotencyKey: normalizedKey.key,
          requestIp: request.ip,
        });
        return reply.code(202).send(success({ targetType: "ci_task", pipelineRun: run }));
      }
      const suiteExecutionId = await triggerSuiteRun({
        projectId: context.project.id,
        suiteId: String(row.target_id),
        environmentId: row.environment_id ? String(row.environment_id) : undefined,
        variables: (row.variables ?? {}) as Record<string, string>,
      });
      const queued = await pool.query("SELECT * FROM suite_executions WHERE id = $1", [suiteExecutionId]);
      return reply.code(202).send(success({ targetType: "suite", suiteExecution: mapSuiteExecution(queued.rows[0]) }));
    } catch (error) {
      /* 幂等命中不是失败（`failTrigger` 不认识它）：回首次那条 run，202 语义不变。 */
      if (error instanceof IdempotentReplayError) {
        return reply.code(202).send(success({ targetType: "ci_task", pipelineRun: { ...error.run, idempotentReplay: true } }));
      }
      return failTrigger(reply, error, "schedule could not be run");
    }
  });
}
