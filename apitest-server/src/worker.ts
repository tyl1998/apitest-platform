import { hostname } from "node:os";
import { Worker } from "bullmq";
import { pool } from "./db.js";
import { performFlowRun } from "./lib/flowRun.js";
import { performSuiteRun } from "./lib/suiteRun.js";
import { inflightCount, listenForCancels, registerInflight, releaseInflight } from "./lib/inflight.js";
import { EXECUTION_QUEUE, createRedis, executionQueue, type ExecutionJob } from "./lib/queue.js";
import { performRun, settleBatch } from "./lib/run.js";

/**
 * 执行 worker（P1-3）。
 *
 * 独立进程，与 API 进程只通过 Redis 与 Postgres 交互。目的不是提高吞吐，而是
 * 把「一次执行最长 30 秒」这件事从 HTTP 请求周期里摘出来：API 不再需要为了
 * 等一个慢接口而挂住连接，用户也不再需要盯着浏览器不敢关。
 */
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 10));

/** hostname:pid —— 单机部署时也要能区分同一台机器上的多个 worker。 */
const WORKER_ID = `${hostname()}:${process.pid}`;

/**
 * 这个 worker 消费哪一类任务。
 *
 * 目前只有接口执行。仓库模式尚未实现，留这个开关是为了让注册表从一开始就能
 * 区分——将来仓库 worker 上线时，平台侧不需要任何改动就能把它列出来。
 */
const WORKER_MODE = process.env.WORKER_MODE ?? "endpoint";

/**
 * 在途请求的中断句柄。
 *
 * BullMQ 只能移除尚未开始的 job，已经在 `await fetch` 里的 job 必须靠
 * AbortController 打断，而 controller 只存在于**正在跑它的那个进程**内存里
 * ——所以取消要先经 Redis 广播到所有 worker，再由持有者对号入座。
 */
/**
 * 在途请求的中断句柄，见 lib/inflight.ts：流程内的每一步也要能被单独取消，
 * 所以登记表是共享的而不是本文件私有。
 */
listenForCancels();

/**
 * 单次执行、流程执行与套件执行共用队列，按载荷形状分派（P1-2 / P2-4.2）。
 *
 * 三者都占一个并发槽：流程与套件本身不发请求，它们是一串子执行，占着槽等自己的每一步
 * 跑完。因此 `WORKER_CONCURRENCY` 是「同时几件事」而不是「同时几个请求」——跑长
 * 流程或套件时要按父任务数而不是节点/成员数估容量。
 *
 * 套件的成员**不入队**：它们在这一个槽内进程内扇出（计划 5.0.11 边界 2）。给成员入队
 * 会让「等子任务的父槽」把并发吃光——与容器持令牌的死锁同一类错误。
 */
const worker = new Worker<ExecutionJob>(
  EXECUTION_QUEUE,
  async (job) => {
    const id = "suiteExecutionId" in job.data ? job.data.suiteExecutionId
      : "flowExecutionId" in job.data ? job.data.flowExecutionId
        : job.data.executionId;
    const controller = registerInflight(id);
    try {
      if ("suiteExecutionId" in job.data) await performSuiteRun(id, controller.signal, WORKER_ID);
      else if ("flowExecutionId" in job.data) await performFlowRun(id, controller.signal, WORKER_ID);
      else await performRun(id, controller.signal, WORKER_ID);
    } finally {
      releaseInflight(id);
    }
  },
  { connection: createRedis(), concurrency: CONCURRENCY },
);

/**
 * 心跳。
 *
 * worker 不监听端口，平台无法主动探它，所以由它自己按期把状态写进来，「在线」
 * 靠 last_seen_at 的新鲜度推断。这样 kill -9 之后不会留下永远在线的幽灵行。
 */
const HEARTBEAT_MS = 10_000;
const WORKER_VERSION = process.env.APP_VERSION ?? null;

async function heartbeat() {
  await pool.query(
    `INSERT INTO workers (id, hostname, pid, concurrency, inflight, version, mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET inflight = EXCLUDED.inflight, concurrency = EXCLUDED.concurrency, mode = EXCLUDED.mode, last_seen_at = now()`,
    [WORKER_ID, hostname(), process.pid, CONCURRENCY, inflightCount(), WORKER_VERSION, WORKER_MODE],
  );
}

/**
 * job 层面的失败兜底。
 *
 * `performRun` 自己把请求异常写成 failed，所以走到这里说明是它之外的事故
 * （取行失败、进程被杀等）。此时行还停在 running，没有人会再来收尾，必须在
 * 这里落终态，否则「运行中」会永远转圈。
 */
worker.on("failed", async (job, error) => {
  if (!job) return;
  const message = error.message || "worker failed";

  /**
   * 套件父记录同理。
   *
   * 只落套件自己与它的成员证据行：成员的子执行（用例的 `executions`、流程成员的
   * `flow_executions`）各有自己的回收阈值，而走到这里说明进程已经不知道每个成员跑到
   * 哪了——由各自的回收去判死比在这里替它们猜一个终态诚实。
   */
  if (job.data && "suiteExecutionId" in job.data) {
    const suiteExecutionId = job.data.suiteExecutionId;
    const result = await pool.query(
      `UPDATE suite_executions SET status = 'failed', error = $2, finished_at = now(), run_spec = NULL
        WHERE id = $1 AND status IN ('queued', 'running') RETURNING id, execution_index_id, total`,
      [suiteExecutionId, message],
    );
    if (!result.rowCount) return;
    const indexId = result.rows[0].execution_index_id;
    await pool.query(
      `UPDATE execution_steps SET status = 'failed', error = $2, finished_at = now()
        WHERE index_id = $1 AND status IN ('queued', 'running')`, [indexId, message],
    );
    const counts = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'success')::int AS succeeded,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled
       FROM execution_steps WHERE index_id = $1 AND parent_step_id IS NULL`, [indexId],
    );
    const aggregate = counts.rows[0];
    /* 一个成员都没来得及起的套件：total 减去有证据的那些就是「从未开跑」。 */
    const skipped = Math.max(0, Number(result.rows[0].total) - Number(aggregate.succeeded) - Number(aggregate.failed) - Number(aggregate.canceled));
    await pool.query("UPDATE suite_executions SET success_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $1", [suiteExecutionId, aggregate.succeeded, aggregate.failed, skipped]);
    await pool.query(
      `UPDATE execution_index SET status = 'failed', success_count = $2, failed_count = $3,
         canceled_count = $4, skipped_count = $5, finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`, [indexId, aggregate.succeeded, aggregate.failed, aggregate.canceled, skipped],
    );
    return;
  }

  /* 流程父记录同理：它停在 running 就没有人会来收尾，且它的在途步骤也一样。 */
  if (job.data && "flowExecutionId" in job.data) {
    const flowExecutionId = job.data.flowExecutionId;
    const result = await pool.query(
      `UPDATE flow_executions SET status = 'failed', error = $2, finished_at = now(), run_spec = NULL
        WHERE id = $1 AND status IN ('queued', 'running') RETURNING id, execution_index_id, total`,
      [flowExecutionId, message],
    );
    if (!result.rowCount) return;
    await pool.query(
      `UPDATE executions SET status = 'failed', error = $2, finished_at = now(), run_spec = NULL
        WHERE flow_execution_id = $1 AND status IN ('queued', 'running')`,
      [flowExecutionId, message],
    );
    const indexId = result.rows[0].execution_index_id;
    await pool.query(
      `UPDATE execution_steps SET status = 'failed', error = $2, finished_at = now()
        WHERE index_id = $1 AND status IN ('queued', 'running')`, [indexId, message],
    );
    const counts = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'success')::int AS succeeded,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled
       FROM execution_steps WHERE index_id = $1 AND parent_step_id IS NULL`, [indexId],
    );
    const aggregate = counts.rows[0];
    const skipped = Math.max(0, Number(result.rows[0].total) - Number(aggregate.succeeded) - Number(aggregate.failed) - Number(aggregate.canceled));
    await pool.query("UPDATE flow_executions SET success_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $1", [flowExecutionId, aggregate.succeeded, aggregate.failed, skipped]);
    await pool.query(
      `UPDATE execution_index SET status = 'failed', success_count = $2, failed_count = $3,
         canceled_count = $4, skipped_count = $5, finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`, [indexId, aggregate.succeeded, aggregate.failed, aggregate.canceled, skipped],
    );
    return;
  }

  const executionId = job.data?.executionId;
  if (!executionId) return;
  const result = await pool.query(
    `UPDATE executions SET status = 'failed', error = $2, finished_at = now(), run_spec = NULL
      WHERE id = $1 AND status IN ('queued', 'running') RETURNING project_id, batch_id`,
    [executionId, message],
  );
  if (!result.rowCount) return;
  const row = result.rows[0];
  if (row.batch_id) await settleBatch(String(row.batch_id), String(row.project_id));
});

worker.on("error", (error) => { console.error("[worker] queue error", error); });

/**
 * 卡死回收。
 *
 * 进程被 kill -9 时在途的行会永远停在 running，队列里也不再有对应 job，没有
 * 任何人会来收尾。单次执行上限是 30 秒，所以超过阈值仍未终态的一定是事故。
 * queued 同理：API 在 INSERT 与入队之间崩溃会留下无主行。
 */
const REAP_INTERVAL_MS = 60_000;
const REAP_AFTER = "5 minutes";
/**
 * 流程的回收阈值必须大于流程自身的总超时（lib/flowRun.ts FLOW_TIMEOUT_MS，10 分钟）
 * 再加排队等待，否则一条正常长跑的流程会被回收判死，而它其实还在一步步跑。
 */
const REAP_FLOW_AFTER = "20 minutes";
/**
 * 套件的回收阈值沿用同一个比例（自身超时的两倍）：`SUITE_TIMEOUT_MS` 是 30 分钟，
 * 所以 45 分钟仍未终态的一定是事故，而不是一个正在老实跑成员的长套件。
 */
const REAP_SUITE_AFTER = "45 minutes";
/**
 * 回收的互斥键（值本身无意义，只要全局唯一）。
 *
 * 每个 worker 都挂着回收定时器，不加锁就是 N 个进程同时扫。UPDATE 本身幂等，
 * 但紧随其后的 settleBatch 会被重复触发，同一批次被并发重算并各自广播一次
 * ——前端会收到同一批次的多份进度。事务级 advisory lock 让同一时刻只有一个
 * worker 真正执行，且随事务结束自动释放，进程崩了也不会把锁留下。
 */
const REAP_LOCK_KEY = 8_013_301;

async function reapStale() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query("SELECT pg_try_advisory_xact_lock($1) AS acquired", [REAP_LOCK_KEY]);
    /* 没抢到说明另一个 worker 正在扫，这一轮直接跳过。 */
    if (!lock.rows[0].acquired) { await client.query("ROLLBACK"); return; }

    const result = await client.query(
      `UPDATE executions SET status = 'failed', error = 'execution abandoned by worker', finished_at = now(), run_spec = NULL
        WHERE status IN ('queued', 'running') AND created_at < now() - INTERVAL '${REAP_AFTER}'
          /* 流程步骤按它所属流程的阈值回收：一条流程可以合法地跑十分钟，它第
             八分钟才开始的那一步不该因为流程 created_at 早就过了 5 分钟而被判死。 */
          AND (flow_execution_id IS NULL OR started_at < now() - INTERVAL '${REAP_AFTER}')
        RETURNING project_id, batch_id`,
    );
    const flows = await client.query(
      `UPDATE flow_executions SET status = 'failed', error = 'flow abandoned by worker', finished_at = now(), run_spec = NULL
        WHERE status IN ('queued', 'running') AND created_at < now() - INTERVAL '${REAP_FLOW_AFTER}'
        RETURNING id, execution_index_id, total`,
    );
    for (const flow of flows.rows) {
      await client.query(
        `UPDATE execution_steps SET status = 'failed', error = 'flow abandoned by worker', finished_at = now()
          WHERE index_id = $1 AND status IN ('queued', 'running')`, [flow.execution_index_id],
      );
      const counts = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'success')::int AS succeeded,
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled
         FROM execution_steps WHERE index_id = $1 AND parent_step_id IS NULL`, [flow.execution_index_id],
      );
      const aggregate = counts.rows[0];
      const skipped = Math.max(0, Number(flow.total) - Number(aggregate.succeeded) - Number(aggregate.failed) - Number(aggregate.canceled));
      await client.query("UPDATE flow_executions SET success_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $1", [flow.id, aggregate.succeeded, aggregate.failed, skipped]);
      await client.query(
        `UPDATE execution_index SET status = 'failed', success_count = $2, failed_count = $3,
           canceled_count = $4, skipped_count = $5, finished_at = now()
          WHERE id = $1 AND status IN ('queued', 'running')`, [flow.execution_index_id, aggregate.succeeded, aggregate.failed, aggregate.canceled, skipped],
      );
    }
    if (result.rowCount) console.warn(`[worker] reaped ${result.rowCount} stale execution(s)`);
    if (flows.rowCount) console.warn(`[worker] reaped ${flows.rowCount} stale flow execution(s)`);

    /* 套件与流程同款：父行停在 running 就没有人会来收尾，成员证据行同理。计数从证据行
       重算而不是相信父行上的数字——父行的计数是进度快照，进程死掉时它可能落后几个成员。 */
    const suites = await client.query(
      `UPDATE suite_executions SET status = 'failed', error = 'suite abandoned by worker', finished_at = now(), run_spec = NULL
        WHERE status IN ('queued', 'running') AND created_at < now() - INTERVAL '${REAP_SUITE_AFTER}'
        RETURNING id, execution_index_id, total`,
    );
    for (const suite of suites.rows) {
      await client.query(
        `UPDATE execution_steps SET status = 'failed', error = 'suite abandoned by worker', finished_at = now()
          WHERE index_id = $1 AND status IN ('queued', 'running')`, [suite.execution_index_id],
      );
      const counts = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'success')::int AS succeeded,
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled
         FROM execution_steps WHERE index_id = $1 AND parent_step_id IS NULL`, [suite.execution_index_id],
      );
      const aggregate = counts.rows[0];
      const skipped = Math.max(0, Number(suite.total) - Number(aggregate.succeeded) - Number(aggregate.failed) - Number(aggregate.canceled));
      await client.query("UPDATE suite_executions SET success_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $1", [suite.id, aggregate.succeeded, aggregate.failed, skipped]);
      await client.query(
        `UPDATE execution_index SET status = 'failed', success_count = $2, failed_count = $3,
           canceled_count = $4, skipped_count = $5, finished_at = now()
          WHERE id = $1 AND status IN ('queued', 'running')`, [suite.execution_index_id, aggregate.succeeded, aggregate.failed, aggregate.canceled, skipped],
      );
    }
    if (suites.rowCount) console.warn(`[worker] reaped ${suites.rowCount} stale suite execution(s)`);
    /**
     * 必须显式提交。
     *
     * 少了这一行，`finally` 会把一条**事务仍开着**的连接还回池子——pg 的 release
     * 不回滚——而后续 `pool.query`（心跳、认领、回收）拿到它就继续在那个事务里跑，
     * 于是：心跳全部不可见（平台上 worker 显示掉线）、回收结果不落库（同一批
     * 记录每轮重复回收）、advisory 锁不释放，且它持有的行锁会把用户请求
     * （如流程保存的 `SELECT ... FOR UPDATE`）永久堵死。
     *
     * 尤其不能指望下一轮回收自愈：对已在事务中的连接再发 `BEGIN`，Postgres 只给
     * 一条 WARNING 而非报错，新一轮会**静默并入**同一个泄漏事务，越积越久。
     */
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const reaper = setInterval(() => { void reapStale().catch((error) => console.error("[worker] reap failed", error)); }, REAP_INTERVAL_MS);
/* 回收是维护动作，不该拖住进程退出。 */
reaper.unref();

/**
 * 启动时清掉本机上已经死掉的 worker 行。
 *
 * 优雅停机会自己摘掉注册，但被 SIGKILL 时来不及——`tsx watch` 每次重启都换一个
 * pid，开发时保存几十次就会堆出几十行死记录。
 *
 * 只查本机：pid 只在本机有意义，拿它去判断别的机器上的进程是张冠李戴。
 * 且只在 ESRCH（进程不存在）时删除——EPERM 说明进程还活着，只是属于别的用户。
 */
async function pruneLocalDead() {
  const rows = await pool.query("SELECT id, pid FROM workers WHERE hostname = $1", [hostname()]);
  for (const row of rows.rows) {
    const pid = Number(row.pid);
    if (pid === process.pid) continue;
    try {
      /* 信号 0 不发送任何东西，只做存在性与权限检查。 */
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      await pool.query("DELETE FROM workers WHERE id = $1", [row.id]);
    }
  }
}

/**
 * 启动时把「库里还在排队、队列里却没有 job」的记录重新投一次。
 *
 * 正常情况下排队中的任务本来就能跨重启继续：job 存在 Redis 里，与 API / worker
 * 进程无关，worker 一回来就领走。但有两种情况会让队列与数据库脱节，而脱节之后
 * 没有任何人会来认领，那行记录只能等回收扫描把它标成失败：
 *
 * - API 在「事务提交」与「入队」之间挂掉（`enqueue.ts` 的补偿只覆盖 add 抛错，
 *   覆盖不了进程在这两步之间消失）。
 * - Redis 丢数据（未开 AOF 时被硬重启，最后几秒入队的 job 就没了）。
 *
 * 之所以可以无脑重投、不必判断到底丢没丢：入队时 `jobId` 就是记录自己的 id
 * （见 `enqueue.ts`），BullMQ 按 jobId 去重，已存在的 job 再 add 是空操作。终态
 * 的 job（失败被保留下来的那些）要先删掉，否则去重会把这次重投也一起吃掉。
 *
 * 即便真的重复投了，认领语句里的 `status = 'queued'` 也保证只有一个能真正跑起来，
 * 所以这里不需要额外加锁。
 */
async function requeueOrphans() {
  const queue = executionQueue();
  /* 先老的后新的：真要排队，也让等得最久的先跑。 */
  const [runs, flows, suites] = await Promise.all([
    pool.query("SELECT id FROM executions WHERE status = 'queued' ORDER BY created_at"),
    pool.query("SELECT id FROM flow_executions WHERE status = 'queued' ORDER BY created_at"),
    pool.query("SELECT id FROM suite_executions WHERE status = 'queued' ORDER BY created_at"),
  ]);

  let requeued = 0;
  const submit = async (id: string, name: "run" | "flow" | "suite", data: ExecutionJob) => {
    const existing = await queue.getJob(id);
    if (existing) {
      /* 还在队列里（等待 / 在途 / 延迟）：本来就会被跑到，不要碰它。 */
      if (!(await existing.isCompleted()) && !(await existing.isFailed())) return;
      await existing.remove();
    }
    await queue.add(name, data, { jobId: id });
    requeued += 1;
  };

  for (const row of runs.rows) await submit(String(row.id), "run", { executionId: String(row.id) });
  for (const row of flows.rows) await submit(String(row.id), "flow", { flowExecutionId: String(row.id) });
  for (const row of suites.rows) await submit(String(row.id), "suite", { suiteExecutionId: String(row.id) });
  if (requeued) console.warn(`[worker] requeued ${requeued} orphaned queued job(s)`);
}

const pulse = setInterval(() => { void heartbeat().catch((error) => console.error("[worker] heartbeat failed", error)); }, HEARTBEAT_MS);
pulse.unref();
void pruneLocalDead()
  .catch((error) => console.error("[worker] prune failed", error))
  .then(() => heartbeat())
  .catch((error) => console.error("[worker] heartbeat failed", error))
  /* 补投放在心跳之后：先让自己在注册表里可见，再去捡活。 */
  .then(() => requeueOrphans())
  .catch((error) => console.error("[worker] requeue failed", error));

/**
 * 停机时先停止领新活，再把在途请求跑完。
 *
 * 直接退出会留下一批 running 的行，只能等回收扫描兜底；等它们自然结束最多
 * 30 秒（请求超时上限），比留下脏状态划算。
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(reaper);
    clearInterval(pulse);
    await worker.close();
    /* 正常退出就把自己摘掉，不必等注册表过期。 */
    await pool.query("DELETE FROM workers WHERE id = $1", [WORKER_ID]).catch(() => {});
    await pool.end();
    process.exit(0);
  });
}

console.log(`[worker] ${WORKER_ID} consuming "${EXECUTION_QUEUE}" as ${WORKER_MODE} with concurrency ${CONCURRENCY}`);
