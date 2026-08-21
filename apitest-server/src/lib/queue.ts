import { Queue } from "bullmq";
import { Redis } from "ioredis";

/**
 * 执行队列（P1-3）。API 进程入队，worker 进程消费。
 *
 * job 载荷只有 executionId：请求定义、环境、断言一律由 worker 从
 * `executions` 回读。这样 Redis 里不存在任何请求体与凭据，且队列不会成为
 * 第二真相来源——一行 execution 就是一次执行的全部事实。
 */
export const EXECUTION_QUEUE = "executions";

/** 取消广播频道。BullMQ 只能移除尚未开始的 job，中断在途请求得靠它。 */
export const CANCEL_CHANNEL = "executions:cancel";

/**
 * job 载荷。
 *
 * 流程执行与单次执行共用同一个队列而不是各开一条：两者都是「等 HTTP 响应」的
 * IO 型任务，抢的是同一份并发预算，分队列只会让一边饿死另一边闲着。用可辨识
 * 联合区分，worker 按形状分派——载荷仍然只有 id。
 */
export type ExecutionJob = { executionId: string } | { flowExecutionId: string };

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * BullMQ 要求阻塞命令的连接 `maxRetriesPerRequest` 为 null，否则 worker 在
 * Redis 短暂抖动时会抛错退出而不是重连。
 */
export function createRedis(): Redis {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: null });
}

let queue: Queue<ExecutionJob> | undefined;

/** 延迟建连，这样单跑 migrate 之类的脚本不会连 Redis。 */
export function executionQueue() {
  queue ??= new Queue<ExecutionJob>(EXECUTION_QUEUE, {
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
  return queue;
}
