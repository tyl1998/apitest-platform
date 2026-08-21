import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { mapProject, type Project, type User, type Role } from "../models/types.js";
import { currentUser } from "./auth.js";
import { fail } from "./response.js";

export async function canAccess(user: User, projectId: string, write = false) {
  if (user.isSystemAdmin) return true;
  const result = await pool.query("SELECT role FROM user_project_roles WHERE project_id = $1 AND user_id = $2", [projectId, user.id]);
  const role = result.rows[0]?.role as Role | undefined;
  return Boolean(role && (!write || role !== "viewer"));
}

export async function requireProjectAccess(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, write = false): Promise<{ user: User; project: Project } | undefined> {
  const user = await currentUser(request, reply);
  if (!user) return undefined;
  const result = await pool.query("SELECT * FROM projects WHERE id = $1", [request.params.id]);
  if (!result.rowCount) { fail(reply, 404, 2001, "project not found"); return undefined; }
  const project = mapProject(result.rows[0]);
  if (!await canAccess(user, project.id, write)) { fail(reply, 403, 1003, "forbidden"); return undefined; }
  return { user, project };
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
