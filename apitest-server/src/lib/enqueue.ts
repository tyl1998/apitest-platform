import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { pool } from "../db.js";
import { publishEvent } from "./events.js";
import { CANCEL_CHANNEL, DEFAULT_RUNNER_LABEL, createRedis, executionQueue } from "./queue.js";
import { settleBatch, type RunSpec } from "./run.js";
import { FLOW_PARALLELISM } from "./flow.js";
import { planSteps, prepareFlowNodes, type FlowRunSpec } from "./flowRun.js";
import { inlineFlowNodeScripts, inlineHookContent, inlineResponseScriptContent, inlineScriptContent } from "./scripts.js";
import type { PreparedFlowNode } from "./flowNodes.js";
import { WORKER_OFFLINE_AFTER_SECONDS, type Assertion, type Execution, type FlowEdge, type FlowExtract, type FlowNode, type HookConfig, type RequestSnapshot, type ResponseScriptConfig, type SuiteExecutionConfig, type SuiteMemberSnapshot } from "../models/types.js";

/**
 * 目标分区没有在线执行器（P2-8 边界 5）。
 *
 * 一个**真错误类型**而不是一句字符串：分区化之后「队列挂了」与「这个分区根本没人服务」
 * 是两个完全不同的处置动作（去修 Redis / 去那个网段起一个 worker），调用方必须能分开。
 * 路由把它映射成错误码 `2004`，`data` 带 `label`。
 */
export class NoRunnerError extends Error {
  constructor(readonly label: string) {
    super(`no online execution worker serves partition "${label}"`);
    this.name = "NoRunnerError";
  }
}

/**
 * 这次执行该从哪个网段发出（P2-8）。
 *
 * 分区挂在**环境**上：环境选择链（用例绑定 → 接口默认 → 项目默认，计划 2.4）已经被
 * 用例/接口/流程/套件/批量调试共用，所以环境定了分区就定了，这里只是把它读出来。
 * 不使用环境的执行（`environmentId` 为空）走 `default`——它没有声明目标系统，只能由
 * 平台所在网段发出。
 */
export async function resolveRunnerLabel(environmentId?: string): Promise<string> {
  if (!environmentId) return DEFAULT_RUNNER_LABEL;
  const result = await pool.query("SELECT runner_label FROM environments WHERE id = $1", [environmentId]);
  /* 环境刚被删掉：按 default 走，让「队列里没有孤儿行」优先于精确路由。 */
  return result.rows[0]?.runner_label ? String(result.rows[0].runner_label) : DEFAULT_RUNNER_LABEL;
}

/**
 * 入队**之前**确认这个分区有在线执行器，没有就抛 `NoRunnerError`（P2-8 边界 4）。
 *
 * 这是本切片最容易漏、代价最高的一处。少了它，用户看到的是一条永远 `queued`、5 分钟后
 * 被回收判成 `execution abandoned by worker` 的记录——排查方向会完全跑偏到 worker 崩溃
 * 上，而事实是这个分区根本没有执行器。检查放在 `INSERT` **之前**，所以连补偿删除都不
 * 需要。
 *
 * 已知行为（不是 bug，不要去"修"）：某分区 worker 在**入队之后**掉线，那批行仍会在
 * 5 分钟后被 `reapStale` 判失败。这里的检查只挡新的，挡不住那种。
 */
async function requireOnlineRunner(label: string): Promise<void> {
  const result = await pool.query(
    `SELECT 1 FROM workers
      WHERE $1 = ANY(labels) AND last_seen_at > now() - ($2 || ' seconds')::interval
      LIMIT 1`,
    [label, WORKER_OFFLINE_AFTER_SECONDS],
  );
  if (!result.rowCount) throw new NoRunnerError(label);
}

export type EnqueueInput = {
  projectId: string;
  endpointId: string;
  endpointName: string;
  request: RequestSnapshot;
  environmentId?: string;
  environmentName?: string;
  source: Execution["source"];
  caseId?: string;
  caseName?: string;
  assertions?: Assertion[];
  batchId?: string;
  /** Set by a flow's单步调试 so the run says which node it came from. */
  flowNodeId?: string;
  flowNodeName?: string;
  /** Set by a flow单步调试 so the debug reports what it would have captured. */
  extracts?: FlowExtract[];
  /**
   * Extra variables layered over the environment, highest priority.
   *
   * Only单步调试 uses this today: a node normally reads values an upstream step
   * extracted, and run in isolation it has no upstream, so the caller supplies
   * the bag instead of the node being untestable on its own.
   */
  variables?: Record<string, string>;
  /**
   * 前置钩子, inlined at enqueue time so an edited signing script cannot change
   * what is already in the queue. Only单步调试 supplies these today; a flow run
   * carries its own via the node list.
   */
  hooks?: HookConfig[];
  /** Post-response scripts, frozen with the rest of the run definition. */
  responseScripts?: ResponseScriptConfig[];
  /**
   * 强制这一行落在某个执行分区（P2-8）。
   *
   * 只有套件成员用：一次套件执行整体落在一个分区（成员是进程内扇出的），成员必须继承
   * 套件入队时冻结的那个标签。让成员重新按自己的环境解析会在「入队之后环境改了标签」
   * 时写出一行本机 worker 认领不了的记录——而那台 worker 正拿着它准备就地跑。
   */
  runnerLabel?: string;
};

/**
 * 写下一行「排队中」的执行，不入队。
 *
 * 从 `enqueueRun` 里拆出来（P2-4.2）：套件成员在套件自己的 worker 槽内**进程内**执行，
 * 不给成员单独入队（计划 5.0.11 边界 2），但它仍然需要一模一样的一行 `executions`
 * ——同一套 run_spec 内联、同一套认领语义、同一份历史。两份 INSERT 必然在「哪些字段
 * 要快照」上分叉，所以只留这一份。
 *
 * 调用方要么随后 `queue.add`（`enqueueRun`），要么随后就地 `performRun`（套件成员）。
 *
 * 返回值带上解析出的分区标签（P2-8）：`enqueueRun` 要靠它选队列，套件成员要靠它判断
 * 「这个成员该不该由我这台 worker 就地跑」。
 */
export async function insertRun(input: EnqueueInput): Promise<{ executionId: string; runnerLabel: string }> {
  const executionId = randomUUID();
  /**
   * Script bodies are inlined here, not read at execution time (计划 4.0.1).
   *
   * `run_spec` is a self-contained snapshot and a worker reads exactly one row,
   * so resolving now is what makes a run reproducible: a followed public script
   * edited between enqueue and execution must not change what is already in the
   * queue, and the recorded result must describe the code that actually ran.
   * Cleared with the rest of `run_spec` on the terminal write.
   */
  const assertions = await inlineScriptContent(input.projectId, input.assertions ?? []);
  const hooks = await inlineHookContent(input.projectId, input.hooks);
  const responseScripts = await inlineResponseScriptContent(input.projectId, input.responseScripts);
  const spec: RunSpec = { request: input.request, environmentId: input.environmentId, assertions, variables: input.variables, extracts: input.extracts, hooks, responseScripts };
  /* 标签在行上快照一份（P2-8 边界 1）：环境改标签或被删后，认领与取消仍要靠这一列
     找到当初那条队列，历史也要说清这次执行从哪个网段跑的。套件成员显式继承套件的标签
     （见 `EnqueueInput.runnerLabel`）。 */
  const runnerLabel = input.runnerLabel ?? await resolveRunnerLabel(input.environmentId);

  await pool.query(
    `INSERT INTO executions (
       id, project_id, endpoint_id, endpoint_name, environment_id, environment_name, batch_id,
       source, case_id, case_name, flow_node_id, flow_node_name, status, duration_ms, request_snapshot, run_spec, runner_label
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'queued', 0, $13::jsonb, $14::jsonb, $15)`,
    [
      executionId, input.projectId, input.endpointId, input.endpointName,
      input.environmentId ?? null, input.environmentName ?? null, input.batchId ?? null,
      input.source, input.caseId ?? null, input.caseName ?? null,
      input.flowNodeId ?? null, input.flowNodeName ?? null,
      /**
       * The un-interpolated definition, so a queued run already shows what it
       * will send. `{{var}}` is still literal here, which is also why no secret
       * can leak: interpolation happens in the worker, where masking is known.
       */
      JSON.stringify({ method: input.request.method, url: input.request.url, query: input.request.queryParams, headers: input.request.headers }),
      JSON.stringify(spec),
      runnerLabel,
    ],
  );
  return { executionId, runnerLabel };
}

/**
 * Records a run as queued and hands it to a worker (P1-3).
 *
 * The row is written first so the client can read the execution the instant the
 * request returns; the job then carries nothing but its id.
 *
 * Ordering matters and cannot be made atomic across Postgres and Redis, so it
 * is arranged to fail safe: if `queue.add` throws, the row is deleted and the
 * caller sees an error. The opposite order would leave a job pointing at a row
 * that does not exist yet.
 *
 * 分区在线检查排在**最前面**（P2-8 边界 4）：目标分区没有在线执行器时一行都不写，
 * 因此不需要补偿删除，用户也看不到一条 5 分钟后才被判死的假排队记录。
 */
export async function enqueueRun(input: EnqueueInput): Promise<string> {
  await requireOnlineRunner(await resolveRunnerLabel(input.environmentId));
  const { executionId, runnerLabel } = await insertRun(input);

  try {
    /* jobId = executionId so a cancel can find the job without a second lookup. */
    await executionQueue(runnerLabel).add("run", { executionId }, { jobId: executionId });
  } catch (error) {
    /* No worker will ever claim it, so the row would sit at 'queued' forever. */
    await pool.query("DELETE FROM executions WHERE id = $1", [executionId]);
    throw new Error(error instanceof Error ? `execution queue unavailable: ${error.message}` : "execution queue unavailable");
  }

  await publishEvent({
    kind: "execution", projectId: input.projectId, executionId, status: "queued",
    endpointId: input.endpointId, batchId: input.batchId, caseId: input.caseId,
  });
  return executionId;
}

let canceller: Redis | undefined;

/** Tells whichever worker holds this run to abort its in-flight request. */
async function signalCancel(executionIds: string[]) {
  if (!executionIds.length) return;
  canceller ??= createRedis();
  await Promise.all(executionIds.map((id) => canceller!.publish(CANCEL_CHANNEL, id)));
}

/**
 * Cancels one run.
 *
 * Both halves are needed and neither is sufficient alone: the UPDATE stops a
 * queued run from ever starting, because `performRun` claims on
 * `status = 'queued'`; the published signal is the only way to abort a request
 * already in flight inside a worker process.
 *
 * Returns false when the run is already terminal, which the route reports as a
 * conflict rather than pretending the cancel did something.
 */
export async function cancelRun(projectId: string, executionId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE executions SET status = 'canceled', error = 'canceled by user', finished_at = now(), run_spec = NULL
      WHERE id = $1 AND project_id = $2 AND status IN ('queued', 'running')
      RETURNING batch_id, endpoint_id, case_id, runner_label`,
    [executionId, projectId],
  );
  if (!result.rowCount) return false;

  /* Dropping the job frees the slot a canceled-while-queued run would occupy.
     队列按分区分裂后必须用**行上的**标签找队列（P2-8 边界 1）：回查 environment 会在
     标签被改之后找错队列，而这个 job 还躺在老队列里。 */
  const row = result.rows[0];
  try { await executionQueue(String(row.runner_label)).remove(executionId); } catch { /* already claimed — the signal below stops it */ }
  await signalCancel([executionId]);

  await publishEvent({
    kind: "execution", projectId, executionId, status: "canceled",
    endpointId: String(row.endpoint_id),
    batchId: row.batch_id ? String(row.batch_id) : undefined,
    caseId: row.case_id ? String(row.case_id) : undefined,
  });
  if (row.batch_id) await settleBatch(String(row.batch_id), projectId);
  return true;
}

/**
 * Cancels every unfinished run in a batch.
 *
 * One UPDATE rather than a loop of `cancelRun`: a batch of 100 would otherwise
 * re-aggregate the batch 100 times and emit 100 events for what the user did
 * once.
 */
export async function cancelBatch(projectId: string, batchId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE executions SET status = 'canceled', error = 'canceled by user', finished_at = now(), run_spec = NULL
      WHERE batch_id = $1 AND project_id = $2 AND status IN ('queued', 'running')
      RETURNING id, runner_label`,
    [batchId, projectId],
  );
  const ids = result.rows.map((row) => String(row.id));
  /* 一批里的行可以分属不同分区（批量调试按各接口的默认环境解析），所以逐行按它自己的
     标签找队列，不能假定整批同一条。 */
  await Promise.all(result.rows.map(async (row) => { try { await executionQueue(String(row.runner_label)).remove(String(row.id)); } catch { /* already claimed */ } }));
  await signalCancel(ids);
  await settleBatch(batchId, projectId);
  return ids.length;
}

export type EnqueueFlowInput = {
  projectId: string;
  flowId?: string;
  flowName: string;
  environmentId?: string;
  environmentName?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  variables: Record<string, string>;
  /** 同 `EnqueueInput.runnerLabel`：套件的流程成员继承套件冻结的分区。 */
  runnerLabel?: string;
};

/**
 * 请求节点声明的并发不能超过一次执行的令牌预算。
 *
 * P2-4.2 起 N 枚令牌是**原子领取**的（凑不齐整批等），所以 N > 池容量就是永远凑不齐
 * ——必须在入队时当场拒绝，不能等执行到那一步再报。保存时也校验（lib/flow.ts
 * `validateNode`），这里是第二道：`FLOW_PARALLELISM` 是可配置的，一份先前存下来的
 * 流程完全可能在预算被调小之后才被运行。
 *
 * 递归进 loop / subflow 的内层图：内层的请求节点向**同一个**池子领令牌。
 */
function overLeafBudget(nodes: PreparedFlowNode[]): string | undefined {
  for (const node of nodes) {
    if (node.type === "request" && (node.concurrency ?? 1) > FLOW_PARALLELISM) {
      return `"${node.name}" declares ${node.concurrency} concurrent requests, over this platform's per-run budget of ${FLOW_PARALLELISM}`;
    }
    if (node.type === "loop" || node.type === "subflow") {
      const inner = overLeafBudget(node.body.nodes);
      if (inner) return inner;
    }
  }
  return undefined;
}

/**
 * 写下一次「排队中」的流程执行（父索引 + 明细行），不入队。
 *
 * 从 `enqueueFlowRun` 里拆出来（P2-4.2）：套件的流程成员在套件的槽内进程内执行，
 * 但它必须是**该流程的一次正式运行**（计划 5.0.11 边界 6）——同一份 run_spec 冻结、
 * 同一行 execution_index、出现在流程自己的运行记录里。
 */
export async function insertFlowRun(input: EnqueueFlowInput): Promise<{ flowExecutionId: string; executionIndexId: string; total: number; runnerLabel: string }> {
  const flowExecutionId = randomUUID();
  /* 节点断言可以引用公共脚本，与用例同理必须在入队时内联：入队后被改的公共
     脚本不能改变已经排队的这一次执行。钩子脚本同一条原则——签名脚本入队后被
     改，会让这次执行签出已经不属于它的串。子流程/循环体的内层图走同一个函数
     （lib/flowRefs.ts 调用），两份实现必然在「哪种节点的哪个槽位有脚本」上分叉。 */
  const scriptedNodes = await inlineFlowNodeScripts(input.projectId, input.nodes);
  const nodes = await prepareFlowNodes(input.projectId, scriptedNodes);
  const overBudget = overLeafBudget(nodes);
  if (overBudget) throw new Error(overBudget);
  const spec: FlowRunSpec = { nodes, edges: input.edges, environmentId: input.environmentId, variables: input.variables };
  const plan = planSteps(spec);
  const executionIndexId = randomUUID();
  /* 分区标签快照（P2-8 边界 1）：流程的每一步 HTTP 证据都由持有这次流程执行的那个
     worker 就地发出，所以整条流程共用流程自己这一个分区，步骤不再单独路由。 */
  const runnerLabel = input.runnerLabel ?? await resolveRunnerLabel(input.environmentId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO execution_index (id, project_id, kind, target_id, target_name, detail_id, status, total)
       VALUES ($1, $2, 'flow', $3, $4, $5, 'queued', $6)`,
      [executionIndexId, input.projectId, input.flowId ?? null, input.flowName, flowExecutionId, plan.length],
    );
    await client.query(
      `INSERT INTO flow_executions (
         id, project_id, flow_id, flow_name, environment_id, environment_name,
         status, total, plan, run_spec, execution_index_id, runner_label
       ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [flowExecutionId, input.projectId, input.flowId ?? null, input.flowName, input.environmentId ?? null, input.environmentName ?? null, plan.length, JSON.stringify(plan), JSON.stringify(spec), executionIndexId, runnerLabel],
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  return { flowExecutionId, executionIndexId, total: plan.length, runnerLabel };
}

/**
 * Records a flow run as queued and hands it to a worker (P1-2).
 *
 * Same shape and same failure ordering as `enqueueRun`, deliberately: a flow is
 * another thing a worker picks up by id, so it inherits cancel, reaping and
 * at-most-once claiming without a second mechanism.
 */
export async function enqueueFlowRun(input: EnqueueFlowInput): Promise<string> {
  /* 同 `enqueueRun`：分区没有在线执行器就一行都不写（P2-8 边界 4）。 */
  await requireOnlineRunner(await resolveRunnerLabel(input.environmentId));
  const { flowExecutionId, executionIndexId, total, runnerLabel } = await insertFlowRun(input);

  try {
    await executionQueue(runnerLabel).add("flow", { flowExecutionId }, { jobId: flowExecutionId });
  } catch (error) {
    /* 同 enqueueRun：没有 worker 会来认领，留着就是一行永远排队的记录。 */
    await pool.query("DELETE FROM execution_index WHERE id = $1", [executionIndexId]);
    await pool.query("DELETE FROM flow_executions WHERE id = $1", [flowExecutionId]);
    throw new Error(error instanceof Error ? `execution queue unavailable: ${error.message}` : "execution queue unavailable");
  }

  await publishEvent({
    kind: "flow", projectId: input.projectId, flowExecutionId, executionIndexId, status: "queued",
    total, successCount: 0, failedCount: 0, skippedCount: 0,
  });
  return flowExecutionId;
}

/**
 * Cancels a flow run and whatever step it had in flight.
 *
 * Both ids are signalled: the flow id stops the loop from starting another
 * step, the step id aborts the request already inside `fetch`. Signalling only
 * the flow would leave the current step running to completion.
 */
export async function cancelFlowRun(projectId: string, flowExecutionId: string): Promise<boolean> {  const client = await pool.connect(); let parent: Record<string, unknown> | undefined; let stepIds: string[] = [];
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE flow_executions SET status = 'canceled', error = 'canceled by user', finished_at = now(), run_spec = NULL
        WHERE id = $1 AND project_id = $2 AND status IN ('queued', 'running')
        RETURNING total, success_count, failed_count, execution_index_id, runner_label`,
      [flowExecutionId, projectId],
    );
    if (!result.rowCount) { await client.query("ROLLBACK"); return false; }
    parent = result.rows[0];
    const parentRow = result.rows[0] as Record<string, unknown>;
    const steps = await client.query(
      `UPDATE executions SET status = 'canceled', error = 'canceled by user', finished_at = now(), run_spec = NULL
        WHERE flow_execution_id = $1 AND project_id = $2 AND status IN ('queued', 'running') RETURNING id`,
      [flowExecutionId, projectId],
    );
    stepIds = steps.rows.map((row) => String(row.id));
    const indexId = parentRow.execution_index_id;
    const genericSteps = await client.query(
      `UPDATE execution_steps SET status = 'canceled', error = 'canceled by user', finished_at = now()
        WHERE index_id = $1 AND status IN ('queued', 'running') RETURNING parent_step_id`, [indexId],
    );
    /* 只统计顶层步骤：嵌套步骤是 loop/subflow 容器内部的证据，父级计数不算它们，
       否则一个 20 次迭代的循环会把 canceled_count 撑到 total 之外。 */
    const canceledCount = genericSteps.rows.filter((row) => row.parent_step_id === null).length;
    const skippedCount = Math.max(0, Number(parentRow.total) - Number(parentRow.success_count) - Number(parentRow.failed_count) - canceledCount);
    await client.query("UPDATE flow_executions SET skipped_count = $2 WHERE id = $1", [flowExecutionId, skippedCount]);
    await client.query(
      `UPDATE execution_index SET status = 'canceled', canceled_count = $2, skipped_count = $3, finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`, [indexId, canceledCount, skippedCount],
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }

  try { await executionQueue(String(parent!.runner_label)).remove(flowExecutionId); } catch { /* already claimed — the signal below stops it */ }
  await signalCancel([flowExecutionId, ...stepIds]);

  const row = parent!;
  const successCount = Number(row.success_count);
  const failedCount = Number(row.failed_count);
  await publishEvent({
    kind: "flow", projectId, flowExecutionId, executionIndexId: String(row.execution_index_id), status: "canceled",
    total: Number(row.total), successCount, failedCount,
    skippedCount: Math.max(0, Number(row.total) - successCount - failedCount),
  });
  return true;
}

export type EnqueueSuiteInput = {
  projectId: string;
  suiteId?: string;
  suiteName: string;
  /** 只有 environmentStrategy='override' 时有值，用于套件级环境覆盖。 */
  environmentId?: string;
  environmentName?: string;
  /** 入队这一刻解析并冻结的成员清单：tag/all 是动态选择，报告要可复现就必须冻结。 */
  members: SuiteMemberSnapshot[];
  execution: SuiteExecutionConfig;
};

/**
 * 一次套件执行落在哪个分区（P2-8）。
 *
 * 套件的成员是**进程内扇出**的（计划 5.0.11 边界 2）：它们由持有这一个 job 的那台
 * worker 就地发请求。而 worker 只能从自己所在网段出站，所以一次套件执行必然整体落在
 * 同一个分区上——这不是可以放宽的实现细节。
 *
 * - `override`：套件级环境说了算，成员环境不参与。
 * - `member_default`：取成员环境的标签集合。**跨分区直接拒绝**，而不是挑一个跑：挑一个
 *   就意味着另一半成员从错误的网段发出，得到的失败会被读成「被测服务挂了」。让用户改成
 *   两个套件，比给一份混着两个网段结论的报告诚实。
 */
async function resolveSuiteRunnerLabel(input: EnqueueSuiteInput): Promise<string> {
  if (input.execution.environmentStrategy === "override") return resolveRunnerLabel(input.environmentId);
  const labels = new Set<string>();
  for (const member of input.members) labels.add(await resolveRunnerLabel(member.environmentId));
  if (labels.size > 1) {
    throw new Error(`this suite spans execution partitions (${[...labels].sort().join(", ")}); a suite runs inside one worker, so split it or set a suite-level environment`);
  }
  return labels.values().next().value ?? DEFAULT_RUNNER_LABEL;
}

/**
 * Records a suite run as queued and hands it to a worker (P2-4.2).
 *
 * 与 `enqueueFlowRun` 同形同序：父索引 + 明细行一个事务写下，再入队，`queue.add` 抛错
 * 就把两行删掉。**成员不在这里入队**——它们在 worker 认领这一个 job 之后进程内扇出
 * （计划 5.0.11 边界 2）。
 */
export async function enqueueSuiteRun(input: EnqueueSuiteInput): Promise<string> {
  const runnerLabel = await resolveSuiteRunnerLabel(input);
  /* 同 `enqueueRun`：分区没有在线执行器就一行都不写（P2-8 边界 4）。 */
  await requireOnlineRunner(runnerLabel);
  const suiteExecutionId = randomUUID();
  const executionIndexId = randomUUID();
  const total = input.members.length;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO execution_index (id, project_id, kind, target_id, target_name, detail_id, status, total)
       VALUES ($1, $2, 'suite', $3, $4, $5, 'queued', $6)`,
      [executionIndexId, input.projectId, input.suiteId ?? null, input.suiteName, suiteExecutionId, total],
    );
    await client.query(
      `INSERT INTO suite_executions (
         id, project_id, suite_id, suite_name, environment_id, environment_name,
         status, total, member_snapshot, run_spec, execution_index_id, runner_label
       ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        suiteExecutionId, input.projectId, input.suiteId ?? null, input.suiteName,
        input.environmentId ?? null, input.environmentName ?? null,
        total, JSON.stringify(input.members), JSON.stringify(input.execution), executionIndexId, runnerLabel,
      ],
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }

  try {
    await executionQueue(runnerLabel).add("suite", { suiteExecutionId }, { jobId: suiteExecutionId });
  } catch (error) {
    /* 同 enqueueRun：没有 worker 会来认领，留着就是一行永远排队的记录。 */
    await pool.query("DELETE FROM execution_index WHERE id = $1", [executionIndexId]);
    await pool.query("DELETE FROM suite_executions WHERE id = $1", [suiteExecutionId]);
    throw new Error(error instanceof Error ? `execution queue unavailable: ${error.message}` : "execution queue unavailable");
  }

  await publishEvent({
    kind: "suite", projectId: input.projectId, suiteExecutionId, executionIndexId, status: "queued",
    total, successCount: 0, failedCount: 0, skippedCount: 0,
  });
  return suiteExecutionId;
}

/**
 * Cancels a suite run, its member evidence, and whatever each member had running.
 *
 * 三层都要动，缺一层就会留下「父级已取消、子级还在发请求」：
 *
 * 1. 套件父行与它的成员证据行（`execution_steps`）落 canceled——排队中的成员因此永远
 *    不会开跑（`performSuiteRun` 的循环每次取成员前都看 signal，收尾写入也带
 *    `status = 'running'` 守卫）。
 * 2. 在途成员各自取消：用例成员是一行 `executions`（`cancelRun`），流程成员是一次完整
 *    的父执行（`cancelFlowRun`）。复用这两个函数而不是自己写 UPDATE，是因为它们各自
 *    还要广播中断信号、清队列、发事件——重写一遍必然漏掉其中一件。
 * 3. 广播套件自己的 id：中断在途请求靠的是持有者进程内的 AbortController。
 */
export async function cancelSuiteRun(projectId: string, suiteExecutionId: string): Promise<boolean> {
  const client = await pool.connect();
  let parent: Record<string, unknown> | undefined;
  let canceledCount = 0;
  let httpExecutionIds: string[] = [];
  let childFlowExecutionIds: string[] = [];
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE suite_executions SET status = 'canceled', error = 'canceled by user', finished_at = now(), run_spec = NULL
        WHERE id = $1 AND project_id = $2 AND status IN ('queued', 'running')
        RETURNING total, success_count, failed_count, execution_index_id, runner_label`,
      [suiteExecutionId, projectId],
    );
    if (!result.rowCount) { await client.query("ROLLBACK"); return false; }
    parent = result.rows[0];
    const parentRow = result.rows[0] as Record<string, unknown>;
    const indexId = parentRow.execution_index_id;
    /* 成员证据行连同它们指向的子执行一起取出来。 */
    const members = await client.query(
      `UPDATE execution_steps SET status = 'canceled', error = 'canceled by user', finished_at = now()
        WHERE index_id = $1 AND status IN ('queued', 'running')
        RETURNING id, http_execution_id, child_index_id`,
      [indexId],
    );
    canceledCount = members.rowCount ?? 0;
    httpExecutionIds = members.rows.filter((row) => row.http_execution_id).map((row) => String(row.http_execution_id));
    /* 流程成员要取消的是**那次流程执行**，而 child_index_id 只是它的父索引，所以再翻
       一次 detail_id——`cancelFlowRun` 认的是 flow_executions.id。 */
    const childIndexIds = members.rows.filter((row) => row.child_index_id).map((row) => String(row.child_index_id));
    if (childIndexIds.length) {
      const children = await client.query("SELECT detail_id FROM execution_index WHERE id = ANY($1::uuid[])", [childIndexIds]);
      childFlowExecutionIds = children.rows.map((row) => String(row.detail_id));
    }
    const skippedCount = Math.max(0, Number(parentRow.total) - Number(parentRow.success_count) - Number(parentRow.failed_count) - canceledCount);
    await client.query("UPDATE suite_executions SET skipped_count = $2 WHERE id = $1", [suiteExecutionId, skippedCount]);
    await client.query(
      `UPDATE execution_index SET status = 'canceled', canceled_count = $2, skipped_count = $3, finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`, [indexId, canceledCount, skippedCount],
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }

  try { await executionQueue(String(parent!.runner_label)).remove(suiteExecutionId); } catch { /* already claimed — the signal below stops it */ }
  /* 先广播套件自己的 id：`performSuiteRun` 由此立刻停止启动新成员，下面逐个取消在途
     成员的过程中就不会有人再往里加。 */
  await signalCancel([suiteExecutionId]);
  for (const executionId of httpExecutionIds) await cancelRun(projectId, executionId);
  for (const flowExecutionId of childFlowExecutionIds) await cancelFlowRun(projectId, flowExecutionId);

  const row = parent!;
  const successCount = Number(row.success_count);
  const failedCount = Number(row.failed_count);
  await publishEvent({
    kind: "suite", projectId, suiteExecutionId, executionIndexId: String(row.execution_index_id), status: "canceled",
    total: Number(row.total), successCount, failedCount,
    skippedCount: Math.max(0, Number(row.total) - successCount - failedCount - canceledCount),
  });
  return true;
}
