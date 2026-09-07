import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { writeAuditLogAsync } from "../lib/audit.js";
import { hashPassword } from "../lib/auth.js";
import { requireProjectAdmin, requireSystemAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapAuditLog, mapManagedUser } from "../models/types.js";

/**
 * 用户管理与审计日志读（P6-2，计划 10.2 / 10.0 边界 1 / 9 / 11）。
 *
 * 全部系统管理员路由（`/system/*`）。本批落地的是**管理员建号通道**（边界 1 的②）：
 * 初始密码当场生成、只在响应里出现一次（照 `RepoCredentials` / Runner Token 的明文
 * 只出现一次纪律），并置 `must_change_password` 强制首登改密。邀请码通道（①）在
 * P6-3 ——`invitations` 表 051 已就位，这里不动它。
 *
 * **只做禁用、不做删除**（边界 9）：`projects.owner_id` 是全库唯一没写 ON DELETE 的
 * users 外键，硬删先被 FK 挡；执行历史与审计的归因都要活过被引用方。禁用即时生效
 * ——`currentUser` 每请求查库，判定端 P0 起就在。
 *
 * 审计动作（边界 10）落在 `lib/audit.ts` 的 `AUDIT_ACTIONS`：user.create /
 * user.disable / user.enable / user.reset_password；detail 只放 email 与角色证据，
 * **密码明文绝不进**（audit.ts 文件头的纪律）。
 */

/**
 * 初始密码：18 字节 base64url ≈ 24 字符，与 webhook secret / mock public_id 同款。
 * 不做复杂度规则——平台自己出的随机串不可能是弱密码，规则只会拦住人。
 */
const PASSWORD_BYTES = 18;

function generateInitialPassword(): string {
  return randomBytes(PASSWORD_BYTES).toString("base64url");
}

/** 管理面行投影：列写死而不是 `SELECT *`，哈希列不进任何管理查询。 */
const USER_COLUMNS = "id, email, name, is_system_admin, status, must_change_password, last_login_at, created_at, updated_at";

/**
 * 不能把自己禁用 / 撤自己的系统管理员旗：做了之后**没有任何恢复路径**（唯一的管理员
 * 被自己锁在门外，dev 库只能手写 SQL）。这不是礼节提示，是 409 ——「防止平台无人能管」
 * 与验收门槛 8（最后一个 project_admin 不能被移除）同一条纪律的用户面版本。
 */
function guardsSelfModifications(adminId: string, userId: string, kind: "disable" | "demote"): boolean {
  return adminId === userId && kind === "disable";
}

/** 系统里是否还有**其他**启用的系统管理员（最后一个管理员的第二道闸）。 */
async function otherActiveAdmins(excludeUserId: string): Promise<number> {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS total FROM users WHERE is_system_admin AND status = 'active' AND id <> $1",
    [excludeUserId],
  );
  return Number(result.rows[0].total);
}

export async function systemUserRoutes(app: FastifyInstance) {
  /**
   * 用户列表（keyword 过滤在 SQL，覆盖全量而不是当前页——与项目列表同一契约）。
   * 按 created_at 倒序：最新的账号（多半还没改初始密码）在最上面。
   */
  app.get<{ Querystring: { keyword?: string; page?: string; pageSize?: string } }>("/api/v1/system/users", async (request, reply) => {
    const admin = await requireSystemAdmin(request, reply); if (!admin) return;
    const params: unknown[] = [];
    const clauses: string[] = [];
    const keyword = request.query?.keyword?.trim();
    if (keyword) {
      params.push(`%${keyword}%`);
      clauses.push(`(email ILIKE $${params.length} OR name ILIKE $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = await pool.query(`SELECT COUNT(*)::int AS total FROM users ${where}`, params);
    const page = Math.max(1, Number(request.query?.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query?.pageSize ?? 20)));
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(
      `SELECT ${USER_COLUMNS} FROM users ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return success(result.rows.map(mapManagedUser), { page, pageSize, total: Number(total.rows[0].total) });
  });

  /**
   * 建号（边界 1 的②）：初始密码服务端生成、只在本次响应出现一次，`must_change_password`
   * 置 true（P6-3 的强制改密页消费）。email 唯一冲突回 409 + 资源级 code（server-contract
   * 对 1002 漂移的告诫），前端据此提示「已存在」。
   */
  app.post<{ Body: { email?: string; name?: string; isSystemAdmin?: boolean } }>("/api/v1/system/users", async (request, reply) => {
    const admin = await requireSystemAdmin(request, reply); if (!admin) return;
    const email = request.body?.email?.trim().toLowerCase();
    const name = request.body?.name?.trim();
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) return fail(reply, 400, 1001, "a valid email is required");
    if (!name) return fail(reply, 400, 1001, "name is required");
    const isSystemAdmin = Boolean(request.body?.isSystemAdmin);
    const password = generateInitialPassword();
    const id = randomUUID();
    const result = await pool.query(
      `INSERT INTO users (id, email, name, password_hash, is_system_admin, must_change_password)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING ${USER_COLUMNS}`,
      [id, email, name, hashPassword(password), isSystemAdmin],
    ).catch((error: { code?: string }) => {
      /* 23505 = unique_violation。不重试：同名账号就是不该建第二次。 */
      if (error.code === "23505") return { rowCount: 0, rows: [], conflict: true as const };
      throw error;
    });
    if (!result.rowCount) return fail(reply, 409, 2003, "email already exists");
    writeAuditLogAsync({
      action: "user.create",
      targetType: "user",
      targetId: id,
      userId: admin.id,
      detail: { email, isSystemAdmin },
      ip: request.ip,
    });
    return reply.code(201).send(success({ ...mapManagedUser(result.rows[0]), initialPassword: password }));
  });

  /**
   * PATCH（name / status / isSystemAdmin，partial——只验出现的键）。禁用即时生效：
   * `currentUser` 每请求查库，没有缓存窗口（验收门槛 4）。detail 里带前后值，审计
   * 才能回答「谁在什么时候把谁怎么了」（门槛 9）。
   */
  app.patch<{ Params: { userId: string }; Body: { name?: string; status?: string; isSystemAdmin?: boolean } }>("/api/v1/system/users/:userId", async (request, reply) => {
    const admin = await requireSystemAdmin(request, reply); if (!admin) return;
    if (!isUuid(request.params.userId)) return fail(reply, 404, 2001, "user not found");
    const body = request.body ?? {};
    if (body.name !== undefined && !String(body.name).trim()) return fail(reply, 400, 1001, "name cannot be empty");
    if (body.status !== undefined && !["active", "disabled"].includes(body.status)) {
      return fail(reply, 400, 1001, "status must be active or disabled");
    }

    /* 只有一处会读到这两列做判定，先取全行（含 status / is_system_admin 的当前值）。 */
    const current = await pool.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [request.params.userId],
    );
    if (!current.rowCount) return fail(reply, 404, 2001, "user not found");
    const before = mapManagedUser(current.rows[0]);

    /* 两个自锁闸：把自己禁掉；把自己（最后一个管理员）的旗摘掉。 */
    if (body.status === "disabled" && guardsSelfModifications(admin.id, request.params.userId, "disable")) {
      return fail(reply, 409, 2003, "cannot disable your own account");
    }
    if (body.isSystemAdmin === false && admin.id === request.params.userId) {
      return fail(reply, 409, 2003, "cannot remove your own system admin role");
    }
    if (body.isSystemAdmin === false && before.isSystemAdmin && before.status === "active") {
      if (!await otherActiveAdmins(request.params.userId)) {
        return fail(reply, 409, 2003, "cannot demote the last active system admin");
      }
    }

    const result = await pool.query(
      `UPDATE users SET
         name = COALESCE($1, name),
         status = COALESCE($2, status),
         is_system_admin = COALESCE($3, is_system_admin),
         updated_at = now()
       WHERE id = $4
       RETURNING ${USER_COLUMNS}`,
      [
        body.name !== undefined ? body.name.trim() : null,
        body.status ?? null,
        body.isSystemAdmin !== undefined ? body.isSystemAdmin : null,
        request.params.userId,
      ],
    );
    const after = mapManagedUser(result.rows[0]);

    /* 禁用/启用与升降管理员旗各写一行（audit action 是枚举不是自由文本，读侧筛选靠它）。 */
    if (body.status !== undefined && body.status !== before.status) {
      writeAuditLogAsync({
        action: body.status === "disabled" ? "user.disable" : "user.enable",
        targetType: "user",
        targetId: request.params.userId,
        userId: admin.id,
        detail: { email: before.email, from: before.status, to: body.status },
        ip: request.ip,
      });
    }
    if (body.isSystemAdmin !== undefined && body.isSystemAdmin !== before.isSystemAdmin) {
      writeAuditLogAsync({
        action: "user.update_role",
        targetType: "user",
        targetId: request.params.userId,
        userId: admin.id,
        detail: { email: before.email, from: before.isSystemAdmin ? "system_admin" : "member", to: body.isSystemAdmin ? "system_admin" : "member" },
        ip: request.ip,
      });
    }
    return success(after);
  });

  /**
   * 重置密码（计划 10.2）：新密码只在本次响应出现一次 + `must_change_password` 强制
   * 下次登录改密。**P6-5 起同步自增 `pwd_epoch`**——被重置用户手里的全部旧 token 立即
   * 401（重置本身就是「旧凭据作废」，连他自己的会话一起杀才符合语义）；管理员自己的
   * token 不受影响。P6-2 时「不动 pwd_epoch」的临时取舍就此收口。
   */
  app.post<{ Params: { userId: string } }>("/api/v1/system/users/:userId/reset-password", async (request, reply) => {
    const admin = await requireSystemAdmin(request, reply); if (!admin) return;
    if (!isUuid(request.params.userId)) return fail(reply, 404, 2001, "user not found");
    const password = generateInitialPassword();
    const result = await pool.query(
      `UPDATE users SET password_hash = $1, must_change_password = TRUE, pwd_epoch = pwd_epoch + 1, updated_at = now()
       WHERE id = $2
       RETURNING ${USER_COLUMNS}`,
      [hashPassword(password), request.params.userId],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "user not found");
    writeAuditLogAsync({
      action: "user.reset_password",
      targetType: "user",
      targetId: request.params.userId,
      userId: admin.id,
      detail: { email: mapManagedUser(result.rows[0]).email },
      ip: request.ip,
    });
    return success({ ...mapManagedUser(result.rows[0]), initialPassword: password });
  });

  /**
   * 全局审计日志（计划 10.2 / 边界 11）：分页 + action / project 筛选，系统管理员。
   * `includeSystem` 缺省排除系统级行（project_id IS NULL）？不——缺省**全部**给出，
   * `project` 筛选才是收窄手段；「系统级动作藏在缺省视图外」违反「审计可读」的初衷。
   */
  app.get<{ Querystring: { page?: string; pageSize?: string; action?: string; projectId?: string } }>("/api/v1/system/audit-logs", async (request, reply) => {
    const admin = await requireSystemAdmin(request, reply); if (!admin) return;
    /* 与 dashboard 的动态过滤同一纪律：值压 params 数组，占位符序号现场算。 */
    const params: unknown[] = [];
    const clauses: string[] = [];
    const action = request.query?.action?.trim();
    if (action) {
      params.push(action);
      clauses.push(`a.action = $${params.length}`);
    }
    /* 非法 uuid 在 cast 前丢掉而不是 500（规则 5）；但「给了但非法」过滤成空集更诚实，
       所以显式回 400，与 endpoints 的 environmentId 筛选同款。 */
    const projectId = request.query?.projectId?.trim();
    if (projectId) {
      if (!isUuid(projectId)) return fail(reply, 400, 1001, "projectId must be a UUID");
      params.push(projectId);
      clauses.push(`a.project_id = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = await pool.query(`SELECT COUNT(*)::int AS total FROM audit_logs a ${where}`, params);
    const page = Math.max(1, Number(request.query?.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query?.pageSize ?? 20)));
    params.push(pageSize, (page - 1) * pageSize);
    /* LEFT JOIN 用户：user_id 可空（调度器 / Webhook 触发源），行必须留下来；
       email 做快照展示——用户被禁用/改名后审计仍要读得出「当时是谁」。 */
    const result = await pool.query(
      `SELECT a.id, a.project_id, a.user_id, a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at,
              u.email AS user_email, p.name AS project_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN projects p ON p.id = a.project_id
         ${where}
         ORDER BY a.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return success(result.rows.map(mapAuditLog), { page, pageSize, total: Number(total.rows[0].total) });
  });

  /**
   * 项目级审计（计划 10.2：`requireProjectAdmin`，最近 50 条，无分页）：给 P6-4 的
   * 成员页与项目设置页读「这个项目里谁做了什么」。系统管理员在这里也过
   * `requireProjectAdmin`（守卫里短路放行），口径与成员管理一致。
   */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/audit-logs", async (request, reply) => {
    const context = await requireProjectAdmin(request, reply); if (!context) return;
    const result = await pool.query(
      `SELECT a.id, a.project_id, a.user_id, a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at,
              u.email AS user_email, p.name AS project_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN projects p ON p.id = a.project_id
        WHERE a.project_id = $1
        ORDER BY a.created_at DESC
        LIMIT 50`,
      [context.project.id],
    );
    return success(result.rows.map(mapAuditLog), { total: result.rowCount });
  });
}
