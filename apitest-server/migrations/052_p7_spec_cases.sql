/*
 * P7 测试管理（计划 11.1）：文本用例是第三类用例资产——一棵人工维护的模块树，
 * 叶子是「用例」（标题/前置/步骤/预期）。它自己不含请求定义、平台不执行它；
 * 通过 spec_case_links 绑定自动化资产（接口/接口用例/流程/仓库用例）读出自动化
 * 状态；测试计划 = 一批文本用例的一次手工执行记录，结果只来自人工标记。
 */

/*
 * 模块树：parent_id + 物化 path（计划 11.0 边界 2）。path 以 '/' 起止，
 * 如 '/模块A/子模块/'；顶层模块 parent_id 为 NULL、path = '/' + name + '/'。
 * 刻意没有「根节点」行：项目都先于 P7 存在，根行要么补数据要么惰性创建，
 * 都是新增面——「根」只是 path 计算的前缀 '/'，树查询返回森林由前端挂接。
 *
 * UNIQUE (project_id, path) 一举两得：它是同层同名的唯一闸（同 parent 下重名
 * 不可，同层不同分支可重名——身份是 path，不是名字），也是「模块及全部子级」
 * 前缀查询的索引（starts_with(path, …) / LIKE '…%' 都能吃它，免去递归 CTE）。
 */
CREATE TABLE IF NOT EXISTS spec_modules (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES spec_modules(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);
CREATE INDEX IF NOT EXISTS spec_modules_parent_idx ON spec_modules (parent_id);

/*
 * 文本用例。不复用 test_cases（边界 1）：后者 endpoint_id NOT NULL +
 * request_snapshot JSONB NOT NULL，文本用例两者皆无，硬塞会污染接口用例的
 * 全部既有查询与覆盖口径。
 *
 * item_key 是导入判重键（优先「用例编号」如 TC-001）；NULL = 无编号，此时
 * 判重回落 (path, title) 哈希——PG 唯一约束对 NULL 不去重，所以无编号用例
 * 可以有任意多条（边界 7）。
 */
CREATE TABLE IF NOT EXISTS spec_cases (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_id UUID NOT NULL REFERENCES spec_modules(id) ON DELETE CASCADE,
  item_key TEXT,
  title TEXT NOT NULL,
  preconditions TEXT NOT NULL DEFAULT '',
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,       -- [{ step, expected }]
  priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','deprecated')),
  source TEXT,                                     -- 'xmind' | 'excel' | 'manual'
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, item_key)
);
CREATE INDEX IF NOT EXISTS spec_cases_module_idx ON spec_cases (project_id, module_id);
CREATE INDEX IF NOT EXISTS spec_cases_status_idx ON spec_cases (project_id, status);

/*
 * 绑定（N:N、多态目标，边界 8/9/10）：一条文本用例可绑多条自动化资产，
 * 一条自动化资产也可被多条文本用例引用。目标四类里 repo_case 按
 * (project_id, case_key) 绑定而不是行 id——仓库用例行会被对账标 removed、
 * 同 key 重现时是否同一行取决于上报序列，case_key 才是身份（迁移 035）；
 * target_id 仍存当前行 id 供读时关联，target_key 是 key 快照。绑定行
 * CASCADE 挂文本用例侧；目标侧删除后悬空，读时显示「目标已删除」。
 */
CREATE TABLE IF NOT EXISTS spec_case_links (
  id UUID PRIMARY KEY,
  spec_case_id UUID NOT NULL REFERENCES spec_cases(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('endpoint','case','flow','repo_case')),
  target_id UUID NOT NULL,
  target_key TEXT,                                 -- 仅 repo_case：project 内 case_key
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (spec_case_id, target_type, target_id)
);

/*
 * 测试计划只记手工结果（边界 12）：passed/failed/blocked/skipped + 备注 +
 * 缺陷链接。绑定资产的最近自动化结果是只读参考列，不参与通过率、不回写。
 */
CREATE TABLE IF NOT EXISTS test_plans (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  owner UUID REFERENCES users(id) ON DELETE SET NULL,
  started_on DATE,
  due_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/*
 * 计划是历史（边界 15/16 与迁移 004 同款纪律）：用例改名/删除后旧计划仍要
 * 读得通，所以 title/module_path 存快照，不 join 实时值。result NULL = 未执行。
 */
CREATE TABLE IF NOT EXISTS test_plan_items (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  spec_case_id UUID REFERENCES spec_cases(id) ON DELETE CASCADE,
  title_snapshot TEXT NOT NULL,
  module_path_snapshot TEXT NOT NULL,
  assignee UUID REFERENCES users(id) ON DELETE SET NULL,
  result TEXT CHECK (result IN ('passed','failed','blocked','skipped')),
  note TEXT NOT NULL DEFAULT '',
  defect_url TEXT,
  executed_at TIMESTAMPTZ,
  UNIQUE (plan_id, spec_case_id)
);
CREATE INDEX IF NOT EXISTS test_plan_items_assignee_idx ON test_plan_items (assignee) WHERE result IS NULL;
