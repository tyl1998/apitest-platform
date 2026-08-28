/*
 * P3-11：套件级通知设置（验收反馈，2026-08-28 确认，见 DEVELOPMENT_PLAN.md 6.8）。
 *
 * 通知配置挂在套件而不是告警规则上：告警规则回答「这个项目的质量指标怎么了」，
 * 套件通知回答「这个套件跑完了，告诉我结果」——两个问题不同层，配置就该分开。
 *
 * JSONB 而非拆列：onSuccess/onFailure/channelIds/template 是一组只在整存整取时
 * 有意义的展示性配置，没有哪一列会被单独 WHERE（渠道删除时按 channelIds 摘除
 * 悬空 id 的更新走 jsonb 函数，与 alert_rules.channel_ids 的清理同款）。
 * 默认 '{}' = 两个开关都关，行为与 P3 之前完全一致。
 *
 * 投递证据不建新表：notification_deliveries.rule_id 本就可空（渠道「测试」
 * 先例），套件通知的行 rule_id 为 NULL、execution_index_id 指向该次执行。
 */
ALTER TABLE test_suites ADD COLUMN IF NOT EXISTS notify_config JSONB NOT NULL DEFAULT '{}'::jsonb;
