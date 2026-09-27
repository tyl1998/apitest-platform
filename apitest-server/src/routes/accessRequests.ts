import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { currentUser } from "../lib/auth.js";
import { writeAuditLogAsync } from "../lib/audit.js";
import { deliverInbox, deliverInboxToRole, deliverInboxToUser } from "../lib/inbox.js";
import { myRoleInProject, requireProjectAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapAccessRequest, type Role } from "../models/types.js";

/**
 * 权限申请审批流（P14-2，计划 20，14.7 转正；P16-1 扩展成员提权）。
 *
 * 自助申请的闭环，五条 REST：
 * - `POST /projects/:id/access-requests`——提交申请（**不走 requireProjectAccess**：
 *   那会把非成员 403 挡在门外，而申请正是非成员/低角色要做的事，用 currentUser 守卫）。
 *   两种形态：**加入申请**（非成员，suggestedRole 可空）与**提权申请**（P16-1，成员
 *   申请严格更高的角色，必带目标角色，from_role 落申请时的角色快照）。
 * - `GET  /projects/:id/access-requests`——project_admin 看本项目的申请（待审 + 历史）。
 * - `GET  /access-requests/me`——本人跨项目的申请与状态（全局层，无项目前缀）。
 * - `POST /access-requests/:id/approve`——**批准 = 既有成员 upsert**（边界 3：不写第二条
 *   加成员路径，granted_by 落审批人、member.upsert 审计照旧，member_change 通知照旧；
 *   提权批准即改角色，通知文案区分「新成员加入」与「角色变更」）。
 * - `POST /access-requests/:id/reject`——拒绝只记状态（handled_by/at）。
 *
 * 两条无项目前缀的审批端点（approve / reject）不能挂 requireProjectAdmin（它按
 * `:id = 项目` 取 context），改为先读申请行拿到 project_id，再用 myRoleInProject 判
 * 「审批人在该项目是不是管理员」——与 requireProjectAdmin 同一判定（system_admin 短路
 * 或 project_admin），只是把关对象从 URL 参数换成申请行指向的项目。
 *
 * 幂等与并发（边界 6）：同一 (project, user) 只允许一条 pending（partial unique
 * index）；审批用带条件 UPDATE（`WHERE status = 'pending'`）原子消费——两个管理员
 * 同时批同一条，第二个拿不到行，回 409 而不是重复 upsert / 覆盖状态。
 */

const ROLES: Role[] = ["project_admin", "developer", "viewer"];

function parseRole(input: unknown): Role | undefined {
  return ROLES.includes(input as Role) ? input as Role : undefined;
}

/** 角色序（P16-1）：提权申请只认「严格高于当前角色」。system_admin 是运行时最高级，
 *  任何目标都不比它高，提权口子对它天然关闭（无需单独特判）。 */
const ROLE_RANK: Record<Role | "system_admin", number> = { viewer: 1, developer: 2, project_admin: 3, system_admin: 4 };

/** 管理面读取投影：申请人身份 + 审批人邮箱快照（审批列表第一眼要看清谁在申请、谁批的）。 */
const ADMIN_SELECT = `
  SELECT ar.*, u.email AS applicant_email, u.name AS applicant_name, h.email AS handled_by_email, p.name AS project_name
    FROM access_requests ar
    JOIN users u ON u.id = ar.user_id
    LEFT JOIN users h ON h.id = ar.handled_by
    LEFT JOIN projects p ON p.id = ar.project_id`;

export async function accessRequestRoutes(app: FastifyInstance) {
  /**
   * 提交申请。两种形态（P16-1 放开提权后）：
   * - **加入申请**（非成员）：suggestedRole 可空（边界 7），from_role 落 NULL。
   * - **提权申请**（成员，P16-1）：必带目标角色且必须**严格高于**当前角色；未给目标 /
   *   同级 / 降级一律 409（你已经有这权限，没有可申请的）。入口在成员页自己那行。
   * 用 currentUser 守卫——申请正是非成员/低角色要做的事，requireProjectAccess 会先把
   * 他 403 掉。system_admin（全项目成员、角色最高）两种形态都进不来：无目标走「已可
   * 进入」409，带目标走「已拥有」409（ROLE_RANK 自然挡掉，无需单独特判）。
   * 单 pending（边界 6）：已有 pending 回 409；partial unique index 是并发兜底
   * （唯一冲突 23505 也归 409）。
   */
  app.post<{ Params: { id: string }; Body: { suggestedRole?: string } }>("/api/v1/projects/:id/access-requests", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (!isUuid(request.params.id)) return fail(reply, 404, 2001, "project not found");
    const project = await pool.query("SELECT id FROM projects WHERE id = $1", [request.params.id]);
    if (!project.rowCount) return fail(reply, 404, 2001, "project not found");
    const projectId = String(project.rows[0].id);

    /* suggestedRole 可空（未带建议）；给了就必须是三级之一。 */
    let suggestedRole: Role | null = null;
    if (request.body?.suggestedRole !== undefined && request.body.suggestedRole !== null) {
      const parsed = parseRole(request.body.suggestedRole);
      if (!parsed) return fail(reply, 400, 1001, "suggestedRole must be project_admin, developer or viewer");
      suggestedRole = parsed;
    }

    /* 已是成员只有「提权」可申请（P16-1）：未给目标 → 仍是「你已经进得来」409；
       目标不高于当前角色 → 「你已经有这权限」409。 */
    const currentRole = await myRoleInProject(user, projectId);
    if (currentRole) {
      if (!suggestedRole) return fail(reply, 409, 2003, "you already have access to this project");
      if (ROLE_RANK[suggestedRole] <= ROLE_RANK[currentRole]) {
        return fail(reply, 409, 2003, `you already have ${currentRole} or higher`);
      }
    }

    /* 单 pending 预检（边界 6）：给个干净的 409，不靠唯一冲突的报错文案。 */
    const pending = await pool.query(
      "SELECT 1 FROM access_requests WHERE project_id = $1 AND user_id = $2 AND status = 'pending'",
      [projectId, user.id],
    );
    if (pending.rowCount) return fail(reply, 409, 2003, "you already have a pending request for this project");

    /* from_role 快照（迁移 075）：提权申请记下申请提交时的角色——历史读当时事实，
       不读时 JOIN 当前角色（批准后角色已变，JOIN 会说谎）。 */
    const fromRole: Role | null = currentRole === "system_admin" ? null : (currentRole as Role | null);
    const id = randomUUID();
    try {
      await pool.query(
        "INSERT INTO access_requests (id, project_id, user_id, suggested_role, from_role) VALUES ($1, $2, $3, $4, $5)",
        [id, projectId, user.id, suggestedRole, fromRole],
      );
    } catch (error) {
      /* partial unique index 的并发兜底：预检与插入之间另一个请求抢先落了 pending。 */
      if ((error as { code?: string }).code === "23505") return fail(reply, 409, 2003, "you already have a pending request for this project");
      throw error;
    }

    /* 定向投递（边界 5）：新申请只通知能放人进来的 project_admin，深链到成员页的申请
       tab。提权申请文案带「从什么角色提」，与加入申请一眼区分。申请人是非成员/低角色，
       不会是该项目管理员，excludeUserId 从简不传。 */
    deliverInboxToRole({
      projectId,
      role: "project_admin",
      kind: "access_request",
      title: fromRole ? `新的提权申请：${user.email}` : `新的权限申请：${user.email}`,
      body: fromRole
        ? `${fromRole} → ${suggestedRole}`
        : (suggestedRole ? `申请角色：${suggestedRole}` : "未指定建议角色"),
      link: `/projects/${projectId}/members?tab=requests`,
    });

    const created = await pool.query(`${ADMIN_SELECT} WHERE ar.id = $1`, [id]);
    return reply.code(201).send(success(mapAccessRequest(created.rows[0])));
  });

  /**
   * 本项目的申请列表（project_admin）。`status` 过滤可选（pending / approved / rejected）；
   * 不给则全量。排序：pending 置顶（待办优先），再按时间倒序。
   */
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>("/api/v1/projects/:id/access-requests", async (request, reply) => {
    const context = await requireProjectAdmin(request, reply); if (!context) return;
    const params: unknown[] = [context.project.id];
    /* status 过滤只加 SQL 片段（合法值才加参数，node-pg 参数个数严格；非法值一律忽略）。 */
    const statusFilter = ["pending", "approved", "rejected"].includes(request.query.status ?? "")
      ? (params.push(request.query.status), ` AND ar.status = $${params.length}`)
      : "";
    const result = await pool.query(
      `${ADMIN_SELECT}
        WHERE ar.project_id = $1${statusFilter}
        ORDER BY CASE ar.status WHEN 'pending' THEN 0 ELSE 1 END, ar.created_at DESC`,
      params,
    );
    return success(result.rows.map(mapAccessRequest), { total: result.rowCount });
  });

  /**
   * 本人跨项目的申请（全局层）。带 projectName 让人认得出向哪个项目申请；深链让批准/
   * 拒绝通知里点回来能看到状态。排序按时间倒序（最近提交的在顶）。
   */
  app.get("/api/v1/access-requests/me", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    const result = await pool.query(
      `${ADMIN_SELECT}
        WHERE ar.user_id = $1
        ORDER BY ar.created_at DESC`,
      [user.id],
    );
    return success(result.rows.map(mapAccessRequest), { total: result.rowCount });
  });

  /**
   * 批准（project_admin）。**= 既有成员 upsert**（边界 3）：最终角色可在批准时改定
   * （body.role），未给则用申请的 suggestedRole；两者都无则 400（管理员必须定个角色）。
   * 加入申请与提权申请（P16-1）同一条路径——提权批准即改角色（ON CONFLICT DO UPDATE），
   * granted_by 落审批人，member.upsert 审计照旧（验收门槛 4），member_change 通知文案
   * 按 from_role 区分「新成员加入」与「角色变更」。带条件 UPDATE 原子消费 pending
   * （并发下第二个批准者拿不到行 → 409）。
   */
  app.post<{ Params: { id: string }; Body: { role?: string } }>("/api/v1/access-requests/:id/approve", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (!isUuid(request.params.id)) return fail(reply, 404, 2001, "access request not found");
    const found = await pool.query(`${ADMIN_SELECT} WHERE ar.id = $1`, [request.params.id]);
    if (!found.rowCount) return fail(reply, 404, 2001, "access request not found");
    const row = found.rows[0];
    const projectId = String(row.project_id);
    const applicantId = String(row.user_id);
    const email = row.applicant_email ? String(row.applicant_email) : applicantId;

    /* 无项目前缀的端点自行把关：审批人必须是该项目管理员（system_admin 短路）。 */
    const role = await myRoleInProject(user, projectId);
    if (role !== "system_admin" && role !== "project_admin") return fail(reply, 403, 1003, "forbidden");

    /* 最终角色：body 显式改定优先，否则用申请建议；都没有 → 400（不擅自默认 developer）。 */
    const grantRole = parseRole(request.body?.role) ?? (row.suggested_role ? String(row.suggested_role) as Role : undefined);
    if (!grantRole) return fail(reply, 400, 1001, "role is required (the request carried no suggested role)");

    if (String(row.status) !== "pending") return fail(reply, 409, 2003, "this request has already been handled");

    /* 原子消费：只有仍是 pending 才落审批（并发下第二个批准者 rowCount = 0）。 */
    const consumed = await pool.query(
      "UPDATE access_requests SET status = 'approved', handled_by = $2, handled_at = now() WHERE id = $1 AND status = 'pending' RETURNING id",
      [request.params.id, user.id],
    );
    if (!consumed.rowCount) return fail(reply, 409, 2003, "this request has already been handled");

    /* 成员 upsert（与 routes/members.ts 同一路径）：granted_by = 审批人。 */
    await pool.query(
      `INSERT INTO user_project_roles (project_id, user_id, role, granted_by, granted_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at`,
      [projectId, applicantId, grantRole, user.id],
    );
    /* member.upsert 审计（边界 3：与人工添加同形状），detail 记走的是审批通道。 */
    writeAuditLogAsync({
      action: "member.upsert",
      targetType: "user",
      targetId: applicantId,
      projectId,
      userId: user.id,
      detail: { email, to: grantRole, via: "access_request" },
      ip: request.ip,
    });
    /* member_change 全体扇出（与人工添加同一通知源）：提权批准是「角色变更」不是
       「新成员加入」，文案按申请时的 from_role 快照区分。 */
    const fromRole = row.from_role ? String(row.from_role) : null;
    deliverInbox({
      projectId,
      kind: "member_change",
      title: fromRole ? `成员角色变更：${email}` : `新成员加入：${email}`,
      body: fromRole
        ? `由 ${user.email} 通过提权申请批准：${fromRole} → ${grantRole}`
        : `由 ${user.email} 通过权限申请批准`,
      link: `/projects/${projectId}/members`,
    });
    /* 结果通知申请人（access_request 源）：深链到本人的「我的申请」tab。 */
    deliverInboxToUser({
      projectId,
      userId: applicantId,
      kind: "access_request",
      title: "权限申请已通过",
      body: `你已获得该项目的 ${grantRole} 角色`,
      link: `/projects/${projectId}/trends`,
    });

    const updated = await pool.query(`${ADMIN_SELECT} WHERE ar.id = $1`, [request.params.id]);
    return success(mapAccessRequest(updated.rows[0]));
  });

  /**
   * 拒绝（project_admin）。只记状态（handled_by/at + 可选 note），不碰成员表——被拒后
   * 可再申请（边界 6，第一版不限流）。带条件 UPDATE 原子消费 pending。结果通知申请人。
   */
  app.post<{ Params: { id: string }; Body: { note?: string } }>("/api/v1/access-requests/:id/reject", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (!isUuid(request.params.id)) return fail(reply, 404, 2001, "access request not found");
    const found = await pool.query(`${ADMIN_SELECT} WHERE ar.id = $1`, [request.params.id]);
    if (!found.rowCount) return fail(reply, 404, 2001, "access request not found");
    const row = found.rows[0];
    const projectId = String(row.project_id);
    const applicantId = String(row.user_id);

    const role = await myRoleInProject(user, projectId);
    if (role !== "system_admin" && role !== "project_admin") return fail(reply, 403, 1003, "forbidden");

    if (String(row.status) !== "pending") return fail(reply, 409, 2003, "this request has already been handled");
    const note = request.body?.note?.trim() ?? "";
    const consumed = await pool.query(
      "UPDATE access_requests SET status = 'rejected', handled_by = $2, handled_at = now(), note = $3 WHERE id = $1 AND status = 'pending' RETURNING id",
      [request.params.id, user.id, note],
    );
    if (!consumed.rowCount) return fail(reply, 409, 2003, "this request has already been handled");

    writeAuditLogAsync({
      action: "access_request.reject",
      targetType: "user",
      targetId: applicantId,
      projectId,
      userId: user.id,
      detail: note ? { note } : {},
      ip: request.ip,
    });
    deliverInboxToUser({
      projectId,
      userId: applicantId,
      kind: "access_request",
      title: "权限申请未通过",
      body: note || "管理员未通过你的申请，可稍后重新申请",
      link: `/projects/${projectId}/trends`,
    });

    const updated = await pool.query(`${ADMIN_SELECT} WHERE ar.id = $1`, [request.params.id]);
    return success(mapAccessRequest(updated.rows[0]));
  });
}
