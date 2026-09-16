import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { writeAuditLogAsync } from "../lib/audit.js";
import { deliverInbox } from "../lib/inbox.js";
import { requireProjectAccess, requireProjectAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapMemberCandidate, mapProjectMember, type Role } from "../models/types.js";

/**
 * 项目成员 CRUD（P6-4，计划 10.2 / 10.3）。
 *
 * 读走 `requireProjectAccess`（viewer 可看——「知道找谁要权限」是成员表的产品理由，
 * 边界 5）；写全挂 `requireProjectAdmin`（边界 4 的第三类路由，P6-1 预留的挂点）。
 * 审计动作 member.upsert / member.remove（边界 10）：target = 被改的那个人，detail
 * 只放 email 与前后角色——与 user.* 同一形状，密码之外的敏感面本来就不在这条路上。
 *
 * 「最后一个 project_admin」闸（验收门槛 8）：降级（PATCH / POST 改角色）与移除
 * （DELETE）都会先数一遍**其他人**里的 project_admin，数到 0 就 409。这里没有照
 * `auth.ts` 注册路由的带条件 UPDATE 做原子消费——那是公开流量的并发窗口，成员管理
 * 是管理员低频操作，先读后写与 systemUsers 的 PATCH 同款姿态；两个管理员同时互降
 * 的 TOCTOU 留给「谁先提交谁赢」，不为它上 SERIALIZABLE。
 */

const ROLES: Role[] = ["project_admin", "developer", "viewer"];

function parseRole(input: unknown): Role | undefined {
  return ROLES.includes(input as Role) ? input as Role : undefined;
}

/** 目标之外还有没有别的 project_admin（最后管理员闸的读数）。 */
async function otherProjectAdmins(projectId: string, userId: string): Promise<number> {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS total FROM user_project_roles WHERE project_id = $1 AND role = 'project_admin' AND user_id <> $2",
    [projectId, userId],
  );
  return Number(result.rows[0].total);
}

export async function memberRoutes(app: FastifyInstance) {
  /**
   * 成员表：读时 JOIN users 拿 email/name/status 快照——用户改名后成员表跟着新名走
   * （成员是当下的事实，不是历史；与 executions 的 name 快照相反）。排序按角色层级
   * 再按 email，成员页的第一眼是「谁在管这个项目」。
   */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/members", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const result = await pool.query(
      `SELECT r.user_id, r.role, r.granted_by, r.granted_at,
              u.email, u.name, u.status,
              g.email AS granted_by_email
         FROM user_project_roles r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN users g ON g.id = r.granted_by
        WHERE r.project_id = $1
        ORDER BY CASE r.role WHEN 'project_admin' THEN 0 WHEN 'developer' THEN 1 ELSE 2 END, u.email`,
      [context.project.id],
    );
    return success(result.rows.map(mapProjectMember), { total: result.rowCount });
  });

  /**
   * 添加成员的候选搜索（计划 10.3「搜索平台用户 → 选角色」）：给 project_admin 一个
   * **收窄的用户目录读**。`/system/users` 是全量管理面（must_change_password 之类），
   * 挂 requireSystemAdmin；这里只回 id/email/name 三列、只回 active、只回非成员，
   * 上限 20——选择器要的是「能搜到人」，不是「能翻通讯录」。
   */
  app.get<{ Params: { id: string }; Querystring: { keyword?: string } }>("/api/v1/projects/:id/members/candidates", async (request, reply) => {
    const context = await requireProjectAdmin(request, reply); if (!context) return;
    const keyword = request.query?.keyword?.trim();
    const params: unknown[] = [context.project.id];
    const keywordClause = keyword
      ? (params.push(`%${keyword}%`), `AND (u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`)
      : "";
    const result = await pool.query(
      `SELECT u.id, u.email, u.name
         FROM users u
        WHERE u.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM user_project_roles r WHERE r.project_id = $1 AND r.user_id = u.id)
          ${keywordClause}
        ORDER BY u.created_at DESC
        LIMIT 20`,
      params,
    );
    return success(result.rows.map(mapMemberCandidate), { total: result.rowCount });
  });

  /**
   * 添加成员 / 就地改角色的 upsert 语义（审计动作叫 member.upsert 的原因）：同一张码
   * 加两次不该 409，后一次的角色生效。目标必须是真实用户（404）；角色必须是三级之一
   * （400）。降级同样过最后管理员闸——POST 把唯一的 project_admin 改成 viewer 与
   * PATCH 做这件事是同一个事故。
   */
  app.post<{ Params: { id: string }; Body: { userId?: string; role?: string } }>("/api/v1/projects/:id/members", async (request, reply) => {
    const context = await requireProjectAdmin(request, reply); if (!context) return;
    const userId = request.body?.userId;
    if (!isUuid(userId)) return fail(reply, 400, 1001, "a valid userId is required");
    const role = parseRole(request.body?.role);
    if (!role) return fail(reply, 400, 1001, "role must be project_admin, developer or viewer");

    const target = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
    if (!target.rowCount) return fail(reply, 404, 2001, "user not found");
    const email = String(target.rows[0].email);

    const existing = await pool.query(
      "SELECT role FROM user_project_roles WHERE project_id = $1 AND user_id = $2",
      [context.project.id, userId],
    );
    const before = existing.rows[0]?.role as Role | undefined;
    /* 降级闸只对「本来就是 project_admin 且要交出这个角色」的人生效。 */
    if (before === "project_admin" && role !== "project_admin" && !await otherProjectAdmins(context.project.id, userId)) {
      return fail(reply, 409, 2003, "cannot demote the last project admin");
    }

    await pool.query(
      `INSERT INTO user_project_roles (project_id, user_id, role, granted_by, granted_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at`,
      [context.project.id, userId, role, context.user.id],
    );
    writeAuditLogAsync({
      action: "member.upsert",
      targetType: "user",
      targetId: userId,
      projectId: context.project.id,
      userId: context.user.id,
      detail: before ? { email, from: before, to: role } : { email, to: role },
      ip: request.ip,
    });
    const member = await pool.query(
      `SELECT r.user_id, r.role, r.granted_by, r.granted_at, u.email, u.name, u.status, g.email AS granted_by_email
         FROM user_project_roles r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN users g ON g.id = r.granted_by
        WHERE r.project_id = $1 AND r.user_id = $2`,
      [context.project.id, userId],
    );
    /* P9-1 站内通知（member_change 新源）：成员变更是全体成员该知道的事——
       新加入的人自己也收到（收件人含本人，「你被加进了这个项目」正是他要的信息）。 */
    deliverInbox({
      projectId: context.project.id,
      kind: "member_change",
      title: before ? `成员角色变更：${email} → ${role}` : `新成员加入：${email}`,
      body: before ? `由 ${context.user.email} 变更` : `由 ${context.user.email} 添加`,
      link: `/projects/${context.project.id}/members`,
    });
    /* 新加入回 201；upsert 落在已有成员上是一次更新，200（envelope 契约：201 只给 create）。 */
    const response = success(mapProjectMember(member.rows[0]));
    return before ? response : reply.code(201).send(response);
  });

  /** 改角色：成员页角色下拉就地改的落点。非成员 404，最后管理员降级 409。 */
  app.patch<{ Params: { id: string; userId: string }; Body: { role?: string } }>("/api/v1/projects/:id/members/:userId", async (request, reply) => {
    const context = await requireProjectAdmin(request, reply); if (!context) return;
    if (!isUuid(request.params.userId)) return fail(reply, 404, 2001, "member not found");
    const role = parseRole(request.body?.role);
    if (!role) return fail(reply, 400, 1001, "role must be project_admin, developer or viewer");

    const existing = await pool.query(
      `SELECT r.role, u.email
         FROM user_project_roles r JOIN users u ON u.id = r.user_id
        WHERE r.project_id = $1 AND r.user_id = $2`,
      [context.project.id, request.params.userId],
    );
    if (!existing.rowCount) return fail(reply, 404, 2001, "member not found");
    const before = String(existing.rows[0].role) as Role;
    const email = String(existing.rows[0].email);
    if (before === role) return success({ userId: request.params.userId, role });

    if (before === "project_admin" && role !== "project_admin" && !await otherProjectAdmins(context.project.id, request.params.userId)) {
      return fail(reply, 409, 2003, "cannot demote the last project admin");
    }
    await pool.query(
      "UPDATE user_project_roles SET role = $3, granted_by = $4, granted_at = now() WHERE project_id = $1 AND user_id = $2",
      [context.project.id, request.params.userId, role, context.user.id],
    );
    writeAuditLogAsync({
      action: "member.upsert",
      targetType: "user",
      targetId: request.params.userId,
      projectId: context.project.id,
      userId: context.user.id,
      detail: { email, from: before, to: role },
      ip: request.ip,
    });
    /* P9-1 站内通知：改角色与加人同一动作（member.upsert），文案区分前后角色。 */
    deliverInbox({
      projectId: context.project.id,
      kind: "member_change",
      title: `成员角色变更：${email} → ${role}`,
      body: `由 ${context.user.email} 变更`,
      link: `/projects/${context.project.id}/members`,
    });
    return success({ userId: request.params.userId, role });
  });

  /** 移除成员：角色行删除即失去访问（判定端每请求查库，即时生效）。最后管理员 409。 */
  app.delete<{ Params: { id: string; userId: string } }>("/api/v1/projects/:id/members/:userId", async (request, reply) => {
    const context = await requireProjectAdmin(request, reply); if (!context) return;
    if (!isUuid(request.params.userId)) return fail(reply, 404, 2001, "member not found");

    const existing = await pool.query(
      `SELECT r.role, u.email
         FROM user_project_roles r JOIN users u ON u.id = r.user_id
        WHERE r.project_id = $1 AND r.user_id = $2`,
      [context.project.id, request.params.userId],
    );
    if (!existing.rowCount) return fail(reply, 404, 2001, "member not found");
    const role = String(existing.rows[0].role);
    const email = String(existing.rows[0].email);
    if (role === "project_admin" && !await otherProjectAdmins(context.project.id, request.params.userId)) {
      return fail(reply, 409, 2003, "cannot remove the last project admin");
    }

    await pool.query("DELETE FROM user_project_roles WHERE project_id = $1 AND user_id = $2", [context.project.id, request.params.userId]);
    writeAuditLogAsync({
      action: "member.remove",
      targetType: "user",
      targetId: request.params.userId,
      projectId: context.project.id,
      userId: context.user.id,
      detail: { email, role },
      ip: request.ip,
    });
    /* P9-1 站内通知：移除不给被移除的人发（excludeUserId——他下次请求就 403，
       一条打不开的深链只会制造困惑），其余成员照常收到。 */
    deliverInbox({
      projectId: context.project.id,
      kind: "member_change",
      title: `成员被移除：${email}`,
      body: `由 ${context.user.email} 移除`,
      link: `/projects/${context.project.id}/members`,
      excludeUserId: request.params.userId,
    });
    return success({ userId: request.params.userId, removed: true });
  });
}
