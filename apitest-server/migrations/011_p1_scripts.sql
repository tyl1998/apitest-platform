/*
 * P1-1 断言收尾：脚本存储 + JSON Schema / 自定义脚本断言。
 *
 * 脚本分两种模式：
 * 1. 具名公共脚本（name 非空，owner_case_id 为空）：属于项目，可被多个用例/节点引用，
 *    引用方前端可选 follow（共享更新）或 copy（脱离成匿名脚本）。
 * 2. 匿名私有脚本（name 为空，owner_case_id 非空）：随宿主用例生灭，ON DELETE CASCADE。
 *
 * P1 只做用例断言场景，owner_case_id 够用；P1-2 DAG 脚本节点会增加 owner_flow_id
 * 列并放宽 CHECK 约束。language 列现在就加，即使只允许 'javascript'，理由同
 * workers.mode：事后加列无法回填历史行的真实值。
 */
CREATE TABLE IF NOT EXISTS scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  /* NULL = 匿名（随宿主生灭），非 NULL = 具名公共脚本（可被多处引用）。 */
  name TEXT,
  language TEXT NOT NULL DEFAULT 'javascript' CHECK (language IN ('javascript')),
  content TEXT NOT NULL,
  /* P1 只支持用例所有；P1-2 再加 owner_flow_id 并改约束为"至少一个 owner 或为公共脚本"。 */
  owner_case_id UUID REFERENCES test_cases(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  /* 具名公共脚本无 owner；匿名脚本必须有 owner。 */
  CHECK ((name IS NOT NULL AND owner_case_id IS NULL) OR (name IS NULL AND owner_case_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS scripts_project_id_idx ON scripts(project_id);
CREATE INDEX IF NOT EXISTS scripts_owner_case_id_idx ON scripts(owner_case_id) WHERE owner_case_id IS NOT NULL;
/* 具名脚本名称在项目内唯一，便于前端按名称搜索复用。 */
CREATE UNIQUE INDEX IF NOT EXISTS scripts_project_name_unique_idx ON scripts(project_id, name) WHERE name IS NOT NULL;

/*
 * 删除公共脚本前要先查"谁在引用我"，引用关系存在 test_cases.assertions 的
 * JSONB 里（{ script: { scriptId } }），只能用 containment 查询。没有这个索引
 * 每次删除确认都要全表扫 assertions。
 */
CREATE INDEX IF NOT EXISTS test_cases_assertions_gin_idx ON test_cases USING gin (assertions);
