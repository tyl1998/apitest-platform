import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { evaluateAssertions, validateDeclarativeAssertions } from "../lib/assert.js";
import { applyCaseToFlowNodes, caseFlowBindings, caseSyncPayload, writeFlowNodes } from "../lib/caseSync.js";
import { NoRunnerError, enqueueRun } from "../lib/enqueue.js";
import { toFlowNode, validateExtracts, validateHooks, validateResponseScripts } from "../lib/flow.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, failNoRunner, success } from "../lib/response.js";
import { BODY_TYPES, METHODS } from "../lib/run.js";
import { detachSuiteMember } from "../lib/suiteMembers.js";
import { isUuid } from "../lib/uuid.js";
import { persistCaseLifecycleScripts, persistFlowScripts } from "../lib/scripts.js";
import { mapExecution, mapFlow, mapTestCase, mapTestCaseSummary, type Assertion, type FlowExtract, type HookConfig, type RequestSnapshot, type ResponseScriptConfig, type TestCase } from "../models/types.js";

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

/**
 * Everything that would break if this case disappeared (P2-4.5).
 *
 * 只有**套件的 manual 成员**算引用：套件只存 `{type,id}`，用例定义现读，所以用例没了那个
 * 成员就是一条悬空引用。tag/all 按条件现算，不产生引用（边界决策 6）。
 *
 * 两类**不算**引用，所以既不拦也不列：
 *
 * - 流程请求节点的 `sourceCaseId` 只是**来源标记**。节点自己持有完整的请求/断言快照
 *   （改用例不影响已存下的流程，见 `RequestFlowNode.sourceCaseId` 的注释），删掉用例
 *   只让编辑器少显示一行「来自哪个用例」，运行结果一模一样。把它列进拦截清单会让人以为
 *   流程会跑坏。
 * - 执行历史：`executions.case_id` 是 ON DELETE SET NULL 且快照了 `case_name`（迁移 007），
 *   删完历史仍然读得通。只报个数，供人判断这条用例跑过多少次。
 */
async function caseUsage(projectId: string, caseId: string) {
  const found = await pool.query("SELECT id FROM test_cases WHERE id = $1 AND project_id = $2", [caseId, projectId]);
  if (!found.rowCount) return undefined;
  const suites = await pool.query(
    `SELECT id, name FROM test_suites
      WHERE project_id = $1 AND selection_type = 'manual' AND selection_config @> $2::jsonb
      ORDER BY name`,
    [projectId, JSON.stringify({ members: [{ type: "case", id: caseId }] })],
  );
  const executions = await pool.query("SELECT COUNT(*)::int AS total FROM executions WHERE case_id = $1", [caseId]);
  return {
    caseId,
    suites: suites.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
    executionCount: Number(executions.rows[0].total),
    blocked: Boolean(suites.rowCount),
  };
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
   * What breaks if this case is deleted, read before the confirm dialog
   * (P2-4.5). Same twin-route shape as environments / data sources.
   */
  app.get<{ Params: { id: string; caseId: string } }>("/api/v1/projects/:id/cases/:caseId/usage", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "case not found");
    const usage = await caseUsage(context.project.id, request.params.caseId);
    if (!usage) return fail(reply, 404, 2001, "case not found");
    return success(usage);
  });

  /**
   * Deleting a case keeps its runs: `executions.case_id` is ON DELETE SET NULL
   * and `case_name` was snapshotted, so history still reads correctly
   * (Spec 4.4 历史保留).
   *
   * 测试套件是第一个引用方（P2-4.5）：手动成员引用了它就回 409 + 清单，`?force=true`
   * 才真删。**force 之后引用不再允许悬空**：删除与「把它从每个引用它的手动套件里摘掉」
   * 在同一个事务里完成（`detachSuiteMember`）。一个已经不存在的用例出现在套件成员列表里
   * 除了解释自己为什么在那儿之外没有用途，唯一合理的操作就是删掉它——那件事这里做完。
   */
  app.delete<{ Params: { id: string; caseId: string }; Querystring: { force?: string } }>("/api/v1/projects/:id/cases/:caseId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "case not found");
    const usage = await caseUsage(context.project.id, request.params.caseId);
    if (!usage) return fail(reply, 404, 2001, "case not found");
    if (usage.blocked && request.query.force !== "true") {
      return reply.code(409).send({ code: 2003, message: "case is referenced", data: usage });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("DELETE FROM test_cases WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.caseId, context.project.id]);
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return fail(reply, 404, 2001, "case not found");
      }
      /* 摘成员必须与 DELETE 同一个事务：分两步会留下「用例已删、成员还在」的中间态，
         而那正是悬空行的来源。 */
      const detached = await detachSuiteMember(client, context.project.id, "case", request.params.caseId);
      await client.query("COMMIT");
      /* 回报改到了哪些套件：界面用它说「已从 N 个套件中移除」，而不是让用户下次打开
         套件才发现成员少了一个。 */
      return success({ id: String(result.rows[0].id), detachedSuites: detached });
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "case could not be deleted");
    } finally {
      client.release();
    }
  });

  /**
   * 这个用例被哪些流程的哪些请求节点引用（P2-4.5 增补）。
   *
   * 与 `usage` 是两件不同的事，所以是两条路由：`usage` 回答「删掉它会坏什么」，绑定清单
   * 回答「改好它之后还有哪儿要跟着改」。把来源标记塞进 usage 的拦截清单会让人以为流程会
   * 跑坏——它不会，节点自带完整快照。
   */
  app.get<{ Params: { id: string; caseId: string } }>("/api/v1/projects/:id/cases/:caseId/flow-bindings", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "case not found");
    const found = await pool.query("SELECT id FROM test_cases WHERE id = $1 AND project_id = $2", [request.params.caseId, context.project.id]);
    if (!found.rowCount) return fail(reply, 404, 2001, "case not found");
    const bindings = await caseFlowBindings(context.project.id, request.params.caseId);
    return success(bindings, { total: bindings.length });
  });

  /**
   * 把这个用例的当前定义**覆盖**进若干条流程里绑定它的节点（P2-4.5 增补）。
   *
   * 这不违反快照隔离，而是补上它缺的那一半：请求节点从用例导入时复制了一份快照，所以
   * 改用例永远不会自动改动已存的流程——那条规则保住了「流程跑的是它自己存下的东西」。
   * 代价是用例修好之后，引用它的每条流程都要手工重新导入一次。这条路由把那件事变成一次
   * **显式**操作：由人勾选流程、点一次同步，覆盖那些节点。自动传播仍然不做。
   *
   * **一次可以同步多条流程**：一处改动往往要推给所有复用它的链路，让人点五次同步
   * 只是把同一个决定重复五遍。破坏性由「勾选 + 确认对话框列出会被覆盖的节点」承担，
   * 而不是由「一次只能选一条」承担。
   *
   * **一个事务覆盖全部选中的流程**：部分成功会留下「三条已同步、两条还是旧的」这种
   * 说不清的中间态，而用户看到的是一条失败提示。要么全推过去，要么一条都不动。
   *
   * `nodeIds` 可选：给出就只覆盖点名的节点（节点 id 在项目内由客户端生成、跨流程不重复，
   * 所以一份清单足够），缺省表示每条流程里绑着这个用例的全部节点。
   */
  app.post<{ Params: { id: string; caseId: string }; Body: { flowIds?: string[]; nodeIds?: string[] } }>("/api/v1/projects/:id/cases/:caseId/sync-to-flows", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.caseId)) return fail(reply, 404, 2001, "case not found");
    const flowIds = request.body?.flowIds;
    if (!Array.isArray(flowIds) || !flowIds.length) return fail(reply, 400, 1001, "flowIds must be a non-empty array");
    if (flowIds.some((id) => !isUuid(id))) return fail(reply, 400, 1001, "each flowId must be a UUID");
    if (request.body?.nodeIds !== undefined && !Array.isArray(request.body.nodeIds)) return fail(reply, 400, 1001, "nodeIds must be an array");
    /* 同一条流程被勾两次不该被覆盖两遍（第二遍写的是刚写进去的那份，纯浪费一次往返）。
       同时**排序**：多行加锁的顺序不一致就会在两次并发同步之间形成死锁。 */
    const unique = [...new Set(flowIds)].sort();

    const found = await pool.query("SELECT * FROM test_cases WHERE id = $1 AND project_id = $2", [request.params.caseId, context.project.id]);
    if (!found.rowCount) return fail(reply, 404, 2001, "case not found");
    const testCase = mapTestCase(found.rows[0]);
    /* 脚本引用先接手（匿名脚本复制正文、公共脚本跟随），与 `flows/node-source` 的导入
       走同一条规则——两条路径给出不同结果就会出现「导入能存、同步存不下」。
       只接手一次：每条流程都重新接手一遍会为同一份匿名脚本正文复制出 N 个副本。 */
    const payload = await caseSyncPayload(context.project.id, testCase);
    const targets = request.body?.nodeIds?.length ? new Set(request.body.nodeIds) : undefined;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results: { flowId: string; flowName: string; updatedNodeIds: string[] }[] = [];
      for (const flowId of unique) {
        /* FOR UPDATE：同步是读图 → 改图 → 写回，中间被另一次保存插进来会让这次写回
           把对方的改动整块盖掉。 */
        const owner = await client.query("SELECT * FROM flows WHERE id = $1 AND project_id = $2 FOR UPDATE", [flowId, context.project.id]);
        if (!owner.rowCount) {
          await client.query("ROLLBACK");
          return fail(reply, 404, 2001, "flow not found");
        }
        const flow = mapFlow(owner.rows[0]);
        const applied = applyCaseToFlowNodes(flow.nodes, testCase.id, targets, payload);
        /* 一条选中的流程里没有可覆盖的节点就整体拒绝，而不是静默跳过：清单是刚读来的，
           出现这种情况说明用户看到的与库里的已经不是一回事，此时继续写别的流程等于
           在一份过期的判断上执行破坏性操作。 */
        if (!applied.updated.length) {
          await client.query("ROLLBACK");
          return fail(reply, 400, 1001, `flow "${flow.name}" has no request node bound to that case`);
        }
        /* 走保存路径同一套归一 + 脚本持久化：同步写进去的节点必须与用户手动保存出来的
           形状一致，否则「同步过的流程」会变成第二种节点形状。 */
        const normalized = applied.nodes.map(toFlowNode);
        const persisted = await persistFlowScripts(client, context.project.id, flowId, normalized);
        await writeFlowNodes(client, context.project.id, flowId, persisted);
        results.push({ flowId, flowName: flow.name, updatedNodeIds: applied.updated });
      }
      await client.query("COMMIT");
      /* 逐条回报改到了哪几个节点：界面据此说「3 条流程 / 5 个节点」，而不是一句成功。 */
      return success({ flows: results });
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "case could not be synced");
    } finally {
      client.release();
    }
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
      /* 分区没有在线执行器是基础设施问题，不是坏输入：2004 + label 让界面说清是哪个
         分区没人服务（P2-8 边界 5）。 */
      if (error instanceof NoRunnerError) return failNoRunner(reply, error.label, error.message);
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
