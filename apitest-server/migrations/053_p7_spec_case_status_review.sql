-- P7-3 第十一轮（㉘）：用例生命周期改名——draft/active/deprecated →
-- unreviewed/reviewed/deprecated（用户口径：未评审 / 已评审 / 废弃）。
-- 项目未发布、无历史数据要保（AGENTS.md 数据兼容条款），直接改值 + 换约束；
-- 新默认 = unreviewed（新用例从「未评审」起步，评审是通过动作，不是缺省态）。

UPDATE spec_cases SET status = 'unreviewed' WHERE status = 'draft';
UPDATE spec_cases SET status = 'reviewed' WHERE status = 'active';

ALTER TABLE spec_cases DROP CONSTRAINT IF EXISTS spec_cases_status_check;
ALTER TABLE spec_cases ALTER COLUMN status SET DEFAULT 'unreviewed';
ALTER TABLE spec_cases ADD CONSTRAINT spec_cases_status_check CHECK (status IN ('unreviewed','reviewed','deprecated'));
