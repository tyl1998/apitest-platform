import { performance } from "node:perf_hooks";
import mssql from "mssql";
import { clamp, compileSql, DEFAULT_MAX_BYTES, hasRowLimitClause, HARD_MAX_BYTES, resolveMaxRows, truncateRows, validateSqlParams } from "./common.js";
import { sqlSkeleton, validateStatement, type SkeletonFlags } from "./skeleton.js";
import type { SqlAdapter, SqlExecutionInput, SqlExecutionResult } from "./types.js";
import type { SqlParameterDefinition } from "../../models/types.js";

/* SQL Server identifiers use [brackets]; quotes and dash/slash comments are
   shared with PG. */
const MSSQL_SKELETON: SkeletonFlags = { brackets: true };

/** mssql rows are JS values but DATE and VARBINARY need explicit JSON-izing. */
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

/** SQL Server is typeless in SQL itself, so the driver needs an input type.
    NVarChar(MAX) for strings/json, Float for numbers, Bit for booleans. */
function mssqlBindType(definition: SqlParameterDefinition) {
  switch (definition.type) {
    case "number": return mssql.Float;
    case "boolean": return mssql.Bit;
    case "date": return mssql.DateTime;
    default: return mssql.NVarChar(mssql.MAX);
  }
}

const adapter: SqlAdapter = {
  type: "sqlserver",
  validateStatement: (sql, statementType) => {
    /* A stray `@name` would collide with the `@pN` placeholders the compiler
       emits; SQL Server variables cannot exist in a single statement anyway. */
    const skeleton = sqlSkeleton(sql, MSSQL_SKELETON);
    if (/@[A-Za-z_][A-Za-z0-9_]*\b/.test(skeleton.replace(/;/g, " ").trim())) return "use {{name}} parameters instead of @placeholders";
    return validateStatement(sql, statementType, MSSQL_SKELETON);
  },
  compile: (sql, definitions, supplied) => compileSql(sql, definitions, supplied, (index) => `@p${index}`, MSSQL_SKELETON),
  execute: async (input: SqlExecutionInput, source): Promise<SqlExecutionResult> => {
    const paramsError = validateSqlParams(input.params);
    if (paramsError) throw new Error(paramsError);
    const statementError = validateStatement(input.sql, input.statementType, MSSQL_SKELETON);
    if (statementError) throw new Error(statementError);
    const skeleton = sqlSkeleton(input.sql, MSSQL_SKELETON); const terminator = skeleton.indexOf(";");
    const normalizedSql = terminator < 0 ? input.sql : input.sql.slice(0, terminator);
    const compiled = compileSql(normalizedSql, input.params ?? [], input.values ?? {}, (index) => `@p${index}`, MSSQL_SKELETON);
    const config = source.config;
    /* No row-limiting clause on a query = full-table scan; capped at 200 rows. */
    const fullScan = input.statementType === "query" && !hasRowLimitClause(skeleton);
    const timeoutMs = clamp(input.timeoutMs ?? config.queryTimeoutMs, 10_000, 60_000);
    const maxRows = resolveMaxRows(input.maxRows, config.maxRows, !fullScan);
    const maxBytes = clamp(input.maxResultBytes ?? config.maxResultBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
    /* SQL Server has no read-only transaction: the statement validation is the
       guard, and the requestTimeout is the per-statement execution budget. */
    const pool = new mssql.ConnectionPool({
      server: config.host, port: config.port, database: config.database, user: config.username,
      password: source.password,
      options: {
        encrypt: Boolean(config.ssl),
        trustServerCertificate: config.sslRejectUnauthorized === false,
      },
      connectionTimeout: clamp(config.connectTimeoutMs, 5_000, 30_000),
      requestTimeout: timeoutMs,
      pool: { max: 1 },
    });
    const started = performance.now();
    try {
      await pool.connect();
      const transaction = new mssql.Transaction(pool);
      await transaction.begin();
      try {
        const request = new mssql.Request(transaction);
        compiled.values.forEach((value, index) => {
          const definition = compiled.definitions[index];
          const name = `p${index + 1}`;
          const type = mssqlBindType(definition);
          if (value === null || value === undefined) request.input(name, type, null);
          else if (definition.type === "json") request.input(name, type, typeof value === "string" ? value : JSON.stringify(value));
          else request.input(name, type, value);
        });
        const sql = compiled.sql;
        /* Row cap via SET ROWCOUNT rather than a `SELECT TOP (n) * FROM (…)` wrap.
           SQL Server rejects a bare ORDER BY inside a derived table (error 1033)
           and rejects a CTE there outright, so wrapping made every `ORDER BY` and
           every `WITH` query fail — and skeleton.ts admits `WITH` as a valid query.
           `maxRows` is code-authored and clamped, never user text. The connection
           is torn down right after, so the session setting needs no reset. */
        if (input.statementType === "query") await new mssql.Request(transaction).query(`SET ROWCOUNT ${maxRows + 1}`);
        const result = await request.query(sql);
        await transaction.commit();
        const recordset = result.recordset ?? [];
        const rows = recordset.map((row) => normalizeRow(row));
        const rowCount = input.statementType === "command" ? Number(result.rowsAffected?.[0] ?? recordset.length) : recordset.length;
        const { rows: kept, truncated } = truncateRows(rows, maxRows, maxBytes);
        return { rows: kept, rowCount, truncated, durationMs: Math.max(0, Math.round(performance.now() - started)), fullScan };
      } catch (error) {
        await transaction.rollback().catch(() => {});
        throw error;
      }
    } finally {
      await pool.close().catch(() => {});
    }
  },
};

export default adapter;
