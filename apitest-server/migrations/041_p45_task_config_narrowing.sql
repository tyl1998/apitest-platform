/*
 * P4.5-14: CI 任务配置面收窄。范围与逐条落点见 DEVELOPMENT_PLAN.md 8.11。
 *
 * 一句话概括这次迁移在改什么：**把「从哪拉代码」从仓库行搬到任务行，把凭据升级成项目级
 * 命名池，并删掉四组用户按不动的配置**（任务级 secret / 报告格式与路径 / 产物路径 /
 * 默认任务）。
 *
 * 为什么是搬而不是加一列：`repositories` 只能由**第一次上报**创建（迁移 034 的绑定模型），
 * 而 clone 配置挂在那一行上意味着配置顺序变成「先有上报 → 才能配 clone → 才能跑 CI」。
 * 用户来这里的目的恰恰是「我还没有 CI，让平台帮我跑」，第一步就锁死。搬到任务上之后两者
 * 不再互为前提：任务回答「从哪拉、怎么跑」，仓库行回答「用例树是谁的」。
 *
 * 项目从未上线（AGENTS.md 的数据兼容性约定），所以这里**直接删列、不搬存量数据**。
 */

/*
 * 项目级命名凭据池。
 *
 * 这不是一个新概念，是把 `repositories.credential_encrypted` 这一列搬到自己的表上并给
 * 它一个名字：一个项目通常只有一两把 key（「公司 GitLab 只读 token」），多个任务共用；
 * 换 token 只改一处，而不是逐个任务改一遍。
 *
 * `method` 就是原来的 `clone_method`，但**少了 `none`**：「公开仓库不需要凭据」由任务
 * 不引用任何凭据表达（`ci_tasks.git_credential_id IS NULL`），不需要一行「什么都没有的
 * 凭据」来代表它。一个枚举值换成一个空外键，语义更准。
 *
 * 加密仍是 `lib/crypto.ts` 的 AES-GCM（与数据源凭据、webhook secret 同一把钥匙、同一套
 * 形状）。凭据明文**只在 claim 的响应体里出现**（边界 11 的缓解②）：不进 GET、不进日志、
 * 不进 `pipeline_runs` 快照。`credential_updated_at` 让「这份凭据什么时候换的」可答——
 * 明文只写不读，没有这一列界面上除了「有/没有」什么都说不出来。
 *
 * `UNIQUE (project_id, name)`：名字是任务表单下拉里的唯一标识，重名的两条凭据没法选。
 */
CREATE TABLE IF NOT EXISTS git_credentials (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('https_token', 'ssh_key')),
  credential_encrypted BYTEA NOT NULL,
  credential_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS git_credentials_project_created_at_idx ON git_credentials(project_id, created_at DESC);

/*
 * 任务自带 clone 来源。
 *
 * `git_url` 是**任务的**拉取地址，与 `repositories.git_url`（上报身份）刻意同名不同角色：
 * 后者是 `/ingest` 的准入判据，改它会打断已绑仓库的上报；前者只回答「Runner 去哪 clone」。
 * 两个任务指向不同仓库是允许的（见 8.11 的「明确不做」：用例树仍只有一棵，那是已知的
 * 松耦合，不在本批解决）。
 *
 * `ON DELETE RESTRICT` 而不是 SET NULL：凭据被删掉后任务会静默变成「按公开仓库 clone」，
 * 然后在下一次执行时以一条 clone 失败的 run 告诉用户。让删除动作当场被拒、并由界面列出
 * 哪几个任务在用它，比事后猜要好（与 `environments` 的 usage/force 删除同一条纪律）。
 *
 * NOT NULL 加不上（存量行没有值），所以是可空列 + 路由层必填校验：迁移里给一个假的默认
 * 地址会让「这条任务的地址是不是真的」永远说不清。
 */
ALTER TABLE ci_tasks
  ADD COLUMN IF NOT EXISTS git_url TEXT NOT NULL DEFAULT '';
ALTER TABLE ci_tasks
  ADD COLUMN IF NOT EXISTS git_credential_id UUID REFERENCES git_credentials(id) ON DELETE RESTRICT;

/*
 * 引用列要自己建索引：Postgres 只为**被引用**的主键建索引，不为引用方建。没有它，每一次
 * 删除凭据都要全表扫 `ci_tasks` 去验 RESTRICT，而凭据列表页的 `task_count` 子选也一样。
 */
CREATE INDEX IF NOT EXISTS ci_tasks_git_credential_idx ON ci_tasks(git_credential_id) WHERE git_credential_id IS NOT NULL;

/*
 * 删掉四组配置（8.11 的 B 类）。
 *
 * - `secrets_encrypted`：任务级 secret 整体撤销。**代价记在这里而不是当成零成本**：
 *   Runner 侧日志脱敏（边界 12 的原文逐行替换）随之失去词表输入，敏感值写进 `env` 会
 *   原样出现在日志里。这是「少一层配置」与「平台替我遮日志」之间的显式取舍，`masker.ts`
 *   的机制保留（clone 凭据仍走它）。
 * - `report_format` / `report_paths`：报告永远按 allure，目录从 `steps` 里解析
 *   `--alluredir`（`lib/allureDir.ts`）。解析不到只提示不拒绝——用户可能在 `pytest.ini`
 *   的 `addopts` 里配了它，平台看不见那份文件，拿一条猜测去否决保存是错的。
 * - `artifact_paths`：allure-results 的打包上传是平台自己的行为（边界 19 的报告层），
 *   与这一列从来无关；它只是一个没人填的框。
 * - `is_default` 与它的部分唯一索引：勾选执行的兜底改成「单任务自动选、多任务让用户选」，
 *   「项目里只有一个任务」前端数一下就知道，不需要一列去声明。
 *
 * 索引必须先删：`DROP COLUMN` 会带走依赖它的索引，但显式写出来才能让读迁移的人知道那条
 * 部分唯一索引是**故意**没了，而不是被级联顺手带走的。
 */
DROP INDEX IF EXISTS ci_tasks_project_default_idx;

ALTER TABLE ci_tasks DROP COLUMN IF EXISTS secrets_encrypted;
ALTER TABLE ci_tasks DROP COLUMN IF EXISTS report_format;
ALTER TABLE ci_tasks DROP COLUMN IF EXISTS report_paths;
ALTER TABLE ci_tasks DROP COLUMN IF EXISTS artifact_paths;
ALTER TABLE ci_tasks DROP COLUMN IF EXISTS is_default;

/*
 * `repository_id` 也走了：任务不再从仓库行取 clone 来源，那条外键剩下的唯一作用是
 * 「这个任务属于哪个仓库」——而任务自己有 `git_url`，仓库行则由上报独立维护。留着它会
 * 让「建任务前必须先有上报」这条前置条件从代码里删掉、却仍然由外键强制执行。
 *
 * 注意它的副作用：`ci_tasks` 从此**不再随仓库解绑 / 删除而级联消失**（原先是
 * `ON DELETE CASCADE`）。这正是想要的——解绑仓库是「换一个上报来源」，不该顺手删掉用户
 * 写好的执行配置。
 */
ALTER TABLE ci_tasks DROP COLUMN IF EXISTS repository_id;

/*
 * 仓库行卸下 clone 相关的四列，回到它在 P4 的形状：只回答「用例树是谁的」。
 *
 * `clone_method` 的 CHECK 由 `DROP COLUMN` 一起带走（约束依附于列），不需要单独 DROP
 * CONSTRAINT——这与迁移 038 里那个要按定义内容找的表级 CHECK 是两种情况。
 */
ALTER TABLE repositories DROP COLUMN IF EXISTS clone_method;
ALTER TABLE repositories DROP COLUMN IF EXISTS clone_url;
ALTER TABLE repositories DROP COLUMN IF EXISTS credential_encrypted;
ALTER TABLE repositories DROP COLUMN IF EXISTS credential_updated_at;
