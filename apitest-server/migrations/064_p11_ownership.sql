/*
 * P11-1（计划 16.1 / 16.6）：资产归属列级 + 单条执行触发人。
 *
 * **14 张 P0–P3 核心表补 `created_by` / `updated_by`**（边界 1）。它们只有
 * `created_at` / `updated_at`，没有任何 user 列——「这个接口谁建的、上次谁改的」
 * 在平台上无处可查。P4.5 之后建的表（`ci_tasks` / `git_credentials` /
 * `ingest_tokens` / `ingest_path_rules` / `runner_tokens` / `mcp_tokens` /
 * `report_shares` / `invitations` / `spec_cases` / `spec_case_links` /
 * `test_plans` / `pipeline_runs`）天生带 `created_by`（或 `triggered_by` /
 * owner），本阶段不动，也不批量补 `updated_by`（边界 2：等真实「谁改的」诉求
 * 再单独加）。
 *
 * **旧行 NULL 即可，不回填**：项目未发布、无历史数据要保护（AGENTS.md Data
 * Compatibility）。NULL 语义 =「非人工更新」——调度器（`lib/schedule.ts`）、对账
 * （`lib/caseSync.ts`）、告警引擎（`lib/alerts.ts`）等系统路径写 NULL（边界 3），
 * 前端显示「系统」而不是空，禁止把这些路径的归属硬塞成任务创建人。
 *
 * **索引只建 `(project_id, created_by)`**：按创建人筛选是列表诉求，按更新人筛选
 * 没有真实场景（边界 1）；`updated_by` 因此无索引。
 *
 * **第 15 张表 `executions` 补 `triggered_by`**（边界 11，2026-09-17 用户增补）：
 * 单条执行（手动跑接口 / 套件成员 / 流程节点）落这张表，「谁跑的」此前无处可查。
 * 它是运行记录不是资产，执行行建了就定、没有「更新人」语义，故只有一列、**不建
 * 索引**（16.5 明确不做「按触发人筛执行记录」）。`execution_index` /
 * `pipeline_runs` 的 `triggered_by`（057b / 038）早已存在，只需读侧解析展示。
 */
/* ── 内容资产 ── */
-- endpoints（001）
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- test_cases（007）
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- flows（012）
ALTER TABLE flows ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- test_suites（026）
ALTER TABLE test_suites ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE test_suites ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- scripts（011）
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- spec_modules（052）
ALTER TABLE spec_modules ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE spec_modules ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

/* ── 环境与数据 ── */
-- environments（001）
ALTER TABLE environments ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE environments ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- data_sources（016）
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- sql_definitions（016）
ALTER TABLE sql_definitions ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sql_definitions ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

/* ── Mock ── */
-- mocks（028）
ALTER TABLE mocks ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE mocks ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

/* ── 调度与告警 ── */
-- schedules（030）
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- webhook_triggers（030）
ALTER TABLE webhook_triggers ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE webhook_triggers ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- notification_channels（031）
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- alert_rules（031）
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

/*
 * 14 条 `(project_id, created_by)` 索引——只覆盖「按创建人筛选」这一真实诉求
 * （边界 1）。列表查询本就带 project_id 前缀，故复合前导列复用既有过滤，不额外
 * 建单列索引。
 */
CREATE INDEX IF NOT EXISTS endpoints_project_created_by_idx ON endpoints(project_id, created_by);
CREATE INDEX IF NOT EXISTS test_cases_project_created_by_idx ON test_cases(project_id, created_by);
CREATE INDEX IF NOT EXISTS environments_project_created_by_idx ON environments(project_id, created_by);
CREATE INDEX IF NOT EXISTS flows_project_created_by_idx ON flows(project_id, created_by);
CREATE INDEX IF NOT EXISTS test_suites_project_created_by_idx ON test_suites(project_id, created_by);
CREATE INDEX IF NOT EXISTS scripts_project_created_by_idx ON scripts(project_id, created_by);
CREATE INDEX IF NOT EXISTS data_sources_project_created_by_idx ON data_sources(project_id, created_by);
CREATE INDEX IF NOT EXISTS sql_definitions_project_created_by_idx ON sql_definitions(project_id, created_by);
CREATE INDEX IF NOT EXISTS mocks_project_created_by_idx ON mocks(project_id, created_by);
CREATE INDEX IF NOT EXISTS schedules_project_created_by_idx ON schedules(project_id, created_by);
CREATE INDEX IF NOT EXISTS webhook_triggers_project_created_by_idx ON webhook_triggers(project_id, created_by);
CREATE INDEX IF NOT EXISTS notification_channels_project_created_by_idx ON notification_channels(project_id, created_by);
CREATE INDEX IF NOT EXISTS alert_rules_project_created_by_idx ON alert_rules(project_id, created_by);
CREATE INDEX IF NOT EXISTS spec_modules_project_created_by_idx ON spec_modules(project_id, created_by);

/* ── 第 15 张：单条执行的触发人（边界 11；运行记录，无索引，无「更新人」语义） ── */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS triggered_by UUID REFERENCES users(id) ON DELETE SET NULL;
