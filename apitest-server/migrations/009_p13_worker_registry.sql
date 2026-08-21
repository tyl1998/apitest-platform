/*
 * P1-3 执行器可观测（系统设置 →「执行器」）。
 *
 * worker 只出不进——不监听任何端口，编排系统与平台都无法主动探它。所以它
 * 反过来定期把自己写进这张表，「在线」由 last_seen_at 的新鲜度推断，而不是
 * 由某处维护的一份名单决定。这样进程被 kill -9 也不会留下永远「在线」的幽灵。
 */
CREATE TABLE IF NOT EXISTS workers (
  /* hostname:pid —— 同一台机器跑多个 worker 时也能区分。 */
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL,
  /* 这台 worker 允许的同时在途数，即它给自己定的容量。 */
  concurrency INTEGER NOT NULL,
  /* 心跳那一刻实际在途的请求数，用来看负载是否均匀。 */
  inflight INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/*
 * 哪个 worker 跑的这次执行。
 *
 * 多 worker 之后，「某些执行特别慢」必须能落到具体机器上，否则只能靠猜。
 * 不加外键：worker 下线后行会被清掉，而执行历史必须活得比它久
 * （与 endpoint_name / environment_name 的快照思路一致，Spec 4.4 历史保留）。
 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS worker_id TEXT;

CREATE INDEX IF NOT EXISTS executions_worker_created_at_idx
  ON executions(worker_id, created_at DESC);
