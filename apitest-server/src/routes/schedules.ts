import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { validateVariableOverrides } from "../lib/resolve.js";
import { fail, success } from "../lib/response.js";
import {
  SCHEDULE_MISS_GRACE_MS, nextOccurrence, validateScheduleCron, validateScheduleTimezone,
} from "../lib/schedule.js";
import { environmentBelongs, failTrigger, triggerSuiteRun } from "../lib/trigger.js";
import { isUuid } from "../lib/uuid.js";
import { mapSchedule, mapScheduleRun, mapSuiteExecution } from "../models/types.js";

/**
 * 定时调度（P3-6，计划 6.2，边界 1~4）。目标只有测试套件（边界 1）。
 *
 * 调度是「何时用哪份配置触发那个套件」的声明，执行永远走 `lib/trigger.ts` 的统一
 * 触发路径（边界 5）；`next_run_at` 由本路由在写入时算好，运行期归调度器进程认领
 * （P3-4）。「立即跑一次」是手动触发（trigger_source=manual，计划 6.2 原文），因此
 * 不写 schedule_runs——那张表回答「调度自己有没有按时触发」，立即跑没有到期时刻。
 */

/** 软上限（6.0「明确不做」末条）：不是配额，是挡住误建的复制循环。 */
const SCHEDULE_MAX_PER_PROJECT = 50;

/** 预览返回的下几次执行时间个数（6.2：cron 可视化只做表达式 + 服务端预览）。 */
const PREVIEW_NEXT = 5;

type ScheduleBody = {
  name?: string;
  /** 目标套件 id（target_type 恒为 'suite'，迁移 030 的 CHECK）。 */
  targetId?: string;
  cron?: string;
  timezone?: string;
  /** 触发级环境覆盖（边界 4）：null = 清掉，回到套件自己的配置。 */
  environmentId?: string | null;
  enabled?: boolean;
  /** 每次触发都带的变量覆盖（6.5 泳道第二层）。 */
  variables?: Record<string, string>;
};

/**
 * 校验 + 归一一份调度配置。partial=true 时只查出现的键（PUT 语义）；PUT 校验 cron
 * 必须对**合并后**的时区算——套件存的是 UTC、这次只改 cron，用默认时区验就会放行一个
 * 在真实时区里非法的表达式。cron 校验与调度器认领、preview 用的是
 * `lib/schedule.ts` 的同一个解析——三处若各说各话，用户在编辑器里预览的时刻和夜里
 * 实际跑的时刻就不是同一个。
 */
async function validateSchedule(projectId: string, body: ScheduleBody, partial: boolean, existingTimezone?: string): Promise<{ error?: string; name?: string; cron?: string; timezone?: string }> {
  const name = body.name?.trim();
  if (!partial || body.name !== undefined) if (!name) return { error: "schedule name is required" };
  const timezone = body.timezone?.trim() || existingTimezone || "Asia/Shanghai";
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
  if (body.targetId !== undefined) {
    if (!isUuid(String(body.targetId))) return { error: "targetId must be a UUID" };
    const suite = await pool.query("SELECT 1 FROM test_suites WHERE id = $1 AND project_id = $2", [body.targetId, projectId]);
    if (!suite.rowCount) return { error: "targetId must reference a suite in this project" };
  }
  if (body.environmentId !== undefined && body.environmentId !== null) {
    if (!isUuid(String(body.environmentId))) return { error: "environmentId must be a UUID" };
    if (!await environmentBelongs(projectId, body.environmentId)) return { error: "environment must belong to the project" };
  }
  const invalidVariables = validateVariableOverrides(body.variables);
  if (invalidVariables) return { error: invalidVariables };
  return { name, cron, timezone };
}

/**
 * 写入时算下一拍：启用 = 当前时刻后的第一个 cron 时刻；禁用 = NULL（不进调度器的
 * 到期扫描，迁移 030 的约定）。
 */
function computeNextRunAt(cron: string, timezone: string, enabled: boolean): Date | null {
  return enabled ? nextOccurrence(cron, timezone, new Date()) : null;
}

/** 带目标套件名的一行（套件被删后 LEFT JOIN 得到 NULL，调度仍读得通）。 */
const SELECT_SCHEDULE = `SELECT s.*, ts.name AS target_name FROM schedules s
  LEFT JOIN test_suites ts ON s.target_type = 'suite' AND ts.id = s.target_id`;

export async function scheduleRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; enabled?: string; targetId?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/schedules", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["s.project_id = $1"];
    if (request.query.keyword?.trim()) { params.push(`%${request.query.keyword.trim()}%`); clauses.push(`s.name ILIKE $${params.length}`); }
    if (request.query.enabled === "true" || request.query.enabled === "false") { params.push(request.query.enabled === "true"); clauses.push(`s.enabled = $${params.length}`); }
    /* 按目标套件过滤（P3-11）：套件详情页的定时面板只看这一个套件的调度。
       非法 uuid 直接丢弃过滤而不是 404——列表过滤是幂等读，坏值当「不过滤」处理。 */
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
    const checked = await validateSchedule(context.project.id, request.body ?? {}, false);
    if (checked.error) return fail(reply, 400, 1001, checked.error);
    if (!request.body?.targetId) return fail(reply, 400, 1001, "targetId is required");

    /* 软上限：防误建循环（6.0 明确不做配额）。 */
    const existing = await pool.query("SELECT COUNT(*)::int AS total FROM schedules WHERE project_id = $1", [context.project.id]);
    if (Number(existing.rows[0].total) >= SCHEDULE_MAX_PER_PROJECT) {
      return fail(reply, 400, 1001, `a project may hold at most ${SCHEDULE_MAX_PER_PROJECT} schedules`);
    }

    const enabled = request.body.enabled ?? true;
    const nextRunAt = computeNextRunAt(checked.cron!, checked.timezone!, enabled);
    const result = await pool.query(
      `INSERT INTO schedules (id, project_id, name, target_type, target_id, environment_id, cron, timezone, enabled, variables, next_run_at)
       VALUES ($1, $2, $3, 'suite', $4, $5, $6, $7, $8, $9::jsonb, $10) RETURNING *`,
      [randomUUID(), context.project.id, checked.name!, request.body.targetId, request.body.environmentId ?? null, checked.cron!, checked.timezone!, enabled, JSON.stringify(request.body.variables ?? {}), nextRunAt],
    );
    const suite = await pool.query("SELECT name FROM test_suites WHERE id = $1", [request.body.targetId]);
    return reply.code(201).send(success(mapSchedule({ ...result.rows[0], target_name: suite.rows[0]?.name })));
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
    const checked = await validateSchedule(context.project.id, request.body ?? {}, true, String(before.timezone));
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
      `UPDATE schedules SET name = COALESCE($1, name), target_id = COALESCE($2, target_id),
         environment_id = $3, cron = $4, timezone = $5, enabled = $6,
         variables = COALESCE($7::jsonb, variables), next_run_at = $8, updated_at = now()
       WHERE id = $9 AND project_id = $10`,
      [
        checked.name ?? null, request.body?.targetId ?? null, environmentId, cron, timezone, enabled,
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

  /** 触发历史（含漏跑 skipped 与触发失败 failed——那两种没有执行，边界 15）。 */
  app.get<{ Params: { id: string; scheduleId: string }; Querystring: { status?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/schedules/:scheduleId/runs", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.scheduleId)) return fail(reply, 404, 2001, "schedule not found");
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id, request.params.scheduleId];
    const clauses = ["project_id = $1", "schedule_id = $2"];
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`status = $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM schedule_runs WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(`SELECT * FROM schedule_runs WHERE ${where} ORDER BY planned_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return success(result.rows.map(mapScheduleRun), { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 立即跑一次：用这条调度的配置（目标、环境覆盖、变量覆盖）**现在**触发，但
   * trigger_source 是 manual（计划 6.2 原文）——它不是到期时刻，不写 schedule_runs，
   * 证据是那一次执行本身（报告/执行记录里可见）。
   */
  app.post<{ Params: { id: string; scheduleId: string } }>("/api/v1/projects/:id/schedules/:scheduleId/run", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.scheduleId)) return fail(reply, 404, 2001, "schedule not found");
    const result = await pool.query("SELECT * FROM schedules WHERE id = $1 AND project_id = $2", [request.params.scheduleId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "schedule not found");
    const row = result.rows[0];
    if (String(row.target_type) !== "suite") return fail(reply, 400, 1001, "this schedule target cannot be run");
    try {
      const suiteExecutionId = await triggerSuiteRun({
        projectId: context.project.id,
        suiteId: String(row.target_id),
        environmentId: row.environment_id ? String(row.environment_id) : undefined,
        variables: (row.variables ?? {}) as Record<string, string>,
      });
      const queued = await pool.query("SELECT * FROM suite_executions WHERE id = $1", [suiteExecutionId]);
      return reply.code(202).send(success(mapSuiteExecution(queued.rows[0])));
    } catch (error) {
      return failTrigger(reply, error, "schedule could not be run");
    }
  });
}
