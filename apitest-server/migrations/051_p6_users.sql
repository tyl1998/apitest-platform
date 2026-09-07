/*
 * P6-1: 用户与权限的数据层（计划 10.1，DEVELOPMENT_PLAN_P6-P10.md）。
 *
 * users 三列全是「注册/建号/改密」三条将来路径的地基：
 *   - must_change_password：管理员建号与重置密码都置 true，首登强制改密（边界 1）；
 *   - pwd_epoch：改密自增，JWT 校验时不等即 401——旧 token 全部失效不需要黑名单表（边界 7）；
 *   - last_login_at / updated_at：纯记录列，本阶段只写不读。
 *
 * invitations 是第五次照抄 Token 形状（users.password_hash / ingest_tokens /
 * runner_tokens / mcp_tokens）：scrypt salt:digest、明文前 8 位收窄候选集、
 * 部分索引排除已用/已吊销码。差异点（边界 3）：默认 7 天过期、单次使用
 * （consumed_at + consumed_user_id）。role 允许 NULL = 不预分配项目。
 *
 * user_project_roles 补 granted_by / granted_at（边界 10）：成员变更要进审计、
 * 要能回答「谁把谁加进来的」，这两列就是证据行的原始材料。
 */
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pwd_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',           -- 给签发人自己看的备注（给谁/为什么）
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,   -- NULL = 不预分配项目
  role TEXT CHECK (role IN ('project_admin','developer','viewer')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitations_prefix_idx ON invitations (token_prefix) WHERE consumed_at IS NULL AND revoked_at IS NULL;

ALTER TABLE user_project_roles
  ADD COLUMN IF NOT EXISTS granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ NOT NULL DEFAULT now();
