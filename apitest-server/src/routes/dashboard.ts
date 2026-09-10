import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { currentUser } from "../lib/auth.js";
import { success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import type { MyRole, User } from "../models/types.js";

export type ProjectFilters = { keyword?: string; projectIds?: string };

/**
 * One aggregation per project, filtered in SQL.
 *
 * Counts come from separate grouped sub-selects rather than joined rows:
 * joining endpoints, environments and executions together multiplies each
 * table by the others and inflates every count.
 *
 * 2026-09-10 拆轻（P8-8 的读时聚合收口的第一刀，用户确认）：`/projects` 与
 * `/dashboard` 的读者不再重合——项目卡只要轻字段（身份 + 环境/接口/用例/流程/
 * 套件/仓库/文本用例计数），dashboard 聚合要执行面。共用一条七表全量聚合让
 * 项目列表页付了 817ms（P8-8 实测）买它不读的 executions 聚合。两个读者
 * 各自持自己的查询：
 * - `queryProjectMetrics`（本函数，给 /dashboard）：维持原状——执行面聚合
 *   是它的全部职责，七张表一张不少。
 * - `queryProjectList`（新，给 /projects）：只聚合资产计数表（全部是小表、
 *   GROUP BY 走 project_id 索引），executions 一次都不碰。
 *
 * 2026-09-11 P8-8 第二刀（子查询 WHERE 下推，计划原方向）：非管理员的可见集、
 * 以及任何收窄过滤（keyword / projectIds）先收敛成一份具体项目 id 集，压成
 * `= ANY($n)` 推进七个聚合子查询——executions 是七张表里唯一的大表（dev 库
 * 15.4 万行 / 215MB），下推前非管理员也在为**全平台**的 executions 付全表聚合
 * （P8-8 实测 817ms 的账就记在这里）；下推后聚合范围收敛到「自己读得着的项目」，
 * 小可见集走 `executions_project_created_at_idx`（EXPLAIN 实测 0.087ms）。
 * 管理员无过滤时不推（`all` 形态）——聚合对象本来就是全部可见项目，全表扫是
 * 诚实形状（与 stats.ts 的 resolveScope/pushScopeParam 同一对概念）。输出形状
 * 不变：外层 WHERE 原样保留（它决定哪些项目行出场），子查询下推只是把「聚合了
 * 但会被 LEFT JOIN 丢弃」的工作剪掉，分组结果一行不差。
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

  /* myRole（P6 边界 5）：非管理员从角色行读（下面的 EXISTS 已保证可见项目必有角色行，
     所以这里不会读到 NULL）；系统管理员短路成 'system_admin'，不多付这次子查询。
     占位符在 user.id 压栈那一刻记下，与动态过滤同一纪律。 */
  let myRoleSelect = "NULL::text AS my_role";
  if (!user.isSystemAdmin) {
    params.push(user.id);
    const userParam = `$${params.length}`;
    clauses.push(`EXISTS (SELECT 1 FROM user_project_roles upr WHERE upr.project_id = p.id AND upr.user_id = ${userParam})`);
    myRoleSelect = `(SELECT upr.role FROM user_project_roles upr WHERE upr.project_id = p.id AND upr.user_id = ${userParam}) AS my_role`;
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
  /* 过滤参数的个数在此刻定格（COUNT 切片用）——aggregateIds 还没压栈。 */
  const filterParamCount = params.length;

  /* P8-8 第二刀：把「这份 WHERE 会放行的项目」先收敛成一份具体 id 集，压一次参数、
     推进七个聚合子查询。非管理员 = 可见集 ∩ 过滤；管理员无过滤 = 不推（聚合对象
     本来就是全部项目，全表扫是诚实形状）。id 集由上面的 clauses 推导而不是重新实现
     一遍过滤——两侧不可能分叉。这一条 SELECT 走 projects 主键（几行就是几次索引
     读），代价可以忽略。 */
  let aggregateIds: string[] | undefined;
  if (!(user.isSystemAdmin && clauses.length === 0)) {
    const idRows = await pool.query<{ id: string }>(`SELECT p.id FROM projects p ${where}`, params);
    aggregateIds = idRows.rows.map((row) => String(row.id));
    /* 空集：主查询一行都不会出，聚合子查询推一个永不命中的占位 id——不为空集付
       ANY 扫描，也不留「不推 = 全表聚合」的歧义形状。 */
    if (aggregateIds.length === 0) aggregateIds = ["00000000-0000-0000-0000-000000000000"];
  }

  /* 分页时 total 数的是「这份 WHERE 命中的全量」，不是当前页行数——卡片墙的翻页器
     需要前者。不分页就不多付这次查询：dashboard 天然要拿全部行。COUNT 只吃过滤参数，
     aggregateIds 是主查询自己的占位符——切片传参，绝不让多余的参数进 bind message
     （node-pg 对参数个数严格，见 stats.ts pushParam 的教训）。 */
  let total: number | undefined;
  if (paging) {
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM projects p ${where}`, params.slice(0, filterParamCount));
    total = Number(count.rows[0].total);
  }

  /* 子查询下推的占位符追加在过滤参数之后、分页参数之前；三个形态共用同一个序号
     （同一条查询内多次引用同一参数是合法的）。 */
  const aggIdx = aggregateIds ? params.push(aggregateIds) : 0;
  const aggWhere = aggregateIds ? ` WHERE project_id = ANY($${aggIdx}::uuid[])` : "";
  /* LIMIT/OFFSET 占位符追加在其后，与动态过滤同一纪律。 */
  const limitFragment = paging ? `LIMIT $${params.length + 1} OFFSET $${params.length + 2}` : "";
  if (paging) params.push(paging.pageSize, (paging.page - 1) * paging.pageSize);
  const result = await pool.query(`
    SELECT p.id, p.name, p.description, p.created_at,
      ${myRoleSelect},
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
      COALESCE(sp.spec_total, 0)::int          AS spec_case_total,
      COALESCE(sp.spec_automated, 0)::int      AS spec_automated_count,
      ex.last_execution_at
    FROM projects p
    LEFT JOIN (SELECT project_id, COUNT(*) AS endpoint_count FROM endpoints${aggWhere} GROUP BY project_id) ep ON ep.project_id = p.id
    LEFT JOIN (SELECT project_id, COUNT(*) AS environment_count FROM environments${aggWhere} GROUP BY project_id) env ON env.project_id = p.id
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
      FROM executions${aggWhere} GROUP BY project_id
    ) ex ON ex.project_id = p.id
    LEFT JOIN (
      /* 覆盖 means "has at least one case" (交互文档 3.11), so the covered count
         is distinct endpoints, not the case total. */
      SELECT project_id, COUNT(*) AS case_count, COUNT(DISTINCT endpoint_id) AS covered_endpoint_count
      FROM test_cases${aggWhere} GROUP BY project_id
    ) tc ON tc.project_id = p.id
    LEFT JOIN (
      /* 调度数（P3-6）：建了多少条就是多少条——含停用的。停用的调度不是「不存在」，
         面板上把它藏掉只会让人以为少建了一条。 */
      SELECT project_id, COUNT(*) AS schedule_count FROM schedules${aggWhere} GROUP BY project_id
    ) sc ON sc.project_id = p.id
    LEFT JOIN (
      /* CI 任务数（P4.5-11）：与调度数同一条口径——建了多少条就是多少条，含停用的。
          看板上的这个数字此前是硬写的「未启用」占位（交互 2.2 的表格里就留着这一格）。
          **覆盖率一个字不改**（P4 边界 2 / P4.5 边界 2）：这里只是数任务，不进任何比率。 */
      SELECT project_id, COUNT(*) AS ci_task_count FROM ci_tasks${aggWhere} GROUP BY project_id
    ) ct ON ct.project_id = p.id
    LEFT JOIN (
      /* 自动化覆盖率（P7-6，边界 11，第三个口径——与接口覆盖率、仓库覆盖率并列
         展示、互不合并）：有 ≥1 条**非 endpoint** 绑定的已评审文本用例 / 全部
         已评审文本用例。endpoint 绑定表达「该测什么」，不算自动化进度；分母只数
         reviewed（迁移 053 前的 active——评审通过才算「在册」的用例）。项目没有
         文本用例时两个子查询都不命中，分子分母为 0，读数端给 null（「还没有用例」
         与「0% 覆盖」是两个事实）。 */
       SELECT project_id,
             COUNT(*) FILTER (WHERE status = 'reviewed')::int AS spec_total,
             COUNT(*) FILTER (WHERE status = 'reviewed' AND EXISTS (
               SELECT 1 FROM spec_case_links l WHERE l.spec_case_id = spec_cases.id AND l.target_type <> 'endpoint'
             ))::int AS spec_automated
        FROM spec_cases${aggWhere ? ` WHERE spec_cases.project_id = ANY($${aggIdx}::uuid[])` : ""} GROUP BY project_id
    ) sp ON sp.project_id = p.id
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
      /* P6 边界 5：项目列表同步带出，前端项目切换器/卡片墙不再发第二次请求。 */
      myRole: user.isSystemAdmin ? "system_admin" : (row.my_role as MyRole),
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
      /* 自动化覆盖率（P7-6，边界 11）：specCaseTotal 是已评审文本用例数（分母），
         specAutomatedCount 是其中有非 endpoint 绑定的条数（分子）。null = 还没有
         已评审用例（不是 0%）。 */
      specCaseTotal: Number(row.spec_case_total),
      specAutomatedCount: Number(row.spec_automated_count),
      automationRate: Number(row.spec_case_total)
        ? (Number(row.spec_automated_count) / Number(row.spec_case_total)) * 100
        : null,
      /* null, not 0: "no runs yet" and "everything failed" are different facts. */
      passRate: judgedCount ? (passedCount / judgedCount) * 100 : null,
      completionRate: endpointCount ? (executedEndpointCount / endpointCount) * 100 : null,
      coverageRate: endpointCount ? (coveredEndpointCount / endpointCount) * 100 : null,
      lastExecutionAt: row.last_execution_at ? new Date(row.last_execution_at).toISOString() : null,
    };
  });

  return { projects, total: total ?? projects.length };
}

/**
 * 项目列表的轻查询（2026-09-10 拆轻，见 queryProjectMetrics 头注释）：只聚合
 * 资产计数——六张全是小表、GROUP BY project_id 有索引；executions（P8-8 实测
 * 的大头）一次都不碰。myRole 随行带出（P6 边界 5），前端切换器不再发第二次请求。
 *
 * 计数口径与 /stats/overview 的资产面完全同款（跨项目合计时两边可对上）：文本用例
 * 总量数非废弃（deprecated 是软删）、仓库用例只数 active（removed 是对账历史，
 * 不是存量资产）、流程/套件/平台用例/接口/环境照行数。
 */
export async function queryProjectList(
  user: User,
  filters: ProjectFilters,
  paging?: { page: number; pageSize: number },
) {
  const params: unknown[] = [];
  const clauses: string[] = [];

  /* myRole 与 queryProjectMetrics 同款（P6 边界 5）。 */
  let myRoleSelect = "NULL::text AS my_role";
  if (!user.isSystemAdmin) {
    params.push(user.id);
    const userParam = `$${params.length}`;
    clauses.push(`EXISTS (SELECT 1 FROM user_project_roles upr WHERE upr.project_id = p.id AND upr.user_id = ${userParam})`);
    myRoleSelect = `(SELECT upr.role FROM user_project_roles upr WHERE upr.project_id = p.id AND upr.user_id = ${userParam}) AS my_role`;
  }

  const keyword = filters.keyword?.trim();
  if (keyword) {
    params.push(`%${keyword}%`);
    clauses.push(`(p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`);
  }

  const ids = (filters.projectIds?.split(",") ?? []).map((id) => id.trim()).filter(isUuid);
  if (ids.length) {
    params.push(ids);
    clauses.push(`p.id = ANY($${params.length}::uuid[])`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  let total: number | undefined;
  if (paging) {
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM projects p ${where}`, params);
    total = Number(count.rows[0].total);
  }
  const limitFragment = paging ? `LIMIT $${params.length + 1} OFFSET $${params.length + 2}` : "";
  if (paging) params.push(paging.pageSize, (paging.page - 1) * paging.pageSize);
  const result = await pool.query(`
    SELECT p.id, p.name, p.description, p.created_at,
      ${myRoleSelect},
      COALESCE(ep.endpoint_count, 0)::int    AS endpoint_count,
      COALESCE(env.environment_count, 0)::int AS environment_count,
      COALESCE(tc.case_count, 0)::int        AS case_count,
      COALESCE(fl.flow_count, 0)::int        AS flow_count,
      COALESCE(su.suite_count, 0)::int       AS suite_count,
      COALESCE(rc.repo_case_count, 0)::int   AS repo_case_count,
      COALESCE(sp.spec_total, 0)::int        AS spec_case_total
    FROM projects p
    LEFT JOIN (SELECT project_id, COUNT(*)::int AS endpoint_count FROM endpoints GROUP BY project_id) ep ON ep.project_id = p.id
    LEFT JOIN (SELECT project_id, COUNT(*)::int AS environment_count FROM environments GROUP BY project_id) env ON env.project_id = p.id
    LEFT JOIN (SELECT project_id, COUNT(*)::int AS case_count FROM test_cases GROUP BY project_id) tc ON tc.project_id = p.id
    LEFT JOIN (SELECT project_id, COUNT(*)::int AS flow_count FROM flows GROUP BY project_id) fl ON fl.project_id = p.id
    LEFT JOIN (SELECT project_id, COUNT(*)::int AS suite_count FROM test_suites GROUP BY project_id) su ON su.project_id = p.id
    /* 仓库用例只数 active：removed 是对账软删的历史，不是存量资产（/stats 同口径）。 */
    LEFT JOIN (SELECT project_id, COUNT(*)::int AS repo_case_count FROM repo_test_cases WHERE status = 'active' GROUP BY project_id) rc ON rc.project_id = p.id
    /* 文本用例总量数非废弃（deprecated 同款是软删），与「文本用例总量」读数同一口径。 */
    LEFT JOIN (SELECT project_id, COUNT(*)::int AS spec_total FROM spec_cases WHERE status <> 'deprecated' GROUP BY project_id) sp ON sp.project_id = p.id
    ${where}
    ORDER BY p.created_at DESC
    ${limitFragment}`, params);

  const projects = result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    myRole: user.isSystemAdmin ? "system_admin" : (row.my_role as MyRole),
    endpointCount: Number(row.endpoint_count),
    environmentCount: Number(row.environment_count),
    caseCount: Number(row.case_count),
    flowCount: Number(row.flow_count),
    suiteCount: Number(row.suite_count),
    repoCaseCount: Number(row.repo_case_count),
    specCaseCount: Number(row.spec_case_total),
  }));

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
    const specCaseTotal = projects.reduce((sum, item) => sum + item.specCaseTotal, 0);
    const specAutomatedCount = projects.reduce((sum, item) => sum + item.specAutomatedCount, 0);

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
      /* 自动化覆盖率（P7-6，边界 11）：与项目行同一公式，跨项目先合分子分母再除
         （不是各项目百分比的均值——那是另一种口径）。 */
      specCaseTotal,
      specAutomatedCount,
      automationRate: specCaseTotal ? (specAutomatedCount / specCaseTotal) * 100 : null,
      projects,
    });
  });
}
