/*
 * 073: Webhook 触发来源链接（2026-09-26 验收需求）。
 *
 * 第三方通过 Webhook 触发时，可在请求体带一个 `_trigger_url`（如本次 CI 任务的地址）。
 * 平台把它记成「触发来源链接」，在执行记录/报告/仓库运行里点开直达触发它的那次构建。
 *
 * 只给有 `trigger_source/ref_name` 的两张表加列：`execution_index`（流程/套件/单接口的
 * 通用运行账本）与 `pipeline_runs`（仓库任务）。套件在 `execution_index` 上，仓库任务
 * 在 `pipeline_runs` 上。NULL = 没有外部来源链接。
 */
ALTER TABLE execution_index ADD COLUMN IF NOT EXISTS trigger_source_url TEXT;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS trigger_source_url TEXT;