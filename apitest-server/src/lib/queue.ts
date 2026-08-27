import { Queue } from "bullmq";
import { Redis } from "ioredis";

/**
 * 执行队列（P1-3）。API 进程入队，worker 进程消费。
 *
 * job 载荷只有 executionId：请求定义、环境、断言一律由 worker 从
 * `executions` 回读。这样 Redis 里不存在任何请求体与凭据，且队列不会成为
 * 第二真相来源——一行 execution 就是一次执行的全部事实。
 */
const EXECUTION_QUEUE_PREFIX = "executions";

/**
 * 默认执行分区（P2-8）。
 *
 * 迁移 027 的三张执行表与 `environments.runner_label` 都以它为 DEFAULT，所以「没配过
 * 分区」与「配了 default」在路由上是同一件事，不需要区分 NULL。
 */
export const DEFAULT_RUNNER_LABEL = "default";

/**
 * 分区标签格式（P2-8 边界 3）。
 *
 * 它**会进 Redis key**（`executions-<label>`），不约束就会写出奇怪的键。校验放在路由层
 * 而不是 CHECK 约束：错误信息要能回给用户。
 */
export const RUNNER_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * 一个分区的队列名（P2-8）。
 *
 * 队列名从常量 `executions` 变成 `executions-<label>`：worker 只能从自己所在网段出站，
 * 所以「谁能领这个 job」必须由队列本身表达，而不是靠 worker 自觉。
 *
 * 分隔符是 `-` 而**不是** `:`：BullMQ 6 明确拒绝名字里带 `:` 的队列
 * （`QueueBase` 构造函数直接抛 `Queue name cannot contain :`），因为它自己用 `:` 拼
 * Redis key 的层级。`-` 不产生歧义——前缀固定，其后整段就是标签，而标签自身唯一。
 * （`CANCEL_CHANNEL` 仍可以带 `:`：那是 pub/sub 频道，不经 BullMQ 的队列名校验。）
 *
 * 一次性代价（计划 5.0.12「一次性代价」）：改名后 Redis 里现存的 job 会成为孤儿。按
 * AGENTS.md 数据兼容条款不写兼容代码，清一次开发 Redis 即可——库里 `queued` 的行由
 * worker 启动时的 `requeueOrphans` 自己捡回来。
 */
export function executionQueueName(label: string = DEFAULT_RUNNER_LABEL) {
  return `${EXECUTION_QUEUE_PREFIX}-${label}`;
}

/**
 * 取消广播频道。BullMQ 只能移除尚未开始的 job，中断在途请求得靠它。
 *
 * **保持单条全局频道**（P2-8 边界 9）：取消是广播 + 持有者对号入座，按标签分频道只会让
 * 每个 worker 多订阅几条，没有收益。
 */
export const CANCEL_CHANNEL = "executions:cancel";

/**
 * job 载荷。
 *
 * 流程执行、套件执行与单次执行共用同一个队列而不是各开一条：三者都是「等 HTTP 响应」的
 * IO 型任务，抢的是同一份并发预算，分队列只会让一边饿死另一边闲着。用可辨识
 * 联合区分，worker 按形状分派——载荷仍然只有 id。
 *
 * 套件的**成员不入队**（P2-4.2，计划 5.0.11 边界 2）：成员在套件自己的槽内进程内扇出。
 * 给成员入队会让「等子任务的父槽」把 `WORKER_CONCURRENCY` 吃光——与 5.0.8 容器持令牌
 * 的死锁同一类错误。
 */
export type ExecutionJob = { executionId: string } | { flowExecutionId: string } | { suiteExecutionId: string };

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * BullMQ 要求阻塞命令的连接 `maxRetriesPerRequest` 为 null，否则 worker 在
 * Redis 短暂抖动时会抛错退出而不是重连。
 */
export function createRedis(): Redis {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: null });
}

/**
 * 每个分区一条队列，按标签缓存（P2-8）。
 *
 * `Map<label, Queue>` 而不是单例：一个 API 进程要能同时往 `default` 与 `prod-dmz` 投递，
 * 而 BullMQ 的 Queue 绑定单个队列名。延迟建连保持不变，这样单跑 migrate 之类的脚本
 * 不会连 Redis；每条队列各自持一个连接，只在真的用到那个分区时才建。
 */
const queues = new Map<string, Queue<ExecutionJob>>();

export function executionQueue(label: string = DEFAULT_RUNNER_LABEL) {
  let queue = queues.get(label);
  if (queue) return queue;
  queue = new Queue<ExecutionJob>(executionQueueName(label), {
    connection: createRedis(),
    defaultJobOptions: {
      /*
       * 不重试：一次执行是一条用户可见的记录，自动重跑会凭空多出一次请求，
       * 对写接口更是危险。失败就是失败，重跑由用户决定。
       */
      attempts: 1,
      /* 完成的 job 立刻可弃——结果在 Postgres 里，Redis 只是传递通道。 */
      removeOnComplete: true,
      removeOnFail: { count: 100 },
    },
  });
  queues.set(label, queue);
  return queue;
}
