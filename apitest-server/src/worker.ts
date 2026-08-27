import { hostname } from "node:os";
import { Worker } from "bullmq";
import { pool } from "./db.js";
import { performFlowRun } from "./lib/flowRun.js";
import { performSuiteRun } from "./lib/suiteRun.js";
import { inflightCount, listenForCancels, registerInflight, releaseInflight } from "./lib/inflight.js";
import { DEFAULT_RUNNER_LABEL, RUNNER_LABEL_PATTERN, createRedis, executionQueue, executionQueueName, type ExecutionJob } from "./lib/queue.js";
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
 * 这个 worker 服务哪些执行分区（P2-8）。
 *
 * 公司内网存在互不连通的网段，而 worker 只能从**自己所在网段**出站。分区标签就是
 * 「我这台机器能打到哪套系统」，队列按标签分裂（`executions-<label>`），所以一个只服务
 * `prod-dmz` 的 worker 领不到 `default` 的任务，反之亦然。
 *
 * **推荐一个进程只服务一个标签**：BullMQ 的 Worker 绑定单队列，多标签就是多个 Worker
 * 实例，容量必须拆分（见 `PER_LABEL_CONCURRENCY`）。多标签只作为单机开发的便利。
 *
 * 非法标签直接退出而不是静默丢掉：它会进 Redis key，写错一个字母的后果是「任务全部
 * 排队没人领」，而进程看起来一切正常——那是最难查的一类故障。
 */
const WORKER_LABELS = (process.env.WORKER_LABELS ?? DEFAULT_RUNNER_LABEL)
  .split(",").map((label) => label.trim()).filter(Boolean);
const uniqueLabels = [...new Set(WORKER_LABELS.length ? WORKER_LABELS : [DEFAULT_RUNNER_LABEL])];
for (const label of uniqueLabels) {
  if (!RUNNER_LABEL_PATTERN.test(label)) {
    console.error(`[worker] invalid WORKER_LABELS entry "${label}": expected ${RUNNER_LABEL_PATTERN}`);
    process.exit(1);
  }
}

/**
 * 多标签进程必须**拆分**并发（P2-8 边界 7）。
 *
 * 一个标签一个 BullMQ Worker 实例，各给一份 `WORKER_CONCURRENCY` 会让这台机器的真实
 * 容量凭空翻倍，而心跳上报的数字与执行器面板上的「总容量」就都是假的——按它做的容量
 * 规划会直接把被测服务打挂。
 */
const PER_LABEL_CONCURRENCY = Math.max(1, Math.floor(CONCURRENCY / uniqueLabels.length));
/** 心跳上报的是**实际**容量（拆分后的总和），不是环境变量里那个数。 */
const REPORTED_CONCURRENCY = PER_LABEL_CONCURRENCY * uniqueLabels.length;

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
 *
 * 取消频道保持**单条全局**（P2-8 边界 9）：取消是广播 + 持有者对号入座，按标签分频道
 * 只会让每个 worker 多订阅几条，没有收益。
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
 *
 * P2-8 起**每个分区一个 Worker 实例**：BullMQ 的 Worker 绑定单个队列名，而分区正是靠
 * 队列名分裂的。认领语句里还带 `runner_label` 防御（`performRun` 等），万一有 job 被投
 * 进错的队列，进程在 `fetch` 之前就退出，而不是从错误的网段发出一个真实请求。
 */
const workers = uniqueLabels.map((label) => new Worker<ExecutionJob>(
  executionQueueName(label),
  async (job) => {
    const id = "suiteExecutionId" in job.data ? job.data.suiteExecutionId
      : "flowExecutionId" in job.data ? job.data.flowExecutionId
        : job.data.executionId;
    const controller = registerInflight(id);
    try {
      /* 只传自己这一个标签，不是 `uniqueLabels`：这个 job 是从 `label` 那条队列来的，
         用全集去认领会让「投错队列」这道防御失效。 */
      if ("suiteExecutionId" in job.data) await performSuiteRun(id, controller.signal, WORKER_ID, [label]);
      else if ("flowExecutionId" in job.data) await performFlowRun(id, controller.signal, WORKER_ID, undefined, [label]);
      else await performRun(id, controller.signal, WORKER_ID, [label]);
    } finally {
      releaseInflight(id);
    }
  },
  { connection: createRedis(), concurrency: PER_LABEL_CONCURRENCY },
));

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
    `INSERT INTO workers (id, hostname, pid, concurrency, inflight, version, mode, labels)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET inflight = EXCLUDED.inflight, concurrency = EXCLUDED.concurrency, mode = EXCLUDED.mode, labels = EXCLUDED.labels, last_seen_at = now()`,
    /* 上报**拆分后**的实际容量：多标签进程各给一份 CONCURRENCY 会让面板上的总容量翻倍。 */
    [WORKER_ID, hostname(), process.pid, REPORTED_CONCURRENCY, inflightCount(), WORKER_VERSION, WORKER_MODE, uniqueLabels],
  );
}

/**
 * job 层面的失败兜底。
 *
 * `performRun` 自己把请求异常写成 failed，所以走到这里说明是它之外的事故
 * （取行失败、进程被杀等）。此时行还停在 running，没有人会再来收尾，必须在
 * 这里落终态，否则「运行中」会永远转圈。
 *
 * 分区化之后每个标签一个 Worker 实例，但处理逻辑完全一样，所以注册同一个回调而不是
 * 复制 N 份：终态是按 job 里的 id 写的，与它来自哪条队列无关。
 */
async function onJobFailed(job: { data?: ExecutionJob } | undefined, error: Error) {
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
}

for (const worker of workers) {
  worker.on("failed", (job, error) => { void onJobFailed(job, error); });
  worker.on("error", (error) => { console.error("[worker] queue error", error); });
}

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

/**
 * 回收**保持全局**，不按分区过滤（P2-8 边界 8）。
 *
 * 它管的是 DB 状态而不是队列：一条超时未终态的行必须被判死，不管它属于哪个网段——而
 * 那个网段的 worker 可能恰好整个都下线了，等它来收就永远不会有人收。并发由 advisory
 * lock 解决，与 `requeueOrphans` 那条「只碰自己看得见的分区」是两件不同的事。
 *
 * 已知行为（P2-8「已知行为」，**不是 bug**）：某分区 worker 在**入队之后**掉线，那批行
 * 仍会在 5 分钟后被这里判失败。`enqueue.ts` 的入队前在线检查只挡新的，挡不住这种。
 */
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
 *
 * **只补投自己服务的分区**（P2-8 边界 8）：一个 worker 不该对它看不见的分区采取行动。
 * 少了这层过滤，测试网段的 worker 会把生产分区的行投进 `executions:prod-dmz`——那条队列
 * 它自己也领不到，看起来无害，但真正的问题是它凭什么替另一个网段做决定；反过来若忘了按
 * 行标签选队列，就会把生产的活投进 `default`，由本网段 worker 发出去。
 * （`reapStale` 保持全局：它管的是 DB 状态而不是队列，advisory lock 已经解决并发。）
 */
async function requeueOrphans() {
  /* 先老的后新的：真要排队，也让等得最久的先跑。 */
  const [runs, flows, suites] = await Promise.all([
    pool.query("SELECT id, runner_label FROM executions WHERE status = 'queued' AND runner_label = ANY($1) ORDER BY created_at", [uniqueLabels]),
    pool.query("SELECT id, runner_label FROM flow_executions WHERE status = 'queued' AND runner_label = ANY($1) ORDER BY created_at", [uniqueLabels]),
    pool.query("SELECT id, runner_label FROM suite_executions WHERE status = 'queued' AND runner_label = ANY($1) ORDER BY created_at", [uniqueLabels]),
  ]);

  let requeued = 0;
  const submit = async (id: string, label: string, name: "run" | "flow" | "suite", data: ExecutionJob) => {
    /* 队列按**行上的**标签选，不是按 `uniqueLabels[0]`：多标签进程补投时必须逐行对号。 */
    const queue = executionQueue(label);
    const existing = await queue.getJob(id);
    if (existing) {
      /* 还在队列里（等待 / 在途 / 延迟）：本来就会被跑到，不要碰它。 */
      if (!(await existing.isCompleted()) && !(await existing.isFailed())) return;
      await existing.remove();
    }
    await queue.add(name, data, { jobId: id });
    requeued += 1;
  };

  for (const row of runs.rows) await submit(String(row.id), String(row.runner_label), "run", { executionId: String(row.id) });
  for (const row of flows.rows) await submit(String(row.id), String(row.runner_label), "flow", { flowExecutionId: String(row.id) });
  for (const row of suites.rows) await submit(String(row.id), String(row.runner_label), "suite", { suiteExecutionId: String(row.id) });
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
    await Promise.all(workers.map((worker) => worker.close()));
    /* 正常退出就把自己摘掉，不必等注册表过期。 */
    await pool.query("DELETE FROM workers WHERE id = $1", [WORKER_ID]).catch(() => {});
    await pool.end();
    process.exit(0);
  });
}

/* 打印**实际**队列名而不是一个常量：分区配错时「这台机器在听哪条队列」是第一个要看的
   事实，而错配的表现是「任务一直排队没人领」，从进程日志上看不出任何异常。 */
console.log(`[worker] ${WORKER_ID} consuming ${uniqueLabels.map((label) => `"${executionQueueName(label)}"`).join(", ")} as ${WORKER_MODE} with concurrency ${PER_LABEL_CONCURRENCY} per partition (${REPORTED_CONCURRENCY} total)`);
