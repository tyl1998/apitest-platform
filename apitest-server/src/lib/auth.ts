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
  /* status 进投影：mapUser 现在读它，靠 WHERE 隐式保证会在缺列时静默读成 active。 */
  const result = await pool.query("SELECT id, email, name, password_hash, is_system_admin, status, pwd_epoch FROM users WHERE id = $1 AND status = 'active'", [request.user.userId]);
  if (!result.rowCount) { fail(reply, 401, 1002, "unauthenticated"); return undefined; }
  /* P6-5 pwdEpoch：改密 / 管理员重置会把库里的值 +1，旧 token 里嵌的还是老值——不等即
     401，全部旧 token 失效不需要黑名单表。缺 claim 的 token 是 P6-5 之前签的，按 0 对齐
     （pwd_epoch 列缺省也是 0），部署不强制存量会话全员重登。 */
  if (Number(result.rows[0].pwd_epoch) !== (request.user.pwdEpoch ?? 0)) {
    fail(reply, 401, 1002, "unauthenticated"); return undefined;
  }
  return mapUser(result.rows[0]);
}

/**
 * 会话 token 签名单点（P6-5）：payload 带 `pwdEpoch`（currentUser 的失效比对值），
 * 过期由注册 @fastify/jwt 时的全局 `sign.expiresIn`（JWT_EXPIRES_IN，默认 7d）控制。
 * `expiresAt` 直接从签出来的 token 解 `exp`——不自己再解析一遍时长字符串，两处来源
 * 迟早漂移。
 */
export async function signSessionToken(reply: FastifyReply, payload: { userId: string; email: string; pwdEpoch: number }) {
  const token = await reply.jwtSign(payload);
  const decoded = reply.server.jwt.decode<{ exp?: number }>(token);
  return { token, expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null };
}

export function registerAuthTypes(app: FastifyInstance) {
  void app;
}
