/*
 * P1 接口用例（交互文档 3.1.3）。
 *
 * 用例 = 请求快照 + 环境 + 断言，且**完全快照隔离**：request_snapshot 固化
 * 保存当时的请求定义，接口后续被修改不会回溯影响已保存的用例。所以这里存的
 * 是定义的副本，而不是指向 endpoints 的字段引用；endpoint_id 只表达归属，
 * 用于「该接口的用例列表」与用例数统计。
 */
CREATE TABLE IF NOT EXISTS test_cases (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  /* 环境被删除后用例仍要说明它原本绑定哪个环境，所以名字与 id 分开存，
     与 executions.environment_name 的做法一致（Spec 4.4 历史保留）。 */
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  environment_name TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  request_snapshot JSONB NOT NULL,
  assertions JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS test_cases_endpoint_created_at_idx ON test_cases(endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS test_cases_project_id_idx ON test_cases(project_id);

/*
 * 一次执行既可能来自接口调试，也可能来自用例回归。source 让两者可分：
 * 侧栏「调试记录」只看 endpoint_debug（临时验证，不留回归语义），用例的
 * 「最近结果」只看自己的 case_id。没有这一列，保存用例后每跑一次用例都会
 * 污染该接口的调试记录列表。
 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'endpoint_debug'
  CHECK (source IN ('endpoint_debug', 'test_case'));
ALTER TABLE executions ADD COLUMN IF NOT EXISTS case_id UUID REFERENCES test_cases(id) ON DELETE SET NULL;
/* 用例删除后历史仍要读得懂是哪个用例跑的（Spec 4.4 历史保留）。 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS case_name TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS assertion_results JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS executions_case_created_at_idx ON executions(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executions_endpoint_source_created_at_idx ON executions(endpoint_id, source, created_at DESC);
