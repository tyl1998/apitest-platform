import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { currentUser } from "../lib/auth.js";
import { AUDIT_ACTIONS, writeAuditLogAsync } from "../lib/audit.js";
import { deliverInboxToRole, deliverInboxToUser } from "../lib/inbox.js";
import { effectiveMcpScopes } from "../lib/mcpScopes.js";
import { myRoleInProject, requireProjectAccess, requireProjectAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapMcpBindingRequest, type McpScope } from "../models/types.js";

/**
 * MCP 绑定许可申请（2026-09-21 用户反馈，迁移 070；计划十七 P13 增补）。
 *
 * 项目 MCP 页的绑定表对成员是「干看着」：scope 上限由实时角色决定（viewer 只有
 * read），超出角色上限的档位在个人中心的绑定弹窗里是灰的。这条 REST 面给那条断层
 * 补一个申请通道，五条：
 *
 * - `POST /projects/:id/mcp/binding-requests`——成员提交（requireProjectAccess，成员
 *   即可申请；只接受 write / execute 且必须**超出**当前有效上限，否则 409）。
 * - `GET  /projects/:id/mcp/binding-requests`——project_admin 看本项目申请（待审 + 历史）。
 * - `GET  /me/mcp/binding-requests`——本人跨项目申请与状态（全局层，无项目前缀）。
 * - `POST /mcp/binding-requests/:id/approve`——批准。**批准行本身就是授权**：有效 scope
 *   是实时聚合（`lib/mcpScopes.ts`），不写第二张事实表、不改成员角色（用户 2026-09-21
 *   选定口径：单项目绑定许可，不动角色）。
 * - `POST /mcp/binding-requests/:id/reject`——拒绝只记状态（handled_by/at + 可选 note）。
 *
 * 两条无项目前缀的审批端点不能挂 `requireProjectAdmin`（它按 `:id = 项目` 取 context），
 * 改为先读申请行拿 project_id，再用 `myRoleInProject` 判「审批人在该项目是不是管理员」
 * ——与 `routes/accessRequests.ts` 同一条纪律（system_admin 短路或 project_admin）。
 *
 * 幂等与并发：同一 (project, user) 只允许一条 pending（partial unique index）；审批用
 * 带条件 UPDATE（`WHERE status = 'pending'`）原子消费，第二个管理员拿不到行回 409。
 */

/** 申请只能点这两档：read 是成员默认就有的（viewer 也可绑），不必申请。 */
const REQUESTABLE_SCOPES: readonly McpScope[] = ["write", "execute"];

/** 归一并校验申请 scope 入参：去重、保序、不认识的档位拒绝而不是静默丢弃。 */
function parseRequestedScopes(input: unknown): { scopes?: McpScope[]; error?: string } {
  if (!Array.isArray(input)) return { error: "scope must be an array of write / execute" };
  const scopes = [...new Set(input.map((each) => String(each ?? "").trim()).filter(Boolean))] as McpScope[];
  if (!scopes.length) return { error: "scope must name at least one of write / execute" };
  for (const scope of scopes) {
    if (!REQUESTABLE_SCOPES.includes(scope)) return { error: `scope "${scope}" is not one of write / execute` };
  }
  return { scopes: scopes.filter((scope) => REQUESTABLE_SCOPES.includes(scope)) };
}

/** 管理面读取投影：申请人身份 + 审批人邮箱快照 + 项目名（审批列表第一眼要看清谁在申请）。 */
const ADMIN_SELECT = `
  SELECT br.*, u.email AS applicant_email, u.name AS applicant_name, h.email AS handled_by_email, p.name AS project_name
    FROM mcp_binding_requests br
    JOIN users u ON u.id = br.user_id
    LEFT JOIN users h ON h.id = br.handled_by
    LEFT JOIN projects p ON p.id = br.project_id`;

export async function mcpBindingRequestRoutes(app: FastifyInstance) {
  /**
   * 提交申请（项目成员）。**只收超出有效上限的档位**：已经能绑的档位回 409，不是
   * 「重复提交」，而是「你要的东西已经在手上了」——把这类请求放进来只会让管理员批一条
   * 什么都不改变的单子。单 pending（partial unique index 兜并发）。
   */
  app.post<{ Params: { id: string }; Body: { scope?: unknown; note?: unknown } }>(
    "/api/v1/projects/:id/mcp/binding-requests",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply); if (!context) return;
      const parsed = parseRequestedScopes(request.body?.scope);
      if (parsed.error) return fail(reply, 400, 1001, parsed.error);

      /* 只落「角色拿不到」的那几档：管理员批的是一条窄门，不是把角色重写一遍。 */
      const effective = await effectiveMcpScopes(context.myRole, context.user.id, context.project.id);
      const needed = parsed.scopes!.filter((scope) => !effective.includes(scope));
      if (!needed.length) return fail(reply, 409, 2003, "you can already bind these scopes in this project");

      const pending = await pool.query(
        "SELECT 1 FROM mcp_binding_requests WHERE project_id = $1 AND user_id = $2 AND status = 'pending'",
        [context.project.id, context.user.id],
      );
      if (pending.rowCount) return fail(reply, 409, 2003, "you already have a pending request for this project");

      const note = typeof request.body?.note === "string" ? request.body.note.trim() : "";
      const id = randomUUID();
      try {
        await pool.query(
          "INSERT INTO mcp_binding_requests (id, project_id, user_id, scope, note) VALUES ($1, $2, $3, $4, $5)",
          [id, context.project.id, context.user.id, needed, note],
        );
      } catch (error) {
        /* partial unique index 的并发兜底：预检与插入之间另一个请求抢先落了 pending。 */
        if ((error as { code?: string }).code === "23505") return fail(reply, 409, 2003, "you already have a pending request for this project");
        throw error;
      }

      /* 定向投递：只通知能批的 project_admin，深链到项目 MCP 页（申请在那一页处理）。 */
      deliverInboxToRole({
        projectId: context.project.id,
        role: "project_admin",
        kind: "mcp_binding_request",
        title: `新的 MCP 绑定许可申请：${context.user.email}`,
        body: `申请档位：${needed.join(" / ")}`,
        link: `/projects/${context.project.id}/mcp`,
        excludeUserId: context.user.id,
      });

      const created = await pool.query(`${ADMIN_SELECT} WHERE br.id = $1`, [id]);
      return reply.code(201).send(success(mapMcpBindingRequest(created.rows[0])));
    },
  );

  /**
   * 本项目的申请列表（project_admin）。`status` 过滤可选；不给则全量。
   * 排序：pending 置顶（待办优先），再按时间倒序。
   */
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>("/api/v1/projects/:id/mcp/binding-requests", async (request, reply) => {
    const context = await requireProjectAdmin(request, reply); if (!context) return;
    const params: unknown[] = [context.project.id];
    const statusFilter = ["pending", "approved", "rejected"].includes(request.query.status ?? "")
      ? (params.push(request.query.status), ` AND br.status = $${params.length}`)
      : "";
    const result = await pool.query(
      `${ADMIN_SELECT}
        WHERE br.project_id = $1${statusFilter}
        ORDER BY CASE br.status WHEN 'pending' THEN 0 ELSE 1 END, br.created_at DESC`,
      params,
    );
    return success(result.rows.map(mapMcpBindingRequest), { total: result.rowCount });
  });

  /**
   * 本人跨项目的申请（全局层）。带 projectName 让人认得出向哪个项目申请；个人中心
   * 的绑定弹窗读它显示「审批中 / 已批准」态。
   */
  app.get("/api/v1/me/mcp/binding-requests", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    const result = await pool.query(
      `${ADMIN_SELECT}
        WHERE br.user_id = $1
        ORDER BY br.created_at DESC`,
      [user.id],
    );
    return success(result.rows.map(mapMcpBindingRequest), { total: result.rowCount });
  });

  /**
   * 批准（project_admin）。带条件 UPDATE 原子消费 pending；批准行即授权，下一档的
   * 绑定校验与 `/mcp` 闸门立刻放行（无缓存窗口——两个读侧都是实时查）。结果通知申请人。
   */
  app.post<{ Params: { id: string } }>("/api/v1/mcp/binding-requests/:id/approve", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (!isUuid(request.params.id)) return fail(reply, 404, 2001, "binding request not found");
    const found = await pool.query(`${ADMIN_SELECT} WHERE br.id = $1`, [request.params.id]);
    if (!found.rowCount) return fail(reply, 404, 2001, "binding request not found");
    const row = found.rows[0];
    const projectId = String(row.project_id);
    const applicantId = String(row.user_id);
    const email = row.applicant_email ? String(row.applicant_email) : applicantId;
    const scope = (row.scope as unknown[]).map(String);

    const role = await myRoleInProject(user, projectId);
    if (role !== "system_admin" && role !== "project_admin") return fail(reply, 403, 1003, "forbidden");
    if (String(row.status) !== "pending") return fail(reply, 409, 2003, "this request has already been handled");

    const consumed = await pool.query(
      "UPDATE mcp_binding_requests SET status = 'approved', handled_by = $2, handled_at = now() WHERE id = $1 AND status = 'pending' RETURNING id",
      [request.params.id, user.id],
    );
    if (!consumed.rowCount) return fail(reply, 409, 2003, "this request has already been handled");

    writeAuditLogAsync({
      action: AUDIT_ACTIONS.mcpBindingRequestApprove,
      targetType: "user",
      targetId: applicantId,
      projectId,
      userId: user.id,
      detail: { email, scope },
      ip: request.ip,
    });
    deliverInboxToUser({
      projectId,
      userId: applicantId,
      kind: "mcp_binding_request",
      title: "MCP 绑定许可已通过",
      body: `你可以在该项目把 Token 绑定到：${scope.join(" / ")}`,
      link: `/projects/${projectId}/mcp`,
    });

    const updated = await pool.query(`${ADMIN_SELECT} WHERE br.id = $1`, [request.params.id]);
    return success(mapMcpBindingRequest(updated.rows[0]));
  });

  /**
   * 拒绝（project_admin）。只记状态（handled_by/at + 可选 note），不产生授权——被拒后
   * 可再申请（第一版不限流）。结果通知申请人。
   */
  app.post<{ Params: { id: string }; Body: { note?: string } }>("/api/v1/mcp/binding-requests/:id/reject", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (!isUuid(request.params.id)) return fail(reply, 404, 2001, "binding request not found");
    const found = await pool.query(`${ADMIN_SELECT} WHERE br.id = $1`, [request.params.id]);
    if (!found.rowCount) return fail(reply, 404, 2001, "binding request not found");
    const row = found.rows[0];
    const projectId = String(row.project_id);
    const applicantId = String(row.user_id);
    const email = row.applicant_email ? String(row.applicant_email) : applicantId;

    const role = await myRoleInProject(user, projectId);
    if (role !== "system_admin" && role !== "project_admin") return fail(reply, 403, 1003, "forbidden");
    if (String(row.status) !== "pending") return fail(reply, 409, 2003, "this request has already been handled");

    const note = request.body?.note?.trim() ?? "";
    const consumed = await pool.query(
      "UPDATE mcp_binding_requests SET status = 'rejected', handled_by = $2, handled_at = now(), note = $3 WHERE id = $1 AND status = 'pending' RETURNING id",
      [request.params.id, user.id, note],
    );
    if (!consumed.rowCount) return fail(reply, 409, 2003, "this request has already been handled");

    writeAuditLogAsync({
      action: AUDIT_ACTIONS.mcpBindingRequestReject,
      targetType: "user",
      targetId: applicantId,
      projectId,
      userId: user.id,
      detail: note ? { email, note } : { email },
      ip: request.ip,
    });
    deliverInboxToUser({
      projectId,
      userId: applicantId,
      kind: "mcp_binding_request",
      title: "MCP 绑定许可未通过",
      body: note || "管理员未通过你的申请，可稍后重新申请",
      link: `/projects/${projectId}/mcp`,
    });

    const updated = await pool.query(`${ADMIN_SELECT} WHERE br.id = $1`, [request.params.id]);
    return success(mapMcpBindingRequest(updated.rows[0]));
  });
}
