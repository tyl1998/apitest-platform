import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { publishEvent } from "./events.js";
import { registerInflight, releaseInflight } from "./inflight.js";
import { MAX_LOOP_CONCURRENCY, MAX_LOOP_ITERATIONS } from "./flow.js";
import { executeRequest, settleExecution, type LoadedEnvironment } from "./run.js";
import { executeConditionNode, executeDatabaseNode, executeScriptNode, executeWaitNode, isContainerNode, masker, type NodeOutcome, type PreparedFlowGraph, type PreparedFlowNode, type PreparedLoopFlowNode, type PreparedSubflowFlowNode } from "./flowNodes.js";
import { resolveDeep } from "./resolve.js";
import type { FlowEdgeCondition } from "../models/types.js";

/**
 * P2-6 的图执行器。
 *
 * 从 P2-2 的 `performFlowRun` 里抽出来的 ready-set 分层调度主体。抽出本身不是
 * 重构秀：循环与子流程都是「在一个节点内部再跑一整张图」，它们需要**同一套**
 * 调度语义（同层受控并行、边条件、跳过传播、同名写冲突稳定失败），而不是第二份
 * 实现——两套语义的结果必然是「同一条链路在外层并行、抽成子流程后变串行」这种
 * 说不清的行为差异。
 *
 * 一个执行共享一个并发令牌池（`TokenPool`，大小 `FLOW_PARALLELISM`；套件执行时是
 * 套件那一个池子，容量 `SUITE_LEAF_BUDGET`）：**叶子步骤**（请求/SQL/脚本/条件/等待）
 * 取令牌，loop/subflow **容器节点不取**。于是三层嵌套的真实并发仍被单次执行的预算
 * 封顶，而不是 4×4×4；容器不持令牌也就不会出现「容器占着槽等自己的身体要槽」的自锁。
 * 循环的 `concurrency` 是形状声明，用一个**局部信号量**实现（不碰全局容量）；请求节点
 * 的 `concurrency` 则是**原子领取**——N 枚令牌一次凑齐，凑不齐整批等。
 *
 * 嵌套步骤的证据（P2-6）写进同一张 execution_steps，用 `parent_step_id` 指回容器
 * 步骤行、`iteration` 记录第几次迭代——所以一次失败的循环可复盘到具体是哪个内层
 * 请求失败。父级计数仍只统计顶层步骤。
 */

/** 一次流程执行共享的执行环境与预算。 */
export type GraphContext = {
  projectId: string;
  indexId: string;
  /** 顶层流程执行 id；嵌套步骤的 HTTP 证据也挂在它下面（来源=flow_step）。 */
  flowExecutionId?: string;
  environment: LoadedEnvironment;
  environmentId?: string;
  environmentName?: string;
  /** 用户取消。 */
  signal: AbortSignal;
  /** 流程总超时（FLOW_TIMEOUT_MS）。 */
  deadline: AbortSignal;
  workerId?: string;
  tokens: TokenPool;
  /**
   * 触发人（P11 边界 11）：流程节点落 `executions` 行的证据也要能答「谁触发的」。
   * 由 `performFlowRun` 从父 `execution_index.triggered_by` 读一次后随上下文下发——
   * 每个节点各查一次库没有意义，而 NULL（定时 / Webhook / 非人 CI）是合法值。
   */
  triggeredBy?: string | null;
  /** 顶层进度回调；嵌套图不传（计数归容器节点，不进父级）。 */
  onProgress?: (counts: { success: number; failed: number; skipped: number }) => void;
};

/** 一次 runGraph 的终态与计数，供顶层收尾、容器节点聚合。 */
export type GraphResult = {
  status: "success" | "failed" | "canceled";
  successCount: number;
  failedCount: number;
  skippedCount: number;
  error?: string;
  /** 成功节点写回的原始变量（未脱敏），给顶层 finish 或容器 outputs 过滤。 */
  produced: Record<string, string>;
};

/**
 * 整次执行共享的并发令牌池。
 *
 * `capacity` 固定为 `FLOW_PARALLELISM`，**运行期不可变**：容量是这次执行允许的
 * 真实在飞叶子数，任何「某个节点想更并发」都不该偷偷抬高整体上限。
 *
 * 只有**叶子步骤**（请求/SQL/脚本/条件/等待）取令牌；loop / subflow 容器节点
 * **不取**。这条区分是死锁的分界线：容器持令牌 → 调内层图 → 内层叶子要令牌 →
 * 令牌被容器们占满 → 谁都跑不动。容器本身不消耗 CPU/连接，它只是在等自己的
 * 身体，所以不该占额度。
 */
export class TokenPool {
  private readonly capacity: number;
  private free: number;
  /** 一条队列，按到达顺序服务；`need` 是这个等待者要几枚。 */
  private waiters: { need: number; resolve: () => void }[] = [];

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.free = this.capacity;
  }

  get max() { return this.capacity; }

  /** 取一个令牌，没有就排队；释放函数幂等，重复调用不会多还令牌。 */
  async acquire(): Promise<() => void> {
    return this.acquireMany(1);
  }

  /**
   * 一次凑齐 `count` 枚令牌（P2-4.2）。
   *
   * 「同一接口并发 N」的用例本意是让服务端**真的同时**收到 N 个请求，所以 N 枚必须
   * 一起拿到再一起发。逐枚领的老做法在池子紧张时会把 `concurrency=3` 静默拆成 2+1
   * ——请求还是发了三次，但并发结论已经失真。
   *
   * 两个风险各自封死：
   * - **真死锁**（要的比池子还大，永远凑不齐）：直接抛错。保存与入队两处已按同一个
   *   预算校验过（lib/flow.ts `validateNode`、lib/enqueue.ts `insertFlowRun`），所以
   *   这里是最后一道，不静默降级。
   * - **饿死**（多枚请求永远排在单枚后面）：队列严格 FIFO 且**禁止插队**——队头凑不齐
   *   时，即使有空闲令牌也不发给后面的单枚请求。代价是攒令牌期间短暂空置几枚，空置
   *   窗口上限 = 最长在飞叶子寿命（请求 30s）。
   */
  async acquireMany(count: number): Promise<() => void> {
    const need = Math.max(1, Math.trunc(count));
    if (need > this.capacity) throw new Error(`cannot gather ${need} concurrency tokens: this run's budget is ${this.capacity}`);
    /* 队列非空时一律排队：能插队就等于没做禁插队，队头的多枚请求会被后面源源不断的
       单枚请求挤到永远。 */
    if (!this.waiters.length && this.free >= need) this.free -= need;
    else await new Promise<void>((resolve) => this.waiters.push({ need, resolve }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.free += need;
      this.drain();
    };
  }

  /** 只看队头：队头凑不齐就整队等着，宁可短暂空置也不越过它服务后面的人。 */
  private drain() {
    while (this.waiters.length && this.free >= this.waiters[0].need) {
      const next = this.waiters.shift()!;
      this.free -= next.need;
      next.resolve();
    }
  }
}

/**
 * 一个循环节点自己的并发窗口。
 *
 * 与 `TokenPool` 分开是修正了第一版的错误：第一版通过临时抬高全局 capacity 来
 * 实现循环并发，结果两个并发的循环互相踩保存/还原、并把池子永久放大。循环的
 * `concurrency` 只是**这个循环最多几次迭代同时在飞**的形状声明，真实并发仍由
 * 全局令牌池封顶——所以它是一个局部信号量，不碰全局容量。
 */
class Semaphore {
  private free: number;
  private waiters: (() => void)[] = [];
  constructor(size: number) { this.free = Math.max(1, size); }
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(); else this.free += 1;
    };
  }
}

const noop = () => {};

type RuntimeState = {
  node: PreparedFlowNode;
  status: "pending" | "ready" | "running" | "success" | "failed" | "skipped";
  remaining: number;
  activated: boolean;
  /** 1 + 最近激活前驱的 stage；同层兄弟共享。 */
  stage: number;
  /** 节点在图中声明下标——同名冲突的确定性裁决，不能改成按启动顺序。 */
  position: number;
  stepId?: string;
  httpExecutionId?: string;
  result?: NodeOutcome;
};

export async function runGraph(
  ctx: GraphContext,
  graph: PreparedFlowGraph,
  bag: Record<string, string>,
  opts: { parentStepId?: string; iteration?: number } = {},
): Promise<GraphResult> {
  const { nodes, edges } = graph;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const positionOf = new Map(nodes.map((node, at) => [node.id, at]));
  const graphLimit = ctx.tokens.max;

  const incoming = new Map<string, { source: string; on?: FlowEdgeCondition }[]>();
  const outgoing = new Map<string, { target: string; on?: FlowEdgeCondition }[]>();
  for (const node of nodes) { incoming.set(node.id, []); outgoing.set(node.id, []); }
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    incoming.get(edge.target)!.push({ source: edge.source, on: edge.on });
    outgoing.get(edge.source)!.push({ target: edge.target, on: edge.on });
  }

  const state = new Map<string, RuntimeState>();
  for (const node of nodes) {
    const inc = incoming.get(node.id)!;
    /* 源节点一开始就 ready；其余等边。 */
    state.set(node.id, {
      node, status: inc.length ? "pending" : "ready",
      remaining: inc.length, activated: inc.length === 0,
      stage: 0, position: positionOf.get(node.id) ?? 0,
    });
  }

  let successCount = 0; let failedCount = 0; let skippedCount = 0;
  let flowError: string | undefined; let stopped = false;
  const running = new Map<string, Promise<{ nodeId: string; result: NodeOutcome }>>();
  const conflictOwners = new Map<number, Map<string, string>>();
  const stageInputs = new Map<number, Record<string, string>>();
  const stageProducedInputs = new Map<number, Record<string, string>>();
  /* 嵌套图里只有顶层那个 produced 会写回，所以这里对本图是局部的。 */
  const produced: Record<string, string> = {};

  function edgeActivates(source: RuntimeState, on?: FlowEdgeCondition): boolean {
    if (on === "true" || on === "false") return source.result?.conditionResult === (on === "true");
    if (on === "failure") return source.status === "failed";
    return source.status === "success";
  }

  function nodeInput(node: PreparedFlowNode): Record<string, unknown> {
    if (node.type === "request") return { endpointId: node.endpointId, request: { method: node.request.method, url: node.request.url }, concurrency: node.concurrency ?? 1 };
    if (node.type === "database") return { dataSourceId: node.dataSourceId, sqlDefinitionId: node.sqlDefinitionId, statementType: node.statementType };
    if (node.type === "script") return { scriptId: node.script?.scriptId };
    if (node.type === "condition") return { mode: node.condition.mode, ruleCount: node.condition.rules.length };
    if (node.type === "wait") return { waitMs: node.waitMs };
    if (node.type === "subflow") return { flowId: node.flowId, flowName: node.body.flowName, inputs: node.inputs };
    return { mode: node.mode, count: node.count, listVariable: node.listVariable, concurrency: node.concurrency, bodyNodes: node.body.nodes.length, bodyEdges: node.body.edges.length };
  }

  async function insertSkippedStep(st: RuntimeState) {
    const id = randomUUID();
    st.stepId = id;
    await pool.query(
      `INSERT INTO execution_steps (id, index_id, step_id, step_type, step_name, status, stage, position, parent_step_id, iteration, input_snapshot, output_snapshot, finished_at)
       VALUES ($1, $2, $3, $4, $5, 'skipped', $6, $7, $8, $9, $10::jsonb, '{}'::jsonb, now())`,
      [id, ctx.indexId, st.node.id, st.node.type, st.node.name, st.stage, st.position, opts.parentStepId ?? null, opts.iteration ?? null, JSON.stringify(nodeInput(st.node))],
    );
  }

  /**
   * 发一次请求并落证据。
   *
   * `container` 存在且 `iteration` 给定（请求并发 > 1）时，这次请求是自己的一个
   * **子步骤行**：请求节点自己那行是容器，N 次并发各挂一行证据（iteration = 下标），
   * 提取按迭代序收集成数组——与循环出参同一套语义，证据也同构。
   *
   * 普通单次请求（包括循环体内的单次请求）直接把 `http_execution_id` 挂到
   * `containerStepId` 自己那行上，不再额外创建子步骤。
   */
  async function executeRequestStep(
    ctx: GraphContext,
    node: PreparedFlowNode & { type: "request" },
    inputBag: Record<string, string>,
    containerStepId: string | undefined,
    stage: number,
    position: number,
    iteration?: number,
  ): Promise<NodeOutcome> {
    const executionId = randomUUID();
    const childStepId = containerStepId && iteration !== undefined ? randomUUID() : undefined;
    await pool.query(
      `INSERT INTO executions (
         id, project_id, endpoint_id, endpoint_name, environment_id, environment_name,
         source, flow_execution_id, flow_node_id, flow_node_name,
         status, duration_ms, request_snapshot, started_at, worker_id, triggered_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 'flow_step', $7, $8, $9, 'running', 0, $10::jsonb, now(), $11, $12)`,
      [executionId, ctx.projectId, node.endpointId, node.name, ctx.environmentId ?? null, ctx.environmentName ?? null, ctx.flowExecutionId ?? null, node.id, node.name, JSON.stringify({ method: node.request.method, url: node.request.url, query: node.request.queryParams, headers: node.request.headers }), ctx.workerId ?? null, ctx.triggeredBy ?? null],
    );
    if (childStepId) {
      await pool.query(
        `INSERT INTO execution_steps (id, index_id, step_id, step_type, step_name, status, stage, position, parent_step_id, iteration, http_execution_id, input_snapshot, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, $9, $10, $11::jsonb, now())`,
        [childStepId, ctx.indexId, node.id, node.type, node.name, stage, position, containerStepId, iteration ?? 0, executionId, JSON.stringify(nodeInput(node))],
      );
    } else {
      await pool.query("UPDATE execution_steps SET http_execution_id = $2 WHERE id = $1", [containerStepId, executionId]);
    }
    await publishEvent({ kind: "execution", projectId: ctx.projectId, executionId, status: "running", endpointId: node.endpointId, flowExecutionId: ctx.flowExecutionId, flowNodeId: node.id });
    const handle = registerInflight(executionId);
    let outcome: Awaited<ReturnType<typeof executeRequest>>;
    try {
      outcome = await executeRequest({
        request: node.request, assertions: node.assertions ?? [], extracts: node.extracts ?? [], hooks: node.preRequestHooks ?? [], responseScripts: node.responseScripts ?? [],
        environment: async () => ({ ...ctx.environment, variables: inputBag }), signal: AbortSignal.any([ctx.signal, ctx.deadline, handle.signal]),
        snapshot: { method: node.request.method, url: node.request.url, query: node.request.queryParams, headers: node.request.headers },
      });
    } finally { releaseInflight(executionId); }
    const result: NodeOutcome = {
      status: outcome.status, durationMs: outcome.durationMs, error: outcome.error,
      output: {
        statusCode: outcome.statusCode, responseTruncated: outcome.responseTruncated,
        assertionResults: outcome.assertionResults, extractResults: outcome.extractResults,
        responseScriptResults: outcome.responseScriptResults,
      },
      produced: outcome.committedVariables,
    };
    await settleExecution(executionId, outcome);
    await publishEvent({ kind: "execution", projectId: ctx.projectId, executionId, status: outcome.status, endpointId: node.endpointId, flowExecutionId: ctx.flowExecutionId, flowNodeId: node.id });
    if (childStepId) {
      await pool.query(
        `UPDATE execution_steps SET status = $2, duration_ms = $3, output_snapshot = $4::jsonb, error = $5, finished_at = now() WHERE id = $1`,
        [childStepId, result.status, result.durationMs, JSON.stringify(result.output), result.error ?? null],
      );
    }
    return result;
  }

  /** 记录并执行一个节点；令牌在准入时已取得，结束时释放。 */
  async function runNode(nodeId: string, release: () => void): Promise<{ nodeId: string; result: NodeOutcome }> {
    const st = state.get(nodeId)!;
    try {
      st.status = "running";
      const node = st.node;
      if (!stageInputs.has(st.stage)) {
        stageInputs.set(st.stage, { ...bag });
        stageProducedInputs.set(st.stage, { ...produced });
      }
      const inputBag = { ...stageInputs.get(st.stage)! };
      const stepRecordId = randomUUID();
      st.stepId = stepRecordId;
      await pool.query(
        `INSERT INTO execution_steps (id, index_id, step_id, step_type, step_name, status, stage, position, parent_step_id, iteration, input_snapshot, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, $9, $10::jsonb, now())`,
        [stepRecordId, ctx.indexId, node.id, node.type, node.name, st.stage, st.position, opts.parentStepId ?? null, opts.iteration ?? null, JSON.stringify(nodeInput(node))],
      );

      let result: NodeOutcome;
      if (node.type === "request") {
        const concurrency = Math.max(1, Math.trunc(Number(node.concurrency ?? 1)));
        if (concurrency === 1) {
          result = await executeRequestStep(ctx, node, inputBag, stepRecordId, st.stage, st.position);
        } else {
          /* 请求并发（P2-4.2 起**原子领取**）：一次凑齐 N 枚令牌，N 个请求一起发。
             容器行输出摘要，每次请求是子步骤行，证据与循环同构。 */
          const mask = masker(ctx.environment);
          let releaseTokens: (() => void) | undefined;
          let budgetError: string | undefined;
          /* 声明超过池容量时 acquireMany 抛错而不是永远等待。保存与入队都按同一个预算
             校验过，所以走到这里的只剩自带池子的调用方（单步调试）；报成这一步失败比
             让整次执行崩在 worker 的兜底分支里诚实。 */
          try { releaseTokens = await ctx.tokens.acquireMany(concurrency); }
          catch (error) { budgetError = error instanceof Error ? error.message : "concurrency budget exceeded"; }

          if (!releaseTokens) {
            result = { status: "failed", durationMs: 0, error: budgetError, output: { concurrency, total: concurrency, iterations: [] }, produced: {} };
          } else {
            const fanOutStartedAt = performance.now();
            let outcomes: NodeOutcome[];
            try {
              /* 全部一起发：没有「首个失败即停领」这一步——N 个请求在同一瞬间就已经都
                 在飞，停领无从谈起，而同时在飞正是并发要表达的形状。onFailure 语义仍由
                 外层图对这个容器节点判定。 */
              outcomes = await Promise.all(Array.from({ length: concurrency }, (_, index) =>
                executeRequestStep(ctx, node, inputBag, stepRecordId, st.stage, st.position, index)));
            } finally {
              releaseTokens();
            }

            const iterations = outcomes.map((one, index) => ({
              index, status: one.status, durationMs: one.durationMs, error: one.error,
              extractResults: (one.output.extractResults ?? []) as unknown[],
            }));
            let firstError: string | undefined;
            for (const item of iterations) {
              if (item.status !== "success") firstError ??= item.error ?? `request ${item.index + 1} failed`;
            }
            const produced: Record<string, string> = {};
            /* 迭代序而非完成序：并发下完成顺序不确定，而结果必须可复现。 */
            const collected = new Map<string, string[]>();
            outcomes.forEach((one) => {
              for (const [name, value] of Object.entries(one.produced)) collected.set(name, [...(collected.get(name) ?? []), value]);
            });
            for (const [name, values] of collected) produced[name] = JSON.stringify(values);
            result = {
              status: firstError ? "failed" : "success",
              /* 墙上时钟而不是各次耗时相加：N 个请求真的同时在飞，相加会把 3 个 1 秒的
                 并发请求报成 3 秒。 */
              durationMs: Math.round(performance.now() - fanOutStartedAt),
              error: firstError,
              output: mask({
                concurrency, total: concurrency,
                iterations,
                successCount: iterations.filter((item) => item.status === "success").length,
                failedCount: iterations.filter((item) => item.status !== "success").length,
              }) as Record<string, unknown>,
              produced,
            };
          }
        }
      } else if (node.type === "database") {
        const outcome = await executeDatabaseNode(ctx.projectId, node, inputBag, ctx.environment);
        result = { status: outcome.status, durationMs: outcome.durationMs, error: outcome.error, output: outcome.output, produced: { ...outcome.extracted, ...outcome.assertionVariables } };
      } else if (node.type === "script") {
        result = await executeScriptNode(node, inputBag, ctx.environment);
      } else if (node.type === "condition") {
        result = executeConditionNode(node, inputBag, ctx.environment);
      } else if (node.type === "wait") {
        result = await executeWaitNode(node, [ctx.signal, ctx.deadline]);
      } else if (node.type === "subflow") {
        result = await executeSubflowNode(ctx, node, inputBag, stepRecordId);
      } else {
        result = await executeLoopNode(ctx, node, inputBag, stepRecordId);
      }

      await pool.query(
        `UPDATE execution_steps SET status = $2, duration_ms = $3, output_snapshot = $4::jsonb, error = $5, finished_at = now()
          WHERE id = $1 AND status = 'running'`,
        [stepRecordId, result.status, result.durationMs, JSON.stringify(result.output), result.error ?? null],
      );
      if (node.type !== "request") {
        await publishEvent({ kind: "step", projectId: ctx.projectId, stepId: stepRecordId, status: result.status, flowExecutionId: ctx.flowExecutionId, flowNodeId: node.id, nodeType: node.type });
      }
      return { nodeId, result };
    } finally {
      release();
    }
  }

  /** 同 stage 同名冲突的另一半：把已经成功的写者翻成失败（计数同步调整）。 */
  async function flipToFailed(nodeId: string, message: string) {
    const st = state.get(nodeId)!;
    if (st.status !== "success") return;
    st.status = "failed";
    st.result = { ...st.result!, status: "failed", error: message };
    successCount -= 1; failedCount += 1;
    await pool.query(
      `UPDATE execution_steps SET status = 'failed', error = $2, finished_at = now()
        WHERE id = $1 AND status IN ('running', 'success')`, [st.stepId, message],
    );
    if (st.node.type === "request" && st.httpExecutionId) {
      await pool.query(
        `UPDATE executions SET status = 'failed', error = $2, finished_at = now()
          WHERE id = $1 AND status IN ('running', 'success')`, [st.httpExecutionId, message],
      );
    }
  }

  /**
   * 合并一个节点的写回；同 stage 两个节点写同名变量时，两个都失败（计划 5.0.2）。
   * 顺序不决定裁决：后完成者检测到冲突、翻自己并翻先完成者。
   */
  async function applyOutcome(nodeId: string, result: NodeOutcome) {
    const st = state.get(nodeId)!;
    const producedNames = result.status === "success" ? Object.keys(result.produced) : [];
    const ownersBefore = conflictOwners.get(st.stage);
    const conflictNames = producedNames.filter((name) => ownersBefore?.get(name) !== undefined && ownersBefore.get(name) !== nodeId);

    if (!conflictNames.length) {
      if (producedNames.length) {
        let owners = conflictOwners.get(st.stage) ?? new Map<string, string>();
        for (const name of producedNames) owners.set(name, nodeId);
        conflictOwners.set(st.stage, owners);
      }
      return;
    }

    const otherWriters = new Set(conflictNames.map((name) => ownersBefore!.get(name)!));
    const otherName = byId.get([...otherWriters][0])?.name ?? "?";
    const message = `variable conflict: "${conflictNames[0]}" was produced by both "${otherName}" and "${st.node.name}" in the same parallel stage`;
    let owners = conflictOwners.get(st.stage) ?? new Map<string, string>();
    for (const name of producedNames) owners.set(name, nodeId);
    conflictOwners.set(st.stage, owners);

    for (const writer of otherWriters) {
      if (writer !== nodeId && state.get(writer)?.status === "success") await flipToFailed(writer, message);
    }
    result.status = "failed";
    result.error = message;
  }

  /** 从 stage 基线加上成功写者重建当前变量袋（确定性：按声明下标排序）。 */
  function rebuildStageVariables(stage: number) {
    const bagBase = stageInputs.get(stage); const producedBase = stageProducedInputs.get(stage);
    if (!bagBase || !producedBase) return;
    for (const name of Object.keys(bag)) delete bag[name];
    for (const name of Object.keys(produced)) delete produced[name];
    Object.assign(bag, bagBase); Object.assign(produced, producedBase);
    const succeeded = [...state.values()].filter((item) => item.stage === stage && item.status === "success" && item.result?.status === "success");
    succeeded.sort((left, right) => left.position - right.position);
    for (const item of succeeded) {
      Object.assign(bag, item.result!.produced);
      Object.assign(produced, item.result!.produced);
    }
  }

  /** 节点定案后激活或击败它的出边；全灭的 target 标记 skipped 并递归传播。 */
  function settleEdges(nodeId: string) {
    const source = state.get(nodeId)!;
    for (const edge of outgoing.get(nodeId) ?? []) {
      const target = state.get(edge.target); if (!target) continue;
      target.remaining -= 1;
      if (edgeActivates(source, edge.on)) target.activated = true;
      if (target.remaining > 0) continue;
      if (target.activated) {
        let stage = 0;
        for (const inc of incoming.get(edge.target) ?? []) {
          const src = state.get(inc.source)!;
          if (edgeActivates(src, inc.on)) stage = Math.max(stage, src.stage + 1);
        }
        target.stage = stage;
        target.status = "ready";
      } else {
        target.status = "skipped";
        skippedCount += 1;
        settleEdges(edge.target);
      }
    }
  }

  const canceled = () => ctx.signal.aborted || ctx.deadline.aborted;

  for (;;) {
    if (!canceled() && !stopped) {
      /**
       * 准入。
       *
       * 每层图最多同时启动 `graphLimit` 个节点，只是本层的扇出上限；真实并发由
       * 全局令牌池封顶，且**只有叶子取令牌**（容器不取，见 TokenPool 注释）。
       * 令牌在 acquire 处等待会阻塞本层准入循环，这是有意的：本层拿不到额度时
       * 继续起新节点没有意义，而已在飞的节点仍在 await 中正常推进。
       */
      while (running.size < graphLimit) {
        const runningStages = [...running.keys()].map((id) => state.get(id)!.stage);
        const readyStages = [...state.values()].filter((item) => item.status === "ready" && !running.has(item.node.id)).map((item) => item.stage);
        const activeStage = runningStages.length ? Math.min(...runningStages) : readyStages.length ? Math.min(...readyStages) : undefined;
        if (activeStage === undefined) break;
        let next: RuntimeState | undefined;
        for (const candidate of state.values()) {
          if (candidate.status !== "ready" || running.has(candidate.node.id)) continue;
          if (candidate.stage !== activeStage) continue;
          if (!next || candidate.position < next.position) next = candidate;
        }
        if (!next) break;
        /**
         * 容器节点不取令牌：它不做工作，只等自己的内层图，而内层叶子要向同一个池子
         * 申请。让容器占额度会在容器数达到 capacity 时把内层饿死。
         *
         * **并发请求节点同理**：它自己不发请求，而是扇出 N 个子请求，这 N 枚令牌由
         * 节点内部**一次性凑齐**（见上面的扇出实现）。若让它作为一个节点只占一个令牌，
         * 那么「循环并发 2 × 请求并发 10」会有 20 个请求在飞而池子只记了 2 个——所谓
         * 「真实并发受整次执行预算封顶」就成了空话。
         */
        const fansOut = next.node.type === "request" && (next.node.concurrency ?? 1) > 1;
        const release = isContainerNode(next.node) || fansOut ? noop : await ctx.tokens.acquire();
        running.set(next.node.id, runNode(next.node.id, release));
      }
    }

    if (running.size === 0) break;
    const { nodeId, result } = await Promise.race([...running.entries()].map(async ([id, promise]) => ({ ...(await promise), id })));
    running.delete(nodeId);

    if (canceled()) continue;

    const st = state.get(nodeId)!;
    const rawStatus = result.status;
    await applyOutcome(nodeId, result);
    st.result = result;
    st.status = result.status;
    rebuildStageVariables(st.stage);
    if (result.status !== rawStatus) {
      await pool.query(
        "UPDATE execution_steps SET status = $2, error = $3 WHERE id = $1 AND status = 'running'",
        [st.stepId, result.status, result.error ?? null],
      );
    }
    if (result.status === "success") successCount += 1; else failedCount += 1;

    if (result.status === "failed" && st.node.onFailure === "stop") {
      /* stop 不传播边：所有未定节点在下面统一标记 skipped。 */
      stopped = true; flowError ??= `stopped at "${st.node.name}"`;
    } else {
      settleEdges(nodeId);
    }
    ctx.onProgress?.({ success: successCount, failed: failedCount, skipped: skippedCount });
  }

  const aborted = canceled();
  if (!aborted) {
    for (const st of state.values()) {
      if (st.status !== "pending" && st.status !== "ready") continue;
      st.status = "skipped";
      skippedCount += 1;
    }
    for (const st of state.values()) {
      if (st.status === "skipped") await insertSkippedStep(st);
    }
  }
  ctx.onProgress?.({ success: successCount, failed: failedCount, skipped: skippedCount });

  return {
    status: aborted ? "canceled" : failedCount || stopped ? "failed" : "success",
    successCount, failedCount, skippedCount,
    error: aborted ? "canceled by user" : flowError,
    produced,
  };
}

/**
 * 进入内层图时用的 ctx。
 *
 * 关键是**摘掉 `onProgress`**：父级计数只统计顶层步骤，而内层图的计数是从 0 开始
 * 的局部值。让内层回调父级会把「外层已完成 4 步」瞬间刷成「1 步」，前端进度反复
 * 跳变。内层的可复盘性由 `parent_step_id` 的嵌套步骤行提供，不靠父级计数。
 */
function nested(ctx: GraphContext): GraphContext {
  return { ...ctx, onProgress: undefined };
}

/** 解析入参映射：`{{name}}` 引用外层变量袋。 */
function resolveInputs(inputs: Record<string, string> | undefined, bag: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(inputs ?? {}).map(([name, value]) => {
    /* resolveDeep 对「整字段就是一个引用」会还原出数组/对象（`{{items}}` 指向
       JSON 数组时正是如此）。变量袋是 Record<string,string>，所以在这里序列化回
       文本；下游 resolveDeep 再次遇到整字段引用时会重新还原成真数组。断言成
       string 会让一个数组冒充字符串流进去，之后按字符串用必然出错。 */
    const resolved = resolveDeep(value, bag);
    return [name, typeof resolved === "string" ? resolved : JSON.stringify(resolved) ?? String(resolved)];
  }));
}

/** 按 outputs 白名单回写；未声明 = 全量。 */
function publishOutputs(produced: Record<string, string>, outputs: string[] | undefined): Record<string, string> {
  if (outputs === undefined) return { ...produced };
  const published: Record<string, string> = {};
  for (const name of outputs) {
    if (Object.prototype.hasOwnProperty.call(produced, name)) published[name] = produced[name];
  }
  return published;
}

/**
 * 子流程节点 (P2-6): 把内层图跑一次，入参显式传入、出参按白名单回写。
 *
 * 内层是一个**隔离的作用域**：只能看到 环境变量 + 内层流程自己的种子变量 + 显式
 * 入参，看不到调用方的其他变量——这既是复用契约（外层换变量名不会悄悄改变子流程
 * 读到的东西），也让子流程能被单步调试（没有外层也能跑）。
 */
export async function executeSubflowNode(
  ctx: GraphContext,
  node: PreparedSubflowFlowNode,
  outerBag: Record<string, string>,
  stepId: string,
): Promise<NodeOutcome> {
  const mask = masker(ctx.environment);
  const startedAt = performance.now();
  const innerBag: Record<string, string> = {
    ...ctx.environment.variables,
    ...node.body.variables,
    ...resolveInputs(node.inputs, outerBag),
  };
  const result = await runGraph(nested(ctx), node.body, innerBag, { parentStepId: stepId });
  const produced = publishOutputs(result.produced, node.outputs);
  return {
    status: result.status === "success" ? "success" : "failed",
    durationMs: Math.round(performance.now() - startedAt),
    error: result.error,
    output: mask({
      flowId: node.body.flowId, flowName: node.body.flowName,
      successCount: result.successCount, failedCount: result.failedCount, skippedCount: result.skippedCount,
    }) as Record<string, unknown>,
    produced,
  };
}

/**
 * 循环节点 (P2-6): 把循环体（画布上的内联子图）跑 count 次或对列表逐项跑一次。
 *
 * - **内联而非引用**：循环体是节点自己 body 里的步骤，画布上它包住这些步骤；
 *   体内步骤与流程共享变量作用域（直接读外层袋），不隔离。
 * - **迭代互相独立**：每次迭代从同一外层快照起步（并发下让迭代互读必然产生
 *   调度相关的非确定结果）。
 * - **有硬上限**：`MAX_LOOP_ITERATIONS`；列表超长直接失败而不是静默截断——少跑
 *   两项比「不知道少跑了」诚实。
 * - **受控并发**：`concurrency` 次迭代同时在飞。这是一个**局部信号量**，不改全局
 *   令牌池容量——真实并发仍由 `FLOW_PARALLELISM` 封顶，所以两个并发的循环不会互相
 *   踩，也不会把整次执行的并发上限永久放大。
 * - 出参（outputs 白名单）按迭代收集成 JSON 数组：声明 `orderId` 后，外层 `{{orderId}}`
 *   是一个 `["A","B"]` 数组，直接可塞进后续请求体（resolveDeep 会把整字段引用的
 *   JSON 还原成真数组）。未产出该变量的迭代不占位，数组里不会出现 null 空洞。
 */
export async function executeLoopNode(
  ctx: GraphContext,
  node: PreparedLoopFlowNode,
  outerBag: Record<string, string>,
  stepId: string,
): Promise<NodeOutcome> {
  const mask = masker(ctx.environment);
  const iterations: { index: number; item?: string; status: string; durationMs: number; error?: string }[] = [];
  /* 稀疏下标会让 JSON.stringify 写出 null，所以按 [index, value] 收集后再压实。 */
  const collected = new Map<string, { index: number; value: string }[]>();
  let firstError: string | undefined;

  const source = resolveIterations(node, outerBag);
  if ("error" in source) {
    return { status: "failed", durationMs: 0, error: source.error, output: { iterations: [] }, produced: {} };
  }
  const { count, items } = source;
  const loopStartedAt = performance.now();

  const concurrency = Math.max(1, Math.min(MAX_LOOP_CONCURRENCY, node.concurrency ?? 1));
  const window = new Semaphore(concurrency);
  /* 循环体是画布上的内联子图，与流程共享作用域：体内步骤直接读外层变量袋，
     不需要子流程那套显式入参。迭代仍从同一快照起步，另注入 item / index。 */
  const base: Record<string, string> = { ...outerBag };
  /* 迭代互相独立：每次都从同一外层快照起步。并发下让迭代互读必然产生调度相关的
     非确定结果，跨迭代累积应该由循环之后的脚本节点读取收集到的出参来做。 */
  const queue = Array.from({ length: count }, (_, index) => index);

  const worker = async () => {
    for (;;) {
      /* 首个失败即停止领新迭代（onFailure 的语义在容器这一层由外层图判定）。 */
      if (firstError || ctx.signal.aborted || ctx.deadline.aborted) return;
      const index = queue.shift();
      if (index === undefined) return;
      const release = await window.acquire();
      try {
        const iterationBag: Record<string, string> = {
          ...base, [node.indexVariable]: String(index),
          ...(node.itemVariable ? { [node.itemVariable]: items[index] } : {}),
        };
        const startedAt = performance.now();
        const result = await runGraph(nested(ctx), node.body, iterationBag, { parentStepId: stepId, iteration: index });
        const durationMs = Math.round(performance.now() - startedAt);
        iterations[index] = { index, item: node.itemVariable ? items[index] : undefined, status: result.status, durationMs, error: result.error };
        if (result.status !== "success") firstError ??= result.error ?? `iteration ${index + 1} failed`;
        for (const [name, value] of Object.entries(publishOutputs(result.produced, node.outputs))) {
          const bucket = collected.get(name) ?? [];
          bucket.push({ index, value });
          collected.set(name, bucket);
        }
      } finally {
        release();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, count)) }, () => worker()));

  const produced: Record<string, string> = {};
  for (const [name, entries] of collected) {
    /* 迭代顺序而非完成顺序：并发下完成顺序不确定，而结果必须可复现。 */
    entries.sort((left, right) => left.index - right.index);
    produced[name] = JSON.stringify(entries.map((entry) => entry.value));
  }
  const settled = iterations.filter(Boolean);
  return {
    status: firstError ? "failed" : "success",
    durationMs: Math.round(performance.now() - loopStartedAt),
    error: firstError,
    output: mask({
      mode: node.mode, total: count,
      iterations: settled,
      successCount: settled.filter((item) => item.status === "success").length,
      failedCount: settled.filter((item) => item.status !== "success").length,
    }) as Record<string, unknown>,
    produced,
  };
}

/** 把循环源解析成要跑的迭代数：count 字面量，或 list 变量解析出的 JSON 数组。 */
function resolveIterations(
  node: PreparedLoopFlowNode,
  bag: Record<string, string>,
): { count: number; items: string[] } | { error: string } {
  if (node.mode === "count") {
    const count = Math.max(0, Math.trunc(Number(node.count ?? 0)));
    if (count > MAX_LOOP_ITERATIONS) {
      return { error: `loop is limited to ${MAX_LOOP_ITERATIONS} iterations and would run ${count}` };
    }
    return { count, items: Array.from({ length: count }, (_, index) => String(index)) };
  }

  const raw = resolveDeep(node.listVariable, bag);
  let list: unknown = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch { /* 保持字面量，下面按不是数组处理 */ }
  }
  if (!Array.isArray(list)) {
    return { error: `"${node.listVariable}" is not a JSON array in the variable bag` };
  }
  if (list.length > MAX_LOOP_ITERATIONS) {
    return { error: `loop is limited to ${MAX_LOOP_ITERATIONS} iterations but the list has ${list.length} items` };
  }
  return { count: list.length, items: list.map((item) => typeof item === "string" ? item : JSON.stringify(item)) };
}
