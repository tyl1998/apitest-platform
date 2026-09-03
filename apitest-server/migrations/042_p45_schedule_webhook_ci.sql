/*
 * P4.5-12: 调度与 Webhook 接 CI 任务。范围见 DEVELOPMENT_PLAN.md 8.7。
 *
 * 迁移 030 建这两张表时就留了话（030:13-14、030:86）：`target_type` 的 CHECK 只写当时有的
 * 值、但整列保留，是为了「P4.5 的 CI 任务接进来时不必回填历史行」。本迁移就是那一刻——
 * 只放宽两个 CHECK、加一列指向 pipeline run，**不动表的形状**。
 *
 * 两个 CHECK 都是 030 里的**列级匿名约束**，Postgres 自动命名为 `<表>_<列>_check`。放宽
 * 只能 DROP 再 ADD（约束不能原地扩），所以这里按那个自动名字删。名字是 Postgres 的确定性
 * 规则生成的（同表同列只会有这一个匿名 CHECK），与迁移 037 那种「自己命名的约束按名字判
 * 存在」是同一条安全性理由的两面；038 里那个要按定义内容找的是**表级**多列 CHECK，
 * 自动名字带序号、不可预测——两种情况不要混。
 *
 * 重跑安全：DROP 带 IF EXISTS，ADD 用 DO 块按名字判存在。重新加的约束沿用同一个名字，
 * 所以第二次执行时 DROP 会把它删掉、DO 块再原样加回来——结果一致。
 */

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_target_type_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'schedules'::regclass AND conname = 'schedules_target_type_check'
  ) THEN
    ALTER TABLE schedules ADD CONSTRAINT schedules_target_type_check
      CHECK (target_type IN ('suite', 'ci_task'));
  END IF;
END $$;

/*
 * Webhook 的目标从两种变三种。流程仍在里面（030:86 的理由不变：外部业务事件天然是单链路
 * 且要带入参），CI 任务加进来回答的是另一件事——「发布流水线跑完，让平台在自己的 Runner
 * 上跑一遍仓库里的用例」。
 */
ALTER TABLE webhook_triggers DROP CONSTRAINT IF EXISTS webhook_triggers_target_type_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'webhook_triggers'::regclass AND conname = 'webhook_triggers_target_type_check'
  ) THEN
    ALTER TABLE webhook_triggers ADD CONSTRAINT webhook_triggers_target_type_check
      CHECK (target_type IN ('flow', 'suite', 'ci_task'));
  END IF;
END $$;

/*
 * 调度触发记录指向 pipeline run。
 *
 * 为什么不能复用 `execution_index_id`：套件路径上，触发一次就有一行 `suite_executions`，
 * 它**入队时**就带 `execution_index_id`，所以 030:74 那一列当场填得上。CI 路径不是这样——
 * `pipeline_runs` 的 index 行只在**终态**才写（`lib/pipelineRun.ts` 的 `completePipelineRun`
 * 与租约回收器），触发那一刻它还不存在。要么让 `triggered` 行的 index id 长期为空、要么
 * 事后回填，两条都比多一列差：前者让「昨晚那次定时跑到哪去了」在界面上无法回答，后者要
 * 在 complete 的事务里反查 schedule_runs（一条与执行无关的写，且回收路径上还得抄一遍）。
 *
 * `ON DELETE SET NULL`：run 会随任务删除级联消失（迁移 038 的刻意设计），而这一行调度证据
 * 要活过它——「那天到点触发了」与「那次执行还查不查得到」是两个事实。
 */
ALTER TABLE schedule_runs
  ADD COLUMN IF NOT EXISTS pipeline_run_id UUID REFERENCES pipeline_runs(id) ON DELETE SET NULL;

/*
 * 任务终态通知（本批的范围扩项，2026-09-01 第二轮验收：用户提出「仓库任务也需要支持定时
 * 任务以及通知」）。
 *
 * 形状与迁移 033 的 `test_suites.notify_config` **逐字相同**（`onSuccess` / `onFailure` /
 * `channelIds` / `template{title,body}`），因此归一函数、校验、投递与证据行四处全部复用，
 * 一行新逻辑都不需要：这不是「CI 也要通知」这个需求恰好长得像套件通知，而是同一个问题
 * （「这个东西跑完了，告诉我结果」）在第二种目标上的同一个答案。
 *
 * JSONB 而非拆列，理由同 033：这一组值只在整存整取时有意义，没有哪一列会被单独 WHERE。
 * 默认 '{}' = 两个开关都关，行为与本批之前完全一致。
 *
 * 投递证据同样不建新表：`notification_deliveries.rule_id` 本就可空（渠道「测试」先例），
 * 任务通知的行 rule_id 为 NULL、`execution_index_id` 指向那次执行的归一行。
 */
ALTER TABLE ci_tasks ADD COLUMN IF NOT EXISTS notify_config JSONB NOT NULL DEFAULT '{}'::jsonb;

/*
 * 任务级串行（本批的第二个范围扩项，2026-09-01 第二轮验收：用户提出「同一任务并发跑会因为
 * 共享测试数据导致 case 不稳定，要排队不要报错」）。
 *
 * **默认 true**：同一份仓库用例跑两遍互不干扰，是需要被证明的性质而不是默认成立的性质。
 * 关掉它就回到本列之前的行为（并发只由 Runner 槽位兜底）。
 *
 * 语义是**排队而不是拒绝**：研发的 CI 流水线经 webhook 触发后要等结果，触发永远 202 受理、
 * 新 run 照常入 `queued`。串行由 **claim 侧守卫**保证（`routes/runners.ts` 的认领 SQL 加一条
 * `NOT EXISTS 同任务更早在途`），因此：
 * - 「谁先跑」由 `run_number` 决定而不是由认领竞速决定；
 * - 被挡住的 run 在前置 run 落终态后**自动**变成可认领，不需要任何重试逻辑；
 * - 触发路径（`lib/trigger.ts`）一行不改——串行是执行端的排队规则，不是触发端的准入规则。
 *
 * 不建索引：守卫的子查询按 `(ci_task_id, run_number)` 走迁移 038 已有的
 * `pipeline_runs_task_number_idx`。
 */
ALTER TABLE ci_tasks ADD COLUMN IF NOT EXISTS single_concurrency BOOLEAN NOT NULL DEFAULT true;
