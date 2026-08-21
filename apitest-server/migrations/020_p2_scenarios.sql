/*
 * P2-3 场景（DEVELOPMENT_PLAN 5.0.3 第 3 批 / 交互文档 3.4）。
 *
 * 场景与流程刻意不同源：流程节点是**快照**（一份独立的请求定义，接口改了也不回溯），
 * 场景步骤是**引用**——它的价值就是复用已经在维护的接口用例，用例修好了场景下一次
 * 跑就是修好的版本。为此步骤只存 case_id 加一份名称快照，请求定义在**入队时**冻结进
 * run_spec，于是「入队后编辑场景或用例不改变本次执行」（5.5.2 第 3 条）依然成立。
 *
 * 执行存储沿用 P2-0 的统一模型：scenario_executions 是父记录并挂 execution_index，
 * 每一步落一行 execution_steps；接口用例步骤额外落一行 executions，这样请求/响应快照
 * 抽屉、接口维度历史、取消与卡死回收全部零改动继承。
 */
CREATE TABLE IF NOT EXISTS scenarios (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  /* 场景级环境，与流程同一条理由：一次场景跑在一套环境上，中途换环境后
     「上一步拿到的 token 在下一步还有效吗」没有可解释的答案。 */
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  environment_name TEXT,
  /*
   * steps: [{ id, type: 'case' | 'database', name, onFailure, extracts, ... }]
   *
   * 存 JSONB 而不是拆表：步骤没有独立生命周期也不跨场景复用，拆表只会把一次保存
   * 变成 N 条 upsert 加一次删除对齐。id 由客户端生成且稳定，执行证据引用它——
   * 因此「步骤失败可定位到固定 step id」不依赖可改的显示名称。
   */
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  /* 场景级初始变量，第一个步骤可见，优先级高于环境变量。 */
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  /*
   * 后置 SQL 校验：[{ id, name, dataSourceId, sqlDefinitionId|sql, parameters, assertions }]
   * 只断言落库结果，**不写变量**（Spec 2.7.4），所以这里没有 extracts 的位置。
   */
  post_checks JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scenarios_project_created_at_idx ON scenarios(project_id, created_at DESC);
/*
 * 删除用例、数据源或命名 SQL 前要扫「谁在引用我」，引用关系在 steps / post_checks 的
 * JSONB 里，只能用 containment 查询；没有索引每次删除确认都要全表扫。
 */
CREATE INDEX IF NOT EXISTS scenarios_steps_gin_idx ON scenarios USING gin (steps);
CREATE INDEX IF NOT EXISTS scenarios_post_checks_gin_idx ON scenarios USING gin (post_checks);

/*
 * 一次场景执行。scenario_id 用 ON DELETE SET NULL 并快照 scenario_name：删掉场景
 * 不该删掉它跑过的历史（Spec 4.4 历史保留），与 flow_executions 同款。
 */
CREATE TABLE IF NOT EXISTS scenario_executions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scenario_id UUID REFERENCES scenarios(id) ON DELETE SET NULL,
  scenario_name TEXT NOT NULL,
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  environment_name TEXT,
  /* 与 executions.status 同一套词汇：queued/running 不是结论，通过率必须排除。 */
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled')),
  /* 计划条目数 = 步骤数 + 后置校验数。 */
  total INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  /*
   * 执行计划：[{ stepId, name, type, endpointId?, caseId? }]。run_spec 落终态即清空
   * （含 auth 明文），但「本次原本要跑哪些步骤、什么顺序」必须活得比它久，否则已完成
   * 的场景无法区分「步骤未执行」与「步骤不存在」。
   */
  plan JSONB NOT NULL DEFAULT '[]'::jsonb,
  /* 终态时的场景变量袋（已按环境 secret 掩码），用于复盘取值。 */
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  /* 待执行的场景快照，含 auth 明文，落终态即置 NULL——理由同 executions.run_spec。 */
  run_spec JSONB,
  worker_id TEXT,
  execution_index_id UUID REFERENCES execution_index(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS scenario_executions_project_created_at_idx ON scenario_executions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scenario_executions_scenario_created_at_idx ON scenario_executions(scenario_id, created_at DESC);
/* 认领与卡死回收都按 status 过滤，未终态的行只占很小比例。 */
CREATE INDEX IF NOT EXISTS scenario_executions_pending_idx
  ON scenario_executions(status, created_at) WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS scenario_executions_execution_index_id_idx
  ON scenario_executions(execution_index_id) WHERE execution_index_id IS NOT NULL;

/*
 * 第四类执行来源。场景里的接口用例步骤记为 scenario_step：它确实是一次用例执行
 * （case_id / case_name 照常写），但必须能与「在接口工作台里单独跑这条用例」区分开，
 * 否则用例历史里两种上下文混在一起没法读。
 */
ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_source_check;
ALTER TABLE executions ADD CONSTRAINT executions_source_check
  CHECK (source IN ('endpoint_debug', 'test_case', 'flow_step', 'scenario_step'));

/* SET NULL 而非 CASCADE，与 batch_id / flow_execution_id 一致：父记录消失不该带走执行历史。 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS scenario_execution_id UUID REFERENCES scenario_executions(id) ON DELETE SET NULL;
/* 步骤 id 是场景文档内的字符串，不是表主键，所以没有外键可加。 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS scenario_step_id TEXT;

CREATE INDEX IF NOT EXISTS executions_scenario_execution_idx ON executions(scenario_execution_id, created_at);
