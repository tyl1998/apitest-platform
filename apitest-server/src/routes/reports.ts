import type { FastifyInstance, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { loadSuiteReport } from "../lib/reportPayload.js";
import { NOT_SELF_DEBUG, PASS_RATE_SQL, passRateOf, sampleKinds, type SampleScope } from "../lib/metrics.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";

/** 报告列表行的归因聚合（P8-3）。`categories` 按已归因条数降序——列表列宽有限，最常见的
 *  原因排前面；`name` 随行带出，读侧（列表列）不再依赖字典请求。 */
export type ReportAttributionSummary = {
  failed: number;
  attributed: number;
  categories: { code: string; name: string; count: number }[];
};

/**
 * 报告（P3-6，边界 13、14、15）。
 *
 * 一份报告 = 一次执行的只读视图（6.4 的四段：标识 / 触发 / 结论 / 明细），
 * 不建新表：名字入队时已定（suite_executions.report_name），触发三列在
 * execution_index，成员明细在 execution_steps。接口把它们拼起来并**算出**派生值
 * （耗时、通过率、排队等待）——界面不自己减时间戳，减法只有一份实现。
 *
 * 明细不分页（边界 14）：成员有 SUITE_MAX_MEMBERS=200 硬上限，用途就是「通读一遍
 * 确认哪几个失败」，翻页会让「一共有几个失败」需要翻完才数得出来。
 *
 * 2026-09-02：报告列表从「只有套件」扩成**套件 + 仓库执行**两类。用户的口径是
 * 「总报告列表」——一次执行产出了什么结论就该在这里找得到，不关心它落在哪张表；
 * 套件在 suite_executions、仓库执行在 pipeline_runs，两边 UNION 出同一列形状
 * （kind 区分，行点开各走各的详情页）。
 */

/** 趋势的时间范围（6.2）：小时桶（24h）或天桶（7d/30d）。 */
const RANGES = {
  "24h": { interval: "24 hours", bucket: "hour", buckets: 24 },
  "7d": { interval: "7 days", bucket: "day", buckets: 7 },
  "30d": { interval: "30 days", bucket: "day", buckets: 30 },
} as const;
type RangeKey = keyof typeof RANGES;

/**
 * pipeline run 状态 → 报告列表的统一状态词汇（与 execution_index 的 indexStatusOf
 * 同一口径：aborted/timed_out 归 failed；claimed/cancelling 是 running 的细节）。
 */
const RUNNER_STATUS_SQL = `CASE pr.status
  WHEN 'success' THEN 'success'
  WHEN 'queued' THEN 'queued'
  WHEN 'canceled' THEN 'canceled'
  WHEN 'claimed' THEN 'running'
  WHEN 'running' THEN 'running'
  WHEN 'cancelling' THEN 'running'
  ELSE 'failed' END`;

/**
 * 趋势与汇总的样本口径（P4 边界 1 + P4.5 边界 2；2026-09-10 用户验收反馈起三态化）
 * ——收敛在 `lib/metrics.ts`（P8-1 口径收口），理由与原文见该文件：`platform` 只算
 * flow/suite，`repo` 只算 ingest/runner（两者一体不拆），`all` 混合。
 */

/** `?scope=platform|repo|all` 的单点解析（趋势与汇总两处共用；白名单外回 platform）。 */
function readSampleScope(value: string | undefined): SampleScope {
  return value === "repo" || value === "all" ? value : "platform";
}

/**
 * `?from=&to=` 时间窗参数（P8-4，下钻前置）：ISO 时间戳，解析失败 400（不静默
 * 丢弃——下钻点的是「这一段的报告」，丢窗会给出全量历史）。与 endpoints.ts 的
 * 同名解析同一份语义，各留一份的理由见彼处注释。
 */
function readTimeRange(query: { from?: string; to?: string }, reply: FastifyReply): { from: Date | null; to: Date | null } | undefined {
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if ((query.from && Number.isNaN(from!.getTime())) || (query.to && Number.isNaN(to!.getTime()))) {
    fail(reply, 400, 1001, "from/to must be ISO timestamps");
    return undefined;
  }
  return { from, to };
}

/**
 * 归因类型筛选（P8-3 验收反馈①，多选，`?attribution=code,code`）：报告命中 = 它的
 * 失败目标里**至少一条**的归因分类落在所选集内；`__unattributed__` 是「未归因」伪值
 * ——命中「存在未归因失败行」的报告（分类 code 以小写字母开头，双下划线前缀不可能
 * 与合法 code 撞车）。无失败的报告在任一选择下都不命中。
 *
 * `__attributed__`（看板「已归因失败」读数下钻，2026-09-10）是对称的「已归因」
 * 伪值——命中「存在已归因失败行」的报告。与具体分类 code 可以多选共存（语义 =
 * 已归因的某几类 OR 任一已归因，同一 EXISTS 展开天然覆盖）。
 *
 * 目标推导与 `loadReportAttributions` 同一口径（套件失败成员 / run 的 failed-error
 * 用例行），但这里是**相关子查询**逐报告 EXISTS，而不是先聚合——它要嵌进列表 WHERE
 * 让 COUNT 与分页两条 SQL 共用一份过滤，聚合成 CTE 再 JOIN 会把两条查询的形状都改掉。
 * 片段全部代码写死（`$1` 项目、`$n` 分类数组），请求值只经参数进 SQL。
 */
function attributionFilterSql(categoriesParam: number): string {
  const suiteTargetType = "CASE WHEN es.http_execution_id IS NOT NULL THEN 'execution' ELSE 'execution_step' END";
  const suiteTargetId = "COALESCE(es.http_execution_id, es.id)";
  return `(
    (kind = 'suite' AND EXISTS (
      SELECT 1
        FROM suite_executions se
        JOIN execution_steps es ON es.index_id = se.execution_index_id AND es.parent_step_id IS NULL
       WHERE se.id = reports.id AND se.project_id = $1 AND es.status = 'failed'
         AND (
           EXISTS (
             SELECT 1 FROM failure_attributions fa
              WHERE fa.project_id = $1 AND fa.target_type = ${suiteTargetType}
                AND fa.target_id = ${suiteTargetId} AND (
                  fa.category = ANY($${categoriesParam})
                  /* 已归因伪值：存在归因行即命中（分类无关）。 */
                  OR '__attributed__' = ANY($${categoriesParam})
                )
           )
           OR ('__unattributed__' = ANY($${categoriesParam}) AND NOT EXISTS (
             SELECT 1 FROM failure_attributions fa
              WHERE fa.project_id = $1 AND fa.target_type = ${suiteTargetType}
                AND fa.target_id = ${suiteTargetId}
           ))
         )
    ))
    OR (kind = 'runner' AND EXISTS (
      SELECT 1
        FROM pipeline_run_cases prc
       WHERE prc.pipeline_run_id = reports.id AND prc.status IN ('failed', 'error')
         AND (
           EXISTS (
             SELECT 1 FROM failure_attributions fa
              WHERE fa.project_id = $1 AND fa.target_type = 'pipeline_run_case' AND fa.target_id = prc.id
                AND (
                  fa.category = ANY($${categoriesParam})
                  OR '__attributed__' = ANY($${categoriesParam})
                )
           )
           OR ('__unattributed__' = ANY($${categoriesParam}) AND NOT EXISTS (
             SELECT 1 FROM failure_attributions fa
              WHERE fa.project_id = $1 AND fa.target_type = 'pipeline_run_case' AND fa.target_id = prc.id
           ))
         )
    ))
  )`;
}

/**
 * 报告列表行的归因聚合（P8-3）：一份报告的「失败行里有多少已归因、都归成了什么」。
 *
 * 归因只在叶子失败上打（边界 4），所以「失败行」按报告类型取最小可读单元：
 * - 套件报告 = 顶层失败成员步骤；目标推导与 `loadSuiteReport` 的随行 JOIN 同一句
 *   ——用例成员（有 httpExecutionId）归到 executions 行，流程成员归到步骤行自身；
 * - 仓库执行 = status IN ('failed','error') 的 pipeline_run_cases 行（error 已算失败，
 *   与 run 计数同口径）。
 *
 * 只对**当前页**的行聚合（IN 数组 ≤ pageSize）：列表是分页读，逐页聚合是 O(页) 而不是
 * O(全量)；报告详情页自己随行带归因，不经过这里。两侧 UNION 进同一个 targets CTE，
 * 聚合尾巴只写一份。
 */
async function loadReportAttributions(projectId: string, suiteIds: string[], runnerIds: string[]): Promise<Map<string, ReportAttributionSummary>> {
  const out = new Map<string, ReportAttributionSummary>();
  if (!suiteIds.length && !runnerIds.length) return out;
  const result = await pool.query(
    `WITH targets AS (
       SELECT se.id AS report_id,
              CASE WHEN es.http_execution_id IS NOT NULL THEN 'execution' ELSE 'execution_step' END AS target_type,
              COALESCE(es.http_execution_id, es.id) AS target_id
         FROM suite_executions se
         JOIN execution_steps es ON es.index_id = se.execution_index_id AND es.parent_step_id IS NULL
        WHERE se.project_id = $1 AND se.id = ANY($2::uuid[]) AND es.status = 'failed'
       UNION ALL
       SELECT prc.pipeline_run_id, 'pipeline_run_case'::text, prc.id
         FROM pipeline_run_cases prc
        WHERE prc.pipeline_run_id = ANY($3::uuid[]) AND prc.status IN ('failed', 'error')
     ),
     joined AS (
       SELECT t.report_id, fa.category, fc.name AS category_name
         FROM targets t
         LEFT JOIN failure_attributions fa
           ON fa.project_id = $1 AND fa.target_type = t.target_type AND fa.target_id = t.target_id
         LEFT JOIN failure_categories fc ON fc.code = fa.category
     ),
     per_report AS (
       SELECT report_id, COUNT(*)::int AS failed, COUNT(category)::int AS attributed
         FROM joined GROUP BY report_id
     ),
     per_category AS (
       SELECT report_id, jsonb_agg(jsonb_build_object('code', category, 'name', category_name, 'count', n) ORDER BY n DESC) AS categories
         FROM (
           SELECT report_id, category, category_name, COUNT(*)::int AS n
             FROM joined WHERE category IS NOT NULL GROUP BY report_id, category, category_name
         ) c GROUP BY report_id
     )
     SELECT pr.report_id, pr.failed, pr.attributed, COALESCE(pc.categories, '[]'::jsonb) AS categories
       FROM per_report pr LEFT JOIN per_category pc ON pc.report_id = pr.report_id`,
    [projectId, suiteIds, runnerIds],
  );
  for (const row of result.rows) {
    out.set(String(row.report_id), {
      failed: Number(row.failed),
      attributed: Number(row.attributed),
      categories: (row.categories as { code: string; name: string; count: number }[]).map((each) => ({
        code: String(each.code), name: String(each.name), count: Number(each.count),
      })),
    });
  }
  return out;
}

export async function reportRoutes(app: FastifyInstance) {
  /**
   * 报告列表（边界 14 分页 + 触发源/状态/类型筛选）。
   *
   * 两个来源 UNION 成同一列形状后在外层过滤排序——keyword 与 status 只出现一次
   * （每边各写一份 `ILIKE` 是两份口径，改一边漏一边）。数量级是单项目的执行行，
   * 先并后滤没有代价。
   *
   * `source`（all|suite|runner）：默认 all。仓库执行的报告名用「任务名 #序号」——
   * 任务删除级联掉 run 后，历史里那行也就消失了（ci_tasks 外键），这与套件快照
   * （suite_name 落在执行行上）不同，但任务删了历史跟着走是迁移 038 的既定语义。
   */
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; triggerSource?: string; status?: string; source?: string; attribution?: string; from?: string; to?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/suite-reports", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id];
    const clauses: string[] = ["project_id = $1"];
    /* 时间窗（P8-4，下钻前置）：套件与仓库两源的 UNION 视图带统一的 created_at，
       外层过滤一份即可覆盖两边。 */
    const range = readTimeRange(request.query, reply);
    if (!range) return;
    if (range.from) { params.push(range.from); clauses.push(`created_at >= $${params.length}`); }
    if (range.to) { params.push(range.to); clauses.push(`created_at <= $${params.length}`); }
    const source = request.query.source === "suite" || request.query.source === "runner" ? request.query.source : "all";
    if (source !== "all") { params.push(source); clauses.push(`kind = $${params.length}`); }
    if (request.query.keyword?.trim()) { params.push(`%${request.query.keyword.trim()}%`); clauses.push(`(report_name ILIKE $${params.length} OR target_name ILIKE $${params.length})`); }
    if (request.query.triggerSource && request.query.triggerSource !== "all") { params.push(request.query.triggerSource); clauses.push(`trigger_source = $${params.length}`); }
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`status = $${params.length}`); }
    /* 归因类型多选（逗号分隔，去重截 20——选项最多字典数 + 未归因伪值，20 已宽裕）。 */
    const attributionCategories = request.query.attribution
      ? [...new Set(request.query.attribution.split(",").map((code) => code.trim()).filter(Boolean))].slice(0, 20)
      : [];
    if (attributionCategories.length) {
      params.push(attributionCategories);
      clauses.push(attributionFilterSql(params.length));
    }
    const where = clauses.join(" AND ");

    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM (${reportUnionSql()}) reports WHERE ${where}`,
      params,
    );
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(
      `SELECT * FROM (${reportUnionSql()}) reports
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    /* 归因聚合作用于当前页（见 loadReportAttributions）：报告行本身不动，聚合随行附加。 */
    const attributions = await loadReportAttributions(
      context.project.id,
      result.rows.filter((row) => row.kind === "suite").map((row) => String(row.id)),
      result.rows.filter((row) => row.kind === "runner").map((row) => String(row.id)),
    );
    const rows = result.rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind) as "suite" | "runner",
      reportName: row.report_name ? String(row.report_name) : null,
      targetName: String(row.target_name),
      environmentName: row.environment_name ? String(row.environment_name) : null,
      runnerLabel: String(row.runner_label ?? "default"),
      triggerSource: String(row.trigger_source ?? "manual"),
      triggerRefId: row.trigger_ref_id ? String(row.trigger_ref_id) : null,
      triggerRefName: row.trigger_ref_name ? String(row.trigger_ref_name) : null,
      triggerSourceUrl: row.trigger_source_url ? String(row.trigger_source_url) : null,
      /* P11 边界 11：触发人（null = 定时 / Webhook / 非人 CI，前端显示「系统」）。 */
      triggeredByEmail: row.triggered_by_email ? String(row.triggered_by_email) : null,
      variableOverrides: (row.variable_overrides ?? {}) as Record<string, string>,
      status: String(row.status),
      total: Number(row.total), successCount: Number(row.success_count), failedCount: Number(row.failed_count), skippedCount: Number(row.skipped_count),
      passRate: row.pass_rate === null || row.pass_rate === undefined ? null : Number(row.pass_rate),
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
      queueMs: row.queue_ms === null || row.queue_ms === undefined ? null : Number(row.queue_ms),
      attribution: attributions.get(String(row.id)) ?? { failed: 0, attributed: 0, categories: [] },
      createdAt: new Date(String(row.created_at)).toISOString(),
      startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
      finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
    }));
    return success(rows, { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 一份报告：摘要 + 成员明细（不分页，边界 14）。
   *
   * 只有 suite 执行走这个详情（边界 13：流程执行详情已是它的报告，不为流程再做一层；
   * 仓库执行的报告是 run 详情页，形状完全不同）。
   */
  app.get<{ Params: { id: string; executionId: string } }>("/api/v1/projects/:id/suite-reports/:executionId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.executionId)) return fail(reply, 404, 2001, "report not found");
    const report = await loadSuiteReport(context.project.id, request.params.executionId);
    if (!report) return fail(reply, 404, 2001, "report not found");
    return success(report);
  });

  /**
   * 趋势（边界 11）：SQL 补空桶 + percentile_cont 分位数。
   *
   * `generate_series` LEFT JOIN 是刻意的——前端补桶会让「这一小时没有执行」与
   「这一小时全失败」在折线上长得一样。分位数在 SQL 里算，不在 Node 里排序：把窗口
   * 内所有行拉进内存只为了让 JS sort 一遍，是趋势接口最经典的慢法。样本与告警同一
   * 口径（已定局的 flow/suite 父执行）；单步调试的一次性自指索引行（detail_id = id）
   * 自 P8-1 起同样排除——列表侧早已排除，趋势与汇总此前漏了（P8 启动核对锚点②）。
   *
   * `?scope=` 三态口径（2026-09-10 用户验收反馈）：`platform`（默认）只算平台自己
   * 跑的 flow/suite；`repo` 只算仓库侧（上报 + Runner）；`all` 混合——理由见
   * `metrics.ts 的 sampleKinds`。耗时分位数在混合视图下会掺进客户端耗时，这正是
   * platform 是默认的原因。
   */
  app.get<{ Params: { id: string }; Querystring: { range?: string; scope?: string } }>("/api/v1/projects/:id/reports/trend", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const range = (request.query.range && request.query.range in RANGES ? request.query.range : "24h") as RangeKey;
    const config = RANGES[range];
    const scope = readSampleScope(request.query.scope);
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
          AND ei.project_id = $1 AND ei.kind IN ${sampleKinds(scope)} AND ei.status IN ('success', 'failed')
          AND ${NOT_SELF_DEBUG("ei")}
        GROUP BY b.bucket ORDER BY b.bucket`,
      [context.project.id],
    );
    return success({
      range,
      scope,
      buckets: result.rows.map((row) => ({
        bucket: new Date(String(row.bucket)).toISOString(),
        total: Number(row.total),
        successCount: Number(row.success_count),
        failedCount: Number(row.failed_count),
        /* 通过率口径（P8-1 收口）：分母 = success + failed（桶内样本本就只含定局行），
           与报告/通知同一公式（metrics.passRateOf）。此前用 total 当分母在语义上
           恰好等价（status 过滤已把非定局行挡掉），改为同一处实现防止两处漂移。 */
        passRate: passRateOf(Number(row.success_count), Number(row.failed_count)),
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
   * 的归类列。窗口与趋势同口径（默认 24h，可带 range），样本口径也同款（`?scope=`
   * 三态，与趋势共用 `readSampleScope`）；总量段自 P8-1 起同样排除单步调试的自指
   * 索引行（`NOT_SELF_DEBUG`，与趋势/列表侧对齐）。
   *
   * P8-1 对 ②③ 段（byEndpoint / byType 的仓库口径一致性）**不动**：这两段读
   * 的是叶子 `executions`（接口粒度），ingest/runner 的失败不落在那张表里。三态化
   * 后的处理：`repo` 口径下这两段**不查不返回**（数据源错位，查出来的平台数字
   * 挂在「仅仓库」标题下是错的）；`all` 口径下照旧（平台叶子是混合样本的一部分，
   * 「仓库失败不在分布里」是 P8-1 记录的既有缺陷，P8-4 `/stats/*` 收口）。
   */
  app.get<{ Params: { id: string }; Querystring: { range?: string; scope?: string } }>("/api/v1/projects/:id/reports/summary", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const range = (request.query.range && request.query.range in RANGES ? request.query.range : "24h") as RangeKey;
    const interval = RANGES[range].interval;
    const scope = readSampleScope(request.query.scope);
    const totals = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
              COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled_count,
              AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL AND started_at IS NOT NULL) AS avg_duration_ms
         FROM execution_index
         WHERE project_id = $1 AND kind IN ${sampleKinds(scope)} AND ${NOT_SELF_DEBUG()}
           AND created_at >= now() - INTERVAL '${interval}'`,
      [context.project.id],
    );
    const row = totals.rows[0];
    const repoOnly = scope === "repo";
    /* 按接口的失败分布：叶子执行按 endpoint_name 快照分组（Spec 4.4：改名/删除后仍
       读得通），只看失败，Top 20——找一个坏接口不需要看完 200 行。repo 口径跳过
       （见上方 doc 注释）。 */
    const byEndpointRows = repoOnly ? [] : (await pool.query(
      `SELECT endpoint_name, COUNT(*)::int AS failed
         FROM executions
        WHERE project_id = $1 AND status = 'failed' AND created_at >= now() - INTERVAL '${interval}'
        GROUP BY endpoint_name ORDER BY failed DESC, endpoint_name LIMIT 20`,
      [context.project.id],
    )).rows;
    /* 按错误类型：三级归类——断言失败（响应正常但有未通过的断言/脚本检查）、请求层
       失败（没拿到响应，其中含超时）。error 正文千奇百怪，按结构归类比按文本枚举稳。 */
    const types = repoOnly
      ? { request_failures: 0, timeouts: 0, assertion_failures: 0, script_failures: 0 }
      : (await pool.query(
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
      )).rows[0];
    return success({
      range,
      scope,
      total: Number(row.total),
      successCount: Number(row.success_count),
      failedCount: Number(row.failed_count),
      canceledCount: Number(row.canceled_count),
      /* 通过率口径（P8-1 收口）：分母 = success + failed，与趋势桶/报告/通知同一
         公式（metrics.passRateOf）。 */
      passRate: passRateOf(Number(row.success_count), Number(row.failed_count)),
      avgDurationMs: row.avg_duration_ms === null || row.avg_duration_ms === undefined ? null : Math.round(Number(row.avg_duration_ms)),
      failures: {
        byEndpoint: byEndpointRows.map((entry) => ({ endpoint: String(entry.endpoint_name), failed: Number(entry.failed) })),
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

/**
 * 报告列表的两源 UNION（套件 + 仓库执行）。列名刻意归一（`target_name`、`kind`），
 * 让外层过滤只写一份；`$1` 是 project_id，两边共用同一个占位符位置。
 *
 * 派生列里的通过率两侧共用 `metrics.PASS_RATE_SQL`（P8-1 收口——2026-09-03 起
 * 两边手写的公式就是 passed/(passed+failed)，收进口径库后与报告详情/通知同一份
 * 实现，防止两处漂移）；耗时/排队仍两边各自算——列名不同（se.* vs pr.*），
 * CASE 守卫各是各的，共享片段反而要模板函数传参。
 */
function reportUnionSql(): string {
  return `
    SELECT 'suite' AS kind, se.id, se.project_id, se.report_name, se.suite_name AS target_name,
           se.environment_name, se.runner_label, se.status, se.variable_overrides,
           se.total, se.success_count, se.failed_count, se.skipped_count,
           CASE WHEN se.finished_at IS NOT NULL AND se.started_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (se.finished_at - se.started_at)) * 1000 END AS duration_ms,
           CASE WHEN se.started_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (se.started_at - se.created_at)) * 1000 END AS queue_ms,
           ${PASS_RATE_SQL("se")} AS pass_rate,
           ei.trigger_source, ei.trigger_ref_id, ei.trigger_ref_name, ei.trigger_source_url,
           /* P11 边界 11：两个分支列序必须一致（UNION ALL 按位置对齐），所以这一列在
              两支里都紧跟 trigger_* 四列（含 trigger_source_url）。 */
           su_triggerer.email AS triggered_by_email,
           se.created_at, se.started_at, se.finished_at
      FROM suite_executions se
      JOIN execution_index ei ON ei.id = se.execution_index_id
      LEFT JOIN users su_triggerer ON su_triggerer.id = ei.triggered_by
     WHERE se.project_id = $1
    UNION ALL
    SELECT 'runner' AS kind, pr.id, pr.project_id,
           (COALESCE(t.name, 'ci task') || ' #' || pr.run_number) AS report_name,
           COALESCE(t.name, 'ci task') AS target_name,
           NULL::text AS environment_name, pr.runner_label, ${RUNNER_STATUS_SQL} AS status,
           NULL::jsonb AS variable_overrides,
           pr.case_total AS total, pr.passed_count AS success_count,
           pr.failed_count AS failed_count, pr.skipped_count AS skipped_count,
           CASE WHEN pr.finished_at IS NOT NULL AND pr.started_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (pr.finished_at - pr.started_at)) * 1000 END AS duration_ms,
           CASE WHEN pr.started_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (pr.started_at - pr.created_at)) * 1000 END AS queue_ms,
           ${PASS_RATE_SQL("pr", "passed_count")} AS pass_rate,
           pr.trigger_source, pr.trigger_ref_id, pr.trigger_ref_name, pr.trigger_source_url,
           pr_triggerer.email AS triggered_by_email,
           pr.created_at, pr.started_at, pr.finished_at
      FROM pipeline_runs pr
      LEFT JOIN ci_tasks t ON t.id = pr.ci_task_id
      LEFT JOIN users pr_triggerer ON pr_triggerer.id = pr.triggered_by
     WHERE pr.project_id = $1`;
}
