/*
 * P2-1 增量（计划「第 1 批增量 · SQL 执行历史」）：交互式查询面板 `POST
 * .../data-sources/:id/query` 的执行历史。
 *
 * ── 只承接交互式 /query ──────────────────────────────────────────────────
 *
 * `test` 连接探针、flow 数据库步骤（已进 `execution_steps.output_snapshot`）、
 * `/public/sql-quick-call` 都不写这张表——它们各自已有记录，重复入表只会让「谁在
 * 控制台跑过什么」这件事被别处的噪声淹没。写入方只有 `/query`，且只对关系型
 * （`kind = 'sql'`）语句：mongo/redis 的 operation 不是 SQL，回填不进 SQL 编辑器，
 * 形状也对不上 statement_type / sql 两列。
 *
 * ── 元数据留存 + 小预览分开存（口径：小而恒定的「查询」与大而危险的「结果」分开）──
 *
 * 元数据（sql / statement_type / params / values / status / error / row_count /
 * duration_ms / truncated）永久留；结果只存一份 `result_preview`，由写路径独立截断到
 * `SQL_HISTORY_PREVIEW_BYTES`（缺省 32KB）或前 50 行——这层截断独立于执行器已有的
 * maxRows/maxBytes（common.ts，100 行 / 1MiB），保证单条历史体积恒定，与查询返回多大
 * 无关。失败查询不存预览，只存 error。`history_truncated` 记「预览这一层是否截过」，
 * 与执行器的 `truncated`（结果这一层是否截过）分开表达。
 *
 * ── 三层淘汰（任一触发即生效，上界 ≈ 用户数 × 数据源数 × 50 × 32KB）──────────
 *
 *   1. 单条体积上限：见上，写入前截断（lib/sqlHistory.ts）。
 *   2. 环形缓冲：每 (user_id, data_source_id) 只留最近 SQL_HISTORY_KEEP_PER_USER
 *      （缺省 50）条，插入后 DELETE 掉超出的（lib/sqlHistory.ts）。
 *   3. TTL：scheduler 一拍 DELETE created_at 早于 now() - SQL_HISTORY_TTL_DAYS
 *      （缺省 14 天），advisory-lock 多实例安全（lib/sqlHistory.ts + scheduler.ts）。
 *
 * ── FK 与索引 ────────────────────────────────────────────────────────────
 *
 * project_id / data_source_id / user_id 全 ON DELETE CASCADE——历史是「谁在控制台
 * 跑过什么」的审计副产物，源没了就该随之消散（不同于版本历史那种「曾经存在的内容」
 * 需活过引用）。读侧永远按 (user_id, data_source_id) 取、按 created_at 倒序翻，环形
 * 缓冲的 DELETE 也走同一组列，故这一条复合索引直接服务两者。
 */

CREATE TABLE IF NOT EXISTS sql_execution_history (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /* 只记关系型语句：mongo/redis 的 operation 不入这张表（见文件头）。 */
  statement_type TEXT NOT NULL CHECK (statement_type IN ('query', 'command')),
  sql TEXT NOT NULL,
  /* 参数定义（名/类型/必填/默认值）与本次试跑传入的实参值；两者都是 ad-hoc 面板的
     字面量，回填编辑器时按名对回。`values` 是保留字，作列名必须加引号。 */
  params JSONB NOT NULL DEFAULT '[]'::jsonb,
  "values" JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  /* 失败才有 error；成功才有 row_count / duration_ms（错误路径没有可信的行数与耗时）。 */
  error TEXT,
  row_count INTEGER,
  duration_ms DOUBLE PRECISION,
  /* 执行器那一层是否截断（结果超 maxRows/maxBytes）。 */
  truncated BOOLEAN NOT NULL DEFAULT false,
  /* 预览快照（写路径独立截断后的那一份）；失败查询为 NULL。 */
  result_preview JSONB,
  /* 预览这一层是否截断（超 SQL_HISTORY_PREVIEW_BYTES 或 50 行）。 */
  history_truncated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* 读列表、环形缓冲 DELETE、TTL 扫描都走这组列——一条复合索引全覆盖。 */
CREATE INDEX IF NOT EXISTS sql_execution_history_user_source_created_idx
  ON sql_execution_history (user_id, data_source_id, created_at DESC);
