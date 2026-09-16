-- 061：会话映射行补 elicit_log——MRTR 确认结果的平台侧持久化（2026-09-15，P9-5 增补）。
--
-- 背景：删除确认卡（issue: 问题记录-助手MRTR删除确认被当文字吞掉）的确认动作走
-- 本人 JWT 的既有 REST，上游 transcript 不知道这件事——历史回放时确认记录整个
-- 消失（用户实测：「确认删除后，聊天记录内没有看到这个记录了」）。对话正文归上
-- 游，平台的确认动作归平台：结果落映射行的 jsonb 日志，历史代理回放时并回去。
-- 追加式日志（每次确认 append 一条），量级是 UI 动作记录不是业务数据，不建表。

ALTER TABLE assistant_conversations ADD COLUMN IF NOT EXISTS elicit_log JSONB NOT NULL DEFAULT '[]'::jsonb;
