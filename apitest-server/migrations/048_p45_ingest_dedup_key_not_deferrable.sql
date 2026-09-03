/*
 * 修复 045 引入的 /ingest 全量 500（2026-09-03，c1f4d1ba 的上报一次都没进来）。
 *
 * 现象：迁移 045 之后每一次 POST /ingest 都回 500：
 *   ON CONFLICT does not support deferrable unique constraints/exclusion
 *   constraints as arbiters（SQLSTATE 55000）。
 * 根因：045 把幂等键 ingest_runs_commit_dedup_key 建成了
 *   UNIQUE (repository_id, commit_sha, ci_run_id) DEFERRABLE INITIALLY DEFERRED，
 *   而 lib/ingest.ts 的插入语句靠 ON CONFLICT (repository_id, commit_sha, ci_run_id)
 *   做合并——PostgreSQL 的 ON CONFLICT 仲裁器必须是不可延迟的唯一约束，
 *   DEFERRABLE 的约束不能当 arbiter，语句直接报错。
 *   SDK 侧纪律是「上报失败只 warning、不动测试结果」（reporter.py），于是测试全绿、
 *   唯一的线索藏在 CI 日志的 warnings summary 里；同一 commit 的 c1f4d1ba 跑了 5 次
 *   （run 17–21），ingest_runs 一行都没有。
 *
 * 修法：约束改为 NOT DEFERRABLE。045 的 DEFERRABLE 从来没有消费者——唯一想用延迟
 * 检查的场景是「事务里先 DELETE 再 INSERT 同键」，而 /ingest 的事务没有这个形状
 * （合并走 ON CONFLICT，旧行删除只发生在迁移的 DO 块里，那里不需要约束延迟）。
 *
 * 幂等性本来就不靠 DEFERRABLE：折形键 (repository, commit, '') 的插入值恒为 ''，
 * 冲突判定与行上真值无关，NOT DEFERRED 的即时检查语义与折形完全一致。
 *
 * 落法：先 DROP 约束（045 按 auto-named 找过旧约束，这里的名字是 045 自己起的，
 * 固定存在），再按 045 的原列建 UNIQUE。045 已 applied、不可改（前向修正是新文件），
 * 新库两个迁移连跑的净效果 = 045 的合并逻辑 + 一个正确的键约束。
 */

ALTER TABLE ingest_runs DROP CONSTRAINT IF EXISTS ingest_runs_commit_dedup_key;

/* DROP CONSTRAINT 会带走它背靠的唯一索引；ADD CONSTRAINT UNIQUE 重建的是普通（非
   deferrable）唯一约束，正好是 ON CONFLICT 需要的仲裁器形态。 */
ALTER TABLE ingest_runs ADD CONSTRAINT ingest_runs_commit_dedup_key
  UNIQUE (repository_id, commit_sha, ci_run_id);
