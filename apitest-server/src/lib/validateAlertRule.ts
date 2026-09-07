import { pool } from "../db.js";
import { isUuid } from "./uuid.js";
import type { AlertComparator, AlertMetric } from "../models/types.js";

/**
 * 告警规则的校验（P5-5b 自 `routes/alertRules.ts` 原样提取，边界 8 的同一笔账）。
 * 函数体逐字搬移：签名、错误文案、`partial` 语义零改动。
 */

export const ALERT_METRICS: AlertMetric[] = ["execution_failed", "consecutive_failures", "success_rate", "avg_duration"];
export const ALERT_COMPARATORS: AlertComparator[] = ["gt", "gte", "lt", "lte"];
/** 事件型指标：失败事件一到就评估，无窗口。 */
export const EVENT_METRICS: AlertMetric[] = ["execution_failed"];
export const DEFAULT_COOLDOWN_SECONDS = 600;

export type RuleBody = {
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
export function validateRule(body: RuleBody, partial: boolean): string | undefined {
  const name = body.name?.trim();
  if (!partial || body.name !== undefined) if (!name) return "rule name is required";
  const metric = body.metric as AlertMetric | undefined;
  if (!partial || body.metric !== undefined) {
    if (!metric || !ALERT_METRICS.includes(metric)) return `metric must be one of ${ALERT_METRICS.join(", ")}`;
  }
  const comparator = body.comparator as AlertComparator | undefined;
  if (!partial || body.comparator !== undefined) {
    if (!comparator || !ALERT_COMPARATORS.includes(comparator)) return `comparator must be one of ${ALERT_COMPARATORS.join(", ")}`;
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
export async function channelsBelong(projectId: string, channelIds: string[]): Promise<boolean> {
  const found = await pool.query("SELECT COUNT(*)::int AS total FROM notification_channels WHERE id = ANY($1::uuid[]) AND project_id = $2", [channelIds, projectId]);
  return Number(found.rows[0].total) === channelIds.length;
}
