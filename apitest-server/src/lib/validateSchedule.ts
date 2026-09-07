import { pool } from "../db.js";
import { validateVariableOverrides } from "./resolve.js";
import {
  nextOccurrence, validateScheduleCron, validateScheduleTimezone,
} from "./schedule.js";
import { environmentBelongs } from "./trigger.js";
import { isUuid } from "./uuid.js";
import { SCHEDULE_TARGET_TYPES, type ScheduleTargetType } from "../models/types.js";

/**
 * 调度配置的校验、归一与下一拍计算（P5-5b 自 `routes/schedules.ts` 原样提取，边界 8
 * 的同一笔账）。函数体逐字搬移：签名、错误文案、`partial` 语义零改动。
 */

/** 目标类型 → 那张表（代码常量二选一，不是输入拼接；见下面 assertTargetOwned）。 */
export const SCHEDULE_TARGET_TABLES: Record<ScheduleTargetType, string> = { suite: "test_suites", ci_task: "ci_tasks" };

export type ScheduleBody = {
  name?: string;
  /** 目标类型（P4.5-12）。创建时缺省为 `'suite'`——P3 起存量调用方都不带这个键。 */
  targetType?: string;
  /** 目标 id：套件 id 或 CI 任务 id，按 `targetType` 解释（迁移 030 起无外键的多态引用）。 */
  targetId?: string;
  cron?: string;
  timezone?: string;
  /** 触发级环境覆盖（边界 4）：null = 清掉，回到套件自己的配置。CI 目标上无意义。 */
  environmentId?: string | null;
  enabled?: boolean;
  /** 每次触发都带的变量覆盖（6.5 泳道第二层）；CI 目标下即任务 `parameters`。 */
  variables?: Record<string, string>;
};

/** 目标必须在本项目里：借别项目的资源建调度等于跨项目触发。 */
export async function assertTargetOwned(projectId: string, targetType: ScheduleTargetType, targetId: string): Promise<boolean> {
  /* 表名来自 SCHEDULE_TARGET_TABLES（代码常量），id 与 project 走参数——与 webhookTriggers.ts 的
     validateTarget 同一条纪律。 */
  const found = await pool.query(
    `SELECT 1 FROM ${SCHEDULE_TARGET_TABLES[targetType]} WHERE id = $1 AND project_id = $2`,
    [targetId, projectId],
  );
  return Boolean(found.rowCount);
}

/**
 * 校验 + 归一一份调度配置。partial=true 时只查出现的键（PUT 语义）；PUT 校验 cron
 * 必须对**合并后**的时区算——套件存的是 UTC、这次只改 cron，用默认时区验就会放行一个
 * 在真实时区里非法的表达式。cron 校验与调度器认领、preview 用的是
 * `lib/schedule.ts` 的同一个解析——三处若各说各话，用户在编辑器里预览的时刻和夜里
 * 实际跑的时刻就不是同一个。
 *
 * 目标类型与目标 id 一起校验（P4.5-12）：`targetType` 换了但 `targetId` 还指着旧那张表的
 * 行，就是一条悬空引用——每拍到点记一行 failed。所以 PUT 里只给一个的那种写法必须用合并后
 * 的值去查存在性，而不是只查请求体里出现的那个。
 */
export async function validateSchedule(
  projectId: string,
  body: ScheduleBody,
  partial: boolean,
  existing?: { timezone: string; targetType: ScheduleTargetType; targetId: string },
): Promise<{ error?: string; name?: string; cron?: string; timezone?: string; targetType?: ScheduleTargetType; targetId?: string }> {
  const name = body.name?.trim();
  if (!partial || body.name !== undefined) if (!name) return { error: "schedule name is required" };
  const timezone = body.timezone?.trim() || existing?.timezone || "Asia/Shanghai";
  if (body.timezone !== undefined) {
    const invalidTz = validateScheduleTimezone(timezone);
    if (invalidTz) return { error: invalidTz };
  }
  const cron = body.cron?.trim();
  if (!partial || body.cron !== undefined) {
    if (!cron) return { error: "cron is required" };
    const invalidCron = validateScheduleCron(cron, timezone);
    if (invalidCron) return { error: invalidCron };
  }

  /* 目标：创建时缺省 'suite'（存量调用方不带这个键），更新时以已存行兜底。 */
  const targetType = (body.targetType?.trim() || existing?.targetType || "suite") as ScheduleTargetType;
  if (!(SCHEDULE_TARGET_TYPES as readonly string[]).includes(targetType)) {
    return { error: `targetType must be one of ${SCHEDULE_TARGET_TYPES.join(", ")}` };
  }
  const targetId = body.targetId !== undefined ? String(body.targetId) : existing?.targetId;
  if (body.targetType !== undefined || body.targetId !== undefined) {
    if (!targetId) return { error: "targetId is required" };
    if (!isUuid(targetId)) return { error: "targetId must be a UUID" };
    if (!await assertTargetOwned(projectId, targetType, targetId)) {
      return { error: `targetId must reference a ${targetType === "ci_task" ? "CI task" : "suite"} in this project` };
    }
  }

  if (body.environmentId !== undefined && body.environmentId !== null) {
    if (!isUuid(String(body.environmentId))) return { error: "environmentId must be a UUID" };
    if (!await environmentBelongs(projectId, body.environmentId)) return { error: "environment must belong to the project" };
  }
  const invalidVariables = validateVariableOverrides(body.variables);
  if (invalidVariables) return { error: invalidVariables };
  return { name, cron, timezone, targetType, targetId };
}

/**
 * 写入时算下一拍：启用 = 当前时刻后的第一个 cron 时刻；禁用 = NULL（不进调度器的
 * 到期扫描，迁移 030 的约定）。
 */
export function computeNextRunAt(cron: string, timezone: string, enabled: boolean): Date | null {
  return enabled ? nextOccurrence(cron, timezone, new Date()) : null;
}
