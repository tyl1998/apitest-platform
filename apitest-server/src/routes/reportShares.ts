import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { loadRunnerReport, loadSuiteReport, readReportAttachment } from "../lib/reportPayload.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapExecution, mapExecutionStep, mapFlowExecution, mapReportShare } from "../models/types.js";

/**
 * 报告分享（2026-09-02，验收反馈：所有报告支持分享、免登录查看）。
 *
 * 两组路由：
 * - `/api/v1/projects/:id/report-shares`：创建 / 查询 / 撤销，走项目 RBAC（viewer 可看
 *   链接，创建与撤销要 write——与「报告是只读派生物」同一条纪律：看可以，改口径不行）。
 * - `/api/v1/public/report-shares/:token`：公开只读，**不走 JWT**（与 Webhook 公开路由
 *   同款位置）。一个 192-bit 随机 token 就是全部凭据——链接能贴给谁，报告就能给谁看。
 *
 * 公开路由回报告的**完整只读视图**（与项目内详情同一份拼装，`lib/reportPayload.ts`）；
 * 成员证据（用例快照 / 流程步骤树 / 容器内层）自 2026-09-03 起按 token 另行放行
 * （见文件尾部的三个端点与「证据闭包」注释），归属收紧到「这份报告的证据」。
 */

const TOKEN_BYTES = 24;

/** 校验目标存在且属于本项目：给别的项目的 id 造分享链接必须是一次干净的 404。 */
async function targetExists(projectId: string, targetType: string, targetId: string): Promise<boolean> {
  const sql = targetType === "suite"
    ? "SELECT 1 FROM suite_executions WHERE id = $1 AND project_id = $2"
    : "SELECT 1 FROM pipeline_runs WHERE id = $1 AND project_id = $2";
  const result = await pool.query(sql, [targetId, projectId]);
  return Boolean(result.rowCount);
}

export async function reportShareRoutes(app: FastifyInstance) {
  /**
   * 查询目标的当前有效分享（前端进入页面时问一次：已分享过就显示「已分享」而不是
   * 让人以为每次点按钮都会生成一条新链接）。没有时回 `data: null`——正常态。
   */
  app.get<{ Params: { id: string }; Querystring: { targetType?: string; targetId?: string } }>(
    "/api/v1/projects/:id/report-shares",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, false); if (!context) return;
      const targetType = request.query?.targetType === "runner" ? "runner" : request.query?.targetType === "suite" ? "suite" : "";
      const targetId = String(request.query?.targetId ?? "").trim();
      if (!targetType || !isUuid(targetId)) return fail(reply, 400, 1001, "targetType (suite|runner) and targetId are required");
      const result = await pool.query(
        "SELECT * FROM report_shares WHERE project_id = $1 AND target_type = $2 AND target_id = $3 AND revoked_at IS NULL",
        [context.project.id, targetType, targetId],
      );
      return success(result.rowCount ? mapReportShare(result.rows[0]) : null);
    },
  );

  /**
   * 创建分享：一个目标同时只有一条有效分享（部分唯一索引），重复点击拿到同一条链接。
   * `ON CONFLICT ... WHERE revoked_at IS NULL DO NOTHING` + 读回——并发双击不会撞出
   * 唯一冲突 500，也不会换 token 让先贴出去的链接失效。
   */
  app.post<{ Params: { id: string }; Body: { targetType?: string; targetId?: string } }>(
    "/api/v1/projects/:id/report-shares",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, true); if (!context) return;
      const targetType = request.body?.targetType === "runner" ? "runner" : request.body?.targetType === "suite" ? "suite" : "";
      const targetId = String(request.body?.targetId ?? "").trim();
      if (!targetType || !isUuid(targetId)) return fail(reply, 400, 1001, "targetType must be suite|runner and targetId must be a uuid");
      if (!await targetExists(context.project.id, targetType, targetId)) {
        return fail(reply, 404, 2001, "report not found");
      }
      const id = randomUUID();
      const inserted = await pool.query(
        `INSERT INTO report_shares (id, project_id, target_type, target_id, token, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (target_type, target_id) WHERE revoked_at IS NULL DO NOTHING
         RETURNING *`,
        [id, context.project.id, targetType, targetId, randomBytes(TOKEN_BYTES).toString("base64url"), context.user.id],
      );
      if (inserted.rowCount) return reply.code(201).send(success(mapReportShare(inserted.rows[0])));
      const existing = await pool.query(
        "SELECT * FROM report_shares WHERE project_id = $1 AND target_type = $2 AND target_id = $3 AND revoked_at IS NULL",
        [context.project.id, targetType, targetId],
      );
      return success(mapReportShare(existing.rows[0]));
    },
  );

  /** 撤销分享：链接立刻失效（公开路由只认有效行）。幂等——重复撤销按已撤销口径回 404。 */
  app.delete<{ Params: { id: string; shareId: string } }>(
    "/api/v1/projects/:id/report-shares/:shareId",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, true); if (!context) return;
      if (!isUuid(request.params.shareId)) return fail(reply, 404, 2001, "share not found");
      const result = await pool.query(
        "UPDATE report_shares SET revoked_at = now() WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING id",
        [request.params.shareId, context.project.id],
      );
      if (!result.rowCount) return fail(reply, 404, 2001, "share not found");
      return success({ id: String(result.rows[0].id) });
    },
  );

  /**
   * 公开读（免登录）：token → 报告的完整只读视图。按 target 类型分派到两个装载器，
   * 它们与项目内详情路由共用同一份拼装（`lib/reportPayload.ts`）。
   */
  app.get<{ Params: { token: string } }>(
    "/api/v1/public/report-shares/:token",
    async (request, reply) => {
      const token = String(request.params.token ?? "").trim();
      /* token 不是 uuid 也不进库：查一行不存在的东西没必要惊动索引之外的任何东西。 */
      if (!token || token.length > 64) return fail(reply, 404, 2001, "share not found");
      const share = await pool.query(
        `SELECT rs.*, p.name AS project_name FROM report_shares rs
           JOIN projects p ON p.id = rs.project_id
          WHERE rs.token = $1 AND rs.revoked_at IS NULL`,
        [token],
      );
      if (!share.rowCount) return fail(reply, 404, 2001, "share not found");
      const row = share.rows[0];
      const projectId = String(row.project_id);
      const targetId = String(row.target_id);

      if (String(row.target_type) === "suite") {
        const report = await loadSuiteReport(projectId, targetId);
        if (!report) return fail(reply, 404, 2001, "report not found");
        return success({
          kind: "suite" as const,
          projectName: String(row.project_name),
          sharedAt: new Date(String(row.created_at)).toISOString(),
          report,
        });
      }
      const report = await loadRunnerReport(projectId, targetId);
      if (!report) return fail(reply, 404, 2001, "report not found");
      return success({
        kind: "runner" as const,
        projectName: String(row.project_name),
        sharedAt: new Date(String(row.created_at)).toISOString(),
        report,
      });
    },
  );

  /**
   * 公开附件（免登录）：仓库执行报告的步骤附件（截图 / 日志文本）。与项目内的附件
   * 路由同一个包装载器，鉴权从「项目成员」换成「持有 token」。
   */
  app.get<{ Params: { token: string }; Querystring: { name?: string } }>(
    "/api/v1/public/report-shares/:token/attachments",
    async (request, reply) => {
      const token = String(request.params.token ?? "").trim();
      const name = String(request.query?.name ?? "").trim();
      if (!token || token.length > 64 || !name || name.includes("/") || name.includes("\\") || name.includes("..")) {
        return fail(reply, 400, 1001, "token and a bare attachment name are required");
      }
      const share = await pool.query(
        "SELECT target_type, target_id FROM report_shares WHERE token = $1 AND revoked_at IS NULL",
        [token],
      );
      if (!share.rowCount || String(share.rows[0].target_type) !== "runner") return fail(reply, 404, 2001, "share not found");
      const entry = await readReportAttachment(String(share.rows[0].target_id), name);
      if (!entry) return fail(reply, 404, 2001, "attachment not found");
      reply.header("content-type", entry.contentType);
      reply.header("content-length", String(entry.content.byteLength));
      reply.header("cache-control", "private, max-age=3600");
      return reply.send(entry.content);
    },
  );

  /* ── 公开成员证据（2026-09-03：分享页点开用例 / 流程成员也要能看到抽屉）────────
   *
   * 公开载荷原先只有报告主体，成员行在 publicView 下不可点（拉执行快照要走登录鉴权），
   * 用户看到的是「点了没反应」。这三个端点把抽屉需要的三种证据按 token 放出来，
   * 鉴权从「项目成员」换成「持有 token」，归属校验全部走下面的证据闭包。
   */

  /**
   * 证据闭包：从该套件执行的 index 出发，沿 `execution_steps.child_index_id`（流程成员
   * 的子执行）递归可达的全部 index。token 换的是「**这份报告**的证据」，不是「这个项目
   * 的执行历史」——闭包之外的行对公开端点一律 404。
   *
   * 片段是固定 SQL（不含请求输入），根 index 以参数形式传入（$n 由调用方指定）。
   */
  const evidenceIndicesSql = (rootParam: string) => `WITH RECURSIVE idx AS (
      SELECT ${rootParam}::uuid AS id
      UNION
      SELECT es.child_index_id FROM execution_steps es JOIN idx ON es.index_id = idx.id WHERE es.child_index_id IS NOT NULL
    ) SELECT id FROM idx`;

  /** 分享 token → 套件执行的 index id。非套件分享没有成员证据，回 null。 */
  async function suiteShareIndexId(token: string): Promise<string | null> {
    const share = await pool.query(
      `SELECT se.execution_index_id FROM report_shares rs
         JOIN suite_executions se ON se.id = rs.target_id
        WHERE rs.token = $1 AND rs.revoked_at IS NULL AND rs.target_type = 'suite'`,
      [token],
    );
    if (!share.rowCount) return null;
    const indexId = share.rows[0].execution_index_id;
    return indexId ? String(indexId) : null;
  }

  /** 用例成员的执行快照：只有闭包内的步骤引用过的 execution 才放行。 */
  app.get<{ Params: { token: string; executionId: string } }>(
    "/api/v1/public/report-shares/:token/executions/:executionId",
    async (request, reply) => {
      const token = String(request.params.token ?? "").trim();
      if (!token || token.length > 64 || !isUuid(request.params.executionId)) return fail(reply, 404, 2001, "share not found");
      const rootIndexId = await suiteShareIndexId(token);
      if (!rootIndexId) return fail(reply, 404, 2001, "share not found");
      const result = await pool.query(
        `SELECT e.* FROM executions e
          WHERE e.id = $1
            AND EXISTS (
              SELECT 1 FROM execution_steps es
               WHERE es.http_execution_id = e.id
                 AND es.index_id IN (${evidenceIndicesSql("$2")})
            )`,
        [request.params.executionId, rootIndexId],
      );
      if (!result.rowCount) return fail(reply, 404, 2001, "execution not found");
      return success(mapExecution(result.rows[0]));
    },
  );

  /**
   * 流程成员的步骤树：一次带回那次流程执行的 run + HTTP 快照 + 通用步骤行（项目内的
   * 路由分两跳——index 详情拿 detailId、再读流程执行；公开侧没有理由让浏览器跑两跳，
   * 服务端就地完成）。index 必须在闭包内。
   */
  app.get<{ Params: { token: string; indexId: string } }>(
    "/api/v1/public/report-shares/:token/flow-steps/:indexId",
    async (request, reply) => {
      const token = String(request.params.token ?? "").trim();
      if (!token || token.length > 64 || !isUuid(request.params.indexId)) return fail(reply, 404, 2001, "share not found");
      const rootIndexId = await suiteShareIndexId(token);
      if (!rootIndexId) return fail(reply, 404, 2001, "share not found");
      /* 闭包成员资格：根 index 本身（防呆——它不是流程成员）之外的任一可达 index。 */
      const member = await pool.query(
        `SELECT 1 WHERE $1::uuid IN (${evidenceIndicesSql("$2")}) AND $1::uuid <> $2::uuid`,
        [request.params.indexId, rootIndexId],
      );
      if (!member.rowCount) return fail(reply, 404, 2001, "flow execution not found");
      const run = await pool.query("SELECT * FROM flow_executions WHERE execution_index_id = $1", [request.params.indexId]);
      if (!run.rowCount) return fail(reply, 404, 2001, "flow execution not found");
      const flowExecutionId = String(run.rows[0].id);
      const steps = await pool.query("SELECT * FROM executions WHERE flow_execution_id = $1 ORDER BY created_at", [flowExecutionId]);
      const genericSteps = await pool.query(
        "SELECT * FROM execution_steps WHERE index_id = $1 ORDER BY COALESCE(parent_step_id::text, ''), position, created_at",
        [request.params.indexId],
      );
      return success({
        ...mapFlowExecution(run.rows[0]),
        steps: steps.rows.map(mapExecution),
        executionSteps: genericSteps.rows.map(mapExecutionStep),
      });
    },
  );

  /** 容器步骤（loop / subflow / 并发请求）的内层证据：与项目内 children 路由同一份拼装。 */
  app.get<{ Params: { token: string; stepId: string } }>(
    "/api/v1/public/report-shares/:token/step-children/:stepId",
    async (request, reply) => {
      const token = String(request.params.token ?? "").trim();
      if (!token || token.length > 64 || !isUuid(request.params.stepId)) return fail(reply, 404, 2001, "share not found");
      const rootIndexId = await suiteShareIndexId(token);
      if (!rootIndexId) return fail(reply, 404, 2001, "share not found");
      const owner = await pool.query(
        `SELECT steps.id FROM execution_steps steps
          WHERE steps.id = $1 AND steps.index_id IN (${evidenceIndicesSql("$2")})`,
        [request.params.stepId, rootIndexId],
      );
      if (!owner.rowCount) return fail(reply, 404, 2001, "execution step not found");
      const children = await pool.query(
        "SELECT * FROM execution_steps WHERE parent_step_id = $1 ORDER BY iteration NULLS FIRST, position, created_at",
        [request.params.stepId],
      );
      const httpIds = children.rows.map((row) => row.http_execution_id).filter(Boolean);
      const httpRuns = httpIds.length
        ? await pool.query("SELECT * FROM executions WHERE id = ANY($1::uuid[])", [httpIds])
        : { rows: [] as Record<string, unknown>[] };
      return success({
        steps: children.rows.map(mapExecutionStep),
        executions: httpRuns.rows.map(mapExecution),
      });
    },
  );
}
