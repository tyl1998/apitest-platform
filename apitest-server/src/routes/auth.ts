import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { mapUser } from "../models/types.js";
import { currentUser, verifyPassword } from "../lib/auth.js";
import { fail, success } from "../lib/response.js";

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email?: string; password?: string } }>("/api/v1/auth/login", async (request, reply) => {
    const result = await pool.query("SELECT id, email, name, password_hash, is_system_admin FROM users WHERE email = $1 AND status = 'active'", [request.body.email]);
    const user = result.rowCount ? mapUser(result.rows[0]) : undefined;
    if (!user || !request.body.password || !verifyPassword(request.body.password, user.passwordHash)) return fail(reply, 401, 1002, "invalid credentials");
    const token = await reply.jwtSign({ userId: user.id, email: user.email });
    return success({ token, user: { id: user.id, email: user.email, name: user.name, isSystemAdmin: user.isSystemAdmin } });
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const user = await currentUser(request, reply);
    return user && success({ id: user.id, email: user.email, name: user.name, isSystemAdmin: user.isSystemAdmin });
  });
}
