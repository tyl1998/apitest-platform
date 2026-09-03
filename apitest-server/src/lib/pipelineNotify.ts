import type { PoolClient } from "pg";
import { pool } from "../db.js";

/**
 * `pipeline_queued` 的共享监听与等待分发（P4.5-3，8.2 约定 2）。
 *
 * 长轮询的「秒级启动」靠 NOTIFY 立刻醒，而不是把轮询间隔压到秒级——20 台 Runner 配
 * 1 秒轮询就是每秒 20 次 claimable 部分索引扫描。触发侧（`lib/trigger.ts`）在入队事务里
 * `pg_notify('pipeline_queued', <label>)`，随 commit 投递。
 *
 * **一个进程一条监听连接**，而不是每个等待中的 claim 各占一条：N 台 Runner 长轮询就是
 * N 个并发请求，每请求一条 LISTEN 连接会把连接预算吃穿（Postgres 默认 max_connections
 * 100，API 自己的池子也在用）。等待者按标签过滤：NOTIFY 的载荷是入队行的分区标签，
 * 只唤醒声明了这个标签的等待者——`default` 分区入队不该把 `prod-dmz` 的轮询全部惊醒。
 *
 * 已知取舍（不是 bug）：监听连接挂掉时，已在等待的请求不会立刻醒，最多等到自己的
 * 25 秒超时返回 204，Runner 下一轮长轮询会重建监听。监听是延迟优化而不是正确性依赖，
 * 为它做重试风暴防护不值得。
 */

type Waiter = { labels: string[]; wake: () => void };

const waiters = new Set<Waiter>();
let listener: PoolClient | undefined;
let starting: Promise<void> | undefined;

function resetListener(client: PoolClient) {
  /* 只复位当前这条：并发重建时旧连接的 error 事件不该把新连接抹掉。 */
  if (listener === client) listener = undefined;
  if (starting) starting = undefined;
  /* pg 的 release() 返回 void（同步），不是 promise——包一层 catch 形状以防类型升级。 */
  try {
    const released = client.release() as unknown;
    if (released && typeof (released as Promise<void>).catch === "function") (released as Promise<void>).catch(() => {});
  } catch {
    /* 释放失败的连接由池的 idle timeout 收尸。 */
  }
}

async function ensureListener(): Promise<void> {
  if (listener) return;
  starting ??= (async () => {
    const client = await pool.connect();
    client.on("notification", (message) => {
      if (message.channel !== "pipeline_queued") return;
      const label = message.payload ?? "";
      for (const waiter of waiters) {
        /* 载荷为空读作「唤醒所有人」：NOTIFY 语句是我们自己发的，载荷缺失只可能来自
           手工 psql 调试，那时宁可多醒一次（多醒的代价只是一次空 claim 尝试）。 */
        if (!label || waiter.labels.includes(label)) waiter.wake();
      }
    });
    client.on("error", (error) => {
      console.error("[pipelineNotify] listener failed, waiters fall back to poll timeout", error);
      resetListener(client);
    });
    await client.query("LISTEN pipeline_queued");
    listener = client;
  })().catch((error) => {
    starting = undefined;
    throw error;
  });
  await starting;
}

/**
 * 等一次匹配的入队通知，最多 `timeoutMs`。
 *
 * 监听建立失败不抛：长轮询的正确性底线是「超时后重试 claim」，醒不来只是这一轮
 * 多等满超时——让 DB 抖动变成 500 会让所有 Runner 的轮询循环一起崩。
 */
export async function waitForPipelineQueued(labels: string[], timeoutMs: number): Promise<void> {
  try {
    await ensureListener();
  } catch (error) {
    console.error("[pipelineNotify] could not establish listener", error);
    /* 不等通知，直接睡满超时：调用方醒来后会再试一次 claim。 */
    await new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.());
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(waiter);
      resolve();
    };
    const waiter: Waiter = { labels, wake: done };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    waiters.add(waiter);
  });
}
