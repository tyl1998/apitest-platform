/*
 * P1-3 队列异步执行（DEVELOPMENT_PLAN 4.4）。
 *
 * 执行从「跑完才 INSERT」改成「入队即 INSERT，worker 跑完再 UPDATE」。这样
 * 前端拿到 executionId 后立刻能查到这一行，真异步与进度推送才有落点。
 * 代价是 status 不再只有终态，读取方必须自己区分「还没跑完」与「跑完失败」。
 */

/* 建表时的匿名 CHECK 由 Postgres 命名为 <table>_<column>_check。 */
ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_status_check;
ALTER TABLE executions ADD CONSTRAINT executions_status_check
  CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled'));

/*
 * created_at 一直是「入队时刻」，另记开始与结束，这样排队等待时长
 * (started_at - created_at) 与请求耗时 (duration_ms) 可以分开看——两者混在
 * 一个字段里会让「接口慢」和「队列堵」无法区分。
 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

/*
 * 待执行的请求定义。worker 只从 job 里拿 executionId，其余一律回读这张表，
 * 于是 Redis 里不会出现任何请求体或凭据，队列与真相来源也不会分叉。
 *
 * 存的是**未插值**的快照：{{var}} 还没展开，所以这里没有环境 secret 的明文。
 * 用例执行允许传 request/assertions 覆盖且不落盘，覆盖后的定义也存在这里，
 * 这是 worker 唯一能拿到它的地方。
 * 它含有 auth 明文（与 endpoints.auth、test_cases.request_snapshot 同级），
 * 因此 mapExecution 绝不映射该列。
 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS run_spec JSONB;

/* 队列领取与卡死回收都按 status 过滤，未终态的行只占很小比例。 */
CREATE INDEX IF NOT EXISTS executions_pending_idx
  ON executions(status, created_at) WHERE status IN ('queued', 'running');

/*
 * 批次同样需要「排队中」与「已取消」：入队后 worker 尚未开工时它既不是
 * running 也不是 completed，没有 queued 就只能撒谎成 running。
 */
ALTER TABLE batch_executions DROP CONSTRAINT IF EXISTS batch_executions_status_check;
ALTER TABLE batch_executions ADD CONSTRAINT batch_executions_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'canceled'));

ALTER TABLE batch_executions ADD COLUMN IF NOT EXISTS canceled_count INTEGER NOT NULL DEFAULT 0;
