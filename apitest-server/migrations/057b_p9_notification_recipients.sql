/*
 * P9-1 收件口径变更（2026-09-11 用户确认，057 落地当天的修订）：
 * alert / suite_result / ci_result 三类站内通知从「项目全体成员扇出」改为
 * 「谁触发发给谁」；非人触发（定时 / Webhook）不发站内——那时受众不明确，
 * 真正需要关注的人已经由站外渠道（告警规则 / 套件通知配置）覆盖。
 * member_change / plan_assign 维持原口径（成员变更全员该知道、指派本来就是单人）。
 *
 * 「谁触发的」需要一个可靠的落点：pipeline_runs 从 038 起就有 triggered_by，
 * 但套件 / 流程的宿主 execution_index 没有——本迁移补上这一列，与 pipeline_runs
 * 同款（ON DELETE SET NULL：执行历史要活过用户删除，「当时是谁」仍是已发生的
 * 事实）。
 *
 * 编号：058 已被 P11 预留（资产归属），本文件用 039b 同款字母后缀插进 057 与 058
 * 之间——迁移按文件名序执行，057b 恰好在 057 之后、058 之前。
 */
ALTER TABLE execution_index ADD COLUMN IF NOT EXISTS triggered_by UUID REFERENCES users(id) ON DELETE SET NULL;
