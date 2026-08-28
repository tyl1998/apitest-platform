import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapAlertRule, type AlertComparator, type AlertMetric } from "../models/types.js";

/**
 * 告警规则（P3-6，计划 6.2，边界 9）。这里只管配置；评估在调度器进程的事件订阅里
 * （P3-4/5 的 lib/alerts.ts），冷却写回也发生在那里。校验按指标约束阈值与窗口：
 * 事件型（execution_failed）没有窗口，窗口型必须带；阈值的量纲（百分比 / 毫秒 /
 * 次数）写进 031 的注释与错误信息，配置页照着显示。
 */

const METRICS: AlertMetric[] = ["execution_failed", "consecutive_failures", "success_rate", "avg_duration"];
const COMPARATORS: AlertComparator[] = ["gt", "gte", "lt", "lte"];
/** 事件型指标：失败事件一到就评估，无窗口。 */
const EVENT_METRICS: AlertMetric[] = ["execution_failed"];
const DEFAULT_COOLDOWN_SECONDS = 600;

type RuleBody = {
  name?: string;
  metric?: string;
  comparator?: string;
  threshold?: number;
  windowMinutes?: number | null;
  cooldownSeconds?: number;
  channelIds?: string[];
  enabled?: boolean;
};

/** 校验一份规则；partial=true 只查出现的键。channelIds 单独校验（要查库）。 */
function validateRule(body: RuleBody, partial: boolean): string | undefined {
  const name = body.name?.trim();
  if (!partial || body.name !== undefined) if (!name) return "rule name is required";
  const metric = body.metric as AlertMetric | undefined;
  if (!partial || body.metric !== undefined) {
    if (!metric || !METRICS.includes(metric)) return `metric must be one of ${METRICS.join(", ")}`;
  }
  const comparator = body.comparator as AlertComparator | undefined;
  if (!partial || body.comparator !== undefined) {
    if (!comparator || !COMPARATORS.includes(comparator)) return `comparator must be one of ${COMPARATORS.join(", ")}`;
  }
  if (!partial || body.threshold !== undefined) {
    const threshold = Number(body.threshold);
    if (!Number.isFinite(threshold)) return "threshold must be a number";
    /* 量纲按指标：success_rate 是 0–100 的百分比（0.5 会被当成 0.5%——按错位配置
       直接拒绝），其余是正数（毫秒 / 次数没有负值）。 */
    if (metric === "success_rate") {
      if (threshold < 0 || threshold > 100) return "threshold for success_rate is a percentage between 0 and 100";
    } else if (threshold <= 0) return "threshold must be positive";
  }
  if (body.windowMinutes !== undefined && body.windowMinutes !== null) {
    const minutes = Number(body.windowMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return "windowMinutes must be an integer between 1 and 1440";
    if (metric !== undefined && EVENT_METRICS.includes(metric)) return "execution_failed is evaluated per event and takes no windowMinutes";
  } else if (!partial && metric !== undefined && !EVENT_METRICS.includes(metric)) {
    return "windowMinutes is required for window metrics";
  }
  if (body.cooldownSeconds !== undefined) {
    const cooldown = Number(body.cooldownSeconds);
    if (!Number.isInteger(cooldown) || cooldown < 10 || cooldown > 86_400) return "cooldownSeconds must be an integer between 10 and 86400";
  }
  if (body.channelIds !== undefined) {
    if (!Array.isArray(body.channelIds) || !body.channelIds.length) return "channelIds must be a non-empty array";
    for (const id of body.channelIds) if (!isUuid(String(id))) return "each channelId must be a UUID";
  }
  return undefined;
}

/** channel_ids 无外键（UUID[]），归属在这里挡：别的项目的渠道 id 混进来，告警会静默
    发到别人的 webhook 上。 */
async function channelsBelong(projectId: string, channelIds: string[]): Promise<boolean> {
  const found = await pool.query("SELECT COUNT(*)::int AS total FROM notification_channels WHERE id = ANY($1::uuid[]) AND project_id = $2", [channelIds, projectId]);
  return Number(found.rows[0].total) === channelIds.length;
}

export async function alertRuleRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/alert-rules", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const result = await pool.query("SELECT * FROM alert_rules WHERE project_id = $1 ORDER BY created_at DESC", [context.project.id]);
    return success(result.rows.map(mapAlertRule), { total: result.rowCount });
  });

  app.post<{ Params: { id: string }; Body: RuleBody }>("/api/v1/projects/:id/alert-rules", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const invalid = validateRule(request.body ?? {}, false);
    if (invalid) return fail(reply, 400, 1001, invalid);
    const body = request.body!;
    if (!await channelsBelong(context.project.id, body.channelIds!)) {
      return fail(reply, 400, 1001, "channelIds must reference notification channels in this project");
    }
    const result = await pool.query(
      `INSERT INTO alert_rules (id, project_id, name, metric, comparator, threshold, window_minutes, cooldown_seconds, channel_ids, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [randomUUID(), context.project.id, body.name!.trim(), body.metric!, body.comparator!, Number(body.threshold!), body.windowMinutes ?? null, body.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS, body.channelIds!, body.enabled ?? true],
    );
    return reply.code(201).send(success(mapAlertRule(result.rows[0])));
  });

  app.put<{ Params: { id: string; ruleId: string }; Body: RuleBody }>("/api/v1/projects/:id/alert-rules/:ruleId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.ruleId)) return fail(reply, 404, 2001, "alert rule not found");
    const existing = await pool.query("SELECT * FROM alert_rules WHERE id = $1 AND project_id = $2", [request.params.ruleId, context.project.id]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "alert rule not found");
    const invalid = validateRule(request.body ?? {}, true);
    if (invalid) return fail(reply, 400, 1001, invalid);

    /* 窗口的必填约束要对**合并后**的配置判：把窗口改成 execution_failed 时必须能清空
       （null），把指标从事件型改成窗口型时必须能补上。 */
    const before = existing.rows[0];
    const metric = request.body?.metric ?? String(before.metric);
    const windowMinutes = request.body?.windowMinutes === undefined ? before.window_minutes : request.body.windowMinutes;
    if (!EVENT_METRICS.includes(metric as AlertMetric) && (windowMinutes === null || windowMinutes === undefined)) {
      return fail(reply, 400, 1001, "windowMinutes is required for window metrics");
    }
    if (EVENT_METRICS.includes(metric as AlertMetric) && windowMinutes !== null && windowMinutes !== undefined) {
      return fail(reply, 400, 1001, "execution_failed is evaluated per event and takes no windowMinutes");
    }

    const channelIds = request.body?.channelIds;
    if (channelIds !== undefined && !await channelsBelong(context.project.id, channelIds)) {
      return fail(reply, 400, 1001, "channelIds must reference notification channels in this project");
    }

    const result = await pool.query(
      `UPDATE alert_rules SET name = COALESCE($1, name), metric = COALESCE($2, metric), comparator = COALESCE($3, comparator),
         threshold = COALESCE($4, threshold), window_minutes = $5, cooldown_seconds = COALESCE($6, cooldown_seconds),
         channel_ids = COALESCE($7, channel_ids), enabled = COALESCE($8, enabled), updated_at = now()
       WHERE id = $9 AND project_id = $10 RETURNING *`,
      [
        request.body?.name?.trim() ?? null, request.body?.metric ?? null, request.body?.comparator ?? null,
        request.body?.threshold !== undefined ? Number(request.body.threshold) : null,
        windowMinutes,
        request.body?.cooldownSeconds !== undefined ? Number(request.body.cooldownSeconds) : null,
        channelIds ?? null, request.body?.enabled ?? null,
        request.params.ruleId, context.project.id,
      ],
    );
    return success(mapAlertRule(result.rows[0]));
  });

  /* 删除不拦引用：派发证据行 rule_id 是 SET NULL，历史仍读得通（边界 10）。 */
  app.delete<{ Params: { id: string; ruleId: string } }>("/api/v1/projects/:id/alert-rules/:ruleId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.ruleId)) return fail(reply, 404, 2001, "alert rule not found");
    const result = await pool.query("DELETE FROM alert_rules WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.ruleId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "alert rule not found");
    return success({ id: result.rows[0].id });
  });
}
