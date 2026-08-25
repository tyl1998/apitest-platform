import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { cancelFlowRun, cancelSuiteRun } from "../lib/enqueue.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapExecutionIndex, mapExecutionStep } from "../models/types.js";

export async function executionIndexRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { kind?: string; status?: string; keyword?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/execution-index", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["project_id = $1"];
    if (request.query.kind && request.query.kind !== "all") { params.push(request.query.kind); clauses.push(`kind = $${params.length}`); }
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`status = $${params.length}`); }
    /* 流程记录按流程名称搜索（5.0.9）。 */
    if (request.query.keyword?.trim()) { params.push(`%${request.query.keyword.trim()}%`); clauses.push(`target_name ILIKE $${params.length}`); }
    const where = clauses.join(" AND "); const count = await pool.query(`SELECT COUNT(*)::int AS total FROM execution_index WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(`SELECT * FROM execution_index WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return success(result.rows.map(mapExecutionIndex), { page, pageSize, total: Number(count.rows[0].total) });
  });

  app.get<{ Params: { id: string; indexId: string } }>("/api/v1/projects/:id/execution-index/:indexId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.indexId)) return fail(reply, 404, 2001, "execution index not found");
    const result = await pool.query("SELECT * FROM execution_index WHERE id = $1 AND project_id = $2", [request.params.indexId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "execution index not found");
    const steps = await pool.query("SELECT * FROM execution_steps WHERE index_id = $1 ORDER BY position, created_at", [request.params.indexId]);
    return success({ ...mapExecutionIndex(result.rows[0]), steps: steps.rows.map(mapExecutionStep) });
  });

  app.post<{ Params: { id: string; indexId: string } }>("/api/v1/projects/:id/execution-index/:indexId/cancel", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.indexId)) return fail(reply, 404, 2001, "execution index not found");
    const result = await pool.query("SELECT * FROM execution_index WHERE id = $1 AND project_id = $2", [request.params.indexId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "execution index not found");
    const kind = String(result.rows[0].kind);
    const detailId = String(result.rows[0].detail_id);
    /* 每一类父执行有自己的取消路径：它们各自要停的东西不一样（流程要停下一步 + 在途
       请求，套件还要停在途成员的整次子执行）。批量调试不写 execution_index，所以这里
       只可能是 flow 或 suite。 */
    if (kind !== "flow" && kind !== "suite") return fail(reply, 400, 1001, "this execution kind cannot be canceled");
    const canceled = kind === "suite"
      ? await cancelSuiteRun(context.project.id, detailId)
      : await cancelFlowRun(context.project.id, detailId);
    if (!canceled) return fail(reply, 409, 2004, "execution is already finished");
    const updated = await pool.query("SELECT * FROM execution_index WHERE id = $1", [request.params.indexId]);
    return success(mapExecutionIndex(updated.rows[0]));
  });
}
