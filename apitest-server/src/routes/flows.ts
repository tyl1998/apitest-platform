import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { flowSnapshot, recordAssetVersion } from "../lib/assetVersions.js";
import { AUDIT_ACTIONS, auditFields, writeAuditLogAsync } from "../lib/audit.js";
import { NoRunnerError, enqueueRun, cancelFlowRun } from "../lib/enqueue.js";
import { MAX_FLOW_NODES, planStages, toFlowNode, topologicalOrder, validateFlowGraph, validateNode } from "../lib/flow.js";
import { checkFlowReferences, flowsReferencing } from "../lib/flowRefs.js";
import { executeConditionNode, executeDatabaseNode, executeScriptNode, prepareFlowNodes } from "../lib/flowRun.js";
import { executeWaitNode } from "../lib/flowNodes.js";
import { runGraph, TokenPool, type GraphContext } from "../lib/flowGraph.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, failNoRunner, success } from "../lib/response.js";
import { adoptScriptRefs, inlineFlowNodeScripts, persistFlowScripts } from "../lib/scripts.js";
import { detachSuiteMember } from "../lib/suiteMembers.js";
import { failTrigger, resourcesBelong, triggerFlowRun } from "../lib/trigger.js";
import { isUuid } from "../lib/uuid.js";
import { loadEnvironment } from "../lib/run.js";
import { mapEndpoint, mapExecution, mapExecutionStep, mapFlow, mapFlowExecution, mapTestCase, type ExecutionStep, type Flow, type FlowEdge, type FlowNode } from "../models/types.js";

type FlowInput = {
  name?: string;
  description?: string;
  environmentId?: string | null;
  nodes?: FlowNode[];
  edges?: FlowEdge[];
  variables?: Record<string, string>;
  tags?: string[];
};

/**
 * 列表投影（P11 归属列，边界 7/9）：`LEFT JOIN users` 带出 email 快照，基表显式
 * `fl.*`——裸 `*` 会在两表同名的 id / name / created_at 上取到 users 的值。
 */
const SELECT_FLOW = `SELECT fl.*, creator.email AS created_by_email, updater.email AS updated_by_email FROM flows fl
  LEFT JOIN users creator ON creator.id = fl.created_by
  LEFT JOIN users updater ON updater.id = fl.updated_by`;

/**
 * 单步调试的时间预算。
 *
 * 与流程总超时同量级（`lib/flowRun.ts` FLOW_TIMEOUT_MS）：单步调试一个容器节点
 * 会在这个 HTTP 请求里跑完整个循环体，没有上限就等于让一个请求无限期挂住。
 */
const SINGLE_STEP_TIMEOUT_MS = 10 * 60_000;

function validate(input: FlowInput, partial = false): string | undefined {
  if (!partial || input.name !== undefined) if (!input.name?.trim()) return "name is required";
  if (input.variables !== undefined) {
    if (typeof input.variables !== "object" || input.variables === null || Array.isArray(input.variables)) return "variables must be an object";
    for (const [key, value] of Object.entries(input.variables)) {
      if (!key.trim()) return "a variable name cannot be empty";
      if (typeof value !== "string") return `variable "${key}" must be a string`;
    }
  }
  if (input.nodes !== undefined || input.edges !== undefined) return validateFlowGraph(input.nodes ?? [], input.edges ?? []);
  return undefined;
}

async function environmentName(projectId: string, environmentId: string | null | undefined) {
  if (!environmentId) return null;
  const result = await pool.query("SELECT name FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  return result.rowCount ? String(result.rows[0].name) : undefined;
}

/** The most recent run of each of these flows, for the list's「最近结果」. */
async function latestRuns(flowIds: string[]) {
  if (!flowIds.length) return new Map<string, ReturnType<typeof mapFlowExecution>>();
  const result = await pool.query(
    `SELECT DISTINCT ON (flow_id) * FROM flow_executions
      WHERE flow_id = ANY($1::uuid[]) ORDER BY flow_id, created_at DESC`,
    [flowIds],
  );
  return new Map(result.rows.map((row) => [String(row.flow_id), mapFlowExecution(row)]));
}

/**
 * 非 HTTP 单步调试 (P2-2, extended P2-6): runs one node alone.
 *
 * Database / script / condition / wait steps have no `executions` row — their
 * evidence is a generic `execution_steps` row under a throwaway parent index,
 * so the drawer gets the same step result a full flow run would produce.
 *
 * A subflow / loop node is itself a container: its body runs as a nested graph
 * under that same throwaway index, and the container's own step row is written
 * by that graph run (so its evidence reads exactly like a full run's). Script
 * bodies are inlined at this point for the same reproducibility rule as a run.
 */
async function executeGenericStep(projectId: string, flow: Flow, node: Extract<FlowNode, { type: "request" | "database" | "script" | "condition" | "wait" | "subflow" | "loop" }>, variables: Record<string, string> | undefined): Promise<ExecutionStep> {
  const indexId = randomUUID();
  try {
    const environment = await loadEnvironment(projectId, flow.environmentId);
    const bag = { ...environment.variables, ...flow.variables, ...(variables ?? {}) };
    await pool.query(
      `INSERT INTO execution_index (id, project_id, kind, target_id, target_name, detail_id, status, total, started_at)
       VALUES ($1, $2, 'flow', $3, $4, $1, 'running', 1, now())`,
      [indexId, projectId, flow.id, `${flow.name}: ${node.name}`],
    );

    /**
     * 脚本正文先内联，再准备。
     *
     * 断言、前置钩子、后置脚本、脚本节点正文、循环体内的这些——全部经同一个
     * `inlineFlowNodeScripts`，与完整运行入队时走的是同一条路。少了这一步，引用
     * 公共脚本的钩子在这里只有 id 没有正文，运行时报「hook script content is
     * missing」，而完整运行却是好的——两条路径必须用同一套内联。
     */
    const [inlined] = await inlineFlowNodeScripts(projectId, [node]);

    /* 容器语义的三种：子流程 / 循环 / **并发请求**。都由 runGraph 写容器行与嵌套
       证据，执行语义与完整运行完全一致——并发请求会落 N 个子步骤行 + N 条 HTTP 记录。 */
    if (node.type === "subflow" || node.type === "loop" || node.type === "request") {
      const [prepared] = await prepareFlowNodes(projectId, [inlined]);
      const tokens = new TokenPool(Math.max(1, Math.min(10, node.type === "request" ? node.concurrency ?? 1 : 1)));
      /* 单步调试同样要有上限：一个 100 次迭代 × 每步 30s 的循环若不设 deadline，
         会把一个 HTTP 请求挂住近一小时。用与完整运行一致的流程预算兜底。 */
      const deadline = AbortSignal.timeout(SINGLE_STEP_TIMEOUT_MS);
      const ctx: GraphContext = {
        projectId, indexId,
        environment, environmentId: flow.environmentId, environmentName: flow.environmentName,
        signal: new AbortController().signal, deadline,
        tokens,
      };
      const result = await runGraph(ctx, {
        flowId: flow.id, flowName: flow.name, nodes: [prepared], edges: [], variables: flow.variables,
      }, bag);
      const rows = await pool.query("SELECT * FROM execution_steps WHERE index_id = $1 AND step_id = $2 AND parent_step_id IS NULL", [indexId, node.id]);
      if (!rows.rowCount) throw new Error("container step was not recorded");
      await pool.query(
        `UPDATE execution_index SET status = $2, success_count = $3, failed_count = $4, finished_at = now() WHERE id = $1`,
        [indexId, result.status === "success" ? "success" : "failed", result.status === "success" ? 1 : 0, result.status === "success" ? 0 : 1],
      );
      return mapExecutionStep(rows.rows[0]);
    }

    /* 叶子节点：手工写一行步骤证据（没有嵌套）。脚本正文已在上面统一内联。 */
    const stepId = randomUUID();
    let prepared: { status: "success" | "failed"; durationMs: number; error?: string; output: Record<string, unknown> };
    if (inlined.type === "database") {
      const [dbNode] = await prepareFlowNodes(projectId, [inlined]);
      if (dbNode.type !== "database") throw new Error("a database node is required");
      prepared = await executeDatabaseNode(projectId, dbNode, bag, environment);
    } else if (inlined.type === "script") {
      prepared = await executeScriptNode(inlined, bag, environment);
    } else if (inlined.type === "condition") {
      prepared = executeConditionNode(inlined, bag, environment);
    } else if (inlined.type === "wait") {
      prepared = await executeWaitNode(inlined, [AbortSignal.timeout(SINGLE_STEP_TIMEOUT_MS)]);
    } else {
      throw new Error("unsupported node type for single-step debug");
    }

    await pool.query(
      `INSERT INTO execution_steps (id, index_id, step_id, step_type, step_name, status, position, input_snapshot, started_at)
       VALUES ($1, $2, $3, $4, $5, 'running', 0, $6::jsonb, now())`,
      [stepId, indexId, node.id, node.type, node.name, JSON.stringify(
        node.type === "database"
          ? { dataSourceId: node.dataSourceId, sqlDefinitionId: node.sqlDefinitionId, statementType: node.statementType }
          : node.type === "script" ? { scriptId: node.script?.scriptId }
          : node.type === "condition" ? { mode: node.condition.mode, ruleCount: node.condition.rules.length }
          : { waitMs: node.waitMs },
      )],
    );
    await pool.query(
      `UPDATE execution_steps SET status = $2, duration_ms = $3, output_snapshot = $4::jsonb, error = $5, finished_at = now() WHERE id = $1`,
      [stepId, prepared.status, prepared.durationMs, JSON.stringify(prepared.output), prepared.error ?? null],
    );
    await pool.query(
      `UPDATE execution_index SET status = $2, success_count = $3, failed_count = $4, finished_at = now() WHERE id = $1`,
      [indexId, prepared.status, prepared.status === "success" ? 1 : 0, prepared.status === "failed" ? 1 : 0],
    );
    const result = await pool.query("SELECT * FROM execution_steps WHERE id = $1", [stepId]);
    return mapExecutionStep(result.rows[0]);
  } catch (error) {
    await pool.query("UPDATE execution_index SET status = 'failed', failed_count = 1, finished_at = now() WHERE id = $1 AND status = 'running'", [indexId]);
    throw error;
  }
}

/**
 * Everything that would break if this flow disappeared (P2-4.5).
 *
 * 两类引用都是**真依赖**，所以都拦：
 *
 * - **套件的 manual 成员**：套件只存 `{type,id}`，成员定义现读。引用的流程没了，那个成员
 *   在下一次运行里就是一条悬空引用（`resolveMembers` 把它挑进 `missing`）。tag/all 是动态
 *   选择，按条件现算，不产生引用——所以扫描只看 `selection_type = 'manual'`（边界决策 6）。
 * - **别的流程的子流程节点**：子流程只存 `flowId`，内层图在入队时才读。目标流程没了，
 *   外层流程要到运行时才报「references a flow that does not exist」——这正是 usage 拦截
 *   要提前到删除前的理由。
 *
 * 执行历史只报数、从不拦：`flow_executions.flow_id` 是 ON DELETE SET NULL 且快照了
 * `flow_name`（迁移 012），删掉流程之后历史仍然读得通。
 */
async function flowUsage(projectId: string, flowId: string) {
  const flow = await pool.query("SELECT id FROM flows WHERE id = $1 AND project_id = $2", [flowId, projectId]);
  if (!flow.rowCount) return undefined;
  const suites = await pool.query(
    `SELECT id, name FROM test_suites
      WHERE project_id = $1 AND selection_type = 'manual' AND selection_config @> $2::jsonb
      ORDER BY name`,
    [projectId, JSON.stringify({ members: [{ type: "flow", id: flowId }] })],
  );
  /* 排除自己：一条引用自己的流程在保存时就被环检测拒了，但真要有这种历史数据，
     把它列成「自己拦住自己」只会让人无从下手。 */
  const flows = await flowsReferencing(projectId, "flowId", flowId, flowId);
  const executions = await pool.query("SELECT COUNT(*)::int AS total FROM flow_executions WHERE flow_id = $1", [flowId]);
  return {
    flowId,
    suites: suites.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
    flows,
    executionCount: Number(executions.rows[0].total),
    blocked: Boolean(suites.rowCount || flows.length),
  };
}

export async function flowRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; tag?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/flows", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const params: unknown[] = [context.project.id]; const clauses = ["fl.project_id = $1"];
    const keyword = request.query.keyword?.trim();
    /* Filtering in SQL so a keyword matches every flow, not just a loaded page. */
    if (keyword) { params.push(`%${keyword}%`); clauses.push(`(fl.name ILIKE $${params.length} OR fl.description ILIKE $${params.length})`); }
    if (request.query.tag?.trim()) { params.push(request.query.tag.trim()); clauses.push(`$${params.length} = ANY(fl.tags)`); }
    const where = clauses.join(" AND ");
    /* Pagination is opt-in: the member picker and flow selectors fetch the whole
       list, so the absence of `pageSize` keeps the unpaginated contract they rely
       on (same convention as endpoints / data-sources / mocks). */
    if (request.query.pageSize !== undefined) {
      const page = Math.max(1, Number(request.query.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM flows fl WHERE ${where}`, params);
      params.push(pageSize, (page - 1) * pageSize);
      const result = await pool.query(`${SELECT_FLOW} WHERE ${where} ORDER BY fl.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      const flows = result.rows.map(mapFlow);
      const runs = await latestRuns(flows.map((flow) => flow.id));
      const data = flows.map((flow) => ({ ...flow, nodeCount: flow.nodes.length, lastRun: runs.get(flow.id) }));
      return success(data, { page, pageSize, total: Number(count.rows[0].total) });
    }
    const result = await pool.query(`${SELECT_FLOW} WHERE ${where} ORDER BY fl.created_at DESC`, params);
    const flows = result.rows.map(mapFlow);
    const runs = await latestRuns(flows.map((flow) => flow.id));
    /* nodeCount travels alongside rather than inside Flow: the list only needs
       the number, and shipping every node's request body to render a list would
       make the flows page heavier than the editor. */
    const data = flows.map((flow) => ({ ...flow, nodeCount: flow.nodes.length, lastRun: runs.get(flow.id) }));
    return success(data, { total: data.length });
  });

  app.get<{ Params: { id: string; flowId: string } }>("/api/v1/projects/:id/flows/:flowId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.flowId)) return fail(reply, 404, 2001, "flow not found");
    const result = await pool.query("SELECT * FROM flows WHERE id = $1 AND project_id = $2", [request.params.flowId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "flow not found");
    return success(mapFlow(result.rows[0]));
  });

  app.post<{ Params: { id: string }; Body: FlowInput }>("/api/v1/projects/:id/flows", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const invalid = validate(request.body);
    if (invalid) return fail(reply, 400, 1001, invalid);
    const name = await environmentName(context.project.id, request.body.environmentId);
    if (name === undefined) return fail(reply, 400, 1001, "environment must belong to the project");
    const nodes = (request.body.nodes ?? []).map(toFlowNode);
    const owned = await resourcesBelong(context.project.id, nodes);
    if (owned) return fail(reply, 400, 1001, owned);
    /* 新流程还没有 id，只可能是引用已存在的流程；跨流程递归仍要在这里拒绝。 */
    const recursive = await checkFlowReferences(context.project.id, nodes, []);
    if (recursive) return fail(reply, 400, 1001, recursive);

    /* One transaction for the flow and its node scripts, for the same reason as
       a case save: an anonymous script needs an `owner_flow_id` to point at, so
       the flow row goes in first and the normalized nodes are written back. */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const flowId = randomUUID();
      await client.query(
        `INSERT INTO flows (id, project_id, name, description, environment_id, environment_name, nodes, edges, variables, tags, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7::jsonb, $8::jsonb, $9, $10)`,
        [
          flowId, context.project.id, request.body.name!.trim(), request.body.description?.trim() ?? "",
          request.body.environmentId ?? null, name,
          JSON.stringify(request.body.edges ?? []), JSON.stringify(request.body.variables ?? {}), request.body.tags ?? [],
          context.user.id,
        ],
      );
      const persisted = await persistFlowScripts(client, context.project.id, flowId, nodes, context.user.id);
      const result = await client.query("UPDATE flows SET nodes = $1::jsonb WHERE id = $2 RETURNING *", [JSON.stringify(persisted), flowId]);
      /* P10-6：落一版内容快照（整张节点图），与流程行同事务成败。 */
      await recordAssetVersion(client, {
        projectId: context.project.id, assetType: "flow", assetId: flowId,
        snapshot: flowSnapshot(mapFlow(result.rows[0])), changeSummary: "创建", createdBy: context.user.id,
      });
      await client.query("COMMIT");
      /* P11-9 审计（边界 5/6）：detail 只有字段名。 */
      writeAuditLogAsync({
        action: AUDIT_ACTIONS.flowCreate, targetType: "flow", targetId: String(result.rows[0].id),
        projectId: context.project.id, userId: context.user.id,
        detail: { fields: auditFields(request.body) }, ip: request.ip,
      });
      return reply.code(201).send(success(mapFlow(result.rows[0])));
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "flow could not be saved");
    } finally {
      client.release();
    }
  });

  app.put<{ Params: { id: string; flowId: string }; Body: FlowInput }>("/api/v1/projects/:id/flows/:flowId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.flowId)) return fail(reply, 404, 2001, "flow not found");
    const invalid = validate(request.body, true);
    if (invalid) return fail(reply, 400, 1001, invalid);

    /* environmentId is tri-state on a save: absent keeps it, null clears it, a
       uuid moves it — so the name snapshot follows the same three. */
    const environmentGiven = Object.prototype.hasOwnProperty.call(request.body, "environmentId");
    let name: string | null | undefined = undefined;
    if (environmentGiven) {
      name = await environmentName(context.project.id, request.body.environmentId);
      if (name === undefined) return fail(reply, 400, 1001, "environment must belong to the project");
    }
    const nodes = request.body.nodes?.map(toFlowNode);
    if (nodes) {
      const owned = await resourcesBelong(context.project.id, nodes);
      if (owned) return fail(reply, 400, 1001, owned);
      /* 本流程作为根进入引用链：自己引用自己、或经别的流程绕回自己都在这里拒绝。 */
      const recursive = await checkFlowReferences(context.project.id, nodes, [{ id: request.params.flowId, name: request.body.name?.trim() || "this flow" }]);
      if (recursive) return fail(reply, 400, 1001, recursive);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      /* Ownership before any script write: the FK on `owner_flow_id` proves the
         flow exists, not that it belongs to this project. */
      const owner = await client.query("SELECT id FROM flows WHERE id = $1 AND project_id = $2 FOR UPDATE", [request.params.flowId, context.project.id]);
      if (!owner.rowCount) {
        await client.query("ROLLBACK");
        return fail(reply, 404, 2001, "flow not found");
      }

      const persisted = nodes ? await persistFlowScripts(client, context.project.id, request.params.flowId, nodes, context.user.id) : undefined;
      const result = await client.query(
        `UPDATE flows SET
           name = COALESCE($1, name),
           description = COALESCE($2, description),
           environment_id = CASE WHEN $3 THEN $4 ELSE environment_id END,
           environment_name = CASE WHEN $3 THEN $5 ELSE environment_name END,
           nodes = COALESCE($6::jsonb, nodes),
           edges = COALESCE($7::jsonb, edges),
           variables = COALESCE($8::jsonb, variables),
           tags = COALESCE($9, tags),
           updated_by = $12,
           updated_at = now()
         WHERE id = $10 AND project_id = $11 RETURNING *`,
        [
          request.body.name?.trim() ?? null,
          request.body.description?.trim() ?? null,
          environmentGiven, request.body.environmentId ?? null, name ?? null,
          persisted ? JSON.stringify(persisted) : null,
          request.body.edges ? JSON.stringify(request.body.edges) : null,
          request.body.variables ? JSON.stringify(request.body.variables) : null,
          request.body.tags ?? null,
          request.params.flowId, context.project.id,
          context.user.id,
        ],
      );
      /* P10-6：落一版内容快照，与流程行/节点脚本改动同事务成败。 */
      await recordAssetVersion(client, {
        projectId: context.project.id, assetType: "flow", assetId: request.params.flowId,
        snapshot: flowSnapshot(mapFlow(result.rows[0])), changeSummary: "更新", createdBy: context.user.id,
      });
      await client.query("COMMIT");
      writeAuditLogAsync({
        action: AUDIT_ACTIONS.flowUpdate, targetType: "flow", targetId: request.params.flowId,
        projectId: context.project.id, userId: context.user.id,
        detail: { fields: auditFields(request.body) }, ip: request.ip,
      });
      return success(mapFlow(result.rows[0]));
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "flow could not be saved");
    } finally {
      client.release();
    }
  });

  /**
   * What breaks if this flow is deleted, read before the confirm dialog
   * (P2-4.5). Same twin-route shape as environments / data sources.
   */
  app.get<{ Params: { id: string; flowId: string } }>("/api/v1/projects/:id/flows/:flowId/usage", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.flowId)) return fail(reply, 404, 2001, "flow not found");
    const usage = await flowUsage(context.project.id, request.params.flowId);
    if (!usage) return fail(reply, 404, 2001, "flow not found");
    return success(usage);
  });

  /**
   * Deleting a flow keeps its runs: `flow_executions.flow_id` is ON DELETE SET
   * NULL and `flow_name` was snapshotted (Spec 4.4 历史保留). Its anonymous node
   * scripts go with it via `owner_flow_id` ON DELETE CASCADE.
   *
   * 套件成员与别的流程的子流程节点都会引用它（P2-4.5），所以删除前先扫描：有引用就回
   * 409 + 清单，`?force=true` 才真删——引用清单必须先给人看过。
   *
   * **force 之后套件成员不再悬空**：删除与「把它从每个引用它的手动套件里摘掉」在同一个
   * 事务里完成（`detachSuiteMember`）。别的流程的子流程节点则**保持**悬空——那是一张图上
   * 的一个节点，静默删掉它会改变流程的结构与连线，属于「删一个东西连带改一串东西」；
   * 它在入队时报「references a flow that does not exist」，由人去改那张图。
   */
  app.delete<{ Params: { id: string; flowId: string }; Querystring: { force?: string } }>("/api/v1/projects/:id/flows/:flowId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.flowId)) return fail(reply, 404, 2001, "flow not found");
    const usage = await flowUsage(context.project.id, request.params.flowId);
    if (!usage) return fail(reply, 404, 2001, "flow not found");
    if (usage.blocked && request.query.force !== "true") {
      return reply.code(409).send({ code: 2003, message: "flow is referenced", data: usage });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("DELETE FROM flows WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.flowId, context.project.id]);
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return fail(reply, 404, 2001, "flow not found");
      }
      const detached = await detachSuiteMember(client, context.project.id, "flow", request.params.flowId, context.user.id);
      await client.query("COMMIT");
      writeAuditLogAsync({
        action: AUDIT_ACTIONS.flowDelete, targetType: "flow", targetId: String(result.rows[0].id),
        projectId: context.project.id, userId: context.user.id, ip: request.ip,
      });
      /* 摘成员也是套件的一次写入（见 cases.ts 同款）：提交后逐条补 suite.update。 */
      for (const suite of detached) {
        writeAuditLogAsync({
          action: AUDIT_ACTIONS.testSuiteUpdate, targetType: "test_suite", targetId: suite.id,
          projectId: context.project.id, userId: context.user.id,
          detail: { fields: ["selection_config"], detachedMember: { type: "flow", id: request.params.flowId } }, ip: request.ip,
        });
      }
      return success({ id: String(result.rows[0].id), detachedSuites: detached });
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "flow could not be deleted");
    } finally {
      client.release();
    }
  });

  /**
   * Runs a flow.
   *
   * The body may carry nodes/edges/variables, which is what the canvas sends
   * when the user runs an edited-but-unsaved flow: those run and are recorded,
   * without touching the stored flow — the same rule as a case run
   * (交互文档 3.1.3).
   *
   * 校验与入队在 `lib/trigger.ts`（P3-3 边界 5）：手动、调度（P3-4）、Webhook（P3-6）
   * 共用同一条路径，错误码与 P2 完全一致（验收 6.7.1）。
   */
  app.post<{ Params: { id: string; flowId: string }; Body: { nodes?: FlowNode[]; edges?: FlowEdge[]; variables?: Record<string, string> } }>("/api/v1/projects/:id/flows/:flowId/execute", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.flowId)) return fail(reply, 404, 2001, "flow not found");
    try {
      const flowExecutionId = await triggerFlowRun({
        projectId: context.project.id,
        flowId: request.params.flowId,
        nodes: request.body?.nodes,
        edges: request.body?.edges,
        variables: request.body?.variables,
        /* 手动触发带上人（P9-1 收件口径）：execution_index.triggered_by 的落点，
           站内通知据此定点发。 */
        trigger: { source: "manual", userId: context.user.id },
      });
      /* 202: an accepted run, not a verdict. The client follows it on the
         stream, exactly as it does for a debug send. */
      const queued = await pool.query("SELECT * FROM flow_executions WHERE id = $1", [flowExecutionId]);
      return reply.code(202).send(success(mapFlowExecution(queued.rows[0])));
    } catch (error) {
      return failTrigger(reply, error, "flow could not be started");
    }
  });

  /**
   * 单步调试: runs one node on its own.
   *
   * A request node goes through `enqueueRun`, so it behaves exactly like a
   * debug send — one execution row, the same SSE, the same snapshot drawer.
   * Database / script / condition nodes are non-HTTP: their evidence is a
   * generic step row (executeGenericStep), because there is no HTTP snapshot
   * to show. The caller supplies the variable bag, since a single node has no
   * upstream step to produce one and would otherwise be untestable in isolation.
   */
  app.post<{ Params: { id: string; flowId: string }; Body: { node?: FlowNode; variables?: Record<string, string> } }>("/api/v1/projects/:id/flows/:flowId/nodes/execute", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.flowId)) return fail(reply, 404, 2001, "flow not found");
    const found = await pool.query("SELECT * FROM flows WHERE id = $1 AND project_id = $2", [request.params.flowId, context.project.id]);
    if (!found.rowCount) return fail(reply, 404, 2001, "flow not found");
    const flow = mapFlow(found.rows[0]);

    const node = request.body?.node ? toFlowNode(request.body.node) : undefined;
    if (!node) return fail(reply, 400, 1001, "node is required");
    const invalid = validateNode(node, "node");
    if (invalid) return fail(reply, 400, 1001, invalid);
    const owned = await resourcesBelong(context.project.id, [node]);
    if (owned) return fail(reply, 400, 1001, owned);

    /* Non-HTTP nodes answer with a generic step, never a fake HTTP execution.
       A **concurrent** request is the same shape: it fans out into N child steps
       under one container row, so a single execution row could not describe it
       and it takes the generic path too (P2-6 修订). */
    if (node.type !== "request" || (node.concurrency ?? 1) > 1) {
      try {
        return success(await executeGenericStep(context.project.id, flow, node, request.body?.variables));
      } catch (error) {
        return fail(reply, 400, 2002, error instanceof Error ? error.message : "step execution failed");
      }
    }

    try {
      const executionId = await enqueueRun({
        projectId: context.project.id,
        endpointId: node.endpointId,
        endpointName: node.name,
        request: node.request,
        environmentId: flow.environmentId,
        environmentName: flow.environmentName,
        source: "flow_step",
        flowNodeId: node.id,
        flowNodeName: node.name,
        /* P11 边界 11：单步调试也是一次「人按的按钮」。 */
        triggeredBy: context.user.id,
        assertions: node.assertions,
        /* Evaluated too, so the debug says whether the chained value would be
           captured — a step that "passes" while extracting nothing is exactly
           what single-step debugging is for. */
        extracts: node.extracts,
        /* 钩子（签名等）与断言同路：单步调试也要能验证签名，否则调试发出的是
           未签名请求，得到 401 却无从在界面上诊断脚本。 */
        hooks: node.preRequestHooks,
        responseScripts: node.responseScripts,
        /* Seed variables are injected here rather than resolved client-side, so
           a single-step debug reads `{{token}}` the same way a full run does. */
        variables: { ...flow.variables, ...(request.body?.variables ?? {}) },
      });
      const queued = await pool.query("SELECT * FROM executions WHERE id = $1", [executionId]);
      return reply.code(202).send(success(mapExecution(queued.rows[0])));
    } catch (error) {
      /* 单步调试同款（P2-8 边界 5）：节点没问题，是这个分区没有执行器。 */
      if (error instanceof NoRunnerError) return failNoRunner(reply, error.label, error.message);
      const message = error instanceof Error ? error.message : "request could not be prepared";
      if (message.includes("queue unavailable")) return fail(reply, 503, 5001, message);
      return fail(reply, 400, 2002, message);
    }
  });

  /** Kept for compatibility with the original database-only endpoint; the
   *  generalized single-step debug lives on /nodes/execute. */
  app.post<{ Params: { id: string; flowId: string }; Body: { node?: FlowNode; variables?: Record<string, string> } }>("/api/v1/projects/:id/flows/:flowId/nodes/execute-step", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.flowId)) return fail(reply, 404, 2001, "flow not found");
    const found = await pool.query("SELECT * FROM flows WHERE id = $1 AND project_id = $2", [request.params.flowId, context.project.id]);
    if (!found.rowCount) return fail(reply, 404, 2001, "flow not found");
    const flow = mapFlow(found.rows[0]); const node = request.body?.node ? toFlowNode(request.body.node) : undefined;
    if (!node || node.type === "request") return fail(reply, 400, 1001, "a database, script or condition node is required");
    const invalid = validateNode(node, "node"); if (invalid) return fail(reply, 400, 1001, invalid);
    const owned = await resourcesBelong(context.project.id, [node]); if (owned) return fail(reply, 400, 1001, owned);
    try {
      return success(await executeGenericStep(context.project.id, flow, node, request.body?.variables));
    } catch (error) {
      return fail(reply, 400, 2002, error instanceof Error ? error.message : "step execution failed");
    }
  });

  app.get<{ Params: { id: string; flowId: string }; Querystring: { status?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/flows/:flowId/executions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.flowId)) return fail(reply, 404, 2001, "flow not found");
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id, request.params.flowId]; const clauses = ["project_id = $1", "flow_id = $2"];
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`status = $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM flow_executions WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(`SELECT * FROM flow_executions WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return success(result.rows.map(mapFlowExecution), { page, pageSize, total: Number(count.rows[0].total) });
  });

  /** One flow run plus every step it produced, for the run panel and history. */
  app.get<{ Params: { id: string; flowExecutionId: string } }>("/api/v1/projects/:id/flow-executions/:flowExecutionId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.flowExecutionId)) return fail(reply, 404, 2001, "flow execution not found");
    const result = await pool.query("SELECT * FROM flow_executions WHERE id = $1 AND project_id = $2", [request.params.flowExecutionId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "flow execution not found");
    const steps = await pool.query("SELECT * FROM executions WHERE flow_execution_id = $1 ORDER BY created_at", [request.params.flowExecutionId]);
    const genericSteps = result.rows[0].execution_index_id
      ? await pool.query("SELECT * FROM execution_steps WHERE index_id = $1 ORDER BY COALESCE(parent_step_id::text, ''), position, created_at", [result.rows[0].execution_index_id])
      : { rows: [] };
    return success({ ...mapFlowExecution(result.rows[0]), steps: steps.rows.map(mapExecution), executionSteps: genericSteps.rows.map(mapExecutionStep) });
  });

  app.post<{ Params: { id: string; flowExecutionId: string } }>("/api/v1/projects/:id/flow-executions/:flowExecutionId/cancel", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.flowExecutionId)) return fail(reply, 404, 2001, "flow execution not found");
    const canceled = await cancelFlowRun(context.project.id, request.params.flowExecutionId);
    /* Already terminal: reported as a conflict rather than pretending the cancel
       did something (same as cancelling a single run). */
    if (!canceled) return fail(reply, 409, 2004, "flow execution is already finished");
    const result = await pool.query("SELECT * FROM flow_executions WHERE id = $1", [request.params.flowExecutionId]);
    return success(mapFlowExecution(result.rows[0]));
  });

  /**
   * 画布可用性提示: the runnable order the flow would use, or the reason it has
   * none. The editor calls this to show step numbers without re-implementing the
   * topological sort — two implementations of "what runs first" would eventually
   * disagree, and the one on screen is the one users would trust.
   *
   * `stages` is the parallel grouping (P2-2): siblings in the same stage may
   * run concurrently up to the parallelism budget, which the canvas shows so a
   * number never misleads someone into thinking two siblings are sequential.
   */
  app.post<{ Params: { id: string }; Body: { nodes?: FlowNode[]; edges?: FlowEdge[] } }>("/api/v1/projects/:id/flows/plan", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const nodes = (request.body?.nodes ?? []) as FlowNode[];
    if (nodes.length > MAX_FLOW_NODES) return fail(reply, 400, 1001, `a flow can hold at most ${MAX_FLOW_NODES} nodes`);
    const edges = request.body?.edges ?? [];
    const invalid = validateFlowGraph(nodes, edges);
    if (invalid) return success({ order: [], stages: [], error: invalid });
    const order = topologicalOrder(nodes, edges) ?? [];
    const stages = planStages(nodes, edges);
    return success({ order: order.map((node) => node.id), stages, error: undefined });
  });

  /**
   * The latest run of one node, whichever way it was produced.
   *
   * Deliberately not filtered to单步调试: after running the whole flow, the newest
   * evidence for a step is its flow run, and showing the older single-step result
   * instead makes the drawer look stale in exactly the moment it matters most.
   *
   * Since P2-2 this is two sources in one answer: HTTP nodes keep their evidence
   * in `executions`, while database / script / condition nodes record it as
   * generic steps under this flow's indexes — both are newest-first and merged
   * so the drawer reads the same shape it did before.
   */
  app.get<{ Params: { id: string; flowId: string }; Querystring: { nodeId?: string } }>("/api/v1/projects/:id/flows/:flowId/nodes/executions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.flowId)) return fail(reply, 404, 2001, "flow not found");
    const nodeId = request.query.nodeId?.trim();
    if (!nodeId) return fail(reply, 400, 1001, "nodeId is required");
    const [httpRuns, genericSteps] = await Promise.all([
      pool.query(
        /* Either a step of a run of this flow, or a single-step debug of this node.
           A debug carries no flow_execution_id, so it is matched by node id and the
           flow it belongs to via the join below. */
        `SELECT executions.* FROM executions
           LEFT JOIN flow_executions ON flow_executions.id = executions.flow_execution_id
          WHERE executions.project_id = $1 AND executions.flow_node_id = $2
            AND (flow_executions.flow_id = $3 OR executions.flow_execution_id IS NULL)
          ORDER BY executions.created_at DESC LIMIT 20`,
        [context.project.id, nodeId, request.params.flowId],
      ),
      pool.query(
        `SELECT steps.* FROM execution_steps steps
           JOIN execution_index idx ON idx.id = steps.index_id
          WHERE idx.kind = 'flow' AND idx.target_id = $1 AND steps.step_id = $2
            AND steps.parent_step_id IS NULL
          ORDER BY steps.created_at DESC LIMIT 20`,
        [request.params.flowId, nodeId],
      ),
    ]);
    /* Merged newest-first across both evidence kinds. */
    const merged = [
      ...httpRuns.rows.map(mapExecution),
      ...genericSteps.rows.map(mapExecutionStep),
    ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()).slice(0, 20);
    return success(merged, { total: merged.length });
  });

  /**
   * 一个容器步骤（loop / subflow）内部跑过的步骤（P2-6）。
   *
   * 单独一个端点而不是塞进 `/flow-executions/:id`：抽屉打开某个循环节点时才需要
   * 它的内层证据，而一个 100 次迭代 × 多节点循环体的嵌套行数可能比整条流程的顶层
   * 步骤多一个量级，默认随父详情一起返回会让运行面板变重。
   */
  app.get<{ Params: { id: string; stepId: string } }>("/api/v1/projects/:id/execution-steps/:stepId/children", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.stepId)) return fail(reply, 404, 2001, "execution step not found");
    /* 归属经父索引校验：步骤行本身不带 project_id。 */
    const owner = await pool.query(
      `SELECT steps.id FROM execution_steps steps
         JOIN execution_index idx ON idx.id = steps.index_id
        WHERE steps.id = $1 AND idx.project_id = $2`,
      [request.params.stepId, context.project.id],
    );
    if (!owner.rowCount) return fail(reply, 404, 2001, "execution step not found");
    const children = await pool.query(
      "SELECT * FROM execution_steps WHERE parent_step_id = $1 ORDER BY iteration NULLS FIRST, position, created_at",
      [request.params.stepId],
    );
    const httpIds = children.rows.map((row) => row.http_execution_id).filter(Boolean);
    /* 内层请求步骤的 HTTP 快照一起返回，抽屉才能直接展示响应而不用逐行再拉。 */
    const httpRuns = httpIds.length
      ? await pool.query("SELECT * FROM executions WHERE id = ANY($1::uuid[])", [httpIds])
      : { rows: [] };
    return success({
      steps: children.rows.map(mapExecutionStep),
      executions: httpRuns.rows.map(mapExecution),
    });
  });

  /**
   * The request definition a node starts from.
   *
   * A node can be seeded from an endpoint **or from a接口用例** — a case already
   * carries a working request plus its checks, which is usually closer to a flow
   * step than a bare endpoint definition. Resolved server-side so the snapshot
   * rule stays in one place: what comes back is a **copy**, and the node keeps
   * running it after the source is edited (交互文档 3.1.3 快照隔离).
   */
  app.get<{ Params: { id: string }; Querystring: { endpointId?: string; caseId?: string } }>("/api/v1/projects/:id/flows/node-source", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const { endpointId, caseId } = request.query;

    if (caseId) {
      if (!isUuid(caseId)) return fail(reply, 404, 2001, "case not found");
      const found = await pool.query("SELECT * FROM test_cases WHERE id = $1 AND project_id = $2", [caseId, context.project.id]);
      if (!found.rowCount) return fail(reply, 404, 2001, "case not found");
      const testCase = mapTestCase(found.rows[0]);
      return success({
        name: testCase.name,
        endpointId: testCase.endpointId,
        sourceCaseId: testCase.id,
        sourceCaseName: testCase.name,
        request: testCase.request,
        /* The case's rules come along: a step built from a case that silently
           dropped its checks would look identical and verify nothing.
           脚本引用要在这里「接手」：用例的匿名脚本属于那个用例、随它一起删，流程不能
           跟随它（保存时会报 belongs to another case）。公共脚本保持跟随，匿名脚本
           复制正文，让流程保存时建自己的那一份——计划 4.0.1 的 follow / copy。 */
        assertions: await adoptScriptRefs(context.project.id, testCase.assertions),
        preRequestHooks: await adoptScriptRefs(context.project.id, testCase.preRequestHooks),
        extracts: testCase.extracts,
        responseScripts: await adoptScriptRefs(context.project.id, testCase.responseScripts),
      });
    }

    if (!endpointId || !isUuid(endpointId)) return fail(reply, 404, 2001, "endpoint not found");
    const found = await pool.query("SELECT * FROM endpoints WHERE id = $1 AND project_id = $2", [endpointId, context.project.id]);
    if (!found.rowCount) return fail(reply, 404, 2001, "endpoint not found");
    const endpoint = mapEndpoint(found.rows[0]);
    return success({
      name: endpoint.name,
      endpointId: endpoint.id,
      sourceCaseId: undefined,
      sourceCaseName: undefined,
      request: {
        method: endpoint.method, url: endpoint.url,
        headers: endpoint.headers, queryParams: endpoint.queryParams, pathParams: endpoint.pathParams,
        bodyType: endpoint.bodyType, body: endpoint.body, bodyText: endpoint.bodyText,
        auth: endpoint.auth,
      },
      assertions: [],
      preRequestHooks: [],
      extracts: [],
      responseScripts: [],
    });
  });
}
