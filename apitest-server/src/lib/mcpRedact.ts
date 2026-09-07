import { pool } from "../db.js";
import { mapExecution, type Execution } from "../models/types.js";
import { sanitizeHeaders, sanitizeValue } from "./sanitize.js";

/**
 * MCP 读工具的脱敏与截断纪律（P5-4，计划 9.5——本阶段最锋利的一条）。
 *
 * 既有脱敏发生在**写入时**（`lib/run.ts` 的 maskHeaders / maskValue），所以库里存的东西
 * 不能直接转发给外部 agent：`store_plaintext` 项目的行写入时就没遮过，且写入时的遮蔽
 * 用的是**当时**的 secret——已轮换的旧值遮不住，在用的新值更遮不住。MCP 读执行证据时
 * 一律按该执行环境**当前的** secret 值重跑 `sanitizeHeaders` / `sanitizeValue`。
 *
 * `store_plaintext` 不参与判定：那个开关的受众是内部人读界面，不是外部 agent 读工具。
 */

/** 单个工具返回值的字节上限（9.5：一个 5MB 响应体会直接撑爆模型上下文）。 */
export const MCP_MAX_RESULT_BYTES = 64 * 1024;

/** 按字节从头截断，UTF-8 边界处退一个字符——与 `lib/notify.ts` 的 truncateBytes 同款。 */
export function truncateText(text: string, maxBytes = MCP_MAX_RESULT_BYTES): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let cut = text.slice(0, Math.floor((maxBytes * text.length) / Buffer.byteLength(text, "utf8")));
  while (Buffer.byteLength(cut, "utf8") > maxBytes - 3) cut = cut.slice(0, -1);
  return { text: `${cut}...`, truncated: true };
}

/**
 * 按字节**从尾保留**（日志尾部优先）：预算内装不下时从头切，切点前进到下一个换行，
 * 保证第一行是整行。按字符推进切点，多字节字符天然不会被切半。
 */
export function tailText(text: string, maxBytes = MCP_MAX_RESULT_BYTES): { text: string; truncated: boolean } {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return { text, truncated: false };
  let cut = Math.max(0, text.length - Math.ceil((maxBytes * text.length) / totalBytes));
  while (cut < text.length && Buffer.byteLength(text.slice(cut), "utf8") > maxBytes) cut += 1;
  const newline = text.indexOf("\n", cut);
  return { text: text.slice(newline === -1 ? cut : newline + 1), truncated: true };
}

/**
 * 某环境**当前**的 secret 值集合。
 *
 * `undefined` = 环境已删（迁移 002 的 SET NULL）——「无从得知要遮哪些字符串」，失败朝
 * 安全那边倒（边界 6）。空数组 = 环境还在、没配 secret，此时脱敏照跑
 * （`SENSITIVE_HEADERS` 仍会被无条件遮掉）。
 */
export async function environmentSecretValues(projectId: string, environmentId: string | null | undefined): Promise<string[] | undefined> {
  if (!environmentId) return undefined;
  const result = await pool.query("SELECT secrets FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  if (!result.rowCount) return undefined;
  return Object.values((result.rows[0].secrets ?? {}) as Record<string, string>).filter(Boolean);
}

/**
 * 项目**全部环境**当前 secret 值的并集（2026-09-06 边界修订，见文件尾的判定顺序）。
 *
 * 无环境执行的遮蔽集：执行自己没带环境，但项目里声明过的 secret 仍然不该流进对话
 * 记录——并集是平台手里最宽的声明集，遮得只多不少。没声明任何 secret 的项目返回
 * 空数组 = 证据按原文流动（这就是用户要的「原生内容」；遮蔽从定义上就无事可做）。
 */
export async function projectSecretValues(projectId: string): Promise<string[]> {
  const result = await pool.query("SELECT secrets FROM environments WHERE project_id = $1", [projectId]);
  const values = new Set<string>();
  for (const row of result.rows) {
    for (const value of Object.values((row.secrets ?? {}) as Record<string, string>)) {
      if (value) values.add(value);
    }
  }
  return [...values];
}

/**
 * CI 任务环境变量的**当前**值集合（任务与报告读取的同一条红线，2026-09-04 扩界）。
 *
 * 仓库凭据加密存储、只注入不出明文，不进遮蔽集——这里的遮蔽集就是任务 `env` 这一列。
 * 过短的值（< 8 字符）不进遮蔽集：`TEST_ENV=stg` 这类配置值遮掉会把日志里所有出现处
 * 变成 `***`，而短字符串不携带值得保护的熵。
 */
export async function ciTaskEnvValues(projectId: string, ciTaskId: string): Promise<string[]> {
  const result = await pool.query("SELECT env FROM ci_tasks WHERE id = $1 AND project_id = $2", [ciTaskId, projectId]);
  if (!result.rowCount) return [];
  return Object.values((result.rows[0].env ?? {}) as Record<string, string>)
    .filter((value) => typeof value === "string" && value.length >= 8);
}

/** 环境不在了就整体不给的「证据字段」：请求/响应及其派生、四类执行证据数组。 */
type ExecutionEvidenceKeys =
  | "request" | "responseHeaders" | "responseContentType" | "responseSizeBytes" | "responseTruncated"
  | "responseBody" | "assertionResults" | "extractResults" | "hookResults" | "responseScriptResults";

/** `get_execution` 的回值：身份字段恒在；证据字段可选（环境已删就不给，边界 6）。 */
export type McpExecutionPayload = Omit<Execution, ExecutionEvidenceKeys>
  & Partial<Pick<Execution, ExecutionEvidenceKeys>>
  & {
    /** 环境已删时：证据字段整体不给，给一句说明（边界 6）。 */
    bodyOmitted?: string;
    /** responseBody 被截到 64KB 时为 true。 */
    responseBodyTruncated?: boolean;
    /** 遮蔽范围：执行自带环境（该环境的 secret）/ 执行没带环境（项目全部环境的并集）。
        值里出现 `***` 时，agent 能据此解释遮蔽从哪来。 */
    masking?: "environment" | "project";
  };

/**
 * 一条 executions 行 → 脱敏后的 MCP 回值（9.5 判定顺序的实现，含 2026-09-06 修订）。
 *
 * 1. 取 executions.environment_id：
 *    - 有值 → 读该环境当前 secrets → sanitizeHeaders + sanitizeValue 对
 *      request_snapshot / response_headers / response_body / 各证据数组重跑；
 *    - NULL 且 environment_name 快照**有值** → 环境事后被删（迁移 002 的 SET NULL）：
 *      当时的 secret 值已随之消失、无从重遮，证据字段整体不给，返回 bodyOmitted
 *      （边界 6 原样保留）；
 *    - NULL 且快照也**无值** → 这次执行本就没带环境（2026-09-06 修订：原实现把这一支
 *      与「环境已删」一起整体不给，堵死了「run → 读响应 → 写断言」的 agent 校验闭环）。
 *      改为按**项目全部环境当前 secret 的并集**重跑脱敏后返回——声明过的 secret 仍然
 *      不进对话记录；一个没声明任何 secret 的项目等于按原文返回。请求侧另有 P5-5a
 *      写入守卫兜底（字面量凭据在 create/update 时就被拒），这条通路不新增写入面。
 * 2. store_plaintext 不参与判定（该开关对 MCP 不生效，边界 5）。
 */
export async function redactExecutionForMcp(projectId: string, row: Record<string, unknown>): Promise<McpExecutionPayload> {
  const execution = mapExecution(row);
  const hadEnvironment = Boolean(execution.environmentName);
  const secrets = await environmentSecretValues(projectId, execution.environmentId);
  if (secrets === undefined && hadEnvironment) {
    const {
      request, responseHeaders, responseBody, responseContentType, responseSizeBytes, responseTruncated,
      assertionResults, extractResults, hookResults, responseScriptResults,
      ...identity
    } = execution;
    return {
      ...identity,
      bodyOmitted: "the environment of this run was deleted; its secret values are gone and cannot be re-masked, so request/response evidence is omitted",
    };
  }
  /* 没带环境的执行：并集遮蔽（没声明 secret 的项目 = 空集 = 原文）。 */
  const maskValues = secrets ?? await projectSecretValues(projectId);
  const masking: "environment" | "project" = secrets === undefined ? "project" : "environment";

  const payload: McpExecutionPayload = {
    ...execution,
    masking,
    request: {
      ...execution.request,
      headers: sanitizeHeaders(execution.request?.headers ?? {}, maskValues),
      body: sanitizeValue(execution.request?.body, maskValues),
    },
    responseHeaders: sanitizeHeaders(execution.responseHeaders ?? {}, maskValues),
    error: execution.error === undefined ? undefined : String(sanitizeValue(execution.error, maskValues)),
    assertionResults: sanitizeValue(execution.assertionResults, maskValues) as Execution["assertionResults"],
    extractResults: sanitizeValue(execution.extractResults, maskValues) as Execution["extractResults"],
    hookResults: sanitizeValue(execution.hookResults, maskValues) as Execution["hookResults"],
    responseScriptResults: sanitizeValue(execution.responseScriptResults, maskValues) as Execution["responseScriptResults"],
  };
  if (payload.responseBody !== undefined) {
    const masked = String(sanitizeValue(payload.responseBody, maskValues));
    const { text, truncated } = truncateText(masked);
    payload.responseBody = text;
    if (truncated) payload.responseBodyTruncated = true;
  }
  return payload;
}
