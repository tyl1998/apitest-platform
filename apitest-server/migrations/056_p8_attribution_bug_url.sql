-- P8-3 验收反馈（2026-09-09）：归因绑定 bug 链接。
-- 空串 = 未绑定（与 note 同款「空值不建档」姿态，避免 NULL/空串三态）。
ALTER TABLE failure_attributions ADD COLUMN IF NOT EXISTS bug_url TEXT NOT NULL DEFAULT '';
