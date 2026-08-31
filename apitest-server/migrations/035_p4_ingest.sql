/*
 * P4-1: 仓库模式的上报数据。范围与边界见 DEVELOPMENT_PLAN.md 7.0/7.1。
 *
 * 一次上报是一个 commit 快照：`ingest_runs` 是那一次运行本身，`repo_test_cases` 是
 * 「代码里现在有哪些用例」，`repo_case_endpoints` 是「用例打过哪些接口」，
 * `ingest_records` 是不可变的请求日志。
 *
 * 分工要记住：**存在性看 inventory，归属看 records**（边界 11）。对账（软删）只看
 * inventory，永不看 records——被 skip 的用例、或这一轮恰好没打到任何接口的用例，
 * records 里是空的，按「没报到就算消失」去删，一次全量跑就会把所有 skip 的用例判成
 * removed。
 */

/*
 * 一次上报。
 *
 * `UNIQUE (repository_id, commit_sha, ci_run_id)` 就是协议的幂等键（Spec 2.10.1）：
 * 重投命中它 → 合并不新增。二期的崩溃兜底补投（边界 12）靠的正是这一条，所以它必须
 * 在 v1.0 就存在，否则二期要改协议。
 *
 * `ci_run_id` 可能为空（本地跑），存 `''` 而不是 NULL——**NULL 在 UNIQUE 约束里不去重**，
 * 两次本地跑会各插一行，重投就不再幂等。
 *
 * `scope` 是本次跑的范围（相对仓库根的路径数组，边界 11/19），空数组 = 全仓。
 * 它与 `is_full_inventory` 是两件不同的事：范围说的是「跑的是哪一片」，
 * `is_full_inventory` 说的是「这一片里有没有过滤」（`-k` / `-m` / `--lf` / collect
 * error 一律判非全量）。
 *
 * `reconciled` 记的是**实际有没有对账**，不是「该不该」：平台侧的双闸门是
 * `is_full_inventory=true` 且 `branch = repositories.tracking_branch`，两者都成立才
 * 真删。上报记录页要显示这一行到底有没有参与删除对账，猜不出来。
 *
 * `execution_index_id` 让这次上报归一进统一执行记录（边界 1，kind='ingest'）：
 * 执行记录页的来源筛选、统一详情跳转、告警订阅三处都读 execution_index，不归一就要
 * 各写一套仓库模式分支。
 */
CREATE TABLE IF NOT EXISTS ingest_runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  execution_index_id UUID REFERENCES execution_index(id) ON DELETE SET NULL,
  protocol_version TEXT NOT NULL DEFAULT '1.0',
  commit_sha TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  ci_run_id TEXT NOT NULL DEFAULT '',
  ci_run_url TEXT,
  scope TEXT[] NOT NULL DEFAULT '{}',
  is_full_inventory BOOLEAN NOT NULL DEFAULT false,
  reconciled BOOLEAN NOT NULL DEFAULT false,
  case_total INTEGER NOT NULL DEFAULT 0,
  passed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  /* 全量 run 的 diff（交互 3.11.3）：这次新增/软删/更新了多少条用例。 */
  added_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  /* 未匹配记录数（边界 20）/ 未归位用例数（边界 21）。 */
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  unplaced_count INTEGER NOT NULL DEFAULT 0,
  /* 平台回 warnings 提示升级时要知道对方是谁。 */
  sdk_name TEXT NOT NULL DEFAULT '',
  sdk_version TEXT NOT NULL DEFAULT '',
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, commit_sha, ci_run_id)
);

CREATE INDEX IF NOT EXISTS ingest_runs_project_created_at_idx ON ingest_runs(project_id, created_at DESC);

/*
 * 仓库用例。
 *
 * `case_key` 是身份，`name` 是显示，两者分开（边界 7）：合成一个的话，用户改一句
 * docstring 就会在树上长出一条新用例、旧的那条被判 removed。
 *
 * `UNIQUE (project_id, case_key)` 而不是叠上 repository_id：项目内仓库唯一
 * （Spec 2.10 基数），再叠一维只会让 upsert 的冲突目标多一列而不多一分保障。
 *
 * `file_path` 是对账的裁剪依据（边界 11，按 scope 前缀匹配），但**不参与 removed 的
 * 身份判定**（边界 8）——文件移动了而 `@case(key=…)` 没变，仍是同一条用例。
 *
 * `last_result` 的 `not_run` 现在就写进 CHECK，尽管 P4.5 的勾选执行才会产出它：理由
 * 与迁移 010/027/030 同款，等做出来再改 CHECK 就要回填，而回填时分不清历史行。
 *
 * 目录路径**不做成树的一层**（边界 8）：平台的树是「系统 → 接口 → 用例」，而
 * `tests/order/` 下的用例完全可能打 `POST /payments`，把目录塞进树就有两套互相打架的
 * 层级。真需要「按目录看」时那是第二种**视图**，不是第二种存储。
 */
CREATE TABLE IF NOT EXISTS repo_test_cases (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  case_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  last_result TEXT NOT NULL DEFAULT 'unknown' CHECK (last_result IN ('passed', 'failed', 'unknown', 'not_run')),
  last_seen_commit TEXT,
  last_ingest_run_id UUID REFERENCES ingest_runs(id) ON DELETE SET NULL,
  last_run_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, case_key)
);

CREATE INDEX IF NOT EXISTS repo_test_cases_project_status_idx ON repo_test_cases(project_id, status);
/* 对账按 scope 前缀裁剪（边界 11）。 */
CREATE INDEX IF NOT EXISTS repo_test_cases_project_file_path_idx ON repo_test_cases(project_id, file_path);

/*
 * 用例 ↔ 接口关系。
 *
 * **一个用例挂它实际打过的每一个接口**（边界 9）：一个用例打三个接口是常态（先登录
 * 再下单再查详情），归给「主接口」会让另外两个显示未覆盖，而它们明明被测到了。
 * 所以这里是一张关系表，不是 `repo_test_cases.endpoint_id` 单列。
 *
 * **两个计数口径因此不同，界面上必须写明**：接口节点上的「用例数」数的是**关系数**
 * （`COUNT(*)` here），项目级「仓库用例总数」数的是 **distinct case_key**，两者相加
 * 不相等。不写明就会被当成 bug 报上来。
 *
 * **关系是累积的，不是每轮重建**（边界 11）：有 inventory 无 records 的用例保留上一轮
 * 的接口关系。每轮重建的话，一次 `-m smoke` 就会把没跑到的用例从接口下摘掉。
 *
 * 一条 active 用例在此**没有任何行** = 未归位用例（边界 21）。刻意不加状态列：它是一个
 * 查得出来的事实，落列就要维护「什么时候该改这一列」。
 */
CREATE TABLE IF NOT EXISTS repo_case_endpoints (
  repo_case_id UUID NOT NULL REFERENCES repo_test_cases(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  first_seen_run_id UUID REFERENCES ingest_runs(id) ON DELETE SET NULL,
  last_seen_run_id UUID REFERENCES ingest_runs(id) ON DELETE SET NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_case_id, endpoint_id)
);

/* 接口 → 用例反查，覆盖判定用它。 */
CREATE INDEX IF NOT EXISTS repo_case_endpoints_endpoint_idx ON repo_case_endpoints(endpoint_id);

/*
 * 上报的请求记录。**不可变日志**（Spec 2.10.1）：可编辑就意味着上报的事实与树上的
 * 显示可以互相矛盾。
 *
 * `UNIQUE (ingest_run_id, seq)` 让分批重投在批次内也幂等（Spec 2.10.1）。
 *
 * `phase` 是必需的，不是调试信息（边界 10）：登录、造数这类请求发生在 fixture 里，
 * 只有 `call` 阶段的请求建立用例关系。`setup`/`teardown` 的请求**仍进这张表并计入
 * 接口覆盖**，但不挂到用例节点上——于是 `POST /login` 显示为「已覆盖，但没有专属
 * 用例」，这正是事实。
 *
 * `endpoint_id` 可空 = 未匹配（边界 16/20）。**绝不自动登记 endpoint**：上报到未登记的
 * 接口就自动建一条 endpoints 的话，覆盖率会永远是 100%——分母跟着分子长。
 *
 * `path_normalized` 匹配到接口时是那条接口的路径模板，未匹配时是**通用归一**的结果
 * （`/users/abc-123` → `/users/{id}`）。计划 7.1 原写「未匹配时 path_normalized 亦为空」，
 * 在此收窄：未匹配诊断视图要按频次聚合、要跟别的项目登记过的路径比对（边界 20 的三样
 * 标注），两件事都需要一个稳定的分组键。按 path_raw 聚合的话，`/users/1`…`/users/900`
 * 会长成 900 行各出现一次的列表，那张表就再也读不出「哪条路径最常被打到」。
 * 列仍可空：`path_raw` 本身畸形到取不出路径时不硬编一个假模板。
 *
 * `repo_case_id` 可空：inventory 里没有的 case_key 不该凭一条 record 就长出用例行
 * （协议要求两者自洽，不自洽回 422），而 fixture 阶段的记录在归属上本就没有用例。
 *
 * **刻意不加 external / silenced 列**：静默是读时按 `ingest_path_rules` 的前缀算出来
 * 的（边界 20）。落列就意味着改一条规则要回填全部历史，且与「不可变日志」冲突。
 */
CREATE TABLE IF NOT EXISTS ingest_records (
  id UUID PRIMARY KEY,
  ingest_run_id UUID NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_case_id UUID REFERENCES repo_test_cases(id) ON DELETE SET NULL,
  endpoint_id UUID REFERENCES endpoints(id) ON DELETE SET NULL,
  phase TEXT NOT NULL DEFAULT 'call' CHECK (phase IN ('setup', 'call', 'teardown')),
  param_id TEXT,
  seq INTEGER NOT NULL,
  method TEXT NOT NULL,
  path_raw TEXT NOT NULL,
  path_normalized TEXT,
  status_code INTEGER,
  latency_ms INTEGER,
  passed BOOLEAN,
  error TEXT,
  /* 默认只报摘要，body 默认不传（边界 13）：脱敏后的头键名、截断后的 body 片段等。 */
  request_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ingest_run_id, seq)
);

/* 接口详情的「最近上报」。 */
CREATE INDEX IF NOT EXISTS ingest_records_endpoint_created_at_idx
  ON ingest_records(endpoint_id, created_at DESC) WHERE endpoint_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ingest_records_run_seq_idx ON ingest_records(ingest_run_id, seq);
/* 未匹配诊断视图（边界 20）：只扫 endpoint_id IS NULL 的那一小片。 */
CREATE INDEX IF NOT EXISTS ingest_records_project_unmatched_idx
  ON ingest_records(project_id, created_at DESC) WHERE endpoint_id IS NULL;
CREATE INDEX IF NOT EXISTS ingest_records_case_idx ON ingest_records(repo_case_id) WHERE repo_case_id IS NOT NULL;

/*
 * 人工标注的外部依赖前缀（边界 20）。
 *
 * 命中的未匹配记录在**诊断列表里静默**，不影响任何统计——所以规则写错的代价是「列表里
 * 多一条或少一条」，不是一次分类错误。前缀在项目内可以重复、可以有多条，因为它不承担
 * 归属判定，重复也就无害。
 *
 * **只做前缀，不用正则**（可多层如 `/api/v2/user/`）：正则要防灾难性回溯，而这里要
 * 表达的就是「`/api/v2/user/` 开头的不是我的」。
 */
CREATE TABLE IF NOT EXISTS ingest_path_rules (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path_prefix TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingest_path_rules_project_idx ON ingest_path_rules(project_id);

/*
 * 上报归一进统一执行记录（边界 1）。
 *
 * CHECK 的放宽必须先 DROP 再 ADD：`ADD CONSTRAINT` 在同名约束已存在时报错，而
 * `IF NOT EXISTS` 对 CHECK 约束不适用。
 *
 * **按定义内容找约束，不按名字**：015 建表时的 CHECK 由 Postgres 自动命名，通常是
 * `execution_index_kind_check`，但那是约定而不是保证（同名冲突时会带后缀）。名字猜错的
 * 后果很隐蔽——`DROP ... IF EXISTS` 静默什么都不做，旧约束留在原处，于是第一次仓库上报
 * 在写 `execution_index` 时才炸，而迁移本身显示成功。
 */
DO $$
DECLARE
  target TEXT;
BEGIN
  FOR target IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'execution_index'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE execution_index DROP CONSTRAINT %I', target);
  END LOOP;
END $$;

ALTER TABLE execution_index ADD CONSTRAINT execution_index_kind_check
  CHECK (kind IN ('flow', 'scenario', 'suite', 'batch', 'ingest'));

/*
 * **趋势与通过率的口径不跟着放宽**（边界 1）：`reports/trend` 与 `reports/summary` 默认
 * 仍只算 `kind IN ('flow','suite')`——外部 CI 的 latency_ms 是用户进程里的客户端耗时，与
 * 平台的墙钟耗时不是一个口径；而一次 `-m smoke` 的局部跑会把通过率拉出一个没人认的台阶。
 * 趋势页给一个默认关闭的「含仓库上报」开关（`includeIngest=1`），让人可以自己要那份混合
 * 视图。看板的 coverageRate 本阶段一个字都不改（边界 2）。
 */
