/*
 * P4.5 报告用例的唯一身份修正（2026-09-02 验收反馈第三批 ③）。
 *
 * 038 给 pipeline_run_cases 定的唯一键是 (pipeline_run_id, source, suite_name,
 * case_name)。它防的是「同一份报告重投插两遍」，但它同时把**两条真实存在的不同执行**
 * 折叠成了一行：参数化用例带 @allure.title 时，两个参数的 result 文件 name/fullName
 * 完全相同（历史 title 也不同不了），ON CONFLICT DO NOTHING 把第二条静默吞掉——
 * 报告包（按 uid）显示失败 2，计数（按表行）显示失败 1，两处对不上。
 *
 * allure 结果文件的真身是它的 uuid（= 报告视图的 uid），加 external_id 列进唯一键：
 * - allure 路径 = 结果 JSON 的 uuid（Runner 的 complete 上报，见 report/allure.ts）；
 * - junit 路径 = ''（junit 的 classname::name 自带参数化 id，天然不重）。
 *
 * 键加宽不改语义：重投的 uuid 相同仍撞键幂等收，不同执行各占一行。
 * （旧行的 external_id 落默认 ''，被折叠掉的那几条不回填——重跑一次任务即恢复。）
 */

ALTER TABLE pipeline_run_cases ADD COLUMN IF NOT EXISTS external_id TEXT NOT NULL DEFAULT '';

/*
 * 按定义找旧唯一约束再 DROP（038 的纪律：建表时的内联 UNIQUE 由 Postgres 自动命名，
 * 猜名字的 DROP IF EXISTS 静默什么都不做，第一次写入时才炸而迁移显示成功）。
 */
DO $$
DECLARE
  target TEXT;
BEGIN
  FOR target IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'pipeline_run_cases'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) ILIKE '%pipeline_run_id%source%suite_name%case_name%'
  LOOP
    EXECUTE format('ALTER TABLE pipeline_run_cases DROP CONSTRAINT %I', target);
  END LOOP;
END $$;

ALTER TABLE pipeline_run_cases ADD CONSTRAINT pipeline_run_cases_identity_unique
  UNIQUE (pipeline_run_id, source, suite_name, case_name, external_id);
