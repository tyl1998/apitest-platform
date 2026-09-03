/*
 * 用例树 × 任务报告的读时关联（2026-09-03，验收反馈：树要展示绑定的仓库任务、
 * 状态与最近执行从最新任务报告取）。
 *
 * 匹配键是「nodeid 去掉参数化后缀」：SDK 的 case_key = pytest nodeid 去掉 `[...]`
 * （apitrack case.py 的 case_key_of），allure 的 guessed_case_key（= fullName）就是
 * nodeid 本身。两者在「去掉尾部 [param]」之后相等——对 pytest + allure + SDK 这套
 * 栈是确定性匹配；junit 的 `classname::name` 对不上 nodeid 就对不上（边界 13 的
 * best-effort 语义不变：读时关联用于**展示**，绝不回写 repo_test_cases）。
 *
 * 表达式索引：关联发生在 LATERAL 里（`regexp_replace(guessed_case_key, ...) = c.case_key`），
 * 没有它每行 case 都是一次全表扫。guessed_case_key 的正则两边（这里与 ingest.ts 的
 * LATERAL）必须逐字相同，否则索引不生效。
 */
CREATE INDEX IF NOT EXISTS pipeline_run_cases_guessed_key_normalized_idx
  ON pipeline_run_cases (regexp_replace(guessed_case_key, '\[[^\]]*\]$', ''))
  WHERE guessed_case_key IS NOT NULL;
