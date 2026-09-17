import { pool } from "../db.js";
import { enqueueRun, NoRunnerError } from "./enqueue.js";
import { auditMcpAction, requiredUuidArg, toolError, toolResult } from "./mcpToolResult.js";
import type { McpToolDefinition } from "./mcpServer.js";
import { queueEndpointRun } from "../routes/endpoints.js";
import {
  IdempotentReplayError, NoCiRunnerError, triggerCiTaskRun, triggerFlowRun, triggerSuiteRun,
  TriggerTargetError, TriggerValidationError,
} from "./trigger.js";
import { isUuid } from "./uuid.js";
import { mapTestCase } from "../models/types.js";

/**
 * 执行工具（P5-5b，计划 9.4「执行 5 个」，独立 `execute` scope）。
 *
 * 边界 3 的两条纪律：
 * - **只跑已保存的命名资产、不接受 overrides**——`run_endpoint` 走 REST 调试发送的
 *   `queueEndpointRun`（环境链：显式指定 → 接口默认 → 项目默认），`run_case` 跑冻结
 *   快照（REST 面的 request/assertions 编辑态执行对工具面不开放）。任意构造请求的
 *   自由执行明确不提供（9.4 末段）。
 * - **在途去重只加在 flow / suite / ci 上**：`run_endpoint` / `run_case` 是调试语义，
 *   连点是正常用法；而一次流程跑十分钟，模型重试两遍就是两条排队 run，同一个套件
 *   /CI 任务也在执行中不该再排一条——同目标已有排队/在途 run 时直接返回那个 id。
 *
 * 每个 execute 落一行 `mcp_tool.execute` 审计（边界 13）；`trigger_ci_task_run` 另有
 * `triggerCiTaskRun` 自己写的 `ci_task.trigger` 行（triggeredBy = Token 签发人）。触发
 * 上下文与 REST 手动路径一致（不传 trigger，入队侧缺省 manual）：`TriggerSource` 没有
 * `mcp` 值，「谁经哪把钥匙触发的」由审计行回答，不往执行证据里发明新枚举。
 */

/** 业务错误文案（与 `failTrigger` 同一张映射——MCP 把码写进消息文本，见 9.4 信封例外）。 */
function triggerErrorText(error: unknown, fallback: string): string {
  /* 503 + 2004：分区没有能领的 worker / Runner（基础设施，不是坏输入）。 */
  if (error instanceof NoRunnerError) return `${error.message} (2004)`;
  if (error instanceof NoCiRunnerError) return `${error.message} (2004)`;
  if (error instanceof TriggerTargetError) return `${error.message} (2001)`;
  if (error instanceof TriggerValidationError) return `${error.message} (1001)`;
  if (error instanceof Error) {
    /* Queue down 同 failTrigger：503/5001 语义，让调用方能说「队列不可用」而不是怪资产。 */
    if (error.message.includes("queue unavailable")) return `${error.message} (5001)`;
    return `${error.message || fallback} (2002)`;
  }
  return `${fallback} (2002)`;
}

export const EXECUTE_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "run_endpoint",
    description: "Queue a debug run of a SAVED endpoint exactly as defined (no overrides — edit it with update_endpoint first). Environment resolution follows the debug-send chain: pass environmentId to pin one, omit it to use the endpoint default then the project default. Not deduplicated: repeated calls queue repeated runs, like clicking Send twice. Returns the executionId — poll get_execution for the result. Cannot construct arbitrary requests or touch environments/secrets.",
    scope: "execute",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: { type: "string" },
        environmentId: { type: "string", description: "pin an environment for this run; omit to follow the endpoint/project default chain" },
      },
      required: ["endpointId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "endpointId", "endpoint");
      if ("error" in id) return toolError(id.error);
      /* isUuid 先挡：坏 uuid 进了 SQL 的 uuid cast 会炸整条查询（契约第 5 条）。 */
      const environmentId = typeof args.environmentId === "string" ? args.environmentId.trim() : undefined;
      if (environmentId !== undefined && environmentId !== "" && !isUuid(environmentId)) {
        return toolError("environmentId must be a UUID (1001)");
      }
      /* 空串与缺省同义（显式跟随默认链）；有值 = 显式钉住该环境。 */
      const explicit = Boolean(environmentId);

      try {
        const executionId = await queueEndpointRun(identity.projectId, id.value, environmentId || null, explicit, undefined, identity.createdBy ?? null);
        auditMcpAction("mcp_tool.execute", "run_endpoint", identity, executionId, { endpointId: id.value });
        return toolResult({ executionId, status: "queued" });
      } catch (error) {
        /* `queueEndpointRun` 抛的是裸 Error（REST 路由层翻译码），这里按消息对回码。 */
        const message = error instanceof Error ? error.message : "";
        if (message === "endpoint not found") return toolError("endpoint not found (2001)");
        if (message === "environment must belong to the project") return toolError(`${message} (1001)`);
        return toolError(triggerErrorText(error, "endpoint could not be queued"));
      }
    },
  },
  {
    name: "run_case",
    description: "Queue a run of a SAVED test case — its frozen request snapshot, assertions, hooks and response scripts, exactly as stored (no overrides). The product is one executions row readable via get_execution. Not deduplicated: repeated calls queue repeated runs.",
    scope: "execute",
    inputSchema: {
      type: "object",
      properties: { caseId: { type: "string" } },
      required: ["caseId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "caseId", "case");
      if ("error" in id) return toolError(id.error);

      const result = await pool.query(
        `SELECT test_cases.*, endpoints.name AS endpoint_name FROM test_cases
           JOIN endpoints ON endpoints.id = test_cases.endpoint_id
          WHERE test_cases.id = $1 AND test_cases.project_id = $2`,
        [id.value, identity.projectId],
      );
      if (!result.rowCount) return toolError("case not found (2001)");
      const testCase = mapTestCase(result.rows[0]);

      /* 与 REST execute 同一条入队路径，但 overrides 一概不收（边界 3）：跑的就是
         冻结快照本身。 */
      const executionId = await enqueueRun({
        projectId: identity.projectId,
        endpointId: testCase.endpointId,
        endpointName: String(result.rows[0].endpoint_name),
        request: testCase.request,
        environmentId: testCase.environmentId,
        environmentName: testCase.environmentName,
        source: "test_case",
        caseId: testCase.id,
        caseName: testCase.name,
        assertions: testCase.assertions,
        hooks: testCase.preRequestHooks,
        extracts: testCase.extracts,
        responseScripts: testCase.responseScripts,
        /* P11 边界 11：MCP 执行的触发人 = Token 签发人（边界 4）。 */
        triggeredBy: identity.createdBy ?? null,
      });
      auditMcpAction("mcp_tool.execute", "run_case", identity, executionId, { caseId: id.value });
      return toolResult({ executionId, status: "queued" });
    },
  },
  {
    name: "run_flow",
    description: "Queue a run of a SAVED flow by its stored DAG (unsaved canvas overrides are a UI concept and are not accepted here; use upsert_flow first if the definition needs changes). Optional environmentId pins the run to one environment; optional variables are trigger-level overrides merged over the flow's seed variables (same rule as schedules/webhooks — never put secrets in them, they freeze into run evidence). Deduplicated: while this flow already has a queued or running execution, the existing executionId is returned instead of queueing another.",
    scope: "execute",
    inputSchema: {
      type: "object",
      properties: {
        flowId: { type: "string" },
        environmentId: { type: "string" },
        variables: { type: "object", additionalProperties: { type: "string" }, description: "per-run variable overrides; never put secrets here — they freeze into run evidence" },
      },
      required: ["flowId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "flowId", "flow");
      if ("error" in id) return toolError(id.error);
      const environmentId = typeof args.environmentId === "string" && args.environmentId.trim() ? args.environmentId.trim() : undefined;
      const variables = typeof args.variables === "object" && args.variables !== null && !Array.isArray(args.variables)
        ? Object.fromEntries(Object.entries(args.variables).map(([key, value]) => [key, String(value)]))
        : undefined;

      /* 在途去重：同流程已有排队/在途 run 直接返回那个 id——一次流程跑十分钟，模型
         重试一遍不该再排一条。 */
      const inFlight = await pool.query(
        "SELECT id FROM flow_executions WHERE flow_id = $1 AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
        [id.value],
      );
      if (inFlight.rowCount) {
        const flowExecutionId = String(inFlight.rows[0].id);
        return toolResult({ flowExecutionId, status: "already_running", deduplicated: true });
      }

      try {
        const flowExecutionId = await triggerFlowRun({
          projectId: identity.projectId,
          flowId: id.value,
          environmentId,
          /* 调度 / Webhook 的触发语义（种子 + 覆盖，后者胜）而不是画布的整袋替换：
             工具是触发路径的一员，与另两条触发路径共用同一套合并规则。 */
          variableOverrides: variables,
          /* 触发人 = Token 签发人（P9-1 收件口径）：站内通知据此定点发。 */
          trigger: { source: "manual", userId: identity.createdBy },
        });
        auditMcpAction("mcp_tool.execute", "run_flow", identity, flowExecutionId, { flowId: id.value });
        return toolResult({ flowExecutionId, status: "queued" });
      } catch (error) {
        return toolError(triggerErrorText(error, "flow could not be queued"));
      }
    },
  },
  {
    name: "trigger_suite_run",
    description: "Queue a run of a SAVED test suite (members resolve at queue time and freeze into the run). Optional environmentId overrides the suite's environment for this run; optional variables are per-trigger overrides. Deduplicated: while this suite already has a queued or running execution, the existing executionId is returned.",
    scope: "execute",
    inputSchema: {
      type: "object",
      properties: {
        suiteId: { type: "string" },
        environmentId: { type: "string" },
        variables: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["suiteId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "suiteId", "suite");
      if ("error" in id) return toolError(id.error);
      const environmentId = typeof args.environmentId === "string" && args.environmentId.trim() ? args.environmentId.trim() : undefined;
      const variables = typeof args.variables === "object" && args.variables !== null && !Array.isArray(args.variables)
        ? Object.fromEntries(Object.entries(args.variables).map(([key, value]) => [key, String(value)]))
        : undefined;

      const inFlight = await pool.query(
        "SELECT id FROM suite_executions WHERE suite_id = $1 AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
        [id.value],
      );
      if (inFlight.rowCount) {
        const suiteExecutionId = String(inFlight.rows[0].id);
        return toolResult({ suiteExecutionId, status: "already_running", deduplicated: true });
      }

      try {
        const suiteExecutionId = await triggerSuiteRun({
          projectId: identity.projectId,
          suiteId: id.value,
          environmentId,
          variables,
          /* 触发人 = Token 签发人（P9-1 收件口径）：站内通知据此定点发。 */
          trigger: { source: "manual", userId: identity.createdBy },
        });
        auditMcpAction("mcp_tool.execute", "trigger_suite_run", identity, suiteExecutionId, { suiteId: id.value });
        return toolResult({ suiteExecutionId, status: "queued" });
      } catch (error) {
        return toolError(triggerErrorText(error, "suite could not be queued"));
      }
    },
  },
  {
    name: "trigger_ci_task_run",
    description: "Queue a CI task run on its runner partition (fails fast if no online runner serves the label, with a clear error instead of a forever-queued run). Optional parameters become the task's parameters for this run; caseFilter.caseKeys selects a subset. Deduplicated: while this task already has a queued/claimed/running pipeline run, that runId is returned — single-concurrency tasks queue anyway, so this returns the queued one rather than stacking another.",
    scope: "execute",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        parameters: { type: "object", additionalProperties: { type: "string" } },
        caseFilter: { type: "object", description: "{caseKeys: [...]} to run a subset; omit to run the full set" },
      },
      required: ["taskId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "taskId", "CI task");
      if ("error" in id) return toolError(id.error);
      const parameters = typeof args.parameters === "object" && args.parameters !== null && !Array.isArray(args.parameters)
        ? Object.fromEntries(Object.entries(args.parameters).map(([key, value]) => [key, String(value)]))
        : undefined;
      const caseFilter = typeof args.caseFilter === "object" && args.caseFilter !== null && !Array.isArray(args.caseFilter)
        ? (args.caseFilter as { caseKeys?: unknown })
        : undefined;

      /* 在途去重：pipeline_runs 的在途集含 claimed / cancelling（Runner 协议的四态）。 */
      const inFlight = await pool.query(
        "SELECT id FROM pipeline_runs WHERE ci_task_id = $1 AND status IN ('queued', 'claimed', 'running', 'cancelling') ORDER BY created_at DESC LIMIT 1",
        [id.value],
      );
      if (inFlight.rowCount) {
        const runId = String(inFlight.rows[0].id);
        return toolResult({ runId, status: "already_running", deduplicated: true });
      }

      try {
        const run = await triggerCiTaskRun({
          projectId: identity.projectId,
          ciTaskId: id.value,
          parameters,
          caseFilter,
          triggeredBy: identity.createdBy,
        });
        auditMcpAction("mcp_tool.execute", "trigger_ci_task_run", identity, run.id, { taskId: id.value });
        return toolResult({ runId: run.id, status: run.status });
      } catch (error) {
        /* 幂等命中不是失败（REST 面同款）：回首次那条 run。 */
        if (error instanceof IdempotentReplayError) {
          return toolResult({ runId: error.run.id, status: error.run.status, deduplicated: true });
        }
        return toolError(triggerErrorText(error, "CI task could not be triggered"));
      }
    },
  },
];
