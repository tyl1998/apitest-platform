/*
 * P2-4: 测试套件 + 统一执行记录。范围与边界见 DEVELOPMENT_PLAN.md 5.0.11。
 *
 * 编号说明：计划原写 022，但 022 已被 022_p26_advanced_nodes.sql 占用（P2-6 提前
 * 落地）。023 是历史空洞，**永久弃用**——补一个 023 会让「文件名顺序 = 实际应用
 * 顺序」这条前提失效（024/025 已记录在 schema_migrations 里，再插 023 只会造成
 * 「按名字排在前面、其实跑在后面」的误导）。Mock 迁移顺延为 027。
 *
 * 套件与流程的关系是「父执行索引 + 类型明细行」的第二个实例：
 * execution_index(kind='suite') 负责被统一列表看见，suite_executions 负责放
 * index 装不下的东西（环境、错误、成员快照、run_spec、worker_id）。'suite' 015
 * 就已经在 kind 的 CHECK 里，所以套件本身不需要放宽任何约束。
 */

/*
 * 套件定义。
 *
 * 编排只有流程一种模型（5.0.1 第 4 条）：套件只负责**选谁**和**怎么跑**，不持有
 * 请求、不传变量。所以这张表没有 nodes/edges，只有选择方式与执行配置。
 *
 * selection_type 决定 selection_config 的形状：
 *   manual → { members: [{ type: 'case'|'flow', id }] }  有序、同一 id 只允许一次
 *   tag    → { tags: [...], match: 'any'|'all', include: { cases, flows } }
 *   all    → { include: { cases, flows } }
 * 形状不进 CHECK：三种形状的差异在路由的手写校验里（与 sql_definitions 的
 * kind_shape_check 不同——那条是为了兜住「既无 SQL 也无 operation」这种执行时才炸
 * 的空洞，而套件选择配置错了在 preview 就会立刻暴露）。
 *
 * execution_config → { concurrency, failFast, environmentStrategy, environmentId }
 *   concurrency 是「几个成员同时开跑」（默认 4、上限 10），不是「几个请求同时在飞」
 *   ——后者是平台级的 SUITE_LEAF_BUDGET 令牌池，见 5.0.11「并发预算与原子领取」。
 */
CREATE TABLE IF NOT EXISTS test_suites (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  selection_type TEXT NOT NULL CHECK (selection_type IN ('manual', 'tag', 'all')),
  selection_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  execution_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS test_suites_project_created_at_idx ON test_suites(project_id, created_at DESC);
/*
 * manual 成员的引用扫描（删用例/流程前的 usage 检查）按 id 在 selection_config 里
 * 找，走 jsonb 容器判定；tag/all 是动态选择，不产生引用，扫描时按 selection_type 排除。
 */
CREATE INDEX IF NOT EXISTS test_suites_selection_gin_idx ON test_suites USING gin (selection_config);

/*
 * 一次套件执行。
 *
 * suite_id 用 ON DELETE SET NULL 并快照 suite_name：删掉套件不该删掉它跑过的历史
 * （与 flow_executions.flow_id / flow_name 同款）。
 *
 * 刻意**不放** canceled_count：flow_executions 也没有，canceled 只在 execution_index
 * 上按 total - success - failed - skipped 派生（lib/flowRun.ts 的 finish）。两张表
 * 各算一遍必然分叉。
 */
CREATE TABLE IF NOT EXISTS suite_executions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id UUID REFERENCES test_suites(id) ON DELETE SET NULL,
  suite_name TEXT NOT NULL,
  /* 套件级环境覆盖（environmentStrategy='override'）；'member_default' 时为 NULL。 */
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  environment_name TEXT,
  /* 与 executions/flow_executions 同一套词汇：queued/running 不是结论。 */
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled')),
  /* 入队时固化的成员数。fail-fast 未启动的成员计入 skipped_count。 */
  total INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  /*
   * 入队时解析并冻结的成员清单：
   * [{ type: 'case'|'flow', id, name, endpointId?, endpointName?, environmentId? }]
   * 标签/全部是动态选择，报告要可复现就必须在入队这一刻定下来（5.0.3 第 3 批）。
   * 与 flow_executions.plan 同一角色：终态后仍然保留，所以已完成的套件能区分
   * 「成员未执行」与「成员不存在」。只放标识与名称，不含请求定义与凭据。
   */
  member_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  /* 待执行配置（并发、fail-fast、环境策略），落终态即置 NULL——理由同 executions.run_spec。 */
  run_spec JSONB,
  worker_id TEXT,
  execution_index_id UUID REFERENCES execution_index(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS suite_executions_project_created_at_idx ON suite_executions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS suite_executions_suite_created_at_idx ON suite_executions(suite_id, created_at DESC);
/* 认领与卡死回收都按 status 过滤，未终态的行只占很小比例。 */
CREATE INDEX IF NOT EXISTS suite_executions_pending_idx
  ON suite_executions(status, created_at) WHERE status IN ('queued', 'running');
/* index → detail 是 1:1（execution_index 侧已有 UNIQUE(kind, detail_id)）。 */
CREATE UNIQUE INDEX IF NOT EXISTS suite_executions_execution_index_id_idx
  ON suite_executions(execution_index_id) WHERE execution_index_id IS NOT NULL;

/*
 * 成员证据：套件的每个成员是该套件 index 下的一行 execution_steps。
 *
 * 用例成员用现有的 http_execution_id 指向 executions 行（与流程 request 步骤同构）。
 * 流程成员指向的却是**一次完整的父执行**——它自己有 execution_index + flow_executions
 * + 一整套子步骤，没有任何现存列能表达。于是加 child_index_id，形状与 http_execution_id
 * 一致：可空、指向别处的证据、ON DELETE SET NULL（子执行被清理不该删掉成员行）。
 *
 * 这样取消、计数（parent_step_id IS NULL）、回收、统一详情路由全部沿用既有实现，
 * 而不是为套件再写一套聚合。
 */
ALTER TABLE execution_steps ADD COLUMN IF NOT EXISTS child_index_id UUID REFERENCES execution_index(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS execution_steps_child_index_idx ON execution_steps(child_index_id) WHERE child_index_id IS NOT NULL;

/*
 * kind 的 CHECK 收窄：去掉 021 留下的死值 scenario。
 *
 * 021 当时说明「收窄要重建约束，而 P2-4 还要再改一次」所以留着——现在就是那一次。
 * 走查后确认 'suite' 015 起就在 CHECK 里，套件本身不需要放宽，这里只做清理：
 * 场景表与场景父索引行已由 021 删净，不存在会被新约束拒绝的历史行。
 * 'batch' 保留：批量调试目前不写 execution_index（它有自己的 batch_executions），
 * 但它仍是规划中的父执行类型，删了以后要再重建一次约束。
 */
ALTER TABLE execution_index DROP CONSTRAINT IF EXISTS execution_index_kind_check;
ALTER TABLE execution_index ADD CONSTRAINT execution_index_kind_check
  CHECK (kind IN ('flow', 'suite', 'batch'));
