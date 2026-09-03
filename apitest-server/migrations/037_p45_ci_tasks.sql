/*
 * P4.5-1: CI 任务定义与仓库拉取凭据。范围与边界见 DEVELOPMENT_PLAN.md 8.0/8.1。
 *
 * 一条 CI 任务回答的是「在哪台机器上、用哪个沙箱档、从哪个 ref 拉哪个仓库、跑哪一段
 * shell、怎么收报告与产物」。它不回答「被测地址是什么」——那在用户脚本和它自己的 `env`
 * 里，平台不知道也不该知道。
 *
 * 本文件只建定义，执行账本（`pipeline_runs` 等）在 038。CRUD 与触发是 P4.5-2。
 */

/*
 * 仓库的**拉取地址与凭据**（边界 11）。
 *
 * `clone_url` 与 `git_url` 分开是刻意的：`git_url` 在 P4 里是**身份**（`/ingest` 靠它防
 * 越权，迁移 034 刻意不加唯一约束但校验绑定），改它会打断已绑仓库的上报。拉取地址是另一
 * 件事——同一个仓库可以有 https 和 ssh 两个地址——必须是另一列。
 *
 * `clone_method='none'` 是默认值：公开仓库不需要凭据，而「不需要凭据」应该是默认状态而
 * 不是一个特例。
 *
 * **凭据加密进库并随 JobSpec 下发**（边界 11，用户 2026-08-31 选定）。用 `lib/crypto.ts`
 * 的 AES-GCM——与数据源凭据、webhook secret 同一套密钥与同一套形状，不引入第二种加密
 * 方式。这笔账的代价必须写明而不是记成零成本：
 *   - 平台库里出现用户 Git 仓库的读凭据；下发意味着它会离开平台边界，落到那台自托管机器
 *     的内存里。
 *   - 缓解三条，全部是硬要求：① **只支持只读 deploy key**（平台无法验证，只能在表单上
 *     写明并要求用户在 Git 平台侧勾掉写权限）；② 凭据只出现在 claim 的**响应体**里，
 *     不进 `pipeline_runs` 快照、不进日志、不进任何 GET 接口的返回；③ Runner 侧写成 0600
 *     临时文件、用 `GIT_SSH_COMMAND` 指向它、`finally` 里删除，绝不写进 `~/.ssh/`。
 *   - **HTTPS + token 是更该推荐的那一种**：可以精确到单仓库只读、可以随时吊销、不需要
 *     用户在机器上配 SSH。表单默认给 HTTPS token。
 *
 * `credential_updated_at` 让「这份凭据是什么时候换的」可答——明文只写不读（8.2 平台侧
 * REST 的 `PUT …/repository/credential`），没有这一列的话界面上除了「有/没有」什么都
 * 说不出来。
 */
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS clone_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS clone_url TEXT NOT NULL DEFAULT '';
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS credential_encrypted BYTEA;
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS credential_updated_at TIMESTAMPTZ;

/*
 * CHECK 单独加并容忍重复执行：`ADD COLUMN IF NOT EXISTS` 不带 CHECK 时无法在同一句里
 * 表达「列已存在但约束还没加」这种中间状态。用 DO 块按名字判存在——这个约束是本迁移
 * 自己命名的，所以按名字是安全的（对比 038 里要动的那个 Postgres 自动命名的 CHECK，
 * 那里必须按定义内容找）。
 */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'repositories'::regclass AND conname = 'repositories_clone_method_check'
  ) THEN
    ALTER TABLE repositories ADD CONSTRAINT repositories_clone_method_check
      CHECK (clone_method IN ('none', 'https_token', 'ssh_key'));
  END IF;
END $$;

/*
 * 一条 CI 任务。
 *
 * `steps` 是**一整段 shell 文本，不是 `TEXT[]`**（8.1）：Runner 把它写成一个脚本文件执行
 * （Spec 2.10.2(d)），拆成数组只会诱导人以为「每一步是独立的阶段、可以单独重试」——而
 * 它们共享一个 shell 进程与工作目录，`cd` 和变量都是跨行生效的。阶段划分是 Runner 固定
 * 的四段（clone / cache / script / report），不是用户脚本的行数。
 *
 * `runner_label` 直接放在任务上，**不从 environment 取**。这是与 P2-8 唯一的不同点，必须
 * 讲清：P2-8 选 environment 做标签归属者，因为接口模式的执行「指向哪套系统」完全由
 * environment 决定；CI 任务里被测地址在用户脚本里，这里的标签回答的是「在哪台机器上
 * clone 与执行」，那是任务自己的属性。**标签的命名空间是共享的**（同一个
 * `RUNNER_LABEL_PATTERN`、同一份候选来源、面板上同一列），共享的是「哪个网段」这个语义。
 *
 * `sandbox_mode` 默认 `container`（边界 15）：Runner 跑的是**用户仓库里的任意脚本**，而
 * 那台机器上有平台下发的 deploy key 和 secret——没有文件系统隔离时，一个脚本可以读到另一
 * 个任务留下的东西。进程档不是「简化版容器档」，它是一个**信任声明**，UI 上要写成
 * 「信任仓库脚本（无隔离）」而不是「轻量模式」。
 *
 * `isolation_mode` 是留位（边界 15）：Spec 2.10.2(a) 的 `isolated`（Job per build / K8s
 * Job）本阶段不做，CHECK 里现在只有 `'shared'` 一个值。留列而不是等做出来再加，理由与
 * 迁移 010/027 同款——回填时分不清历史行。
 *
 * `secrets_encrypted` 是 `{k:v}` 整体加密（不是逐条一行）：它的 values 同时是 Runner 侧
 * 日志脱敏的字典（边界 12），拆表只会让「取出全部 value 做脱敏」变成一次 join。
 */
CREATE TABLE IF NOT EXISTS ci_tasks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  git_ref TEXT NOT NULL DEFAULT 'main',
  runner_label TEXT NOT NULL DEFAULT 'default',
  sandbox_mode TEXT NOT NULL DEFAULT 'container' CHECK (sandbox_mode IN ('process', 'container')),
  isolation_mode TEXT NOT NULL DEFAULT 'shared' CHECK (isolation_mode IN ('shared')),
  /* container 档必填（路由层校验，错误信息要说清）；process 档忽略。 */
  image TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL,
  /* 明文变量。与 secrets 分列：明文的要能在 GET 里回显，secret 的永不回显。 */
  env JSONB NOT NULL DEFAULT '{}'::jsonb,
  secrets_encrypted BYTEA,
  /* 依赖缓存目录，与「以这些文件的内容 hash 作缓存 key」。 */
  cache_paths TEXT[] NOT NULL DEFAULT '{}',
  cache_key_files TEXT[] NOT NULL DEFAULT '{}',
  /* 报告归一的 B/C 两条路径（边界 13）。A 路径（SDK 上报）由 `sdk_ingest_enabled` 控制，
     两者并存而不是三选一。 */
  report_format TEXT NOT NULL DEFAULT 'none' CHECK (report_format IN ('none', 'junit', 'allure')),
  report_paths TEXT[] NOT NULL DEFAULT '{}',
  artifact_paths TEXT[] NOT NULL DEFAULT '{}',
  /* 注入 `APITRACK_URL` / `APITRACK_TOKEN` / `APITRACK_CI_RUN_ID` 三件套（8.2 约定 8）。
     第三个是 SDK 路径与 Runner 路径能对上的**全部机制**。 */
  sdk_ingest_enabled BOOLEAN NOT NULL DEFAULT true,
  timeout_seconds INTEGER NOT NULL DEFAULT 1800,
  /* 勾选执行时的推荐兜底（§8.3）：一个项目最多一个默认任务，见下面的部分唯一索引。 */
  is_default BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* 一个项目最多一个默认任务。部分唯一索引而不是路由里「先查有没有」：并发两次「设为默认」
   会双双通过，然后勾选执行的推荐逻辑面对两个默认任务无从选择。 */
CREATE UNIQUE INDEX IF NOT EXISTS ci_tasks_project_default_idx ON ci_tasks(project_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS ci_tasks_project_created_at_idx ON ci_tasks(project_id, created_at DESC);
/* 触发前的「这个标签下有在线 Runner 吗」要按标签反查任务；面板也按标签分组显示。 */
CREATE INDEX IF NOT EXISTS ci_tasks_runner_label_idx ON ci_tasks(runner_label);
