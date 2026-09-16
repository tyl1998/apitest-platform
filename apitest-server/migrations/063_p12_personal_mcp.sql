/*
 * P12-1（计划 18.1）：MCP Token 用户级化 + 项目绑定。
 *
 * **token 归人、绑定归项目、scope 放绑定上**（18.0 边界 2）。原 050 把 `project_id`
 * 与 `scope` 都挂在 token 行上——一把 token 只能服务一个项目，且写权限随绑定数
 * 线性放大。本迁移把两个列都删掉，项目归属改由 `mcp_token_projects` 表达：一把
 * token 绑 N 个项目，每个绑定各有自己的 scope（A 可写、B 只读可表达）。
 *
 * **既有行不搬**（AGENTS.md Data Compatibility：项目未发布，无历史数据要保护）。
 * 迁移后既有 dev token 一行绑定都没有——任何 tools/call 都因「未绑定」被拒（-32601
 * 形状），等价于作废；重签即可，`created_by` 仍指向签发人。
 *
 * `mcp_tokens_prefix_idx` 部分索引（前缀收窄候选集 + 排除吊销行）与吊销即时生效
 * 的机制一行不动——鉴权热路径不变。`mcp_tokens_project_idx`（050）建在被删的
 * `project_id` 列上，随列删除由 PG 自动回收，无需显式 DROP。
 */
ALTER TABLE mcp_tokens DROP COLUMN IF EXISTS project_id;
ALTER TABLE mcp_tokens DROP COLUMN IF EXISTS scope;

/*
 * 绑定表：token × 项目 × scope。
 *
 * `scope` 在绑定而不是 token 上（边界 2）：'read' / 'write' / 'execute' 三值，
 * `read` 恒在（normalizeScopes 的归一搬到签发侧的绑定入口）。复合主键
 * `(token_id, project_id)` 保证「同一 token 同一项目只有一条绑定」，解绑即删行。
 *
 * 两侧 FK 都是 `ON DELETE CASCADE`：token 吊销/删除、项目删除都不该留下悬空绑定。
 * 但吊销是软删（token 行还在），所以吊销时显式删绑定不是必须——闸门①已排除吊销
 * 行，鉴权面无可见行为；项目侧绑定列表按 `revoked_at IS NULL` 过滤，吊销的行不
 * 出现。解绑（边界 4）删的是这一行。
 *
 * 绑定是**过滤器，不是授权**（边界 3）：绑定时刻实时角色匹配，调用时刻每次重跑
 * `canAccess(owner, 目标项目)`。项目侧按 project_id 反查「谁的钥匙开了我这扇门」
 * （项目管理员解绑视图），故单建 `mcp_token_projects_project_idx`。
 */
CREATE TABLE IF NOT EXISTS mcp_token_projects (
  token_id   UUID NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope      TEXT[] NOT NULL DEFAULT '{read}',
  bound_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, project_id)
);

CREATE INDEX IF NOT EXISTS mcp_token_projects_project_idx ON mcp_token_projects (project_id);
