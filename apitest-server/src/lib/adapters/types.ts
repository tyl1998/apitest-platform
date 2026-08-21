import type { DataSourceConfig, DataSourceType, SqlParameterDefinition, SqlStatementType } from "../../models/types.js";

export type SqlExecutionInput = {
  projectId: string;
  dataSourceId: string;
  statementType: SqlStatementType;
  sql: string;
  params?: SqlParameterDefinition[];
  values?: Record<string, unknown>;
  timeoutMs?: number;
  maxRows?: number;
  maxResultBytes?: number;
};

export type SqlExecutionResult = {
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
};

/** Decrypted connection facts handed to an adapter by the executeSql dispatcher. */
export type ResolvedSource = {
  type: DataSourceType;
  config: DataSourceConfig;
  password?: string;
};

/**
 * A relational-dialect adapter. Everything that differs between the SQL-capable
 * data source types lives here: statement validation (exact dialect — this is
 * the execution-time security boundary), `{{name}}` placeholder compilation and
 * the connect/run/limit mechanics. Parameter validation, value conversion and
 * row/byte truncation are shared in common.ts.
 */
export type SqlAdapter = {
  type: DataSourceType;
  validateStatement(sql: string, statementType: SqlStatementType): string | undefined;
  compile(sql: string, definitions: SqlParameterDefinition[], supplied: Record<string, unknown>): { sql: string; values: unknown[] };
  execute(input: SqlExecutionInput, source: ResolvedSource): Promise<SqlExecutionResult>;
};
