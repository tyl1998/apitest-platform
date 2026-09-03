/*
 * 报告分享（2026-09-02，验收反馈：所有报告支持分享、免登录查看）。
 *
 * 一条分享 = 一个 192-bit 随机 token 换一份只读报告视图。目标两类：
 * 'suite' = suite_executions.id（套件报告），'runner' = pipeline_runs.id（仓库执行报告）。
 *
 * target_id 刻意不加外键：两张目标表各自有自己的删除语义（ci_tasks 级联掉 run、
 * 套件删除把 suite_id 置 NULL 但执行行保留），一个多态列没法同时声明两种行为；
 * 公开读路由按目标存在性回 404，悬空 token 自然失效。project_id 上的 CASCADE 负责
 * 项目删除时连带清掉分享行。
 *
 * 部分唯一索引保证「一个目标同时只有一条有效分享」：重复点分享拿到同一条链接，
 * 而不是每次都造一条新 token 让旧链接失控地漂在外面。撤销 = UPDATE revoked_at，
 * 索引立刻放行下一条新建。
 */
CREATE TABLE IF NOT EXISTS report_shares (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('suite', 'runner')),
  target_id UUID NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS report_shares_active_target_idx
  ON report_shares (target_type, target_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS report_shares_project_idx ON report_shares (project_id);
