import { getAdapter } from "./adapters/index.js";
import { validateSqlParams } from "./adapters/common.js";
import { SUPERSET_FLAGS, validateStatement } from "./adapters/skeleton.js";
import type { SqlExecutionInput, SqlExecutionResult } from "./adapters/types.js";
import { loadDataSource } from "./dataSources.js";
import type { SqlParameterDefinition, SqlStatementType } from "./models/types.js";

export type { SqlExecutionInput, SqlExecutionResult } from "./adapters/types.js";
export { validateSqlParams };

/**
 * Definition-time validation when the target data source type is not at hand
 * (flow node inline SQL, SQL definition editor). Uses the union of every
 * dialect's quoting/comment styles, so it accepts anything any dialect would
 * and is deliberately a superset. The authoritative security boundary is the
 * adapter's own exact-dialect validation at execution time.
 */
export function validateSqlDefinition(statementType: SqlStatementType, sql: string, params?: SqlParameterDefinition[]): string | undefined {
  return validateSqlParams(params) ?? validateStatement(sql, statementType, SUPERSET_FLAGS);
}

/** Dispatches to the adapter registered for the data source's type. The driver,
    placeholder dialect and transaction/limit mechanics are the adapter's
    concern; the caller (route, database step) only supplies the SQL contract. */
export async function executeSql(input: SqlExecutionInput): Promise<SqlExecutionResult> {
  const source = await loadDataSource(input.projectId, input.dataSourceId);
  const adapter = getAdapter(source.type);
  if (!adapter) throw new Error(`data source type "${source.type}" is not supported yet`);
  return adapter.execute(input, { type: source.type, config: source.config, password: source.password });
}
