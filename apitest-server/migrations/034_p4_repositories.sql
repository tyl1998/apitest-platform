/*
 * P4-1: 仓库模式（上报式用例）的绑定与凭据。范围与边界见 DEVELOPMENT_PLAN.md 7.0/7.1。
 *
 * 核心模型：平台不拥有测试代码，只接收「跑完之后的结果」。用例挂到「系统 → 接口 →
 * 用例」树上，接口下有用例 = 已覆盖。本迁移只落绑定与凭据两张表，上报本身在 035。
 *
 * 编号说明：计划原写 `005_p4_schema.sql` 为过时命名，实际接在 033 之后。
 */

/*
 * 一个项目绑定唯一一个仓库（Spec 2.10 基数约束，边界 18）。
 *
 * `project_id UNIQUE` 让「一项目挂两仓库」由数据库拒绝，而不是靠路由里的一次
 * SELECT——那种检查在并发首报下会双双通过。
 *
 * **`git_url` 上刻意没有全局唯一约束**：禁止的是「一项目挂两仓库」，不禁止「同一个
 * 仓库出现在多个项目里」。一个 monorepo 按目录划分多个系统时（边界 19），每个项目各
 * 登记一行同 git_url 的记录，各自看到的仍是自己的单例视图。
 *
 * `tracking_branch` 是删除对账的第二道闸门（边界 11）：只有全量上报**且**在跟踪分支
 * 上才允许软删用例。一次 feature 分支上的全量跑不该删掉主干上还存在的用例。
 *
 * `status='unbound'` 是解绑后的状态：解绑**保留**历史用例与上报记录，不做级联删除
 * ——那些历史是「当时确实测过」的事实，换个仓库不会让它变成假的。
 */
CREATE TABLE IF NOT EXISTS repositories (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  git_url TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'other' CHECK (provider IN ('github', 'gitlab', 'gitee', 'bitbucket', 'other')),
  tracking_branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unbound')),
  /* 首次上报时的 commit，用于「这棵树是从哪一版长起来的」。 */
  first_seen_commit TEXT,
  last_ingest_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/*
 * 上报 Token。项目级，`Authorization: Bearer apitrack_<token>`。
 *
 * **AES-GCM 可逆加密存储**（2026-09-28 起，取代原 scrypt 哈希）：产品要求「凭据能重新
 * 复制」，所以明文要能被服务端解回来——管理页按前缀取回明文即可，丢了不必吊销重发。
 * 格式与 Webhook 密钥 / `api_access_keys.secret_encrypted` 同款。代价：库被读走时加密的
 * 凭据能被主密钥解开，用可重复复制换掉了「库泄露也拿不到明文」这条属性。
 *
 * `token_prefix` 存明文前 8 位（`apitrack_` 之后的那段），供列表展示与「这条是哪个」
 * 的辨认。它不足以反推出 Token，也不参与校验。
 *
 * 吊销是软删（留 `revoked_at`）：一个被吊销的 Token 在上报记录里还留着引用，硬删之后
 * 「那次上报是谁报的」就答不出来了。
 */
CREATE TABLE IF NOT EXISTS ingest_tokens (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  secret_encrypted BYTEA,         -- AES-256-GCM(明文 token)，可解回供重新复制
  token_prefix TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingest_tokens_project_created_at_idx ON ingest_tokens(project_id, created_at DESC);
/*
 * `/ingest` 的鉴权扫描：Token 是不透明随机串，请求里没有项目信息，所以只能按前缀
 * 取候选行再逐个解密比对。前缀索引把候选集压到个位数——全表解密会让上报接口
 * 的耗时随 Token 总数线性增长。
 */
CREATE INDEX IF NOT EXISTS ingest_tokens_prefix_idx ON ingest_tokens(token_prefix) WHERE revoked_at IS NULL;
