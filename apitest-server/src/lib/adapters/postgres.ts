import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { clamp, compileSql, DEFAULT_MAX_BYTES, hasRowLimitClause, HARD_MAX_BYTES, resolveMaxRows, truncateRows, validateSqlParams } from "./common.js";
import { sqlSkeleton, validateStatement, type SkeletonFlags } from "./skeleton.js";
import type { SqlAdapter, SqlExecutionInput, SqlExecutionResult } from "./types.js";

const PG_SKELETON: SkeletonFlags = { dollarQuoted: true };

const adapter: SqlAdapter = {
  type: "postgresql",
  validateStatement: (sql, statementType) => validateStatement(sql, statementType, PG_SKELETON),
  compile: (sql, definitions, supplied) => compileSql(sql, definitions, supplied, (index) => `$${index}`, PG_SKELETON),
  execute: async (input: SqlExecutionInput, source): Promise<SqlExecutionResult> => {
    const paramsError = validateSqlParams(input.params);
    if (paramsError) throw new Error(paramsError);
    const statementError = validateStatement(input.sql, input.statementType, PG_SKELETON);
    if (statementError) throw new Error(statementError);
    const skeleton = sqlSkeleton(input.sql, PG_SKELETON); const terminator = skeleton.indexOf(";");
    const normalizedSql = terminator < 0 ? input.sql : input.sql.slice(0, terminator);
    const compiled = compileSql(normalizedSql, input.params ?? [], input.values ?? {}, (index) => `$${index}`, PG_SKELETON);
    const config = source.config;
    /* No row-limiting clause on a query = full-table scan; capped at 200 rows. */
    const fullScan = input.statementType === "query" && !hasRowLimitClause(skeleton);
    const timeoutMs = clamp(input.timeoutMs ?? config.queryTimeoutMs, 10_000, 60_000);
    const maxRows = resolveMaxRows(input.maxRows, config.maxRows, !fullScan);
    const maxBytes = clamp(input.maxResultBytes ?? config.maxResultBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
    const connectionTimeoutMillis = clamp(config.connectTimeoutMs, 5_000, 30_000);
    const database = new Pool({
      host: config.host, port: config.port, database: config.database, user: config.username,
      password: source.password, ssl: config.ssl ? { rejectUnauthorized: config.sslRejectUnauthorized !== false } : undefined,
      max: 1, connectionTimeoutMillis, idleTimeoutMillis: 1_000,
    });
    const started = performance.now();
    try {
      const client = await database.connect();
      try {
        await client.query(input.statementType === "query" ? "BEGIN READ ONLY" : "BEGIN");
        await client.query("SELECT set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`]);
        /* A code-authored LIMIT bounds result rows without interpolating user data. */
        const sql = input.statementType === "query" ? `SELECT * FROM (${compiled.sql}) AS apitest_result LIMIT ${maxRows + 1}` : compiled.sql;
        const result = await client.query(sql, compiled.values);
        await client.query("COMMIT");
        const { rows, truncated } = truncateRows(result.rows, maxRows, maxBytes);
        return { rows, rowCount: Number(result.rowCount ?? result.rows.length), truncated, durationMs: Math.max(0, Math.round(performance.now() - started)), fullScan };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await database.end();
    }
  },
};

export default adapter;
