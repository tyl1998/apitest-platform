/*
 * P14-2（计划 20，14.7 转正）：权限申请审批流。
 *
 * 非成员自助申请加入项目的通道——不是第二条成员写路径：**批准 = 既有成员 upsert**
 * （routes/members.ts 的 upsert，`granted_by` 落审批人、`member.upsert` 审计照旧，
 * 边界 3）。本表只记「谁向哪个项目申请、带没带建议角色、审批到了哪一步」，成员事实
 * 仍落 user_project_roles。P6-3 邀请码、P6-4 人工添加两条既有通道不变（边界 4）。
 *
 * suggested_role 可空（NULL = 未带建议，边界 7 的开口）：申请可带一个「我想要什么
 * 角色」的建议，管理员批准时可改定——最终角色以批准动作为准，不以申请为准。
 *
 * 单 pending（边界 6）：partial unique index 保证同一 (project, user) 只有一条
 * pending；被拒 / 批准后状态离开 pending，可再申请（第一版不限流、不做冷却）。
 * ON DELETE CASCADE：项目 / 用户删除时申请行随之消失——申请是「想进这个项目」的
 * 意向，项目没了意向就没有落点（与 notifications 的「活过项目删除」相反：那是已发生
 * 的事实，这是未决的请求）。handled_by SET NULL：审批人删除后申请历史仍要能读，
 * 「当时是谁批的」在审批人账号删除后退化为未知，但不该让整行消失。
 */
CREATE TABLE IF NOT EXISTS access_requests (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  suggested_role TEXT CHECK (suggested_role IN ('project_admin', 'developer', 'viewer')),  -- NULL = 未带建议（边界 7）
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  handled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* 单 pending（边界 6）：只约束未决行，历史（approved / rejected）不参与——被拒后
   立即再申请要能落一条新的 pending。 */
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_pending_uniq
  ON access_requests (project_id, user_id) WHERE status = 'pending';

/* 管理员按项目查待审列表（`GET /projects/:id/access-requests`）：项目 + 状态 + 时间序。 */
CREATE INDEX IF NOT EXISTS access_requests_project_status_idx
  ON access_requests (project_id, status, created_at DESC);

/* 本人跨项目查自己的申请（`GET /access-requests/me`）：申请人 + 时间序。 */
CREATE INDEX IF NOT EXISTS access_requests_user_created_idx
  ON access_requests (user_id, created_at DESC);

/*
 * 站内信 kind 扩一个 'access_request'（P9-1 的 057 建表时是列级匿名 CHECK，PG 默认名
 * notifications_kind_check）：新申请 → 通知全体 project_admin（定向投递，见
 * lib/inbox.ts）；审批结果 → 通知申请人。drop + 重建，六值全集——DROP IF EXISTS 兜住
 * 「本地库约束名与默认名不一致」的可能（重命名过则先手动对齐）。
 */
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('member_change', 'plan_assign', 'alert', 'suite_result', 'ci_result', 'access_request'));
