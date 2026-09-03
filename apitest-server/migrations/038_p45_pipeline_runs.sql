/*
 * P4.5-2: CI 执行账本。范围与边界见 DEVELOPMENT_PLAN.md 8.0/8.1。
 *
 * 三张表回答三个不同的问题：
 * - `pipeline_runs`：这次执行**是什么状态**（状态机 / 阶段 / 租约 / 计数）。
 * - `pipeline_run_logs`：Runner 推上来的日志字节流（按 offset 续传）。
 * - `pipeline_run_cases`：junit / allure 解析出来的 case 级结果——**不可信到不能回写树**的
 *   那一份（边界 13），`guessed_case_key` 这个列名就是在说这件事。
 *
 * 本批次（P4.5-2）只建表并接通「触发 → 排队」；`claim` / `heartbeat` / `logs` / `complete`
 * 与状态机推进是 P4.5-3 / P4.5-4。
 */

/*
 * 一条 pipeline run。
 *
 * `runner_label` 与 `sandbox_mode` 是**触发时冻结的快照**（照 P2-8 边界 1 的同一条纪律）：
 * 任务改了配置、标签换了网段，历史 run 仍要说清「当时是从哪个网段、用哪一档沙箱跑的」。
 *
 * `runner_id` 无级联（SET NULL）：Runner 被删掉后这条历史仍要留——与 `executions.worker_id`
 * 同款取舍。`execution_index_id` 同理 SET NULL，归一写入是 P4.5-4。
 *
 * `lease_expires_at` 是「这个任务还活着吗」的唯一判据（边界 5）：认领时设 90 秒，心跳续，
 * scheduler 的回收器（P4.5-3）按它判 `aborted`。它不等于「Runner 在不在线」——那是
 * `runners.last_seen_at` 的新鲜度。
 *
 * `trigger_source` 的 `'ci'` 值：`execution_index.trigger_source` 在迁移 030 就带着它，
 * 本表沿用同一份枚举，避免两边口径分叉。
 */
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ci_task_id UUID NOT NULL REFERENCES ci_tasks(id) ON DELETE CASCADE,
  execution_index_id UUID REFERENCES execution_index(id) ON DELETE SET NULL,
  /* 任务内自增（界面上的 #128）。产生方式：触发事务里锁任务行 + MAX+1，见 lib/trigger.ts。 */
  run_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued', 'claimed', 'running', 'cancelling', 'success', 'failed', 'canceled', 'aborted', 'timed_out')),
  /* 固定四段（clone / cache / script / report）而不是自由文本：界面要画得出阶段进度条
     （交互 3.12.3），自由文本画不出来。`pending` = 还没被认领。 */
  stage TEXT NOT NULL DEFAULT 'pending' CHECK (stage IN
    ('pending', 'clone', 'cache', 'script', 'report', 'done')),
  runner_label TEXT NOT NULL,
  /* ci_tasks.sandbox_mode 的触发时快照；不加 CHECK——源头列已约束，这里只是历史记录。 */
  sandbox_mode TEXT NOT NULL,
  runner_id UUID REFERENCES runners(id) ON DELETE SET NULL,
  lease_expires_at TIMESTAMPTZ,
  trigger_source TEXT NOT NULL DEFAULT 'manual'
      CHECK (trigger_source IN ('manual', 'scheduled', 'webhook', 'ci')),
  trigger_ref_id UUID,
  trigger_ref_name TEXT,
  triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  /* 触发时的任务配置快照。 */
  git_ref TEXT NOT NULL,
  /* clone 完了由 Runner 回填（P4.5-5）。 */
  commit_sha TEXT NOT NULL DEFAULT '',
  /* NULL = 全量；{ "case_keys": [...] } = 勾选执行（§8.3，P4.5-9 贯通）。 */
  case_filter JSONB,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  exit_code INTEGER,
  error TEXT,
  /* 同时是「日志总长」和「下一个期望 offset」：一个数不会自相矛盾。Runner 断线重连时
     「我上次报到哪了」的答案就是这一列（边界 7）。 */
  log_bytes BIGINT NOT NULL DEFAULT 0,
  case_total INTEGER NOT NULL DEFAULT 0,
  passed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  /* SDK 路径回填（A 路径，`APITRACK_CI_RUN_ID = job_id` 缝起来，8.2 约定 8）。 */
  ingest_run_id UUID REFERENCES ingest_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

/* 任务内序号唯一：触发事务的行锁保证不撞；索引兜底并发事故。 */
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_runs_task_number_idx
  ON pipeline_runs (ci_task_id, run_number);
/* claim 的认领扫描（P4.5-3）：WHERE status='queued' + 标签过滤 + created_at 排序。 */
CREATE INDEX IF NOT EXISTS pipeline_runs_claimable_idx
  ON pipeline_runs (runner_label, created_at) WHERE status = 'queued';
/* 租约回收器（P4.5-3，scheduler 进程）：只扫在途的行。 */
CREATE INDEX IF NOT EXISTS pipeline_runs_lease_idx
  ON pipeline_runs (lease_expires_at) WHERE status IN ('claimed', 'running', 'cancelling');

/*
 * 日志按 (run, byte_offset) 追加，唯一约束就是断线重传的去重（边界 7）：Runner 重发已收的
 * chunk 撞唯一键不报错（路由按 ON CONFLICT 幂等收，P4.5-4），丢的窗口由 offset 续传补上。
 *
 * `id` 用 BIGSERIAL 而不是 randomUUID()：日志是 Runner 高频追加的流，生成端在对方进程里，
 * 自增主键让「按 run 顺序读」免费，且省下每行 16 字节的 UUID。
 */
CREATE TABLE IF NOT EXISTS pipeline_run_logs (
  id BIGSERIAL PRIMARY KEY,
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  byte_offset BIGINT NOT NULL,
  chunk TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_run_id, byte_offset)
);

/*
 * 报告解析出的 case 级结果（B/C 两条路径，边界 13）。
 *
 * `source` **没有 `'sdk'`**：SDK 路径的 case 级结果已经在 `repo_test_cases` +
 * `ingest_records` 里了，再存一份就有两个都自称权威的副本。这张表专门装「报告解析出来的、
 * 不可信到不能回写树」的那一类——junit 的 `classname::name` 与 pytest nodeid 之间没有
 * 稳定映射（类名、参数化 id、conftest 层级都会让它对不上），`guessed_case_key` 只做
 * best-effort 提示，绝不当身份用。
 */
CREATE TABLE IF NOT EXISTS pipeline_run_cases (
  id UUID PRIMARY KEY,
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('junit', 'allure')),
  suite_name TEXT NOT NULL DEFAULT '',
  case_name TEXT NOT NULL,
  guessed_case_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped', 'error')),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  UNIQUE (pipeline_run_id, source, suite_name, case_name)
);

/*
 * `execution_index.kind` 放宽出 `'runner'`（边界 1）：执行记录页的来源筛选、统一详情跳转、
 * 告警订阅三处都读 execution_index，不归一就要为仓库执行再写一套分支。写入方是 P4.5-4。
 *
 * 照抄 035 的做法（那里有完整的理由注释）：CHECK 的放宽必须先 DROP 再 ADD；**按定义内容
 * 找约束，不按名字**——015 建表时的 CHECK 由 Postgres 自动命名，名字猜错的后果是
 * `DROP ... IF EXISTS` 静默什么都不做，第一次写入 kind='runner' 时才炸而迁移显示成功。
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
  CHECK (kind IN ('flow', 'scenario', 'suite', 'batch', 'ingest', 'runner'));
