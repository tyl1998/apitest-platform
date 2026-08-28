/*
 * P3-2: 套件执行的变量覆盖持久化（计划 6.5 流量泳道第二层）。
 *
 * 计划 6.1 的 030 草图没有这一列，但 6.5「证据与可读性」要求一次执行的变量覆盖
 * 出现在报告的标识段（6.4），而 suite run_spec 落终态即置 NULL（迁移 026 的规则，
 * 成员正文里有凭据的考虑对套件级同样保留）。于是标识段缺一个终态后仍可读的存放
 * 位置——本迁移补上。放这里而不是塞进 member_snapshot：后者是成员清单的形状
 * （API 直接映射成 members），混入别的东西会让快照的语义分叉。
 *
 * 刻意不叫 `variables`：flow_executions.variables 是「跑完后最终的变量袋」，这里存
 * 的是「入队时给的覆盖」，两个语义在两张姊妹表上撞同一个名字只会让人读错。
 * 内容按边界 17 本就不该放密钥（明文冻进 run_spec 并出现在执行快照里），不脱敏。
 */
ALTER TABLE suite_executions
  ADD COLUMN IF NOT EXISTS variable_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
