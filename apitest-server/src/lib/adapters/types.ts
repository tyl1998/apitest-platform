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

/** A mongo/redis execution: the named-definition payload is a `kind` plus an
    operation document, not SQL (P2-7.3). Same result shape as SQL so the
    database step's assertions/extracts stay one code path. */
export type OperationExecutionInput = {
  projectId: string;
  dataSourceId: string;
  kind: "mongo" | "redis";
  operation: unknown;
  params?: SqlParameterDefinition[];
  values?: Record<string, unknown>;
  timeoutMs?: number;
  maxRows?: number;
  maxResultBytes?: number;
};

/** Decrypted connection facts handed to an adapter by the executeSql dispatcher. */
export type ResolvedSource = {
  type: DataSourceType;
  config: DataSourceConfig;
  password?: string;
};

/** The compiled statement plus, aligned by index with `values`, the parameter
    definition that produced each value slot. `?` / `:n` / `@pn` all bind
    positionally; the type is what lets mssql/oracle pick a driver bind type
    (NVarChar vs Float vs DATE), including for null and json values. */
export type CompiledSql = { sql: string; values: unknown[]; definitions: SqlParameterDefinition[] };

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
  compile(sql: string, definitions: SqlParameterDefinition[], supplied: Record<string, unknown>): CompiledSql;
  execute(input: SqlExecutionInput, source: ResolvedSource): Promise<SqlExecutionResult>;
};

/** A mongo/redis driver: same lifecycle as a SQL adapter but executes an
    operation document instead of a SQL statement. */
export type OperationDriver = {
  type: DataSourceType;
  execute(input: OperationExecutionInput, source: ResolvedSource): Promise<SqlExecutionResult>;
};
