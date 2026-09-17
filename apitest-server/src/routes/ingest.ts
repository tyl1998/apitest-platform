import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, writeAuditLogAsync } from "../lib/audit.js";
import {
  INGEST_MAX_BODY_BYTES, INGEST_MAX_RECORDS, IngestPayloadError, IngestTooLargeError,
  PROTOCOL_VERSION, RepositoryConflictError, ingest, type IngestPayload,
} from "../lib/ingest.js";
import { authenticateIngest } from "../lib/ingestAuth.js";
import { buildEndpointMatcher, comparableTemplate, coverageShapeKey, endpointPath, loadEndpointShapes, stripQuery } from "../lib/ingestPath.js";
import { findReportArtifactRow, loadReportView } from "../lib/reportPayload.js";
import type { ReportStep } from "../lib/allureReport.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { METHODS } from "../lib/run.js";
import { isUuid } from "../lib/uuid.js";
import { mapEndpoint, mapIngestPathRule, mapIngestRecord, mapIngestRun, mapRepoTestCase, type IngestRecord } from "../models/types.js";

/**
 * 仓库模式：唯一上报入口 + 查询侧（P4-3/4/5/6，计划 7.2）。
 *
 * `POST /ingest` 是**平台只暴露的那一个入口**（Spec 2.10.1）：它不在 `/api/v1/projects/:id`
 * 下，因为项目由 Token 决定而不是由 URL 决定——让 CI 同时配 URL 里的项目 id 和一个项目级
 * Token，就多了一处可以互相矛盾的配置。
 */

/** 未匹配诊断视图与用例树的默认页大小，与其它列表同款上限 100。 */
function paging(query: { page?: string; pageSize?: string }) {
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * 「该用例最新一条任务报告」的 LATERAL 片段（2026-09-03，验收反馈 ⑦）。
 *
 * 树上的通过状态、最近执行与「绑定的仓库任务」都从**任务报告**读（pipeline_run_cases，
 * Runner 解析 junit/allure 落的行），而不是 ingest 侧的 `repo_test_cases.last_result`——
 * 后者是 SDK 请求桩的推导，报告才是「这轮 CI 到底怎么走的」的权威副本。
 *
 * 匹配键 = nodeid 去掉参数化后缀（SDK 的 case_key 这么来）。2026-09-03 修复：allure-pytest
 * 的 fullName 是 `pkg.Module#test`（点号 + `#`），不是 nodeid 的 `path/to.py::test`——
 * Runner 侧（report/allure.ts 的 normalizeFullName）已把新上报归一到 nodeid 形态；这里
 * 的第二个匹配分支救**历史行**（修复之前落的点号形态），同一 SQL 里做同一个逆变换，
 * 不回写历史数据（边界 13 的「读时关联」不变）。**读时关联，绝不回写**——junit 的
 * `classname::name` 对不上就是显示「没有报告」，不产生任何数据变更。
 *
 * 归并规则：一次 run 里同一条用例的多条参数化行折成一条——有 failed/error 就算失败，
 * 否则有 skipped 就算跳过，否则通过（与 `mapCiTask` 的最近执行、报告页的失败口径一致：
 * 「任何一个场景挂了，这条用例就是挂了」）。
 *
 * 正则与迁移 047 的表达式索引逐字相同，改一处必须同步另一处。历史兼容分支（dotkey）
 * **不走**那个索引——它是救旧数据的过渡，新数据不再产生点号形态，扫描成本随历史行
 * 一起消亡；不打算为它建第二个表达式索引。
 */
const LATEST_REPORT_LATERAL = `LEFT JOIN LATERAL (
    SELECT pr.id AS report_run_id, pr.run_number AS report_run_number,
           t.name AS report_task_name, pr.created_at AS report_run_at,
           pr.ingest_run_id AS report_ingest_run_id,
           CASE WHEN COUNT(*) FILTER (WHERE prc.status IN ('failed', 'error')) > 0 THEN 'failed'
                WHEN COUNT(*) FILTER (WHERE prc.status = 'skipped') > 0 THEN 'skipped'
                ELSE 'passed' END AS report_status,
           MAX(prc.duration_ms) AS report_duration_ms,
           /* 失败行的话优先（失败那句话才是要点开抽屉的理由）；没有失败行时多为 NULL。 */
           (ARRAY_AGG(prc.message ORDER BY (prc.status IN ('failed', 'error')) DESC, prc.message NULLS LAST))[1] AS report_message
      FROM pipeline_run_cases prc
      JOIN pipeline_runs pr ON pr.id = prc.pipeline_run_id AND pr.project_id = c.project_id
      JOIN ci_tasks t ON t.id = pr.ci_task_id
     WHERE prc.guessed_case_key IS NOT NULL
       AND (
         regexp_replace(prc.guessed_case_key, '\\[[^\\]]*\\]$', '') = c.case_key
          OR (
            /* 历史行兼容（见函数注释）：pkg.Mod#test[param] → pkg/Mod.py::test，
               与 Runner 侧 normalizeFullName 同一个逆变换。只对含 # 的 key 生效——
               junit 的 classname::name 没有 #，不会走进这个分支。 */
            prc.guessed_case_key LIKE '%#%'
            AND c.case_key = concat(
              replace(split_part(prc.guessed_case_key, '#', 1), '.', '/'), '.py::',
              regexp_replace(split_part(prc.guessed_case_key, '#', 2), '\\[[^\\]]*\\]$', ''))
          )
       )
     GROUP BY pr.id, pr.run_number, t.name, pr.created_at, pr.ingest_run_id
      ORDER BY pr.created_at DESC
      LIMIT 1
  ) lr ON true`;

/** LATERAL 结果 → API 的 `lastReport`（null 行读作「没有匹配的任务报告」）。 */
function mapLastReport(row: Record<string, unknown>) {
  if (!row.report_run_id) return undefined;
  return {
    runId: String(row.report_run_id),
    runNumber: Number(row.report_run_number),
    taskName: String(row.report_task_name),
    status: String(row.report_status) as "passed" | "failed" | "skipped",
    runAt: new Date(String(row.report_run_at)).toISOString(),
  };
}

/**
 * 把未匹配记录归到某个接口上，并按 call 阶段补 `repo_case_endpoints`（link 与 register 共用）。
 *
 * 条件片段由调用方拼接（都是固定 SQL、不含请求输入），值走参数——与 dashboard.ts 的动态
 * 过滤同一纪律。关系仍然只由 call 阶段的记录建立（边界 10）：关联/登记不该成为把 fixture
 * 请求挂到用例节点上的后门。
 */
async function attachUnmatchedRecords(
  client: PoolClient,
  projectId: string,
  endpointId: string,
  condition: string,
  params: unknown[],
): Promise<{ linkedRecords: number; linkedCases: number }> {
  const linked = await client.query(
    `UPDATE ingest_records SET endpoint_id = $1
       WHERE project_id = $2 AND endpoint_id IS NULL AND ${condition}
       RETURNING repo_case_id, phase, ingest_run_id`,
    [endpointId, projectId, ...params],
  );
  const counts = new Map<string, { count: number; runId: string }>();
  for (const row of linked.rows) {
    if (String(row.phase) !== "call" || !row.repo_case_id) continue;
    const key = String(row.repo_case_id);
    const entry = counts.get(key) ?? { count: 0, runId: String(row.ingest_run_id) };
    entry.count += 1;
    counts.set(key, entry);
  }
  for (const [caseId, entry] of counts) {
    await client.query(
      `INSERT INTO repo_case_endpoints (repo_case_id, endpoint_id, first_seen_run_id, last_seen_run_id, request_count)
       VALUES ($1, $2, $3, $3, $4)
       ON CONFLICT (repo_case_id, endpoint_id) DO UPDATE SET
         last_seen_run_id = EXCLUDED.last_seen_run_id,
         request_count = repo_case_endpoints.request_count + EXCLUDED.request_count`,
      [caseId, endpointId, entry.runId, entry.count],
    );
  }
  return { linkedRecords: linked.rowCount ?? 0, linkedCases: counts.size };
}

export async function ingestRoutes(app: FastifyInstance) {
  /**
   * 上报入口。
   *
   * `bodyLimit` 在**解析之前**拒掉超大请求体（413，计划 7.2）：读完 200MB JSON 再数一遍
   * 记录条数，内存已经付过了。条数那一道在 `lib/ingest.ts` 里，两道各挡一种形状。
   *
   * 不走 `requireProjectAccess`：调用者是 CI 而不是登录用户，凭据是项目级 Token。
   */
  app.post<{ Body: IngestPayload }>("/ingest", { bodyLimit: INGEST_MAX_BODY_BYTES }, async (request, reply) => {
    const identity = await authenticateIngest(request.headers.authorization);
    if (!identity) return fail(reply, 401, 1002, "ingest token is invalid or revoked");
    try {
      const result = await ingest(identity.projectId, request.body ?? {});
      return success(result);
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        /* 409 要说清绑的是哪个（验收 7）：只回「冲突」的话，接入方无法判断是自己配错了
           Token 还是平台上绑了别人的仓库。 */
        return fail(reply, 409, 2003, `this project is bound to ${error.boundGitUrl}; unbind it in the UI to switch repositories`);
      }
      if (error instanceof IngestTooLargeError) return fail(reply, 413, 1001, error.message);
      if (error instanceof IngestPayloadError) return fail(reply, 422, 1001, error.message);
      throw error;
    }
  });

  /**
   * 协议自描述：接入排查时第一个想确认的是「平台认哪个版本、上限是多少」。
   *
   * **要 Token**，尽管回的只有三个常量：这条路由和 `POST /ingest` 一样挂在根上、对公网可达，
   * 而一个不需要凭据的接口会顺带确认「这个地址是一个 ApiTrack 平台」。唯一的调用者是拿着
   * Token 排查接入的人，所以要求它不增加任何成本。
   */
  app.get("/ingest/protocol", async (request, reply) => {
    const identity = await authenticateIngest(request.headers.authorization);
    if (!identity) return fail(reply, 401, 1002, "ingest token is invalid or revoked");
    return success({
      protocolVersion: PROTOCOL_VERSION,
      maxRecords: INGEST_MAX_RECORDS,
      maxBodyBytes: INGEST_MAX_BODY_BYTES,
    });
  });

  /**
   * 用例树数据 + 覆盖统计（交互 3.11.1）。
   *
   * 树是「系统 → 接口 → 用例」，所以这里回的是**按接口分组的用例**，不是用例的平表。
   * 分页分在**接口**上：一个接口下的用例要一起显示才有意义，切页会让「这个接口有几条
   * 用例」这个数字随页码变。
   *
   * 两个计数口径不同（边界 9），响应里各给一个名字：`caseCount` 是关系数，
   * `distinctCaseTotal` 是 distinct case_key。相加不相等，界面上必须写明。
   */
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; status?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/repo-cases", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const { page, pageSize, offset } = paging(request.query);
    /* `removed` 默认折叠置灰（交互 3.11.1）：默认只回 active，要看软删的显式传
       status=all——一棵混着历史用例的树读不出「现在测到了多少」。 */
    const includeRemoved = request.query.status === "all" || request.query.status === "removed";
    /**
     * 三条查询（计数 / 接口页 / 用例行）共用同一份用例过滤条件，所以过滤参数必须占据
     * **最前面**那几个位置，各查询自己的参数一律追加在后面。把 `$2` 让给某一条查询的
     * endpointIds，另一条查询里的关键字就会落到 `$2` 上并静默匹配错东西。
     */
    const filterParams: unknown[] = [context.project.id];
    const caseClauses = ["c.project_id = $1"];
    if (!includeRemoved) caseClauses.push("c.status = 'active'");
    else if (request.query.status === "removed") caseClauses.push("c.status = 'removed'");
    const keyword = request.query.keyword?.trim();
    if (keyword) {
      filterParams.push(`%${keyword}%`);
      /* 名字、case_key 与文件路径一起搜：三者都是用户会拿来找一条用例的入口
         （边界 8：file_path 用于详情显示与按前缀搜索）。 */
      caseClauses.push(`(c.name ILIKE $${filterParams.length} OR c.case_key ILIKE $${filterParams.length} OR c.file_path ILIKE $${filterParams.length})`);
    }
    const caseWhere = caseClauses.join(" AND ");
    const coveredEndpoint = `EXISTS (SELECT 1 FROM repo_case_endpoints r JOIN repo_test_cases c ON c.id = r.repo_case_id
                       WHERE r.endpoint_id = e.id AND ${caseWhere})`;

    /* 有用例关系的接口 = 已覆盖的接口。接口本身的清单来自 endpoints，用例数来自关系表
       ——分组子查询而不是直接 join，理由与 dashboard.ts 同款：join 兄弟表会成倍放大行数。 */
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM endpoints e WHERE e.project_id = $1 AND ${coveredEndpoint}`,
      filterParams,
    );
    const endpoints = await pool.query(
      `SELECT e.id, e.name, e.method, e.url,
              (SELECT COUNT(*)::int FROM repo_case_endpoints r JOIN repo_test_cases c ON c.id = r.repo_case_id
                WHERE r.endpoint_id = e.id AND ${caseWhere}) AS case_count
         FROM endpoints e
        WHERE e.project_id = $1 AND ${coveredEndpoint}
        ORDER BY e.method, e.url
        LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
      [...filterParams, pageSize, offset],
    );

    const endpointIds = endpoints.rows.map((row) => String(row.id));
    const caseRows = endpointIds.length
      ? await pool.query(
          `SELECT r.endpoint_id, c.*, lr.report_run_id, lr.report_run_number, lr.report_task_name, lr.report_run_at, lr.report_status
             FROM repo_case_endpoints r JOIN repo_test_cases c ON c.id = r.repo_case_id
             ${LATEST_REPORT_LATERAL}
            WHERE r.endpoint_id = ANY($${filterParams.length + 1}::uuid[]) AND ${caseWhere}
            ORDER BY c.name`,
          [...filterParams, endpointIds],
        )
      : { rows: [] as Record<string, unknown>[] };

    const byEndpoint = new Map<string, Record<string, unknown>[]>();
    for (const row of caseRows.rows) {
      const key = String(row.endpoint_id);
      const bucket = byEndpoint.get(key) ?? [];
      bucket.push(row);
      byEndpoint.set(key, bucket);
    }

    /* 覆盖统计：分母是**已登记接口的去重形状数**（边界 16——绝不因为上报到未登记接口就扩
       分母；同一 (method, 归一路径) 登记成多行时只算一个，理由见 `coverageShapeKey`——匹配器
       只会把用例挂到其中一行，按行数当分母会把覆盖率压低）。分子是「有仓库用例挂着」的
       形状数：同形多行里任一行挂了用例，这个形状就算已覆盖。这份数字只在本页显示，
       `/dashboard` 的 coverageRate 一个字都不改（边界 2）。 */
    const shapes = await loadEndpointShapes(context.project.id);
    const shapeOf = new Map<string, string>();
    for (const shape of shapes) shapeOf.set(shape.id, coverageShapeKey(shape.method, shape.path));
    const endpointTotal = new Set(shapeOf.values()).size;
    /* 挂了用例的接口行 → 形状：DISTINCT endpoint_id 在 SQL 里做，去重到形状只能在 TS 里做
       （归一不是 SQL 的能力）。关系表 ON DELETE CASCADE，行随接口删除而消失，所以每个 id
       都该在 shapeOf 里；查不到的宁可丢掉也不计入。 */
    const coveredRows = await pool.query(
      `SELECT DISTINCT r.endpoint_id AS id
         FROM repo_case_endpoints r JOIN repo_test_cases c ON c.id = r.repo_case_id
        WHERE c.project_id = $1 AND c.status = 'active'`,
      [context.project.id],
    );
    const coveredShapes = new Set<string>();
    for (const row of coveredRows.rows) {
      const key = shapeOf.get(String(row.id));
      if (key !== undefined) coveredShapes.add(key);
    }
    const stats = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM repo_test_cases WHERE project_id = $1 AND status = 'active') AS case_total,
         (SELECT COUNT(*)::int FROM repo_test_cases WHERE project_id = $1 AND status = 'removed') AS removed_total,
         (SELECT COUNT(*)::int FROM repo_test_cases c WHERE c.project_id = $1 AND c.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM repo_case_endpoints r WHERE r.repo_case_id = c.id)) AS unplaced_total`,
      [context.project.id],
    );
    const summary = stats.rows[0];

    return success({
      endpoints: endpoints.rows.map((row) => ({
        endpointId: String(row.id), name: String(row.name), method: String(row.method), url: String(row.url),
        /* 关系数（边界 9）：与 distinctCaseTotal 不是同一个口径。 */
        caseCount: Number(row.case_count),
        /* 2026-09-03 起 cases 不再带 requestCount（用户要求删掉「请求数」列）；
            最近任务 / 状态 / 最近执行从 lastReport 读（见 LATEST_REPORT_LATERAL）。 */
        cases: (byEndpoint.get(String(row.id)) ?? []).map((entry) => ({
          ...mapRepoTestCase(entry),
          lastReport: mapLastReport(entry),
        })),
      })),
      coverage: {
        /* 两个数都是「形状」口径（去重键见 coverageShapeKey）；树上的接口行仍是行口径，
           重复登记时行数 ≥ 形状数，两处对不上是登记侧的信号，不是统计的错。 */
        endpointTotal,
        coveredEndpointTotal: coveredShapes.size,
        /* distinct case_key（边界 9）。 */
        distinctCaseTotal: Number(summary.case_total),
        removedCaseTotal: Number(summary.removed_total),
        unplacedCaseTotal: Number(summary.unplaced_total),
      },
    }, { page, pageSize, total: Number(countResult.rows[0].total) });
  });

  /**
   * 未归位用例（边界 21）。
   *
   * 有 inventory 但一个接口都没打到的用例：跨系统调用一多就会出现「这条用例只打了外部
   * 接口」的情况——它在 inventory 里，但拿不到任何关系，而树是「系统 → 接口 → 用例」，
   * 它没有地方挂。**不能藏掉**：藏了之后「上报了 36 条用例，树上只数出 31 条」会被当成
   * bug 报上来。
   *
   * 路由必须注册在 `/repo-cases/:caseId` **之前**：Fastify 的静态段优先级高于参数段，
   * 顺序其实不影响匹配，但读代码的人会以为 `unplaced` 会被 `:caseId` 吃掉，放在前面省一
   * 次困惑。
   */
  app.get<{ Params: { id: string }; Querystring: { page?: string; pageSize?: string } }>("/api/v1/projects/:id/repo-cases/unplaced", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const { page, pageSize, offset } = paging(request.query);
    const where = `c.project_id = $1 AND c.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM repo_case_endpoints r WHERE r.repo_case_id = c.id)`;
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM repo_test_cases c WHERE ${where}`, [context.project.id]);
    const result = await pool.query(
      `SELECT c.*, lr.report_run_id, lr.report_run_number, lr.report_task_name, lr.report_run_at, lr.report_status
         FROM repo_test_cases c
         ${LATEST_REPORT_LATERAL}
        WHERE ${where} ORDER BY c.name LIMIT $2 OFFSET $3`,
      [context.project.id, pageSize, offset],
    );
    /* 与主树同款补 lastReport（未归位用例的最近任务报告同样成立——它只是没打到本项目
        登记的接口，CI 照样跑了它）。 */
    return success(
      result.rows.map((row) => ({ ...mapRepoTestCase(row), lastReport: mapLastReport(row) })),
      { page, pageSize, total: Number(count.rows[0].total) },
    );
  });

  /**
   * 单用例：参数化场景 + 最近的记录 + **最新任务报告**（2026-09-03，验收反馈 ⑦）。
   *
   * `latestReport` 回答三个问题：「绑定了哪个仓库任务」（taskName / runNumber）、
   * 「这轮报告里它的结论」（status / durationMs / message）、「用例内执行了什么」——
   * 后者由两部分拼成：报告包里的 allure 步骤树（`steps`，有报告包才有）与那次 run 的
   * SDK 请求序列（`requests`，按 seq 排序；`endpointId` 都在行上，前端据此高亮「该接口
   * 所在的步骤」）。两部分都可能缺席（junit-only 的任务没有包、关了 SDK 的任务没有
   * 上报），缺席就是缺席，不伪造空壳。
   */
  app.get<{ Params: { id: string; caseId: string }; Querystring: { page?: string; pageSize?: string } }>("/api/v1/projects/:id/repo-cases/:caseId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "repo case not found");
    const result = await pool.query("SELECT * FROM repo_test_cases WHERE id = $1 AND project_id = $2", [request.params.caseId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "repo case not found");
    const caseRow = result.rows[0];
    /* 参数化场景：records 里 distinct param_id，按首次出现排序（2026-08-30 用例详情用）。
        协议不报场景清单——它只存在于请求记录里，所以这里聚合。allure 式的步骤不受 SDK
        采集（桩挂在传输层，看不见 allure.step），场景 id 是 ingest 侧最接近的对应物；
        报告侧的步骤树在下面的 latestReport.steps。 */
    const params = await pool.query(
      `SELECT param_id, MIN(created_at) AS first_seen
         FROM ingest_records WHERE repo_case_id = $1 AND param_id IS NOT NULL
        GROUP BY param_id ORDER BY first_seen, param_id`,
      [request.params.caseId],
    );
    const { page, pageSize, offset } = paging(request.query);
    const recordCount = await pool.query("SELECT COUNT(*)::int AS total FROM ingest_records WHERE repo_case_id = $1", [request.params.caseId]);
    const records = await pool.query(
      "SELECT * FROM ingest_records WHERE repo_case_id = $1 ORDER BY created_at DESC, seq DESC LIMIT $2 OFFSET $3",
      [request.params.caseId, pageSize, offset],
    );

    /* ── 最新任务报告（树上的状态/最近执行同一条匹配，见 LATEST_REPORT_LATERAL）── */
    let latestReport: {
      runId: string; runNumber: number; taskName: string; status: "passed" | "failed" | "skipped";
      durationMs: number; message: string | null; runAt: string;
      steps?: ReportStep[];
      requests: IngestRecord[];
    } | undefined;
    const latest = await pool.query(
      `SELECT lr.* FROM repo_test_cases c ${LATEST_REPORT_LATERAL} WHERE c.id = $1`,
      [request.params.caseId],
    );
    if (latest.rowCount && latest.rows[0].report_run_id) {
      const row = latest.rows[0];
      const runId = String(row.report_run_id);
      /* 步骤树来自报告包（与 run 详情页同一个装载器与缓存）：按「归一 fullName =
          case_key」匹配——与 LATERAL 匹配 pipeline_run_cases 是同一把尺。归一两侧都做：
          报告包里的 fullName 是 allure-pytest 的 `pkg.Mod#test` 点号形态（Runner 侧
          normalizeFullName 只管新上报的 guessed_case_key，报告包是 zip 原文，改不了），
          所以这里把两边都折到同一形态再比——`#`→`::` + 包段点号→`/` 补 `.py`。 */
      let steps: ReportStep[] | undefined;
      const artifact = await findReportArtifactRow(runId);
      if (artifact) {
        try {
          const view = await loadReportView(String(artifact.id), String(artifact.storage_driver), String(artifact.storage_key));
          const fullNameToNodeid = (value: string) => {
            const hash = value.indexOf("#");
            if (hash < 0) return value;
            const head = value.slice(0, hash);
            return `${head ? `${head.replace(/\./g, "/")}.py` : ""}::${value.slice(hash + 1)}`;
          };
          /* 两边都去参数化后缀再比（参数化子项共享一棵步骤树时取第一条；normal用例只有一条）。 */
          const normalizeKey = (value: string) => fullNameToNodeid(value).replace(/\[[^\]]*\]$/, "");
          const matched = view.cases.find((each) => normalizeKey(each.fullName) === String(caseRow.case_key));
          if (matched) steps = matched.steps;
        } catch {
          /* 包读不出来：报告事实仍在，步骤树缺席（best-effort 增强而不是前提）。 */
        }
      }
      /* 请求序列来自那次 run 的 SDK 上报（pipeline_runs.ingest_run_id，迁移 045 折行口径
         下它指向本 run 对应的 ingest 行）。上限 200：序列是「第几步打了哪个接口」的
         展示，不是取证清单。 */
      const requests = row.report_ingest_run_id
        ? await pool.query(
            "SELECT * FROM ingest_records WHERE repo_case_id = $1 AND ingest_run_id = $2 ORDER BY seq LIMIT 200",
            [request.params.caseId, String(row.report_ingest_run_id)],
          )
        : { rows: [] as Record<string, unknown>[] };
      latestReport = {
        runId,
        runNumber: Number(row.report_run_number),
        taskName: String(row.report_task_name),
        status: String(row.report_status) as "passed" | "failed" | "skipped",
        durationMs: Number(row.report_duration_ms ?? 0),
        message: row.report_message === null || row.report_message === undefined ? null : String(row.report_message),
        runAt: new Date(String(row.report_run_at)).toISOString(),
        ...(steps ? { steps } : {}),
        requests: requests.rows.map(mapIngestRecord),
      };
    }

    return success({
      ...mapRepoTestCase(caseRow),
      params: params.rows.map((row) => String(row.param_id)),
      records: records.rows.map(mapIngestRecord),
      latestReport,
    }, { page, pageSize, total: Number(recordCount.rows[0].total) });
  });

  /** 上报记录列表（交互 3.11.3）：commit / 分支 / scope / 是否全量 / diff。 */
  /**
   * 上报记录列表（交互 3.11.3）：commit / 分支 / scope / 是否全量 / diff。
   *
   * 两个降噪过滤（2026-08-30 用户确认）：`changed=1` 只看**用例有变动**的 run（新增或
   * 消失 > 0——大多数 run 是逐字相同的全量快照，diff 全 0，扫列表全是噪声）；`unmatched=1`
   * 只看**有未匹配**的 run。两个都给时是**或**——用户勾两个要的是「需要关注的都给我」，
   * 不是同时满足两条件的交集。`updated`（~N，元数据变化）不算变动：改名/改 docstring 也
   * 会推高它，勾上会让过滤失去降噪意义。
   */
  app.get<{ Params: { id: string }; Querystring: { page?: string; pageSize?: string; changed?: string; unmatched?: string } }>("/api/v1/projects/:id/ingest-runs", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const { page, pageSize, offset } = paging(request.query);
    const conditions: string[] = ["project_id = $1"];
    if (request.query.changed === "1") conditions.push("(added_count > 0 OR removed_count > 0)");
    if (request.query.unmatched === "1") conditions.push("unmatched_count > 0");
    /* 片段全部是代码写死的列名比较，不含请求输入——与 dashboard.ts 的动态过滤同纪律。 */
    const where = `WHERE ${conditions.join(" OR ")}`;
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM ingest_runs ${where}`, [context.project.id]);
    const result = await pool.query(
      `SELECT * FROM ingest_runs ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [context.project.id, pageSize, offset],
    );
    return success(result.rows.map(mapIngestRun), { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 单次 run：diff + 请求明细，分页。
   *
   * `changes=1`（2026-08-30 用户确认的语义）：明细里只留**有变动**的记录——
   * - 未匹配（`endpoint_id IS NULL`，本轮又见到了没登记的路径）；
   * - 本轮**新增的覆盖**（`repo_case_endpoints.first_seen_run_id = 本 run` 的关系对应的
   *   记录——新用例挂上接口、或老用例第一次挂上这个接口）。
   * 绝大多数 run 的记录都是既有关系的重复，「有变动」是扫明细时唯一值得看的东西。
   * 消失（−N）在记录层没有行可显示（那些请求根本没发生），由 diff 列汇总。
   */
  app.get<{ Params: { id: string; runId: string }; Querystring: { page?: string; pageSize?: string; changes?: string } }>("/api/v1/projects/:id/ingest-runs/:runId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.runId)) return fail(reply, 404, 2001, "ingest run not found");
    const result = await pool.query("SELECT * FROM ingest_runs WHERE id = $1 AND project_id = $2", [request.params.runId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "ingest run not found");
    const { page, pageSize, offset } = paging(request.query);
    const changed = request.query.changes === "1";
    /* 条件是代码写死的列比较（与 runs 列表过滤同纪律）；count 与明细共用同一份。 */
    const changesWhere = changed
      ? `AND (r.endpoint_id IS NULL OR EXISTS (
           SELECT 1 FROM repo_case_endpoints rel
            WHERE rel.repo_case_id = r.repo_case_id AND rel.endpoint_id = r.endpoint_id
              AND rel.first_seen_run_id = r.ingest_run_id))`
      : "";
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ingest_records r WHERE r.ingest_run_id = $1 ${changesWhere}`,
      [request.params.runId],
    );
    const records = await pool.query(
      `SELECT r.*, c.name AS case_name, c.case_key, e.name AS endpoint_name
         FROM ingest_records r
         LEFT JOIN repo_test_cases c ON c.id = r.repo_case_id
         LEFT JOIN endpoints e ON e.id = r.endpoint_id
        WHERE r.ingest_run_id = $1 ${changesWhere} ORDER BY r.seq LIMIT $2 OFFSET $3`,
      [request.params.runId, pageSize, offset],
    );
    return success({
      ...mapIngestRun(result.rows[0]),
      records: records.rows.map((row) => ({
        ...mapIngestRecord(row),
        caseName: row.case_name ? String(row.case_name) : undefined,
        caseKey: row.case_key ? String(row.case_key) : undefined,
        endpointName: row.endpoint_name ? String(row.endpoint_name) : undefined,
      })),
    }, { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 未匹配诊断视图（边界 20）。
   *
   * **它是诊断视图，不是待办清单**：没有待处理计数、没有红点、没有「全部处理」，也
   * **没有**「补登记接口」的动作（与原交互文档 3.11.1 冲突，已在计划 7.0 边界 20 显式
   * 撤销）。要登记接口就去接口管理页手工建——保留这一步摩擦是有意的，它让「把一个接口
   * 放进本系统的分母」始终是一次显式决定，而不是清列表的副产品。
   *
   * 每行三样**读时标注**（不是判定，错了也没有后果）：
   * ① 出现频次 + 打过它的用例；
   * ② `phase` 分布——集中在 `setup` 的几乎一定是跨系统前置，这是仓库里唯一真正有判别力
   *    的信号，且是行为特征而非命名约定；
   * ③ 别的项目是否登记过这条路径（只回项目名）。
   *
   * ③ **在读取时查，不在 `/ingest` 时查**：既不进上报热路径，又是活的——用户中心那边
   * 今天才登记，昨天那条记录的标注今天自动出现。它从不参与任何判定。
   *
   * 静默同理是**读时**按 `ingest_path_rules` 前缀算的（迁移 035 说明了为什么不落列）。
   * `silenced=true` 时回被静默的那些行，默认只回未静默的。
   *
   * **不变量**：这张表里的记录与被静默的记录**永不计入覆盖分子**——覆盖率不会因为这套
   * 规则的任何误判而虚高。
   */
  app.get<{ Params: { id: string }; Querystring: { silenced?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/ingest-unmatched", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const { page, pageSize, offset } = paging(request.query);
    const silenced = request.query.silenced === "true";
    /* 前缀规则用 SQL 的 LIKE 前缀匹配（`path LIKE prefix || '%'`），不用正则：规则要
       表达的就是「`/api/v2/user/` 开头的不是我的」（见计划「明确不做」）。
       `||'%'` 里的 prefix 是库里的列值而不是请求输入，所以没有转义面。 */
    const ruleMatch = `EXISTS (SELECT 1 FROM ingest_path_rules p
        WHERE p.project_id = $1 AND COALESCE(r.path_normalized, r.path_raw) LIKE p.path_prefix || '%')`;
    const where = `r.project_id = $1 AND r.endpoint_id IS NULL AND ${silenced ? "" : "NOT "}${ruleMatch}`;
    /* 按归一后的模板聚合（迁移 035）：按 path_raw 分组会让 `/users/1`…`/users/900` 变成
       900 行各出现一次的列表，那张表就再也读不出「哪条路径最常被打到」。 */
    const groupKey = "r.method, COALESCE(r.path_normalized, r.path_raw)";
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM (SELECT 1 FROM ingest_records r WHERE ${where} GROUP BY ${groupKey}) g`,
      [context.project.id],
    );
    const result = await pool.query(
      `SELECT r.method,
              COALESCE(r.path_normalized, r.path_raw) AS path,
              COUNT(*)::int AS hit_count,
              COUNT(*) FILTER (WHERE r.phase = 'setup')::int AS setup_count,
              COUNT(*) FILTER (WHERE r.phase = 'call')::int AS call_count,
              COUNT(*) FILTER (WHERE r.phase = 'teardown')::int AS teardown_count,
              MAX(r.created_at) AS last_seen_at,
              /* 打过它的用例，最多 5 条：这是一条线索而不是一份清单，给全了也没人读完。 */
              (ARRAY_AGG(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL))[1:5] AS case_names,
              COUNT(DISTINCT r.repo_case_id)::int AS case_count
         FROM ingest_records r
         LEFT JOIN repo_test_cases c ON c.id = r.repo_case_id
        WHERE ${where}
        GROUP BY ${groupKey}
        ORDER BY hit_count DESC, path
        LIMIT $2 OFFSET $3`,
      [context.project.id, pageSize, offset],
    );

    /* ③ 跨项目登记查询：只回项目名，不回接口详情——「哪个系统登记过这条路径」是全部
       需要的信息，接口的形状是别人项目里的事。只查**用户看得见的**项目（系统管理员看
       全部），否则这张诊断表会变成一条跨项目的信息泄露通道。
       候选按本页出现过的 method 收窄：路径要归一之后才能比，没法在 SQL 里过滤，但 method
       可以——只拿 GET/POST 两种就不必把别的项目的整张接口表读回来。 */
    const methods = [...new Set(result.rows.map((row) => String(row.method).toUpperCase()))];
    const owners = methods.length
      ? await pool.query(
          `SELECT DISTINCT e.method, e.url, p.name AS project_name
             FROM endpoints e JOIN projects p ON p.id = e.project_id
            WHERE e.project_id <> $1 AND UPPER(e.method) = ANY($4::text[])
              AND ($3::boolean OR EXISTS (SELECT 1 FROM user_project_roles upr WHERE upr.project_id = e.project_id AND upr.user_id = $2))`,
          [context.project.id, context.user.id, context.user.isSystemAdmin, methods],
        )
      : { rows: [] as Record<string, unknown>[] };
    /* 归一后的模板与别人项目里的接口路径比对，两边都过一次 `comparableTemplate`：占位符
       名字必然不同（这边通用归一出 `{id}`，那边登记的可能是 `{userId}`），按原样比这条
       标注几乎永远为空——而空着与「真的没人登记」看起来一样。 */
    const ownerIndex = new Map<string, Set<string>>();
    for (const row of owners.rows) {
      const key = `${String(row.method).toUpperCase()} ${comparableTemplate(endpointPath(String(row.url)))}`;
      const set = ownerIndex.get(key) ?? new Set<string>();
      set.add(String(row.project_name));
      ownerIndex.set(key, set);
    }

    return success(result.rows.map((row) => ({
      method: String(row.method),
      path: String(row.path),
      hitCount: Number(row.hit_count),
      caseCount: Number(row.case_count),
      caseNames: Array.isArray(row.case_names) ? (row.case_names as unknown[]).map(String) : [],
      phases: { setup: Number(row.setup_count), call: Number(row.call_count), teardown: Number(row.teardown_count) },
      lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)).toISOString() : undefined,
      /* 只有项目名（边界 20）。空数组不代表「不是外部的」——别人还没做自动化时它就是空的。 */
      registeredInProjects: [...(ownerIndex.get(`${String(row.method).toUpperCase()} ${comparableTemplate(String(row.path))}`) ?? [])],
    })), { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 关联到已登记接口（边界 20 保留的那个动作）。
   *
   * 它安全：目标接口本来就在本项目、本来就在分母里，关联只是把记录挪过去。它解决的也
   * 不是归属问题，而是 path 归一没匹配上（`/users/abc-123` 这类）——那是技术缺陷，该修。
   *
   * **不回溯改写历史以外的东西**：这里改的是已有记录的 `endpoint_id`（那正是「关联」的
   * 意思），但**不**去补建 `repo_case_endpoints` 之外的任何派生数据；未来的归位靠下一次
   * 上报（边界 16 不回溯）。关系表要补，否则关联完树上依然看不到这条用例。
   */
  app.post<{ Params: { id: string }; Body: { method?: string; path?: string; endpointId?: string } }>("/api/v1/projects/:id/ingest-unmatched/link", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const method = request.body?.method?.trim().toUpperCase();
    const path = request.body?.path?.trim();
    const endpointId = request.body?.endpointId;
    if (!method || !path) return fail(reply, 400, 1001, "method and path are required");
    if (!endpointId || !isUuid(endpointId)) return fail(reply, 400, 1001, "endpointId must be a UUID");
    const endpoint = await pool.query("SELECT 1 FROM endpoints WHERE id = $1 AND project_id = $2", [endpointId, context.project.id]);
    if (!endpoint.rowCount) return fail(reply, 400, 1001, "endpoint must belong to this project");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await attachUnmatchedRecords(
        client, context.project.id, endpointId,
        "method = $3 AND COALESCE(path_normalized, path_raw) = $4", [method, path],
      );
      await client.query("COMMIT");
      return success(result);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * 一键登记（2026-08-30 用户确认新增，修订边界 20：保住「进分母 = 显式决定」的精神，
   * 撤掉「去接口管理页填一遍表」的摩擦——仓库模式团队不该为了覆盖率把仓库里已有的接口
   * 清单在平台再抄一遍，而那些路径其实已经躺在未匹配区里了）。
   *
   * 形状上的克制与边界 20 一脉相承：仍是**单行、显式、无批量**动作——没有待处理计数、
   * 没有「全部处理」。分母依然只随人的决定增长，只是这个决定从「填一张表」变成「确认
   * 一个预填好的模板」。
   *
   * 行为：
   * 1. 建**最小 endpoint**（method + path 模板；headers/body/auth 全空——仓库模式平台不
   *    执行请求，这行的唯一职责是进覆盖分母。url 记成 `{{baseUrl}}` + 模板，满足「绝对
   *    地址或含 `{{`」的 URL 契约，以后想在接口模式调试再补）。
   * 2. 同形 409：项目里已有相同 (method, 归一形状) 的接口时拒绝，让人改用「关联」——
   *    再登记一行只会让分母把同一个接口重复计一次（见 coverageShapeKey 的来龙去脉）。
   * 3. 历史归位按**匹配语义**筛而不是精确串：用新模板建单形状匹配器逐条试未匹配记录的
   *    path_raw（与 ingest 时的匹配同一条代码路径）。这一步正是为了补通用归一的盲区——
   *    `/users/abc` 的 `abc` 不像 id、归一不会换成 `{id}`，登记时把模板改成
   *    `/users/{username}` 才能让下一轮 `/users/bob` 也命中。被前缀规则静默的记录一并
   *    归位：静默只是显示规则，而这里是一次显式决定。
   * 4. 下一次上报自动匹配（边界 16 不回溯改写历史，但这条新接口从现在起参与匹配）。
   */
  app.post<{ Params: { id: string }; Body: { method?: string; path?: string; name?: string } }>("/api/v1/projects/:id/ingest-unmatched/register", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const method = request.body?.method?.trim().toUpperCase();
    const path = request.body?.path?.trim();
    const name = request.body?.name?.trim();
    if (!method || !METHODS.includes(method)) return fail(reply, 400, 1001, `method must be one of ${METHODS.join(", ")}`);
    /* 模板必须以 `/` 开头且不含 query/fragment：它要进 endpoints.url 参与逐段匹配，
       带着 `?` 的模板永远匹配不上任何 raw path，而它错得非常安静。 */
    if (!path || !path.startsWith("/")) return fail(reply, 400, 1001, "path must start with /");
    if (/[?#]/.test(path)) return fail(reply, 400, 1001, "path must not contain query or fragment");

    /* 同形拦截在事务外做：读侧判重，撞了直接 409，不占连接。 */
    const shapes = await loadEndpointShapes(context.project.id);
    const shapeKey = coverageShapeKey(method, path);
    const clash = shapes.find((shape) => coverageShapeKey(shape.method, shape.path) === shapeKey);
    if (clash) {
      return fail(reply, 409, 2003, `endpoint with the same method and path shape already exists (${String(clash.id)}); link the records to it instead`);
    }

    /* 历史归位候选：先在 SQL 里按 method 收窄到未匹配记录的 distinct path_raw，再在 TS 里
       逐条试匹配（归一不是 SQL 的能力）。候选量 = 未匹配的 distinct 原始路径数，一次性
       管理动作，几百上千条也在毫秒级。 */
    const candidates = await pool.query(
      "SELECT DISTINCT path_raw FROM ingest_records WHERE project_id = $1 AND endpoint_id IS NULL AND method = $2",
      [context.project.id, method],
    );
    const matcher = buildEndpointMatcher([{ id: "pending", method, path }]);
    const rawPaths = candidates.rows
      .map((row) => String(row.path_raw))
      .filter((raw) => matcher.match(method, stripQuery(raw)));

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      /* 最小 endpoint：列清单与 endpoints.ts 的 WRITE_COLUMNS 同一张表（那边刻意不导出——
         routes 之间不互相 import 内部助手）。这里除身份与模板外全空，列变动时两处同步
         （P11 的 `created_by` 就是一次同步：登记是人工动作，落 `context.user.id`）。 */
      const created = await client.query(
        `INSERT INTO endpoints (id, project_id, name, description, method, url,
           headers, query_params, path_params, body_type, body, body_text, auth, tags, default_environment_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6,
           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'none', NULL, NULL, '{"type":"none"}'::jsonb, '{}', NULL, $7)
         RETURNING *`,
        [
          randomUUID(), context.project.id,
          name || `${method} ${path}`, "从未匹配区一键登记", method, `{{baseUrl}}${path}`,
          context.user.id,
        ],
      );
      const endpointId = String(created.rows[0].id);
      const attached = rawPaths.length
        ? await attachUnmatchedRecords(
            client, context.project.id, endpointId,
            "method = $3 AND path_raw = ANY($4::text[])", [method, rawPaths],
          )
        : { linkedRecords: 0, linkedCases: 0 };
      await client.query("COMMIT");
      /* P11-9 审计：一键登记是人动作，落的是一行 endpoint.create（登记时带的字段名）。 */
      writeAuditLogAsync({
        action: AUDIT_ACTIONS.endpointCreate, targetType: "endpoint", targetId: endpointId,
        projectId: context.project.id, userId: context.user.id,
        detail: { fields: ["name", "method", "url"], registeredFrom: "ingest-unmatched" }, ip: request.ip,
      });
      return reply.code(201).send(success({ endpoint: mapEndpoint(created.rows[0]), ...attached }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * 外部依赖前缀规则（边界 20）。
   *
   * **只影响未匹配诊断列表的显示，不影响任何统计**——所以规则写错的代价是「列表里多一条
   * 或少一条」，不是一次分类错误。项目内允许重复与多条，因为它不承担归属判定。
   */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/ingest-path-rules", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const result = await pool.query("SELECT * FROM ingest_path_rules WHERE project_id = $1 ORDER BY path_prefix", [context.project.id]);
    return success(result.rows.map(mapIngestPathRule), { total: result.rowCount });
  });

  app.post<{ Params: { id: string }; Body: { pathPrefix?: string; note?: string } }>("/api/v1/projects/:id/ingest-path-rules", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const prefix = request.body?.pathPrefix?.trim();
    if (!prefix) return fail(reply, 400, 1001, "pathPrefix is required");
    /* 必须以 `/` 开头：前缀是拿来跟路径比的，`api/v2` 这种写法一条都匹配不上，而它错得
       非常安静——用户只会觉得「规则不生效」。 */
    if (!prefix.startsWith("/")) return fail(reply, 400, 1001, "pathPrefix must start with /");
    const result = await pool.query(
      "INSERT INTO ingest_path_rules (id, project_id, path_prefix, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [randomUUID(), context.project.id, prefix, request.body?.note?.trim() ?? "", context.user.id],
    );
    return reply.code(201).send(success(mapIngestPathRule(result.rows[0])));
  });

  /** 删规则：被静默的记录**重新出现**（静默是读时算的，历史记录从未被改写）。 */
  app.delete<{ Params: { id: string; ruleId: string } }>("/api/v1/projects/:id/ingest-path-rules/:ruleId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.ruleId)) return fail(reply, 404, 2001, "path rule not found");
    const result = await pool.query("DELETE FROM ingest_path_rules WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.ruleId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "path rule not found");
    return success({ id: request.params.ruleId });
  });
}
