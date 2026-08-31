import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { issueIngestToken } from "../lib/ingestAuth.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapIngestToken, mapRepository } from "../models/types.js";

/**
 * 仓库绑定与上报凭据（P4-2，计划 7.2）。
 *
 * 仓库是**单例视图**：`GET /projects/:id/repository` 回一行或 `null`，没有列表、没有
 * 创建路由——绑定由首次上报完成（边界 18），登记一个「还没报过任何东西的仓库」在平台上
 * 没有任何用途。这里只有读、改跟踪分支、解绑三件事。
 */

const PROVIDERS = ["github", "gitlab", "gitee", "bitbucket", "other"];

export async function repositoryRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/repository", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const result = await pool.query("SELECT * FROM repositories WHERE project_id = $1", [context.project.id]);
    /* 未绑定回 `null` 而不是 404：接入指引页把「还没报过」当成一个正常的初始状态显示，
       404 会让它必须把「真的没绑」与「请求错了」两件事分开处理。 */
    if (!result.rowCount) return success(null);
    /* 用例总数与最近一次上报是接入状态的全部答案（交互 3.11.2 的连通状态）。 */
    const stats = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM repo_test_cases WHERE project_id = $1 AND status = 'active') AS active_cases,
         (SELECT COUNT(*)::int FROM ingest_runs WHERE project_id = $1) AS run_total`,
      [context.project.id],
    );
    return success({
      ...mapRepository(result.rows[0]),
      activeCaseCount: Number(stats.rows[0].active_cases),
      ingestRunCount: Number(stats.rows[0].run_total),
    });
  });

  /**
   * 只允许改跟踪分支与托管方标注。
   *
   * `git_url` 刻意不可改：它是上报时的准入判据（边界 18），在 UI 里改掉等于绕过那道
   * 校验换一个仓库进来。要换仓库就走解绑，那是一次显式决定。
   */
  app.patch<{ Params: { id: string }; Body: { trackingBranch?: string; provider?: string } }>("/api/v1/projects/:id/repository", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const branch = request.body?.trackingBranch?.trim();
    if (request.body?.trackingBranch !== undefined && !branch) return fail(reply, 400, 1001, "trackingBranch cannot be empty");
    if (request.body?.provider !== undefined && !PROVIDERS.includes(request.body.provider)) return fail(reply, 400, 1001, `provider must be one of ${PROVIDERS.join(", ")}`);
    const result = await pool.query(
      `UPDATE repositories SET tracking_branch = COALESCE($2, tracking_branch), provider = COALESCE($3, provider), updated_at = now()
        WHERE project_id = $1 RETURNING *`,
      [context.project.id, branch ?? null, request.body?.provider ?? null],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "repository not found");
    return success(mapRepository(result.rows[0]));
  });

  /**
   * 解绑（边界 18）：置 `unbound`，**保留**历史用例与上报记录，不做级联删除。
   *
   * 那些历史是「当时确实测过」的事实，换个仓库不会让它变成假的；而删掉之后覆盖树会
   * 凭空塌一片，没有任何地方能解释它去哪了。解绑后下一次上报会用新的 git_url 重新
   * 激活这一行（`lib/ingestAuth.ts` 的 `bindRepository`）。
   */
  app.delete<{ Params: { id: string } }>("/api/v1/projects/:id/repository", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const result = await pool.query(
      "UPDATE repositories SET status = 'unbound', updated_at = now() WHERE project_id = $1 RETURNING *",
      [context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "repository not found");
    return success(mapRepository(result.rows[0]));
  });

  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/ingest-tokens", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    /* 列出所有列**除了** token_hash：`SELECT *` 会把它带进来，而映射漏一个字段就是一次
       凭据泄露。列名写全比信任映射安全。 */
    const result = await pool.query(
      `SELECT id, project_id, name, token_prefix, created_by, last_used_at, revoked_at, created_at
         FROM ingest_tokens WHERE project_id = $1 ORDER BY created_at DESC`,
      [context.project.id],
    );
    return success(result.rows.map(mapIngestToken), { total: result.rowCount });
  });

  /** 创建：明文**只在这一次响应里出现**（边界 17），丢了只能吊销重发。 */
  app.post<{ Params: { id: string }; Body: { name?: string } }>("/api/v1/projects/:id/ingest-tokens", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const name = request.body?.name?.trim();
    if (!name) return fail(reply, 400, 1001, "token name is required");
    const issued = issueIngestToken();
    const result = await pool.query(
      `INSERT INTO ingest_tokens (id, project_id, name, token_hash, token_prefix, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, project_id, name, token_prefix, created_by, last_used_at, revoked_at, created_at`,
      [randomUUID(), context.project.id, name, issued.hash, issued.prefix, context.user.id],
    );
    return reply.code(201).send(success({ ...mapIngestToken(result.rows[0]), token: issued.plaintext }));
  });

  /** 吊销是软删（留 `revoked_at`）：硬删之后「那次上报是谁报的」就答不出来了。 */
  app.delete<{ Params: { id: string; tokenId: string } }>("/api/v1/projects/:id/ingest-tokens/:tokenId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.tokenId)) return fail(reply, 404, 2001, "ingest token not found");
    const result = await pool.query(
      `UPDATE ingest_tokens SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1 AND project_id = $2
        RETURNING id, project_id, name, token_prefix, created_by, last_used_at, revoked_at, created_at`,
      [request.params.tokenId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "ingest token not found");
    return success(mapIngestToken(result.rows[0]));
  });
}
