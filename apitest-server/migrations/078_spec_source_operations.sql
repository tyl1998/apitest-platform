/*
 * 接口来源的派生操作索引（P17 性能，迁移 078）。
 *
 * 背景：077 把来源快照整份存在 `spec_sources.cache`（JSONB）。搜索时按 `s.*` 取行会
 * 把每个来源的整份快照 JSON 读进内存，来源多 / 快照大时「搜一次」的读写量与「全部来源
 * 快照之和」成正比。
 *
 * 本表把每个 operation 拆成一行：搜索只读很小的 `search_text`（小写干草堆）命中判断，
 * 命中后再取 `payload`（完整 SourceOperation，供预填）。列表的 operationCount 也退化为
 * `count(*)`，不再需要读 `cache`。刷新（refresh）时整来源重写本表。
 *
 * `search_text` 用小写拼 method / path / summary / description / tags，搜索用
 * `strpos(search_text, lower(keyword)) > 0` 做字面子串匹配（无通配符转义问题）。
 *
 * 回填：把已在 `cache` 里的快照拆进本表，老数据无需重置即可搜。检索型来源（adapter）
 * 无快照、不落本表，仍实时透传远端。
 */

CREATE TABLE IF NOT EXISTS spec_source_operations (
  source_id UUID NOT NULL REFERENCES spec_sources(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL,
  PRIMARY KEY (source_id, method, path)
);

CREATE INDEX IF NOT EXISTS spec_source_operations_source_idx ON spec_source_operations (source_id);

/* 回填存量快照（幂等：重复跑靠 ON CONFLICT 跳过）。 */
INSERT INTO spec_source_operations (source_id, method, path, summary, search_text, payload)
SELECT
  s.id,
  upper(coalesce(op->>'method', '')),
  coalesce(op->>'path', ''),
  coalesce(op->>'summary', ''),
  lower(concat_ws(' ',
    coalesce(op->>'method', ''), coalesce(op->>'path', ''), coalesce(op->>'summary', ''),
    coalesce(op->>'description', ''), coalesce(op->'tags', '[]'::jsonb)::text)),
  op
FROM spec_sources s
CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.cache, '[]'::jsonb)) AS op
WHERE coalesce(op->>'method', '') <> '' AND coalesce(op->>'path', '') <> ''
ON CONFLICT (source_id, method, path) DO NOTHING;
