import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapExecutionStep } from "../models/types.js";

/**
 * 报告（P3-6，边界 13、14、15）。
 *
 * 一份报告 = 一次套件执行的只读视图（6.4 的四段：标识 / 触发 / 结论 / 明细），
 * 不建新表：名字入队时已定（suite_executions.report_name），触发三列在
 * execution_index，成员明细在 execution_steps。接口把它们拼起来并**算出**派生值
 * （耗时、通过率、排队等待）——界面不自己减时间戳，减法只有一份实现。
 *
 * 明细不分页（边界 14）：成员有 SUITE_MAX_MEMBERS=200 硬上限，用途就是「通读一遍
 * 确认哪几个失败」，翻页会让「一共有几个失败」需要翻完才数得出来。
 */

/** 趋势的时间范围（6.2）：小时桶（24h）或天桶（7d/30d）。 */
const RANGES = {
  "24h": { interval: "24 hours", bucket: "hour", buckets: 24 },
  "7d": { interval: "7 days", bucket: "day", buckets: 7 },
  "30d": { interval: "30 days", bucket: "day", buckets: 30 },
} as const;
type RangeKey = keyof typeof RANGES;

/** 派生指标都由接口算（边界 13）：墙钟耗时、排队等待、通过率。 */
function derivedColumns(): string {
  return `
    CASE WHEN se.finished_at IS NOT NULL AND se.started_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (se.finished_at - se.started_at)) * 1000 END AS duration_ms,
    CASE WHEN se.started_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (se.started_at - se.created_at)) * 1000 END AS queue_ms,
    CASE WHEN se.total > 0
      THEN ROUND(se.success_count::numeric * 100 / se.total, 1) END AS pass_rate`;
}

/**
 * 趋势与汇总的样本口径（P4 边界 1）。
 *
 * 默认只算 `flow` / `suite`：外部 CI 的 `latency_ms` 是用户进程里的客户端耗时，与平台的
 * 墙钟耗时不是一个口径，混进同一条分位数曲线得到的是一个谁都不认的数；而一次 `-m smoke`
 * 的局部跑会把通过率拉出一个没人认的台阶。
 *
 * `includeIngest=true` 才把 `kind='ingest'` 放进样本——趋势页的开关**默认关闭**，让人可以
 * 自己要那份混合视图。这是一段代码作者写死的 SQL 片段，不是请求值拼接。
 */
function sampleKinds(includeIngest: boolean) {
  return includeIngest ? "('flow', 'suite', 'ingest')" : "('flow', 'suite')";
}

export async function reportRoutes(app: FastifyInstance) {
  /**
   * 报告列表（边界 14 分页 + 触发源/状态筛选，6.4 的三入口共用这份数据）。
   */
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; triggerSource?: string; status?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/suite-reports", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["se.project_id = $1"];
    if (request.query.keyword?.trim()) { params.push(`%${request.query.keyword.trim()}%`); clauses.push(`(se.report_name ILIKE $${params.length} OR se.suite_name ILIKE $${params.length})`); }
    if (request.query.triggerSource && request.query.triggerSource !== "all") { params.push(request.query.triggerSource); clauses.push(`ei.trigger_source = $${params.length}`); }
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`se.status = $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM suite_executions se JOIN execution_index ei ON ei.id = se.execution_index_id WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(
      `SELECT se.*, ${derivedColumns()}, ei.trigger_source, ei.trigger_ref_id, ei.trigger_ref_name
         FROM suite_executions se JOIN execution_index ei ON ei.id = se.execution_index_id
        WHERE ${where}
        ORDER BY se.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const rows = result.rows.map((row) => ({
      id: String(row.id),
      executionIndexId: row.execution_index_id ? String(row.execution_index_id) : undefined,
      reportName: row.report_name ? String(row.report_name) : null,
      suiteName: String(row.suite_name),
      environmentName: row.environment_name ? String(row.environment_name) : null,
      runnerLabel: String(row.runner_label ?? "default"),
      triggerSource: String(row.trigger_source ?? "manual"),
      triggerRefId: row.trigger_ref_id ? String(row.trigger_ref_id) : null,
      triggerRefName: row.trigger_ref_name ? String(row.trigger_ref_name) : null,
      variableOverrides: (row.variable_overrides ?? {}) as Record<string, string>,
      status: String(row.status),
      total: Number(row.total), successCount: Number(row.success_count), failedCount: Number(row.failed_count), skippedCount: Number(row.skipped_count),
      passRate: row.pass_rate === null || row.pass_rate === undefined ? null : Number(row.pass_rate),
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
      queueMs: row.queue_ms === null || row.queue_ms === undefined ? null : Number(row.queue_ms),
      createdAt: new Date(String(row.created_at)).toISOString(),
      startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
      finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
    }));
    return success(rows, { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 一份报告：摘要 + 成员明细（不分页，边界 14）。
   *
   * 只有 suite 执行是报告（边界 13：流程执行详情已是它的报告，不为流程再做一层）。
   */
  app.get<{ Params: { id: string; executionId: string } }>("/api/v1/projects/:id/suite-reports/:executionId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.executionId)) return fail(reply, 404, 2001, "report not found");
    const result = await pool.query(
      `SELECT se.*, ${derivedColumns()}, ei.trigger_source, ei.trigger_ref_id, ei.trigger_ref_name
         FROM suite_executions se JOIN execution_index ei ON ei.id = se.execution_index_id
        WHERE se.id = $1 AND se.project_id = $2`,
      [request.params.executionId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "report not found");
    const row = result.rows[0];
    /* 顶层步骤 = 成员明细（与套件运行抽屉同一口径）；循环/子流程的内层证据按需走
       execution-steps 的 children 路由。 */
    const steps = await pool.query(
      "SELECT * FROM execution_steps WHERE index_id = $1 AND parent_step_id IS NULL ORDER BY position, created_at",
      [row.execution_index_id],
    );
    return success({
      id: String(row.id),
      executionIndexId: String(row.execution_index_id),
      reportName: row.report_name ? String(row.report_name) : null,
      suiteName: String(row.suite_name),
      environmentName: row.environment_name ? String(row.environment_name) : null,
      runnerLabel: String(row.runner_label ?? "default"),
      triggerSource: String(row.trigger_source ?? "manual"),
      triggerRefId: row.trigger_ref_id ? String(row.trigger_ref_id) : null,
      triggerRefName: row.trigger_ref_name ? String(row.trigger_ref_name) : null,
      variableOverrides: (row.variable_overrides ?? {}) as Record<string, string>,
      status: String(row.status),
      error: row.error ? String(row.error) : null,
      total: Number(row.total), successCount: Number(row.success_count), failedCount: Number(row.failed_count), skippedCount: Number(row.skipped_count),
      passRate: row.pass_rate === null || row.pass_rate === undefined ? null : Number(row.pass_rate),
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
      queueMs: row.queue_ms === null || row.queue_ms === undefined ? null : Number(row.queue_ms),
      createdAt: new Date(String(row.created_at)).toISOString(),
      startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
      finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
      members: steps.rows.map(mapExecutionStep),
    });
  });

  /**
   * 趋势（边界 11）：SQL 补空桶 + percentile_cont 分位数。
   *
   * `generate_series` LEFT JOIN 是刻意的——前端补桶会让「这一小时没有执行」与
   「这一小时全失败」在折线上长得一样。分位数在 SQL 里算，不在 Node 里排序：把窗口
   * 内所有行拉进内存只为了让 JS sort 一遍，是趋势接口最经典的慢法。样本与告警同一
   * 口径（已定局的 flow/suite 父执行）。
   *
   * `includeIngest=1` 才把仓库上报算进来（P4 边界 1），开关默认关——理由见
   * `sampleKinds`。耗时分位数在混合视图下会掺进客户端耗时，这正是它不默认打开的原因。
   */
  app.get<{ Params: { id: string }; Querystring: { range?: string; includeIngest?: string } }>("/api/v1/projects/:id/reports/trend", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const range = (request.query.range && request.query.range in RANGES ? request.query.range : "24h") as RangeKey;
    const config = RANGES[range];
    const includeIngest = request.query.includeIngest === "1" || request.query.includeIngest === "true";
    /* 桶数恰好 = buckets 个（generate_series 双端闭合会多一个），最后一桶是进行中的
       当前桶——它的计数随执行增长，这是实时图的常态。 */
    const result = await pool.query(
      `WITH buckets AS (
         SELECT generate_series(
                  date_trunc('${config.bucket}', now()) - INTERVAL '${config.buckets - 1} ${config.bucket}s',
                  date_trunc('${config.bucket}', now()),
                  INTERVAL '1 ${config.bucket}') AS bucket
       )
       SELECT b.bucket,
              COUNT(ei.id)::int AS total,
              COUNT(ei.id) FILTER (WHERE ei.status = 'success')::int AS success_count,
              COUNT(ei.id) FILTER (WHERE ei.status = 'failed')::int AS failed_count,
              percentile_cont(ARRAY[0.5, 0.9, 0.99]) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ei.finished_at - ei.started_at)) * 1000)
                FILTER (WHERE ei.finished_at IS NOT NULL AND ei.started_at IS NOT NULL) AS durations
         FROM buckets b
         LEFT JOIN execution_index ei
           ON ei.created_at >= b.bucket AND ei.created_at < b.bucket + INTERVAL '1 ${config.bucket}'
          AND ei.project_id = $1 AND ei.kind IN ${sampleKinds(includeIngest)} AND ei.status IN ('success', 'failed')
        GROUP BY b.bucket ORDER BY b.bucket`,
      [context.project.id],
    );
    return success({
      range,
      includeIngest,
      buckets: result.rows.map((row) => ({
        bucket: new Date(String(row.bucket)).toISOString(),
        total: Number(row.total),
        successCount: Number(row.success_count),
        failedCount: Number(row.failed_count),
        passRate: Number(row.total) > 0 ? Math.round((Number(row.success_count) / Number(row.total)) * 1000) / 10 : null,
        /* 空桶的 duration 分位是 null：没有样本就没有耗时结论。 */
        p50: row.durations ? Math.round(Number(row.durations[0])) : null,
        p90: row.durations ? Math.round(Number(row.durations[1])) : null,
        p99: row.durations ? Math.round(Number(row.durations[2])) : null,
      })),
    });
  });

  /**
   * 汇总（6.2）：总量 + 失败分布（按接口 / 按错误类型）。
   *
   * 按接口的失败分布来自叶子 executions（接口粒度），按错误类型的来自断言/请求错误
   * 的归类列。窗口与趋势同口径（默认 24h，可带 range），样本口径也同款（默认排除
   * 仓库上报，`includeIngest=1` 才含，P4 边界 1）。
   */
  app.get<{ Params: { id: string }; Querystring: { range?: string; includeIngest?: string } }>("/api/v1/projects/:id/reports/summary", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const range = (request.query.range && request.query.range in RANGES ? request.query.range : "24h") as RangeKey;
    const interval = RANGES[range].interval;
    const includeIngest = request.query.includeIngest === "1" || request.query.includeIngest === "true";
    const totals = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
              COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled_count,
              AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL AND started_at IS NOT NULL) AS avg_duration_ms
         FROM execution_index
        WHERE project_id = $1 AND kind IN ${sampleKinds(includeIngest)} AND created_at >= now() - INTERVAL '${interval}'`,
      [context.project.id],
    );
    const row = totals.rows[0];
    const settled = Number(row.success_count) + Number(row.failed_count);
    /* 按接口的失败分布：叶子执行按 endpoint_name 快照分组（Spec 4.4：改名/删除后仍
       读得通），只看失败，Top 20——找一个坏接口不需要看完 200 行。 */
    const byEndpoint = await pool.query(
      `SELECT endpoint_name, COUNT(*)::int AS failed
         FROM executions
        WHERE project_id = $1 AND status = 'failed' AND created_at >= now() - INTERVAL '${interval}'
        GROUP BY endpoint_name ORDER BY failed DESC, endpoint_name LIMIT 20`,
      [context.project.id],
    );
    /* 按错误类型：三级归类——断言失败（响应正常但有未通过的断言/脚本检查）、请求层
       失败（没拿到响应，其中含超时）。error 正文千奇百怪，按结构归类比按文本枚举稳。 */
    const byType = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status_code IS NULL)::int AS request_failures,
         COUNT(*) FILTER (WHERE status_code IS NULL AND error ILIKE '%timeout%')::int AS timeouts,
         COUNT(*) FILTER (WHERE status_code IS NOT NULL
                            AND EXISTS (SELECT 1 FROM jsonb_array_elements(assertion_results) a WHERE NOT (a->>'passed')::boolean))::int AS assertion_failures,
         COUNT(*) FILTER (WHERE status_code IS NOT NULL
                            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(assertion_results) a WHERE NOT (a->>'passed')::boolean))::int AS script_failures
       FROM executions
      WHERE project_id = $1 AND status = 'failed' AND created_at >= now() - INTERVAL '${interval}'`,
      [context.project.id],
    );
    const types = byType.rows[0];
    return success({
      range,
      includeIngest,
      total: Number(row.total),
      successCount: Number(row.success_count),
      failedCount: Number(row.failed_count),
      canceledCount: Number(row.canceled_count),
      passRate: settled > 0 ? Math.round((Number(row.success_count) / settled) * 1000) / 10 : null,
      avgDurationMs: row.avg_duration_ms === null || row.avg_duration_ms === undefined ? null : Math.round(Number(row.avg_duration_ms)),
      failures: {
        byEndpoint: byEndpoint.rows.map((entry) => ({ endpoint: String(entry.endpoint_name), failed: Number(entry.failed) })),
        byType: {
          assertion: Number(types.assertion_failures),
          script: Number(types.script_failures),
          timeout: Number(types.timeouts),
          request: Math.max(0, Number(types.request_failures) - Number(types.timeouts)),
        },
      },
    });
  });
}
