import { pool } from "../db.js";
import { inferOperationKind } from "./adapters/operations.js";
import { publishEvent } from "./events.js";
import { loadFlowBody } from "./flowRefs.js";
import { runGraph, TokenPool, type GraphContext } from "./flowGraph.js";
import { executeConditionNode, executeDatabaseNode, executeScriptNode, type PreparedFlowNode } from "./flowNodes.js";
import { loadEnvironment, type LoadedEnvironment } from "./run.js";
import { sanitizeValue } from "./sanitize.js";
import { topologicalOrder } from "./flow.js";
import { loadSqlDefinition } from "./dataSources.js";
import type { FlowEdge, FlowNode, FlowPlanStep, SqlParameterDefinition } from "../models/types.js";

export type FlowRunSpec = {
  nodes: PreparedFlowNode[];
  edges: FlowEdge[];
  environmentId?: string;
  variables: Record<string, string>;
};

const FLOW_TIMEOUT_MS = 10 * 60_000;
/**
 * 流程内并行上限（计划 5.0.2：默认 4、最大 10）。
 *
 * 这是整次执行的**全局令牌池**容量：叶子步骤（请求/SQL/脚本/条件/等待）取令牌，
 * loop/subflow 容器不取。所以嵌套三层不会把并发乘起来（4×4×4），容器也不会占着
 * 槽等自己的身体要槽。父任务仍占一个 BullMQ worker 槽。
 */
const FLOW_PARALLELISM = Math.min(10, Math.max(1, Number(process.env.FLOW_PARALLELISM ?? 4)));

/**
 * 在入队时把整张图冻成自包含的 run_spec。
 *
 * 递归三件事：内联脚本正文（与用例断言同一条复现规则）、解析命名 SQL、把子流程/
 * 循环体引用的内层流程整张加载并继续递归。内层图冻结的理由与内联脚本相同——入队后
 * 被改的子流程不能改变已经排队的这一次执行，执行记录必须描述真正跑过的那份定义。
 *
 * `chain` 是已进入的流程链（根在 0），循环引用和超深在这里被拒绝，而不是等 worker
 * 递归到栈溢出。
 */
export async function prepareFlowNodes(
  projectId: string,
  nodes: FlowNode[],
  chain: { id: string; name: string }[] = [],
): Promise<PreparedFlowNode[]> {
  return Promise.all(nodes.map(async (node): Promise<PreparedFlowNode> => {
    if (node.type === "database") {
      /* Database nodes keep their assertion/extract handling inside flowNodes,
         but the payload (SQL or mongo/redis operation) is resolved here because
         credentials must never ride along in run_spec. */
      const inferred: SqlParameterDefinition[] = Object.entries(node.parameters).map(([name, value]) => ({ name, type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : typeof value === "object" ? "json" : "string" }));
      if (!node.sqlDefinitionId) {
        if (node.operation) return { ...node, kind: inferOperationKind(node.operation), resolvedOperation: node.operation, parameterDefinitions: inferred };
        return { ...node, kind: "sql", resolvedSql: node.sql!, parameterDefinitions: inferred };
      }
      const definition = await loadSqlDefinition(projectId, node.sqlDefinitionId);
      if (!definition || definition.dataSourceId !== node.dataSourceId) throw new Error("database node SQL definition must belong to its data source and project");
      if (definition.kind === "sql") {
        /* The definition is the source of truth. A node only authors its own
           statementType in inline mode, so a present-but-different one is a real
           conflict, while an absent one simply adopts the definition's. */
        if (node.statementType && definition.statementType !== node.statementType) throw new Error("database node statementType does not match its SQL definition");
        return { ...node, kind: "sql", statementType: definition.statementType, resolvedSql: definition.sql, parameterDefinitions: definition.params };
      }
      /* A mongo/redis definition has no statementType: clear whatever the node
         kept from an earlier relational data source so the snapshot cannot imply
         a read-only guarantee the operation path does not make. */
      return { ...node, kind: definition.kind, statementType: undefined, resolvedOperation: definition.operation, parameterDefinitions: definition.params };
    }
    if (node.type === "subflow") {
      const body = await loadFlowBody(projectId, node, chain);
      const prepared: PreparedFlowNode = {
        ...node,
        body: {
          flowId: body.id, flowName: body.name, variables: body.variables, edges: body.edges,
          nodes: await prepareFlowNodes(projectId, body.nodes, [...chain, { id: body.id, name: body.name }]),
        },
      };
      return prepared;
    }
    if (node.type === "loop") {
      /* 循环体是内联子图，不是另一条流程：递归准备体内节点，链上不加新流程。
         循环体里可以有子流程节点——那个子流程的递归检测在下面的 prepareFlowNodes
         里按它自己的 chain 走。 */
      const bodyNodes = await prepareFlowNodes(projectId, node.body?.nodes ?? [], chain);
      /**
       * 画布容器 v1 不强制画体内连线：没连边就按数组顺序串成链，让体内步骤顺序执行，
       * 而不是全部同 stage 并行——循环体的直觉是「这几步依次做一遍」。
       *
       * 条件节点的出边不参与默认链：无法推断该走真还是假分支，生成一条无条件边会让
       * 条件静默失效（保存时的校验也会要求这种体内显式连线）。
       */
      const bodyEdges = (node.body?.edges?.length ? node.body.edges : bodyNodes.slice(1).flatMap((inner, index) => {
        const previous = bodyNodes[index];
        return previous.type === "condition" ? [] : [{ id: `__default_${node.id}_${inner.id}`, source: previous.id, target: inner.id }];
      })).filter((edge) => bodyNodes.some((inner) => inner.id === edge.source) && bodyNodes.some((inner) => inner.id === edge.target));
      const prepared: PreparedFlowNode = {
        ...node,
        body: {
          flowId: chain[0]?.id ?? node.id, flowName: node.name || "loop", variables: {},
          edges: bodyEdges,
          nodes: bodyNodes,
        },
      };
      return prepared;
    }
    return node;
  }));
}

export function planSteps(spec: FlowRunSpec): FlowPlanStep[] {
  const order = topologicalOrder(spec.nodes, spec.edges) ?? spec.nodes;
  return order.map((node) => ({ nodeId: node.id, name: node.name, type: node.type, endpointId: node.type === "request" ? node.endpointId : undefined }));
}

export async function performFlowRun(flowExecutionId: string, signal: AbortSignal, workerId?: string): Promise<boolean> {
  const claimed = await pool.query(
    `UPDATE flow_executions SET status = 'running', started_at = now(), worker_id = $2
      WHERE id = $1 AND status = 'queued' RETURNING *`,
    [flowExecutionId, workerId ?? null],
  );
  if (!claimed.rowCount) return false;

  const row = claimed.rows[0]; const projectId = String(row.project_id); const indexId = String(row.execution_index_id);
  const spec = row.run_spec as FlowRunSpec; const plan = (row.plan ?? []) as FlowPlanStep[];
  await pool.query("UPDATE execution_index SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued'", [indexId]);
  await publishEvent({ kind: "flow", projectId, flowExecutionId, executionIndexId: indexId, status: "running", total: Number(row.total), successCount: 0, failedCount: 0, skippedCount: 0 });

  let environment: LoadedEnvironment;
  try { environment = await loadEnvironment(projectId, spec.environmentId); }
  catch (error) {
    await finish(flowExecutionId, indexId, projectId, { status: "failed", successCount: 0, failedCount: 0, skippedCount: plan.length, error: error instanceof Error ? error.message : "environment could not be loaded", variables: {}, total: Number(row.total) });
    return true;
  }

  const bag: Record<string, string> = { ...environment.variables, ...(spec.variables ?? {}) };
  const deadline = AbortSignal.timeout(FLOW_TIMEOUT_MS);
  const tokens = new TokenPool(FLOW_PARALLELISM);

  const updateCounts = (counts: { success: number; failed: number; skipped: number }) => Promise.all([
    pool.query("UPDATE execution_index SET success_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $1 AND status = 'running'", [indexId, counts.success, counts.failed, counts.skipped]),
    pool.query("UPDATE flow_executions SET success_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $1 AND status = 'running'", [flowExecutionId, counts.success, counts.failed, counts.skipped]),
  ]);

  const ctx: GraphContext = {
    projectId, indexId, flowExecutionId,
    environment, environmentId: spec.environmentId, environmentName: row.environment_name ? String(row.environment_name) : undefined,
    signal, deadline, workerId, tokens,
    onProgress: async (counts) => {
      await updateCounts(counts);
      await publishEvent({ kind: "flow", projectId, flowExecutionId, executionIndexId: indexId, status: "running", total: Number(row.total), successCount: counts.success, failedCount: counts.failed, skippedCount: counts.skipped });
    },
  };

  const result = await runGraph(ctx, {
    flowId: row.flow_id ? String(row.flow_id) : flowExecutionId,
    flowName: String(row.flow_name),
    nodes: spec.nodes,
    edges: spec.edges,
    variables: spec.variables,
  }, bag);

  /* 最终变量袋只提交成功节点写回的（嵌套图已在容器节点聚合），按环境脱敏后落库。 */
  const variables = Object.fromEntries(Object.entries(result.produced).map(([key, value]) => [key, String(environment.storePlaintext ? value : sanitizeValue(value, environment.secretValues))]));

  await finish(flowExecutionId, indexId, projectId, {
    status: result.status,
    successCount: result.successCount,
    failedCount: result.failedCount,
    skippedCount: result.status === "canceled" ? Math.max(0, plan.length - result.successCount - result.failedCount) : result.skippedCount,
    error: result.error,
    variables,
    total: Number(row.total),
  });
  return true;
}

async function finish(
  flowExecutionId: string,
  indexId: string,
  projectId: string,
  result: { status: "success" | "failed" | "canceled"; successCount: number; failedCount: number; skippedCount: number; error?: string; variables: Record<string, string>; total: number },
) {
  const client = await pool.connect(); let settled = false;
  try {
    await client.query("BEGIN");
    const parent = await client.query(
      `UPDATE flow_executions SET status = $2, success_count = $3, failed_count = $4, skipped_count = $5, error = $6,
         variables = $7::jsonb, finished_at = now(), run_spec = NULL
       WHERE id = $1 AND status = 'running' RETURNING status`,
      [flowExecutionId, result.status, result.successCount, result.failedCount, result.skippedCount, result.error ?? null, JSON.stringify(result.variables)],
    );
    settled = Boolean(parent.rowCount);
    if (settled) await client.query(
      `UPDATE execution_index SET status = $2, success_count = $3, failed_count = $4, skipped_count = $5,
         canceled_count = $6, finished_at = now()
       WHERE id = $1 AND status = 'running'`,
      [indexId, result.status, result.successCount, result.failedCount, result.skippedCount, result.status === "canceled" ? Math.max(0, result.total - result.successCount - result.failedCount - result.skippedCount) : 0],
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await publishEvent({ kind: "flow", projectId, flowExecutionId, executionIndexId: indexId, status: settled ? result.status : "canceled", total: result.total, successCount: result.successCount, failedCount: result.failedCount, skippedCount: result.skippedCount });
}

/* Re-exported for routes that dispatch non-HTTP nodes directly. */
export { executeConditionNode, executeDatabaseNode, executeScriptNode };
export type { PreparedDatabaseFlowNode, PreparedFlowNode } from "./flowNodes.js";
