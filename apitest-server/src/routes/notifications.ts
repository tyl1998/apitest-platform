import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { currentUser } from "../lib/auth.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapUserNotification } from "../models/types.js";

/**
 * 站内通知（P9-1，计划 13.2 的通知四条）：跨项目、用户级——没有项目前缀，
 * `currentUser` 即守卫（登录就能读自己的收件箱，13.0 边界 9：收件人是人不是成员集合）。
 *
 * 未读数轮询 60s + 页面获焦即拉（边界 11——不做实时推送：通知不是聊天，60s 延迟
 * 无感；SSE 推送要把跨项目的用户级通道引进来，为一个计数不值）。
 */
export async function notificationRoutes(app: FastifyInstance) {
  /**
   * 我的通知（分页）。`unread=1` 只看未读；`read` 是筛选值不是排序列——排序恒
   * created_at DESC（最新的在顶，已读与否由行内标记表达）。
   */
  app.get<{ Querystring: { unread?: string; page?: string; pageSize?: string } }>("/api/v1/notifications", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [user.id];
    /* unread=1 只加 SQL 片段不加参数（node-pg 对参数个数严格：多给报
       「bind message supplies N … requires M」，stats.ts 的 pushParam 注释同款教训）。 */
    const where = `n.user_id = $1${request.query.unread === "1" ? " AND n.read_at IS NULL" : ""}`;
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM notifications n WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    /* projectName 是读时快照（项目删除后通知仍可读，mapUserNotification 的注释）。 */
    const result = await pool.query(
      `SELECT n.*, COALESCE(p.name, '') AS project_name
         FROM notifications n
         LEFT JOIN projects p ON p.id = n.project_id
        WHERE ${where}
        ORDER BY n.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return success(result.rows.map(mapUserNotification), { page, pageSize, total: Number(count.rows[0].total) });
  });

  /** 未读数（轮询端点）：一次 Index Only 扫部分索引（notifications_unread_idx）。 */
  app.get("/api/v1/notifications/unread-count", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    const result = await pool.query("SELECT COUNT(*)::int AS total FROM notifications WHERE user_id = $1 AND read_at IS NULL", [user.id]);
    return success({ count: Number(result.rows[0].total) });
  });

  /** 标已读：别人的通知行 404（行存在但 user_id 不匹配按不存在处理，不泄露存在性）。 */
  app.post<{ Params: { id: string } }>("/api/v1/notifications/:id/read", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (!isUuid(request.params.id)) return fail(reply, 404, 2001, "notification not found");
    const result = await pool.query(
      "UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING read_at",
      [request.params.id, user.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "notification not found");
    return success({ id: request.params.id, readAt: new Date(String(result.rows[0].read_at)).toISOString() });
  });

  /** 全部已读：只动自己的行；已读行不再碰（COALESCE 保持首次阅读时间）。 */
  app.post("/api/v1/notifications/read-all", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    const result = await pool.query(
      "UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE user_id = $1 AND read_at IS NULL",
      [user.id],
    );
    return success({ updated: result.rowCount ?? 0 });
  });
}
