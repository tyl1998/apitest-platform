/*
 * P4.5-13: pipeline_run_cases 的 timeline 数据（边界 19 的第一层）。
 *
 * 之前解析器算完 duration 就把 start/stop 扔了、host/thread 根本没取——timeline 恰好
 * 只要这四样，数据不在库里，想画也画不了。列全部可空：junit 路径（B）没有这些概念，
 * allure 适配器缺字段的文件也不该因此丢行；渲染侧按「有 started_at_ms 的行进时间轴，
 * 没有的按 suite 顺序列表」降级。
 *
 * 毫秒用 BIGINT 存（不转 timestamptz）：allure 的 start/stop 是 epoch 毫秒整数，
 * 转时间戳要除一次 1000、渲染时再乘回去，两次舍入换不来任何查询能力——timeline 是
 * 客户端算术，不是 SQL 谓词。host/thread 是 allure 的 label（'host' / 'thread'），
 * 并行执行的时间轴按 thread 分泳道，别按 suite 猜。
 */
ALTER TABLE pipeline_run_cases
  ADD COLUMN IF NOT EXISTS started_at_ms BIGINT,
  ADD COLUMN IF NOT EXISTS finished_at_ms BIGINT,
  ADD COLUMN IF NOT EXISTS host TEXT,
  ADD COLUMN IF NOT EXISTS thread TEXT;

/* run 详情页 cases tab 按 run 读全量行，现状只有 UNIQUE 索引可用；时间轴排序是
   (started_at_ms NULLS LAST, case_name)——建一个覆盖排序列的索引，别让 2 万行的
   run 靠全表排序出时间轴。 */
CREATE INDEX IF NOT EXISTS pipeline_run_cases_run_order_idx
  ON pipeline_run_cases (pipeline_run_id, started_at_ms, case_name);
