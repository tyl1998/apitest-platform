import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { getWriterObjectStore, storageDriverName } from "./objectStore.js";

/**
 * 执行历史分区维护与归档（P10-2，计划 14.1）。
 *
 * 迁移 066 把 `executions` 改成了按季范围分区表；本文件是它的运行时那一半：**预建未来分区**、
 * **把到期的冷分区脱离出去**、**列出现状**、**在人决定清理时同步删掉对象存储里的大响应体**。
 *
 * ── 2026-09-20 用户拍板的四条口径 ──────────────────────────────────────────
 *
 * 1. **按季**（不是按月）：分区换来的是「批量移除从 DELETE 百万行变成 DETACH 一张表」，
 *    粒度该对齐归档窗口而不是查询模式；按月多 3 倍关系数却换不到额外收益。
 * 2. **到期只 DETACH + 改名，不 DROP**：脱离即读侧不再看见（API 只查 `executions`），但数据
 *    仍在库里，何时 pg_dump / 真删由人决定。自动维护永不做不可逆的事。
 * 3. **对象只在表被真正 DROP 的那一刻删**：已脱离的分区里行还在，对象就得在，两者同生命周期
 *    （14.1「不能只归档行、留下孤儿对象」的正解不是「归档就删」，而是「同生共死」）。
 * 4. **保留窗口走环境变量、默认关闭**：`EXECUTION_RETENTION_MONTHS` 缺省 0 = 只预建分区、
 *    永不归档。删历史是破坏性动作，不该开箱即开。
 *
 * ── 一条必须守住的顺序 ────────────────────────────────────────────────────
 *
 * DETACH **不**清理 `execution_steps.http_execution_id` / `mocks.snapshot_execution_id`
 * （066 已拆掉这两条外键，它们不再自动置空）：脱离是可逆的，重新 ATTACH 回去证据就还在，
 * 提前抹掉指针等于把可逆动作做成不可逆。**DROP 才清指针**——那一步本来就没有回头路。
 */

/* ── 季的算术（一律按 UTC，与迁移 066 的 `+00` 边界字面量同源）──────────────── */

/** 给定时刻所属季的起点。UTC 对齐：季界必须与 066 建的分区边界严丝合缝。 */
function quarterStartOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), Math.floor(at.getUTCMonth() / 3) * 3, 1));
}

function addQuarters(start: Date, quarters: number): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + quarters * 3, 1));
}

function quarterIndex(start: Date): number {
  return Math.floor(start.getUTCMonth() / 3) + 1;
}

/** 分区表名。名字里的季**就是**这张分区的范围，归档判定直接读名字（见 parseQuarter）。 */
function partitionNameFor(start: Date): string {
  return `executions_${start.getUTCFullYear()}q${quarterIndex(start)}`;
}

/** 范围边界字面量，显式带 `+00`：不依赖会话 TimeZone，否则季界会差出几个小时。 */
function boundLiteral(at: Date): string {
  return `${at.toISOString().slice(0, 10)} 00:00:00+00`;
}

/**
 * 从表名反解这一季的范围。
 *
 * 判定归档到期读的是**名字**而不是 `pg_get_expr(relpartbound)`：名字是我们自己按季生成的
 * 唯一格式，解析它不需要正则啃 Postgres 的边界表达式文本。认不出来的（`executions_default`
 * 兜底分区、已归档的 `executions_archived_*`、或任何手工挂上去的分区）返回 null ——
 * **永不参与自动归档**，这正是想要的行为：归档过的表哪怕被重新 ATTACH 回去，也该由人决定
 * 它的去留，而不是被维护拍再归档一次、名字越滚越长。
 */
function parseQuarter(name: string): { start: Date; end: Date } | null {
  const matched = /^executions_(\d{4})q([1-4])$/.exec(name);
  if (!matched) return null;
  const start = new Date(Date.UTC(Number(matched[1]), (Number(matched[2]) - 1) * 3, 1));
  return { start, end: addQuarters(start, 1) };
}

/* ── 配置 ─────────────────────────────────────────────────────────────────── */

/**
 * 保留窗口（月）。**0 或负数 = 归档整个关闭**，维护拍只预建分区。
 *
 * 单位用月而不是季：窗口本身可以比季细（「留 18 个月」是合理配置），判定时按「整季都落在
 * 窗口之外」才归档，所以细单位不会切碎一张分区。
 */
export const EXECUTION_RETENTION_MONTHS = Number(process.env.EXECUTION_RETENTION_MONTHS ?? 0);

/** 提前量：当前季 + 之后两季。与迁移 066 建分区时的预建量一致。 */
const PRECREATE_QUARTERS = 2;

/**
 * 维护拍频。分区是季级的，一天四次已经远超必要——它存在的意义只是「别把创建新分区这件事
 * 拖到跨季那一刻才做」。与 scheduler 的其它拍一样，不该成为负载来源。
 */
export const PARTITION_MAINTENANCE_TICK_MS = 6 * 60 * 60 * 1000;

/**
 * 互斥键。与 worker 的 `REAP_LOCK_KEY`（8_013_301）、scheduler 的
 * `PIPELINE_REAP_LOCK_KEY`（8_013_401）同一条编号纪律：按「谁在扫哪张表」划范围。
 */
const PARTITION_MAINTENANCE_LOCK_KEY = 8_013_501;

/* ── 维护拍 ───────────────────────────────────────────────────────────────── */

export type PartitionMaintenanceResult = {
  created: string[];
  archived: string[];
  /**
   * 该建却建不出来的季：`executions_default` 里已经有属于这一季的行。
   *
   * 不是致命故障（写入照常落进兜底分区，一行都不丢），但这一季**永远不会**被自动归档
   * ——兜底分区不参与归档判定。修法是人工把那批行从 default 里搬出来（DETACH default →
   * 建该季分区 → 搬行 → ATTACH 回去），不该由维护拍自作主张搬动数据。
   */
  blocked: string[];
};

/**
 * 预建当前季与之后两季的分区。
 *
 * 表名是**代码生成的**（由 Date 算出、格式固定为 `executions_YYYYqN`），不含任何来自请求的
 * 字节，所以这里的标识符拼接不触碰 server-contract 第 4 条（禁的是把请求值拼进 SQL）。
 * 标识符本来也无法参数化——`$1` 只能是值。
 *
 * **被兜底分区堵住的情况要先查、不能等报错**：维护拍长期没跑时，行会落进
 * `executions_default`；此后 Postgres 拒绝为同一范围建分区（新分区约束会被 default 里的
 * 现有行违反）。而事务里任何一个错误都会毒化整个事务，`try/catch` 在这里救不了后面几季，
 * 所以先查一条、查到就跳过并如实报告，由 scheduler 打出可操作的告警。
 */
async function ensureQuarterPartitions(client: PoolClient): Promise<{ created: string[]; blocked: string[] }> {
  const base = quarterStartOf(new Date());
  const created: string[] = [];
  const blocked: string[] = [];
  for (let offset = 0; offset <= PRECREATE_QUARTERS; offset += 1) {
    const start = addQuarters(base, offset);
    const end = addQuarters(start, 1);
    const name = partitionNameFor(start);
    /* 与紧接着的 CREATE TABLE 用同一套名字解析（search_path），而不是扫 pg_class 的全部
       schema——否则别的 schema 里一张同名表会让这一季永远建不出来。 */
    const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [name]);
    if (exists.rows[0].present) continue;

    const stranded = await client.query(
      "SELECT 1 FROM executions_default WHERE created_at >= $1 AND created_at < $2 LIMIT 1",
      [boundLiteral(start), boundLiteral(end)],
    );
    if (stranded.rowCount) { blocked.push(name); continue; }

    await client.query(
      `CREATE TABLE ${name} PARTITION OF executions
       FOR VALUES FROM ('${boundLiteral(start)}') TO ('${boundLiteral(end)}')`,
    );
    created.push(name);
  }
  return { created, blocked };
}

/**
 * 把整季都落在保留窗口之外的分区脱离出去并改名。
 *
 * 判据是**整季的上界**早于 cutoff：只要这一季里还有一天在窗口内，整张分区就留着。宁可多留
 * 一季，也不能让「保留 3 个月」意外删掉 2 个月零 1 天前的记录。
 *
 * 不会碰到当前季与未来季：retention ≥ 1 个月时它们的上界都在 cutoff 之后；兜底分区
 * `executions_default` 名字解析不出季，直接跳过（见 parseQuarter）。
 */
async function archiveExpiredPartitions(client: PoolClient): Promise<string[]> {
  if (!(EXECUTION_RETENTION_MONTHS > 0)) return [];
  /* cutoff 交给 Postgres 算：`interval` 的月运算会正确夹取月末（3 月 31 日减一个月是
     2 月 28/29 日），而 JS 的 `Date.UTC(y, m - 1, 31)` 会溢出成 3 月初，把窗口悄悄放宽。 */
  const bound = await client.query<{ cutoff: Date }>(
    "SELECT (now() - ($1 || ' months')::interval) AS cutoff",
    [EXECUTION_RETENTION_MONTHS],
  );
  const cutoff = bound.rows[0].cutoff;

  const partitions = await client.query<{ name: string }>(
    `SELECT c.relname AS name
     FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'executions'::regclass
     ORDER BY c.relname`,
  );

  const archived: string[] = [];
  for (const row of partitions.rows) {
    const quarter = parseQuarter(row.name);
    if (!quarter || quarter.end > cutoff) continue;

    /* 脱离那一刻的真实计数（不是 reltuples 估算）：表被 DROP 之后，台账里的这个数是唯一
       还说得出「清掉了多少」的东西。 */
    const counted = await client.query<{ total: string }>(`SELECT COUNT(*)::bigint AS total FROM ${row.name}`);
    const archivedName = `executions_archived_${row.name.slice("executions_".length)}`;

    /* 普通 DETACH 而不是 CONCURRENTLY：后者不能在事务块里跑，而维护拍的互斥靠的正是
       事务级 advisory lock。对父表的 ACCESS EXCLUSIVE 只持续这一条语句。 */
    await client.query(`ALTER TABLE executions DETACH PARTITION ${row.name}`);
    await client.query(`ALTER TABLE ${row.name} RENAME TO ${archivedName}`);
    await client.query(
      `INSERT INTO execution_partition_archives (table_name, quarter_start, quarter_end, row_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (table_name) DO NOTHING`,
      [archivedName, quarter.start.toISOString(), quarter.end.toISOString(), Number(counted.rows[0].total)],
    );
    archived.push(archivedName);
  }
  return archived;
}

/**
 * 一拍维护：预建未来分区 + 归档到期分区。
 *
 * 事务级 advisory lock（与 `reapExpiredLeases` 同款）：多实例部署下同一时刻只有一个
 * scheduler 真的执行，锁随事务结束自动释放，进程崩了也不会把锁留下。抢不到锁就是别人正在
 * 做这件事，直接返回空结果，不排队也不报错。
 */
export async function runPartitionMaintenance(): Promise<PartitionMaintenanceResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query("SELECT pg_try_advisory_xact_lock($1) AS acquired", [PARTITION_MAINTENANCE_LOCK_KEY]);
    if (!lock.rows[0].acquired) { await client.query("ROLLBACK"); return { created: [], archived: [], blocked: [] }; }
    const { created, blocked } = await ensureQuarterPartitions(client);
    const archived = await archiveExpiredPartitions(client);
    /* 必须显式提交：pg 的 release 不回滚，挂着事务的连接回到池子里会把后续查询静默并入
       同一个事务（worker.ts 用一次事故换来的教训）。 */
    await client.query("COMMIT");
    return { created, archived, blocked };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/* ── 读侧 ─────────────────────────────────────────────────────────────────── */

export type LivePartition = {
  name: string;
  /** `2026q1`；兜底分区为 null。 */
  quarter: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  isDefault: boolean;
  /** 规划器统计的**估算**行数（reltuples）；从未 ANALYZE 过时为 null。 */
  approxRows: number | null;
  bytes: number;
};

export type ArchivedPartition = {
  tableName: string;
  quarterStart: string;
  quarterEnd: string;
  /** 脱离那一刻的精确行数。 */
  rowCount: number;
  detachedAt: string;
  droppedAt: string | null;
  droppedBy: string | null;
  /** 表是否还在库里。false = 已清理，台账行作为永久记录保留。 */
  present: boolean;
  bytes: number | null;
};

export async function listLivePartitions(): Promise<LivePartition[]> {
  const result = await pool.query<{ name: string; is_default: boolean; approx_rows: string; bytes: string }>(
    `SELECT c.relname AS name,
            pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT' AS is_default,
            c.reltuples::bigint AS approx_rows,
            pg_total_relation_size(c.oid)::bigint AS bytes
     FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'executions'::regclass
     ORDER BY c.relname`,
  );
  return result.rows.map((row) => {
    const quarter = parseQuarter(row.name);
    /* reltuples 在从未 ANALYZE 的新表上是 -1，那不是「零行」而是「不知道」——照实回 null，
       别让界面把「没统计过」显示成「空的、可以删」。 */
    const approx = Number(row.approx_rows);
    return {
      name: row.name,
      quarter: quarter ? `${quarter.start.getUTCFullYear()}q${quarterIndex(quarter.start)}` : null,
      rangeStart: quarter ? quarter.start.toISOString() : null,
      rangeEnd: quarter ? quarter.end.toISOString() : null,
      isDefault: row.is_default,
      approxRows: approx < 0 ? null : approx,
      bytes: Number(row.bytes),
    };
  });
}

/**
 * 兜底分区里滞留了多少行（精确计数）。没有兜底分区时返回 null。
 *
 * 这是本设计**唯一**的静默失败面，所以值得一次精确计数而不是读 reltuples 估算：落进
 * `executions_default` 的行既不会被归档（归档按季名判定，兜底分区没有季），又会挡住之后
 * 为同一季建分区。正常情况下它恒为 0——不是 0 就是维护拍停过，需要人工搬行。
 */
export async function countStrandedRows(): Promise<number | null> {
  const found = await pool.query<{ name: string }>(
    `SELECT c.relname AS name
     FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'executions'::regclass AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`,
  );
  if (!found.rowCount) return null;
  const counted = await pool.query<{ total: string }>(`SELECT COUNT(*)::bigint AS total FROM ${found.rows[0].name}`);
  return Number(counted.rows[0].total);
}

export async function listArchivedPartitions(): Promise<ArchivedPartition[]> {
  const result = await pool.query(
    `SELECT a.table_name, a.quarter_start, a.quarter_end, a.row_count, a.detached_at, a.dropped_at, a.dropped_by,
            to_regclass(a.table_name) IS NOT NULL AS present,
            pg_total_relation_size(to_regclass(a.table_name))::bigint AS bytes
     FROM execution_partition_archives a
     ORDER BY a.dropped_at IS NOT NULL, a.detached_at DESC`,
  );
  return result.rows.map((row) => ({
    tableName: String(row.table_name),
    quarterStart: new Date(row.quarter_start).toISOString(),
    quarterEnd: new Date(row.quarter_end).toISOString(),
    rowCount: Number(row.row_count),
    detachedAt: new Date(row.detached_at).toISOString(),
    droppedAt: row.dropped_at ? new Date(row.dropped_at).toISOString() : null,
    droppedBy: row.dropped_by ? String(row.dropped_by) : null,
    present: Boolean(row.present),
    bytes: row.bytes === null ? null : Number(row.bytes),
  }));
}

/* ── 清理（唯一会删对象的通路）─────────────────────────────────────────────── */

/**
 * 已脱离分区的合法表名。
 *
 * 清理端点的目标名来自请求，而标识符无法参数化，所以这里是**唯一**的防线：只接受
 * `executions_archived_YYYYqN`。字符集封死在 `[a-z_0-9]`，拼进 DDL 没有注入面；形状对不上
 * 的一律不进 SQL。命中之后还要在台账里查到行才动手（见 dropArchivedPartition）。
 */
const ARCHIVED_NAME = /^executions_archived_\d{4}q[1-4]$/;

/** 路由侧用来把「名字就不合法」（1001）与「合法但查无此表」（2001）分成两个回答。 */
export function isArchivedPartitionName(name: string): boolean {
  return ARCHIVED_NAME.test(name);
}

export type DropOutcome = {
  tableName: string;
  rowCount: number;
  /** 真正从对象存储删掉的大响应体个数。 */
  objectsDeleted: number;
  /** 驱动对不上（部署换过 fs↔s3）而**没有**删的个数——照实回，不假装删干净了。 */
  objectsSkipped: number;
  /** 被置空的悬垂指针数（execution_steps + mocks）。 */
  pointersCleared: number;
};

/**
 * 彻底清理一张已脱离的分区：**先删对象，再断指针，最后 DROP**。
 *
 * 顺序是刻意的。对象存储没有事务，删对象不能回滚，所以它必须排在数据库事务**之前**——反过来
 * 做（先 DROP 再删对象）一旦中途失败，对象的 key 就随表一起消失了，谁也不知道还剩哪些孤儿。
 * 先删对象的失败模式则是良性的：表还在、台账行还在，重跑一次即可，`deleteObject` 本身幂等。
 *
 * 已脱离的分区不在 `executions` 里，API 读不到它的任何一行，所以「对象先没了、行还在」这个
 * 中间态对用户不可见。
 */
export async function dropArchivedPartition(tableName: string, userId: string): Promise<DropOutcome | null> {
  if (!ARCHIVED_NAME.test(tableName)) return null;

  const ledger = await pool.query(
    "SELECT row_count FROM execution_partition_archives WHERE table_name = $1",
    [tableName],
  );
  if (!ledger.rowCount) return null;

  const present = await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [tableName]);
  const outcome: DropOutcome = {
    tableName,
    rowCount: Number(ledger.rows[0].row_count),
    objectsDeleted: 0,
    objectsSkipped: 0,
    pointersCleared: 0,
  };

  /* 表还在：删对象 → 断指针 → DROP（顺序见函数头注）。不在的情况落到本函数末尾。 */
  if (present.rows[0].present) {
    const driver = storageDriverName();
    const objects = await pool.query<{ key: string; driver: string | null }>(
      `SELECT response_body_object_key AS key, response_body_storage_driver AS driver
       FROM ${tableName} WHERE response_body_object_key IS NOT NULL`,
    );
    if (objects.rowCount) {
      const store = await getWriterObjectStore();
      for (const object of objects.rows) {
        /* 驱动对不上就不删：当前 store 指向的是另一套后端，照 key 删下去要么删错东西、
           要么什么也没删却报告删干净了。读侧（P10-1 的下载直链）对驱动不符本来就回 404，
           这里保持同一个判断。 */
        if (object.driver !== driver) { outcome.objectsSkipped += 1; continue; }
        await store.deleteObject(object.key);
        outcome.objectsDeleted += 1;
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      /* 066 拆掉了指向 executions 的外键，`ON DELETE SET NULL` 不再自动发生——DROP 之前
         必须亲手断掉这两处指针，否则留下的是指向已不存在的行的 id。DETACH 时刻意不做
         （脱离可逆，指针还有意义），只在这条不可逆的路上做。 */
      const steps = await client.query(
        `UPDATE execution_steps SET http_execution_id = NULL
         WHERE http_execution_id IN (SELECT id FROM ${tableName})`,
      );
      const mocks = await client.query(
        `UPDATE mocks SET snapshot_execution_id = NULL
         WHERE snapshot_execution_id IN (SELECT id FROM ${tableName})`,
      );
      outcome.pointersCleared = (steps.rowCount ?? 0) + (mocks.rowCount ?? 0);
      await client.query(`DROP TABLE ${tableName}`);
      await client.query(
        "UPDATE execution_partition_archives SET dropped_at = now(), dropped_by = $2 WHERE table_name = $1",
        [tableName, userId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return outcome;
  }

  /*
   * 表已经不在了（上一次清到一半崩了、或有人绕过本端点手工 DROP 过）：没有可删的对象、
   * 没有可断的指针，只把台账补成「已清理」。`COALESCE` 保住第一次记录的时间与人——补记
   * 不该把原始事实改写成最后一个点进来的管理员。
   */
  await pool.query(
    "UPDATE execution_partition_archives SET dropped_at = COALESCE(dropped_at, now()), dropped_by = COALESCE(dropped_by, $2) WHERE table_name = $1",
    [tableName, userId],
  );
  return outcome;
}
