import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { fail } from "./response.js";
import { mapUser, type User } from "../models/types.js";

export function hashPassword(password: string) {
  const salt = randomUUID();
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string) {
  const [salt, digest] = stored.split(":");
  if (!salt || !digest) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function seedAdmin() {
  await pool.query(
    "INSERT INTO users (id, email, name, password_hash, is_system_admin) VALUES ($1, $2, $3, $4, TRUE) ON CONFLICT (email) DO NOTHING",
    ["00000000-0000-4000-8000-000000000001", "admin@local.test", "Platform Admin", hashPassword("admin123")],
  );
}

export async function currentUser(request: FastifyRequest, reply: FastifyReply): Promise<User | undefined> {
  try { await request.jwtVerify(); } catch { fail(reply, 401, 1002, "unauthenticated"); return undefined; }
  const result = await pool.query("SELECT id, email, name, password_hash, is_system_admin FROM users WHERE id = $1 AND status = 'active'", [request.user.userId]);
  if (!result.rowCount) { fail(reply, 401, 1002, "unauthenticated"); return undefined; }
  return mapUser(result.rows[0]);
}

export function registerAuthTypes(app: FastifyInstance) {
  void app;
}
