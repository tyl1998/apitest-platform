import { performance } from "node:perf_hooks";
import mysql from "mysql2/promise";
import { clamp, compileSql, DEFAULT_MAX_BYTES, hasRowLimitClause, HARD_MAX_BYTES, resolveMaxRows, truncateRows, validateSqlParams } from "./common.js";
import { sqlSkeleton, validateStatement, type SkeletonFlags } from "./skeleton.js";
import type { SqlAdapter, SqlExecutionInput, SqlExecutionResult } from "./types.js";

const MYSQL_SKELETON: SkeletonFlags = { backticks: true, hashComments: true };

/** MySQL rows are driver types (BigInt, Buffer, Date); execution evidence and
    the JSON assertions body need plain JSON-serializable values. */
function normalizeRow(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeRow);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalizeRow(item);
    return out;
  }
  return value;
}

const adapter: SqlAdapter = {
  type: "mysql",
  validateStatement: (sql, statementType) => validateStatement(sql, statementType, MYSQL_SKELETON),
  compile: (sql, definitions, supplied) => compileSql(sql, definitions, supplied, () => "?", MYSQL_SKELETON),
  execute: async (input: SqlExecutionInput, source): Promise<SqlExecutionResult> => {
    const paramsError = validateSqlParams(input.params);
    if (paramsError) throw new Error(paramsError);
    const statementError = validateStatement(input.sql, input.statementType, MYSQL_SKELETON);
    if (statementError) throw new Error(statementError);
    const skeleton = sqlSkeleton(input.sql, MYSQL_SKELETON); const terminator = skeleton.indexOf(";");
    const normalizedSql = terminator < 0 ? input.sql : input.sql.slice(0, terminator);
    const compiled = compileSql(normalizedSql, input.params ?? [], input.values ?? {}, () => "?", MYSQL_SKELETON);
    const config = source.config;
    /* No row-limiting clause on a query = full-table scan; capped at 200 rows. */
    const fullScan = input.statementType === "query" && !hasRowLimitClause(skeleton);
    const timeoutMs = clamp(input.timeoutMs ?? config.queryTimeoutMs, 10_000, 60_000);
    const maxRows = resolveMaxRows(input.maxRows, config.maxRows, !fullScan);
    const maxBytes = clamp(input.maxResultBytes ?? config.maxResultBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
    /* bigNumberStrings keeps BIGINT beyond Number.MAX_SAFE_INTEGER lossless;
       dateStrings avoids timezone-shifted Date objects in evidence. */
    const connection = await mysql.createConnection({
      host: config.host, port: config.port, database: config.database, user: config.username,
      password: source.password, ssl: config.ssl ? { rejectUnauthorized: config.sslRejectUnauthorized !== false } : undefined,
      connectTimeout: clamp(config.connectTimeoutMs, 5_000, 30_000),
      supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
    });
    const started = performance.now();
    try {
      /* Query statements run in a read-only transaction (MySQL 5.7+).
         MAX_EXECUTION_TIME only governs SELECT, so the driver-level per-query
         timeout is what protects commands. */
      if (input.statementType === "query") {
        await connection.query("START TRANSACTION READ ONLY");
        await connection.query("SET SESSION MAX_EXECUTION_TIME = ?", [timeoutMs]);
      } else {
        await connection.query("START TRANSACTION");
      }
      const sql = input.statementType === "query" ? `SELECT * FROM (${compiled.sql}) AS apitest_result LIMIT ${maxRows + 1}` : compiled.sql;
      const [result] = await connection.query({ sql, values: compiled.values, timeout: timeoutMs });
      await connection.query("COMMIT");
      const rawRows = Array.isArray(result) ? result : [];
      const rowCount = input.statementType === "command" ? Number((result as { affectedRows?: number }).affectedRows ?? rawRows.length) : rawRows.length;
      const { rows, truncated } = truncateRows(rawRows.map((row) => normalizeRow(row)), maxRows, maxBytes);
      return { rows, rowCount, truncated, durationMs: Math.max(0, Math.round(performance.now() - started)), fullScan };
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await connection.end();
    }
  },
};

export default adapter;
