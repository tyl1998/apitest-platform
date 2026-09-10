import { pool } from "../db.js";
import { isUuid } from "./uuid.js";
import type { AttributionTargetType } from "../models/types.js";

/**
 * 归因校验的共用件（P8-7 从 `routes/attributions.ts` 提取）：REST 面与 MCP 工具
 * （`lib/mcpToolsAttribution.ts`）**同一套校验**——边界 8 的原话是「set_failure_
 * attribution 复用 REST 同一套校验」，落成代码就是这里的一份实现：MCP 建出来的
 * 归因能过 MCP 的校验却存不进 REST 的形状（或反过来），这件事从这一份开始就
 * 不允许发生（与 validate.ts 之于写工具的关系同构）。
 *
 * 全部只做判定，不做写库——写库两侧各走各的（REST 落 'human' + 当前用户，
 * MCP 落 'mcp' + Token 签发人），这是两个通道唯一允许的差异。
 */

/** 归因目标三类（边界 4：只在叶子失败上归因，不在父级 run/suite execution 上打标）。 */
export const ATTRIBUTION_TARGET_TYPES: readonly AttributionTargetType[] = ["execution", "pipeline_run_case", "execution_step"];

/** 跨项目不比失败细节只比分类，但打标仍只认失败行——成功/取消行收归因等于伪造分布。 */
const FAILED_EXECUTION_STATUS = "failed";
const FAILED_CASE_STATUSES = ["failed", "error"];

export type AttributionTarget = { type: AttributionTargetType; id: string };

/**
 * 目标形状校验：targetType 三值白名单 + targetId 是 UUID。
 * 错误消息**不带业务错误码**——REST 侧包 400/1001、MCP 侧拼 "(1001)"，各自的
 * 信封约定不同，文案本身保持一致。
 */
export function validateAttributionTarget(targetType: unknown, targetId: unknown): AttributionTarget | { error: string } {
  if (typeof targetType !== "string" || !(ATTRIBUTION_TARGET_TYPES as readonly string[]).includes(targetType)) {
    return { error: `targetType must be one of ${ATTRIBUTION_TARGET_TYPES.join(", ")}` };
  }
  if (typeof targetId !== "string" || !isUuid(targetId)) return { error: "targetId must be a UUID" };
  return { type: targetType as AttributionTargetType, id: targetId };
}

/**
 * bug 链接的归一与校验（P8-3 验收反馈）：缺省 = 空串（未绑定）；非空必须是 http(s)
 * ——归因行会把它渲染成可点链接，`javascript:` 这类伪协议在打开的那一刻才炸，入口
 * 就拒掉。长度与 URL 常识同档（2000）。
 */
export function normalizeAttributionBugUrl(raw: unknown): { url: string } | { error: string } {
  if (raw === undefined || raw === null) return { url: "" };
  if (typeof raw !== "string") return { error: "bugUrl must be a string" };
  const url = raw.trim().slice(0, 2000);
  if (url && !/^https?:\/\//i.test(url)) return { error: "bugUrl must be an http(s) URL" };
  return { url };
}

/**
 * 目标必须同时满足「属于本项目」与「是一条失败」。三类目标各一张表：
 * `executions` 自带 project_id；`pipeline_run_cases` 经 pipeline_runs 归属；
 * `execution_steps` 经 execution_index 归属（自指的单步调试父索引也算——那一步确实
 * 失败了，只是父级不算一次执行，叶子归因不受影响）。
 */
export async function attributionTargetIsFailed(projectId: string, targetType: AttributionTargetType, targetId: string): Promise<boolean> {
  if (targetType === "execution") {
    const found = await pool.query(
      `SELECT 1 FROM executions WHERE id = $1 AND project_id = $2 AND status = $3`,
      [targetId, projectId, FAILED_EXECUTION_STATUS],
    );
    return Boolean(found.rowCount);
  }
  if (targetType === "pipeline_run_case") {
    const found = await pool.query(
      `SELECT 1 FROM pipeline_run_cases prc
         JOIN pipeline_runs pr ON pr.id = prc.pipeline_run_id
        WHERE prc.id = $1 AND pr.project_id = $2 AND prc.status = ANY($3)`,
      [targetId, projectId, FAILED_CASE_STATUSES],
    );
    return Boolean(found.rowCount);
  }
  const found = await pool.query(
    `SELECT 1 FROM execution_steps es
       JOIN execution_index ei ON ei.id = es.index_id
      WHERE es.id = $1 AND ei.project_id = $2 AND es.status = $3`,
    [targetId, projectId, FAILED_EXECUTION_STATUS],
  );
  return Boolean(found.rowCount);
}

/** 分类必须存在且启用——停用项不再接受新归因（历史行照常读）。 */
export async function attributionCategoryExists(code: string): Promise<boolean> {
  const found = await pool.query("SELECT 1 FROM failure_categories WHERE code = $1 AND active", [code]);
  return Boolean(found.rowCount);
}
