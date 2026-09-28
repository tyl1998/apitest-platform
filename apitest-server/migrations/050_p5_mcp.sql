/*
 * P5-1: MCP Server 模式的 Token 与项目开关（计划 9.1）。
 *
 * 一张表加一列。原 9.1 计划的两张表已按边界撤销：`mcp_servers` 是「平台当 Client」的
 * 反方向（不建，P10 之后按需排期）；`mcp_tool_calls` 审计表不建——外部 agent 调进来
 * 时没有 flow execution，审计走 P4.5-8 已有的 `audit_logs`（039b）。
 *
 * MCP 协议 2026-07-28 GA 已把协议核心改成无状态：没有 session、每条消息是一次自包含
 * POST。与现有无状态 Fastify + pg 同构——不需要 session 表、不需要粘性会话、不需要
 * Redis。这是本阶段范围能压缩到一张表的根本原因（9.0「不引入 session / 状态」）。
 */

/*
 * MCP Token。项目级，`Authorization: Bearer apimcp_<random>`。
 *
 * **AES-GCM 可逆加密存储**（2026-09-28 起，取代原 scrypt 哈希）：产品要求凭据能重新
 * 复制，明文要能被服务端解回来——个人中心按前缀取回明文即可，丢了不必吊销重发。格式与
 * `ingest_tokens` / `runner_tokens` / Webhook 密钥的 `secret_encrypted` 一致。代价：库被
 * 读走时加密的凭据能被主密钥解开，用可重复复制换掉了「库泄露也拿不到明文」这条属性。
 *
 * `scope TEXT[]` 而不是 boolean 列：`ingest_runs.scope`（035）与 `workers.labels`（027）
 * 是先例，当初留的「将来加 scope 不改表」这次兑现——`execute` 在表结构零改动的
 * 情况下加了进来，将来加第四种同样不需要动表。三值 'read' / 'write' / 'execute'。
 *
 * `created_by` 是 `ON DELETE SET NULL`：用户被删后 Token 行还在（吊销记录要活过被
 * 引用方），但边界 2 的活体判据取不到人——此时写调用一律拒绝、只保留 read。这不是
 * 降级容错，是唯一正确的答案：没有人为这次写入负责。
 *
 * 吊销是软删（留 `revoked_at`）：吊销的行要能回答「那次写入是谁放进来的」。
 * 部分索引排除吊销行，因此吊销即时生效（验收门槛 4）。
 */
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  secret_encrypted BYTEA,         -- AES-256-GCM(明文 token)，可解回供重新复制
  token_prefix TEXT NOT NULL,              -- 明文前 8 位，辨认与候选集收窄用
  scope TEXT[] NOT NULL DEFAULT '{read}',  -- 'read' / 'write' / 'execute'（边界 1）
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,   -- 写权限的活体判据（边界 2）
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/*
 * `/mcp` 鉴权按前缀取候选行再逐个解密比对（与 ingest_tokens_prefix_idx 同款）：
 * 全表解密会让鉴权耗时随 Token 总数线性增长。前缀索引把候选集
 * 压到个位数，且吊销行被 WHERE 条件排除——吊销即时生效，无缓存窗口。
 */
CREATE INDEX IF NOT EXISTS mcp_tokens_prefix_idx
  ON mcp_tokens (token_prefix) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS mcp_tokens_project_idx ON mcp_tokens (project_id);

/*
 * 项目级 MCP 开关（边界 12），默认 false：关掉时 `/mcp` 端点对该项目 404——不是藏
 * 前端入口，而是服务端真的不服务。一个默认开着的写入通道是安全默认值的反面。
 *
 * `project_settings` 的行只在项目设置被 PUT 过一次时才存在（routes/projects.ts 的
 * upsert），所以读取必须按「无行 = false」处理。写入侧要接 COALESCE 护住（见
 * routes/projects.ts 的注释），否则只改默认环境的一次 PUT 会把开关顺手清掉。
 */
ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS mcp_enabled BOOLEAN NOT NULL DEFAULT false;
