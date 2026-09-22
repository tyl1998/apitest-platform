import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import type { SqlParameterDefinition, SqlStatementType } from "../models/types.js";

/*
 * P2-1 增量：交互式查询面板 `/query` 的执行历史落库与淘汰（迁移 072）。
 *
 * 三个阈值全走环境变量，默认值恒定，改值需重启进程（与 ASSET_VERSION_RETENTION 同纪律）。
 * 缺省 / 非法值一律回退到默认，绝不让一个手滑的环境变量把历史体积放开或直接关掉写入。
 */

/** 单条预览的字节上界（写入前独立截断，与执行器的 maxBytes 无关）。 */
const SQL_HISTORY_PREVIEW_BYTES = positiveInt(process.env.SQL_HISTORY_PREVIEW_BYTES, 32 * 1024);
/** 单条预览的行上界。字节与行数先到先停。 */
const SQL_HISTORY_PREVIEW_ROWS = 50;
/** 每 (user_id, data_source_id) 保留的最近条数（环形缓冲）。 */
const SQL_HISTORY_KEEP_PER_USER = positiveInt(process.env.SQL_HISTORY_KEEP_PER_USER, 50);
/** TTL（天）。0 或负数关闭 TTL 拍——环形缓冲与单条上限仍然生效。 */
export const SQL_HISTORY_TTL_DAYS = Number.isFinite(Number(process.env.SQL_HISTORY_TTL_DAYS))
  ? Math.max(0, Math.floor(Number(process.env.SQL_HISTORY_TTL_DAYS)))
  : 14;

/** TTL 拍频（6h）：TTL 是天级的，这一拍只为「别把过期清理拖到跨天那一刻」，不必更密。 */
export const SQL_HISTORY_TTL_TICK_MS = 6 * 60 * 60 * 1000;

/** 事务级 advisory lock 键：与 worker（8_013_301）/ pipeline 回收（8_013_401）分键，
    按「谁在扫哪张表」划互斥范围，多实例部署下同一时刻只有一个 scheduler 真正删。 */
const SQL_HISTORY_TTL_LOCK_KEY = 8_013_501;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

type SqlHistoryBase = {
  projectId: string;
  dataSourceId: string;
  userId: string;
  statementType: SqlStatementType;
  sql: string;
  params: SqlParameterDefinition[];
  values: Record<string, unknown>;
};

/** 成功与失败两路分开：失败没有可信的行数 / 耗时 / 结果，只留 error（且不存预览）。 */
export type SqlHistoryRecord = SqlHistoryBase &
  (
    | { status: "success"; rows: unknown[]; rowCount: number; truncated: boolean; durationMs: number }
    | { status: "error"; error: string }
  );

/**
 * 独立于执行器的预览截断：`SQL_HISTORY_PREVIEW_BYTES` 或前 `SQL_HISTORY_PREVIEW_ROWS`
 * 行，先到先停。至少保留第一行——一条超预算的巨行不该把整份预览清空成「看不出跑了什么」。
 */
function buildPreview(rows: unknown[]): { preview: unknown[]; historyTruncated: boolean } {
  const limit = Math.min(rows.length, SQL_HISTORY_PREVIEW_ROWS);
  const preview: unknown[] = [];
  let bytes = 0;
  let historyTruncated = rows.length > SQL_HISTORY_PREVIEW_ROWS;
  for (let index = 0; index < limit; index += 1) {
    const size = Buffer.byteLength(JSON.stringify(rows[index]) ?? "null", "utf8");
    if (preview.length > 0 && bytes + size > SQL_HISTORY_PREVIEW_BYTES) { historyTruncated = true; break; }
    preview.push(rows[index]);
    bytes += size;
  }
  return { preview, historyTruncated };
}

/**
 * 记一条执行历史：预览截断 → INSERT → 环形缓冲 DELETE。
 *
 * **fire-and-forget**：调用方 `.catch` 吞掉——写历史失败绝不影响 `/query` 的响应。
 * 这里也各自兜底，让 INSERT 失败不至于把环形缓冲的清理连带跳过（虽然清理本就依赖有新行）。
 */
export async function recordSqlHistory(record: SqlHistoryRecord): Promise<void> {
  const preview = record.status === "success" ? buildPreview(record.rows) : undefined;
  await pool.query(
    `INSERT INTO sql_execution_history
       (id, project_id, data_source_id, user_id, statement_type, sql, params, "values",
        status, error, row_count, duration_ms, truncated, result_preview, history_truncated)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
    [
      randomUUID(), record.projectId, record.dataSourceId, record.userId, record.statementType, record.sql,
      JSON.stringify(record.params ?? []), JSON.stringify(record.values ?? {}),
      record.status,
      record.status === "error" ? record.error : null,
      record.status === "success" ? record.rowCount : null,
      record.status === "success" ? record.durationMs : null,
      record.status === "success" ? record.truncated : false,
      preview ? JSON.stringify(preview.preview) : null,
      preview ? preview.historyTruncated : false,
    ],
  );
  /* 环形缓冲：插入后把这对 (user, source) 里超出最近 N 条的删掉。子查询取最新 N 个 id，
     外层删不在其中的——只在本人本数据源范围内操作，索引 (user_id, data_source_id,
     created_at DESC) 直接服务子查询的排序。 */
  await pool.query(
    `DELETE FROM sql_execution_history
      WHERE user_id = $1 AND data_source_id = $2
        AND id NOT IN (
          SELECT id FROM sql_execution_history
           WHERE user_id = $1 AND data_source_id = $2
           ORDER BY created_at DESC
           LIMIT $3
        )`,
    [record.userId, record.dataSourceId, SQL_HISTORY_KEEP_PER_USER],
  );
}

/**
 * TTL 拍：删掉早于 now() - SQL_HISTORY_TTL_DAYS 的历史（scheduler 调用，6h 一拍）。
 *
 * 事务级 advisory lock 多实例互斥、随事务结束自动释放（进程崩了不留锁，与 worker.reapStale /
 * pipeline 回收器同款）。TTL 关闭时（天数 ≤ 0）直接返回，不进事务。
 */
export async function purgeExpiredSqlHistory(): Promise<number> {
  if (SQL_HISTORY_TTL_DAYS <= 0) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query("SELECT pg_try_advisory_xact_lock($1) AS acquired", [SQL_HISTORY_TTL_LOCK_KEY]);
    if (!lock.rows[0].acquired) { await client.query("ROLLBACK"); return 0; }
    /* make_interval(days => $1)：天数走参数，不拼进 SQL 串（server-contract：值永不拼接）。 */
    const result = await client.query(
      "DELETE FROM sql_execution_history WHERE created_at < now() - make_interval(days => $1)",
      [SQL_HISTORY_TTL_DAYS],
    );
    /* 必须显式提交：pg 的 release 不回滚，挂在池子里的事务会把后续查询静默并入（worker.ts 教训）。 */
    await client.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
