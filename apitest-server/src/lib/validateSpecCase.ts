import { pool } from "../db.js";
import { isUuid } from "./uuid.js";
import type { SpecCaseStep } from "../models/types.js";

/**
 * Extracted from `routes/specCases.ts` (P5-6，边界 8——同 `validateSuite` 等四件的先例)
 * so the MCP write tools run the exact same checks as the REST routes: two copies
 * would mean two semantics. Move only: behavior, signatures (message string, not
 * a thrown error) and the `partial` flag are untouched.
 */

export const SPEC_PRIORITIES = ["P0", "P1", "P2", "P3"];
/* 生命周期三态（㉘ 改名）：未评审起步 → 评审通过 → 废弃收档。 */
export const SPEC_STATUSES = ["unreviewed", "reviewed", "deprecated"];

export type SpecCaseBody = {
  moduleId?: string;
  title?: string;
  preconditions?: string;
  steps?: SpecCaseStep[];
  priority?: string;
  tags?: string[];
  status?: string;
};

/** 手工建/改的入参校验（消息串风格照 lib/validate.ts；PATCH 只验出现的键）。 */
export function validateSpecCase(input: SpecCaseBody, partial = false): string | undefined {
  if (!partial || input.title !== undefined) if (!input.title?.trim()) return "title is required";
  if (!partial && input.moduleId === undefined) return "moduleId is required";
  if (input.moduleId !== undefined && !isUuid(input.moduleId)) return "moduleId must be a UUID";
  if (input.preconditions !== undefined && typeof input.preconditions !== "string") return "preconditions must be a string";
  if (input.priority !== undefined && !SPEC_PRIORITIES.includes(input.priority)) return `priority must be one of ${SPEC_PRIORITIES.join(", ")}`;
  if (input.status !== undefined && !SPEC_STATUSES.includes(input.status)) return `status must be one of ${SPEC_STATUSES.join(", ")}`;
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string"))) return "tags must be an array of strings";
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps)) return "steps must be an array";
    for (const item of input.steps) {
      if (typeof item !== "object" || item === null) return "each step must be an object";
      const record = item as { step?: unknown; expected?: unknown };
      if (record.step !== undefined && typeof record.step !== "string") return "step text must be a string";
      if (record.expected !== undefined && typeof record.expected !== "string") return "expected text must be a string";
    }
  }
  return undefined;
}

/**
 * 步骤归一：trim + 丢弃两列全空的行（行内表格极易留空行，存进去只会在详情里渲染出
 * 空步骤）。String() 兜底而不是 `.trim()` 直调——JSON 里混进 `{}` 或数组的行（校验
 * 只拦 null 与显式非串值）不该把接口打成 500。undefined 表示请求里没带 steps
 * （保持不动）。
 */
export function normalizeSteps(input: SpecCaseStep[] | undefined): SpecCaseStep[] | undefined {
  if (input === undefined) return undefined;
  return input
    .map((item) => ({ step: String(item?.step ?? "").trim(), expected: String(item?.expected ?? "").trim() }))
    .filter((item) => item.step !== "" || item.expected !== "");
}

export function normalizeTags(input: string[] | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  return input.map((tag) => tag.trim()).filter(Boolean);
}

/**
 * 项目内自增编号（2026-09-07 反馈：编号不再手工录入，新建时由服务端生成）。
 * `TC-` + 项目内已有最大序号 + 1，三位补零（TC-001）——补零后字典序即数值序，
 * 列表 ORDER BY item_key 免二次排序。只统计 `TC-<纯数字>` 形态的行：导入
 * （P7-4/5）写进来的其它形态编号不参与序列，也不会被生成的键撞上（形态即前缀
 * 不同，UNIQUE 键不同）。
 */
export async function nextItemKey(projectId: string): Promise<string> {
  const result = await pool.query(
    `SELECT 'TC-' || lpad((COALESCE(MAX((substring(item_key FROM 4))::int), 0) + 1)::text, 3, '0') AS next
       FROM spec_cases
      WHERE project_id = $1 AND item_key ~ '^TC-[0-9]+$'`,
    [projectId],
  );
  return String(result.rows[0].next);
}
