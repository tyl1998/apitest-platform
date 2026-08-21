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
 */
export async function queryProjectMetrics(user: User, filters: ProjectFilters) {
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
    ${where}
    ORDER BY p.created_at DESC`, params);

  return result.rows.map((row) => {
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
      /* null, not 0: "no runs yet" and "everything failed" are different facts. */
      passRate: judgedCount ? (passedCount / judgedCount) * 100 : null,
      completionRate: endpointCount ? (executedEndpointCount / endpointCount) * 100 : null,
      coverageRate: endpointCount ? (coveredEndpointCount / endpointCount) * 100 : null,
      lastExecutionAt: row.last_execution_at ? new Date(row.last_execution_at).toISOString() : null,
    };
  });
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ProjectFilters }>("/api/v1/dashboard", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;

    const projects = await queryProjectMetrics(user, request.query);
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
      /* Not yet built. null renders as "未启用" rather than a misleading 0. */
      ciTaskCount: null,
      scheduleCount: null,
      projects,
    });
  });
}
