import { performance } from "node:perf_hooks";
import oracledb from "oracledb";
import { clamp, compileSql, DEFAULT_MAX_BYTES, hasRowLimitClause, HARD_MAX_BYTES, resolveMaxRows, truncateRows, validateSqlParams } from "./common.js";
import { sqlSkeleton, validateStatement, type SkeletonFlags } from "./skeleton.js";
import type { SqlAdapter, SqlExecutionInput, SqlExecutionResult } from "./types.js";
import type { SqlParameterDefinition } from "../../models/types.js";

/* Oracle shares PG's `'` `"` `--` block-comment styles; no dollar-quoting. */
const ORACLE_SKELETON: SkeletonFlags = {};

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

/** Thin-mode positional bind. `null` needs an explicit type; booleans have no
    Oracle literal so they become 1/0; json travels as text. */
function oracleBind(definition: SqlParameterDefinition, value: unknown) {
  const val = value === null || value === undefined ? null : value;
  if (definition.type === "number") return { dir: oracledb.BIND_IN, type: oracledb.NUMBER, val: val };
  if (definition.type === "date") return { dir: oracledb.BIND_IN, type: oracledb.DATE, val: val };
  if (definition.type === "boolean") return { dir: oracledb.BIND_IN, type: oracledb.NUMBER, val: val ? 1 : 0 };
  const text = definition.type === "json" ? (typeof value === "string" ? value : JSON.stringify(value)) : value;
  return { dir: oracledb.BIND_IN, type: oracledb.STRING, val: text ?? null };
}

/** node-oracledb has no statement-timeout option; the caller-facing budget is a
    client-side race that rejects, and closing the connection in the caller's
    `finally` terminates the session — which cancels the in-flight statement. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`statement timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

const adapter: SqlAdapter = {
  type: "oracle",
  validateStatement: (sql, statementType) => {
    /* A stray `:1` would collide with the `:n` placeholders the compiler emits. */
    const skeleton = sqlSkeleton(sql, ORACLE_SKELETON);
    if (/:\d+\b/.test(skeleton.replace(/;/g, " ").trim())) return "use {{name}} parameters instead of positional :1 placeholders";
    return validateStatement(sql, statementType, ORACLE_SKELETON);
  },
  compile: (sql, definitions, supplied) => compileSql(sql, definitions, supplied, (index) => `:${index}`, ORACLE_SKELETON),
  execute: async (input: SqlExecutionInput, source): Promise<SqlExecutionResult> => {
    const paramsError = validateSqlParams(input.params);
    if (paramsError) throw new Error(paramsError);
    const statementError = validateStatement(input.sql, input.statementType, ORACLE_SKELETON);
    if (statementError) throw new Error(statementError);
    const skeleton = sqlSkeleton(input.sql, ORACLE_SKELETON); const terminator = skeleton.indexOf(";");
    const normalizedSql = terminator < 0 ? input.sql : input.sql.slice(0, terminator);
    const compiled = compileSql(normalizedSql, input.params ?? [], input.values ?? {}, (index) => `:${index}`, ORACLE_SKELETON);
    const config = source.config;
    /* No row-limiting clause on a query = full-table scan; capped at 200 rows. */
    const fullScan = input.statementType === "query" && !hasRowLimitClause(skeleton);
    const timeoutMs = clamp(input.timeoutMs ?? config.queryTimeoutMs, 10_000, 60_000);
    const maxRows = resolveMaxRows(input.maxRows, config.maxRows, !fullScan);
    const maxBytes = clamp(input.maxResultBytes ?? config.maxResultBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
    /* Thin mode, no Instant Client. `database` holds the service name.
       `connectTimeout` is in seconds here (every other adapter budgets in ms),
       and rounds up so a sub-second config never becomes a 0 = "no timeout". */
    const connection = await oracledb.getConnection({
      user: config.username,
      password: source.password,
      connectString: `${config.host}:${config.port}/${config.database}`,
      connectTimeout: Math.ceil(clamp(config.connectTimeoutMs, 5_000, 30_000) / 1_000),
    });
    const started = performance.now();
    try {
      if (input.statementType === "query") await connection.execute("SET TRANSACTION READ ONLY");
      const binds = compiled.values.map((value, index) => oracleBind(compiled.definitions[index], value));
      /* maxRows caps the fetch instead of a ROWNUM wrap, so the sentinel row is
         simply the (maxRows+1)-th fetched row. */
      const result = await withTimeout(connection.execute(compiled.sql, binds, { maxRows: maxRows + 1, outFormat: oracledb.OUT_FORMAT_OBJECT }), timeoutMs);
      await connection.commit();
      const rawRows = result.rows ?? [];
      const rows = rawRows.map((row) => normalizeRow(row));
      const rowCount = input.statementType === "command" ? Number(result.rowsAffected ?? 0) : rawRows.length;
      const { rows: kept, truncated } = truncateRows(rows, maxRows, maxBytes);
      return { rows: kept, rowCount, truncated, durationMs: Math.max(0, Math.round(performance.now() - started)), fullScan };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      await connection.close().catch(() => {});
    }
  },
};

export default adapter;
