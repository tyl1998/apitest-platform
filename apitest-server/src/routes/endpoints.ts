import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, auditFields, writeAuditLogAsync, type AuditBatchDetail } from "../lib/audit.js";
import { NoRunnerError, cancelBatch, cancelRun, enqueueRun } from "../lib/enqueue.js";
import { getSharedObjectStore, requestBaseUrl, storageDriverName } from "../lib/objectStore.js";
import { endpointSnapshot, recordAssetVersion } from "../lib/assetVersions.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, failNoRunner, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { validateEndpoint, type EndpointInput } from "../lib/validate.js";
import { mapBatchExecution, mapEndpoint, mapExecution, type Endpoint, type RequestSnapshot } from "../models/types.js";

type ImportItem = EndpointInput;

/** Column list shared by insert and import so the two cannot drift apart. */
const WRITE_COLUMNS = "name, description, method, url, headers, query_params, path_params, body_type, body, body_text, auth, tags, default_environment_id, created_by";

function writeValues(input: EndpointInput, createdBy: string) {
  return [
    input.name!.trim(),
    input.description?.trim() ?? "",
    input.method!.toUpperCase(),
    input.url!.trim(),
    JSON.stringify(input.headers ?? {}),
    JSON.stringify(input.queryParams ?? {}),
    JSON.stringify(input.pathParams ?? {}),
    input.bodyType ?? (input.body === undefined ? "none" : "json"),
    input.body === undefined ? null : JSON.stringify(input.body),
    input.bodyText ?? null,
    JSON.stringify(input.auth ?? { type: "none" }),
    input.tags ?? [],
    input.defaultEnvironmentId ?? null,
    /* P11-1 列级归属：建的人。MCP 写路径走 mcpToolsWriteCore 自己的列常量，不共享这里。 */
    createdBy,
  ];
}

/**
 * Execution sources a client may filter by (来源 filter, 交互文档 3.8).
 *
 * `flow_step` is included since 5.0.9: project-wide records mark flow steps
 * as 流程执行, so the source filter must be able to narrow to them.
 */
const SOURCE_FILTERS = ["endpoint_debug", "test_case", "flow_step"];

/**
 * `?from=&to=` 时间窗参数（P8-4，下钻前置）：ISO 时间戳，解析失败 400（不静默
 * 丢弃——下钻点的是「这一段的记录」，丢窗会给出全量历史）。与 reports.ts 的
 * 同名解析保持同一份语义；各留一份是因为两处各自的路由文件没有共享层可放
 * （lib/validate.ts 是实体输入校验，不是 query 参数解析）。
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

async function validEnvironment(projectId: string, environmentId: string | null | undefined) {
  if (!environmentId || !isUuid(environmentId)) return !environmentId;
  const result = await pool.query("SELECT 1 FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  return Boolean(result.rowCount);
}

/**
 * P10-4：把一次接口写（INSERT / UPDATE / duplicate 的 `... RETURNING *`）与它的版本快照包进
 * 一个事务。`write` 返回带 `rows` 的查询结果；无行（更新未命中/复制源不存在）时回滚并回
 * `undefined`，调用方据此回 404。命中则映射、落一版快照（同事务）、提交、回映射后的 Endpoint。
 * 单条写本不需要事务，这里开事务纯粹是为了让快照与行"一起成功或一起回滚"（计划 14.3 边界）。
 */
async function writeEndpointWithVersion(
  context: { project: { id: string }; user: { id: string } },
  changeSummary: string,
  write: (client: PoolClient) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
): Promise<Endpoint | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await write(client);
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return undefined;
    }
    const endpoint = mapEndpoint(result.rows[0]);
    await recordAssetVersion(client, {
      projectId: context.project.id, assetType: "endpoint", assetId: endpoint.id,
      snapshot: endpointSnapshot(endpoint), changeSummary, createdBy: context.user.id,
    });
    await client.query("COMMIT");
    return endpoint;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The runnable part of an endpoint, in the shape a case also freezes. */
export function toRequestSnapshot(endpoint: Endpoint): RequestSnapshot {
  return {
    method: endpoint.method, url: endpoint.url,
    headers: endpoint.headers, queryParams: endpoint.queryParams, pathParams: endpoint.pathParams,
    bodyType: endpoint.bodyType, body: endpoint.body, bodyText: endpoint.bodyText, auth: endpoint.auth,
  };
}

/**
 * Resolves which environment a debug send uses, then queues the run.
 *
 * The fallback chain is endpoint default → project default, and it is skipped
 * entirely when the caller named an environment (including `null`, which means
 * "run without one").
 *
 * The definition is snapshotted here rather than re-read by the worker, so what
 * gets sent is what existed when the button was pressed — an edit made while
 * the run sits in the queue cannot change it underneath.
 *
 * Exported for the MCP `run_endpoint` tool (P5-5b): the tool runs saved
 * definitions with no overrides, which is exactly this function's contract —
 * keeping it private would force a second copy of the environment chain.
 */
export async function queueEndpointRun(projectId: string, endpointId: string, requestedEnvironmentId: string | null | undefined, explicitEnvironment: boolean, batchId?: string, triggeredBy?: string | null): Promise<string> {
  const endpointResult = await pool.query("SELECT * FROM endpoints WHERE id = $1 AND project_id = $2", [endpointId, projectId]);
  if (!endpointResult.rowCount) throw new Error("endpoint not found");
  const endpoint = mapEndpoint(endpointResult.rows[0]);

  let environmentId = requestedEnvironmentId ?? undefined;
  if (!explicitEnvironment) {
    if (endpoint.defaultEnvironmentId) environmentId = endpoint.defaultEnvironmentId;
    else {
      const setting = await pool.query("SELECT default_environment_id FROM project_settings WHERE project_id = $1", [projectId]);
      environmentId = setting.rows[0]?.default_environment_id ? String(setting.rows[0].default_environment_id) : undefined;
    }
  }

  /* Named here so history still reads correctly after the environment is
     renamed or deleted (Spec 4.4 历史保留). */
  let environmentName: string | undefined;
  if (environmentId) {
    const environment = await pool.query("SELECT name FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
    if (!environment.rowCount) throw new Error("environment must belong to the project");
    environmentName = String(environment.rows[0].name);
  }

  return enqueueRun({
    projectId,
    endpointId: endpoint.id,
    endpointName: endpoint.name,
    request: toRequestSnapshot(endpoint),
    environmentId,
    environmentName,
    source: "endpoint_debug",
    batchId,
    /* P11 边界 11：单条执行也要答「谁按的按钮」。批量走同一个入口，因此批量里的每一行
       都带同一个触发人（调用方传的就是按批量按钮的那个人）。 */
    triggeredBy: triggeredBy ?? null,
  });
}

export async function endpointRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; method?: string; environmentId?: string; coverage?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/endpoints", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const params: unknown[] = [context.project.id]; const clauses = ["endpoints.project_id = $1"];
    /* Server-side filtering, so a keyword matches every endpoint, not just the loaded page.
       列名一律带 `endpoints.` 前缀：P11 的归属列给这条查询加了 users join，`name` /
       `created_at` 这些同名裸列会变成 ambiguous。 */
    const keyword = request.query.keyword?.trim();
    if (keyword) { params.push(`%${keyword}%`); clauses.push(`(endpoints.name ILIKE $${params.length} OR endpoints.url ILIKE $${params.length} OR endpoints.description ILIKE $${params.length})`); }
    if (request.query.method && request.query.method !== "all") { params.push(request.query.method.toUpperCase()); clauses.push(`endpoints.method = $${params.length}`); }
    /* 覆盖率筛选（看板「已覆盖/未覆盖」下钻的落点）：口径与 /stats/overview 的
       coverageRate 同一表达式——有用例接口 = EXISTS(test_cases)。covered/uncovered
       之外不进 SQL（口径参数不静默报错也不放大，method 同款纪律）。 */
    if (request.query.coverage === "covered") clauses.push("EXISTS (SELECT 1 FROM test_cases tc WHERE tc.endpoint_id = endpoints.id)");
    else if (request.query.coverage === "uncovered") clauses.push("NOT EXISTS (SELECT 1 FROM test_cases tc WHERE tc.endpoint_id = endpoints.id)");
    if (request.query.environmentId === "unset") clauses.push("endpoints.default_environment_id IS NULL");
    else if (request.query.environmentId) {
      if (!isUuid(request.query.environmentId)) return fail(reply, 400, 1001, "environmentId must be a UUID or unset");
      if (!await validEnvironment(context.project.id, request.query.environmentId)) return fail(reply, 400, 1001, "environment must belong to the project");
      params.push(request.query.environmentId); clauses.push(`endpoints.default_environment_id = $${params.length}`);
    }
    /* Pagination is opt-in: the project store still fetches the whole list for
       endpoint pickers (flow nodes, mock 快照来源), so the absence of `pageSize`
       keeps the unpaginated contract those callers rely on.

       LATERAL last-run（2026-09-03 性能修复）：列表页原先靠前端另拉 200 条
       `/executions`（约 254KB）画「最近运行」条与状态列；现在按接口随行带出最近
       一次执行的 status / duration（走 executions_endpoint_created_at_idx 的
       LIMIT 1），那笔大请求连同「最近运行」列一起删除。`source <> 'flow_step'`
       与旧的前端拉法同一口径：流程步骤不冒充接口的独立运行。 */
    const select = `SELECT endpoints.*, COALESCE(cases.total, 0) AS case_count,
           lr.last_status, lr.last_duration_ms,
           /* P11 归属列（边界 7/9）：email 快照，只读这两列，不带 users 的其它字段。 */
           creator.email AS created_by_email, updater.email AS updated_by_email
         FROM endpoints
         /* Sub-select, not a join onto test_cases: joining would multiply the
            endpoint row per case and inflate anything else aggregated here. */
         LEFT JOIN (SELECT endpoint_id, COUNT(*)::int AS total FROM test_cases GROUP BY endpoint_id) AS cases
           ON cases.endpoint_id = endpoints.id
         LEFT JOIN LATERAL (
           SELECT e.status AS last_status, e.duration_ms AS last_duration_ms
             FROM executions e
            WHERE e.endpoint_id = endpoints.id AND e.source <> 'flow_step'
            ORDER BY e.created_at DESC LIMIT 1
         ) lr ON true
         LEFT JOIN users creator ON creator.id = endpoints.created_by
         LEFT JOIN users updater ON updater.id = endpoints.updated_by
         WHERE ${clauses.join(" AND ")}
         ORDER BY endpoints.created_at DESC`;
    /* caseCount is a real number now that用例 exist (P1); 0 truthfully means
       "this endpoint has no cases yet". */
    const rows = (result: { rows: Record<string, unknown>[] }) => result.rows.map((row) => ({
      ...mapEndpoint(row),
      caseCount: Number(row.case_count),
      lastStatus: row.last_status === null || row.last_status === undefined ? undefined : String(row.last_status),
      lastDurationMs: row.last_duration_ms === null || row.last_duration_ms === undefined ? undefined : Number(row.last_duration_ms),
    }));
    if (request.query.pageSize === undefined) {
      const result = await pool.query(select, params);
      return success(rows(result), { total: result.rowCount ?? 0 });
    }
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    /* The cases sub-select cannot multiply endpoint rows, so counting the base
       table under the same WHERE is the page total. */
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM endpoints WHERE ${clauses.join(" AND ")}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(`${select} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return success(rows(result), { page, pageSize, total: Number(count.rows[0].total) });
  });

  app.get<{ Params: { id: string; endpointId: string } }>("/api/v1/projects/:id/endpoints/:endpointId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.endpointId)) return fail(reply, 404, 2001, "endpoint not found");
    const result = await pool.query("SELECT * FROM endpoints WHERE id = $1 AND project_id = $2", [request.params.endpointId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "endpoint not found");
    return success(mapEndpoint(result.rows[0]));
  });

  app.get<{ Params: { id: string; endpointId: string }; Querystring: { status?: string; environmentId?: string; source?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/endpoints/:endpointId/executions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.endpointId)) return fail(reply, 404, 2001, "endpoint not found");
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id, request.params.endpointId]; const clauses = ["project_id = $1", "endpoint_id = $2"];
    /**
     * 运行记录 covers everything run against this endpoint — debug sends, case
     * runs and场景步骤 alike — because "what happened on this endpoint" is the
     * question the panel answers. `source` narrows it when only one kind is
     * wanted.
     */
    if (SOURCE_FILTERS.includes(request.query.source ?? "")) { params.push(request.query.source); clauses.push(`source = $${params.length}`); }
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`status = $${params.length}`); }
    if (isUuid(request.query.environmentId)) { params.push(request.query.environmentId); clauses.push(`environment_id = $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM executions WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(`SELECT * FROM executions WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return success(result.rows.map(mapExecution), { page, pageSize, total: Number(count.rows[0].total) });
  });

  app.post<{ Params: { id: string }; Body: EndpointInput }>("/api/v1/projects/:id/endpoints", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const invalid = validateEndpoint(request.body);
    if (invalid) return fail(reply, 400, 1001, invalid);
    if (!await validEnvironment(context.project.id, request.body.defaultEnvironmentId)) return fail(reply, 400, 1001, "default environment must belong to the project");
    /* P10-4：行与首版快照同事务落 —— 版本是内容的序列，保存即产出一版，失败整体回滚。 */
    const endpoint = await writeEndpointWithVersion(context, "创建", (client) => client.query(
      `INSERT INTO endpoints (id, project_id, ${WRITE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14, $15, $16) RETURNING *`,
      [randomUUID(), context.project.id, ...writeValues(request.body, context.user.id)],
    ));
    if (!endpoint) return fail(reply, 404, 2001, "endpoint not found");
    /* P11-9 审计（边界 5/6）：成功后 fire-and-forget；detail 只有字段名。 */
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.endpointCreate, targetType: "endpoint", targetId: endpoint.id,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return reply.code(201).send(success(endpoint));
  });

  app.patch<{ Params: { id: string; endpointId: string }; Body: EndpointInput }>("/api/v1/projects/:id/endpoints/:endpointId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.endpointId)) return fail(reply, 404, 2001, "endpoint not found");
    const invalid = validateEndpoint(request.body, true);
    if (invalid) return fail(reply, 400, 1001, invalid);
    if ("defaultEnvironmentId" in request.body && !await validEnvironment(context.project.id, request.body.defaultEnvironmentId)) return fail(reply, 400, 1001, "default environment must belong to the project");
    const b = request.body;
    /**
     * body and bodyText are nullable, so COALESCE cannot distinguish "leave
     * unchanged" from "clear it". Each is only written when the key is
     * present in the payload.
     */
    const endpoint = await writeEndpointWithVersion(context, "更新", (client) => client.query(
      `UPDATE endpoints SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         method = COALESCE($3, method),
         url = COALESCE($4, url),
         headers = COALESCE($5::jsonb, headers),
         query_params = COALESCE($6::jsonb, query_params),
         path_params = COALESCE($7::jsonb, path_params),
         body_type = COALESCE($8, body_type),
         body = CASE WHEN $9::boolean THEN $10::jsonb ELSE body END,
         body_text = CASE WHEN $11::boolean THEN $12 ELSE body_text END,
         auth = COALESCE($13::jsonb, auth),
         tags = COALESCE($14, tags),
         default_environment_id = CASE WHEN $15::boolean THEN $16 ELSE default_environment_id END,
         updated_by = $19,
         updated_at = now()
       WHERE id = $17 AND project_id = $18 RETURNING *`,
      [
        b.name?.trim() || null,
        b.description ?? null,
        b.method?.toUpperCase() || null,
        b.url?.trim() || null,
        b.headers ? JSON.stringify(b.headers) : null,
        b.queryParams ? JSON.stringify(b.queryParams) : null,
        b.pathParams ? JSON.stringify(b.pathParams) : null,
        b.bodyType ?? null,
        "body" in b, b.body === undefined ? null : JSON.stringify(b.body),
        "bodyText" in b, b.bodyText ?? null,
         b.auth ? JSON.stringify(b.auth) : null,
         b.tags ?? null,
         "defaultEnvironmentId" in b, b.defaultEnvironmentId ?? null,
         request.params.endpointId, context.project.id,
         context.user.id,
      ],
    ));
    if (!endpoint) return fail(reply, 404, 2001, "endpoint not found");
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.endpointUpdate, targetType: "endpoint", targetId: request.params.endpointId,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return success(endpoint);
  });

  /**
   * Copies an endpoint inside its project.
   *
   * Server-side rather than a client read-then-create, so the copy carries every
   * stored column even if the client's type is behind, and so it cannot produce
   * a half-populated endpoint when the second request fails.
   */
  app.post<{ Params: { id: string; endpointId: string }; Body: { name?: string } }>("/api/v1/projects/:id/endpoints/:endpointId/duplicate", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.endpointId)) return fail(reply, 404, 2001, "endpoint not found");

    const source = await pool.query("SELECT name FROM endpoints WHERE id = $1 AND project_id = $2", [request.params.endpointId, context.project.id]);
    if (!source.rowCount) return fail(reply, 404, 2001, "endpoint not found");

    /* Names are not unique, but a list full of identical names is unusable, so
       the copy gets a numeric suffix until it reads as distinct. */
    const requested = request.body?.name?.trim() || `${String(source.rows[0].name)} copy`;
    const taken = await pool.query("SELECT name FROM endpoints WHERE project_id = $1 AND name LIKE $2", [context.project.id, `${requested}%`]);
    const names = new Set(taken.rows.map((row) => String(row.name)));
    let name = requested;
    for (let index = 2; names.has(name); index += 1) name = `${requested} ${index}`;

    /* 复制也是创建：副本落一版首快照（changeSummary 记"复制"，与手工建区分）。 */
    const endpoint = await writeEndpointWithVersion(context, "复制", (client) => client.query(
      `INSERT INTO endpoints (id, project_id, ${WRITE_COLUMNS})
       SELECT $1, project_id, $2, description, method, url, headers, query_params, path_params, body_type, body, body_text, auth, tags, default_environment_id, $5
       FROM endpoints WHERE id = $3 AND project_id = $4 RETURNING *`,
      [randomUUID(), name, request.params.endpointId, context.project.id, context.user.id],
    ));
    if (!endpoint) return fail(reply, 404, 2001, "endpoint not found");
    /* 复制也是创建：动作与普通 create 同一行，detail 记来源（动作证据）与请求体字段名。 */
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.endpointCreate, targetType: "endpoint", targetId: endpoint.id,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body), duplicatedFrom: request.params.endpointId }, ip: request.ip,
    });
    return reply.code(201).send(success(endpoint));
  });

  app.delete<{ Params: { id: string; endpointId: string } }>("/api/v1/projects/:id/endpoints/:endpointId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.endpointId)) return fail(reply, 404, 2001, "endpoint not found");
    const result = await pool.query("DELETE FROM endpoints WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.endpointId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "endpoint not found");
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.endpointDelete, targetType: "endpoint", targetId: String(result.rows[0].id),
      projectId: context.project.id, userId: context.user.id, ip: request.ip,
    });
    return success({ id: result.rows[0].id });
  });

  app.post<{ Params: { id: string }; Body: { endpointIds?: string[] } }>("/api/v1/projects/:id/endpoints/batch-delete", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const endpointIds = [...new Set(request.body?.endpointIds ?? [])];
    if (!endpointIds.length) return fail(reply, 400, 1001, "at least one endpoint is required");
    if (endpointIds.length > 100 || endpointIds.some((id) => !isUuid(id))) return fail(reply, 400, 1001, "endpointIds must contain at most 100 UUIDs");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query("SELECT id FROM endpoints WHERE project_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE", [context.project.id, endpointIds]);
      if (owned.rowCount !== endpointIds.length) {
        await client.query("ROLLBACK");
        return fail(reply, 400, 1001, "all endpoints must belong to the project");
      }
      const deleted = await client.query("DELETE FROM endpoints WHERE project_id = $1 AND id = ANY($2::uuid[]) RETURNING id", [context.project.id, endpointIds]);
      await client.query("COMMIT");
      /* 批量删除落**一行**（边界 6）：target_id 没有单一落点（UUID 列），数量进 detail。 */
      const detail: AuditBatchDetail = { ids: deleted.rowCount ?? 0 };
      writeAuditLogAsync({
        action: AUDIT_ACTIONS.endpointDelete, targetType: "endpoint", targetId: null,
        projectId: context.project.id, userId: context.user.id,
        detail, ip: request.ip,
      });
      return success({ ids: deleted.rows.map((row) => String(row.id)), deleted: deleted.rowCount });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  /**
   * 接口调试. Queues the run and returns the record immediately (P1-3).
   *
   * `202` rather than `200`: the body is a run that has been accepted, not a
   * result. Callers follow it on the SSE stream or by re-reading the execution.
   */
  app.post<{ Params: { id: string; endpointId: string }; Body: { environmentId?: string | null } }>("/api/v1/projects/:id/endpoints/:endpointId/execute", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.endpointId)) return fail(reply, 404, 2001, "endpoint not found");
    const body = request.body ?? {};
    const explicitEnvironment = Object.prototype.hasOwnProperty.call(body, "environmentId");
    let executionId: string;
    try { executionId = await queueEndpointRun(context.project.id, request.params.endpointId, body.environmentId, explicitEnvironment, undefined, context.user.id); }
    catch (error) {
      /* 分区没有执行器是基础设施问题，不是坏输入：2004 + label，让界面说清是哪个分区
         没人服务，而不是笼统的「请求无法准备」。 */
      if (error instanceof NoRunnerError) return failNoRunner(reply, error.label, error.message);
      return fail(reply, 400, 2002, error instanceof Error ? error.message : "request could not be prepared");
    }
    const result = await pool.query("SELECT * FROM executions WHERE id = $1", [executionId]);
    return reply.code(202).send(success(mapExecution(result.rows[0])));
  });

  /**
   * 批量调试. Queues every selected endpoint and returns at once (P1-3).
   *
   * Previously this held the HTTP connection until all of them had run — up to
   * ten minutes for a full batch, which any reverse proxy would cut short while
   * the work carried on unseen. Now the batch is a record the client follows.
   */
  app.post<{ Params: { id: string }; Body: { endpointIds?: string[]; environmentStrategy?: "endpoint_default" | "override"; environmentId?: string | null } }>("/api/v1/projects/:id/endpoints/batch-debug", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const endpointIds = [...new Set(request.body?.endpointIds ?? [])];
    if (!endpointIds.length) return fail(reply, 400, 1001, "at least one endpoint is required");
    if (endpointIds.length > 100 || endpointIds.some((id) => !isUuid(id))) return fail(reply, 400, 1001, "endpointIds must contain at most 100 UUIDs");

    const body = request.body ?? {};
    const strategy = body.environmentStrategy ?? "endpoint_default";
    if (!['endpoint_default', 'override'].includes(strategy)) return fail(reply, 400, 1001, "invalid environment strategy");
    if (strategy === "override" && !await validEnvironment(context.project.id, body.environmentId)) return fail(reply, 400, 1001, "environment must belong to the project");

    const endpointsResult = await pool.query("SELECT id FROM endpoints WHERE project_id = $1 AND id = ANY($2::uuid[])", [context.project.id, endpointIds]);
    if (endpointsResult.rowCount !== endpointIds.length) return fail(reply, 400, 1001, "all endpoints must belong to the project");

    const batchId = randomUUID();
    await pool.query(
      "INSERT INTO batch_executions (id, project_id, type, environment_strategy, override_environment_id, total, status) VALUES ($1, $2, 'endpoint_debug', $3, $4, $5, 'queued')",
      [batchId, context.project.id, strategy, strategy === "override" ? body.environmentId ?? null : null, endpointIds.length],
    );

    /**
     * Sequential on purpose: this loop only writes rows and pushes jobs, so
     * concurrency here would buy nothing. The concurrency that matters is the
     * worker's, and it now applies across the whole system rather than being
     * hardcoded per batch.
     */
    for (const endpointId of endpointIds) {
      try {
        await queueEndpointRun(context.project.id, endpointId, strategy === "override" ? body.environmentId ?? null : undefined, strategy === "override", batchId, context.user.id);
      } catch (error) {
        /* Queue down mid-batch: stop rather than leave the rest unqueued and
           the batch permanently short of its total. 分区没有执行器同理——先把已经
           入队的取消掉，再据实回报是哪个分区没人服务。 */
        await cancelBatch(context.project.id, batchId);
        if (error instanceof NoRunnerError) return failNoRunner(reply, error.label, error.message);
        return fail(reply, 503, 5001, error instanceof Error ? error.message : "execution queue unavailable");
      }
    }

    const batch = await pool.query("SELECT * FROM batch_executions WHERE id = $1", [batchId]);
    return reply.code(202).send(success(mapBatchExecution(batch.rows[0])));
  });

  /**
   * Cancels one run.
   *
   * Queued runs never start; a run already in flight has its request aborted in
   * whichever worker holds it. A run that already finished is a conflict, not a
   * silent no-op — the user needs to know the result they see is real.
   */
  app.post<{ Params: { id: string; executionId: string } }>("/api/v1/projects/:id/executions/:executionId/cancel", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.executionId)) return fail(reply, 404, 2001, "execution not found");
    if (!await cancelRun(context.project.id, request.params.executionId)) {
      const existing = await pool.query("SELECT id FROM executions WHERE id = $1 AND project_id = $2", [request.params.executionId, context.project.id]);
      if (!existing.rowCount) return fail(reply, 404, 2001, "execution not found");
      return fail(reply, 409, 2004, "execution already finished");
    }
    const result = await pool.query("SELECT * FROM executions WHERE id = $1", [request.params.executionId]);
    return success(mapExecution(result.rows[0]));
  });

  app.post<{ Params: { id: string; batchId: string } }>("/api/v1/projects/:id/batch-executions/:batchId/cancel", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.batchId)) return fail(reply, 404, 2001, "batch execution not found");
    const batch = await pool.query("SELECT id FROM batch_executions WHERE id = $1 AND project_id = $2", [request.params.batchId, context.project.id]);
    if (!batch.rowCount) return fail(reply, 404, 2001, "batch execution not found");
    const canceled = await cancelBatch(context.project.id, request.params.batchId);
    const result = await pool.query("SELECT * FROM batch_executions WHERE id = $1", [request.params.batchId]);
    return success({ ...mapBatchExecution(result.rows[0]), canceled });
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/batch-executions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    /* 时间窗与 executions / execution-index 两份清单同款（P8-6 验收反馈：执行记录
       页三个大类都要有按时间范围筛选）。 */
    const range = readTimeRange(request.query, reply);
    if (!range) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id];
    const clauses = ["project_id = $1"];
    if (range.from) { params.push(range.from); clauses.push(`created_at >= $${params.length}`); }
    if (range.to) { params.push(range.to); clauses.push(`created_at <= $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM batch_executions WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    /* P11 边界 11：批量没有自己的触发行人列（迁移 064 只给 executions 加了
       triggered_by），但一次批量里每一行 execution 的触发人必然相同——从成员行派生
       一列即可，不必再加列加索引。用标量子查询而不是 join：这条 WHERE 的列都没带前缀，
       join users 会让 created_at 变成 ambiguous。 */
    const result = await pool.query(
      `SELECT *, (SELECT u.email FROM executions e JOIN users u ON u.id = e.triggered_by
                   WHERE e.batch_id = batch_executions.id LIMIT 1) AS triggered_by_email
         FROM batch_executions WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return success(result.rows.map(mapBatchExecution), { page, pageSize, total: Number(count.rows[0].total) });
  });

  app.get<{ Params: { id: string; batchId: string } }>("/api/v1/projects/:id/batch-executions/:batchId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.batchId)) return fail(reply, 404, 2001, "batch execution not found");
    /* 同列表：批量本身没有触发行人列，从成员行派生（见 batch-executions 列表注释）。 */
    const batchResult = await pool.query(
      `SELECT *, (SELECT u.email FROM executions e JOIN users u ON u.id = e.triggered_by
                   WHERE e.batch_id = batch_executions.id LIMIT 1) AS triggered_by_email
         FROM batch_executions WHERE id = $1 AND project_id = $2`,
      [request.params.batchId, context.project.id],
    );
    if (!batchResult.rowCount) return fail(reply, 404, 2001, "batch execution not found");
    /* Ordered by created_at, which is enqueue order, so the list keeps the
       order the user selected rather than the order workers happened to finish. */
    const executions = await pool.query("SELECT * FROM executions WHERE batch_id = $1 ORDER BY created_at", [request.params.batchId]);
    const row = batchResult.rows[0];
    return success({
      ...mapBatchExecution(row),
      items: [
        ...executions.rows.map((execution) => ({ endpointId: String(execution.endpoint_id), endpointName: String(execution.endpoint_name), execution: mapExecution(execution) })),
        /* Kept for batches recorded before P1-3, when a定义 that could not be
           prepared produced no execution row at all. */
        ...((row.error_items ?? []) as { endpointId: string; endpointName: string; error: string }[]),
      ],
    });
  });

  /**
   * One execution. The reconnect path for the SSE stream: a client that missed
   * events while disconnected re-reads the run instead of guessing.
   */
  app.get<{ Params: { id: string; executionId: string } }>("/api/v1/projects/:id/executions/:executionId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.executionId)) return fail(reply, 404, 2001, "execution not found");
    const result = await pool.query(
      /* P11 边界 11：单条执行也要答「谁触发的」。基表起别名，裸 `*` 会在两表同名的
         id / created_at 上取到 users 的值。 */
      `SELECT ex.*, triggerer.email AS triggered_by_email
         FROM executions ex
         LEFT JOIN users triggerer ON triggerer.id = ex.triggered_by
        WHERE ex.id = $1 AND ex.project_id = $2`,
      [request.params.executionId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "execution not found");
    return success(mapExecution(result.rows[0]));
  });

  /**
   * 完整响应体的下载直链（P10-1，计划 14.1）：`response_body_object_key` 有值的执行，
   * 详情页的「下载完整响应」来这里换一条短活 presignGet 直链（fs 5 分钟，与产物列表
   * 同款），浏览器随后直接打对象存储 / fs 直链端点——**平台不代理大流**（边界 14）。
   *
   * 直链按需签而不是随执行详情下发：详情被列表、分享、MCP 多处复用，行行都签等于给
   * 每次列表多一次 HMAC / S3 签名，还会把短活 URL 泄进公开分享载荷。
   */
  app.get<{ Params: { id: string; executionId: string } }>("/api/v1/projects/:id/executions/:executionId/response-body", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.executionId)) return fail(reply, 404, 2001, "execution not found");
    const result = await pool.query(
      "SELECT response_body_object_key, response_body_storage_driver FROM executions WHERE id = $1 AND project_id = $2",
      [request.params.executionId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "execution not found");
    const row = result.rows[0];
    if (!row.response_body_object_key) return fail(reply, 404, 2001, "this execution has no full response body stored");
    /* 行上记的驱动与当前部署不一致（迁移 / 换驱动之后）：对象还在旧驱动里，新驱动签出的
       直链必然 404。按「不存在」回答，而不是签一条打不开的链接。 */
    if (String(row.response_body_storage_driver) !== storageDriverName()) {
      return fail(reply, 404, 2001, "the full response body was stored with a different storage driver and is no longer reachable");
    }
    const store = await getSharedObjectStore(requestBaseUrl(request));
    const downloadUrl = await store.presignGet(String(row.response_body_object_key), {
      expiresSeconds: 300,
      /* 文件名对齐分享 / 产物的净化规则（非安全边界，只防奇怪的响应头值）。 */
      downloadName: `response-${request.params.executionId}.txt`,
    });
    return success({ downloadUrl, expiresIn: 300 });
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string; endpointId?: string; source?: string; caseId?: string; from?: string; to?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/executions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["project_id = $1"];
    /* 时间窗（P8-4，下钻前置）：趋势图点击跳转列表时带 from/to。ISO 时间戳解析失败
       400 而不是静默丢弃——用户点的是「这一天的失败」，静默丢窗会给他全量历史。 */
    const range = readTimeRange(request.query, reply);
    if (!range) return;
    if (range.from) { params.push(range.from); clauses.push(`created_at >= $${params.length}`); }
    if (range.to) { params.push(range.to); clauses.push(`created_at <= $${params.length}`); }
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`status = $${params.length}`); }
    /* A non-uuid would abort the whole query, so ignore anything malformed. */
    if (isUuid(request.query.endpointId)) { params.push(request.query.endpointId); clauses.push(`endpoint_id = $${params.length}`); }
    /* Since 5.0.9 flow runs are their own category on this page, so the plain
       project record excludes flow steps unless one is explicitly asked for —
       otherwise every flow run would also scatter its steps into 单接口记录. */
    if (SOURCE_FILTERS.includes(request.query.source ?? "")) { params.push(request.query.source); clauses.push(`source = $${params.length}`); }
    else { clauses.push("source <> 'flow_step'"); }
    if (isUuid(request.query.caseId)) { params.push(request.query.caseId); clauses.push(`case_id = $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM executions WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    /* flow_name is joined in so project records can mark a step as 流程执行 (5.0.9).
       Both tables carry project_id, so the joined query qualifies every clause. */
    const qualifiedWhere = clauses.map((clause) => `executions.${clause}`).join(" AND ");
    const result = await pool.query(
      `SELECT executions.*, flow_executions.flow_name AS flow_name,
              triggerer.email AS triggered_by_email
         FROM executions
         LEFT JOIN flow_executions ON flow_executions.id = executions.flow_execution_id
         /* P11 边界 11：谁触发的（email 快照）。只在 users 上 join，别名独立于上面的
            两条 join；WHERE 已经逐条以 executions. 限定，不会与 users 的同名列撞。 */
         LEFT JOIN users triggerer ON triggerer.id = executions.triggered_by
        WHERE ${qualifiedWhere} ORDER BY executions.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return success(result.rows.map(mapExecution), { page, pageSize, total: Number(count.rows[0].total) });
  });

  app.post<{ Params: { id: string }; Body: { endpoints?: ImportItem[]; conflictStrategy?: "update" | "skip" | "create" } }>("/api/v1/projects/:id/endpoints/import", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const items = request.body.endpoints ?? [];
    const strategy = request.body.conflictStrategy ?? "skip";
    const imported: Endpoint[] = []; const updated: Endpoint[] = []; const skipped: string[] = [];

    for (const item of items) {
      if (validateEndpoint(item)) continue;
      const existing = await pool.query("SELECT id FROM endpoints WHERE project_id = $1 AND method = $2 AND url = $3 LIMIT 1", [context.project.id, item.method!.toUpperCase(), item.url!.trim()]);

      if (existing.rowCount && strategy === "skip") { skipped.push(`${item.method!.toUpperCase()} ${item.url}`); continue; }

      if (existing.rowCount && strategy === "update") {
        const result = await pool.query(
          `UPDATE endpoints SET name = $1, description = $2, headers = $3::jsonb, query_params = $4::jsonb, path_params = $5::jsonb, body_type = $6, body = $7::jsonb, body_text = $8, auth = $9::jsonb, tags = $10, updated_by = $12, updated_at = now() WHERE id = $11 RETURNING *`,
          [
            item.name!.trim(), item.description?.trim() ?? "",
            JSON.stringify(item.headers ?? {}), JSON.stringify(item.queryParams ?? {}), JSON.stringify(item.pathParams ?? {}),
            item.bodyType ?? (item.body === undefined ? "none" : "json"),
            item.body === undefined ? null : JSON.stringify(item.body), item.bodyText ?? null,
            JSON.stringify(item.auth ?? { type: "none" }), item.tags ?? [], existing.rows[0].id,
            context.user.id,
          ],
        );
        updated.push(mapEndpoint(result.rows[0]));
        /* 导入按条目挂审计（每条资源一行，P11-10 的资源「变更历史」才拉得到）。 */
        writeAuditLogAsync({
          action: AUDIT_ACTIONS.endpointUpdate, targetType: "endpoint", targetId: String(result.rows[0].id),
          projectId: context.project.id, userId: context.user.id,
          detail: { fields: auditFields(item) }, ip: request.ip,
        });
        continue;
      }

      const result = await pool.query(
        `INSERT INTO endpoints (id, project_id, ${WRITE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14, $15, $16) RETURNING *`,
        [randomUUID(), context.project.id, ...writeValues(item, context.user.id)],
      );
      imported.push(mapEndpoint(result.rows[0]));
      writeAuditLogAsync({
        action: AUDIT_ACTIONS.endpointCreate, targetType: "endpoint", targetId: String(result.rows[0].id),
        projectId: context.project.id, userId: context.user.id,
        detail: { fields: auditFields(item), imported: true }, ip: request.ip,
      });
    }

    return success({ imported, updated, skipped }, { total: imported.length + updated.length });
  });
}
