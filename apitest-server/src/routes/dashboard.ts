import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { currentUser } from "../lib/auth.js";
import { success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import type { User } from "../models/types.js";

export type ProjectFilters = { keyword?: string; projectIds?: string };

/**
 * One aggregation per project, filtered in SQL.
 *
 * Counts come from separate grouped sub-selects rather than joined rows:
 * joining endpoints, environments and executions together multiplies each
 * table by the others and inflates every count.
 *
 * `paging` 只有项目列表页传（卡片墙随项目数线性长下去）；dashboard 聚合永远全量——
 * 它的 readout 数的是「全部可见项目」的合计，分页会把分子分母一起截短。total 与主查询
 * 共用同一份 WHERE，两个数才对得上。
 */
export async function queryProjectMetrics(
  user: User,
  filters: ProjectFilters,
  paging?: { page: number; pageSize: number },
) {
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (!user.isSystemAdmin) {
    params.push(user.id);
    clauses.push(`EXISTS (SELECT 1 FROM user_project_roles upr WHERE upr.project_id = p.id AND upr.user_id = $${params.length})`);
  }

  /* Substring match, case-insensitive, over name and description. */
  const keyword = filters.keyword?.trim();
  if (keyword) {
    params.push(`%${keyword}%`);
    clauses.push(`(p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`);
  }

  /* Non-uuid values would abort the query, so drop them before casting. */
  const ids = (filters.projectIds?.split(",") ?? []).map((id) => id.trim()).filter(isUuid);
  if (ids.length) {
    params.push(ids);
    clauses.push(`p.id = ANY($${params.length}::uuid[])`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  /* 分页时 total 数的是「这份 WHERE 命中的全量」，不是当前页行数——卡片墙的翻页器
     需要前者。不分页就不多付这次查询：dashboard 天然要拿全部行。 */
  let total: number | undefined;
  if (paging) {
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM projects p ${where}`, params);
    total = Number(count.rows[0].total);
  }
  /* LIMIT/OFFSET 占位符追加在过滤参数之后，与动态过滤同一纪律。 */
  const limitFragment = paging ? `LIMIT $${params.length + 1} OFFSET $${params.length + 2}` : "";
  if (paging) params.push(paging.pageSize, (paging.page - 1) * paging.pageSize);
  const result = await pool.query(`
    SELECT p.id, p.name, p.description, p.created_at,
      COALESCE(ep.endpoint_count, 0)::int      AS endpoint_count,
      COALESCE(env.environment_count, 0)::int  AS environment_count,
      COALESCE(ex.executed_endpoint_count, 0)::int AS executed_endpoint_count,
      COALESCE(ex.execution_count, 0)::int     AS execution_count,
      COALESCE(ex.judged_count, 0)::int        AS judged_count,
      COALESCE(ex.passed_count, 0)::int        AS passed_count,
      COALESCE(tc.case_count, 0)::int          AS case_count,
      COALESCE(tc.covered_endpoint_count, 0)::int AS covered_endpoint_count,
      COALESCE(sc.schedule_count, 0)::int      AS schedule_count,
      COALESCE(ct.ci_task_count, 0)::int       AS ci_task_count,
      ex.last_execution_at
    FROM projects p
    LEFT JOIN (SELECT project_id, COUNT(*) AS endpoint_count FROM endpoints GROUP BY project_id) ep ON ep.project_id = p.id
    LEFT JOIN (SELECT project_id, COUNT(*) AS environment_count FROM environments GROUP BY project_id) env ON env.project_id = p.id
    LEFT JOIN (
      /**
       * Only settled runs count (P1-3). A run sitting in the queue has no
       * verdict, so counting it would drag the pass rate down the moment
       * someone presses 执行 and pull it back up when the worker finishes —
       * a number that moves on its own is worse than no number.
       *
       * 'canceled' is settled but is nobody's verdict either, so it is visible
       * in the executed total and excluded from the pass-rate denominator.
       */
      SELECT project_id,
        COUNT(*) FILTER (WHERE status IN ('success', 'failed', 'canceled')) AS execution_count,
        COUNT(*) FILTER (WHERE status IN ('success', 'failed')) AS judged_count,
        COUNT(*) FILTER (WHERE status = 'success') AS passed_count,
        COUNT(DISTINCT endpoint_id) FILTER (WHERE status IN ('success', 'failed')) AS executed_endpoint_count,
        MAX(created_at) FILTER (WHERE status IN ('success', 'failed', 'canceled')) AS last_execution_at
      FROM executions GROUP BY project_id
    ) ex ON ex.project_id = p.id
    LEFT JOIN (
      /* 覆盖 means "has at least one case" (交互文档 3.11), so the covered count
         is distinct endpoints, not the case total. */
      SELECT project_id, COUNT(*) AS case_count, COUNT(DISTINCT endpoint_id) AS covered_endpoint_count
      FROM test_cases GROUP BY project_id
    ) tc ON tc.project_id = p.id
    LEFT JOIN (
      /* 调度数（P3-6）：建了多少条就是多少条——含停用的。停用的调度不是「不存在」，
         面板上把它藏掉只会让人以为少建了一条。 */
      SELECT project_id, COUNT(*) AS schedule_count FROM schedules GROUP BY project_id
    ) sc ON sc.project_id = p.id
    LEFT JOIN (
      /* CI 任务数（P4.5-11）：与调度数同一条口径——建了多少条就是多少条，含停用的。
         看板上的这个数字此前是硬写的「未启用」占位（交互 2.2 的表格里就留着这一格）。
         **覆盖率一个字不改**（P4 边界 2 / P4.5 边界 2）：这里只是数任务，不进任何比率。 */
      SELECT project_id, COUNT(*) AS ci_task_count FROM ci_tasks GROUP BY project_id
    ) ct ON ct.project_id = p.id
    ${where}
    ORDER BY p.created_at DESC
    ${limitFragment}`, params);

  const projects = result.rows.map((row) => {
    const executionCount = Number(row.execution_count);
    /* Pass rate divides by runs that produced a verdict, not by every row. */
    const judgedCount = Number(row.judged_count);
    const endpointCount = Number(row.endpoint_count);
    const executedEndpointCount = Number(row.executed_endpoint_count);
    const passedCount = Number(row.passed_count);
    const coveredEndpointCount = Number(row.covered_endpoint_count);
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ""),
      endpointCount,
      environmentCount: Number(row.environment_count),
      executedEndpointCount,
      executionCount,
      judgedCount,
      passedCount,
      caseCount: Number(row.case_count),
      coveredEndpointCount,
      scheduleCount: Number(row.schedule_count),
      ciTaskCount: Number(row.ci_task_count),
      /* null, not 0: "no runs yet" and "everything failed" are different facts. */
      passRate: judgedCount ? (passedCount / judgedCount) * 100 : null,
      completionRate: endpointCount ? (executedEndpointCount / endpointCount) * 100 : null,
      coverageRate: endpointCount ? (coveredEndpointCount / endpointCount) * 100 : null,
      lastExecutionAt: row.last_execution_at ? new Date(row.last_execution_at).toISOString() : null,
    };
  });

  return { projects, total: total ?? projects.length };
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ProjectFilters }>("/api/v1/dashboard", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;

    /* 聚合页永远全量（见 queryProjectMetrics 的 paging 注释），不透传分页参数。 */
    const { projects } = await queryProjectMetrics(user, request.query);
    const endpointCount = projects.reduce((sum, item) => sum + item.endpointCount, 0);
    const executionCount = projects.reduce((sum, item) => sum + item.executionCount, 0);
    /* Same rule as per-project: only runs with a verdict form the denominator. */
    const judgedCount = projects.reduce((sum, item) => sum + item.judgedCount, 0);
    const passedCount = projects.reduce((sum, item) => sum + item.passedCount, 0);
    const executedEndpointCount = projects.reduce((sum, item) => sum + item.executedEndpointCount, 0);
    const coveredEndpointCount = projects.reduce((sum, item) => sum + item.coveredEndpointCount, 0);

    return success({
      projectCount: projects.length,
      endpointCount,
      environmentCount: projects.reduce((sum, item) => sum + item.environmentCount, 0),
      executionCount,
      passRate: judgedCount ? (passedCount / judgedCount) * 100 : null,
      completionRate: endpointCount ? (executedEndpointCount / endpointCount) * 100 : null,
      /* Real numbers now that接口用例 exist (P1). */
      coverageRate: endpointCount ? (coveredEndpointCount / endpointCount) * 100 : null,
      testCaseCount: projects.reduce((sum, item) => sum + item.caseCount, 0),
      /* Real numbers now that CI tasks exist (P4.5-11). */
      ciTaskCount: projects.reduce((sum, item) => sum + item.ciTaskCount, 0),
      /* Real numbers now that schedules exist (P3-6). */
      scheduleCount: projects.reduce((sum, item) => sum + item.scheduleCount, 0),
      projects,
    });
  });
}
