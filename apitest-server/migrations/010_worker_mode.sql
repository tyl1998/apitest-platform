/*
 * worker 模式（P1-3 铺垫）。
 *
 * 现在只有接口执行一种 worker。仓库模式尚未实现，但这一列现在加最便宜——等真做
 * 出来再加就得处理已有行的回填，而回填时无法区分历史行到底属于哪种模式。
 *
 * 注意：仓库模式的队列深度不能复用 `executions` 队列。那是接口执行专用的，
 * 仓库任务性质不同，必然是另一个队列。所以前端按模式筛选时，队列指标只对
 * endpoint 模式有意义。
 */
ALTER TABLE workers ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'endpoint';

ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_mode_check;
ALTER TABLE workers ADD CONSTRAINT workers_mode_check
  CHECK (mode IN ('endpoint', 'repository'));
