/*
 * P10-2（计划 14.1）：执行历史归档 —— `executions` 改为**按季**范围分区。
 *
 * **分区换来的是什么，先说准**：不是列表查询变快（执行记录列表今天就走
 * `executions_project_created_at_idx`，已经是索引驱动的），而是**批量移除从「DELETE 百万行
 * + 表膨胀 + 等 autovacuum」变成「DETACH 一张表」**。所以粒度对齐的是归档窗口，不是查询
 * 模式——2026-09-20 用户拍板**按季**（4 张/年）而不是按月（12 张/年）：归档窗口本就以季/年
 * 计，月粒度多出 3 倍关系数（表 + 10 个索引）却换不到额外收益。
 *
 * **净损失项，必须写在这里**：`WHERE id = $1`（worker 认领 / 取消 / 详情 / 下载直链，代码里
 * 16 处）没有 `created_at`，**无法分区裁剪，要逐分区探索引**。这是本批唯一变差的东西，且随
 * 分区数单调增长——按季 5 年 = 20 张，可接受；这也正是不选按月的理由。
 *
 * ── 三处不可回避的结构变更 ──────────────────────────────────────────────────
 *
 * 1. **主键 `id` → `(id, created_at)`**：Postgres 要求分区键出现在每一个唯一约束里。`id` 放
 *    前面是刻意的——上面那 16 处按 id 单查靠的就是这个索引的前缀。代价：`id` 的**全局**唯一
 *    性不再由约束保证（每张分区各自唯一），由 UUIDv4 保证。
 *
 * 2. **两条指向 executions 的外键必须拆掉**：分区表的唯一键含 `created_at`，而引用方
 *    （`execution_steps.http_execution_id` / `mocks.snapshot_execution_id`）没有这一列，
 *    无法组成合法的外键。列保留、`ON DELETE SET NULL` 语义消失，降级为「悬垂即证据已消失」
 *    ——现有读法（LEFT JOIN / 取回再查）本来就按「查不到就没有」处理，可降级。**但归档与
 *    清理必须显式置空这些指针**（lib/executionArchive.ts 的 `dropArchivedPartition`），
 *    否则会留下指向已删分区的指针。
 *
 * 3. **DEFAULT 兜底分区**：维护拍（scheduler）停了也绝不能写失败——一次执行写不进
 *    `executions` 等于整个平台停摆。代价是建新分区时要扫一遍 DEFAULT 并对它取
 *    ACCESS EXCLUSIVE；因为维护拍提前两季预建，正常情况下 DEFAULT 恒空，扫描是空操作。
 *
 * ── 季的边界按 UTC 对齐 ────────────────────────────────────────────────────
 *
 * 分区边界字面量一律带 `+00`，不依赖会话 TimeZone：迁移在这里建的分区与 scheduler 之后建的
 * 分区必须用同一个「季」的定义，否则某一季的两端会差出几个小时，出现既不属于前一季也不属于
 * 后一季的缝（真落进缝里会被 DEFAULT 接住，但那就是一张永不到期的杂物表）。
 *
 * ── 一次性改造，不可重放 ───────────────────────────────────────────────────
 *
 * 本文件是换表而不是可重放 DDL（`IF NOT EXISTS` 在这里没有意义）。once-only 由 migrate.ts
 * 的 `schema_migrations` 保证，与 015 / 021 的一次性回填同一条纪律。手工重放会在第一条语句
 * 就失败并整体回滚（每个迁移文件一个事务），不会写坏数据。
 */

/*
 * 1. 新父表。
 *
 * `LIKE ... INCLUDING DEFAULTS INCLUDING CONSTRAINTS` 而不是手抄列定义：executions 的列是
 * 001 起十几个迁移叠出来的（最近一次是 065 的两列转存字段），手抄必漏。NOT NULL 总是被复制，
 * CHECK 约束随 INCLUDING CONSTRAINTS 复制（`executions_status_check` /
 * `executions_source_check` 的名字照旧，Postgres 对 CHECK 的自动命名也正好落在同一个名字上）。
 * **外键与索引不在 LIKE 的复制范围内**，下面第 7、9 步显式重建。
 */
CREATE TABLE executions_p10 (LIKE executions INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
  PARTITION BY RANGE (created_at);

/* 2. 兜底分区（见头注 3）。 */
CREATE TABLE executions_default PARTITION OF executions_p10 DEFAULT;

/*
 * 3. 覆盖现有数据的所有季 + 当前季 + 预建两季。
 *
 * 预建两季与 scheduler 维护拍的提前量一致：拍停了仍有半年缓冲，且 DEFAULT 在缓冲之外兜底。
 */
DO $$
DECLARE
  q_start timestamp;
  q_end   timestamp;
  q_stop  timestamp;
BEGIN
  /* 空表时从当前季起步；`AT TIME ZONE 'UTC'` 把时刻换算到 UTC 再截断，季界才与下面的
     `+00` 字面量同源。 */
  SELECT date_trunc('quarter', COALESCE(MIN(created_at), now()) AT TIME ZONE 'UTC')
    INTO q_start FROM executions;
  q_stop := date_trunc('quarter', now() AT TIME ZONE 'UTC') + interval '6 months';

  WHILE q_start <= q_stop LOOP
    q_end := q_start + interval '3 months';
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF executions_p10 FOR VALUES FROM (%L) TO (%L)',
      format('executions_%sq%s', to_char(q_start, 'YYYY'), to_char(q_start, 'Q')),
      to_char(q_start, 'YYYY-MM-DD HH24:MI:SS') || '+00',
      to_char(q_end,   'YYYY-MM-DD HH24:MI:SS') || '+00'
    );
    q_start := q_end;
  END LOOP;
END $$;

/* 4. 搬数据。列序由 LIKE 保证一致，`SELECT *` 是安全的（也是唯一不会漏列的写法）。 */
INSERT INTO executions_p10 SELECT * FROM executions;

/*
 * 5. 拆掉所有指向 executions 的外键（见头注 2）。
 *
 * 按 `pg_constraint` 扫而不是按名字逐条 DROP：约束名是 Postgres 自动生成的，写死名字会在
 * 「名字对不上就静默跳过」和「DROP TABLE 时才炸」之间二选一，两个都不要。
 */
DO $$
DECLARE fk record;
BEGIN
  FOR fk IN
    SELECT con.conname, con.conrelid::regclass::text AS tbl
    FROM pg_constraint con
    WHERE con.contype = 'f' AND con.confrelid = 'executions'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
    RAISE NOTICE '[066] 拆除指向 executions 的外键：%.%', fk.tbl, fk.conname;
  END LOOP;
END $$;

/* 6. 换位。旧表带走自己的索引，下面第 9 步才能用回原来的索引名。 */
DROP TABLE executions;
ALTER TABLE executions_p10 RENAME TO executions;

/* 7. 主键（见头注 1）。 */
ALTER TABLE executions ADD CONSTRAINT executions_pkey PRIMARY KEY (id, created_at);

/*
 * 8. 出向外键。分区表作为**引用方**没有任何限制，级联删除照常下推到分区。
 *
 * 名字沿用 Postgres 原来的自动命名（`<表>_<列>_fkey`），免得以后按名字操作时对不上。
 * 删除行为逐条照抄原定义：项目 / 接口是拥有关系（CASCADE），其余是「历史活得比引用久」
 * （SET NULL，与 environment_name 快照同一条纪律）。
 */
ALTER TABLE executions ADD CONSTRAINT executions_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE executions ADD CONSTRAINT executions_endpoint_id_fkey
  FOREIGN KEY (endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE;
ALTER TABLE executions ADD CONSTRAINT executions_environment_id_fkey
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL;
ALTER TABLE executions ADD CONSTRAINT executions_batch_id_fkey
  FOREIGN KEY (batch_id) REFERENCES batch_executions(id) ON DELETE SET NULL;
ALTER TABLE executions ADD CONSTRAINT executions_case_id_fkey
  FOREIGN KEY (case_id) REFERENCES test_cases(id) ON DELETE SET NULL;
ALTER TABLE executions ADD CONSTRAINT executions_flow_execution_id_fkey
  FOREIGN KEY (flow_execution_id) REFERENCES flow_executions(id) ON DELETE SET NULL;
ALTER TABLE executions ADD CONSTRAINT executions_triggered_by_fkey
  FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL;

/*
 * 9. 索引，逐条照抄原定义与原名字（001 / 002 / 006 / 007 / 008 / 009 / 012 / 027 / 055）。
 *
 * 建在父表上即自动下推到每一张分区（含之后新建的分区），局部索引在分区表上同样合法。
 * 名字必须与改造前一致：055 就是靠 `DROP INDEX executions_created_at_idx` 按名字纠偏的，
 * 以后还会有这种前向修正。
 */
CREATE INDEX executions_project_created_at_idx ON executions(project_id, created_at DESC);
CREATE INDEX executions_endpoint_created_at_idx ON executions(endpoint_id, created_at DESC);
CREATE INDEX executions_batch_id_idx ON executions(batch_id);
CREATE INDEX executions_case_created_at_idx ON executions(case_id, created_at DESC);
CREATE INDEX executions_endpoint_source_created_at_idx ON executions(endpoint_id, source, created_at DESC);
CREATE INDEX executions_pending_idx ON executions(status, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX executions_worker_created_at_idx ON executions(worker_id, created_at DESC);
CREATE INDEX executions_flow_execution_idx ON executions(flow_execution_id, created_at);
CREATE INDEX executions_pending_label_idx ON executions(runner_label, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX executions_failed_created_at_idx ON executions (created_at DESC) WHERE status = 'failed';

/*
 * 10. 归档台账。
 *
 * 2026-09-20 用户拍板的归档形态是「DETACH + 改名保留，何时真删由人决定」，于是多出两个
 * 运维必须能回答、而 Postgres 目录**答不出**的问题：这张已脱离的表是**什么时候**脱离的
 * （目录不记 rename 时间），以及它最后**被谁**清掉的。没有答案，「该清了」就只能靠人记，
 * 正是这次要消灭的那种无序扩张。
 *
 * 行**不随 DROP 删除**：表没了，台账还在——「2026q1 的 N 条执行历史于某时脱离、于某时由
 * 某人清除」是一条永久事实。`row_count` 是脱离那一刻的真实计数（COUNT(*)，不是统计估算），
 * 表被 DROP 之后它是唯一还说得出「清掉了多少」的地方。
 *
 * 与 `audit_logs` 不重复：审计流回答「谁做了什么」，且是 fire-and-forget（写失败只损失一条
 * 历史）；这张表是清理动作的**前置状态机**——没有这一行就没有可清理的目标，不能丢。
 */
CREATE TABLE IF NOT EXISTS execution_partition_archives (
  /* 改名后的表名（executions_archived_YYYYqN），既是主键也是 DELETE 端点的目标标识。 */
  table_name TEXT PRIMARY KEY,
  quarter_start TIMESTAMPTZ NOT NULL,
  quarter_end TIMESTAMPTZ NOT NULL,
  row_count BIGINT NOT NULL,
  detached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  /* 非空 = 表已被清除；台账行保留（见上）。 */
  dropped_at TIMESTAMPTZ,
  /* 清理者销号后仍要留下「清过」这个事实（与 executions.triggered_by 同一条纪律）。 */
  dropped_by UUID REFERENCES users(id) ON DELETE SET NULL
);

/* 状态接口按「未清理的排前面、新脱离的排前面」列，这是它唯一的排序。 */
CREATE INDEX IF NOT EXISTS execution_partition_archives_detached_at_idx
  ON execution_partition_archives (detached_at DESC);
