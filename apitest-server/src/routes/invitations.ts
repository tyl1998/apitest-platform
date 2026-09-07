import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { writeAuditLogAsync } from "../lib/audit.js";
import { issueInvitation } from "../lib/inviteAuth.js";
import { requireSystemAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapInvitation } from "../models/types.js";

/**
 * 邀请码的签发、列表与吊销（P6-3，计划 10.0 边界 1 的① / 10.2）。
 *
 * 系统管理员路由（`/system/invitations*`）。进人两条通道里的邀请码：签发 `apiinv_`
 * 一次性码（可预设「进哪个项目、什么角色」），受邀人开 `/register?invite=` 自设密码；
 * **链接带外传递**（企微/钉钉转给本人），平台不发邮件（边界 2：不引 SMTP）。
 *
 * 消费端（`POST /auth/register`）在 `routes/auth.ts`；本文件只回答「码怎么发、
 * 怎么收」。明文码只在签发那一次响应里出现——丢了只能吊销重发，与初始密码 /
 * Runner Token 同一条纪律。
 */

/** 邀请码默认 7 天过期（边界 3 的差异点，写死而不是入参——「更长的有效期」不是签发人当下要权衡的事）。 */
const EXPIRES_DAYS = 7;
const ROLE_VALUES = ["project_admin", "developer", "viewer"] as const;

/** 列表投影：列名写死而不是 `SELECT *`，`token_hash` 不进任何管理查询（规则 7 的邀请码版本）。 */
const INVITATION_COLUMNS = "id, note, project_id, role, token_prefix, created_by, expires_at, consumed_at, consumed_user_id, revoked_at, created_at";

/** 列表查询的同款列（带 `i.` 前缀，与 JOIN 里的别名对应）。INSERT/UPDATE 的
    RETURNING 必须用不带前缀的裸列——RETURNING 子句里没有表别名，`i.` 会被当成
    缺 FROM 条目（42P01，签发 500 的根因）。 */
const INVITATION_COLUMNS_ALIASED = INVITATION_COLUMNS.split(", ").map((column) => `i.${column}`).join(", ");

export async function invitationRoutes(app: FastifyInstance) {
  /**
   * 列表（全量，不分页——活跃邀请码的数量级是「本周加了几个人」，分页页码在这里
   * 是噪音；历史码留给审计日志筛 action）。排序：未消费/未吊销在前，同组按签发时间
   * 倒序——签发人要看的永远是「还有哪几张码在路上」。
   */
  app.get("/api/v1/system/invitations", async (request, reply) => {
    const admin = await requireSystemAdmin(request, reply); if (!admin) return;
    const result = await pool.query(
      `SELECT ${INVITATION_COLUMNS_ALIASED}, u.email AS created_by_email, c.email AS consumed_by_email
         FROM invitations i
         LEFT JOIN users u ON u.id = i.created_by
         LEFT JOIN users c ON c.id = i.consumed_user_id
        ORDER BY (i.consumed_at IS NOT NULL OR i.revoked_at IS NOT NULL), i.created_at DESC`,
    );
    return success(result.rows.map(mapInvitation), { total: result.rowCount });
  });

  /**
   * 签发：`note` 给签发人自己看（给谁/为什么）；`projectId` + `role` 预设注册后进
   * 哪个项目、什么角色（两者都可空 = 不预分配，注册后走成员管理）。**role 有值必须
   * 配 projectId**——没有项目却带着角色，注册时那行 `user_project_roles` 没地方写。
   */
  app.post<{ Body: { note?: string; projectId?: string; role?: string; expiresDays?: number } }>("/api/v1/system/invitations", async (request, reply) => {
    const admin = await requireSystemAdmin(request, reply); if (!admin) return;
    const note = request.body?.note?.trim() ?? "";
    const role = request.body?.role?.trim() || undefined;
    const projectId = request.body?.projectId?.trim() || undefined;
    if (role && !ROLE_VALUES.includes(role as (typeof ROLE_VALUES)[number])) {
      return fail(reply, 400, 1001, "role must be project_admin, developer or viewer");
    }
    if (projectId && !isUuid(projectId)) return fail(reply, 400, 1001, "projectId must be a UUID");
    if (role && !projectId) return fail(reply, 400, 1001, "role requires projectId — a role row needs somewhere to live");

    /* 预分配的项目必须真实存在，否则注册时插 user_project_roles 会被 FK 拒——
       那个 500 落在**受邀人**的注册请求上，离签发人已经隔了一次带外传递。 */
    if (projectId) {
      const project = await pool.query("SELECT id FROM projects WHERE id = $1", [projectId]);
      if (!project.rowCount) return fail(reply, 404, 2001, "project not found");
    }

    const issued = issueInvitation();
    const id = randomUUID();
    const result = await pool.query(
      `INSERT INTO invitations (id, token_hash, token_prefix, note, project_id, role, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' days')::interval)
       RETURNING ${INVITATION_COLUMNS}`,
      [id, issued.hash, issued.prefix, note, projectId ?? null, role ?? null, admin.id, String(EXPIRES_DAYS)],
    );
    writeAuditLogAsync({
      action: "invite.create",
      targetType: "invitation",
      targetId: id,
      userId: admin.id,
      /* detail 只有 note 与预分配证据——明文码连日志都不进（audit.ts 文件头纪律）。 */
      detail: { note, projectId, role },
      ip: request.ip,
    });
    return reply.code(201).send(success({ ...mapInvitation(result.rows[0]), token: issued.plaintext }));
  });

  /** 吊销：软删（留 `revoked_at`）。候选查询按部分索引排除吊销行，即时生效（验收 5：吊销的码注册得明确报错）。 */
  app.post<{ Params: { invitationId: string } }>("/api/v1/system/invitations/:invitationId/revoke", async (request, reply) => {
    const admin = await requireSystemAdmin(request, reply); if (!admin) return;
    if (!isUuid(request.params.invitationId)) return fail(reply, 404, 2001, "invitation not found");
    const result = await pool.query(
      `UPDATE invitations SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1
        RETURNING ${INVITATION_COLUMNS}`,
      [request.params.invitationId],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "invitation not found");
    writeAuditLogAsync({
      action: "invite.revoke",
      targetType: "invitation",
      targetId: request.params.invitationId,
      userId: admin.id,
      detail: { note: String(result.rows[0].note) },
      ip: request.ip,
    });
    return success(mapInvitation(result.rows[0]));
  });
}
