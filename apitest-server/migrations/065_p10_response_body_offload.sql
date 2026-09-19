/*
 * P10-1（计划 14.1）：大响应体口径变更 + 转存对象存储。
 *
 * **两个「大」拆开**：`response_truncated`（002）表达「为断言 / 展示截断到 10KB」，原义
 * 不动；这里新增的两列表达「完整正文已转存对象存储、可按需拉全量」。一行可以只有前者
 * （历史行、转存关闭、超出落盘上限、对象写入失败），不能只有后者。
 *
 * **只加对象 key + 驱动，不加 size / content-type**：`response_size_bytes` 与
 * `response_content_type`（002）记的本来就是完整正文的真实大小与类型，转存后照旧。
 *
 * **驱动一并记**（照 `artifacts.storage_driver`，039）：部署换驱动后旧 key 在新驱动里
 * 不存在，读侧据此回一个干净的 404，而不是签出一条打不开的直链。
 *
 * **不走 artifacts 表**：039 的注释虽预留了大响应体，但 14.1 明确「`executions` 只留对象
 * key + content-type + 真实大小」——一次执行最多一个正文对象、key 由执行 id 派生
 * （`executions/<id>/response`），多一张多态表只多一次 join。对象生命周期（归档 / 清理）
 * 留给 P10-2 与分区表同批处理（14.1「不能只归档行、留下孤儿对象」）。
 *
 * **历史行不回填**：key 为 NULL 即「无全量」（14.1 边界）。
 *
 * **转存开关是项目级的**（2026-09-19 用户拍板：默认开）：没有系统设置表，复用
 * `project_settings`；无行 = 列默认（与 `store_plaintext` / `mcp_enabled` 同一条纪律，
 * 见 routes/projects.ts 的注释）。落盘上限走环境变量 `RESPONSE_OFFLOAD_MAX_BYTES`，
 * 不进表。
 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS response_body_object_key TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS response_body_storage_driver TEXT
  CHECK (response_body_storage_driver IN ('fs', 's3'));

ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS offload_large_response BOOLEAN NOT NULL DEFAULT true;
