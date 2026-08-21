import { evaluateConditionGroup } from "./flow.js";
import { executeDatabaseWork } from "./databaseStep.js";
import { runScriptNode } from "./sandbox.js";
import { sanitizeValue } from "./sanitize.js";
import type { LoadedEnvironment } from "./run.js";
import type { DatabaseFlowNode, FlowEdge, FlowNode, LoopFlowNode, SqlParameterDefinition, SubflowFlowNode } from "../models/types.js";

/**
 * 单个流程节点的执行（叶子节点）。
 *
 * 从 `flowRun.ts` 拆出来，因为 P2-6 的循环/子流程节点要在**节点内部再跑一整张图**：
 * 调度器（`flowGraph.ts`）需要调用这些执行器，而循环/子流程执行器又需要调度器，
 * 两者放在一个文件里会让「一个节点怎么跑」和「一张图怎么排」互相纠缠。分开之后
 * 依赖是单向的：flowRun → flowGraph → flowNodes。
 *
 * 这里只放**不递归**的节点：数据库、脚本、条件、等待。循环与子流程在 flowGraph.ts，
 * 它们的实现本质上是「准备一个变量袋，然后 runGraph」。
 */

/** SQL resolved at enqueue time; credentials never enter `run_spec`. */
export type PreparedDatabaseFlowNode = DatabaseFlowNode & { resolvedSql: string; parameterDefinitions: SqlParameterDefinition[] };

/**
 * 一张已冻结的内层图（P2-6）。
 *
 * 子流程与循环体引用的流程在入队时被整张冻进 `run_spec`（含脚本正文），理由与
 * 内联脚本相同：入队之后被改的子流程不能改变已经排队的这一次执行。它**不是**
 * 快照隔离——下一次运行会读到改好的定义，因为子流程存在的意义就是一份定义多处复用。
 */
export type PreparedFlowGraph = {
  flowId: string;
  flowName: string;
  nodes: PreparedFlowNode[];
  edges: FlowEdge[];
  /** 内层流程自己的种子变量，作为调用方入参之下的默认值。 */
  variables: Record<string, string>;
};

export type PreparedSubflowFlowNode = SubflowFlowNode & { body: PreparedFlowGraph };
/** 循环体是画布上的内联子图：体内节点已准备（脚本内联、SQL 解析、再递归），
    edges 是体内连线。flowId/flowName 取所属流程的值，仅用于证据展示。 */
export type PreparedLoopFlowNode = LoopFlowNode & { body: PreparedFlowGraph };

export type PreparedFlowNode =
  | Exclude<FlowNode, DatabaseFlowNode | SubflowFlowNode | LoopFlowNode>
  | PreparedDatabaseFlowNode
  | PreparedSubflowFlowNode
  | PreparedLoopFlowNode;

/** 需要在节点内部再跑一张图的两类节点。 */
export type PreparedContainerNode = PreparedSubflowFlowNode | PreparedLoopFlowNode;

export function isContainerNode(node: PreparedFlowNode): node is PreparedContainerNode {
  return node.type === "subflow" || node.type === "loop";
}

/**
 * What one node produced, enough for the scheduler to judge, chain and record.
 */
export type NodeOutcome = {
  status: "success" | "failed";
  durationMs: number;
  error?: string;
  /** Sanitized evidence for `execution_steps.output_snapshot`. */
  output: Record<string, unknown>;
  /** Raw bag writes — the chaining channel, never the stored evidence. */
  produced: Record<string, string>;
  /** Set on a condition node; routes its `true`/`false` edges. */
  conditionResult?: boolean;
};

/** Masking is per-environment: a plaintext project keeps its evidence raw. */
export function masker(environment: LoadedEnvironment) {
  return (value: unknown) => (environment.storePlaintext ? value : sanitizeValue(value, environment.secretValues));
}

type DatabaseOutcome = {
  status: "success" | "failed";
  durationMs: number;
  error?: string;
  output: Record<string, unknown>;
  extracted: Record<string, string>;
  assertionVariables: Record<string, string>;
};

/**
 * 数据库节点。执行与断言实现在 `lib/databaseStep.ts`（计划 5.0.3 第 1 批）：
 * 同一条 SQL 不该在流程里通过而在别处失败。
 */
export async function executeDatabaseNode(projectId: string, node: PreparedDatabaseFlowNode, bag: Record<string, string>, environment: LoadedEnvironment): Promise<DatabaseOutcome> {
  const outcome = await executeDatabaseWork(projectId, {
    dataSourceId: node.dataSourceId, statementType: node.statementType, sql: node.resolvedSql,
    parameterDefinitions: node.parameterDefinitions, parameters: node.parameters, assertions: node.assertions ?? [],
  }, bag, environment, node.extracts ?? []);
  /* assertionVariables stayed in the shape after declarative assertions stopped
     writing variables (P2-2.1); kept empty rather than removed so the node's
     `produced` spread reads the same as it did. */
  return { ...outcome, assertionVariables: {} };
}

/**
 * 脚本节点 (P2-2): user JavaScript as a computation step over the variable bag.
 *
 * The sandbox contract is shared with assertions and hooks; the difference is
 * the output channel — a returned plain object and `ctx.setVariable` writes
 * both land in the bag, because producing values is the node's whole job.
 */
export async function executeScriptNode(node: Extract<PreparedFlowNode, { type: "script" }>, bag: Record<string, string>, environment: LoadedEnvironment): Promise<NodeOutcome> {
  const source = node.script?.content;
  if (!source) {
    return { status: "failed", durationMs: 0, error: "script content is missing", output: {}, produced: {} };
  }
  const outcome = runScriptNode(source, {
    variables: { ...bag },
    libraries: node.script?.libraries ?? [],
    /* Key material stays host-side, exactly as for hooks and assertions. */
    resolveSecret: (name) => environment.variables[name],
  });
  const mask = masker(environment);
  return {
    status: outcome.ok ? "success" : "failed",
    durationMs: 0,
    error: outcome.error,
    output: mask({
      logs: outcome.logs, debug: outcome.debug, checks: outcome.checks,
      returned: outcome.returned, error: outcome.error, variables: outcome.variables,
    }) as Record<string, unknown>,
    /* Raw values chain; the snapshot above is what gets stored. */
    produced: outcome.ok ? outcome.variables : {},
  };
}

/**
 * 条件节点 (P2-2): evaluate the rule group against the bag and route edges.
 *
 * A condition never "fails" — false is a valid decision. Its step record shows
 * every rule and the actual value it tested, so a branch that did not fire is
 * reviewable, not mysterious.
 */
export function executeConditionNode(node: Extract<PreparedFlowNode, { type: "condition" }>, bag: Record<string, string>, environment: LoadedEnvironment): NodeOutcome {
  const evaluated = evaluateConditionGroup(node.condition, bag);
  const mask = masker(environment);
  return {
    status: "success",
    durationMs: 0,
    output: mask({
      mode: node.condition.mode,
      rules: evaluated.rules.map(({ rule, actual, result }) => ({ ...rule, actual, result })),
      result: evaluated.result,
    }) as Record<string, unknown>,
    produced: {},
    conditionResult: evaluated.result,
  };
}

/**
 * 等待节点 (P2-6): sleeps this branch for a bounded time.
 *
 * Two properties are the whole design:
 *
 * 1. **有上限**。`waitMs` is capped by `MAX_WAIT_MS` at validation time, because
 *    a waiting node holds one of the run's concurrency tokens for its whole
 *    duration. 「等到某个条件成立」needs the suspend/resume model in 规范 3.2 and
 *    is not this node.
 * 2. **可被打断**。A cancel or the flow deadline resolves the sleep immediately
 *    and reports `canceled: true`, so stopping a run never has to wait out a
 *    sleep that is already pointless.
 */
export async function executeWaitNode(
  node: Extract<PreparedFlowNode, { type: "wait" }>,
  signals: AbortSignal[],
): Promise<NodeOutcome> {
  const startedAt = performance.now();
  const interrupted = await sleep(node.waitMs, signals);
  const durationMs = Math.round(performance.now() - startedAt);
  return {
    /* An interrupted wait is not a failure of the wait: the run is being torn
       down, and the parent decides the verdict. Reported as failed with the
       reason so the step row does not claim it slept the full budget. */
    status: interrupted ? "failed" : "success",
    durationMs,
    error: interrupted ? "wait interrupted because the run stopped" : undefined,
    output: { waitMs: node.waitMs, waitedMs: durationMs, interrupted },
    produced: {},
  };
}

/** Resolves `true` when one of the signals fired before the delay elapsed. */
function sleep(ms: number, signals: AbortSignal[]): Promise<boolean> {
  if (signals.some((signal) => signal.aborted)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (interrupted: boolean) => {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener("abort", onAbort);
      resolve(interrupted);
    };
    const onAbort = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
  });
}
