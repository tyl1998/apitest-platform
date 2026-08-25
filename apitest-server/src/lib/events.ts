import { createRedis } from "./queue.js";

/**
 * 执行状态变更的跨进程广播（P1-3）。
 *
 * worker 与 API 是两个进程，浏览器只连得到 API，所以状态变更必须从 worker
 * 经 Redis 转一手才能推给前端。
 *
 * 载荷刻意只有标识与状态，不含响应体：SSE 是项目级的流，把响应体塞进去等于
 * 把每一次执行的响应推给该项目所有在线成员。前端收到终态后再按 id 拉详情。
 */
export const EVENT_CHANNEL = "executions:events";

export type ExecutionEvent =
  | { kind: "execution"; projectId: string; executionId: string; status: string; batchId?: string; caseId?: string; flowExecutionId?: string; flowNodeId?: string; endpointId: string }
  | { kind: "batch"; projectId: string; batchId: string; status: string; total: number; successCount: number; failedCount: number; canceledCount: number }
  /* 非 HTTP 节点（数据库/脚本/条件，P2-2）没有 executions 行，进度走 step 事件。 */
  | { kind: "step"; projectId: string; stepId: string; status: string; flowExecutionId?: string; flowNodeId: string; nodeType: string }
  /* 流程父记录的进度（P1-2）。节点级进度仍走 execution/step 事件，只是多带一个
     flowExecutionId，这样画布与执行记录页可以复用同一条流。 */
  | { kind: "flow"; projectId: string; flowExecutionId: string; executionIndexId?: string; status: string; total: number; successCount: number; failedCount: number; skippedCount: number }
  /* 套件父记录的进度（P2-4）。成员级进度不需要新事件：一个成员就是一次独立执行，
     它自己已经在流上发 execution / flow 事件，这一条只描述父级计数与终态。 */
  | { kind: "suite"; projectId: string; suiteExecutionId: string; executionIndexId?: string; status: string; total: number; successCount: number; failedCount: number; skippedCount: number };

let publisher: ReturnType<typeof createRedis> | undefined;

/** worker 侧：发布一次状态变更。 */
export async function publishEvent(event: ExecutionEvent) {
  publisher ??= createRedis();
  await publisher.publish(EVENT_CHANNEL, JSON.stringify(event));
}

type Listener = (event: ExecutionEvent) => void;

/**
 * API 侧的扇出中心。
 *
 * 一个 Redis 订阅连接对应进程内任意多个 SSE 客户端——订阅连接不能复用
 * `Pool` 里的连接，也没必要每个浏览器开一条。
 */
const listeners = new Set<Listener>();
let subscriber: ReturnType<typeof createRedis> | undefined;

export function subscribeEvents(listener: Listener) {
  if (!subscriber) {
    subscriber = createRedis();
    void subscriber.subscribe(EVENT_CHANNEL);
    subscriber.on("message", (_channel, payload) => {
      let event: ExecutionEvent;
      /* 坏消息不能拖垮扇出：解析失败就丢弃这一条。 */
      try { event = JSON.parse(payload) as ExecutionEvent; } catch { return; }
      for (const each of listeners) each(event);
    });
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
