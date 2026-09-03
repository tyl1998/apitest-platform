import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import type { PoolClient } from "pg";

/**
 * 幂等键通用设施（P4.5-8，计划 8.1 的 `idempotency_keys` + 边界 17）。
 *
 * REPOSITORY_ARCHITECTURE.md 3.2「触发类接口支持 `Idempotency-Key`」的第一次落地。
 * 表不带 `ci_` 前缀、scope 决定 `result_id` 指向哪张表——它从第一天起就该能被套件触发、
 * 流程触发复用，只是本阶段只有 CI 触发接上去（边界 17：不追溯改造既有触发接口）。
 *
 * 并发竞态不能靠「先 SELECT 再 INSERT」：两个双击同时查到「没有」、各自触发，幂等
 * 形同虚设。抢占必须是**一条原子语句**——`INSERT ... ON CONFLICT DO NOTHING`，
 * 抢到占位行的那个请求继续做真正的触发，没抢到的回读首次的 `result_id`。
 *
 * 占位与触发之间会有一段「key 已占、result_id 还空着」的窗口：抢占时 `result_id` 先写
 * 一个 UUID 占位，触发成功后在**同一个事务里**回填真正的 run id。失败的触发
 * ROLLBACK，占位行随之消失，重试可以再来——幂等只承诺「成功的效果只发生一次」，
 * 不承诺「失败也只许一次」。
 */

/** 已有的 scope 值。集中列在这里是为了加第二个调用方时不必翻迁移文件。 */
export const IDEMPOTENCY_SCOPES = {
  /** `result_id` 指向 `pipeline_runs.id`。 */
  ciTaskTrigger: "ci_task_trigger",
} as const;

export type IdempotencyScope = (typeof IDEMPOTENCY_SCOPES)[keyof typeof IDEMPOTENCY_SCOPES];

/** `Idempotency-Key` 头的形状约束：非空、去首尾空白、长度上限 255（防把整段话塞进主键）。 */
export function normalizeIdempotencyKey(header: unknown): { key?: string; error?: string } {
  if (header === undefined || header === null) return {};
  const key = String(header).trim();
  if (!key) return { error: "Idempotency-Key header cannot be empty when provided" };
  if (key.length > 255) return { error: "Idempotency-Key header must be at most 255 characters" };
  return { key };
}

/**
 * 一次带幂等保护的触发会话。
 *
 * 用法（调用方的事务模板）：
 * 1. `claimIdempotency(client, …)` 抢占；
 * 2. `claimed === false` → 撞已有键，`resultId` 是首次那条，直接回它；
 * 3. `claimed === true` → 在**同一个 client** 上做真正的触发（写 result 行），
 *    拿到 result id 后 `fillIdempotencyResult(client, …)` 回填，一起 COMMIT。
 */
export type IdempotencyClaim =
  | { claimed: true; placeholderId: string }
  | { claimed: false; resultId: string };

export async function claimIdempotency(
  client: PoolClient,
  scope: IdempotencyScope,
  projectId: string,
  key: string,
): Promise<IdempotencyClaim> {
  /* result_id NOT NULL：抢占时先放一个占位 UUID，触发成功后回填真值。并发窗口内的
     回读者只可能是同一对 (scope, project, key) 的撞键者——它拿走的是占位 id，但那个
     分支本来就还没 COMMIT，读不到（READ COMMITTED 下未提交行不可见）；能读到的
     撞键者碰到的都是已回填的行。 */
  const placeholderId = randomUUID();
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (scope, key, project_id, result_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope, project_id, key) DO NOTHING
     RETURNING result_id`,
    [scope, key, projectId, placeholderId],
  );
  if (inserted.rowCount) return { claimed: true, placeholderId };
  const existing = await client.query(
    "SELECT result_id FROM idempotency_keys WHERE scope = $1 AND project_id = $2 AND key = $3",
    [scope, projectId, key],
  );
  return { claimed: false, resultId: String(existing.rows[0].result_id) };
}

/** 触发成功后回填真正的 result id（与触发同一事务；参数校验防手误把占位 id 留下）。 */
export async function fillIdempotencyResult(
  client: PoolClient,
  scope: IdempotencyScope,
  projectId: string,
  key: string,
  placeholderId: string,
  resultId: string,
): Promise<void> {
  const updated = await client.query(
    `UPDATE idempotency_keys SET result_id = $4
      WHERE scope = $1 AND project_id = $2 AND key = $3 AND result_id = $5`,
    [scope, projectId, key, resultId, placeholderId],
  );
  if (!updated.rowCount) {
    throw new Error("idempotency key placeholder was overwritten; refusing to fill the result");
  }
}

/**
 * 只读查询：按 (scope, project, key) 取首次的 result id。
 *
 * 供「不想开事务先查一下」的调用方用；真正的防重必须走 claim 路径，这个函数只是
 * 幂等命中后的载荷重组（比如把 result_id 换成完整的 run 行）。
 */
export async function idempotencyResultId(
  scope: IdempotencyScope,
  projectId: string,
  key: string,
): Promise<string | undefined> {
  const result = await pool.query(
    "SELECT result_id FROM idempotency_keys WHERE scope = $1 AND project_id = $2 AND key = $3",
    [scope, projectId, key],
  );
  return result.rowCount ? String(result.rows[0].result_id) : undefined;
}
