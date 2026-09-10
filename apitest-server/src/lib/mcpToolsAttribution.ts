import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import {
  attributionCategoryExists, attributionTargetIsFailed, normalizeAttributionBugUrl, validateAttributionTarget,
} from "./attribution.js";
import { auditMcpAction, pageArgs, stringArg, toolError, toolResult } from "./mcpToolResult.js";
import type { McpToolDefinition } from "./mcpServer.js";
import { projectSecretValues } from "./mcpRedact.js";
import { sanitizeValue } from "./sanitize.js";

/**
 * 归因工具（P8-7，计划 12.2 的两个工具——边界 8「自动归因走 MCP，平台不写一行 LLM
 * 代码」的 agent 侧入口）：`list_unattributed_failures`（读）+ `set_failure_attribution`
 * （写）。
 *
 * 目标推导、三类目标校验、bug 链接归一全部来自 `lib/attribution.ts`——与 REST 面
 * （`routes/attributions.ts`）**同一份实现**（边界 8「复用 REST 同一套校验」的字面
 * 落法）。写库差异只有三处刻意的：
 * - `source` 写 `'mcp'`（验收门槛 10：MCP 写回后 source='mcp'，人工覆盖后变 human）；
 * - `created_by` 落 Token 签发人（`identity.createdBy`——真人判据照旧，P5 边界 2；
 *   `/mcp` 路由的第 4 道闸门已保证签发人此刻仍有项目写权限，无签发人的 Token 在
 *   闸门就被拒了，这里的写路径不再重复判）；
 * - 审计走 `mcp_tool.write`（MCP 面自己的动作词条），detail 带分类与目标——note
 *   自由文本不进审计（与 REST 的 `failure_attribution.set` 同一条纪律）。
 */

/** 证据摘录的字节上限：摘录是「归因决策的线索」不是完整堆栈（UI 抽屉同款 800 字符档）。 */
const EVIDENCE_EXCERPT_BYTES = 2048;

/* ── list 工具的取证形状 ── */

/**
 * 未归因失败的目标母查询：与 `stats.ts` 的 failureTargetsSql 同一份口径（套件失败
 * 成员 → executions 行 / 步骤行；仓库 run 的 failed/error 用例行），但**方向反过来**
 * ——stats 从失败行 LEFT JOIN 归因（悬空归因不命中），这里要的是「没有归因行」的
 * 失败：`fa.id IS NULL` 的反连接。窗口参数 `since` 可选（不给 = 全量未归因，agent
 * 从最旧的开始清也是一种工作法）。
 */
function unattributedTargetsSql(base: number): string {
  return `
    SELECT ei.project_id AS project_id,
           CASE WHEN es.http_execution_id IS NOT NULL THEN 'execution' ELSE 'execution_step' END AS target_type,
           COALESCE(es.http_execution_id, es.id) AS target_id,
           es.step_name AS label, es.error AS error, ei.created_at AS failed_at,
           NULL::uuid AS pipeline_run_id
      FROM execution_index ei
      JOIN suite_executions se ON se.execution_index_id = ei.id
      JOIN execution_steps es ON es.index_id = se.execution_index_id AND es.parent_step_id IS NULL AND es.status = 'failed'
      LEFT JOIN failure_attributions fa ON fa.target_type = CASE WHEN es.http_execution_id IS NOT NULL THEN 'execution' ELSE 'execution_step' END
        AND fa.target_id = COALESCE(es.http_execution_id, es.id)
     WHERE ei.kind = 'suite' AND ei.project_id = $1 AND ei.created_at >= $${base} AND fa.id IS NULL
     UNION ALL
    SELECT pr.project_id, 'pipeline_run_case', prc.id,
           prc.case_name, prc.message, pr.created_at,
           pr.id AS pipeline_run_id
      FROM pipeline_runs pr
      JOIN pipeline_run_cases prc ON prc.pipeline_run_id = pr.id AND prc.status IN ('failed', 'error')
      LEFT JOIN failure_attributions fa ON fa.target_type = 'pipeline_run_case' AND fa.target_id = prc.id
     WHERE pr.project_id = $1 AND pr.created_at >= $${base} AND fa.id IS NULL`;
}

/**
 * 证据摘录的遮蔽：错误原文可能带出凭据（executions.error / pipeline_run_cases.message
 * 是入队或失败时的原文）。与 `redactExecutionForMcp` 同一条理由——写入时的遮蔽用
 * 的是当时的 secret，读时按**项目全部环境当前 secret 的并集**重跑一遍。CI 侧的
 * message 再叠一层任务 env 值遮蔽（`ciTaskEnvValues` 的判据：值 ≥ 8 字符才值得遮）。
 */
async function maskExcerpt(projectId: string, ciTaskId: string | null, text: string | null | undefined): Promise<string | undefined> {
  if (text === undefined || text === null || !String(text).trim()) return undefined;
  const secrets = await projectSecretValues(projectId);
  let masked = String(sanitizeValue(String(text), secrets));
  if (ciTaskId) {
    const env = await pool.query("SELECT env FROM ci_tasks WHERE id = $1 AND project_id = $2", [ciTaskId, projectId]);
    if (env.rowCount) {
      for (const value of Object.values((env.rows[0].env ?? {}) as Record<string, string>)) {
        if (typeof value === "string" && value.length >= 8) masked = String(sanitizeValue(masked, [value]));
      }
    }
  }
  const cut = Math.floor((EVIDENCE_EXCERPT_BYTES * masked.length) / Buffer.byteLength(masked, "utf8"));
  const excerpt = Buffer.byteLength(masked, "utf8") > EVIDENCE_EXCERPT_BYTES ? `${masked.slice(0, cut)}…` : masked;
  return excerpt;
}

export const ATTRIBUTION_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "list_unattributed_failures",
    description: "List this project's failed leaf targets that have NO attribution yet, newest first, paged, each with an evidence excerpt (error text or failure message, masked against the project's current secrets, truncated to 2KB). Targets are the three leaf kinds: 'execution' (HTTP failures of endpoint cases and suite case members), 'execution_step' (non-HTTP step failures of suite flow members), 'pipeline_run_case' (CI run cases with status failed/error). Use get_execution / get_run_case for full evidence of one target, then set_failure_attribution to write the verdict. Attributed failures are excluded — this is the backlog for attribution work. Cannot list attributed failures or modify anything.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO 8601; only failures created at or after this time. Omit for the full backlog" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: async (args, identity) => {
      const { page, pageSize, offset } = pageArgs(args);
      const sinceArg = stringArg(args, "since");
      const since = sinceArg ? new Date(sinceArg) : new Date(0);
      if (sinceArg && Number.isNaN(since.getTime())) return toolError("since must be an ISO 8601 timestamp (1001)");

      const sql = unattributedTargetsSql(2);
      const params: unknown[] = [identity.projectId, since.toISOString(), pageSize, offset];
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM (${sql}) targets`, [identity.projectId, since.toISOString()]);
      const result = await pool.query(`${sql} ORDER BY failed_at DESC LIMIT $3 OFFSET $4`, params);

      const rows = [];
      for (const row of result.rows) {
        /* pipeline_run_case 的摘录按所在 CI 任务的 env 值再叠一层遮蔽（get_run_case
           的同一条红线）；另外两类的错误原文走项目 secret 并集即可。 */
        let ciTaskId: string | null = null;
        if (row.pipeline_run_id) {
          const task = await pool.query("SELECT ci_task_id FROM pipeline_runs WHERE id = $1 AND project_id = $2", [row.pipeline_run_id, identity.projectId]);
          ciTaskId = task.rows[0]?.ci_task_id ? String(task.rows[0].ci_task_id) : null;
        }
        rows.push({
          targetType: String(row.target_type),
          targetId: String(row.target_id),
          label: row.label ? String(row.label) : null,
          failedAt: new Date(String(row.failed_at)).toISOString(),
          evidence: await maskExcerpt(identity.projectId, ciTaskId, row.error),
        });
      }
      return toolResult({ failures: rows, page, pageSize, total: Number(count.rows[0].total) });
    },
  },
  {
    name: "set_failure_attribution",
    description: "Write or overwrite one failure's attribution (a failure holds exactly one; re-attributing is an update, not an append). Category must exist and be active — read valid codes from the platform's category list (seeded: product_bug / test_defect / env / data / flaky / dependency / other). note is free text for project-specific context; bugUrl (optional) must be http(s). The row is stamped source='mcp' and the MCP token issuer becomes created_by; a later human overwrite flips source to 'human'. Target must be a FAILED leaf of this project — attributing a success row is rejected. Batch is not offered as a tool: loop this tool, it is idempotent per target.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        targetType: { type: "string", description: "execution | pipeline_run_case | execution_step" },
        targetId: { type: "string", description: "target id from list_unattributed_failures" },
        category: { type: "string", description: "active failure category code" },
        note: { type: "string" },
        bugUrl: { type: "string" },
      },
      required: ["targetType", "targetId", "category"],
    },
    handler: async (args, identity) => {
      const target = validateAttributionTarget(args.targetType, args.targetId);
      if ("error" in target) return toolError(`${target.error} (1001)`);
      const category = stringArg(args, "category");
      if (!category) return toolError("category is required (1001)");
      const note = stringArg(args, "note") ?? "";
      const bugUrl = normalizeAttributionBugUrl(args.bugUrl);
      if ("error" in bugUrl) return toolError(`${bugUrl.error} (1001)`);
      if (!(await attributionCategoryExists(category))) return toolError("unknown or inactive failure category (1001)");
      if (!(await attributionTargetIsFailed(identity.projectId, target.type, target.id))) {
        return toolError("attribution target not found in this project or is not a failure (2001)");
      }
      /* source='mcp' + created_by=签发人：与 REST 的唯一差异（见文件头注释）。ON
         CONFLICT DO UPDATE 与 REST 同款——重打标是一条 UPDATE，不留未归因窗口。 */
      const result = await pool.query(
        `INSERT INTO failure_attributions (id, project_id, target_type, target_id, category, note, bug_url, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'mcp', $8)
         ON CONFLICT (target_type, target_id) DO UPDATE
           SET category = $5, note = $6, bug_url = $7, source = 'mcp', created_by = $8, updated_at = now()
         RETURNING *`,
        [randomUUID(), identity.projectId, target.type, target.id, category, note, bugUrl.url, identity.createdBy ?? null],
      );
      const row = result.rows[0];
      auditMcpAction("mcp_tool.write", "set_failure_attribution", identity, target.id, { category, target: target.type });
      return toolResult({
        attribution: {
          targetType: String(row.target_type),
          targetId: String(row.target_id),
          category: String(row.category),
          note: String(row.note ?? ""),
          bugUrl: String(row.bug_url ?? ""),
          source: String(row.source),
          updatedAt: new Date(String(row.updated_at)).toISOString(),
        },
      });
    },
  },
];
