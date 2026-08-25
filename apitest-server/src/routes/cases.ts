import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { evaluateAssertions, validateDeclarativeAssertions } from "../lib/assert.js";
import { enqueueRun } from "../lib/enqueue.js";
import { validateExtracts, validateHooks, validateResponseScripts } from "../lib/flow.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { BODY_TYPES, METHODS } from "../lib/run.js";
import { isUuid } from "../lib/uuid.js";
import { persistCaseLifecycleScripts } from "../lib/scripts.js";
import { mapExecution, mapTestCase, mapTestCaseSummary, type Assertion, type FlowExtract, type HookConfig, type RequestSnapshot, type ResponseScriptConfig, type TestCase } from "../models/types.js";

type CaseInput = {
  name?: string;
  description?: string;
  environmentId?: string | null;
  request?: Partial<RequestSnapshot>;
  assertions?: Assertion[];
  preRequestHooks?: HookConfig[];
  extracts?: FlowExtract[];
  responseScripts?: ResponseScriptConfig[];
  tags?: string[];
};

function validate(input: CaseInput, partial = false): string | undefined {
  if (!partial || input.name !== undefined) if (!input.name?.trim()) return "name is required";
  if (!partial || input.request !== undefined) {
    const request = input.request;
    if (!request) return "request is required";
    if (!request.method || !METHODS.includes(request.method.toUpperCase())) return `request.method must be one of ${METHODS.join(", ")}`;
    if (!request.url?.trim()) return "request.url is required";
    /* Variables are resolved at run time, so only validate literal URLs here. */
    if (!request.url.includes("{{") && !/^https?:\/\//i.test(request.url.trim())) return "request.url must start with http:// or https://";
    if (request.bodyType !== undefined && !BODY_TYPES.includes(request.bodyType)) return `request.bodyType must be one of ${BODY_TYPES.join(", ")}`;
  }
  return validateDeclarativeAssertions(input.assertions)
    ?? validateHooks(input.preRequestHooks, "case")
    ?? validateExtracts(input.extracts, "case")
    ?? validateResponseScripts(input.responseScripts, "case");
}

/** Fills in what the client may omit, so a stored snapshot is always complete. */
function toSnapshot(request: Partial<RequestSnapshot>): RequestSnapshot {
  return {
    method: request.method!.toUpperCase(),
    url: request.url!.trim(),
    headers: request.headers ?? {},
    queryParams: request.queryParams ?? {},
    pathParams: request.pathParams ?? {},
    bodyType: request.bodyType ?? (request.body === undefined ? "none" : "json"),
    body: request.body,
    bodyText: request.bodyText,
    auth: request.auth ?? { type: "none" },
  };
}

async function environmentName(projectId: string, environmentId: string | null | undefined) {
  if (!environmentId) return null;
  const result = await pool.query("SELECT name FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  return result.rowCount ? String(result.rows[0].name) : undefined;
}

/** The most recent run of each of these cases, for the用例 list's「最近结果」. */
async function latestRuns(caseIds: string[]) {
  if (!caseIds.length) return new Map<string, ReturnType<typeof mapExecution>>();
  const result = await pool.query(
    `SELECT DISTINCT ON (case_id) * FROM executions
      WHERE case_id = ANY($1::uuid[]) ORDER BY case_id, created_at DESC`,
    [caseIds],
  );
  return new Map(result.rows.map((row) => [String(row.case_id), mapExecution(row)]));
}

type CaseWithRun = TestCase & { lastRun?: ReturnType<typeof mapExecution> };

async function withLastRun(cases: TestCase[]): Promise<CaseWithRun[]> {
  const runs = await latestRuns(cases.map((item) => item.id));
  return cases.map((item) => ({ ...item, lastRun: runs.get(item.id) }));
}

export async function caseRoutes(app: FastifyInstance) {
  /* 用例 live inside the endpoint workbench (交互文档 3.1.3), so every route is
     project-scoped: `requireProjectAccess` reads `:id` and nothing else. */
  app.get<{ Params: { id: string; endpointId: string } }>("/api/v1/projects/:id/endpoints/:endpointId/cases", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.endpointId)) return fail(reply, 404, 2001, "endpoint not found");
    const result = await pool.query(
      "SELECT * FROM test_cases WHERE project_id = $1 AND endpoint_id = $2 ORDER BY created_at DESC",
      [context.project.id, request.params.endpointId],
    );
    const data = await withLastRun(result.rows.map(mapTestCase));
    return success(data, { total: data.length });
  });

  /**
   * Cross-endpoint case search, for the跨接口用例选择器 that测试套件 uses
   * (交互文档 3.1.3). It is a project-level read, not a second navigation page.
   *
   * Paged and summary-only (P2-4): a project with hundreds of cases would
   * otherwise ship every request body and assertion set to render a picker.
   * Grouping is by endpoint, so the sort leads with the endpoint name — a
   * `created_at DESC` order would scatter one endpoint's cases across pages.
   */
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; tag?: string; endpointId?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/cases", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["c.project_id = $1"];
    const keyword = request.query.keyword?.trim();
    /* Filtering in SQL so a keyword matches every case, not just a loaded page. */
    if (keyword) { params.push(`%${keyword}%`); clauses.push(`(c.name ILIKE $${params.length} OR c.description ILIKE $${params.length})`); }
    if (request.query.tag?.trim()) { params.push(request.query.tag.trim()); clauses.push(`$${params.length} = ANY(c.tags)`); }
    if (request.query.endpointId) {
      if (!isUuid(request.query.endpointId)) return fail(reply, 400, 1001, "endpointId must be a UUID");
      params.push(request.query.endpointId); clauses.push(`c.endpoint_id = $${params.length}`);
    }
    const where = clauses.join(" AND ");
    /* INNER JOIN is safe: endpoint_id is NOT NULL and ON DELETE CASCADE, so a
       case cannot outlive its endpoint. */
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM test_cases c WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(
      `SELECT c.id, c.project_id, c.endpoint_id, e.name AS endpoint_name, c.name, c.description,
              c.environment_id, c.environment_name, c.tags, c.created_at, c.updated_at,
              /* 脚本断言在 P2-2.1 已下线，mapTestCase 也把它们过滤掉；这里同样只数
                 声明式校验，否则选择器上的条数会和编辑器里看到的不一致。 */
              (SELECT COUNT(*)::int FROM jsonb_array_elements(c.assertions) item WHERE item->>'type' <> 'script') AS assertion_count
         FROM test_cases c
         JOIN endpoints e ON e.id = c.endpoint_id
        WHERE ${where}
        ORDER BY e.name, c.name, c.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const summaries = result.rows.map(mapTestCaseSummary);
    const runs = await latestRuns(summaries.map((item) => item.id));
    const data = summaries.map((item) => ({ ...item, lastRun: runs.get(item.id) }));
    return success(data, { page, pageSize, total: Number(count.rows[0].total) });
  });

  app.get<{ Params: { id: string; caseId: string } }>("/api/v1/projects/:id/cases/:caseId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "case not found");
    const result = await pool.query("SELECT * FROM test_cases WHERE id = $1 AND project_id = $2", [request.params.caseId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "case not found");
    return success(mapTestCase(result.rows[0]));
  });

  app.get<{ Params: { id: string; caseId: string }; Querystring: { status?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/cases/:caseId/executions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "case not found");
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id, request.params.caseId]; const clauses = ["project_id = $1", "case_id = $2"];
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`status = $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM executions WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(`SELECT * FROM executions WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return success(result.rows.map(mapExecution), { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 保存为用例: freezes the request as sent plus the environment and assertions.
   *
   * The snapshot is copied, never referenced, so later edits to the endpoint
   * leave this case running exactly what was saved (交互文档 3.1.3 快照隔离).
   */
  app.post<{ Params: { id: string; endpointId: string }; Body: CaseInput }>("/api/v1/projects/:id/endpoints/:endpointId/cases", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.endpointId)) return fail(reply, 404, 2001, "endpoint not found");
    const endpoint = await pool.query("SELECT id FROM endpoints WHERE id = $1 AND project_id = $2", [request.params.endpointId, context.project.id]);
    if (!endpoint.rowCount) return fail(reply, 404, 2001, "endpoint not found");

    const invalid = validate(request.body);
    if (invalid) return fail(reply, 400, 1001, invalid);
    const name = await environmentName(context.project.id, request.body.environmentId);
    if (name === undefined) return fail(reply, 400, 1001, "environment must belong to the project");

    /**
     * One transaction for the case and its scripts (计划 4.0.1).
     *
     * The case row goes in first because an anonymous script needs a
     * `owner_case_id` to point at, then the normalized assertions — ids only, no
     * bodies — are written back. Both land together or neither does, so a failed
     * save cannot leave a script with no case or a case referencing a script
     * that was never written.
     */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const caseId = randomUUID();
      await client.query(
        `INSERT INTO test_cases (id, project_id, endpoint_id, environment_id, environment_name, name, description, request_snapshot, assertions, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb, $9) RETURNING *`,
        [
          caseId, context.project.id, request.params.endpointId,
          request.body.environmentId ?? null, name,
          request.body.name!.trim(), request.body.description?.trim() ?? "",
          JSON.stringify(toSnapshot(request.body.request!)), request.body.tags ?? [],
        ],
      );
      const lifecycle = await persistCaseLifecycleScripts(client, context.project.id, caseId, {
        hooks: request.body.preRequestHooks ?? [],
        responseScripts: request.body.responseScripts ?? [],
      });
      const result = await client.query(
        `UPDATE test_cases SET assertions = $1::jsonb, pre_request_hooks = $2::jsonb,
           extracts = $3::jsonb, response_scripts = $4::jsonb WHERE id = $5 RETURNING *`,
        [
          JSON.stringify(request.body.assertions ?? []), JSON.stringify(lifecycle.hooks),
          JSON.stringify(request.body.extracts ?? []), JSON.stringify(lifecycle.responseScripts), caseId,
        ],
      );
      await client.query("COMMIT");
      /* Returns the normalized assertions so the client picks up the ids it did
         not have when it built the request. */
      return reply.code(201).send(success(mapTestCase(result.rows[0])));
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "case could not be saved");
    } finally {
      client.release();
    }
  });

  app.patch<{ Params: { id: string; caseId: string }; Body: CaseInput }>("/api/v1/projects/:id/cases/:caseId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "case not found");
    const invalid = validate(request.body, true);
    if (invalid) return fail(reply, 400, 1001, invalid);

    /* environmentId is tri-state on a patch: absent keeps it, null clears it,
       a uuid moves it — so the name snapshot has to follow the same three. */
    const environmentGiven = Object.prototype.hasOwnProperty.call(request.body, "environmentId");
    let name: string | null | undefined = undefined;
    if (environmentGiven) {
      name = await environmentName(context.project.id, request.body.environmentId);
      if (name === undefined) return fail(reply, 400, 1001, "environment must belong to the project");
    }

    /* Same transaction as the create path, for the same reason: the scripts and
       the assertion list that names them must not be able to disagree. */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      /**
       * Ownership is checked before any script is written. The FK on
       * `owner_case_id` only proves the case exists, not that it belongs to this
       * project, so without this a caller could attach a script to someone
       * else's case.
       */
      const owner = await client.query(
        "SELECT id, pre_request_hooks, response_scripts FROM test_cases WHERE id = $1 AND project_id = $2 FOR UPDATE",
        [request.params.caseId, context.project.id],
      );
      if (!owner.rowCount) {
        await client.query("ROLLBACK");
        return fail(reply, 404, 2001, "case not found");
      }

      const lifecycleGiven = request.body.preRequestHooks !== undefined || request.body.responseScripts !== undefined;
      const lifecycle = lifecycleGiven ? await persistCaseLifecycleScripts(client, context.project.id, request.params.caseId, {
        hooks: request.body.preRequestHooks ?? ((owner.rows[0].pre_request_hooks ?? []) as HookConfig[]),
        responseScripts: request.body.responseScripts ?? ((owner.rows[0].response_scripts ?? []) as ResponseScriptConfig[]),
      }) : undefined;

      const result = await client.query(
        `UPDATE test_cases SET
           name = COALESCE($1, name),
           description = COALESCE($2, description),
           environment_id = CASE WHEN $3 THEN $4 ELSE environment_id END,
           environment_name = CASE WHEN $3 THEN $5 ELSE environment_name END,
            request_snapshot = COALESCE($6::jsonb, request_snapshot),
            assertions = COALESCE($7::jsonb, assertions),
            pre_request_hooks = COALESCE($8::jsonb, pre_request_hooks),
            extracts = COALESCE($9::jsonb, extracts),
            response_scripts = COALESCE($10::jsonb, response_scripts),
            tags = COALESCE($11, tags),
            updated_at = now()
          WHERE id = $12 AND project_id = $13 RETURNING *`,
        [
          request.body.name?.trim() ?? null,
          request.body.description?.trim() ?? null,
          environmentGiven, request.body.environmentId ?? null, name ?? null,
          request.body.request ? JSON.stringify(toSnapshot(request.body.request)) : null,
          request.body.assertions ? JSON.stringify(request.body.assertions) : null,
          lifecycle ? JSON.stringify(lifecycle.hooks) : null,
          request.body.extracts ? JSON.stringify(request.body.extracts) : null,
          lifecycle ? JSON.stringify(lifecycle.responseScripts) : null,
          request.body.tags ?? null,
          request.params.caseId, context.project.id,
        ],
      );
      await client.query("COMMIT");
      return success(mapTestCase(result.rows[0]));
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "case could not be saved");
    } finally {
      client.release();
    }
  });

  /**
   * Deleting a case keeps its runs: `executions.case_id` is ON DELETE SET NULL
   * and `case_name` was snapshotted, so history still reads correctly
   * (Spec 4.4 历史保留). Nothing references a case yet — 测试套件 (P2-4) will be
   * the first, and its usage scan belongs to that slice.
   */
  app.delete<{ Params: { id: string; caseId: string } }>("/api/v1/projects/:id/cases/:caseId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "case not found");
    const result = await pool.query("DELETE FROM test_cases WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.caseId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "case not found");
    return success({ id: String(result.rows[0].id) });
  });

  /**
   * Runs a case. The body may carry a request and/or assertions, which is what
   * the workbench sends after the user edited a loaded case: 交互文档 3.1.3 says
   * those edits run but do not自动落盘, so overrides are executed and recorded
   * without touching the stored case.
   */
  app.post<{ Params: { id: string; caseId: string }; Body: { request?: Partial<RequestSnapshot>; assertions?: Assertion[]; preRequestHooks?: HookConfig[]; extracts?: FlowExtract[]; responseScripts?: ResponseScriptConfig[] } }>("/api/v1/projects/:id/cases/:caseId/execute", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "case not found");
    const result = await pool.query(
      /* endpoint_name is read from the endpoint so history keeps naming the
         resource the case belongs to, the same way a debug run does. */
      `SELECT test_cases.*, endpoints.name AS endpoint_name FROM test_cases
         JOIN endpoints ON endpoints.id = test_cases.endpoint_id
        WHERE test_cases.id = $1 AND test_cases.project_id = $2`,
      [request.params.caseId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "case not found");
    const testCase = mapTestCase(result.rows[0]);

    const override = request.body?.request;
    if (override) {
      const invalid = validate({ name: testCase.name, request: override });
      if (invalid) return fail(reply, 400, 1001, invalid);
    }
    const assertionOverride = request.body?.assertions;
    const lifecycleInvalid = validateDeclarativeAssertions(assertionOverride)
      ?? validateHooks(request.body?.preRequestHooks, "case")
      ?? validateExtracts(request.body?.extracts, "case")
      ?? validateResponseScripts(request.body?.responseScripts, "case");
    if (lifecycleInvalid) return fail(reply, 400, 1001, lifecycleInvalid);

    try {
      const executionId = await enqueueRun({
        projectId: context.project.id,
        endpointId: testCase.endpointId,
        endpointName: String(result.rows[0].endpoint_name),
        /* The frozen snapshot unless the caller supplied an edited one. */
        request: override ? toSnapshot(override) : testCase.request,
        environmentId: testCase.environmentId,
        environmentName: testCase.environmentName,
        source: "test_case",
        caseId: testCase.id,
        caseName: testCase.name,
        assertions: assertionOverride ?? testCase.assertions,
        hooks: request.body?.preRequestHooks ?? testCase.preRequestHooks,
        extracts: request.body?.extracts ?? testCase.extracts,
        responseScripts: request.body?.responseScripts ?? testCase.responseScripts,
      });
      /* 202: an accepted run, not a verdict. The client follows it on the
         stream, exactly as it does for a debug send. */
      const queued = await pool.query("SELECT * FROM executions WHERE id = $1", [executionId]);
      return reply.code(202).send(success(mapExecution(queued.rows[0])));
    } catch (error) {
      return fail(reply, 400, 2002, error instanceof Error ? error.message : "request could not be prepared");
    }
  });

  /**
   * 即时验证: runs the assertion editor's declarative rules against a response
   * the user already has, so the form can be checked without sending another
   * request. Response scripts are validated through `/scripts/try` instead.
   */
  app.post<{ Params: { id: string }; Body: { assertions?: Assertion[]; statusCode?: number; headers?: Record<string, string>; body?: string } }>("/api/v1/projects/:id/assertions/validate", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const invalid = validateDeclarativeAssertions(request.body?.assertions);
    if (invalid) return fail(reply, 400, 1001, invalid);

    const evaluated = evaluateAssertions(request.body?.assertions ?? [], {
      statusCode: request.body?.statusCode,
      headers: request.body?.headers ?? {},
      body: request.body?.body,
    });
    return success({ results: evaluated.results, passed: evaluated.results.every((item) => item.passed), variables: evaluated.variables });
  });
}
