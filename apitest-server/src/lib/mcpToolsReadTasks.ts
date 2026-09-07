import { pool } from "../db.js";
import { ciTaskEnvValues, tailText, truncateText } from "./mcpRedact.js";
import { pageArgs, requiredUuidArg, stringArg, toolError, toolResult } from "./mcpToolResult.js";
import type { McpToolDefinition } from "./mcpServer.js";
import { loadSuiteReport, loadRunnerReport, findReportArtifactRow, loadReportView } from "./reportPayload.js";
import { sanitizeValue } from "./sanitize.js";
import { loadSuite } from "./trigger.js";
import {
  mapCiTask, mapPipelineRun, mapPipelineRunCase, mapSchedule, mapSuiteExecution, mapTestSuite,
} from "../models/types.js";

/**
 * 只读工具第二批（P5-4b，计划 9.4「任务与报告读」9 个）：套件 / CI 任务 / run / 报告 /
 * 日志 / 仓库用例。
 *
 * 报告数据走 `lib/reportPayload.ts` 的同一份拼装（不产生第二套口径）；日志与失败明细
 * 用 CI 任务环境变量的当前值重跑脱敏 + 尾部优先 + 64KB 上限（9.5 的任务与报告红线）。
 */

/** 调度列表的读取形状：目标名由 target_type 判据的两个 LEFT JOIN 带出（schedules.ts 同款）。 */
const SELECT_SCHEDULE = `SELECT s.*, COALESCE(ts.name, ct.name) AS target_name FROM schedules s
  LEFT JOIN test_suites ts ON s.target_type = 'suite' AND ts.id = s.target_id
  LEFT JOIN ci_tasks ct ON s.target_type = 'ci_task' AND ct.id = s.target_id`;

/** CI 任务的 env 只回键名不回值（9.5：env 值是日志遮蔽集的素材，不该从另一个工具流出去）。 */
function ciTaskSummary(row: Record<string, unknown>) {
  const { env, ...task } = mapCiTask(row);
  return { ...task, envKeys: Object.keys(env ?? {}).sort() };
}

/** 列表行里的最近一次套件运行（DISTINCT ON 同款读法，只带轻量字段）。 */
async function suiteLastRuns(suiteIds: string[]) {
  if (!suiteIds.length) return new Map<string, { id: string; status: string; total: number; successCount: number; failedCount: number; finishedAt?: string }>();
  const result = await pool.query(
    `SELECT DISTINCT ON (suite_id) * FROM suite_executions
       WHERE suite_id = ANY($1::uuid[]) ORDER BY suite_id, created_at DESC`,
    [suiteIds],
  );
  return new Map(result.rows.map((row) => {
    const run = mapSuiteExecution(row);
    return [String(row.suite_id), {
      id: run.id, status: run.status, total: run.total,
      successCount: run.successCount, failedCount: run.failedCount, finishedAt: run.finishedAt,
    }];
  }));
}

export const READ_TASKS_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "list_suites",
    description: "List test suites with keyword filter and paging; each row carries id, selection and its most recent run summary. Suites orchestrate members (cases/flows) without passing variables between them — a chain that needs data flow should be a flow, not a suite. Cannot create, modify, delete or run suites from here.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "substring match against name and description" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: async (args, identity) => {
      const { page, pageSize, offset } = pageArgs(args);
      const params: unknown[] = [identity.projectId];
      const clauses = ["project_id = $1"];
      const keyword = stringArg(args, "keyword");
      if (keyword) {
        params.push(`%${keyword}%`);
        clauses.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
      }
      const where = clauses.join(" AND ");
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM test_suites WHERE ${where}`, params);
      params.push(pageSize, offset);
      const result = await pool.query(
        `SELECT * FROM test_suites WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const suites = result.rows.map(mapTestSuite);
      const runs = await suiteLastRuns(suites.map((suite) => suite.id));
      return toolResult({
        suites: suites.map((suite) => ({ ...suite, lastRun: runs.get(suite.id) })),
        page, pageSize, total: Number(count.rows[0].total),
      });
    },
  },
  {
    name: "get_suite",
    description: "One suite's full definition (selection, execution config, notify config) plus every schedule that targets it — there is no separate list_schedules tool, so schedules travel with their target. Cannot run it (trigger_suite_run) or modify it.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { suiteId: { type: "string", description: "suite id from list_suites" } },
      required: ["suiteId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "suiteId", "suite");
      if ("error" in id) return toolError(id.error);
      const suite = await loadSuite(identity.projectId, id.value);
      if (!suite) return toolError("test suite not found (2001)");
      const schedules = await pool.query(
        `${SELECT_SCHEDULE} WHERE s.project_id = $1 AND s.target_type = 'suite' AND s.target_id = $2 ORDER BY s.created_at`,
        [identity.projectId, id.value],
      );
      return toolResult({ ...suite, schedules: schedules.rows.map(mapSchedule) });
    },
  },
  {
    name: "list_ci_tasks",
    description: "List CI tasks with keyword filter and paging; each row carries its active/latest run and run total. Task env values are not returned (envKeys only) — they are treated as secret material for log masking. Cannot create, modify, delete or trigger tasks from here.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "substring match against name, description and git url" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: async (args, identity) => {
      const { page, pageSize, offset } = pageArgs(args);
      const params: unknown[] = [identity.projectId];
      let where = "t.project_id = $1";
      const keyword = stringArg(args, "keyword");
      if (keyword) {
        params.push(`%${keyword}%`);
        where += ` AND (t.name ILIKE $${params.length} OR t.description ILIKE $${params.length} OR t.git_url ILIKE $${params.length})`;
      }
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM ci_tasks t WHERE ${where}`, params);
      params.push(pageSize, offset);
      /* 两段 LATERAL（在途 + 最近一条/总数）与 REST 列表同款 SQL——列表的行内提示口径只有一份。 */
      const result = await pool.query(
        `SELECT t.*, c.name AS git_credential_name, c.method AS git_credential_method,
                ar.active_run_count, ar.active_run_id, ar.active_run_number, ar.active_run_status,
                lr.run_total, lr.last_run_id, lr.last_run_number, lr.last_run_status
           FROM ci_tasks t
           LEFT JOIN git_credentials c ON c.id = t.git_credential_id
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS active_run_count,
                    (ARRAY_AGG(id ORDER BY run_number DESC))[1] AS active_run_id,
                    (ARRAY_AGG(run_number ORDER BY run_number DESC))[1] AS active_run_number,
                    (ARRAY_AGG(status ORDER BY run_number DESC))[1] AS active_run_status
               FROM pipeline_runs
              WHERE ci_task_id = t.id AND status IN ('queued', 'claimed', 'running', 'cancelling')
           ) ar ON true
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS run_total,
                    (ARRAY_AGG(id ORDER BY run_number DESC))[1] AS last_run_id,
                    (ARRAY_AGG(run_number ORDER BY run_number DESC))[1] AS last_run_number,
                    (ARRAY_AGG(status ORDER BY run_number DESC))[1] AS last_run_status
               FROM pipeline_runs WHERE ci_task_id = t.id
           ) lr ON true
          WHERE ${where}
          ORDER BY t.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return toolResult({
        ciTasks: result.rows.map(ciTaskSummary),
        page, pageSize, total: Number(count.rows[0].total),
      });
    },
  },
  {
    name: "get_ci_task",
    description: "One CI task's full definition — git source (url + credential reference by id only; the credential itself is never readable), steps, cache config, notify config — plus its schedules and latest run summary. Env values are not returned (envKeys only): they are masking material for logs. Cannot modify or trigger; use update_ci_task / trigger_ci_task_run.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "CI task id from list_ci_tasks" } },
      required: ["taskId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "taskId", "CI task");
      if ("error" in id) return toolError(id.error);
      const result = await pool.query(
        `SELECT t.*, c.name AS git_credential_name, c.method AS git_credential_method
           FROM ci_tasks t LEFT JOIN git_credentials c ON c.id = t.git_credential_id
          WHERE t.id = $1 AND t.project_id = $2`,
        [id.value, identity.projectId],
      );
      if (!result.rowCount) return toolError("CI task not found (2001)");
      const schedules = await pool.query(
        `${SELECT_SCHEDULE} WHERE s.project_id = $1 AND s.target_type = 'ci_task' AND s.target_id = $2 ORDER BY s.created_at`,
        [identity.projectId, id.value],
      );
      const total = await pool.query("SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE ci_task_id = $1", [id.value]);
      const last = await pool.query("SELECT * FROM pipeline_runs WHERE ci_task_id = $1 ORDER BY run_number DESC LIMIT 1", [id.value]);
      const lastRun = last.rowCount ? mapPipelineRun(last.rows[0]) : undefined;
      return toolResult({
        ...ciTaskSummary(result.rows[0]),
        schedules: schedules.rows.map(mapSchedule),
        runTotal: Number(total.rows[0].total),
        lastRun,
      });
    },
  },
  {
    name: "list_runs",
    description: "List runs of one resource, newest first: kind='ci' with ciTaskId lists pipeline runs (stage, commit, counts); kind='suite' with suiteId lists suite executions (counts only — the member snapshot is dropped here; get_run_report has it). Rows carry the resource id so two-hop navigation works. Cannot trigger or cancel runs.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "'ci' or 'suite'" },
        ciTaskId: { type: "string", description: "required when kind is ci" },
        suiteId: { type: "string", description: "required when kind is suite" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["kind"],
    },
    handler: async (args, identity) => {
      const { page, pageSize, offset } = pageArgs(args);
      const kind = stringArg(args, "kind");
      if (kind !== "ci" && kind !== "suite") return toolError("kind must be 'ci' or 'suite' (1001)");
      if (kind === "ci") {
        const id = requiredUuidArg(args, "ciTaskId", "CI task");
        if ("error" in id) return toolError(id.error);
        const count = await pool.query("SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE project_id = $1 AND ci_task_id = $2", [identity.projectId, id.value]);
        const result = await pool.query(
          `SELECT * FROM pipeline_runs WHERE project_id = $1 AND ci_task_id = $2
            ORDER BY run_number DESC LIMIT $3 OFFSET $4`,
          [identity.projectId, id.value, pageSize, offset],
        );
        return toolResult({ kind: "ci", ciTaskId: id.value, runs: result.rows.map(mapPipelineRun), page, pageSize, total: Number(count.rows[0].total) });
      }
      const id = requiredUuidArg(args, "suiteId", "suite");
      if ("error" in id) return toolError(id.error);
      const count = await pool.query("SELECT COUNT(*)::int AS total FROM suite_executions WHERE project_id = $1 AND suite_id = $2", [identity.projectId, id.value]);
      const result = await pool.query(
        `SELECT * FROM suite_executions WHERE project_id = $1 AND suite_id = $2
          ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [identity.projectId, id.value, pageSize, offset],
      );
      return toolResult({
        kind: "suite",
        suiteId: id.value,
        /* member_snapshot 刻意不带：列表行要的是状态与计数，成员明细是 get_run_report 的事。 */
        runs: result.rows.map((row) => {
          const { members, ...run } = mapSuiteExecution(row);
          return run;
        }),
        page, pageSize, total: Number(count.rows[0].total),
      });
    },
  },
  {
    name: "get_run_report",
    description: "One run's report, same assembly the UI and share pages use: summary readout (status, trigger, commit for ci runs, counts, pass rate) plus the case list, failures first. Suite member rows carry httpExecutionId so evidence can be fetched via get_execution; ci case rows carry id for get_run_case. Step-level evidence and log excerpts are not included here — use get_run_case / get_run_logs.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "'ci' (with runId) or 'suite' (with executionId)" },
        runId: { type: "string", description: "pipeline run id, when kind is ci" },
        executionId: { type: "string", description: "suite execution id, when kind is suite" },
      },
      required: ["kind"],
    },
    handler: async (args, identity) => {
      const kind = stringArg(args, "kind");
      if (kind === "suite") {
        const id = requiredUuidArg(args, "executionId", "suite execution");
        if ("error" in id) return toolError(id.error);
        const report = await loadSuiteReport(identity.projectId, id.value);
        if (!report) return toolError("report not found (2001)");
        /* 成员的 input/output 快照不带出：套件成员的证据走 get_execution（读时脱敏），
           这里只回「谁跑了、什么结论」。失败优先。 */
        const members = report.members
          .map(({ input, output, ...member }) => member)
          .sort((left, right) => Number(right.status === "failed") - Number(left.status === "failed"));
        return toolResult({ kind: "suite", ...report, members });
      }
      if (kind === "ci") {
        const id = requiredUuidArg(args, "runId", "pipeline run");
        if ("error" in id) return toolError(id.error);
        const loaded = await loadRunnerReport(identity.projectId, id.value);
        if (!loaded) return toolError("pipeline run not found (2001)");
        const { run, taskName, cases, report } = loaded;
        /* 报告视图（allure 全量）刻意不带回：几 MB 的包会撑爆上下文，单条明细走 get_run_case。 */
        const failuresFirst = [...cases].sort((left, right) => {
          const rank = (status: string) => (status === "failed" || status === "error" ? 0 : status === "skipped" ? 1 : 2);
          return rank(left.status) - rank(right.status);
        });
        return toolResult({
          kind: "ci",
          taskName,
          run,
          reportAvailable: Boolean(report),
          cases: failuresFirst.map((item) => ({
            id: item.id, suiteName: item.suiteName, caseName: item.caseName, status: item.status,
            durationMs: item.durationMs, startedAtMs: item.startedAtMs, externalId: item.externalId,
          })),
        });
      }
      return toolError("kind must be 'ci' or 'suite' (1001)");
    },
  },
  {
    name: "get_run_case",
    description: "One CI run case's failure detail: status, message, allure step tree (when a report bundle exists), trace and parameters — masked against the CI task's current env values and truncated to 64KB. Suite reports have no pipeline case rows; their member evidence is read via get_execution. Cannot re-run a single case.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { runCaseId: { type: "string", description: "case row id from get_run_report (kind ci)" } },
      required: ["runCaseId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "runCaseId", "run case");
      if ("error" in id) return toolError(id.error);
      const result = await pool.query(
        `SELECT prc.*, pr.ci_task_id FROM pipeline_run_cases prc
           JOIN pipeline_runs pr ON pr.id = prc.pipeline_run_id
          WHERE prc.id = $1 AND pr.project_id = $2`,
        [id.value, identity.projectId],
      );
      if (!result.rowCount) return toolError("run case not found (2001)");
      const row = result.rows[0];
      const runId = String(row.pipeline_run_id);
      const secrets = await ciTaskEnvValues(identity.projectId, String(row.ci_task_id));
      const mask = (text: string | null | undefined) =>
        text === undefined || text === null ? undefined : String(sanitizeValue(text, secrets));

      const payload: Record<string, unknown> = {
        ...mapPipelineRunCase(row),
        message: undefined,
      };
      if (row.message !== null && row.message !== undefined) {
        const { text, truncated } = truncateText(mask(String(row.message)) ?? "");
        payload.message = text;
        if (truncated) payload.messageTruncated = true;
      }

      /* allure 明细：报告包存在才读；externalId 是结果文件的 uid，参数化用例靠它对上。 */
      const artifact = await findReportArtifactRow(runId);
      if (artifact) {
        try {
          const view = await loadReportView(String(artifact.id), String(artifact.storage_driver), String(artifact.storage_key));
          const externalId = typeof payload.externalId === "string" ? payload.externalId : undefined;
          const match = (externalId ? view.cases.find((item) => item.uid === externalId) : undefined)
            ?? view.cases.find((item) => item.fullName === `${payload.suiteName}.${payload.caseName}`);
          if (match) {
            if (match.trace) {
              const { text, truncated } = truncateText(mask(match.trace) ?? "", 8 * 1024);
              payload.trace = text;
              if (truncated) payload.traceTruncated = true;
            }
            if (match.description) payload.description = truncateText(String(match.description), 4 * 1024).text;
            const steps = sanitizeValue(match.steps, secrets);
            /* 步骤树超预算就整体不给：截断 JSON 会留下读不了的半截结构。 */
            if (JSON.stringify(steps).length > 32 * 1024) payload.stepsOmitted = "step tree exceeds 32KB; read the full report in the UI";
            else payload.steps = steps;
            payload.parameters = sanitizeValue(match.parameters, secrets);
          }
        } catch {
          /* 报告包读不出来不该废掉整条明细：DB 行上的事实照回，allure 部分降级为缺席。 */
        }
      }
      return toolResult(payload);
    },
  },
  {
    name: "get_run_logs",
    description: "A CI run's log, tail-first: the last `tail` lines (default 200) capped at 64KB from the end — models need the error section, not the full流水. Masked against the CI task's current env values. totalBytes tells how much exists; truncatedAtHead means the 64KB budget cut older lines. Cannot stream or download attachments.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "pipeline run id" },
        tail: { type: "integer", minimum: 1, maximum: 2000, description: "number of trailing lines to return (default 200)" },
      },
      required: ["runId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "runId", "pipeline run");
      if ("error" in id) return toolError(id.error);
      const run = await pool.query("SELECT log_bytes, ci_task_id FROM pipeline_runs WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!run.rowCount) return toolError("pipeline run not found (2001)");
      const tail = Math.min(2000, Math.max(1, Math.trunc(Number(args.tail ?? 200)) || 200));
      const chunks = await pool.query("SELECT chunk FROM pipeline_run_logs WHERE pipeline_run_id = $1 ORDER BY byte_offset", [id.value]);
      const full = chunks.rows.map((chunk) => String(chunk.chunk)).join("");
      const tailLines = full.split("\n").slice(-tail).join("\n");
      const secrets = await ciTaskEnvValues(identity.projectId, String(run.rows[0].ci_task_id));
      const masked = String(sanitizeValue(tailLines, secrets));
      const { text, truncated } = tailText(masked);
      return toolResult({
        runId: id.value,
        tail,
        totalBytes: Number(run.rows[0].log_bytes ?? 0),
        truncatedAtHead: truncated,
        log: text,
      });
    },
  },
  {
    name: "list_repo_cases",
    description: "Repository-reported test cases as a flat list along the coverage tree path: each row is one case-to-endpoint relation with the endpoint's id/name/method/url, plus the case's last result. Unplaced cases (reported but hitting no registered endpoint) are counted separately — the row total will not include them. Cannot register, link or unlink cases; that is the REST UI's unmatched workflow.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "substring match against case name / case_key / file path and endpoint name / url" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: async (args, identity) => {
      const { page, pageSize, offset } = pageArgs(args);
      const params: unknown[] = [identity.projectId];
      const clauses = ["c.project_id = $1", "c.status = 'active'"];
      const keyword = stringArg(args, "keyword");
      if (keyword) {
        params.push(`%${keyword}%`);
        clauses.push(`(c.name ILIKE $${params.length} OR c.case_key ILIKE $${params.length} OR c.file_path ILIKE $${params.length} OR e.name ILIKE $${params.length} OR e.url ILIKE $${params.length})`);
      }
      const where = clauses.join(" AND ");
      const joins = `FROM repo_test_cases c
         JOIN repo_case_endpoints r ON r.repo_case_id = c.id
         JOIN endpoints e ON e.id = r.endpoint_id AND e.project_id = c.project_id`;
      const count = await pool.query(`SELECT COUNT(*)::int AS total ${joins} WHERE ${where}`, params);
      params.push(pageSize, offset);
      const result = await pool.query(
        `SELECT c.id, c.repository_id, c.case_key, c.name, c.file_path, c.last_result, c.last_run_at,
                e.id AS endpoint_id, e.name AS endpoint_name, e.method, e.url
           ${joins}
          WHERE ${where}
          ORDER BY e.method, e.url, c.name
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      /* 未归位数单独给个数（边界 21）：藏掉会让人把「上报了 36 条、树上 31 条」当 bug 报。 */
      const unplaced = await pool.query(
        `SELECT COUNT(*)::int AS total FROM repo_test_cases c
          WHERE c.project_id = $1 AND c.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM repo_case_endpoints r WHERE r.repo_case_id = c.id)`,
        [identity.projectId],
      );
      return toolResult({
        cases: result.rows.map((row) => ({
          caseId: String(row.id),
          repositoryId: String(row.repository_id),
          caseKey: String(row.case_key),
          name: String(row.name),
          filePath: String(row.file_path ?? ""),
          lastResult: String(row.last_result ?? "unknown"),
          lastRunAt: row.last_run_at ? new Date(String(row.last_run_at)).toISOString() : undefined,
          endpointId: String(row.endpoint_id),
          endpointName: String(row.endpoint_name),
          method: String(row.method),
          url: String(row.url),
        })),
        unplacedCaseTotal: Number(unplaced.rows[0].total),
        page, pageSize, total: Number(count.rows[0].total),
      });
    },
  },
];
