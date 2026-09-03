import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { RepositoryConflictError, bindRepository } from "./ingestAuth.js";
import { buildEndpointMatcher, loadEndpointShapes, stripQuery, templateFor } from "./ingestPath.js";

/**
 * 上报主链路（P4-3 / P4-4，计划 7.2）。
 *
 * 一次上报是一个 commit 快照：按 `(project, case_key)` upsert 用例，按
 * `(repository, commit, ci_run_id)` 幂等，全部在**一个事务**里。
 *
 * 为什么单事务：一次上报要么整份进去要么一份都不进。半份进去之后，
 * `is_full_inventory` 的对账就会拿一份不完整的清单去删用例——那正是边界 11 要防的
 * 事故，只是换了个成因。
 *
 * 分工贯穿全文：**存在性看 inventory，归属看 records**（边界 11）。
 */

/** 协议版本。只增不改（`REPOSITORY_ARCHITECTURE.md` 3.4 最严格一档）。 */
export const PROTOCOL_VERSION = "1.0";

/**
 * 硬上限（计划「明确不做」：只做一道硬上限，不做项目级配额）。
 *
 * 记录数与请求体各一道：一份 20000 条记录的 JSON 也可能有 200MB（body 捕获开着时），
 * 只看条数挡不住内存。请求体那道由 Fastify 的 `bodyLimit` 在解析前就拒掉，比读完再数
 * 更省——所以它必须是路由选项，不是这里的判断。
 */
export const INGEST_MAX_RECORDS = Number(process.env.INGEST_MAX_RECORDS ?? 20_000);
export const INGEST_MAX_BODY_BYTES = Number(process.env.INGEST_MAX_BODY_BYTES ?? 8 * 1024 * 1024);

/** 一批 INSERT 的行数。太大只会让一条 SQL 的参数数量撞上 Postgres 的 65535 上限。 */
const RECORD_CHUNK = 400;

export type IngestPayload = {
  protocol_version?: string;
  run?: {
    repo?: { git_url?: string; provider?: string };
    commit_sha?: string;
    branch?: string;
    ci_run_id?: string;
    ci_run_url?: string;
    /** 本次跑的范围，相对仓库根（边界 11/19）。缺省 = 全仓。 */
    scope?: string[];
    /** 「这个范围内没有过滤」。 */
    is_full_inventory?: boolean;
    sdk?: { name?: string; version?: string };
    started_at?: string;
    finished_at?: string;
  };
  inventory?: {
    case_key?: string;
    name?: string;
    description?: string;
    /** 协议 3.4 写的是 `file`；`file_path` 一并接受，SDK 两种写法都不会静默丢字段。 */
    file?: string;
    file_path?: string;
    tags?: string[];
    /**
     * 用例级结果。
     *
     * **这是 v1.0 相对 `REPOSITORY_ARCHITECTURE.md` 3.4 草图的第三处增补**（前两处是
     * `run.scope` 与 `records[].phase`，计划 7.2 已记）：草图只有 `records[].passed`，
     * 那是**每个请求**的结果，而用例结果不能由它推出来——一条被 skip 的用例、或一条只
     * 断言了本地计算的用例，records 里是空的，按「没有失败的请求就算通过」会把它算成
     * 绿的。理由与 scope 同款：首版漏掉之后再加，就要面对「老 SDK 没报，那它算通过
     * 吗」这个两个答案都错的问题。
     *
     * 缺省时回退到从 records 推断（见 `deriveResult`），保证草图形状的上报仍能进来。
     */
    result?: string;
  }[];
  records?: {
    /** 空串 = 没有归属用例（session 级 fixture 在任何用例开始前发的请求）。 */
    case_key?: string;
    param_id?: string;
    phase?: string;
    seq?: number;
    method?: string;
    path_raw?: string;
    status_code?: number;
    latency_ms?: number;
    passed?: boolean;
    error?: string;
    request_summary?: Record<string, unknown>;
  }[];
};

export type IngestResult = {
  runId: string;
  indexId: string;
  matched: number;
  unmatched: number;
  unplaced: number;
  reconciled: boolean;
  warnings: string[];
};

/** 422 的载体：协议不自洽时要说清是哪一条不自洽，否则接入方无从下手。 */
export class IngestPayloadError extends Error {}
/** 413 的载体（记录条数那一道；请求体大小由 `bodyLimit` 更早拒掉）。 */
export class IngestTooLargeError extends Error {}

const PHASES = ["setup", "call", "teardown"];
const RESULTS = ["passed", "failed", "skipped", "unknown"];

/** 路径前缀比较：`tests/order` 命中 `tests/order/test_a.py`，不命中 `tests/orders/`。 */
function underScope(filePath: string, scope: string[]): boolean {
  if (!scope.length) return true;
  const normalized = filePath.replace(/^\.?\//, "");
  return scope.some((entry) => {
    const prefix = entry.replace(/^\.?\//, "").replace(/\/+$/, "");
    if (!prefix || prefix === ".") return true;
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

/**
 * 没有用例级结果时的回退推断。
 *
 * `unknown` 是刻意的第三种答案：一条用例这一轮没有任何请求记录时，它既不是通过也不是
 * 失败——把它算成通过会让一次「依赖服务没起、全部 skip」的运行在页面上显示为全绿。
 */
function deriveResult(records: { passed?: boolean }[]): "passed" | "failed" | "unknown" {
  if (!records.length) return "unknown";
  if (records.some((record) => record.passed === false)) return "failed";
  if (records.some((record) => record.passed === true)) return "passed";
  return "unknown";
}

function trimmed(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/**
 * 校验并规范化一份 payload。
 *
 * 校验一律**先于**任何写入：inventory 与 records 的 case_key 不自洽（边界所述 422）在
 * 事务里发现就要回滚，而回滚掉的那一份对账已经算过一遍——白算不算错，但会让「为什么这
 * 次没删」多一个不必要的解释。
 */
function normalize(payload: IngestPayload) {
  const version = trimmed(payload.protocol_version);
  /* 版本未知直接 422，而不是尽力解析：协议只增不改，一个平台不认识的版本号意味着对方
     的字段语义可能已经和这里不同，猜着解析会把错误数据写成事实。
     注意这与「不得因版本旧而拒绝上报」不冲突——旧版本一直被支持，拒的是**未来**版本。 */
  if (version && version !== PROTOCOL_VERSION) throw new IngestPayloadError(`unsupported protocol_version ${version}`);

  const run = payload.run ?? {};
  const gitUrl = trimmed(run.repo?.git_url);
  if (!gitUrl) throw new IngestPayloadError("run.repo.git_url is required");
  const commitSha = trimmed(run.commit_sha);
  if (!commitSha) throw new IngestPayloadError("run.commit_sha is required");

  const inventory = (payload.inventory ?? []).map((entry) => {
    const caseKey = trimmed(entry.case_key);
    if (!caseKey) throw new IngestPayloadError("every inventory entry needs a case_key");
    const result = trimmed(entry.result);
    if (result && !RESULTS.includes(result)) throw new IngestPayloadError(`inventory result must be one of ${RESULTS.join(", ")}`);
    return {
      caseKey,
      /* 显示名缺省回落到 case_key：树上宁可显示一个技术标识，也不要一行空白。 */
      name: trimmed(entry.name) || caseKey,
      description: typeof entry.description === "string" ? entry.description : "",
      filePath: trimmed(entry.file ?? entry.file_path),
      tags: Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag)).filter(Boolean) : [],
      result: result as "passed" | "failed" | "skipped" | "unknown" | "",
    };
  });

  const known = new Set(inventory.map((entry) => entry.caseKey));
  const seenKeys = new Set<string>();
  for (const entry of inventory) {
    if (seenKeys.has(entry.caseKey)) throw new IngestPayloadError(`duplicate case_key in inventory: ${entry.caseKey}`);
    seenKeys.add(entry.caseKey);
  }

  const rawRecords = payload.records ?? [];
  if (rawRecords.length > INGEST_MAX_RECORDS) throw new IngestTooLargeError(`records exceed INGEST_MAX_RECORDS (${INGEST_MAX_RECORDS})`);

  const seenSeq = new Set<number>();
  const records = rawRecords.map((entry, index) => {
    const caseKey = trimmed(entry.case_key);
    /* 未在 inventory 里的 case_key 是真正的不自洽（边界所述 422）：凭一条 record 就长出
       一条用例行的话，一次 `-k` 局部跑会在树上留下 inventory 从未确认过的用例，而对账
       只看 inventory——它们就永远不会被清理。 */
    if (caseKey && !known.has(caseKey)) throw new IngestPayloadError(`record case_key not present in inventory: ${caseKey}`);
    const phase = trimmed(entry.phase) || "call";
    if (!PHASES.includes(phase)) throw new IngestPayloadError(`record phase must be one of ${PHASES.join(", ")}`);
    const method = trimmed(entry.method).toUpperCase();
    if (!method) throw new IngestPayloadError("every record needs a method");
    const pathRaw = trimmed(entry.path_raw);
    if (!pathRaw) throw new IngestPayloadError("every record needs a path_raw");
    /* seq 是重投的幂等键之一（UNIQUE(run, seq)）。SDK 没给就按数组下标补——但给了就必须
       唯一，否则同一批里两条记录会互相 DO NOTHING 掉一条。 */
    const seq = Number.isInteger(entry.seq) ? Number(entry.seq) : index;
    if (seenSeq.has(seq)) throw new IngestPayloadError(`duplicate record seq: ${seq}`);
    seenSeq.add(seq);
    return {
      caseKey, phase: phase as "setup" | "call" | "teardown",
      paramId: trimmed(entry.param_id) || undefined,
      seq, method, pathRaw,
      statusCode: Number.isFinite(entry.status_code) ? Number(entry.status_code) : undefined,
      latencyMs: Number.isFinite(entry.latency_ms) ? Number(entry.latency_ms) : undefined,
      passed: typeof entry.passed === "boolean" ? entry.passed : undefined,
      error: typeof entry.error === "string" && entry.error ? entry.error : undefined,
      requestSummary: (entry.request_summary ?? {}) as Record<string, unknown>,
    };
  });

  return {
    protocolVersion: version || PROTOCOL_VERSION,
    gitUrl, commitSha,
    branch: trimmed(run.branch),
    /* 空串而不是 NULL：NULL 在 UNIQUE 里不去重，本地跑的两次上报会各插一行。 */
    ciRunId: trimmed(run.ci_run_id),
    ciRunUrl: trimmed(run.ci_run_url) || undefined,
    scope: Array.isArray(run.scope) ? run.scope.map((entry) => String(entry).trim()).filter(Boolean) : [],
    isFullInventory: run.is_full_inventory === true,
    sdkName: trimmed(run.sdk?.name),
    sdkVersion: trimmed(run.sdk?.version),
    startedAt: trimmed(run.started_at) || undefined,
    finishedAt: trimmed(run.finished_at) || undefined,
    inventory, records,
  };
}

type Normalized = ReturnType<typeof normalize>;

/**
 * 每条用例这一轮的结果。
 *
 * 显式的 `inventory[].result` 优先；缺省时从该用例的请求记录推断，这样
 * `REPOSITORY_ARCHITECTURE.md` 3.4 草图形状（只有 `records[].passed`）的上报仍能进来。
 * 算一次给三处用：用例 upsert、`ingest_runs` 的通过/失败计数、`execution_index` 的状态。
 */
function caseResults(data: Normalized): Map<string, "passed" | "failed" | "skipped" | "unknown"> {
  const byCase = new Map<string, { passed?: boolean }[]>();
  for (const record of data.records) {
    if (!record.caseKey) continue;
    const bucket = byCase.get(record.caseKey) ?? [];
    bucket.push(record);
    byCase.set(record.caseKey, bucket);
  }
  const results = new Map<string, "passed" | "failed" | "skipped" | "unknown">();
  for (const entry of data.inventory) {
    results.set(entry.caseKey, entry.result || deriveResult(byCase.get(entry.caseKey) ?? []));
  }
  return results;
}

/**
 * upsert 一次上报的用例清单，返回 case_key → 行 id 与本次 diff。
 *
 * `last_result` / `last_run_at` **只在这一轮真的跑了它**（passed / failed）时才更新：
 * 一条被 skip 的用例把上一轮的 `passed` 冲成 `unknown`，界面上就变成「这条用例从来没
 * 通过过」——而事实是它昨天通过了、今天没跑。
 *
 * 软删过的用例再次出现时自动回 `active`（验收 6 末条）：文件被改回来、或某次误报的
 * 非全量被纠正之后，用户不该需要去点一个「恢复」。
 */
async function upsertCases(
  client: PoolClient,
  projectId: string,
  repositoryId: string,
  runId: string,
  data: Normalized,
  results: Map<string, string>,
) {
  const ids = new Map<string, string>();
  let added = 0;
  let updated = 0;

  for (const entry of data.inventory) {
    const result = results.get(entry.caseKey) ?? "unknown";
    /* skipped 与 unknown 都不动 last_result（见上）：`ran` 为 false 时那两列走
       CASE 的 else 分支保持原值。 */
    const ran = result === "passed" || result === "failed";
    const upserted = await client.query(
      `INSERT INTO repo_test_cases (
         id, project_id, repository_id, case_key, name, description, file_path, tags,
         status, last_result, last_seen_commit, last_ingest_run_id, last_run_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11, CASE WHEN $12 THEN now() ELSE NULL END)
       ON CONFLICT (project_id, case_key) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         file_path = EXCLUDED.file_path,
         tags = EXCLUDED.tags,
         status = 'active',
         removed_at = NULL,
         last_result = CASE WHEN $12 THEN EXCLUDED.last_result ELSE repo_test_cases.last_result END,
         last_run_at = CASE WHEN $12 THEN now() ELSE repo_test_cases.last_run_at END,
         last_seen_commit = EXCLUDED.last_seen_commit,
         last_ingest_run_id = EXCLUDED.last_ingest_run_id,
         updated_at = now()
       RETURNING id, (created_at = updated_at) AS inserted`,
      [
        randomUUID(), projectId, repositoryId, entry.caseKey, entry.name, entry.description, entry.filePath, entry.tags,
        ran ? result : "unknown", data.commitSha, runId, ran,
      ],
    );
    const row = upserted.rows[0];
    ids.set(entry.caseKey, String(row.id));
    if (row.inserted) added += 1; else updated += 1;
  }
  return { ids, added, updated };
}

/**
 * 按 `scope` 裁剪的删除对账（边界 11）。
 *
 * 两道闸门都在调用方判过（全量 + 跟踪分支），这里只做裁剪与软删。裁剪按 `file_path`
 * 前缀：范围之外的用例一个都不动——一个仓库常按目录划分系统，`pytest tests/order/`
 * 不该让 `tests/user/` 下的用例集体消失。
 *
 * **只看 inventory，绝不看 records**：被 skip 的用例、这一轮没打到任何接口的用例，
 * records 里是空的。
 */
async function reconcile(client: PoolClient, projectId: string, data: Normalized) {
  const keys = data.inventory.map((entry) => entry.caseKey);
  const candidates = await client.query(
    "SELECT id, case_key, file_path FROM repo_test_cases WHERE project_id = $1 AND status = 'active' AND NOT (case_key = ANY($2::text[]))",
    [projectId, keys],
  );
  const doomed = candidates.rows.filter((row) => underScope(String(row.file_path), data.scope)).map((row) => String(row.id));
  if (!doomed.length) return 0;
  const removed = await client.query(
    "UPDATE repo_test_cases SET status = 'removed', removed_at = now(), updated_at = now() WHERE id = ANY($1::uuid[])",
    [doomed],
  );
  return removed.rowCount ?? 0;
}

/**
 * 写入请求记录，返回本次**真正插进去的**记录所形成的用例↔接口增量与匹配计数。
 *
 * 三个数字（关系增量、matched、unmatched）**全部只算新插入的行**（`ON CONFLICT DO NOTHING`
 * + `RETURNING`），这是重投不翻倍的关键：关系表的 `request_count` 是累积值（边界 11），
 * 如果按 payload 里的条数去加，同一份 payload 报三次就会让每个接口的请求数变成三倍——而
 * `ingest_records` 里明明只有一份。matched / unmatched 同理，它们要和「表里到底存了多少行」
 * 对得上，否则一次重投会让未匹配数凭空翻倍。
 *
 * 代价是：一次完全重复的重投回 `matched=0 unmatched=0`。那是诚实的——这一次调用确实没有
 * 记下任何新东西。
 */
async function insertRecords(
  client: PoolClient,
  projectId: string,
  runId: string,
  data: Normalized,
  caseIds: Map<string, string>,
  matcher: { match: (method: string, pathRaw: string) => { endpointId: string; path: string } | undefined },
) {
  /* key: `${caseId}\u0000${endpointId}` → 新增请求数。只有 call 阶段进这里（边界 10）。 */
  const relations = new Map<string, number>();
  let matched = 0;
  let unmatched = 0;
  let inserted = 0;

  for (let offset = 0; offset < data.records.length; offset += RECORD_CHUNK) {
    const chunk = data.records.slice(offset, offset + RECORD_CHUNK);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const record of chunk) {
      const path = stripQuery(record.pathRaw);
      const hit = matcher.match(record.method, path);
      const caseId = record.caseKey ? caseIds.get(record.caseKey) ?? null : null;
      const row = [
        randomUUID(), runId, projectId, caseId, hit?.endpointId ?? null, record.phase, record.paramId ?? null,
        record.seq, record.method, record.pathRaw, templateFor(hit?.path, path),
        record.statusCode ?? null, record.latencyMs ?? null, record.passed ?? null, record.error ?? null,
        JSON.stringify(record.requestSummary),
      ];
      const base = values.length;
      /* 最后一个占位要 ::jsonb（request_summary 以字符串传入，与 endpoints.ts 的
         `$4::jsonb` 同款）。 */
      placeholders.push(`(${row.map((_, index) => `$${base + index + 1}${index === row.length - 1 ? "::jsonb" : ""}`).join(", ")})`);
      values.push(...row);
    }
    const result = await client.query(
      `INSERT INTO ingest_records (
         id, ingest_run_id, project_id, repo_case_id, endpoint_id, phase, param_id, seq,
         method, path_raw, path_normalized, status_code, latency_ms, passed, error, request_summary
       ) VALUES ${placeholders.join(", ")}
       ON CONFLICT (ingest_run_id, seq) DO NOTHING
       RETURNING repo_case_id, endpoint_id, phase`,
      values,
    );
    inserted += result.rowCount ?? 0;
    for (const row of result.rows) {
      /* 匹配计数只数真的插进去的行（见函数注释）：重投时这一轮什么都没记下，
         matched/unmatched 就该是 0，而不是把 payload 里的条数再算一遍。 */
      if (row.endpoint_id) matched += 1; else unmatched += 1;
      /* 只有 call 阶段建立用例关系（边界 10）：登录、造数发生在 fixture 里，
         contextvar 此时指向触发该 fixture 的第一个用例，直接归进去会得到「登录接口的
         用例数 = 恰好第一个用例」这种失真。setup/teardown 的记录仍在表里、仍计入接口
         覆盖，只是不挂到用例节点上。 */
      if (String(row.phase) !== "call") continue;
      if (!row.repo_case_id || !row.endpoint_id) continue;
      const key = `${String(row.repo_case_id)}\u0000${String(row.endpoint_id)}`;
      relations.set(key, (relations.get(key) ?? 0) + 1);
    }
  }

  return { relations, matched, unmatched, inserted };
}

/** 关系表**累积**（边界 11）：有 inventory 无 records 的用例保留上一轮的接口关系。 */
async function upsertRelations(client: PoolClient, runId: string, relations: Map<string, number>) {
  for (const [key, count] of relations) {
    const [caseId, endpointId] = key.split("\u0000");
    await client.query(
      `INSERT INTO repo_case_endpoints (repo_case_id, endpoint_id, first_seen_run_id, last_seen_run_id, request_count)
       VALUES ($1, $2, $3, $3, $4)
       ON CONFLICT (repo_case_id, endpoint_id) DO UPDATE SET
         last_seen_run_id = EXCLUDED.last_seen_run_id,
         request_count = repo_case_endpoints.request_count + EXCLUDED.request_count`,
      [caseId, endpointId, runId, count],
    );
  }
}

/**
 * 接收一次上报。
 *
 * 处理顺序（计划 7.2）：校验 Token（调用方已做）→ 登记或校验仓库 → `ingest_runs` upsert
 * → 用例 upsert → records 批插 → 关系累积 → 按 scope 对账 → 写 `execution_index`
 * → 回填 diff 与未匹配/未归位计数。
 *
 * 对账排在 records 之后是刻意的：删除只看 inventory，但**未归位计数**要在关系写完之后
 * 才算得准，而两者要出现在同一行 `ingest_runs` 上。
 */
export async function ingest(projectId: string, payload: IngestPayload): Promise<IngestResult> {
  const data = normalize(payload);
  const warnings: string[] = [];
  if (!data.sdkName) warnings.push("run.sdk.name is missing; upgrade notices cannot be targeted");
  if (!data.branch) warnings.push("run.branch is empty; this run can never take part in delete reconciliation");
  if (data.isFullInventory && !data.inventory.length) warnings.push("is_full_inventory was set with an empty inventory; reconciliation was skipped");

  /* 匹配表在事务外读：它是「项目里现在有哪些接口」的快照，读进事务只会让上报和接口
     管理互相排队。这一次上报期间新建的接口下一次才归位（边界 16 不回溯）。 */
  const matcher = buildEndpointMatcher(await loadEndpointShapes(projectId));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const repository = await bindRepository(client, projectId, data.gitUrl, data.commitSha);

    /* 幂等键命中就走合并分支：同一行 run 被更新，records 靠 UNIQUE(run, seq) 去重。
       `xmax = 0` 是 Postgres 上区分「这一行是 INSERT 还是 ON CONFLICT 走了 UPDATE」的惯用
       写法：新插入的行事务里没有前一个版本，xmax 为 0。下面的 diff 计数要用它——重投不该
        重写「这次上报新增了几条用例」这个已经定局的事实。
       键 = (repository, commit)（迁移 049 折形）：045 曾把键留在三列上、靠「插入值写 ''」
       折形，但 UPDATE 分支把真值写回键列（`COALESCE(NULLIF($15,''),…)`）——第 1 次建行、
       第 2 次命中合并且键列变真值、第 3 次起 `''` 再也匹配不上 → 同 commit 每两次上报
       溢出一行（dev 库 c1f4d1ba 实测 2 行）。键里删掉 `ci_run_id` 列本身才是折形；
       列保留为纯展示语义「最近一次上报来自哪次 CI 执行」，不参与任何唯一性。 */
    const runId = randomUUID();
    const run = await client.query(
      `INSERT INTO ingest_runs (
         id, project_id, repository_id, protocol_version, commit_sha, branch, ci_run_id, ci_run_url,
         scope, is_full_inventory, sdk_name, sdk_version, warnings, started_at, finished_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
       ON CONFLICT (repository_id, commit_sha) DO UPDATE SET
         branch = EXCLUDED.branch,
         ci_run_id = CASE WHEN EXCLUDED.ci_run_id <> '' THEN EXCLUDED.ci_run_id ELSE ingest_runs.ci_run_id END,
         scope = EXCLUDED.scope,
         is_full_inventory = EXCLUDED.is_full_inventory,
         sdk_name = EXCLUDED.sdk_name,
         sdk_version = EXCLUDED.sdk_version,
         warnings = EXCLUDED.warnings,
         finished_at = COALESCE(EXCLUDED.finished_at, ingest_runs.finished_at),
         /* 计数只在新 CI 执行（run id 变了）时 +1：同一次执行的重试/重投（ci_run_id
            相同）不推——「跑过几次」数的是执行，不是上报调用。SDK 直跑（空串）不推：
            它不是 CI 执行。
            已知的近似：判据是「与列上记录的上一来源不同」而不是「全局见没见过这个
            run id」——A 报完 B 再报、之后 A 的**重试**再报一次，会按新执行多推 1。
            列上不保留 run id 全史（那是无界数组），一条 SQL 也算不了集合差；交错重试
            是罕见路径，误差 +1 且只影响展示列，不影响折行本身。 */
         ci_execution_count = CASE
           WHEN EXCLUDED.ci_run_id <> '' AND EXCLUDED.ci_run_id <> ingest_runs.ci_run_id THEN ingest_runs.ci_execution_count + 1
           ELSE ingest_runs.ci_execution_count END
       RETURNING id, execution_index_id, (xmax = 0) AS inserted`,
      [
        runId, projectId, repository.id, data.protocolVersion, data.commitSha, data.branch,
        data.ciRunId, data.ciRunUrl ?? null,
        data.scope, data.isFullInventory, data.sdkName, data.sdkVersion, JSON.stringify(warnings),
        data.startedAt ?? null, data.finishedAt ?? null,
      ],
    );
    const effectiveRunId = String(run.rows[0].id);
    const firstPass = Boolean(run.rows[0].inserted);
    const existingIndexId = run.rows[0].execution_index_id ? String(run.rows[0].execution_index_id) : undefined;

    const results = caseResults(data);
    const cases = await upsertCases(client, projectId, repository.id, effectiveRunId, data, results);
    const written = await insertRecords(client, projectId, effectiveRunId, data, cases.ids, matcher);
    await upsertRelations(client, effectiveRunId, written.relations);

    /**
     * 双闸门（边界 11）：全量 **且** 在跟踪分支上才真删。
     *
     * 宁可少报一次全量（后果：本该删的用例多留一天），不可多报一次（后果：跑个 smoke
     * 删掉 90% 的树）。空 inventory 的「全量」一律不对账——那是 SDK 出错或 collect 全挂
     * 的形状，照它执行会清空整棵树。
     */
    const reconciled = data.isFullInventory && data.inventory.length > 0
      && Boolean(data.branch) && data.branch === repository.trackingBranch;
    const removed = reconciled ? await reconcile(client, projectId, data) : 0;

    /* 未归位用例（边界 21）：本次 inventory 里、在本项目拿不到任何接口关系的 active 用例。
       不能藏掉——藏了之后「上报了 36 条用例，树上只数出 31 条」会被当成 bug 报上来。 */
    const unplaced = await client.query(
      `SELECT COUNT(*)::int AS total FROM repo_test_cases c
        WHERE c.project_id = $1 AND c.case_key = ANY($2::text[]) AND c.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM repo_case_endpoints r WHERE r.repo_case_id = c.id)`,
      [projectId, data.inventory.map((entry) => entry.caseKey)],
    );

    let passedCount = 0;
    let failedCount = 0;
    for (const result of results.values()) {
      if (result === "passed") passedCount += 1;
      else if (result === "failed") failedCount += 1;
    }

    /**
     * 归一进统一执行记录（边界 1）：`kind='ingest'`，`trigger_source='ci'`（P3 边界 13
     * 已把 'ci' 提前写进 CHECK，正是为这一刻）。
     *
     * `UNIQUE (kind, detail_id)` 让重投复用同一行索引；`target_id` 留空——上报没有平台
     * 侧的目标对象，`target_name` 用「仓库 @ 分支」把它在列表里说清。
     */
    const indexId = existingIndexId ?? randomUUID();
    await client.query(
      `INSERT INTO execution_index (
         id, project_id, kind, target_id, target_name, detail_id, status,
         total, success_count, failed_count, trigger_source, trigger_ref_name, started_at, finished_at
       ) VALUES ($1, $2, 'ingest', NULL, $3, $4, $5, $6, $7, $8, 'ci', $9, $10, $11)
       ON CONFLICT (kind, detail_id) DO UPDATE SET
         target_name = EXCLUDED.target_name, status = EXCLUDED.status, total = EXCLUDED.total,
         success_count = EXCLUDED.success_count, failed_count = EXCLUDED.failed_count,
         finished_at = EXCLUDED.finished_at`,
      [
        indexId, projectId, `${repository.gitUrl}${data.branch ? ` @ ${data.branch}` : ""}`, effectiveRunId,
        failedCount > 0 ? "failed" : "success",
        data.inventory.length, passedCount, failedCount,
        data.sdkName || "ingest", data.startedAt ?? null, data.finishedAt ?? new Date().toISOString(),
      ],
    );

    /**
     * 回填这一行 run 的统计。
     *
     * **diff 三列只在第一次写入时算**（`firstPass`）：重投同一份 payload 时用例已经全部
     * 存在，`upsertCases` 数出来的必然是「新增 0 / 更新 N」，对账也删不掉任何东西——照它
     * 回写就会把上报记录页里已经定局的「+2 −1 ~33」抹成「+0 −0 ~36」。而 diff 描述的是
     * 「那一次上报改变了什么」，它不该随重投次数变化。
     *
     * 其余计数分两类。**累积**的两个（请求数、未匹配数）跟着真正插进去的行走：分批重投时
     * 它们确实会增长，而完全重复的重投带来的增量是 0，加上去等于不变。**每次重算**的三个
     * （用例总数、通过/失败、未归位数）描述「这一份快照现在长什么样」，重投得到的答案与第
     * 一次相同，刷一遍无害。
     *
     * `ci_execution_count`（迁移 045）在 upsert 里维护，这里不再动：新 CI 执行 +1、
     * 同一执行的重试不推、SDK 直跑不推——「跑过几次」数执行不数调用。
     */
    await client.query(
      `UPDATE ingest_runs SET
         execution_index_id = $2, reconciled = $3,
         case_total = $4, passed_count = $5, failed_count = $6,
         request_count = CASE WHEN $13 THEN $7 ELSE request_count + $7 END,
         added_count = CASE WHEN $13 THEN $8 ELSE added_count END,
         removed_count = CASE WHEN $13 THEN $9 ELSE removed_count END,
         updated_count = CASE WHEN $13 THEN $10 ELSE updated_count END,
         unmatched_count = CASE WHEN $13 THEN $11 ELSE unmatched_count + $11 END,
         unplaced_count = $12
       WHERE id = $1`,
      [
        effectiveRunId, indexId, reconciled,
        data.inventory.length, passedCount, failedCount, written.inserted,
        cases.added, removed, cases.updated,
        written.unmatched, Number(unplaced.rows[0].total),
        firstPass,
      ],
    );

    /* SDK 路径缝合的另一半在 completePipelineRun（pipelineRun.ts）：反查
       (project, commit) 的折合行。 */

    await client.query("COMMIT");
    return {
      runId: effectiveRunId, indexId,
      matched: written.matched, unmatched: written.unmatched,
      unplaced: Number(unplaced.rows[0].total),
      reconciled, warnings,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export { RepositoryConflictError };
