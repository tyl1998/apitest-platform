/*
 * P4.5-7: artifacts（对象存储元数据表）。计划 8.1 的 039 是「通用设施」一个文件，
 * 但 P4.5-8 还没做（idempotency_keys / audit_logs 属那一批）——迁移是 forward-only
 * 的，现在把 039 整个建掉、P4.5-8 就没有自己的文件可写；所以本批只建 artifacts，
 * 幂等与审计两张表留给 039b（P4.5-8 落地时再建）。表结构逐字照抄计划 8.1 的 039。
 *
 * `owner_type` + `owner_id` 多态而不是 `pipeline_run_id`（计划 8.1 的注释原话）：P6 要把
 * 大响应体和归档也放进来，表结构现在就别把自己锁死。CHECK 里现在只有一个值，加值时
 * 是一次 DROP/ADD CHECK，比加一张表便宜。
 *
 * `uploaded_at` NULL = 申请了但没传成：申请（POST /runner/jobs/:id/artifacts）写行，
 * 直传完成回调（s3 完成回调在 P6 之前不存在，fs 驱动在落盘时回写）置时间。一张
 * 「申请了但永远空着」的行是事实（Runner 中途死了），不是垃圾——别去猜着清。
 */
CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('pipeline_run')),
  owner_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('log', 'report', 'file')),
  name TEXT NOT NULL,
  storage_driver TEXT NOT NULL CHECK (storage_driver IN ('fs', 's3')),
  storage_key TEXT NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  checksum TEXT NOT NULL DEFAULT '',
  uploaded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* 执行详情页的产物 tab（P4.5-11）按 run 全量列：owner 多态之后这个查询永远带
   owner_type 常量，部分索引只留一种值时仍然成立。 */
CREATE INDEX IF NOT EXISTS artifacts_owner_idx
  ON artifacts (owner_type, owner_id, created_at DESC);
