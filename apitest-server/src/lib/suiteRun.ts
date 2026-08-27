import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { insertFlowRun, insertRun } from "./enqueue.js";
import { publishEvent } from "./events.js";
import { SUITE_LEAF_BUDGET } from "./flow.js";
import { TokenPool } from "./flowGraph.js";
import { performFlowRun } from "./flowRun.js";
import { performRun } from "./run.js";
import { mapFlow, mapTestCase, type FlowNode, type SuiteExecutionConfig, type SuiteMemberSnapshot } from "../models/types.js";

/**
 * 一次套件执行（P2-4.2）。范围与边界见 DEVELOPMENT_PLAN.md 5.0.11。
 *
 * 套件是流程之上又一层容器，但它**不是**第二个图执行器：成员之间不传变量，所以这里
 * 没有 ready-set 调度、没有边条件、没有变量袋——只有「几个成员同时开跑」和「一个成员
 * 跑完算什么」。
 *
 * 三条决定了整个实现形状的边界：
 *
 * 1. **成员在套件自己的 worker 槽内进程内扇出，不单独入队**（边界 2）。给成员入队会让
 *    「等子任务的父槽」把 `WORKER_CONCURRENCY` 吃光——与 5.0.8 容器持令牌的死锁同一类
 *    错误。所以这里调用的是 `insertRun` / `insertFlowRun`（只写行）+ `performRun` /
 *    `performFlowRun`（就地跑），而不是 `enqueueRun` / `enqueueFlowRun`。
 * 2. **成员证据 = 该套件 index 下的一行 `execution_steps`**（边界 1）。用例成员
 *    `step_type='case'` + `http_execution_id`；流程成员 `step_type='flow'` +
 *    `child_index_id`。于是取消、计数、回收、统一详情全部沿用既有实现。
 * 3. **一次套件执行共享一个令牌池**（容量 `SUITE_LEAF_BUDGET`），传给每个流程成员。
 *    套件容器与流程成员容器都不拿令牌——容器拿令牌就会「攥着额度等自己的身体要额度」。
 *    用例成员是一个叶子，它自己拿一枚。
 */

/** 与 `SUITE_TIMEOUT_MS` 配对的回收阈值在 worker.ts（`REAP_SUITE_AFTER`，45 分钟）。 */
export const SUITE_TIMEOUT_MS = 30 * 60_000;

/** 一个成员跑完算什么。`canceled` 既不是通过也不是失败，但它不是成功。 */
type MemberOutcome = "success" | "failed" | "canceled";

/**
 * 子执行行上的状态翻成成员结论。
 *
 * 非终态（queued/running）说明这一行不是本次跑出来的：`insertRun` 与就地认领之间有一个
 * 毫秒级窗口，另一个 worker 启动时的补投扫描理论上能在那里抢走它。真相在行上，按失败
 * 记并说明原因，比假装它成功或让成员行永远停在「执行中」都要诚实。
 */
function settledOutcome(status: unknown, error: unknown): { status: MemberOutcome; error?: string } {
  const value = String(status);
  const message = error === null || error === undefined ? undefined : String(error);
  if (value === "success" || value === "failed" || value === "canceled") return { status: value, error: message };
  return { status: "failed", error: message ?? "member run was claimed by another worker" };
}

type MemberEnvironment = { id?: string; name?: string };

/**
 * 跑完一次套件执行。
 *
 * 返回 false 表示这一行认领不到——排队期间被取消的执行就是这个结果，与
 * `performRun` / `performFlowRun` 一致。
 *
 * `labels` 是这台 worker 服务的执行分区（P2-8）。成员是**进程内扇出**的，所以整次套件
 * 执行必然落在同一个分区上；成员行的标签由套件行上的那一个继承，而不是各自重新解析。
 */
export async function performSuiteRun(suiteExecutionId: string, signal: AbortSignal, workerId?: string, labels?: string[]): Promise<boolean> {
  /* 认领与开跑一条语句：`status = 'queued'` 让先到的取消生效（那行已经是 canceled，
     这条 UPDATE 匹配不到任何行，一个成员都不会开跑），同时挡住重复投递。
     `runner_label = ANY($3)` 是 P2-8 的分区防御，与 `performRun` 同款。 */
  const claimed = await pool.query(
    `UPDATE suite_executions SET status = 'running', started_at = now(), worker_id = $2
      WHERE id = $1 AND status = 'queued' AND ($3::text[] IS NULL OR runner_label = ANY($3))
      RETURNING *`,
    [suiteExecutionId, workerId ?? null, labels ?? null],
  );
  if (!claimed.rowCount) return false;

  const row = claimed.rows[0];
  const projectId = String(row.project_id);
  const indexId = String(row.execution_index_id);
  const total = Number(row.total);
  const members = (row.member_snapshot ?? []) as SuiteMemberSnapshot[];
  const spec = (row.run_spec ?? {}) as SuiteExecutionConfig;
  const failFast = Boolean(spec.failFast);
  const override = spec.environmentStrategy === "override";
  const suiteEnvironment: MemberEnvironment = { id: row.environment_id ? String(row.environment_id) : undefined, name: row.environment_name ? String(row.environment_name) : undefined };
  /* 成员继承套件行上的分区（P2-8）：入队时已确认整批成员同属一个分区，成员行再各自
     解析一次只会在「入队后环境改了标签」时写出本机认领不了的记录。 */
  const runnerLabel = String(row.runner_label ?? "default");

  await pool.query("UPDATE execution_index SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued'", [indexId]);
  await publishEvent({ kind: "suite", projectId, suiteExecutionId, executionIndexId: indexId, status: "running", total, successCount: 0, failedCount: 0, skippedCount: 0 });

  /* 一次套件执行的两个预算：叶子令牌池（所有成员共享）与成员并发（成员数上限）。
     `C ≤ 池容量` 保证每个在跑的成员至少能拿到一枚令牌，一定有进展——执行入口已经拒绝
     了 C > 预算 的请求，这里的 min 只兜住「预算被调小之前存下的那个 C」。 */
  const tokens = new TokenPool(SUITE_LEAF_BUDGET);
  const concurrency = Math.max(1, Math.min(SUITE_LEAF_BUDGET, Math.trunc(Number(spec.concurrency ?? 1))));
  const deadline = AbortSignal.timeout(SUITE_TIMEOUT_MS);
  /* 成员自己的中断信号：套件被取消或整体超时，在途请求都要立刻断。 */
  const memberSignal = AbortSignal.any([signal, deadline]);
  const aborted = () => signal.aborted || deadline.aborted;

  let successCount = 0; let failedCount = 0; let skippedCount = 0;
  /* fail-fast：不再启动新成员，在途成员跑完（边界 4）。中途 abort 会写出一行看起来
     像用户取消的 canceled，而成员是独立执行，它的证据值得留。 */
  let stopped = false;

  const progress = async () => {
    await Promise.all([
      pool.query("UPDATE execution_index SET success_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $1 AND status = 'running'", [indexId, successCount, failedCount, skippedCount]),
      pool.query("UPDATE suite_executions SET success_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $1 AND status = 'running'", [suiteExecutionId, successCount, failedCount, skippedCount]),
    ]);
    await publishEvent({ kind: "suite", projectId, suiteExecutionId, executionIndexId: indexId, status: "running", total, successCount, failedCount, skippedCount });
  };

  /** 一个成员的环境：override 用套件的，member_default 用入队时冻结的那一个。 */
  const environmentOf = (member: SuiteMemberSnapshot): MemberEnvironment => override
    ? suiteEnvironment
    /* 取快照而不是现读定义：报告里显示的就是这一份，两处不同答案会让人以为跑错了环境。
       成员的请求正文与断言仍必须现读——快照里没有它们。 */
    : { id: member.environmentId, name: member.environmentName };

  /**
   * 写下成员的终态证据。
   *
   * `status = 'running'` 守卫是必需的：取消已经把这一行写成 canceled，没有守卫的话
   * 一个恰好同时跑完的成员会把它盖回 success/failed。匹配不到行即「已被取消」。
   */
  const settleStep = async (stepId: string, status: MemberOutcome, durationMs: number, output: Record<string, unknown>, error?: string): Promise<boolean> => {
    const settled = await pool.query(
      `UPDATE execution_steps SET status = $2, duration_ms = $3, output_snapshot = $4::jsonb, error = $5, finished_at = now()
        WHERE id = $1 AND status = 'running' RETURNING id`,
      [stepId, status, durationMs, JSON.stringify(output), error ?? null],
    );
    return Boolean(settled.rowCount);
  };

  /** 用例成员：一行 `executions`，与用例列表里手动跑一次完全同构（source='test_case'）。 */
  const runCaseMember = async (member: SuiteMemberSnapshot, stepId: string) => {
    const found = await pool.query(
      /* endpoint_name 从接口读，与 routes/cases.ts 的执行一致：历史要说清这次跑的是
         哪个接口。test_cases.endpoint_id 是 NOT NULL + CASCADE，所以 INNER JOIN 安全。 */
      `SELECT c.*, e.name AS endpoint_name FROM test_cases c
         JOIN endpoints e ON e.id = c.endpoint_id
        WHERE c.id = $1 AND c.project_id = $2`,
      [member.id, projectId],
    );
    if (!found.rowCount) throw new Error(`case "${member.name}" no longer exists`);
    const testCase = mapTestCase(found.rows[0]);
    const environment = environmentOf(member);
    /**
     * 令牌先领，再写 `executions` 行。
     *
     * 用例成员是一个叶子，它自己占一枚令牌——这才让「真实在飞请求数受池容量封顶」对
     * 用例成员也成立。顺序反过来会出真问题：池子紧张时那一行会以 `queued` 干等，而
     * 回收扫描（worker.ts `REAP_AFTER`，5 分钟）会把一个还在正常排队的成员判死。
     */
    const release = await tokens.acquire();
    try {
      const { executionId } = await insertRun({
        projectId, endpointId: testCase.endpointId, endpointName: String(found.rows[0].endpoint_name),
        request: testCase.request, environmentId: environment.id, environmentName: environment.name,
        source: "test_case", caseId: testCase.id, caseName: testCase.name,
        assertions: testCase.assertions, hooks: testCase.preRequestHooks,
        extracts: testCase.extracts, responseScripts: testCase.responseScripts,
        runnerLabel,
      });
      /* 证据指针先落库再开跑：中途取消要能顺着它找到这次请求。 */
      await pool.query("UPDATE execution_steps SET http_execution_id = $2 WHERE id = $1", [stepId, executionId]);
      await performRun(executionId, memberSignal, workerId, labels);
      /**
       * 结论从库里读，不从 `performRun` 的返回值推。
       *
       * 它返回 false 只说明「这一行不是我认领的」——被取消、或极小概率被另一个 worker
       * 的补投抢走（`requeueOrphans` 在插入与认领之间那毫秒级窗口里扫到了它）。两种情况
       * 下真相都在行上，读它比猜它诚实。
       */
      const settled = await pool.query("SELECT status, error, status_code FROM executions WHERE id = $1", [executionId]);
      const result = settled.rows[0];
      return {
        ...settledOutcome(result.status, result.error),
        output: { executionId, endpointName: String(found.rows[0].endpoint_name), statusCode: result.status_code === null ? undefined : Number(result.status_code) },
      };
    } finally {
      release();
    }
  };

  /**
   * 流程成员：一次**完整的**流程执行（边界 6）。
   *
   * 它自己有 execution_index + flow_executions + 一整套子步骤，会出现在流程的运行记录
   * 与流程列表的 lastRun 里。本切片不加「由套件触发」标记：要标记就得在 flow_executions
   * 上再加一列，而反查 `execution_steps.child_index_id` 已经够用。
   */
  const runFlowMember = async (member: SuiteMemberSnapshot, stepId: string) => {
    const found = await pool.query("SELECT * FROM flows WHERE id = $1 AND project_id = $2", [member.id, projectId]);
    if (!found.rowCount) throw new Error(`flow "${member.name}" no longer exists`);
    const flow = mapFlow(found.rows[0]);
    if (!flow.nodes.length) throw new Error(`flow "${flow.name}" has no steps to run`);
    const environment = environmentOf(member);
    /* insertFlowRun 会冻结整张图（内联脚本、解析命名 SQL、展开子流程），跨流程递归与
       超预算的请求并发都在那里抛错——它们是这个成员的失败，不是整个套件的失败。 */
    const inserted = await insertFlowRun({
      projectId, flowId: flow.id, flowName: flow.name,
      environmentId: environment.id, environmentName: environment.name,
      nodes: flow.nodes, edges: flow.edges, variables: flow.variables,
      runnerLabel,
    });
    await pool.query("UPDATE execution_steps SET child_index_id = $2 WHERE id = $1", [stepId, inserted.executionIndexId]);
    /* 流程成员是**容器**：它不拿令牌，它内部的叶子向套件这个共享池子领。容器持令牌
       就会攥着额度等自己的身体要额度（5.0.8 已经付过一次代价的死锁）。 */
    await performFlowRun(inserted.flowExecutionId, memberSignal, workerId, tokens, labels);
    const settled = await pool.query("SELECT status, error, success_count, failed_count, skipped_count FROM flow_executions WHERE id = $1", [inserted.flowExecutionId]);
    const result = settled.rows[0];
    return {
      ...settledOutcome(result.status, result.error),
      output: {
        flowExecutionId: inserted.flowExecutionId, executionIndexId: inserted.executionIndexId,
        successCount: Number(result.success_count), failedCount: Number(result.failed_count), skippedCount: Number(result.skipped_count),
      },
    };
  };

  const runMember = async (member: SuiteMemberSnapshot, position: number): Promise<MemberOutcome> => {
    const stepId = randomUUID();
    const startedAt = performance.now();
    await pool.query(
      `INSERT INTO execution_steps (id, index_id, step_id, step_type, step_name, status, stage, position, input_snapshot, started_at)
       VALUES ($1, $2, $3, $4, $5, 'running', 0, $6, $7::jsonb, now())`,
      /* stage 恒为 0：成员之间没有依赖，「第几批」这个概念在套件里不存在。position 是
         解析出来的成员顺序，也就是报告的阅读顺序。 */
      [stepId, indexId, member.id, member.type, member.name, position, JSON.stringify({ type: member.type, id: member.id, endpointId: member.endpointId, environmentId: environmentOf(member).id })],
    );

    try {
      const outcome = member.type === "case" ? await runCaseMember(member, stepId) : await runFlowMember(member, stepId);
      const settled = await settleStep(stepId, outcome.status, Math.round(performance.now() - startedAt), outcome.output, outcome.error);
      /* 写不进去说明取消先到了，这个成员的结论就是 canceled——不是它跑出来的那个。 */
      return settled ? outcome.status : "canceled";
    } catch (error) {
      /* 成员起不来（用例/流程被删、子流程成环、请求并发超预算……）是**这个成员**的失败。
         整个套件为一个成员崩掉会把其余成员的证据一起丢掉。 */
      const message = error instanceof Error ? error.message : "member could not be started";
      const settled = await settleStep(stepId, "failed", Math.round(performance.now() - startedAt), {}, message);
      return settled ? "failed" : "canceled";
    }
  };

  const queue = members.map((member, position) => ({ member, position }));
  const runner = async () => {
    for (;;) {
      if (stopped || aborted()) return;
      const next = queue.shift();
      if (!next) return;
      const outcome = await runMember(next.member, next.position);
      if (outcome === "success") successCount += 1;
      /* canceled 也计入 failed：它不是一次通过，而 index 的 canceled_count 由取消路径
         自己写（那条路径下这里的计数根本不会落库，见 finish 的 running 守卫）。 */
      else failedCount += 1;
      /* fail-fast 对 canceled 同样成立：用户既然停了一个成员，继续开新的没有意义。 */
      if (outcome !== "success" && failFast) stopped = true;
      await progress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, members.length)) }, () => runner()));

  /**
   * 没开跑的成员留 skipped 证据行（`execution_steps.status` 自 017 起有这个值）。
   *
   * 只在 fail-fast 停下时写：被取消时 `cancelSuiteRun` 已经把该写的都写了，这里再补
   * 会与它算出来的 canceled/skipped 打架。
   */
  if (!aborted()) {
    for (const pending of queue) {
      await pool.query(
        `INSERT INTO execution_steps (id, index_id, step_id, step_type, step_name, status, stage, position, input_snapshot, output_snapshot, finished_at)
         VALUES ($1, $2, $3, $4, $5, 'skipped', 0, $6, $7::jsonb, '{}'::jsonb, now())`,
        [randomUUID(), indexId, pending.member.id, pending.member.type, pending.member.name, pending.position, JSON.stringify({ type: pending.member.type, id: pending.member.id, reason: "not started: the suite stopped on the first failure" })],
      );
      skippedCount += 1;
    }
  }

  await finish(suiteExecutionId, indexId, projectId, {
    status: aborted() ? "canceled" : failedCount ? "failed" : "success",
    successCount, failedCount, skippedCount, total,
    /* 成员的失败原因在成员行上，父级只说明它为什么是这个结论。超时与用户取消都让整次
       执行落 canceled（与流程一致），但两者的原因必须写清楚——把超时说成「用户取消」
       会让人去找一个并不存在的操作记录。 */
    error: signal.aborted ? "canceled by user"
      : deadline.aborted ? `suite timed out after ${Math.round(SUITE_TIMEOUT_MS / 60_000)} minutes`
        : stopped ? "stopped on the first failed member" : undefined,
  });
  return true;
}

/**
 * 落终态。
 *
 * 与 `lib/flowRun.ts` 的 `finish` 逐字同形，包括 `canceled_count` **只在 index 上派生**
 * 这一条：`suite_executions` 刻意没有这一列（迁移 026），两张表各算一遍必然分叉。
 * `status = 'running'` 守卫让取消保持胜出。
 */
async function finish(
  suiteExecutionId: string,
  indexId: string,
  projectId: string,
  result: { status: "success" | "failed" | "canceled"; successCount: number; failedCount: number; skippedCount: number; error?: string; total: number },
) {
  const client = await pool.connect(); let settled = false;
  try {
    await client.query("BEGIN");
    const parent = await client.query(
      `UPDATE suite_executions SET status = $2, success_count = $3, failed_count = $4, skipped_count = $5, error = $6,
         finished_at = now(), run_spec = NULL
       WHERE id = $1 AND status = 'running' RETURNING status`,
      [suiteExecutionId, result.status, result.successCount, result.failedCount, result.skippedCount, result.error ?? null],
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
  await publishEvent({
    kind: "suite", projectId, suiteExecutionId, executionIndexId: indexId,
    status: settled ? result.status : "canceled",
    total: result.total, successCount: result.successCount, failedCount: result.failedCount, skippedCount: result.skippedCount,
  });
}

/**
 * 一个成员**一次要几枚令牌**（原子领取的那个数）。
 *
 * 只有这一个实现，套件预览的峰值提示与入队时的硬校验都用它——两份算法必然给出两个
 * 答案，而用户看到的那个会被当成结论。
 *
 * - 用例成员就是一个请求：1 枚。
 * - 流程成员取图里**单个请求节点**声明的最大并发：那才是必须一次凑齐的批量。stage 并行
 *   与循环并发是机会性的，池子紧张时自然分批，不需要原子性。
 * - 循环体是内联子图，要递归进去；子流程引用的是另一条流程，它的图在入队时才展开，
 *   超预算由 `insertFlowRun` 的校验拦住。
 */
export function memberTokenDemand(member: SuiteMemberSnapshot, nodes?: FlowNode[]): number {
  if (member.type === "case" || !nodes) return 1;
  const walk = (list: FlowNode[]): number => list.reduce((most, node) => {
    if (node.type === "request") return Math.max(most, Math.max(1, Math.trunc(Number(node.concurrency ?? 1))));
    if (node.type === "loop") return Math.max(most, walk(node.body?.nodes ?? []));
    return most;
  }, 1);
  return walk(nodes);
}
