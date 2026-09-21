/*
 * MCP 绑定许可申请（2026-09-21 用户反馈，P13-1 评审第三项）。
 *
 * 项目 MCP 页的绑定表在成员视角下是「干看着」：scope 的上限由**实时角色**决定
 * （`routes/me.ts` 的 ROLE_MAX_SCOPE，viewer 只有 read），成员在自己角色拿不到的
 * 档位（write / execute）上只能看着灰掉的勾选框。本表给这条断层补一个申请通道：
 * 成员向项目申请「允许我在本项目把 Token 绑到这些档位」，project_admin 审批通过后，
 * 申请里点到的档位进入该成员在本项目的**有效 scope 集**（= 角色上限 ∪ 已批准申请），
 * 绑定时校验与 `/mcp` 调用的第 5 道闸门都读这一份并集——不是改角色，是给这个项目
 * 这一档写权限开一道窄门（用户选定的口径：单项目绑定许可，不动成员角色）。
 *
 * 形状照 `access_requests`（069）：pending 唯一、审批原子消费、handled_by SET NULL
 * （审批人删号后申请历史仍要能读）。差别只在「批准落什么」——那边落成员 upsert，
 * 这边不写第二张表：**批准行本身就是授权**，有效 scope 是实时聚合出来的，所以撤销
 * 授权只需再走一次替换（后续如需要，改状态即可，不改事实表）。
 *
 * ON DELETE CASCADE（项目 / 用户）：申请是「想在这个项目多拿一档权限」的意向，
 * 项目或人没了，意向没有落点。
 */
CREATE TABLE IF NOT EXISTS mcp_binding_requests (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /* 申请点到的档位；read 不在申请范围（viewer 本就有），校验在写入侧（非空且只含
     write / execute）。TEXT[] 而不是三列 boolean：将来加第四档不改表形状。 */
  scope TEXT[] NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  handled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* 单 pending：同一 (项目, 成员) 只有一条未决申请；被拒 / 批准后状态离开 pending，
   可再申请（第一版不限流、不设冷却——与 access_requests 同口径）。 */
CREATE UNIQUE INDEX IF NOT EXISTS mcp_binding_requests_pending_uniq
  ON mcp_binding_requests (project_id, user_id) WHERE status = 'pending';

/* 管理端按项目查待审列表（`GET /projects/:id/mcp/binding-requests`）。 */
CREATE INDEX IF NOT EXISTS mcp_binding_requests_project_status_idx
  ON mcp_binding_requests (project_id, status, created_at DESC);

/* 本人跨项目查自己的申请（`GET /me/mcp/binding-requests`）+ 有效 scope 聚合
   （按 (user, project, status) 取已批准行）。 */
CREATE INDEX IF NOT EXISTS mcp_binding_requests_user_project_idx
  ON mcp_binding_requests (user_id, project_id, status);

/*
 * 站内信 kind 扩一个 'mcp_binding_request'（069 建的是列级匿名 CHECK，PG 默认名
 * notifications_kind_check）：新申请 → 定向投递 project_admin；审批结果 → 通知申请人。
 * drop + 重建，七值全集——DROP IF EXISTS 兜住「本地库约束名与默认名不一致」的可能。
 */
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('member_change', 'plan_assign', 'alert', 'suite_result', 'ci_result', 'access_request', 'mcp_binding_request'));
