import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { recordAssetVersion, specCaseSnapshot } from "../lib/assetVersions.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapSpecCase, mapSpecCaseLink, type SpecLinkTargetType } from "../models/types.js";
import { buildExcelExport, type ExcelExportCase } from "../lib/excel.js";
import { buildXmindWorkbook, type XmindExportCase } from "../lib/xmindWriter.js";
/* P5-6 边界 8：校验/归一/编号提取到 lib/validateSpecCase.ts（MCP 写工具同款判据）。 */
import { nextItemKey, normalizeSteps, normalizeTags, validateSpecCase, type SpecCaseBody } from "../lib/validateSpecCase.js";

/**
 * 文本用例 CRUD（P7-2，计划 11.2）。只做「设计内容」的增删改查：绑定（links）在
 * P7-6（原 P7-3，2026-09-07 批次交换），导入（preview/commit）在 P7-4/P7-5。
 * P7-3 追加两条批量路由（batch-update / batch-delete，树视图勾选批量条的后端）。
 */

/* 枚举常量已随校验提取到 lib/validateSpecCase.ts；本文件只在 batch-update 校验里
   用到 PRIORITIES/STATUSES，改从提取文件取（同一份，避免第二拷贝漂移）。 */
import { SPEC_PRIORITIES as PRIORITIES, SPEC_STATUSES as STATUSES } from "../lib/validateSpecCase.js";

/**
 * P10-4：把一次文本用例写（`... RETURNING *`）与它的版本快照包进一个事务。无行（更新未命中）
 * 回滚并回 `undefined`，调用方据此回 404；命中则映射、落一版快照、提交、回映射后的 SpecCase。
 */
async function writeSpecCaseWithVersion(
  context: { project: { id: string }; user: { id: string } },
  changeSummary: string,
  write: (client: PoolClient) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
): Promise<ReturnType<typeof mapSpecCase> | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await write(client);
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return undefined;
    }
    const specCase = mapSpecCase(result.rows[0]);
    await recordAssetVersion(client, {
      projectId: context.project.id, assetType: "spec_case", assetId: specCase.id,
      snapshot: specCaseSnapshot(specCase), changeSummary, createdBy: context.user.id,
    });
    await client.query("COMMIT");
    return specCase;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/* ── 绑定的读时关联（P7-6，计划 11.2「绝不回写」纪律） ──────────────────────
 *
 * 一条绑定按 target_type 各查各的「最近一次」：
 *   endpoint  → 无执行语义（接口不是可执行单元），恒无 lastResult；
 *   case      → executions 里 source='test_case' AND case_id=target 的最新一条终态；
 *   flow      → flow_executions 里 flow_id=target 的最新一条（DISTINCT ON 同
 *               flows.ts:60 的 latestRuns）；executions 行的 flow_execution_id 也
 *               命中用例挂在流程里跑出来的行——取两者里更新的那条；
 *   repo_case → repo_test_cases.last_result + 最新任务报告（LATERAL 同 ingest.ts
 *               的 LATEST_REPORT_LATERAL 匹配尺——报告状态优先，没有报告行退
 *               last_result）。
 *
 * 目标名字与 repo_case 行状态同一次 JOIN 带出：目标删了名字缺席（前端「目标已
 * 删除」）、repo_case 对账标 removed 读「目标已失效」而不是消失或报错（验收 7）。
 *
 * 全部拼在一条 SQL 的 LATERAL 里而不是每类一条查询：绑定清单 ≤ 几十条（单条
 * 用例的绑定数），一条查询带 CASE 比四条往返干净，且四类互斥不会互相放大行数。
 */
const LINK_READ_SQL = `
  SELECT l.*,
    CASE l.target_type
      WHEN 'endpoint'  THEN (SELECT e.name FROM endpoints e WHERE e.id = l.target_id AND e.project_id = $2)
      WHEN 'case'      THEN (SELECT tc.name FROM test_cases tc WHERE tc.id = l.target_id AND tc.project_id = $2)
      WHEN 'flow'      THEN (SELECT f.name FROM flows f WHERE f.id = l.target_id AND f.project_id = $2)
      WHEN 'repo_case' THEN (SELECT c.name FROM repo_test_cases c WHERE c.id = l.target_id AND c.project_id = $2)
    END AS target_name,
    CASE l.target_type WHEN 'repo_case'
      THEN (SELECT c.status FROM repo_test_cases c WHERE c.id = l.target_id AND c.project_id = $2)
    END AS target_status,
    /* 跳转语境（2026-09-10 用户反馈：绑定行支持点击跳转）：case 目标的宿主接口 id。
       接口用例的页面是 endpoints/:endpointId 工作台（?case= 深链已存在），光有
       targetId 拼不出那条地址。endpoint / flow / repo_case 的页面都由自己的
       targetId 直接可达，只有 case 需要这一列；目标删了 LEFT 得 NULL，前端照
       「目标已删除」读，不会拿旧 id 拼出 404 链接。 */
    CASE l.target_type WHEN 'case'
      THEN (SELECT tc.endpoint_id::text FROM test_cases tc WHERE tc.id = l.target_id AND tc.project_id = $2)
    END AS target_endpoint_id,
    CASE l.target_type
      WHEN 'case' THEN (
        SELECT x.status::text || '|' || COALESCE(x.finished_at::text, '') || '|' || x.id::text
          FROM executions x
         WHERE x.project_id = $2 AND x.source = 'test_case' AND x.case_id = l.target_id
           AND x.status IN ('success', 'failed', 'canceled')
         ORDER BY x.created_at DESC LIMIT 1)
      WHEN 'flow' THEN (
        SELECT fe.status::text || '|' || COALESCE(fe.finished_at::text, '') || '|' ||
               COALESCE(fe.execution_index_id::text, '')
          FROM flow_executions fe
         WHERE fe.project_id = $2 AND fe.flow_id = l.target_id
         ORDER BY fe.created_at DESC LIMIT 1)
      WHEN 'repo_case' THEN (
        SELECT lr.report_status::text || '|' || COALESCE(lr.report_run_at::text, '') || '|' || COALESCE(lr.report_run_id::text, '')
          FROM repo_test_cases c,
               LATERAL (
                 SELECT pr.id AS report_run_id, pr.created_at AS report_run_at,
                        CASE WHEN COUNT(*) FILTER (WHERE prc.status IN ('failed', 'error')) > 0 THEN 'failed'
                             WHEN COUNT(*) FILTER (WHERE prc.status = 'skipped') > 0 THEN 'skipped'
                             ELSE 'passed' END AS report_status
                   FROM pipeline_run_cases prc
                   JOIN pipeline_runs pr ON pr.id = prc.pipeline_run_id AND pr.project_id = c.project_id
                  WHERE prc.guessed_case_key IS NOT NULL
                    AND (
                      regexp_replace(prc.guessed_case_key, '\\[[^\\]]*\\]$', '') = c.case_key
                       OR (prc.guessed_case_key LIKE '%#%'
                           AND c.case_key = concat(
                             replace(split_part(prc.guessed_case_key, '#', 1), '.', '/'), '.py::',
                             regexp_replace(split_part(prc.guessed_case_key, '#', 2), '\\[[^\\]]*\\]$', '')))
                    )
                  GROUP BY pr.id, pr.created_at
                  ORDER BY pr.created_at DESC LIMIT 1) lr
         WHERE c.id = l.target_id AND c.project_id = $2)
    END AS last_raw
  FROM spec_case_links l`;

/**
 * last_raw（'status|at|runId' 三段竖线拼串）拆回三段。用拼串而不是三个 JSONB
 * 列：CASE 子查询只能产出一个标量，三个列就要把整个子查询写三遍。
 *
 * repo_case 的回落：报告 LATERAL 没匹配到行时 last_raw 为 NULL，此时退
 * `repo_test_cases.last_result`（推导值）——树视图同款优先级（RepoCaseTree 读
 * lastReport 优先、lastResult 兜底）。悬空行（目标被删）两者都没有，如实空。
 */
function splitLastRaw(link: Record<string, unknown>, repoFallback?: string | null) {
  const raw = link.last_raw;
  if ((raw === undefined || raw === null) && repoFallback) {
    link.last_status = repoFallback;
    return;
  }
  if (raw === undefined || raw === null) return;
  const [status, at, runId] = String(raw).split("|");
  link.last_status = status || undefined;
  if (at) link.last_at = at;
  if (runId) link.last_run_id = runId;
}

async function loadSpecCaseLinks(projectId: string, caseIds: string[]) {
  if (!caseIds.length) return new Map<string, ReturnType<typeof mapSpecCaseLink>[]>();
  const result = await pool.query(
    `${LINK_READ_SQL}
     WHERE l.spec_case_id = ANY($1::uuid[])
     ORDER BY l.created_at, l.id`,
    [caseIds, projectId],
  );
  const byCase = new Map<string, ReturnType<typeof mapSpecCaseLink>[]>();
  for (const row of result.rows) {
    /* repo_case 无报告行（last_raw 为 NULL）时才读目标行自己的 last_result——
       有报告就不多付这次查询（读时、绝不回写绑定行）。 */
    const needsFallback = row.target_type === "repo_case"
      && (row.last_raw === undefined || row.last_raw === null)
      && row.target_status;
    const fallback = needsFallback
      ? await loadRepoLastResult(row.target_id as string, projectId)
      : null;
    splitLastRaw(row, fallback);
    const key = String(row.spec_case_id);
    const bucket = byCase.get(key) ?? [];
    bucket.push(mapSpecCaseLink(row));
    byCase.set(key, bucket);
  }
  return byCase;
}

/** repo_test_cases.last_result（单行读；status 'unknown' 视作没有结论，返回 null）。 */
async function loadRepoLastResult(targetId: string, projectId: string): Promise<string | null> {
  const result = await pool.query(
    "SELECT last_result FROM repo_test_cases WHERE id = $1 AND project_id = $2",
    [targetId, projectId],
  );
  if (!result.rowCount) return null;
  const value = String(result.rows[0].last_result);
  return value === "unknown" ? null : value;
}

export async function specCaseRoutes(app: FastifyInstance) {
  /**
   * 列表（viewer 可读）：服务端分页 + keyword / path（模块路径前缀，含全部子级——
   * 「模块及子级的用例」一条 starts_with 查询，不用递归 CTE）/ moduleId（直属精确，
   * P7-3 树视图展开单模块用）/ priority / status / automation 筛选。`automation`
   * 的语义从第一天就与覆盖口径（边界 11）对齐：有 ≥1 条**非 endpoint** 绑定才算
   * 已自动化——接口绑定表达「该测什么」，不算自动化进度。linkCount 由分组无关的
   * 相关子查询带出（页大小 ≤ 100，代价可忽略）；绑定接口在 P7-6（原 P7-3）才有
   * 写端，这列在那之前恒为 0。
   *
   * INNER JOIN spec_modules 是安全的：module_id NOT NULL + ON DELETE CASCADE，
   * 用例不可能活过它的模块。
   */
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; path?: string; moduleId?: string; priority?: string; status?: string; automation?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/spec-cases", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["c.project_id = $1"];
    const keyword = request.query.keyword?.trim();
    /* 筛选在 SQL 里做（与 cases 列表同款）：keyword 命中的是全量结果集，不只是已加载页。 */
    if (keyword) { params.push(`%${keyword}%`); clauses.push(`(c.title ILIKE $${params.length} OR c.item_key ILIKE $${params.length})`); }
    const path = request.query.path?.trim();
    if (path) { params.push(path); clauses.push(`starts_with(m.path, $${params.length})`); }
    /* moduleId 是 uuid 过滤值：先验后查（规则 5）——坏值打到 uuid cast 会炸整条查询。 */
    if (request.query.moduleId) {
      if (!isUuid(request.query.moduleId)) return fail(reply, 400, 1001, "moduleId must be a UUID");
      params.push(request.query.moduleId); clauses.push(`c.module_id = $${params.length}`);
    }
    if (request.query.priority) { params.push(request.query.priority); clauses.push(`c.priority = $${params.length}`); }
    if (request.query.status) { params.push(request.query.status); clauses.push(`c.status = $${params.length}`); }
    if (request.query.automation === "yes" || request.query.automation === "no") {
      clauses.push(`${request.query.automation === "yes" ? "" : "NOT "}EXISTS (SELECT 1 FROM spec_case_links l WHERE l.spec_case_id = c.id AND l.target_type <> 'endpoint')`);
    }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM spec_cases c JOIN spec_modules m ON m.id = c.module_id WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(
      `SELECT c.*, m.path AS module_path,
              (SELECT COUNT(*)::int FROM spec_case_links l WHERE l.spec_case_id = c.id) AS link_count,
              /* 已自动化（P7-6 列表列）：与 automation 筛选、覆盖口径三者同一表达式——
                 有 ≥1 条非 endpoint 绑定。不限定用例状态（deprecated 的绑定事实照实读）。 */
              EXISTS (SELECT 1 FROM spec_case_links l WHERE l.spec_case_id = c.id AND l.target_type <> 'endpoint') AS automated,
              /* P11 归属列（边界 7/9）：只有「创建人」。spec_cases 天生带 created_by
                 （P7），但按边界 2 没有 updated_by 列，所以这里没有 updated_by_email——
                 前端该列显示「—」，要它得先给表加列（另立项）。 */
              creator.email AS created_by_email
         FROM spec_cases c
         JOIN spec_modules m ON m.id = c.module_id
         LEFT JOIN users creator ON creator.id = c.created_by
        WHERE ${where}
        /* 模块序（path 字典序即深度优先）→ 编号 → 标题：与树视图 P7-6 落地后两视图
           的行序一致，切换视图时同一批用例不会换位置。 */
        ORDER BY m.path, COALESCE(c.item_key, ''), c.title, c.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return success(result.rows.map(mapSpecCase), { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 用例导出（2026-09-08 用户要求）：`{ format: xmind|excel, caseIds?, …filters }`。
   * **勾选集优先**（2026-09-08 第二轮反馈）：caseIds 非空 = 精确导这批（树/列表
   * 跨视图勾选集，忽略筛选）；空 = 按筛选导全量命中集（keyword / path / moduleId /
   * priority / status / automation 与列表**逐字同一套**——「我在列表里看到什么就
   * 导出什么」；不分页，分页会把「导出」变成「导出当前页」的陷阱）。
   *
   * POST 而非 GET：勾选集一批 uuid（上限 2000 × 36 字符 ≈ 70KB）放不进 query
   * string（Node 默认 header 上限），body 才放得下；语义仍是纯读，viewer 可导。
   * 勾选集走**归属预检 + 全量命中**（批量条同款纪律：部分命中说明勾选已过期，
   * 拒绝而不是静默导半份）。
   *
   * 裸二进制流 + attachment（与日志下载 / 模板下载同款 envelope 例外）；文件名
   * ASCII 保底，前端下载时以本地化名另存。XMind 走零依赖写入器（lib/xmindWriter，
   * content.json 新格式、保证回导闭环）；Excel 走 exceljs（按需导入，与模板同一
   * 生成器——导出文件本身就是一份合法模板）。
   */
  app.post<{
    Params: { id: string };
    Body: { format?: string; caseIds?: string[]; keyword?: string; path?: string; moduleId?: string; priority?: string; status?: string; automation?: string };
  }>("/api/v1/projects/:id/spec-cases/export", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    if (!context) return;
    const body = request.body ?? {};
    const format = body.format;
    if (format !== "xmind" && format !== "excel") return fail(reply, 400, 1001, "format must be xmind or excel");

    let rows: Record<string, unknown>[];
    if (Array.isArray(body.caseIds) && body.caseIds.length) {
      /* 勾选集导出：上限对齐单次导入的 2000（再大的集合属于筛选导出的场景）。 */
      const caseIds = [...new Set(body.caseIds)];
      if (caseIds.length > 2000 || caseIds.some((id) => !isUuid(id))) return fail(reply, 400, 1001, "caseIds must contain at most 2000 UUIDs");
      const result = await pool.query(
        `SELECT c.*, m.path AS module_path
           FROM spec_cases c
           JOIN spec_modules m ON m.id = c.module_id
          WHERE c.project_id = $1 AND c.id = ANY($2::uuid[])
          ORDER BY m.path, COALESCE(c.item_key, ''), c.title, c.created_at DESC`,
        [context.project.id, caseIds],
      );
      if (result.rowCount !== caseIds.length) return fail(reply, 400, 1001, "all cases must belong to the project");
      rows = result.rows;
    } else {
      /* 筛选子句与列表逐字同源（拷贝而非抽函数：抽出去要带 params 数组进出，
          两处各自演化时反而容易漂——列表还有分页两参，形状不同）。 */
      const params: unknown[] = [context.project.id]; const clauses = ["c.project_id = $1"];
      const keyword = body.keyword?.trim();
      if (keyword) { params.push(`%${keyword}%`); clauses.push(`(c.title ILIKE $${params.length} OR c.item_key ILIKE $${params.length})`); }
      const path = body.path?.trim();
      if (path) { params.push(path); clauses.push(`starts_with(m.path, $${params.length})`); }
      if (body.moduleId) {
        if (!isUuid(body.moduleId)) return fail(reply, 400, 1001, "moduleId must be a UUID");
        params.push(body.moduleId); clauses.push(`c.module_id = $${params.length}`);
      }
      if (body.priority) { params.push(body.priority); clauses.push(`c.priority = $${params.length}`); }
      if (body.status) { params.push(body.status); clauses.push(`c.status = $${params.length}`); }
      if (body.automation === "yes" || body.automation === "no") {
        clauses.push(`${body.automation === "yes" ? "" : "NOT "}EXISTS (SELECT 1 FROM spec_case_links l WHERE l.spec_case_id = c.id AND l.target_type <> 'endpoint')`);
      }
      const where = clauses.join(" AND ");

      const result = await pool.query(
        `SELECT c.*, m.path AS module_path
           FROM spec_cases c
           JOIN spec_modules m ON m.id = c.module_id
          WHERE ${where}
          ORDER BY m.path, COALESCE(c.item_key, ''), c.title, c.created_at DESC`,
        params,
      );
      rows = result.rows;
    }
    const mapped = rows.map(mapSpecCase);

    let buffer: Buffer;
    if (format === "xmind") {
      const cases: XmindExportCase[] = mapped.map((row) => ({
        modulePath: row.modulePath ?? "/",
        title: row.title,
        preconditions: row.preconditions,
        steps: row.steps,
        priority: row.priority,
        tags: row.tags,
      }));
      buffer = buildXmindWorkbook(cases);
      reply.header("content-type", "application/octet-stream");
      reply.header("content-disposition", 'attachment; filename="spec-cases.xmind"');
    } else {
      const cases: ExcelExportCase[] = mapped.map((row) => ({
        modulePath: row.modulePath ?? "/",
        itemKey: row.itemKey,
        title: row.title,
        preconditions: row.preconditions,
        steps: row.steps,
        priority: row.priority,
        tags: row.tags,
      }));
      buffer = await buildExcelExport(cases);
      reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("content-disposition", 'attachment; filename="spec-cases.xlsx"');
    }
    return reply.send(buffer);
  });

  /**
   * 手工建（写权限）。`source = 'manual'`——导入路径（P7-4/P7-5）写 'xmind'/'excel'，
   * 建了就不改（PATCH 不接受 source）。编号（item_key）不由请求提供：服务端按项目内
   * TC- 序列自增生成（2026-09-07 反馈）。并发下两个请求可能取到同号，UNIQUE
   * (project_id, item_key) 把后者打回来（23505）——重取号重试，至多 3 次；仍撞说明
   * 序列被外部编号占满，如实抛出交全局兜底。
   */
  app.post<{ Params: { id: string }; Body: SpecCaseBody }>("/api/v1/projects/:id/spec-cases", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    const input = request.body ?? {};
    const invalid = validateSpecCase(input);
    if (invalid) return fail(reply, 400, 1001, invalid);
    /* body 引用照 suites 先例：不存在/不属于本项目一律 400 + 1001，404 只留给 URL 资源。 */
    const module = await pool.query("SELECT id FROM spec_modules WHERE id = $1 AND project_id = $2", [input.moduleId, context.project.id]);
    if (!module.rowCount) return fail(reply, 400, 1001, "module not found in this project");

    /* P10-4：行与首版快照同事务落。取号重试的每一次尝试是一个独立事务——撞号（23505）
       后 ROLLBACK 再重取号，否则事务已中毒（aborted）无法在同连接上重试。 */
    const client = await pool.connect();
    try {
      for (let attempt = 0; ; attempt++) {
        const itemKey = await nextItemKey(context.project.id);
        try {
          await client.query("BEGIN");
          const result = await client.query(
            `INSERT INTO spec_cases (id, project_id, module_id, item_key, title, preconditions, steps, priority, tags, status, source, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'manual', $11) RETURNING *`,
            [
              randomUUID(), context.project.id, input.moduleId, itemKey,
              input.title!.trim(), input.preconditions?.trim() ?? "",
              JSON.stringify(normalizeSteps(input.steps) ?? []), input.priority ?? "P2",
              normalizeTags(input.tags) ?? [], input.status ?? "unreviewed", context.user.id,
            ],
          );
          const created = mapSpecCase(result.rows[0]);
          await recordAssetVersion(client, {
            projectId: context.project.id, assetType: "spec_case", assetId: created.id,
            snapshot: specCaseSnapshot(created), changeSummary: "创建", createdBy: context.user.id,
          });
          await client.query("COMMIT");
          /* 响应不带 module_path：POST RETURNING 里放不了子查询，而前端保存后本来就要重取列表。 */
          return reply.code(201).send(success(created));
        } catch (error) {
          await client.query("ROLLBACK");
          if ((error as { code?: string }).code === "23505" && attempt < 2) continue;
          throw error;
        }
      }
    } finally {
      client.release();
    }
  });

  /**
   * 详情（viewer 可读）。P7-6 起带绑定清单：`links[]` = mapSpecCaseLink + 读时
   * 关联的最近自动化结果（LINK_READ_SQL，绝不回写）。列表行不带 links——详情
   * 抽屉挂载时按 id 现拉这一份（抽屉的取数契约自 P7-3 修订就是这么定的）。
   */
  app.get<{ Params: { id: string; caseId: string } }>("/api/v1/projects/:id/spec-cases/:caseId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "spec case not found");
    const result = await pool.query(
      `SELECT c.*, m.path AS module_path
         FROM spec_cases c JOIN spec_modules m ON m.id = c.module_id
        WHERE c.id = $1 AND c.project_id = $2`,
      [request.params.caseId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "spec case not found");
    const links = await loadSpecCaseLinks(context.project.id, [request.params.caseId]);
    return success({ ...mapSpecCase(result.rows[0]), links: links.get(request.params.caseId) ?? [] });
  });

  /**
   * 局部更新。moduleId 只有两态：缺省 = 不动；uuid = 移过去（module_id NOT NULL，
   * null 没有含义，validate 里被 400 拦下）。编号不可改：自增编号是系统身份，只在
   * 新建时生成（2026-09-07 反馈；请求里残留的 itemKey 被忽略）。steps / tags 整体
   * 替换（不做行级合并——导入与手工写都以「整份步骤表」为提交单位）。
   */
  app.patch<{ Params: { id: string; caseId: string }; Body: SpecCaseBody }>("/api/v1/projects/:id/spec-cases/:caseId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "spec case not found");
    const input = request.body ?? {};
    const invalid = validateSpecCase(input, true);
    if (invalid) return fail(reply, 400, 1001, invalid);

    const existing = await pool.query("SELECT id FROM spec_cases WHERE id = $1 AND project_id = $2", [request.params.caseId, context.project.id]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "spec case not found");

    let moduleGiven = false;
    if (input.moduleId !== undefined) {
      const module = await pool.query("SELECT id FROM spec_modules WHERE id = $1 AND project_id = $2", [input.moduleId, context.project.id]);
      if (!module.rowCount) return fail(reply, 400, 1001, "module not found in this project");
      moduleGiven = true;
    }

    /* P10-4：更新与其版本快照同事务（单条写本不需事务，这里纯为"行与快照一起回滚"）。 */
    const updated = await writeSpecCaseWithVersion(context, "更新", (client) => client.query(
      `UPDATE spec_cases SET
          module_id = CASE WHEN $1 THEN $2::uuid ELSE module_id END,
          title = COALESCE($3, title),
          preconditions = COALESCE($4, preconditions),
          steps = COALESCE($5::jsonb, steps),
          priority = COALESCE($6, priority),
          tags = COALESCE($7, tags),
          status = COALESCE($8, status),
          updated_at = now()
        WHERE id = $9 AND project_id = $10 RETURNING *`,
      [
        moduleGiven, moduleGiven ? input.moduleId! : null,
        input.title?.trim() ?? null,
        input.preconditions?.trim() ?? null,
        input.steps !== undefined ? JSON.stringify(normalizeSteps(input.steps) ?? []) : null,
        input.priority ?? null,
        input.tags !== undefined ? (normalizeTags(input.tags) ?? []) : null,
        input.status ?? null,
        request.params.caseId, context.project.id,
      ],
    ));
    if (!updated) return fail(reply, 404, 2001, "spec case not found");
    return success(updated);
  });

  /**
   * 直接删。没有 environments 那套 409/force：绑定行与计划项都 ON DELETE CASCADE
   * 随用例消散（P7-1 已定纪律——计划项靠 title/module 快照「读得通」，不拦内容删除；
   * 绑定行是用例的一部分，没有独立存活的语义）。
   */
  app.delete<{ Params: { id: string; caseId: string } }>("/api/v1/projects/:id/spec-cases/:caseId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "spec case not found");
    const result = await pool.query("DELETE FROM spec_cases WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.caseId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "spec case not found");
    return success({ id: result.rows[0].id });
  });

  /**
   * 批量更新（P7-3 树视图勾选批量条）：一份 patch 应用到一批用例——移动模块 /
   * 批量改优先级 / 批量改状态（2026-09-08 反馈补第三项）。「加入计划」是测试
   * 计划的事（P7-7），不在这里加第四个字段。单资源 PATCH 的语义逐字复用：
   * moduleId 必须真实存在于本项目（400），priority / status 过枚举；caseIds 去重 +
   * uuid 校验 + 上限 500（模块懒载每模块 100 条，跨模块勾选很容易超过 endpoints
   * 批删的 100，照 100 卡会把合法流当错误拦下）。
   */
  app.post<{ Params: { id: string }; Body: { caseIds?: string[]; moduleId?: string; priority?: string; status?: string } }>("/api/v1/projects/:id/spec-cases/batch-update", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    const caseIds = [...new Set(request.body?.caseIds ?? [])];
    if (!caseIds.length) return fail(reply, 400, 1001, "at least one case is required");
    if (caseIds.length > 500 || caseIds.some((id) => !isUuid(id))) return fail(reply, 400, 1001, "caseIds must contain at most 500 UUIDs");
    if (request.body?.moduleId === undefined && request.body?.priority === undefined && request.body?.status === undefined) {
      return fail(reply, 400, 1001, "nothing to update: moduleId, priority or status is required");
    }
    if (request.body?.priority !== undefined && !PRIORITIES.includes(request.body.priority)) return fail(reply, 400, 1001, `priority must be one of ${PRIORITIES.join(", ")}`);
    if (request.body?.status !== undefined && !STATUSES.includes(request.body.status)) return fail(reply, 400, 1001, `status must be one of ${STATUSES.join(", ")}`);
    if (request.body?.moduleId !== undefined) {
      if (!isUuid(request.body.moduleId)) return fail(reply, 400, 1001, "moduleId must be a UUID");
      const module = await pool.query("SELECT id FROM spec_modules WHERE id = $1 AND project_id = $2", [request.body.moduleId, context.project.id]);
      if (!module.rowCount) return fail(reply, 400, 1001, "module not found in this project");
    }

    /* 归属预检 + 更新同一个事务（endpoints 批删同款）：部分命中说明勾选集已过期
       （有行被并发删了），照实拒绝而不是静默只改一部分——用户看到的是一次失败。 */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query("SELECT id FROM spec_cases WHERE project_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE", [context.project.id, caseIds]);
      if (owned.rowCount !== caseIds.length) {
        await client.query("ROLLBACK");
        return fail(reply, 400, 1001, "all cases must belong to the project");
      }
      const result = await client.query(
        `UPDATE spec_cases SET
           module_id = COALESCE($2::uuid, module_id),
           priority = COALESCE($3, priority),
           status = COALESCE($4, status),
           updated_at = now()
         WHERE project_id = $1 AND id = ANY($5::uuid[]) RETURNING id`,
        [context.project.id, request.body?.moduleId ?? null, request.body?.priority ?? null, request.body?.status ?? null, caseIds],
      );
      await client.query("COMMIT");
      return success({ updated: result.rowCount });
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "cases could not be updated");
    } finally {
      client.release();
    }
  });

  /**
   * 批量删除（P7-3）：语义与单条 DELETE 完全一致（CASCADE，无 409/force），只是
   * 一次吃一批——树视图勾选后整组清理废弃用例是最常见的批量动作。
   */
  app.post<{ Params: { id: string }; Body: { caseIds?: string[] } }>("/api/v1/projects/:id/spec-cases/batch-delete", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    const caseIds = [...new Set(request.body?.caseIds ?? [])];
    if (!caseIds.length) return fail(reply, 400, 1001, "at least one case is required");
    if (caseIds.length > 500 || caseIds.some((id) => !isUuid(id))) return fail(reply, 400, 1001, "caseIds must contain at most 500 UUIDs");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query("SELECT id FROM spec_cases WHERE project_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE", [context.project.id, caseIds]);
      if (owned.rowCount !== caseIds.length) {
        await client.query("ROLLBACK");
        return fail(reply, 400, 1001, "all cases must belong to the project");
      }
      const deleted = await client.query("DELETE FROM spec_cases WHERE project_id = $1 AND id = ANY($2::uuid[]) RETURNING id", [context.project.id, caseIds]);
      await client.query("COMMIT");
      return success({ ids: deleted.rows.map((row: Record<string, unknown>) => String(row.id)), deleted: deleted.rowCount });
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "cases could not be deleted");
    } finally {
      client.release();
    }
  });

  /* ── 绑定（P7-6，计划 11.2 links 两条）：写端只有建与删，没有改——绑定的
     全部可变事实（最近结果）是读时关联出来的，改一个绑定等于删了再建。 ──── */

  const TARGET_TABLES: Record<Exclude<SpecLinkTargetType, "repo_case">, string> = {
    endpoint: "endpoints",
    case: "test_cases",
    flow: "flows",
  };

  /**
   * 建绑定（写权限）。四类目标逐一校验**项目归属**（照 suites 的 body 引用先例：
   * 400 + 1001，404 只留给 URL 资源）：
   *   - endpoint / case / flow：目标 id 必须是本项目的行；
   *   - repo_case：**按 (project, case_key) 绑定**（边界 9）——targetId 传当前行
   *     id；对账把行标 removed 后同 key 重现可能是新行 id，绑定时若已有同 key
   *     的绑定行，把它的 target_id **就地更新到新行**（UNIQUE (spec_case_id,
   *     target_type, target_id) 拦不住同 key 换 id 的重复绑定——身份是 key），
   *     语义与「重复绑定」合并成同一条。
   *
   * 同 (specCase, type, id) 重复提交 = 409 + 2003（与模块同层同名同一套冲突码；
   * 约束兜底并发）。created_by 落当前用户。
   */
  app.post<{
    Params: { id: string; caseId: string };
    Body: { targetType?: string; targetId?: string };
  }>("/api/v1/projects/:id/spec-cases/:caseId/links", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "spec case not found");
    const body = request.body ?? {};
    const targetType = body.targetType as SpecLinkTargetType | undefined;
    if (!targetType || !["endpoint", "case", "flow", "repo_case"].includes(targetType)) {
      return fail(reply, 400, 1001, "targetType must be one of endpoint, case, flow, repo_case");
    }
    if (!body.targetId || !isUuid(body.targetId)) return fail(reply, 400, 1001, "targetId must be a UUID");

    const specCase = await pool.query("SELECT id FROM spec_cases WHERE id = $1 AND project_id = $2", [request.params.caseId, context.project.id]);
    if (!specCase.rowCount) return fail(reply, 404, 2001, "spec case not found");

    let targetKey: string | null = null;
    if (targetType === "repo_case") {
      /* repo_case：按 case_key 找身份行；removed 行也允许绑（绑定是对 key 的，
         对账状态读时展示「目标已失效」）——最新一行（同 key 重现取新行）。 */
      const target = await pool.query(
        "SELECT id, case_key FROM repo_test_cases WHERE id = $1 AND project_id = $2 ORDER BY (status = 'active') DESC, updated_at DESC LIMIT 1",
        [body.targetId, context.project.id],
      );
      if (!target.rowCount) return fail(reply, 400, 1001, "target repo case not found in this project");
      targetKey = String(target.rows[0].case_key);
      /* 同 key 旧绑定就地换行 id（表上没有 updated_at——绑定行只有 created_at，
         换行不产新时间戳，key 快照不变）。 */
      await pool.query(
        `UPDATE spec_case_links SET target_id = $1
          WHERE spec_case_id = $2 AND target_type = 'repo_case' AND target_key = $3`,
        [String(target.rows[0].id), request.params.caseId, targetKey],
      );
    } else {
      const table = TARGET_TABLES[targetType];
      const target = await pool.query(`SELECT id FROM ${table} WHERE id = $1 AND project_id = $2`, [body.targetId, context.project.id]);
      if (!target.rowCount) return fail(reply, 400, 1001, `target ${targetType} not found in this project`);
    }

    try {
      /* RETURNING 带上目标名：前端就地合入这一条（不整抽屉重拉——表单草稿在，
         ㉑ 同款纪律），没有名字的绑定行读作「目标已删除」就错了。last_raw 等
         读时关联列不在这条响应里（刚建的绑定还没结果，前端显示「—」属实）。 */
      const result = await pool.query(
        `INSERT INTO spec_case_links AS l (id, spec_case_id, target_type, target_id, target_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING l.id, l.spec_case_id, l.target_type, l.target_id, l.target_key, l.created_by, l.created_at,
                   CASE $3
                     WHEN 'endpoint'  THEN (SELECT e.name FROM endpoints e WHERE e.id = $4)
                     WHEN 'case'      THEN (SELECT tc.name FROM test_cases tc WHERE tc.id = $4)
                     WHEN 'flow'      THEN (SELECT f.name FROM flows f WHERE f.id = $4)
                     WHEN 'repo_case' THEN (SELECT c.name FROM repo_test_cases c WHERE c.id = $4)
                   END AS target_name`,
        [randomUUID(), request.params.caseId, targetType, body.targetId, targetKey, context.user.id],
      );
      return reply.code(201).send(success(mapSpecCaseLink(result.rows[0])));
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return fail(reply, 409, 2003, "this target is already linked to the case");
      }
      throw error;
    }
  });

  /**
   * 删绑定（写权限）。绑定行是文本用例的一部分（ON DELETE CASCADE 随用例消散），
   * 单独删除没有引用扫描——目标侧（接口/用例/流程/仓库用例）从不因被绑定而拦删
   * （P7-1 的纪律：绑定不构成对目标的生命周期约束）。
   */
  app.delete<{ Params: { id: string; caseId: string; linkId: string } }>("/api/v1/projects/:id/spec-cases/:caseId/links/:linkId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.caseId) || !isUuid(request.params.linkId)) return fail(reply, 404, 2001, "link not found");
    const result = await pool.query(
      `DELETE FROM spec_case_links l USING spec_cases c
        WHERE l.id = $1 AND l.spec_case_id = c.id AND c.id = $2 AND c.project_id = $3 RETURNING l.id`,
      [request.params.linkId, request.params.caseId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "link not found");
    return success({ id: result.rows[0].id });
  });
}
