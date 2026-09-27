/*
 * 074: webhook 列表显示最近一次运行状态（2026-09-26 验收需求）。
 *
 * 触发成功后记住这次 run 的 id，列表行展示它的状态并可点击跳转到运行详情。
 * 不存 status（状态会变），列表查询用 LEFT JOIN 从对应表实时读。
 */
ALTER TABLE webhook_triggers ADD COLUMN IF NOT EXISTS last_run_id UUID;