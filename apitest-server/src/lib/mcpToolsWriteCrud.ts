import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, auditFields } from "./audit.js";
import { notifySerializedQueue } from "./pipelineRun.js";
import {
  auditMcpAction, auditMcpResource,
  requiredUuidArg, toolError, toolResult,
} from "./mcpToolResult.js";
import type { McpToolDefinition } from "./mcpServer.js";
import {
  environmentBelongs, toExecutionConfig, loadSuite,
} from "./trigger.js";
import {
  toSelectionConfig, validateSuite, validateSuiteNotify, type SuiteInput,
} from "./validateSuite.js";
import {
  computeNextRunAt, SCHEDULE_TARGET_TABLES, validateSchedule, type ScheduleBody,
} from "./validateSchedule.js";
import {
  channelsBelong, DEFAULT_COOLDOWN_SECONDS, EVENT_METRICS, validateRule, type RuleBody,
} from "./validateAlertRule.js";
import {
  assertCredentialOwned, mergeDraft, validateCiTaskNotify, type CiTaskBody,
} from "./validateCiTask.js";
import {
  mapAlertRule, mapCiTask, mapSchedule, mapTestSuite, normalizeSuiteNotify,
  type AlertComparator, type AlertMetric, type ScheduleTargetType,
} from "../models/types.js";

/**
 * 全量 CRUD 工具（P5-5b，计划 9.4「写 17 个」的后 12 个）：套件 / 调度 / 告警规则 /
 * CI 任务。delete_* 一次调用直接执行（等价 REST 面的 `?force=true` 路径）：先扫引用者
 * 再在事务里连带删除。**确认交给客户端**——`delete_*` 在 `tools/list` 里带
 * `destructiveHint: true`，agent 平台据此在调用前向人确认；服务端不再走 MRTR
 * 确认回合（2026-10-21 移除：多数 agent 不支持 elicitation，删除会被白卡一轮）。
 *
 * 校验全部复用 P5-5b 随本批提取到 `lib/validate*.ts` 的同一份函数（边界 8 的收尾）：
 * suites / schedules / alertRules / ciTasks 四个路由文件此刻与这些工具跑同一套判据。
 * 幂等键沿用：套件 `(project, name)`、调度 `(resource, cron, target)`、告警规则
 * `(project, name)`、CI 任务 `(repo, name)`。
 */

/** 套件/CI 任务删除的引用者清单（REST 删除路由同款两查询）。 */
async function referencingRows(projectId: string, targetType: "suite" | "ci_task", targetId: string) {
  const schedules = await pool.query(
    "SELECT id, name FROM schedules WHERE project_id = $1 AND target_type = $2 AND target_id = $3",
    [projectId, targetType, targetId],
  );
  const triggers = await pool.query(
    "SELECT id, name FROM webhook_triggers WHERE project_id = $1 AND target_type = $2 AND target_id = $3",
    [projectId, targetType, targetId],
  );
  return {
    schedules: schedules.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
    webhookTriggers: triggers.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
  };
}

/** 引用清单转一句人可读的后果摘要（回执里给调用方看「连带删了什么」）。 */
function summarizeReferences(rows: { schedules: { id: string; name: string }[]; webhookTriggers: { id: string; name: string }[] }): string {
  const parts: string[] = [];
  if (rows.schedules.length) parts.push(`${rows.schedules.length} schedule(s): ${rows.schedules.map((row) => row.name).join(", ")}`);
  if (rows.webhookTriggers.length) parts.push(`${rows.webhookTriggers.length} webhook trigger(s): ${rows.webhookTriggers.map((row) => row.name).join(", ")}`);
  return parts.length ? `It is referenced by ${parts.join("; ")}; those referencing schedules and webhook triggers are deleted too.` : "Nothing else references it.";
}

export const WRITE_CRUD_TOOLS: readonly McpToolDefinition[] = [
  /* ── 套件 ─────────────────────────────────────────────────────────────── */

  {
    name: "create_suite",
    description: "Create a test suite (a batch of cases/flows run together without passing variables between members — a chain that needs data flow should be a flow). Idempotency key is (project, name): an existing suite with the same name is updated instead of duplicated. A suite may be saved with zero members but cannot run until members resolve. Cannot run it (trigger_suite_run) or manage notification channels.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        selection: {
          type: "object",
          description: "manual: {type:'manual', members:[{type:'case'|'flow', id}]}; tag: {type:'tag', tags, match:'any'|'all', includeCases, includeFlows}; all: {type:'all', includeCases, includeFlows}",
        },
        execution: {
          type: "object",
          description: "concurrency (1-10), failFast, environmentStrategy ('member_default'|'override'), environmentId (override only)",
        },
        notify: { type: "object", description: "{onSuccess, onFailure, channelIds, template:{title,body}} — channels must exist in this project" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name", "selection"],
    },
    handler: async (args, identity) => {
      const input = args as unknown as SuiteInput;
      const invalid = validateSuite(input);
      if (invalid) return toolError(`${invalid} (1001)`);
      const execution = toExecutionConfig(input.execution);
      if (!await environmentBelongs(identity.projectId, execution.environmentId)) return toolError("environment must belong to the project (1001)");
      const invalidNotify = await validateSuiteNotify(identity.projectId, input.notify);
      if (invalidNotify) return toolError(`${invalidNotify} (1001)`);

      /* 幂等键 `(project, name)`：同名即更新（与 create_endpoint 的 update 分支同一
         语义——模型重述一遍需求不该产出第二条同名套件）。 */
      const existing = await pool.query("SELECT id FROM test_suites WHERE project_id = $1 AND name = $2 LIMIT 1", [identity.projectId, input.name!.trim()]);
      const created = !existing.rowCount;
      const suiteId = created ? randomUUID() : String(existing.rows[0].id);
      const result = created
        ? await pool.query(
            `INSERT INTO test_suites (id, project_id, name, description, selection_type, selection_config, execution_config, notify_config, tags, created_by)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10) RETURNING *`,
            [
              suiteId, identity.projectId, input.name!.trim(), input.description?.trim() ?? "",
              input.selection!.type!, JSON.stringify(toSelectionConfig(input.selection!)),
              JSON.stringify(execution), JSON.stringify(normalizeSuiteNotify(input.notify ?? {})), input.tags ?? [],
              identity.createdBy ?? null,
            ],
          )
        : await pool.query(
            `UPDATE test_suites SET
               name = $3, description = $4, selection_type = $5, selection_config = $6::jsonb,
               execution_config = $7::jsonb, notify_config = $8::jsonb, tags = $9, updated_by = $10, updated_at = now()
             WHERE id = $1 AND project_id = $2 RETURNING *`,
            [
              suiteId, identity.projectId, input.name!.trim(), input.description?.trim() ?? "",
              input.selection!.type!, JSON.stringify(toSelectionConfig(input.selection!)),
              JSON.stringify(execution), JSON.stringify(normalizeSuiteNotify(input.notify ?? {})), input.tags ?? [],
              identity.createdBy ?? null,
            ],
          );
      auditMcpAction("mcp_tool.write", "create_suite", identity, suiteId, { outcome: created ? "created" : "updated" });
      /* P11-9：资源级审计与 mcp_tool.write 并行落一行（detail 只有字段名）。 */
      auditMcpResource(created ? AUDIT_ACTIONS.testSuiteCreate : AUDIT_ACTIONS.testSuiteUpdate, "test_suite", identity, suiteId, { fields: auditFields(input) });
      return toolResult({ suite: mapTestSuite(result.rows[0]), outcome: created ? "created" : "updated" });
    },
  },
  {
    name: "update_suite",
    description: "Patch one suite by id. selection, execution and notify are each replaced whole when present (no deep merge — switching a tag selection to manual must drop the old tags). Cannot run it; that is trigger_suite_run.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        suiteId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        selection: { type: "object" },
        execution: { type: "object" },
        notify: { type: "object" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["suiteId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "suiteId", "suite");
      if ("error" in id) return toolError(id.error);
      const input = args as unknown as SuiteInput;
      const invalid = validateSuite(input, true);
      if (invalid) return toolError(`${invalid} (1001)`);
      const invalidNotify = await validateSuiteNotify(identity.projectId, input.notify);
      if (invalidNotify) return toolError(`${invalidNotify} (1001)`);

      /* REST PUT 同款：selection/execution/notify 整块替换——深合并会把旧 tags 留在库里。 */
      const selection = input.selection ? JSON.stringify(toSelectionConfig(input.selection)) : null;
      let execution: string | null = null;
      if (input.execution) {
        const config = toExecutionConfig(input.execution);
        if (!await environmentBelongs(identity.projectId, config.environmentId)) return toolError("environment must belong to the project (1001)");
        execution = JSON.stringify(config);
      }
      const notify = input.notify === undefined ? null : JSON.stringify(normalizeSuiteNotify(input.notify));
      const result = await pool.query(
        `UPDATE test_suites SET
           name = COALESCE($1, name),
           description = COALESCE($2, description),
           selection_type = COALESCE($3, selection_type),
           selection_config = COALESCE($4::jsonb, selection_config),
           execution_config = COALESCE($5::jsonb, execution_config),
           notify_config = COALESCE($6::jsonb, notify_config),
           tags = COALESCE($7, tags),
           updated_by = $10,
           updated_at = now()
         WHERE id = $8 AND project_id = $9 RETURNING *`,
        [
          input.name?.trim() ?? null,
          input.description?.trim() ?? null,
          input.selection?.type ?? null, selection, execution, notify,
          input.tags ?? null,
          id.value, identity.projectId,
          identity.createdBy ?? null,
        ],
      );
      if (!result.rowCount) return toolError("test suite not found (2001)");
      auditMcpAction("mcp_tool.write", "update_suite", identity, id.value, {});
      auditMcpResource(AUDIT_ACTIONS.testSuiteUpdate, "test_suite", identity, id.value, { fields: auditFields(input) });
      return toolResult(mapTestSuite(result.rows[0]));
    },
  },
  {
    name: "delete_suite",
    description: "Delete a suite and the schedules / webhook triggers that reference it (run history survives via name snapshots). Irreversible and marked destructive, so the client asks the human before calling; once called it deletes in one round. This tool cannot preview the blast radius — list schedules/triggers first if the human wants to see them before deciding.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { suiteId: { type: "string" } },
      required: ["suiteId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "suiteId", "suite");
      if ("error" in id) return toolError(id.error);
      const suite = await loadSuite(identity.projectId, id.value);
      if (!suite) return toolError("test suite not found (2001)");

      const references = await referencingRows(identity.projectId, "suite", id.value);

      /* 连带删除引用者（REST force 同款事务）：确认已在客户端调用前完成。 */
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM schedules WHERE project_id = $1 AND target_type = 'suite' AND target_id = $2", [identity.projectId, id.value]);
        await client.query("DELETE FROM webhook_triggers WHERE project_id = $1 AND target_type = 'suite' AND target_id = $2", [identity.projectId, id.value]);
        const result = await client.query("DELETE FROM test_suites WHERE id = $1 AND project_id = $2 RETURNING id", [id.value, identity.projectId]);
        await client.query("COMMIT");
        if (!result.rowCount) return toolError("test suite not found (2001)");
        auditMcpAction("mcp_tool.write", "delete_suite", identity, id.value, {
          outcome: "deleted",
          removedSchedules: references.schedules.length,
          removedWebhookTriggers: references.webhookTriggers.length,
        });
        auditMcpResource(AUDIT_ACTIONS.testSuiteDelete, "test_suite", identity, id.value, { fields: [] });
        /* 连带删掉的引用者也各落一行：它们的「变更历史」不该只剩一个消失的资产。 */
        for (const schedule of references.schedules) auditMcpResource(AUDIT_ACTIONS.scheduleDelete, "schedule", identity, schedule.id, { fields: [], cascadeFrom: id.value });
        for (const trigger of references.webhookTriggers) auditMcpResource(AUDIT_ACTIONS.webhookTriggerDelete, "webhook_trigger", identity, trigger.id, { fields: [], cascadeFrom: id.value });
        return toolResult({ id: id.value, deleted: true, removedSchedules: references.schedules.length, removedWebhookTriggers: references.webhookTriggers.length });
      } catch (error) {
        await client.query("ROLLBACK");
        return toolError(error instanceof Error ? `${error.message} (1001)` : "suite could not be deleted (1001)");
      } finally {
        client.release();
      }
    },
  },

  /* ── 调度 ─────────────────────────────────────────────────────────────── */

  {
    name: "create_schedule",
    description: "Create a cron schedule that fires a suite or CI task (targetType 'suite' | 'ci_task'). Idempotency key is (target, cron, targetType): an identical existing schedule is returned instead of duplicated. cron is validated against the timezone with the same parser the scheduler claims with — what the preview says is what runs. variables are per-trigger overrides (CI target: task parameters); never put secrets in them (they freeze into run evidence).",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        targetType: { type: "string", description: "suite | ci_task (default suite)" },
        targetId: { type: "string" },
        cron: { type: "string", description: "standard cron expression" },
        timezone: { type: "string", description: "IANA name, default Asia/Shanghai" },
        environmentId: { type: ["string", "null"], description: "trigger-level environment override (suite target only)" },
        enabled: { type: "boolean" },
        variables: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["name", "targetId", "cron"],
    },
    handler: async (args, identity) => {
      const body = args as unknown as ScheduleBody;
      if (!body.targetId) return toolError("targetId is required (1001)");
      const checked = await validateSchedule(identity.projectId, body, false);
      if (checked.error) return toolError(`${checked.error} (1001)`);

      /* 幂等键 `(target, cron, targetType)`：同目标同节奏的重复创建读回既有行——
         模型把「每小时跑一次」说两遍不该产出两条每小时调度。 */
      const existing = await pool.query(
        "SELECT * FROM schedules WHERE project_id = $1 AND target_type = $2 AND target_id = $3 AND cron = $4 LIMIT 1",
        [identity.projectId, checked.targetType!, checked.targetId!, checked.cron!],
      );
      if (existing.rowCount) {
        return toolResult({ schedule: mapSchedule(existing.rows[0]), outcome: "skipped", conflict: true });
      }

      /* 软上限与 REST 同款：挡误建的复制循环。 */
      const count = await pool.query("SELECT COUNT(*)::int AS total FROM schedules WHERE project_id = $1", [identity.projectId]);
      if (Number(count.rows[0].total) >= 50) return toolError("a project may hold at most 50 schedules (1001)");

      const enabled = body.enabled ?? true;
      const result = await pool.query(
        `INSERT INTO schedules (id, project_id, name, target_type, target_id, environment_id, cron, timezone, enabled, variables, next_run_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12) RETURNING *`,
        [
          randomUUID(), identity.projectId, checked.name!, checked.targetType!, checked.targetId!,
          body.environmentId ?? null, checked.cron!, checked.timezone!, enabled,
          JSON.stringify(body.variables ?? {}), computeNextRunAt(checked.cron!, checked.timezone!, enabled),
          identity.createdBy ?? null,
        ],
      );
      const target = await pool.query(`SELECT name FROM ${SCHEDULE_TARGET_TABLES[checked.targetType!]} WHERE id = $1`, [checked.targetId!]);
      auditMcpAction("mcp_tool.write", "create_schedule", identity, String(result.rows[0].id), { outcome: "created", targetType: checked.targetType });
      auditMcpResource(AUDIT_ACTIONS.scheduleCreate, "schedule", identity, String(result.rows[0].id), { fields: auditFields(body) });
      return toolResult({ schedule: mapSchedule({ ...result.rows[0], target_name: target.rows[0]?.name }), outcome: "created" });
    },
  },
  {
    name: "update_schedule",
    description: "Patch one schedule by id. next_run_at is recomputed whenever cron / timezone / enabled change (the claim anchor follows the config). environmentId is tri-state: absent keeps, null clears, a value switches. Target changes are validated against the merged (targetType, targetId) pair so a half-updated reference cannot dangle.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        scheduleId: { type: "string" },
        name: { type: "string" },
        targetType: { type: "string" },
        targetId: { type: "string" },
        cron: { type: "string" },
        timezone: { type: "string" },
        environmentId: { type: ["string", "null"] },
        enabled: { type: "boolean" },
        variables: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["scheduleId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "scheduleId", "schedule");
      if ("error" in id) return toolError(id.error);
      const existing = await pool.query("SELECT * FROM schedules WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!existing.rowCount) return toolError("schedule not found (2001)");

      const before = existing.rows[0];
      const body = args as unknown as ScheduleBody;
      const checked = await validateSchedule(identity.projectId, body, true, {
        timezone: String(before.timezone),
        targetType: String(before.target_type) as ScheduleTargetType,
        targetId: String(before.target_id),
      });
      if (checked.error) return toolError(`${checked.error} (1001)`);

      const cron = checked.cron ?? String(before.cron);
      const timezone = body.timezone?.trim() || String(before.timezone);
      const enabled = body.enabled ?? Boolean(before.enabled);
      /* 认领锚点跟着配置走（REST PUT 同款）：改 cron/时区/启停后仍用旧的 next_run_at，
         调度器会按旧时刻认领、按新 cron 快进。 */
      const recompute = body.cron !== undefined || body.timezone !== undefined || body.enabled !== undefined;
      const nextRunAt = recompute ? computeNextRunAt(cron, timezone, enabled) : before.next_run_at;
      const environmentId = body.environmentId === undefined ? before.environment_id : body.environmentId;

      await pool.query(
        `UPDATE schedules SET name = COALESCE($1, name), target_type = $2, target_id = $3,
           environment_id = $4, cron = $5, timezone = $6, enabled = $7,
           variables = COALESCE($8::jsonb, variables), next_run_at = $9, updated_by = $12, updated_at = now()
         WHERE id = $10 AND project_id = $11`,
        [
          checked.name ?? null, checked.targetType!, checked.targetId!,
          environmentId, cron, timezone, enabled,
          body.variables !== undefined ? JSON.stringify(body.variables) : null,
          nextRunAt, id.value, identity.projectId,
          identity.createdBy ?? null,
        ],
      );
      const updated = await pool.query(
        `SELECT s.*, COALESCE(ts.name, ct.name) AS target_name FROM schedules s
           LEFT JOIN test_suites ts ON s.target_type = 'suite' AND ts.id = s.target_id
           LEFT JOIN ci_tasks ct ON s.target_type = 'ci_task' AND ct.id = s.target_id
          WHERE s.id = $1 AND s.project_id = $2`,
        [id.value, identity.projectId],
      );
      auditMcpAction("mcp_tool.write", "update_schedule", identity, id.value, {});
      auditMcpResource(AUDIT_ACTIONS.scheduleUpdate, "schedule", identity, id.value, { fields: auditFields(body) });
      return toolResult(mapSchedule(updated.rows[0]));
    },
  },
  {
    name: "delete_schedule",
    description: "Delete a schedule. Its firing history (schedule_runs) is deleted with it; executions it produced survive in the execution records. Irreversible and marked destructive, so the client asks the human before calling; once called it deletes in one round.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { scheduleId: { type: "string" } },
      required: ["scheduleId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "scheduleId", "schedule");
      if ("error" in id) return toolError(id.error);
      const existing = await pool.query("SELECT * FROM schedules WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!existing.rowCount) return toolError("schedule not found (2001)");

      const result = await pool.query("DELETE FROM schedules WHERE id = $1 AND project_id = $2 RETURNING id", [id.value, identity.projectId]);
      if (!result.rowCount) return toolError("schedule not found (2001)");
      auditMcpAction("mcp_tool.write", "delete_schedule", identity, id.value, { outcome: "deleted" });
      auditMcpResource(AUDIT_ACTIONS.scheduleDelete, "schedule", identity, id.value, { fields: [] });
      return toolResult({ id: id.value, deleted: true });
    },
  },

  /* ── 告警规则 ─────────────────────────────────────────────────────────── */

  {
    name: "create_alert_rule",
    description: "Create an alert rule (metric execution_failed | consecutive_failures | success_rate | avg_duration; window metrics need windowMinutes, the event metric takes none; threshold is a percentage for success_rate, ms for avg_duration, a count otherwise). Idempotency key is (project, name). channelIds must reference this project's notification channels — creating channels is a UI action, not a tool.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        metric: { type: "string" },
        comparator: { type: "string", description: "gt | gte | lt | lte" },
        threshold: { type: "number" },
        windowMinutes: { type: ["integer", "null"], description: "required for window metrics; null/absent for execution_failed" },
        cooldownSeconds: { type: "integer" },
        channelIds: { type: "array", items: { type: "string" } },
        enabled: { type: "boolean" },
      },
      required: ["name", "metric", "comparator", "threshold", "channelIds"],
    },
    handler: async (args, identity) => {
      const body = args as unknown as RuleBody;
      const invalid = validateRule(body, false);
      if (invalid) return toolError(`${invalid} (1001)`);
      if (!await channelsBelong(identity.projectId, body.channelIds!)) {
        return toolError("channelIds must reference notification channels in this project (1001)");
      }

      /* 幂等键 `(project, name)`：同名规则的重复创建按更新处理。 */
      const existing = await pool.query("SELECT id FROM alert_rules WHERE project_id = $1 AND name = $2 LIMIT 1", [identity.projectId, body.name!.trim()]);
      const created = !existing.rowCount;
      const ruleId = created ? randomUUID() : String(existing.rows[0].id);
      const values = [
        ruleId, identity.projectId, body.name!.trim(), body.metric!, body.comparator!,
        Number(body.threshold!), body.windowMinutes ?? null,
        body.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS, body.channelIds!, body.enabled ?? true,
        /* INSERT 与 UPDATE 共用这一份值数组（$11 在两条语句里分别是 created_by /
           updated_by）——分开列值会让两个分支的列序悄悄漂移。 */
        identity.createdBy ?? null,
      ];
      const result = created
        ? await pool.query(
            `INSERT INTO alert_rules (id, project_id, name, metric, comparator, threshold, window_minutes, cooldown_seconds, channel_ids, enabled, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            values,
          )
        : await pool.query(
            `UPDATE alert_rules SET
               name = $3, metric = $4, comparator = $5, threshold = $6, window_minutes = $7,
               cooldown_seconds = $8, channel_ids = $9, enabled = $10, updated_by = $11, updated_at = now()
             WHERE id = $1 AND project_id = $2 RETURNING *`,
            values,
          );
      auditMcpAction("mcp_tool.write", "create_alert_rule", identity, ruleId, { outcome: created ? "created" : "updated" });
      auditMcpResource(created ? AUDIT_ACTIONS.alertRuleCreate : AUDIT_ACTIONS.alertRuleUpdate, "alert_rule", identity, ruleId, { fields: auditFields(body) });
      return toolResult({ rule: mapAlertRule(result.rows[0]), outcome: created ? "created" : "updated" });
    },
  },
  {
    name: "update_alert_rule",
    description: "Patch one alert rule by id. The window requirement is checked against the MERGED config (switching an event metric to a window metric must supply windowMinutes; switching back must clear it with null). Cannot create notification channels.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "string" },
        name: { type: "string" },
        metric: { type: "string" },
        comparator: { type: "string" },
        threshold: { type: "number" },
        windowMinutes: { type: ["integer", "null"] },
        cooldownSeconds: { type: "integer" },
        channelIds: { type: "array", items: { type: "string" } },
        enabled: { type: "boolean" },
      },
      required: ["ruleId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "ruleId", "alert rule");
      if ("error" in id) return toolError(id.error);
      const existing = await pool.query("SELECT * FROM alert_rules WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!existing.rowCount) return toolError("alert rule not found (2001)");
      const body = args as unknown as RuleBody;
      const invalid = validateRule(body, true);
      if (invalid) return toolError(`${invalid} (1001)`);

      /* 窗口约束对合并后的配置判（REST PUT 同款两个分支）。 */
      const before = existing.rows[0];
      const metric = body.metric ?? String(before.metric);
      const windowMinutes = body.windowMinutes === undefined ? before.window_minutes : body.windowMinutes;
      if (!EVENT_METRICS.includes(metric as AlertMetric) && (windowMinutes === null || windowMinutes === undefined)) {
        return toolError("windowMinutes is required for window metrics (1001)");
      }
      if (EVENT_METRICS.includes(metric as AlertMetric) && windowMinutes !== null && windowMinutes !== undefined) {
        return toolError("execution_failed is evaluated per event and takes no windowMinutes (1001)");
      }
      if (body.channelIds !== undefined && !await channelsBelong(identity.projectId, body.channelIds)) {
        return toolError("channelIds must reference notification channels in this project (1001)");
      }

      const result = await pool.query(
        `UPDATE alert_rules SET name = COALESCE($1, name), metric = COALESCE($2, metric), comparator = COALESCE($3, comparator),
           threshold = COALESCE($4, threshold), window_minutes = $5, cooldown_seconds = COALESCE($6, cooldown_seconds),
           channel_ids = COALESCE($7, channel_ids), enabled = COALESCE($8, enabled), updated_by = $11, updated_at = now()
         WHERE id = $9 AND project_id = $10 RETURNING *`,
        [
          body.name?.trim() ?? null, body.metric ?? null, body.comparator ?? null,
          body.threshold !== undefined ? Number(body.threshold) : null,
          windowMinutes,
          body.cooldownSeconds !== undefined ? Number(body.cooldownSeconds) : null,
          body.channelIds ?? null, body.enabled ?? null,
          id.value, identity.projectId,
          identity.createdBy ?? null,
        ],
      );
      auditMcpAction("mcp_tool.write", "update_alert_rule", identity, id.value, {});
      auditMcpResource(AUDIT_ACTIONS.alertRuleUpdate, "alert_rule", identity, id.value, { fields: auditFields(body) });
      return toolResult(mapAlertRule(result.rows[0]));
    },
  },
  {
    name: "delete_alert_rule",
    description: "Delete an alert rule. Delivery evidence rows survive with the rule id nulled. Irreversible and marked destructive, so the client asks the human before calling; once called it deletes in one round. To pause alerts without losing the rule, use update_alert_rule with enabled:false instead.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { ruleId: { type: "string" } },
      required: ["ruleId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "ruleId", "alert rule");
      if ("error" in id) return toolError(id.error);
      const existing = await pool.query("SELECT * FROM alert_rules WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!existing.rowCount) return toolError("alert rule not found (2001)");

      const result = await pool.query("DELETE FROM alert_rules WHERE id = $1 AND project_id = $2 RETURNING id", [id.value, identity.projectId]);
      if (!result.rowCount) return toolError("alert rule not found (2001)");
      auditMcpAction("mcp_tool.write", "delete_alert_rule", identity, id.value, { outcome: "deleted" });
      auditMcpResource(AUDIT_ACTIONS.alertRuleDelete, "alert_rule", identity, id.value, { fields: [] });
      return toolResult({ id: id.value, deleted: true });
    },
  },

  /* ── CI 任务 ──────────────────────────────────────────────────────────── */

  {
    name: "create_ci_task",
    description: "Create a CI task (git source + runner label + sandbox mode + shell steps). Idempotency key is (gitUrl, name). The git credential is REFERENCED BY ID only — it must already exist in this project; credentials are never created or passed through tools (create them in the UI). env values become real environment variables on the runner: no APITRACK_* names, values may not be secrets-in-disguise. process sandbox is a trust declaration, not a lighter option.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        gitUrl: { type: "string", description: "https://, http://, ssh:// URL or scp-style git@host:group/repo.git" },
        gitCredentialId: { type: ["string", "null"], description: "existing credential id; null for a public repo" },
        gitRef: { type: "string", description: "default main" },
        runnerLabel: { type: "string", description: "partition label, default 'default'" },
        sandboxMode: { type: "string", description: "process | container (container requires image)" },
        image: { type: "string" },
        steps: { type: "string", description: "one shell block sharing a process and workspace" },
        env: { type: "object", additionalProperties: { type: "string" } },
        cachePaths: { type: "array", items: { type: "string" } },
        cacheKeyFiles: { type: "array", items: { type: "string" } },
        sdkIngestEnabled: { type: "boolean" },
        timeoutSeconds: { type: "integer" },
        enabled: { type: "boolean" },
        notify: { type: "object" },
        singleConcurrency: { type: "boolean", description: "default true: runs queue instead of running in parallel" },
      },
      required: ["name", "gitUrl", "steps"],
    },
    handler: async (args, identity) => {
      const body = args as unknown as CiTaskBody;
      const { draft, error } = mergeDraft(body);
      if (error || !draft) return toolError(`${error ?? "invalid CI task"} (1001)`);
      if (!await assertCredentialOwned(identity.projectId, draft.gitCredentialId)) {
        return toolError("gitCredentialId must reference a git credential of this project (1001)");
      }
      const invalidNotify = await validateCiTaskNotify(identity.projectId, body.notify);
      if (invalidNotify) return toolError(`${invalidNotify} (1001)`);

      /* 幂等键 `(repo, name)`：同仓库同名的重复创建读回既有行。 */
      const existing = await pool.query(
        "SELECT id FROM ci_tasks WHERE project_id = $1 AND git_url = $2 AND name = $3 LIMIT 1",
        [identity.projectId, draft.gitUrl, draft.name],
      );
      if (existing.rowCount) {
        const loaded = await pool.query(
          `SELECT t.*, c.name AS git_credential_name, c.method AS git_credential_method
             FROM ci_tasks t LEFT JOIN git_credentials c ON c.id = t.git_credential_id WHERE t.id = $1`,
          [String(existing.rows[0].id)],
        );
        return toolResult({ ciTask: mapCiTask(loaded.rows[0]), outcome: "skipped", conflict: true });
      }

      const result = await pool.query(
        `INSERT INTO ci_tasks (
           id, project_id, name, description, git_url, git_credential_id, git_ref, runner_label,
           sandbox_mode, isolation_mode, image, steps, env,
           cache_paths, cache_key_files, sdk_ingest_enabled, notify_config, single_concurrency,
           timeout_seconds, enabled, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'shared', $10, $11, $12::jsonb, $13, $14, $15, $16::jsonb, $17, $18, $19, $20)
         RETURNING *`,
        [
          randomUUID(), identity.projectId, draft.name, draft.description,
          draft.gitUrl, draft.gitCredentialId, draft.gitRef, draft.runnerLabel,
          draft.sandboxMode, draft.image, draft.steps, JSON.stringify(draft.env),
          draft.cachePaths, draft.cacheKeyFiles, draft.sdkIngestEnabled, JSON.stringify(draft.notify),
          draft.singleConcurrency, draft.timeoutSeconds, draft.enabled, identity.createdBy ?? null,
        ],
      );
      const loaded = await pool.query(
        `SELECT t.*, c.name AS git_credential_name, c.method AS git_credential_method
           FROM ci_tasks t LEFT JOIN git_credentials c ON c.id = t.git_credential_id WHERE t.id = $1`,
        [String(result.rows[0].id)],
      );
      auditMcpAction("mcp_tool.write", "create_ci_task", identity, String(result.rows[0].id), { outcome: "created" });
      return toolResult({ ciTask: mapCiTask(loaded.rows[0]), outcome: "created" });
    },
  },
  {
    name: "update_ci_task",
    description: "Patch one CI task by id (partial update: absent keys keep their values; gitUrl and gitCredentialId may change — history keeps its own snapshots). The credential is referenced by id only. Turning singleConcurrency off immediately wakes queued runs.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        gitUrl: { type: "string" },
        gitCredentialId: { type: ["string", "null"] },
        gitRef: { type: "string" },
        runnerLabel: { type: "string" },
        sandboxMode: { type: "string" },
        image: { type: "string" },
        steps: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
        cachePaths: { type: "array", items: { type: "string" } },
        cacheKeyFiles: { type: "array", items: { type: "string" } },
        sdkIngestEnabled: { type: "boolean" },
        timeoutSeconds: { type: "integer" },
        enabled: { type: "boolean" },
        notify: { type: "object" },
        singleConcurrency: { type: "boolean" },
      },
      required: ["taskId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "taskId", "CI task");
      if ("error" in id) return toolError(id.error);
      const existing = await pool.query(
        `SELECT t.*, c.name AS git_credential_name, c.method AS git_credential_method
           FROM ci_tasks t LEFT JOIN git_credentials c ON c.id = t.git_credential_id
          WHERE t.id = $1 AND t.project_id = $2`,
        [id.value, identity.projectId],
      );
      if (!existing.rowCount) return toolError("CI task not found (2001)");

      const body = args as unknown as CiTaskBody;
      const { draft, error } = mergeDraft(body, mapCiTask(existing.rows[0]));
      if (error || !draft) return toolError(`${error ?? "invalid CI task"} (1001)`);
      if (!await assertCredentialOwned(identity.projectId, draft.gitCredentialId)) {
        return toolError("gitCredentialId must reference a git credential of this project (1001)");
      }
      const invalidNotify = await validateCiTaskNotify(identity.projectId, body.notify);
      if (invalidNotify) return toolError(`${invalidNotify} (1001)`);

      await pool.query(
        `UPDATE ci_tasks SET
           name = $3, description = $4, git_url = $5, git_credential_id = $6, git_ref = $7,
           runner_label = $8, sandbox_mode = $9, image = $10, steps = $11, env = $12::jsonb,
           cache_paths = $13, cache_key_files = $14, sdk_ingest_enabled = $15,
           notify_config = $16::jsonb, single_concurrency = $17,
           timeout_seconds = $18, enabled = $19, updated_at = now()
         WHERE id = $1 AND project_id = $2`,
        [
          id.value, identity.projectId,
          draft.name, draft.description, draft.gitUrl, draft.gitCredentialId, draft.gitRef,
          draft.runnerLabel, draft.sandboxMode, draft.image, draft.steps, JSON.stringify(draft.env),
          draft.cachePaths, draft.cacheKeyFiles, draft.sdkIngestEnabled,
          JSON.stringify(draft.notify), draft.singleConcurrency, draft.timeoutSeconds, draft.enabled,
        ],
      );
      /* 关掉串行后补一发唤醒（REST PUT 同款）：被守卫挡住的排队 run 立刻可领。 */
      await notifySerializedQueue(pool, id.value).catch(() => {});
      const loaded = await pool.query(
        `SELECT t.*, c.name AS git_credential_name, c.method AS git_credential_method
           FROM ci_tasks t LEFT JOIN git_credentials c ON c.id = t.git_credential_id WHERE t.id = $1`,
        [id.value],
      );
      auditMcpAction("mcp_tool.write", "update_ci_task", identity, id.value, {});
      return toolResult(mapCiTask(loaded.rows[0]));
    },
  },
  {
    name: "delete_ci_task",
    description: "Delete a CI task together with the schedules / webhook triggers referencing it; its pipeline runs and logs cascade with it. Irreversible and marked destructive, so the client asks the human before calling; once called it deletes in one round. To keep run history, use update_ci_task with enabled:false instead — this tool cannot preview the cascade, read the run count via get_ci_task first if the human wants it.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "taskId", "CI task");
      if ("error" in id) return toolError(id.error);
      const existing = await pool.query("SELECT * FROM ci_tasks WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!existing.rowCount) return toolError("CI task not found (2001)");

      const references = await referencingRows(identity.projectId, "ci_task", id.value);
      const runTotal = await pool.query("SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE ci_task_id = $1", [id.value]);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM schedules WHERE project_id = $1 AND target_type = 'ci_task' AND target_id = $2", [identity.projectId, id.value]);
        await client.query("DELETE FROM webhook_triggers WHERE project_id = $1 AND target_type = 'ci_task' AND target_id = $2", [identity.projectId, id.value]);
        const result = await client.query("DELETE FROM ci_tasks WHERE id = $1 AND project_id = $2 RETURNING id", [id.value, identity.projectId]);
        await client.query("COMMIT");
        if (!result.rowCount) return toolError("CI task not found (2001)");
        auditMcpAction("mcp_tool.write", "delete_ci_task", identity, id.value, {
          outcome: "deleted",
          cascadedRuns: Number(runTotal.rows[0].total),
          removedSchedules: references.schedules.length,
          removedWebhookTriggers: references.webhookTriggers.length,
        });
        /* CI 任务不在 P11 的 14 张表里（天生带 created_by），但连带删掉的调度与
           Webhook 触发在——它们各落一行 delete。 */
        for (const schedule of references.schedules) auditMcpResource(AUDIT_ACTIONS.scheduleDelete, "schedule", identity, schedule.id, { fields: [], cascadeFrom: id.value });
        for (const trigger of references.webhookTriggers) auditMcpResource(AUDIT_ACTIONS.webhookTriggerDelete, "webhook_trigger", identity, trigger.id, { fields: [], cascadeFrom: id.value });
        return toolResult({
          id: id.value, deleted: true,
          cascadedRuns: Number(runTotal.rows[0].total),
          removedSchedules: references.schedules.length,
          removedWebhookTriggers: references.webhookTriggers.length,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        return toolError(error instanceof Error ? `${error.message} (1001)` : "CI task could not be deleted (1001)");
      } finally {
        client.release();
      }
    },
  },
];
