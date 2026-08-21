import { evaluateAssertions } from "./assert.js";
import { applyExtracts } from "./flow.js";
import { resolveDeep } from "./resolve.js";
import { sanitizeValue } from "./sanitize.js";
import { executeSql } from "./sqlExecutor.js";
import type { LoadedEnvironment } from "./run.js";
import type { Assertion, FlowExtract, SqlParameterDefinition, SqlStatementType } from "../models/types.js";

/**
 * 数据库步骤的执行与断言，流程数据库节点与场景数据库步骤共用（计划 5.0.3 第 1 批：
 * 「与场景数据库步骤共用同一套执行与断言实现」）。
 *
 * 两处唯一的差别是配置存在哪份文档里，判定、断言主体、提取语义与限流必须一致——
 * 各写一份的结果一定是「同一条 SQL 在流程里通过、在场景里失败」。
 */

/** A database call with its SQL already resolved and no credentials in sight. */
export type PreparedDatabaseWork = {
  dataSourceId: string;
  statementType: SqlStatementType;
  sql: string;
  parameterDefinitions: SqlParameterDefinition[];
  /** Values at the call site; `{{var}}` is resolved before driver binding. */
  parameters: Record<string, unknown>;
  assertions: Assertion[];
};

export type DatabaseWorkOutcome = {
  status: "success" | "failed";
  durationMs: number;
  error?: string;
  /** Sanitized evidence for `execution_steps.output_snapshot`. */
  output: Record<string, unknown>;
  /** Raw values for the variable bag. Empty when the step failed. */
  extracted: Record<string, string>;
};

/**
 * 数据库结果用与 HTTP 相同的断言/提取主体：状态 200 + JSON content-type 是适配契约，
 * 于是 `$.rows[0].id` 在两种步骤里含义完全一样，断言编辑器也不需要第二套语法。
 */
const SUBJECT_HEADERS = { "content-type": "application/json" };

export async function executeDatabaseWork(
  projectId: string,
  work: PreparedDatabaseWork,
  bag: Record<string, string>,
  environment: LoadedEnvironment,
  extracts: FlowExtract[],
): Promise<DatabaseWorkOutcome> {
  /* Same opt-out as a request step: a plaintext project keeps its evidence raw. */
  const mask = (value: unknown) => environment.storePlaintext ? value : sanitizeValue(value, environment.secretValues);
  try {
    const values = resolveDeep(work.parameters, bag) as Record<string, unknown>;
    const result = await executeSql({
      projectId, dataSourceId: work.dataSourceId, statementType: work.statementType,
      sql: work.sql, params: work.parameterDefinitions, values,
    });
    const body = JSON.stringify({ rows: result.rows, rowCount: result.rowCount, truncated: result.truncated });
    const assertion = evaluateAssertions(work.assertions ?? [], { statusCode: 200, headers: SUBJECT_HEADERS, body });
    const extraction = applyExtracts(extracts, { statusCode: 200, headers: SUBJECT_HEADERS, body });
    const assertionFailed = assertion.results.some((item) => !item.passed);
    const extractFailed = extraction.results.some((item) => !item.ok);
    return {
      status: assertionFailed || extractFailed ? "failed" : "success",
      durationMs: result.durationMs,
      error: assertionFailed ? "one or more assertions failed" : extractFailed ? "one or more extracts failed" : undefined,
      output: mask({
        rows: result.rows, rowCount: result.rowCount, truncated: result.truncated,
        assertionResults: assertion.results, extractResults: extraction.results,
      }) as Record<string, unknown>,
      /* A failed step contributes nothing: the same transaction boundary a request
         step has, so a half-verified query cannot seed the next step. */
      extracted: assertionFailed || extractFailed ? {} : extraction.values,
    };
  } catch (error) {
    return {
      status: "failed", durationMs: 0,
      error: error instanceof Error ? error.message : "database execution failed",
      output: { rows: [], rowCount: 0, truncated: false }, extracted: {},
    };
  }
}
