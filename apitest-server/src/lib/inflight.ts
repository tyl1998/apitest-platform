import { CANCEL_CHANNEL, createRedis } from "./queue.js";

/**
 * 在途中断句柄的进程内登记表（P1-2 起共享）。
 *
 * BullMQ 只能移除尚未开始的 job，已经在 `await fetch` 里的必须靠 AbortController
 * 打断，而 controller 只存在于**正在跑它的那个进程**内存里——所以取消要先经 Redis
 * 广播到所有 worker，再由持有者对号入座。
 *
 * 之所以从 worker.ts 提出来：流程执行占一个 job（登记 flowExecutionId），但它内部
 * 每一步又是一条独立的 execution 行，用户可以单独取消其中一步。只登记 job 那一层
 * 会让「取消某一步」只改数据库状态而不真正打断请求，那一步仍会把请求发完。
 */
const inflight = new Map<string, AbortController>();

export function registerInflight(id: string): AbortController {
  const controller = new AbortController();
  inflight.set(id, controller);
  return controller;
}

export function releaseInflight(id: string) {
  inflight.delete(id);
}

export function inflightCount() {
  return inflight.size;
}

/** worker 进程启动时调一次：订阅取消广播并对号入座。 */
export function listenForCancels() {
  const canceller = createRedis();
  void canceller.subscribe(CANCEL_CHANNEL);
  canceller.on("message", (_channel, id) => {
    /* 不是本进程在跑的就没有句柄，忽略即可——广播必然扇出到所有 worker。 */
    inflight.get(id)?.abort(new Error("canceled by user"));
  });
  return canceller;
}
