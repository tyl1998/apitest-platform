/*
 * 接口来源（P17，迁移 077）——一个「可以去取接口定义的地方」。
 *
 * 全系统级一张表（不设项目级来源），全局可见可选，只有系统管理员能建 / 改 / 删。
 * `type` 是驱动键（本期只落 `openapi` 一个真实驱动，adapter vendor 另立需求再排），
 * 所以这里不给 CHECK 枚举——它是一组开放的注册表键，由 `lib/specDrivers/index.ts`
 * 的 `isSupportedSpecSourceType` 在路由层把关，与 `data_sources` 的驱动注册表同形。
 *
 * `cache` 是快照（一次拉全量的归一后 operation 数组），创建时本地搜、离线可搜；
 * `cache_etag` 留着给后续条件请求。`status` 是最近一次取数的结论，`is_temporary`
 * 只是状态标记（区分正式来源与临时贴的 URL），不改变可见性与权限。
 *
 * `credential_cipher` 走 `lib/crypto.ts` 的 encryptSecret（AES-256-GCM）；读回永不下发明文。
 * `name` 全局唯一（大小写不敏感）。
 */

CREATE TABLE IF NOT EXISTS spec_sources (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  credential_cipher BYTEA,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_temporary BOOLEAN NOT NULL DEFAULT false,
  cache JSONB,
  cache_fetched_at TIMESTAMPTZ,
  cache_etag TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS spec_sources_name_idx ON spec_sources (lower(name));
