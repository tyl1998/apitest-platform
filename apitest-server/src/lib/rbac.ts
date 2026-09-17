import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { mapProject, type Project, type User, type Role, type MyRole } from "../models/types.js";
import { currentUser } from "./auth.js";
import { fail } from "./response.js";

/**
 * The user's effective role for one project (P6 边界 5).
 *
 * `system_admin` short-circuits without touching `user_project_roles` — an admin
 * is an admin everywhere, and the per-request cost of re-discovering that is a
 * query nobody needs. This is also the single lookup both guards share, so the
 * role row is read once per request instead of once per check.
 */
export async function myRoleInProject(user: User, projectId: string): Promise<MyRole | undefined> {
  if (user.isSystemAdmin) return "system_admin";
  const result = await pool.query("SELECT role FROM user_project_roles WHERE project_id = $1 AND user_id = $2", [projectId, user.id]);
  return (result.rows[0]?.role as Role | undefined) ?? undefined;
}

/* 兼作类型收窄：判真即角色非空（undefined 一律判假），requireProjectAccess 的
   返回类型因此不必再断言。 */
function roleAllows(role: MyRole | undefined, write: boolean): role is MyRole {
  if (role === "system_admin" || role === "project_admin" || role === "developer") return true;
  return role === "viewer" && !write;
}

/**
 * Signature and verdicts unchanged (P6 边界 4: 80+ call sites, zero regression) —
 * the MCP write path re-runs this per call (mcpAuth 边界 2: a token is a key,
 * not a permission snapshot), so behavior drift here changes what a stale token
 * can do.
 */
export async function canAccess(user: User, projectId: string, write = false) {
  return roleAllows(await myRoleInProject(user, projectId), write);
}

async function loadProjectContext(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<{ user: User; project: Project } | undefined> {
  const user = await currentUser(request, reply);
  if (!user) return undefined;
  const result = await pool.query("SELECT * FROM projects WHERE id = $1", [request.params.id]);
  if (!result.rowCount) { fail(reply, 404, 2001, "project not found"); return undefined; }
  return { user, project: mapProject(result.rows[0]) };
}

export async function requireProjectAccess(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, write = false): Promise<{ user: User; project: Project; myRole: MyRole } | undefined> {
  const context = await loadProjectContext(request, reply);
  if (!context) return undefined;
  const myRole = await myRoleInProject(context.user, context.project.id);
  if (!roleAllows(myRole, write)) { fail(reply, 403, 1003, "forbidden"); return undefined; }
  return { ...context, myRole };
}

/**
 * P6 边界 4: `project_admin` 与 `developer` 真正分开后的项目管理员守卫。
 *
 * 系统管理员短路；否则角色行必须是 `project_admin`。只挂三类路由——成员管理、
 * 项目设置写、项目删除；资源 CRUD（接口/用例/流程/套件）developer 照旧可写，
 * 那不是「管人、管项目级配置」。
 */
export async function requireProjectAdmin(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<{ user: User; project: Project } | undefined> {
  const context = await loadProjectContext(request, reply);
  if (!context) return undefined;
  const myRole = await myRoleInProject(context.user, context.project.id);
  if (myRole !== "system_admin" && myRole !== "project_admin") { fail(reply, 403, 1003, "forbidden"); return undefined; }
  return context;
}

/**
 * Guards platform-wide resources, which belong to no project.
 *
 * Project membership cannot express "the whole installation", so anything that
 * exposes infrastructure — the execution workers, the queue — is admin only.
 */
export async function requireSystemAdmin(request: FastifyRequest, reply: FastifyReply): Promise<User | undefined> {
  const user = await currentUser(request, reply);
  if (!user) return undefined;
  if (!user.isSystemAdmin) { fail(reply, 403, 1003, "forbidden"); return undefined; }
  return user;
}

/**
 * P11-10 边界 7: reads that `viewer` must not make, though it may read the
 * project itself. Verdict-wise this is `requireProjectAccess(…, true)` (any
 * non-viewer role passes), but naming it "developer" keeps the route honest:
 * a read that writes nothing is not asking for write access, it is asking for
 * a role the project decided is trusted with more than listings.
 *
 * First (and currently only) caller: the project audit read. Audit rows carry
 * emails and IPs — the column-level ownership emails are public to every
 * member, but the audit trail is one layer more private, so it does not share
 * the "read = viewer included" verdict.
 */
export async function requireDeveloper(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const context = await requireProjectAccess(request, reply);
  if (!context) return undefined;
  if (context.myRole === "viewer") { fail(reply, 403, 1003, "forbidden"); return undefined; }
  return context;
}
