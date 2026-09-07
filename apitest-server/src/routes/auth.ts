import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { mapUser } from "../models/types.js";
import { currentUser, hashPassword, signSessionToken, verifyPassword } from "../lib/auth.js";
import { writeAuditLogAsync } from "../lib/audit.js";
import { findLiveInvitation, invitationPrefix } from "../lib/inviteAuth.js";
import { fail, success } from "../lib/response.js";

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email?: string; password?: string } }>("/api/v1/auth/login", async (request, reply) => {
    /* status 进投影（同 lib/auth.ts）：mapUser 读它。登录本身已按 status='active' 过滤。
       must_change_password / pwd_epoch 并进同一条 SELECT（P6-5 起签 token 要带 epoch，
       不再值得为旗单独发一次查询）。 */
    const result = await pool.query("SELECT id, email, name, password_hash, is_system_admin, status, must_change_password, pwd_epoch FROM users WHERE email = $1 AND status = 'active'", [request.body.email]);
    const user = result.rowCount ? mapUser(result.rows[0]) : undefined;
    if (!user || !request.body.password || !verifyPassword(request.body.password, user.passwordHash)) return fail(reply, 401, 1002, "invalid credentials");
    /* last_login_at 在这里写（fire-and-forget，登录路径不该被一次记录写失败拦住）。 */
    void pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]).catch(() => {});
    const session = await signSessionToken(reply, { userId: user.id, email: user.email, pwdEpoch: Number(result.rows[0].pwd_epoch) });
    return success({ token: session.token, expiresAt: session.expiresAt, user: { id: user.id, email: user.email, name: user.name, isSystemAdmin: user.isSystemAdmin }, mustChangePassword: Boolean(result.rows[0].must_change_password) });
  });

  /**
   * `/auth/me`（P6-3 起带 `mustChangePassword`）：刷新页面后 PasswordGate 仍要工作，
   * 而登录响应里的旗活不过一次刷新——读时从库里来（改密端点同请求清掉它，无缓存窗口）。
   */
  app.get("/api/v1/auth/me", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    const flags = await pool.query("SELECT must_change_password FROM users WHERE id = $1", [user.id]);
    return success({ id: user.id, email: user.email, name: user.name, isSystemAdmin: user.isSystemAdmin, mustChangePassword: Boolean(flags.rows[0]?.must_change_password) });
  });

  /**
   * 邀请码注册（P6-3，计划 10.2 的公开路由；边界 1 的①）。
   *
   * `{invite, email, name, password}`。计划 10.2 的 body 清单只写了
   * `{invite, name, password}`，但 `users.email NOT NULL UNIQUE` 且登录按 email
   * 找行——没有 email 的账号登录不了，所以 email 必须由注册人自报。**邮箱归属由
   * 签发人目视判断**（边界 2：内网平台不预填邮箱验证）：签发人把码带外发给本人，
   * 本人来填自己的邮箱；填了别人的邮箱也过不了登录（密码在填的人手里），冲突时
   * 409 而不是枚举既有账号。
   *
   * 消费走**事务 + 带条件的 UPDATE**（`WHERE consumed_at IS NULL`）：两条并发注册
   * 同一张码，只有一个 UPDATE 命中，另一个回 409——单次使用不是读后判，是数据库
   * 层面的原子事实（验收 5）。
   *
   * 过期/吊销/无效分别给不同的 message（不是 500）：注册页要能告诉用户「这张码
   * 过期了，找签发人重发」还是「码不对」。
   */
  app.post<{ Body: { invite?: string; email?: string; name?: string; password?: string } }>("/api/v1/auth/register", async (request, reply) => {
    const invite = request.body?.invite?.trim();
    const email = request.body?.email?.trim().toLowerCase();
    const name = request.body?.name?.trim();
    const password = request.body?.password ?? "";
    if (!invite) return fail(reply, 400, 1001, "invite code is required");
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) return fail(reply, 400, 1001, "a valid email is required");
    if (!name) return fail(reply, 400, 1001, "name is required");
    if (password.length < 8) return fail(reply, 400, 1001, "password must be at least 8 characters");

    /* 三个前置失败（无效/吊销/过期）都要在开事务之前给出带原因的报错。吊销与无效
       对用户的指引不同（找签发人重发 vs 检查粘贴），所以吊销单独看一眼。 */
    const live = await findLiveInvitation(invite);
    if (!live) {
      /* 吊销与无效对用户的指引不同（找签发人重发 vs 检查粘贴）：吊销行被候选查询
         排除后在这里单独看一眼，按同一个前缀取（前缀是签发时写死的辨认段）。 */
      const prefix = invitationPrefix(invite);
      const revoked = prefix
        ? await pool.query("SELECT 1 FROM invitations WHERE token_prefix = $1 AND revoked_at IS NOT NULL", [prefix])
        : { rowCount: 0 };
      return fail(reply, revoked.rowCount ? 403 : 401, revoked.rowCount ? 1003 : 1002, revoked.rowCount ? "invite code revoked" : "invalid invite code");
    }
    if (new Date(String(live.expires_at)).getTime() <= Date.now()) {
      return fail(reply, 410, 1002, "invite code expired");
    }
    const projectId = live.project_id ? String(live.project_id) : null;
    const role = (live.role as string | null) ?? null;

    const userId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      /* 先建用户、再消费码（同事务，原子性不变）：`consumed_user_id` 有 FK 指向
         users——UPDATE 那一刻用户行必须已经存在，顺序反了就是 FK 拒（23503）。
         任一步失败都整体回滚，单次使用语义不受影响。 */
      const inserted = await client.query(
        "INSERT INTO users (id, email, name, password_hash, is_system_admin) VALUES ($1, $2, $3, $4, FALSE) RETURNING id, email, name",
        [userId, email, name, hashPassword(password)],
      ).catch((error: { code?: string }) => {
        /* 23505 = unique_violation：email 已有账号。回滚事务后由外层统一回 409。 */
        if (error.code === "23505") return { rowCount: 0, rows: [] as Record<string, unknown>[], conflict: true as const };
        throw error;
      });
      if (!inserted.rowCount) {
        await client.query("ROLLBACK");
        return fail(reply, 409, 2003, "email already registered");
      }
      /* 原子消费：条件 UPDATE 命中 0 行 = 码已被并发注册用掉，整体回滚。 */
      const consumed = await client.query(
        "UPDATE invitations SET consumed_at = now(), consumed_user_id = $2 WHERE id = $1 AND consumed_at IS NULL RETURNING id",
        [String(live.id), userId],
      );
      if (!consumed.rowCount) {
        await client.query("ROLLBACK");
        return fail(reply, 409, 2003, "invite code already used");
      }
      /* 预分配角色（计划 10.1）：仅当码带 projectId 才写角色行；granted_by 落签发人
         （`created_by`）——「谁把谁加进来的」从注册这一刻就有证据行。 */
      if (projectId && role) {
        await client.query(
          "INSERT INTO user_project_roles (project_id, user_id, role, granted_by) VALUES ($1, $2, $3, $4)",
          [projectId, userId, role, live.created_by ? String(live.created_by) : null],
        );
      }
      await client.query("COMMIT");
      writeAuditLogAsync({
        action: "invite.consume",
        targetType: "invitation",
        targetId: String(live.id),
        projectId,
        userId,
        detail: { email, role },
        ip: request.ip,
      });
      /* 注册即登录（不制造「注册完再登一次」的空转）；token 与登录同款（P6-5 起带
         pwdEpoch——新用户的列缺省是 0，密码是注册人自己刚设的，epoch 必然为 0）。 */
      const session = await signSessionToken(reply, { userId, email, pwdEpoch: 0 });
      return reply.code(201).send(success({ token: session.token, expiresAt: session.expiresAt, user: { id: userId, email, name, isSystemAdmin: false } }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * 修改自己的密码（P6-3 强制改密的提交端）：登录用户，验证旧密码，写新哈希并清
   * `must_change_password`。
   *
   * **P6-5 起自增 `pwd_epoch`**——改密后全部旧 token（含改密前签给本会话的那枚）立即
   * 401，同响应换发带新 epoch 的 token：当前会话凭它无缝续命，其他浏览器 / 设备上的
   * 旧会话全部下线（验收门槛 6「改密后旧 token 全部失效」）。P6-3 时「不动 pwd_epoch」
   * 的临时取舍就此收口。
   */
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>("/api/v1/auth/change-password", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    const current = request.body?.currentPassword ?? "";
    const next = request.body?.newPassword ?? "";
    if (next.length < 8) return fail(reply, 400, 1001, "new password must be at least 8 characters");
    const stored = await pool.query("SELECT password_hash FROM users WHERE id = $1", [user.id]);
    if (!stored.rowCount || !verifyPassword(current, String(stored.rows[0].password_hash))) {
      return fail(reply, 400, 1001, "current password is incorrect");
    }
    if (current === next) return fail(reply, 400, 1001, "new password must differ from the current one");
    const result = await pool.query(
      "UPDATE users SET password_hash = $1, must_change_password = FALSE, pwd_epoch = pwd_epoch + 1, updated_at = now() WHERE id = $2 RETURNING pwd_epoch",
      [hashPassword(next), user.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "user not found");
    const session = await signSessionToken(reply, { userId: user.id, email: user.email, pwdEpoch: Number(result.rows[0].pwd_epoch) });
    return success({ token: session.token, expiresAt: session.expiresAt, user: { id: user.id, email: user.email, name: user.name, isSystemAdmin: user.isSystemAdmin }, mustChangePassword: false });
  });
}
