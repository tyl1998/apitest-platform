import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { cancelBatch, cancelRun, enqueueRun } from "../lib/enqueue.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { BODY_TYPES, METHODS } from "../lib/run.js";
import { isUuid } from "../lib/uuid.js";
import { mapBatchExecution, mapEndpoint, mapExecution, type BodyType, type Endpoint, type EndpointAuth, type RequestSnapshot } from "../models/types.js";

type EndpointInput = {
  name?: string;
  description?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  pathParams?: Record<string, string>;
  bodyType?: BodyType;
  body?: unknown;
  bodyText?: string;
  auth?: EndpointAuth;
  tags?: string[];
  defaultEnvironmentId?: string | null;
};
type ImportItem = EndpointInput;

/** Column list shared by insert and import so the two cannot drift apart. */
const WRITE_COLUMNS = "name, description, method, url, headers, query_params, path_params, body_type, body, body_text, auth, tags, default_environment_id";

function writeValues(input: EndpointInput) {
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
  ];
}

/**
 * Execution sources a client may filter by (来源 filter, 交互文档 3.8).
 *
 * `flow_step` is included since 5.0.9: project-wide records mark flow steps
 * as 流程执行, so the source filter must be able to narrow to them.
 */
const SOURCE_FILTERS = ["endpoint_debug", "test_case", "flow_step"];

async function validEnvironment(projectId: string, environmentId: string | null | undefined) {
  if (!environmentId || !isUuid(environmentId)) return !environmentId;
  const result = await pool.query("SELECT 1 FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  return Boolean(result.rowCount);
}

function validate(input: EndpointInput, partial = false): string | undefined {
  if (!partial || input.name !== undefined) if (!input.name?.trim()) return "name is required";
  if (!partial || input.method !== undefined) {
    if (!input.method) return "method is required";
    if (!METHODS.includes(input.method.toUpperCase())) return `method must be one of ${METHODS.join(", ")}`;
  }
  if (!partial || input.url !== undefined) {
    if (!input.url?.trim()) return "url is required";
    /* Variables are resolved at run time, so only validate literal URLs here. */
    if (!input.url.includes("{{") && !/^https?:\/\//i.test(input.url.trim())) return "url must start with http:// or https://";
  }
  if (input.bodyType !== undefined && !BODY_TYPES.includes(input.bodyType)) return `bodyType must be one of ${BODY_TYPES.join(", ")}`;
  return undefined;
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
 */
async function queueEndpointRun(projectId: string, endpointId: string, requestedEnvironmentId: string | null | undefined, explicitEnvironment: boolean, batchId?: string): Promise<string> {
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
  });
}

export async function endpointRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; method?: string; environmentId?: string } }>("/api/v1/projects/:id/endpoints", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const params: unknown[] = [context.project.id]; const clauses = ["project_id = $1"];
    /* Server-side filtering, so a keyword matches every endpoint, not just the loaded page. */
    const keyword = request.query.keyword?.trim();
    if (keyword) { params.push(`%${keyword}%`); clauses.push(`(name ILIKE $${params.length} OR url ILIKE $${params.length} OR description ILIKE $${params.length})`); }
    if (request.query.method && request.query.method !== "all") { params.push(request.query.method.toUpperCase()); clauses.push(`method = $${params.length}`); }
    if (request.query.environmentId === "unset") clauses.push("default_environment_id IS NULL");
    else if (request.query.environmentId) {
      if (!isUuid(request.query.environmentId)) return fail(reply, 400, 1001, "environmentId must be a UUID or unset");
      if (!await validEnvironment(context.project.id, request.query.environmentId)) return fail(reply, 400, 1001, "environment must belong to the project");
      params.push(request.query.environmentId); clauses.push(`default_environment_id = $${params.length}`);
    }
    const result = await pool.query(
      `SELECT endpoints.*, COALESCE(cases.total, 0) AS case_count
         FROM endpoints
         /* Sub-select, not a join onto test_cases: joining would multiply the
            endpoint row per case and inflate anything else aggregated here. */
         LEFT JOIN (SELECT endpoint_id, COUNT(*)::int AS total FROM test_cases GROUP BY endpoint_id) AS cases
           ON cases.endpoint_id = endpoints.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY endpoints.created_at DESC`,
      params,
    );
    /* caseCount is a real number now that用例 exist (P1); 0 truthfully means
       "this endpoint has no cases yet". */
    const data = result.rows.map((row) => ({ ...mapEndpoint(row), caseCount: Number(row.case_count) }));
    return success(data, { total: data.length });
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
    const invalid = validate(request.body);
    if (invalid) return fail(reply, 400, 1001, invalid);
    if (!await validEnvironment(context.project.id, request.body.defaultEnvironmentId)) return fail(reply, 400, 1001, "default environment must belong to the project");
    const result = await pool.query(
      `INSERT INTO endpoints (id, project_id, ${WRITE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14, $15) RETURNING *`,
      [randomUUID(), context.project.id, ...writeValues(request.body)],
    );
    return reply.code(201).send(success(mapEndpoint(result.rows[0])));
  });

  app.patch<{ Params: { id: string; endpointId: string }; Body: EndpointInput }>("/api/v1/projects/:id/endpoints/:endpointId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.endpointId)) return fail(reply, 404, 2001, "endpoint not found");
    const invalid = validate(request.body, true);
    if (invalid) return fail(reply, 400, 1001, invalid);
    if ("defaultEnvironmentId" in request.body && !await validEnvironment(context.project.id, request.body.defaultEnvironmentId)) return fail(reply, 400, 1001, "default environment must belong to the project");
    const b = request.body;
    /**
     * body and bodyText are nullable, so COALESCE cannot distinguish "leave
     * unchanged" from "clear it". Each is only written when the key is
     * present in the payload.
     */
    const result = await pool.query(
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
      ],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "endpoint not found");
    return success(mapEndpoint(result.rows[0]));
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

    const result = await pool.query(
      `INSERT INTO endpoints (id, project_id, ${WRITE_COLUMNS})
       SELECT $1, project_id, $2, description, method, url, headers, query_params, path_params, body_type, body, body_text, auth, tags, default_environment_id
       FROM endpoints WHERE id = $3 AND project_id = $4 RETURNING *`,
      [randomUUID(), name, request.params.endpointId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "endpoint not found");
    return reply.code(201).send(success(mapEndpoint(result.rows[0])));
  });

  app.delete<{ Params: { id: string; endpointId: string } }>("/api/v1/projects/:id/endpoints/:endpointId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.endpointId)) return fail(reply, 404, 2001, "endpoint not found");
    const result = await pool.query("DELETE FROM endpoints WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.endpointId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "endpoint not found");
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
    try { executionId = await queueEndpointRun(context.project.id, request.params.endpointId, body.environmentId, explicitEnvironment); }
    catch (error) { return fail(reply, 400, 2002, error instanceof Error ? error.message : "request could not be prepared"); }
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
        await queueEndpointRun(context.project.id, endpointId, strategy === "override" ? body.environmentId ?? null : undefined, strategy === "override", batchId);
      } catch (error) {
        /* Queue down mid-batch: stop rather than leave the rest unqueued and
           the batch permanently short of its total. */
        await cancelBatch(context.project.id, batchId);
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

  app.get<{ Params: { id: string }; Querystring: { page?: string; pageSize?: string } }>("/api/v1/projects/:id/batch-executions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const count = await pool.query("SELECT COUNT(*)::int AS total FROM batch_executions WHERE project_id = $1", [context.project.id]);
    const result = await pool.query(
      "SELECT * FROM batch_executions WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
      [context.project.id, pageSize, (page - 1) * pageSize],
    );
    return success(result.rows.map(mapBatchExecution), { page, pageSize, total: Number(count.rows[0].total) });
  });

  app.get<{ Params: { id: string; batchId: string } }>("/api/v1/projects/:id/batch-executions/:batchId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.batchId)) return fail(reply, 404, 2001, "batch execution not found");
    const batchResult = await pool.query("SELECT * FROM batch_executions WHERE id = $1 AND project_id = $2", [request.params.batchId, context.project.id]);
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
    const result = await pool.query("SELECT * FROM executions WHERE id = $1 AND project_id = $2", [request.params.executionId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "execution not found");
    return success(mapExecution(result.rows[0]));
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string; endpointId?: string; source?: string; caseId?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/executions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["project_id = $1"];
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
      `SELECT executions.*, flow_executions.flow_name AS flow_name
         FROM executions
         LEFT JOIN flow_executions ON flow_executions.id = executions.flow_execution_id
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
      if (validate(item)) continue;
      const existing = await pool.query("SELECT id FROM endpoints WHERE project_id = $1 AND method = $2 AND url = $3 LIMIT 1", [context.project.id, item.method!.toUpperCase(), item.url!.trim()]);

      if (existing.rowCount && strategy === "skip") { skipped.push(`${item.method!.toUpperCase()} ${item.url}`); continue; }

      if (existing.rowCount && strategy === "update") {
        const result = await pool.query(
          `UPDATE endpoints SET name = $1, description = $2, headers = $3::jsonb, query_params = $4::jsonb, path_params = $5::jsonb, body_type = $6, body = $7::jsonb, body_text = $8, auth = $9::jsonb, tags = $10, updated_at = now() WHERE id = $11 RETURNING *`,
          [
            item.name!.trim(), item.description?.trim() ?? "",
            JSON.stringify(item.headers ?? {}), JSON.stringify(item.queryParams ?? {}), JSON.stringify(item.pathParams ?? {}),
            item.bodyType ?? (item.body === undefined ? "none" : "json"),
            item.body === undefined ? null : JSON.stringify(item.body), item.bodyText ?? null,
            JSON.stringify(item.auth ?? { type: "none" }), item.tags ?? [], existing.rows[0].id,
          ],
        );
        updated.push(mapEndpoint(result.rows[0]));
        continue;
      }

      const result = await pool.query(
        `INSERT INTO endpoints (id, project_id, ${WRITE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14, $15) RETURNING *`,
        [randomUUID(), context.project.id, ...writeValues(item)],
      );
      imported.push(mapEndpoint(result.rows[0]));
    }

    return success({ imported, updated, skipped }, { total: imported.length + updated.length });
  });
}
