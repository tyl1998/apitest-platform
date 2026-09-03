/*
 * P4.5-8: idempotency_keys / audit_logs（通用设施，计划 8.1 的 039 的后一半）。
 *
 * 8.1 把 artifacts / idempotency_keys / audit_logs 排进一个 039，但迁移是 forward-only
 * 的，P4.5-7 落地时只建了 artifacts（039_p45_artifacts.sql），这两张表留给本文件
 * （039b）。表结构逐字照抄计划 8.1。
 *
 * `idempotency_keys` 用复合主键而不是「UUID 主键 + 唯一索引」（8.1 的注释原话）：这张表
 * **只**被「按 key 查有没有」这一种方式访问，一个自增 id 是纯粹的多余空间。`result_id`
 * 无 FK——scope 决定它指向哪张表。
 *
 * `audit_logs.detail` 绝不放 secret 值（8.1 的列注释原话）：审计日志天然会被广泛读取，
 * 是最容易发生「顺手把 payload 整个塞进去」的地方。
 *
 * 两张表都不带 `ci_` 前缀：它们从第一天起就该能被套件触发、流程触发复用——本阶段
 * 只有 CI 触发与 Runner Token 签发接上去（边界 17：不追溯改造既有触发接口）。
 */
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,                                -- 'ci_task_trigger' 等
  key TEXT NOT NULL,                                  -- 客户端给的 Idempotency-Key
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  result_id UUID NOT NULL,                            -- 首次调用产生的那一行
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, project_id, key)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,   -- 可空：系统级动作
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,                               -- 'ci_task.trigger' / 'runner_token.create' …
  target_type TEXT NOT NULL,
  target_id UUID,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,          -- 绝不放 secret 值
  ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_project_created_at_idx
  ON audit_logs (project_id, created_at DESC);
