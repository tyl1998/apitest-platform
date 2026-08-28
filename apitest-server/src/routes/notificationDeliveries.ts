import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapNotificationDelivery } from "../models/types.js";

/**
 * 派发证据（P3-6，边界 10）：只读列表，没有写路由——证据由投递路径自己落
 * （lib/notify.ts），可编辑的证据不是证据。
 *
 * 筛选维度对着排查路径来：「某条规则最近发了什么」（ruleId）、「这个渠道到底通
 * 不通」（channelId）、「那次失败到底告警了没有」（executionIndexId）。渠道/规则
 * 的名字靠 LEFT JOIN 快照——证据行要活过被引用方的删除（SET NULL），join 不中就
 * 显示不出名字，这正确：名字是可选项，行本身才是证据。
 */
export async function notificationDeliveryRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { ruleId?: string; channelId?: string; executionIndexId?: string; status?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/notification-deliveries", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["d.project_id = $1"];
    /* 坏的 uuid 过滤值直接丢掉而不是 400：列表页的筛选框是自由输入，一次误粘不该把
       整页打红（契约第 5 条：uuid 过滤值在进 SQL 前处理）。 */
    if (request.query.ruleId && isUuid(request.query.ruleId)) { params.push(request.query.ruleId); clauses.push(`d.rule_id = $${params.length}`); }
    if (request.query.channelId && isUuid(request.query.channelId)) { params.push(request.query.channelId); clauses.push(`d.channel_id = $${params.length}`); }
    if (request.query.executionIndexId && isUuid(request.query.executionIndexId)) { params.push(request.query.executionIndexId); clauses.push(`d.execution_index_id = $${params.length}`); }
    if (request.query.status === "sent" || request.query.status === "failed") { params.push(request.query.status); clauses.push(`d.status = $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM notification_deliveries d WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(
      `SELECT d.*, c.name AS channel_name, r.name AS rule_name
         FROM notification_deliveries d
         LEFT JOIN notification_channels c ON c.id = d.channel_id
         LEFT JOIN alert_rules r ON r.id = d.rule_id
        WHERE ${where}
        ORDER BY d.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return success(result.rows.map((row) => ({ ...mapNotificationDelivery(row), channelName: row.channel_name ? String(row.channel_name) : null, ruleName: row.rule_name ? String(row.rule_name) : null })), { page, pageSize, total: Number(count.rows[0].total) });
  });
}
