import { type FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { notifySerializedQueue, publishPipelineTransition } from "../lib/pipelineRun.js";
import { findReportArtifactRow, loadReportView, readReportAttachment } from "../lib/reportPayload.js";
import { getSharedObjectStore, requestBaseUrl } from "../lib/objectStore.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapArtifact, mapPipelineRun, mapPipelineRunCase } from "../models/types.js";

/**
 * pipeline run 的平台侧路由（8.2 平台侧 REST）。cancel 是 P4.5-3（取消只经心跳下发的
 * 源头）；详情 / 日志 / cases / artifacts / 报告视图 / 附件下载是 P4.5-11 与 P4.5-13。
 *
 * 报告视图与附件的装载在 `lib/reportPayload.ts`（报告分享的公开路由回同一份拼装）。
 */

export async function pipelineRunRoutes(app: FastifyInstance) {
  /**
   * 列表（P4.5-15，8.12 ②）：`?ciTaskId=` 按任务过滤。此前 run 只有按 id 的详情——
   * 任务列表行内展开执行历史需要一个真正的列表接口，全局报告页的 keyword 模糊匹配
   * （任务改名就搜不到）被它替代。
   *
   * `ciTaskId` 必填：不带它就是「这个项目全部 run」的跨任务视角，那是执行记录页的
   * 职责（走 `execution_index`），这里重复实现只会长出第二套口径。动态过滤照
   * `dashboard.ts` 的 params 数组模式。
   */
  app.get<{ Params: { id: string }; Querystring: { ciTaskId?: string; page?: string; pageSize?: string } }>(
    "/api/v1/projects/:id/pipeline-runs",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, false); if (!context) return;
      const ciTaskId = String(request.query?.ciTaskId ?? "").trim();
      if (!ciTaskId) return fail(reply, 400, 1001, "ciTaskId is required");
      if (!isUuid(ciTaskId)) return fail(reply, 404, 2001, "pipeline run not found");
      const page = Math.max(1, Number(request.query?.page ?? 1) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(request.query?.pageSize ?? 5) || 5));

      /* 任务归属先验：一个不属于本项目的 ciTaskId 不该回「空列表」——那是 404 语义，
         回空会让前端把「查错项目」渲染成「这个任务还没跑过」。 */
      const task = await pool.query(
        "SELECT 1 FROM ci_tasks WHERE id = $1 AND project_id = $2",
        [ciTaskId, context.project.id],
      );
      if (!task.rowCount) return fail(reply, 404, 2001, "pipeline run not found");

      const total = await pool.query(
        "SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE ci_task_id = $1",
        [ciTaskId],
      );
      const runs = await pool.query(
        `SELECT * FROM pipeline_runs WHERE ci_task_id = $1
          ORDER BY run_number DESC LIMIT $2 OFFSET $3`,
        [ciTaskId, pageSize, (page - 1) * pageSize],
      );
      return success(runs.rows.map(mapPipelineRun), { page, pageSize, total: Number(total.rows[0].total) });
    },
  );

  /**
   * 详情（P4.5-11）：阶段进度 / 计数 / 终态事实的一页数据源。
   *
   * `meta.blockedBy`（P4.5-12）：这条 run 处于 `queued` 且被**任务级串行**挡着时，回它在
   * 等的那条 run 的序号。没有它，界面上一条一直排队的 run 与「分区没有 Runner」长得一模
   * 一样，而两者的处置动作完全不同（等着 vs 去起一台机器）。放 meta 而不是进 `PipelineRun`：
   * 它是**读时算出的关系**，不是 run 行上的事实。
   */
  app.get<{ Params: { id: string; runId: string } }>("/api/v1/projects/:id/pipeline-runs/:runId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, false); if (!context) return;
    if (!isUuid(request.params.runId)) return fail(reply, 404, 2001, "pipeline run not found");
    const result = await pool.query(
      "SELECT * FROM pipeline_runs WHERE id = $1 AND project_id = $2",
      [request.params.runId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "pipeline run not found");
    const run = result.rows[0];
    let blockedBy: number | undefined;
    if (String(run.status) === "queued") {
      /* 与 claim 侧守卫同一条判据（`routes/runners.ts`）：同任务、序号更小、仍在途。取最大
         的那个序号——它就是「等它跑完就轮到我」的那一条。 */
      const blocking = await pool.query(
        `SELECT MAX(earlier.run_number)::int AS run_number
           FROM pipeline_runs earlier JOIN ci_tasks t ON t.id = earlier.ci_task_id
          WHERE earlier.ci_task_id = $1 AND earlier.run_number < $2
            AND earlier.status IN ('queued', 'claimed', 'running', 'cancelling')
            AND t.single_concurrency`,
        [String(run.ci_task_id), Number(run.run_number)],
      );
      const number = blocking.rows[0]?.run_number;
      if (number !== null && number !== undefined) blockedBy = Number(number);
    }
    return success(mapPipelineRun(run), blockedBy === undefined ? undefined : { blockedBy });
  });

  /**
   * 日志增量（P4.5-11）：`?offset=` 起、`?bytes=` 截断。前端 SSE 收到 `pipelineLog`
   * 水位事件后按 offset 回拉——事件不带内容（8.6 的纪律：Redis pub/sub 里不流日志）。
   *
   * `bytes` 上限 512KB：一次拉一整段几 MB 日志会把 JSON 响应膨胀成浏览器一帧渲染不完
   * 的字符串；前端循环拉到追上水位为止。
   */
  app.get<{ Params: { id: string; runId: string }; Querystring: { offset?: string; bytes?: string } }>(
    "/api/v1/projects/:id/pipeline-runs/:runId/logs",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, false); if (!context) return;
      if (!isUuid(request.params.runId)) return fail(reply, 404, 2001, "pipeline run not found");
      const offset = Math.max(0, Math.trunc(Number(request.query?.offset ?? 0)) || 0);
      const bytes = Math.min(512 * 1024, Math.max(1, Math.trunc(Number(request.query?.bytes ?? 128 * 1024)) || 128 * 1024));

      const run = await pool.query(
        "SELECT log_bytes FROM pipeline_runs WHERE id = $1 AND project_id = $2",
        [request.params.runId, context.project.id],
      );
      if (!run.rowCount) return fail(reply, 404, 2001, "pipeline run not found");

      const chunks = await pool.query(
        `SELECT chunk FROM pipeline_run_logs
          WHERE pipeline_run_id = $1 AND byte_offset >= $2 AND byte_offset < $3
          ORDER BY byte_offset`,
        [request.params.runId, offset, offset + bytes],
      );
      const text = chunks.rows.map((row) => String(row.chunk)).join("");
      return success({ text, nextOffset: offset + Buffer.byteLength(text, "utf8"), totalBytes: Number(run.rows[0].log_bytes) });
    },
  );

  /**
   * 整份日志下载（P4.5-15，8.12 ③）：`text/plain` + `attachment`，一次 join 全部
   * chunk。读路径与上面的增量接口同一条（`pipeline_run_logs` 按 byte_offset 排序），
   * 只是不做 `?bytes=` 截断——日志几 MB 可接受，再大要走对象存储，那属 P6 的
   * 大响应体口径变更，不在本批。
   *
   * 与增量接口分开而不加 `?download=true` 的原因：两个消费形状差的不止响应头——
   * 一个要 envelope JSON、一个要裸文本流。合在一个 handler 里会让每条分支都为
   * 另一条背着不属于自己的约束。
   */
  app.get<{ Params: { id: string; runId: string } }>(
    "/api/v1/projects/:id/pipeline-runs/:runId/logs/download",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, false); if (!context) return;
      if (!isUuid(request.params.runId)) return fail(reply, 404, 2001, "pipeline run not found");
      const run = await pool.query(
        "SELECT log_bytes, run_number FROM pipeline_runs WHERE id = $1 AND project_id = $2",
        [request.params.runId, context.project.id],
      );
      if (!run.rowCount) return fail(reply, 404, 2001, "pipeline run not found");

      const chunks = await pool.query(
        "SELECT chunk FROM pipeline_run_logs WHERE pipeline_run_id = $1 ORDER BY byte_offset",
        [request.params.runId],
      );
      const text = chunks.rows.map((row) => String(row.chunk)).join("");
      reply.header("content-type", "text/plain; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="run-${Number(run.rows[0].run_number)}.log"`);
      return reply.send(text);
    },
  );

  /** cases（P4.5-11/13）：全量行，时间轴与列表共用一个接口（几万行内不分页——
   *  渲染侧自己虚拟化；分页会把时间轴切成不是用户心智的形状）。 */
  app.get<{ Params: { id: string; runId: string } }>(
    "/api/v1/projects/:id/pipeline-runs/:runId/cases",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, false); if (!context) return;
      if (!isUuid(request.params.runId)) return fail(reply, 404, 2001, "pipeline run not found");
      const result = await pool.query(
        `SELECT * FROM pipeline_run_cases
          WHERE pipeline_run_id = $1
          ORDER BY started_at_ms NULLS LAST, suite_name, case_name`,
        [request.params.runId],
      );
      return success(result.rows.map(mapPipelineRunCase), { total: result.rowCount });
    },
  );

  /** 产物列表（P4.5-11）：`uploaded_at` 非空的才有下载直链。 */
  app.get<{ Params: { id: string; runId: string } }>(
    "/api/v1/projects/:id/pipeline-runs/:runId/artifacts",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, false); if (!context) return;
      if (!isUuid(request.params.runId)) return fail(reply, 404, 2001, "pipeline run not found");
      const result = await pool.query(
        `SELECT * FROM artifacts
          WHERE owner_type = 'pipeline_run' AND owner_id = $1 AND uploaded_at IS NOT NULL
          ORDER BY created_at DESC`,
        [request.params.runId],
      );
      const store = await getSharedObjectStore(requestBaseUrl(request));
      /* 直链短活（5 分钟）：下载按钮点下去立刻用；列表页停留时间长，长了等于把对象
         存储开放成一个可分享的 URL。 */
      const items = [];
      for (const row of result.rows) {
        const artifact = mapArtifact(row);
        const downloadUrl = await store.presignGet(artifact.storageKey, { expiresSeconds: 300, downloadName: artifact.name });
        items.push({ ...artifact, downloadUrl });
      }
      return success(items, { total: items.length });
    },
  );

  /**
   * 报告视图（P4.5-13，边界 19）：找 run 的 `kind='report'` 产物，读 zip、解析、回归一
   * JSON。解析结果缓存 5 分钟（产物不可变——zip 是终态后传的，内容不会再变）。
   *
   * 报告包不存在时回 `data: null` 而不是 404：junit 任务的 run 详情页也请求这个接口，
   * 「没有报告视图」是正常态不是错误态。
   */
  app.get<{ Params: { id: string; runId: string } }>(
    "/api/v1/projects/:id/pipeline-runs/:runId/report",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, false); if (!context) return;
      if (!isUuid(request.params.runId)) return fail(reply, 404, 2001, "pipeline run not found");

      const artifact = await findReportArtifactRow(request.params.runId);
      if (!artifact) return success(null);
      try {
        return success(await loadReportView(String(artifact.id), String(artifact.storage_driver), String(artifact.storage_key)));
      } catch (error) {
        return fail(reply, 500, 5001, `report bundle is not readable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  /**
   * 附件下载（P4.5-13）：`storage_key` 不是浏览器能消费的东西（fs 是本地路径、s3 是
   * 对象键），presignGet 的直链又被 5 分钟短活罩着——报告页里一张 10 分钟后才点开的
   * 截图需要一个**按 run 归属鉴权**的路由来重签。`?name=` 是附件文件名（zip 内路径
   * 的 basename），fs 驱动下直接从磁盘读；s3 驱动重定向到 presigned URL。
   */
  app.get<{ Params: { id: string; runId: string }; Querystring: { name?: string } }>(
    "/api/v1/projects/:id/pipeline-runs/:runId/attachments",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, false); if (!context) return;
      if (!isUuid(request.params.runId)) return fail(reply, 404, 2001, "pipeline run not found");
      const name = String(request.query?.name ?? "").trim();
      if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
        return fail(reply, 400, 1001, "attachment name is required and must be a bare file name");
      }
      /* 附件不在 artifacts 表里（zip 内部的文件没有自己的行），存储位置跟着报告产物
         走：从 zip 里按 basename 取——报告包不可变，同一个包既是视图的数据源也是
         附件的数据源，不需要解包落盘这个中间形态。 */
      const entry = await readReportAttachment(request.params.runId, name);
      if (!entry) return fail(reply, 404, 2001, "attachment not found");
      reply.header("content-type", entry.contentType);
      reply.header("content-length", String(entry.content.byteLength));
      reply.header("cache-control", "private, max-age=3600");
      return reply.send(entry.content);
    },
  );

  /**
   * 取消（约定 6）：
   * - `queued` → **直接终态** `canceled`：还没有 Runner 持有它，没有人要通知；
   * - `claimed` / `running` → 推到 `cancelling`，下一次心跳的响应带 `cancel:true`，
   *   Runner 杀掉整个进程树后自己 `complete` 报 `canceled`（P4.5-4/5）。
   *
   * 平台**永不反向连接** Runner（REPOSITORY_ARCHITECTURE 1.3），所以「通知取消」只能是
   * Runner 来问时顺势带上——这正是取消只经心跳下发的全部原因。
   */
  app.post<{ Params: { id: string; runId: string } }>("/api/v1/projects/:id/pipeline-runs/:runId/cancel", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.runId)) return fail(reply, 404, 2001, "pipeline run not found");

    /* queued：一行 UPDATE 直接落终态。SSE 事件照发——详情页可能正开着，终态不推就永远
       停在「排队中」直到手动刷新。 */
    const queued = await pool.query(
      `UPDATE pipeline_runs SET status = 'canceled', error = 'canceled by user', finished_at = now()
        WHERE id = $1 AND project_id = $2 AND status = 'queued' RETURNING *`,
      [request.params.runId, context.project.id],
    );
    if (queued.rowCount) {
      await publishPipelineTransition(context.project.id, request.params.runId, "canceled");
      /* 串行唤醒（P4.5-12）：取消掉队头的那条排队 run 之后，它后面那条就不再被守卫挡着。
         这条路径不走 `completePipelineRun`，所以唤醒要在这里补一次。 */
      await notifySerializedQueue(pool, String(queued.rows[0].ci_task_id)).catch(() => {});
      return success(mapPipelineRun(queued.rows[0]));
    }

    /* 在途：只推状态，终止动作由持有租约的 Runner 执行。事件让界面立刻显示「取消中」，
       而不是等到 Runner 下一次心跳拿到信号后才变。 */
    const cancelling = await pool.query(
      `UPDATE pipeline_runs SET status = 'cancelling'
        WHERE id = $1 AND project_id = $2 AND status IN ('claimed', 'running') RETURNING *`,
      [request.params.runId, context.project.id],
    );
    if (cancelling.rowCount) {
      await publishPipelineTransition(context.project.id, request.params.runId, "cancelling");
      return success(mapPipelineRun(cancelling.rows[0]));
    }

    /* 都没匹配：要么不存在，要么已终态（含 cancelling——重复取消按已终态口径回）。 */
    const existing = await pool.query("SELECT 1 FROM pipeline_runs WHERE id = $1 AND project_id = $2", [request.params.runId, context.project.id]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "pipeline run not found");
    return fail(reply, 409, 2004, "pipeline run is already in a terminal or cancelling state");
  });
}
