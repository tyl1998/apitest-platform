-- P9-4 修订（2026-09-14，用户四条反馈之二）：站内助手默认开启、取消项目级闸门。
-- 助手是「用户 × 会话」的功能（凭据后续也走用户级，见 DEVELOPMENT_PLAN 13.0 修订），
-- 不该由项目管理员决定开不开——project_settings.assistant_enabled 整列作废。
-- 编号顺延：本文件占用 058，P11 由 058 顺延为 059。
ALTER TABLE project_settings DROP COLUMN IF EXISTS assistant_enabled;
