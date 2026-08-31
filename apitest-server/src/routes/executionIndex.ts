import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { cancelFlowRun, cancelSuiteRun } from "../lib/enqueue.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapExecutionIndex, mapExecutionStep } from "../models/types.js";

export async function executionIndexRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { kind?: string; status?: string; triggerSource?: string; keyword?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/execution-index", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["project_id = $1"];
    /**
     * 非 HTTP 单步调试写的是一次性父索引（`routes/flows.ts` 的 `executeGenericStep`，
     * `detail_id = id` 自指），它存在的唯一理由是给那一行 `execution_steps` 一个归属，
     * 不是一次「父执行」。它必须排除在这份清单之外：一是「调试了一下某个节点」不该和
     * 一次完整流程/套件运行并列，二是它的 `detail_id` 不是 `flow_executions` 的 id，
     * 点开会 404。自指是这类行唯一稳定的标记（两张表的 id 都是 randomUUID，真实父执行
     * 不可能撞上）。
     */
    clauses.push("detail_id <> id");
    if (request.query.kind && request.query.kind !== "all") { params.push(request.query.kind); clauses.push(`kind = $${params.length}`); }
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`status = $${params.length}`); }
    /* 触发源筛选（P3-6，报告页/趋势页共用这份口径）：manual|scheduled|webhook|ci，
       迁移 030 的 CHECK 值域。 */
    if (request.query.triggerSource && request.query.triggerSource !== "all") { params.push(request.query.triggerSource); clauses.push(`trigger_source = $${params.length}`); }
    /* 按对象名称搜索（5.0.9 起）。`target_name` 是入队时的快照，流程与套件共用这一列，
       所以统一父执行列表（P2-4.4）的搜索框不需要按 kind 分两套。 */
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
    /* 只回顶层步骤，与套件明细（`routes/suites.ts`）一致：循环/子流程的内层证据按需走
       `GET /execution-steps/:stepId/children`。不过滤的话，一次 100 迭代的循环会把上千行
       带完整快照的步骤塞进这个响应里，而两个调用方（套件里的流程成员、记录页的
       `?parent=` 深链）都只读父行本身与顶层行。 */
    const steps = await pool.query("SELECT * FROM execution_steps WHERE index_id = $1 AND parent_step_id IS NULL ORDER BY position, created_at", [request.params.indexId]);
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
       只可能是 flow、suite 或 ingest。
       `ingest` 必须**显式**拒绝（P4 边界 1 末段）：它是「别人已经跑完的历史」，取消对它
       没有意义，而这一处是按 kind 分派的——不拒绝就会走到一个空实现里静默失败，用户点了
       取消、什么也没发生、也没有任何提示。 */
    if (kind === "ingest") return fail(reply, 400, 1001, "repository ingest records cannot be canceled: the run already finished outside the platform");
    if (kind !== "flow" && kind !== "suite") return fail(reply, 400, 1001, "this execution kind cannot be canceled");
    const canceled = kind === "suite"
      ? await cancelSuiteRun(context.project.id, detailId)
      : await cancelFlowRun(context.project.id, detailId);
    if (!canceled) return fail(reply, 409, 2004, "execution is already finished");
    const updated = await pool.query("SELECT * FROM execution_index WHERE id = $1", [request.params.indexId]);
    return success(mapExecutionIndex(updated.rows[0]));
  });
}
