import { pool } from "../db.js";
import { METHODS } from "./run.js";
import { redactExecutionForMcp } from "./mcpRedact.js";
import { pageArgs, requiredUuidArg, stringArg, toolError, toolResult } from "./mcpToolResult.js";
import type { McpToolDefinition } from "./mcpServer.js";
import { SCRIPT_CTX_SCHEMAS } from "./scriptContract.js";
import { isUuid } from "./uuid.js";
import {
  mapEndpoint, mapEnvironment, mapFlow, mapScript, mapTestCase, mapTestCaseSummary,
} from "../models/types.js";

/**
 * 只读工具第一批（P5-4a，计划 9.4「核心资产读」12 个）：接口 / 用例 / 执行 / 脚本契约 /
 * 环境 / 流程 / 项目总览。
 *
 * 各自写 SQL、共用 `models/types.ts` 的 mapper（边界 8：读工具**不重构**既有读路由）。
 * `description` 必须写清「不能做什么」——模型读 description 决定调不调（9.4 硬要求）。
 */

/** 执行状态过滤的合法值（与 executions 的 CHECK 同集）。 */
const EXECUTION_STATUSES = ["queued", "running", "success", "failed", "canceled"];

export const READ_CORE_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "list_endpoints",
    description: "List the project's API endpoints, newest first, with keyword and method filters and page/pageSize paging. Each row carries the endpoint id (for get_endpoint) plus caseCount. Returns definitions without case bodies — use get_endpoint for one full definition, list_cases for cases. Cannot create, modify or delete endpoints.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "substring match against name, url and description" },
        method: { type: "string", description: "exact HTTP method filter, e.g. GET; 'all' disables the filter" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: async (args, identity) => {
      const { page, pageSize, offset } = pageArgs(args);
      const params: unknown[] = [identity.projectId];
      const clauses = ["project_id = $1"];
      const keyword = stringArg(args, "keyword");
      if (keyword) {
        params.push(`%${keyword}%`);
        clauses.push(`(name ILIKE $${params.length} OR url ILIKE $${params.length} OR description ILIKE $${params.length})`);
      }
      const method = stringArg(args, "method")?.toUpperCase();
      if (method && method !== "ALL") {
        if (!METHODS.includes(method)) return toolError(`method must be one of ${METHODS.join(", ")} (1001)`);
        params.push(method);
        clauses.push(`method = $${params.length}`);
      }
      const where = clauses.join(" AND ");
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM endpoints WHERE ${where}`, params);
      params.push(pageSize, offset);
      const result = await pool.query(
        `SELECT endpoints.*, COALESCE(cases.total, 0) AS case_count
           FROM endpoints
           /* 分组子查询而不是 join test_cases：join 会让接口行按用例数成倍放大（dashboard.ts 同款纪律）。 */
           LEFT JOIN (SELECT endpoint_id, COUNT(*)::int AS total FROM test_cases GROUP BY endpoint_id) cases
             ON cases.endpoint_id = endpoints.id
          WHERE ${where}
          ORDER BY endpoints.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return toolResult({
        endpoints: result.rows.map((row) => ({ ...mapEndpoint(row), caseCount: Number(row.case_count) })),
        page, pageSize, total: Number(count.rows[0].total),
      });
    },
  },
  {
    name: "get_endpoint",
    description: "One endpoint's full definition (method, url, headers, query/path params, body, auth, tags). Cannot execute it — execution only happens through saved assets via run_* tools, and no tool accepts an inline ad-hoc request.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { endpointId: { type: "string", description: "endpoint id from list_endpoints" } },
      required: ["endpointId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "endpointId", "endpoint");
      if ("error" in id) return toolError(id.error);
      const result = await pool.query("SELECT * FROM endpoints WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!result.rowCount) return toolError("endpoint not found (2001)");
      return toolResult(mapEndpoint(result.rows[0]));
    },
  },
  {
    name: "list_cases",
    description: "List test case summaries with keyword and endpointId filters, paged, grouped by endpoint name. Rows are summaries (assertionCount but no request snapshot, no assertions/scripts bodies) and carry both id and endpointId — use get_case with the id for the full definition. Cannot create or modify cases.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "substring match against case name and description" },
        endpointId: { type: "string", description: "restrict to cases of one endpoint" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: async (args, identity) => {
      const { page, pageSize, offset } = pageArgs(args);
      const params: unknown[] = [identity.projectId];
      const clauses = ["c.project_id = $1"];
      const keyword = stringArg(args, "keyword");
      if (keyword) {
        params.push(`%${keyword}%`);
        clauses.push(`(c.name ILIKE $${params.length} OR c.description ILIKE $${params.length})`);
      }
      const endpointId = stringArg(args, "endpointId");
      if (endpointId) {
        const id = requiredUuidArg(args, "endpointId", "endpoint");
        if ("error" in id) return toolError(id.error);
        params.push(id.value);
        clauses.push(`c.endpoint_id = $${params.length}`);
      }
      const where = clauses.join(" AND ");
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM test_cases c WHERE ${where}`, params);
      params.push(pageSize, offset);
      const result = await pool.query(
        `SELECT c.id, c.project_id, c.endpoint_id, e.name AS endpoint_name, c.name, c.description,
                c.environment_id, c.environment_name, c.tags, c.created_at, c.updated_at,
                (SELECT COUNT(*)::int FROM jsonb_array_elements(c.assertions) item WHERE item->>'type' <> 'script') AS assertion_count
           FROM test_cases c
           JOIN endpoints e ON e.id = c.endpoint_id
          WHERE ${where}
          ORDER BY e.name, c.name, c.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return toolResult({
        cases: result.rows.map(mapTestCaseSummary),
        page, pageSize, total: Number(count.rows[0].total),
      });
    },
  },
  {
    name: "get_case",
    description: "One test case's full definition: frozen request snapshot, declarative assertions, pre-request hooks, extracts and responseScripts. Script assertions (type 'script') are retired and filtered out — validation scripts only live in responseScripts (see get_script_contract). Cannot run it; use run_case.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { caseId: { type: "string", description: "case id from list_cases" } },
      required: ["caseId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "caseId", "case");
      if ("error" in id) return toolError(id.error);
      const result = await pool.query("SELECT * FROM test_cases WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!result.rowCount) return toolError("case not found (2001)");
      return toolResult(mapTestCase(result.rows[0]));
    },
  },
  {
    name: "get_execution",
    description: "One execution record with its evidence (request snapshot, response headers/body, assertion results, hooks, response scripts), re-masked at read time so declared secrets never reach the conversation. Runs WITH an environment are masked against that environment's CURRENT secrets; runs WITHOUT one are masked against the union of ALL the project's environments' secrets (a project that declares no secrets gets the evidence verbatim; `masking` says which set was used). If the run's environment was DELETED after the fact, evidence is omitted with a bodyOmitted reason — its secret values are gone and cannot be re-masked. Response bodies are truncated to 64KB. Cannot cancel or re-run; use the REST/UI for that.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { executionId: { type: "string", description: "execution id from list_executions" } },
      required: ["executionId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "executionId", "execution");
      if ("error" in id) return toolError(id.error);
      const result = await pool.query("SELECT * FROM executions WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!result.rowCount) return toolError("execution not found (2001)");
      return toolResult(await redactExecutionForMcp(identity.projectId, result.rows[0]));
    },
  },
  {
    name: "list_executions",
    description: "List execution records, newest first, filterable by caseId / endpointId / status / since (ISO 8601 timestamp). Rows are lightweight — id, status, statusCode, durationMs, createdAt plus origin ids (endpointId/caseId, source, flow node) — and never carry request/response bodies: use get_execution by id for evidence. Flow step records are included unless source narrows them.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string" },
        endpointId: { type: "string" },
        status: { type: "string", description: "queued | running | success | failed | canceled; 'all' disables the filter" },
        since: { type: "string", description: "ISO 8601; only executions created at or after this time" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: async (args, identity) => {
      const { page, pageSize, offset } = pageArgs(args);
      const params: unknown[] = [identity.projectId];
      const clauses = ["project_id = $1"];
      const caseId = stringArg(args, "caseId");
      if (caseId) {
        if (!isUuid(caseId)) return toolError("caseId must be a UUID (1001)");
        params.push(caseId);
        clauses.push(`case_id = $${params.length}`);
      }
      const endpointId = stringArg(args, "endpointId");
      if (endpointId) {
        if (!isUuid(endpointId)) return toolError("endpointId must be a UUID (1001)");
        params.push(endpointId);
        clauses.push(`endpoint_id = $${params.length}`);
      }
      const status = stringArg(args, "status");
      if (status && status !== "all") {
        if (!EXECUTION_STATUSES.includes(status)) return toolError(`status must be one of ${EXECUTION_STATUSES.join(", ")} (1001)`);
        params.push(status);
        clauses.push(`status = $${params.length}`);
      }
      const since = stringArg(args, "since");
      if (since) {
        const parsed = new Date(since);
        if (Number.isNaN(parsed.getTime())) return toolError("since must be an ISO 8601 timestamp (1001)");
        params.push(parsed.toISOString());
        clauses.push(`created_at >= $${params.length}`);
      }
      const where = clauses.join(" AND ");
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM executions WHERE ${where}`, params);
      params.push(pageSize, offset);
      const result = await pool.query(
        `SELECT id, endpoint_id, endpoint_name, case_id, case_name, source, flow_execution_id,
                flow_node_id, flow_node_name, status, status_code, duration_ms, created_at
           FROM executions
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return toolResult({
        executions: result.rows.map((row) => ({
          id: String(row.id),
          endpointId: row.endpoint_id ? String(row.endpoint_id) : undefined,
          endpointName: row.endpoint_name ? String(row.endpoint_name) : undefined,
          caseId: row.case_id ? String(row.case_id) : undefined,
          caseName: row.case_name ? String(row.case_name) : undefined,
          source: String(row.source),
          flowExecutionId: row.flow_execution_id ? String(row.flow_execution_id) : undefined,
          flowNodeId: row.flow_node_id ? String(row.flow_node_id) : undefined,
          flowNodeName: row.flow_node_name ? String(row.flow_node_name) : undefined,
          status: String(row.status),
          statusCode: row.status_code === null || row.status_code === undefined ? undefined : Number(row.status_code),
          durationMs: Number(row.duration_ms ?? 0),
          createdAt: new Date(String(row.created_at)).toISOString(),
        })),
        page, pageSize, total: Number(count.rows[0].total),
      });
    },
  },
  {
    name: "get_script_contract",
    description: "The platform's script runtime contract: every ctx.* symbol per script kind (assertion / response / hook / node), how variables and secrets work, and the rules a script must follow. Read this BEFORE writing any script — scripts are not bare JavaScript and code written against other runtimes will not execute here. Also states what the tool set does not offer: no ad-hoc request execution, no secret creation (secrets are entered by humans in the UI and referenced via {{name}}), no create_mcp_token.",
    scope: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      return toolResult({
        ctxSchemas: SCRIPT_CTX_SCHEMAS,
        rules: [
          "Scripts run inside a sandbox with a ctx.* contract, not bare JavaScript: no require/import, no network or filesystem access, only what ctx exposes.",
          "Script assertions (Assertion.type === 'script') are retired — validation scripts must go into responseScripts; a 'script' assertion saved today is silently dropped on read.",
          "Secrets are never passed literally: scripts reference { secret: \"NAME\" } which resolves against the run environment's secrets; write tools reject literal credential-looking values and ask for {{variable}} references instead.",
          "Library scripts are declarations only (functions/classes/constants with side-effect-free initializers) and are composed one level deep via dependencies.",
          "Not provided as tools: executing an ad-hoc request with inline method/url/body (execution only runs saved assets), creating or reading secret values, and creating MCP tokens (no self-escalation).",
        ],
      });
    },
  },
  {
    name: "list_scripts",
    description: "List the project's named public scripts (assertion / hook / response / library / node kinds), optionally filtered by kind or keyword, paged. Anonymous case-owned scripts are an implementation detail and never listed. Editing a public script changes every follower at once — there is no read tool that can tell you the blast radius of an edit; the REST UI shows usage. Cannot create or edit scripts through this tool set.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "substring match against script name" },
        kind: { type: "string", description: "assertion | hook | response | library | node" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: async (args, identity) => {
      const { page, pageSize, offset } = pageArgs(args);
      const params: unknown[] = [identity.projectId];
      const clauses = ["s.project_id = $1", "s.name IS NOT NULL"];
      const keyword = stringArg(args, "keyword");
      if (keyword) {
        params.push(`%${keyword}%`);
        clauses.push(`s.name ILIKE $${params.length}`);
      }
      const kind = stringArg(args, "kind");
      if (kind) {
        if (!["assertion", "hook", "response", "library", "node"].includes(kind)) {
          return toolError("kind must be one of assertion, hook, response, library, node (1001)");
        }
        params.push(kind);
        clauses.push(`s.kind = $${params.length}`);
      }
      const where = clauses.join(" AND ");
      const body = `
        FROM scripts s
        LEFT JOIN (
          SELECT script_id, array_agg(depends_on_id ORDER BY position) AS ids
            FROM script_deps GROUP BY script_id
        ) d ON d.script_id = s.id
        WHERE ${where}
        ORDER BY s.kind, s.name`;
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM scripts s WHERE ${where}`, params);
      params.push(pageSize, offset);
      const result = await pool.query(
        `SELECT s.*, COALESCE(d.ids, '{}') AS dependencies${body} LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return toolResult({
        scripts: result.rows.map(mapScript),
        page, pageSize, total: Number(count.rows[0].total),
      });
    },
  },
  {
    name: "list_environments",
    description: "List the project's environments: visible variables, runner label, default headers, and secretKeys — the NAMES of configured secrets only. Secret values never leave the server; no tool can read, create or update them. Use the key names to write {{name}} references.",
    scope: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, identity) => {
      const result = await pool.query("SELECT * FROM environments WHERE project_id = $1 ORDER BY name", [identity.projectId]);
      return toolResult({ environments: result.rows.map(mapEnvironment), total: result.rowCount ?? 0 });
    },
  },
  {
    name: "list_flows",
    description: "List the project's flows with nodeCount (not the node bodies — a list shipping every request body would outweigh the editor itself), keyword filter and paging. Use get_flow with the id for the full DAG. Cannot run a flow from here; that is run_flow.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "substring match against name and description" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: async (args, identity) => {
      const { page, pageSize, offset } = pageArgs(args);
      const params: unknown[] = [identity.projectId];
      const clauses = ["project_id = $1"];
      const keyword = stringArg(args, "keyword");
      if (keyword) {
        params.push(`%${keyword}%`);
        clauses.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
      }
      const where = clauses.join(" AND ");
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM flows WHERE ${where}`, params);
      params.push(pageSize, offset);
      const result = await pool.query(
        `SELECT flows.*, jsonb_array_length(flows.nodes) AS node_count
           FROM flows
          WHERE ${where}
          ORDER BY flows.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return toolResult({
        flows: result.rows.map((row) => {
          const { nodes, ...flow } = mapFlow(row);
          return { ...flow, nodeCount: Number(row.node_count ?? 0) };
        }),
        page, pageSize, total: Number(count.rows[0].total),
      });
    },
  },
  {
    name: "get_flow",
    description: "One flow's full DAG: nodes (request/script/condition/database/wait), edges, variables and tags. Cannot modify or run it; that is upsert_flow / run_flow.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { flowId: { type: "string", description: "flow id from list_flows" } },
      required: ["flowId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "flowId", "flow");
      if ("error" in id) return toolError(id.error);
      const result = await pool.query("SELECT * FROM flows WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!result.rowCount) return toolError("flow not found (2001)");
      return toolResult(mapFlow(result.rows[0]));
    },
  },
  {
    name: "get_project_overview",
    description: "One call instead of dozens of paged walks: asset counts (endpoints, cases, environments, flows, suites, CI tasks), case coverage rate, the pass rate over the most recent 100 judged executions, and the 10 most recent failures (ids only — fetch evidence via get_execution). Cannot produce trends or alerts; read tools answer 'what is the state right now'.",
    scope: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, identity) => {
      /* 每个计数一个分组子查询：join 兄弟表会成倍放大行数（dashboard.ts 同款纪律）。 */
      const stats = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM endpoints WHERE project_id = $1) AS endpoint_count,
           (SELECT COUNT(DISTINCT endpoint_id) FROM test_cases WHERE project_id = $1) AS covered_endpoint_count,
           (SELECT COUNT(*)::int FROM test_cases WHERE project_id = $1) AS case_count,
           (SELECT COUNT(*)::int FROM environments WHERE project_id = $1) AS environment_count,
           (SELECT COUNT(*)::int FROM flows WHERE project_id = $1) AS flow_count,
           (SELECT COUNT(*)::int FROM test_suites WHERE project_id = $1) AS suite_count,
           (SELECT COUNT(*)::int FROM ci_tasks WHERE project_id = $1) AS ci_task_count,
           (SELECT MAX(created_at) FROM executions WHERE project_id = $1) AS last_execution_at`,
        [identity.projectId],
      );
      const row = stats.rows[0];
      const endpointCount = Number(row.endpoint_count);
      const coveredEndpointCount = Number(row.covered_endpoint_count);

      /* 最近通过率：分母只算最近 100 条「有结论」的执行（queued/running 不是结论），
         与看板 passRate 同一条口径——一个会自己动的数比没有数更糟。 */
      const recent = await pool.query(
        `SELECT COUNT(*)::int AS judged, COUNT(*) FILTER (WHERE status = 'success')::int AS passed
           FROM (SELECT status FROM executions
                  WHERE project_id = $1 AND status IN ('success', 'failed')
                  ORDER BY created_at DESC LIMIT 100) recent`,
        [identity.projectId],
      );
      const judged = Number(recent.rows[0].judged);
      const passed = Number(recent.rows[0].passed);

      /* 最近失败 top 10：只带定位字段（错误详情里可能带出凭据，走 get_execution 的读时脱敏）。 */
      const failures = await pool.query(
        `SELECT id, endpoint_id, endpoint_name, case_id, case_name, source, status_code, duration_ms, created_at
           FROM executions
          WHERE project_id = $1 AND status = 'failed'
          ORDER BY created_at DESC LIMIT 10`,
        [identity.projectId],
      );

      return toolResult({
        counts: {
          endpoints: endpointCount,
          coveredEndpoints: coveredEndpointCount,
          cases: Number(row.case_count),
          environments: Number(row.environment_count),
          flows: Number(row.flow_count),
          suites: Number(row.suite_count),
          ciTasks: Number(row.ci_task_count),
        },
        /* null 而不是 0：「还没跑过」与「全挂了」是两件不同的事。 */
        coverageRate: endpointCount ? Math.round((coveredEndpointCount / endpointCount) * 1000) / 10 : null,
        recentPassRate: judged ? Math.round((passed / judged) * 1000) / 10 : null,
        recentJudgedCount: judged,
        lastExecutionAt: row.last_execution_at ? new Date(String(row.last_execution_at)).toISOString() : null,
        recentFailures: failures.rows.map((failure) => ({
          executionId: String(failure.id),
          endpointId: failure.endpoint_id ? String(failure.endpoint_id) : undefined,
          endpointName: failure.endpoint_name ? String(failure.endpoint_name) : undefined,
          caseId: failure.case_id ? String(failure.case_id) : undefined,
          caseName: failure.case_name ? String(failure.case_name) : undefined,
          source: String(failure.source),
          statusCode: failure.status_code === null || failure.status_code === undefined ? undefined : Number(failure.status_code),
          durationMs: Number(failure.duration_ms ?? 0),
          createdAt: new Date(String(failure.created_at)).toISOString(),
        })),
      });
    },
  },
];
