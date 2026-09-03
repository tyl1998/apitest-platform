import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { publishEvent } from "./events.js";

/**
 * pipeline run 的日志接收与终态落库（P4.5-4，8.2 接口 4/6）。
 *
 * 两个入口都在 `routes/runners.ts`（`/runner/jobs/:jobId/logs|complete`），但状态机与
 * 终态守卫收在这一个模块里：claim / heartbeat 是「活着」的那半（P4.5-3，routes 内联），
 * 这两个是「收尾」的那半，语义密度的量级不同——logs 是幂等追加，complete 是一次带
 * 归一写入的守卫落库。
 */

/**
 * `complete` 的合法终态（8.2 接口 6 的 `status`）。
 *
 * `canceled` 要求当前状态是 `cancelling`（取消只经心跳下发，约定 6）：Runner 没有
 * 收到取消信号却自己报 `canceled`，等价于把一次失败静默抹成取消——审计口径就脏了。
 */
const COMPLETE_STATUSES = ["success", "failed", "canceled", "aborted", "timed_out"] as const;
type CompleteStatus = (typeof COMPLETE_STATUSES)[number];

/** 报告解析路径的 case 级结果（B/C，边界 13）——`source` 没有 `'sdk'`（迁移 038）。 */
type ReportCase = {
  source?: string; suite_name?: string; suiteName?: string;
  case_name?: string; caseName?: string;
  guessed_case_key?: string; guessedCaseKey?: string;
  /* allure 结果文件的 uuid（迁移 044）：同名参数化用例的两次执行靠它区分，junit 缺省。 */
  external_id?: string; externalId?: string;
  status?: string; duration_ms?: number; durationMs?: number; message?: string;
  /* P4.5-13（边界 19 的 timeline 层）：allure 的定位数据，可选——旧 Runner 与 junit
     路径都没有这四样，缺省就是 NULL 列。 */
  started_at_ms?: number | null; startedAtMs?: number | null;
  finished_at_ms?: number | null; finishedAtMs?: number | null;
  host?: string | null; thread?: string | null;
};

/** 报告 case 的行数上限：complete 请求体带整份报告解析结果，给它一个防手误护栏。 */
const MAX_REPORT_CASES = 20_000;

/**
 * complete 请求体的字节上限（路由级 bodyLimit，与 `/ingest` 的 INGEST_MAX_BODY_BYTES
 * 同一条纪律：在**解析之前**拒掉，比读完再数省一次内存）。
 *
 * 为什么必须显式给：Fastify 默认 1MB，而 MAX_REPORT_CASES 行 × 每行 message（服务端
 * 收 8000 字符）在真实报告里轻松超过它——不抬这一道，P4.5-4 落的「能收能存」在
 * 大报告上只兑现一半（Runner 会先撞 413 再把 cases 丢掉降级重发）。8MB 对齐 /ingest。
 */
export const RUNNER_COMPLETE_MAX_BODY_BYTES = Number(process.env.RUNNER_COMPLETE_MAX_BODY_BYTES ?? 8 * 1024 * 1024);

/**
 * 勾选执行的缺失对账：`case_filter.case_keys` 减去本次 `ingest_run` 实际报到的集合，
 * 差集标 `not_run`（P4.5-9，边界 16）。
 *
 * **由平台算，不让 SDK 报「我没跑这些」**：脚本可能根本不认识 `--apitrack-case-keys`，
 * 那时它全量跑、这些 key 全都报到、差集为空，结论正确；脚本认识但崩在中途时差集非空，
 * 标 `not_run` 也正确。SDK 侧上报只对前一种成立。
 *
 * 「报到了」的判据是 `last_ingest_run_id = 本次 ingest run`，而**不是** `last_run_at`
 * 有没有更新：被 skip 的用例在 `upsertCases` 里不动 `last_run_at`（那是刻意的——一条
 * 被 skip 的用例不该把昨天的 `passed` 冲掉），但它确实报到了，不该标 `not_run`。
 *
 * 第二个条件 `last_run_at < since` 是防误伤的护栏：`since` 取 run 的 `created_at`（入队
 * 时刻，最保守的下界）。别的执行在这条 run 排队之后报过这条用例时，它的 `last_run_at`
 * 会新于 `since`，于是不动它——宁可少标一条（树上多留一天旧结论），不可把一条刚跑过的
 * 用例误标成没跑。
 *
 * `ingestRunId` 为 null（任务没开 SDK 上报 / 脚本没跑到 SDK / 整份上报失败）时全集都算
 * 差集：平台确实无从得知这些 key 跑了没有，而 `not_run` 正是这个事实的名字——比留着
 * 上一轮的 `passed` 让人以为「这次也通过了」诚实。
 */
async function markCaseFilterNotRun(
  client: import("pg").PoolClient,
  projectId: string,
  caseKeys: string[],
  ingestRunId: string | null,
  since: unknown,
): Promise<number> {
  if (!caseKeys.length) return 0;
  /* `since` 原样传 pg 驱动（Date 对象直接绑成 timestamptz）。**不要** `String(date)`：
     那给出 `Tue Sep 01 2026 …` 这种本地化文本，Postgres 解析它靠 DateStyle 设置，
     换个库参数就变成一次运行时错误——而这个分支只在勾选执行时走到，不会在日常路径上
     被发现。 */
  const marked = await client.query(
    `UPDATE repo_test_cases SET last_result = 'not_run', updated_at = now()
      WHERE project_id = $1 AND case_key = ANY($2::text[])
        AND ($3::uuid IS NULL OR last_ingest_run_id IS DISTINCT FROM $3::uuid)
        AND (last_run_at IS NULL OR $4::timestamptz IS NULL OR last_run_at < $4::timestamptz)
        AND last_result <> 'not_run'`,
    [projectId, caseKeys, ingestRunId, since ?? null],
  );
  return marked.rowCount ?? 0;
}

/** 落库的 `case_filter`（jsonb）里的 key 列表。写入侧已去重并限长（lib/trigger.ts）。 */
function caseFilterKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const keys = (raw as { case_keys?: unknown }).case_keys;
  if (!Array.isArray(keys)) return [];
  return keys.map((each) => String(each ?? "").trim()).filter(Boolean);
}

/** `execution_index.status` 的 CHECK（迁移 015）只有五个值，pipeline 侧多出的两个要归一：
 * `aborted` / `timed_out` 都是「平台基础设施/超时」的事实，归到 `failed` 并保留 run 行上的
 * 原状态——统一执行记录页要能筛出来，但它的状态枚举不为 pipeline 扩两个值（改 CHECK 是
 * 一次口径变更，`aborted` 在 flow/suite 语境里根本不存在）。 */
function indexStatusOf(status: CompleteStatus): "success" | "failed" | "canceled" {
  if (status === "success") return "success";
  if (status === "canceled") return "canceled";
  return "failed";
}

/**
 * Runner 的 job 行是否仍由这台 Runner 持有且在途。
 *
 * 心跳与 complete 共用的判据（`WHERE runner_id = $2 AND status IN (...)`）：终态已落、
 * 租约被回收判 `aborted`、被别的 Runner 认领，三种情况都读作「这个 job 不再是我的」。
 */
const ACTIVE_GUARD = "status IN ('claimed', 'running', 'cancelling')";

export type AppendLogsResult =
  | { ok: false; reason: "not_found" | "not_owner" | "bad_offset" }
  | { ok: true; nextOffset: number; projectId: string; totalLogBytes: number };

/**
 * 接收一段日志（8.2 接口 4）。断线重传的去重就是 `UNIQUE (pipeline_run_id, byte_offset)`
 * （迁移 038，边界 7）：Runner 重发的 chunk 撞唯一键，`ON CONFLICT DO NOTHING` 幂等收。
 *
 * `next_offset` 的答案永远是**当前总长**（`log_bytes`），而不是「这段的尾」——它回答的
 * 问题是「我应该从哪接着发」，而不是「我刚才发的这段到哪了」。
 *
 * **已终态的 run 仍收日志**：Runner 的收尾顺序是 complete → 传产物（runners.ts 申请
 * 接口注释里的共识），产物上传的成败行（reportBundle 的 `report-bundle: …`）必然落在
 * 终态之后；此外杀掉进程树后 shell 的残余输出还会流一小会儿。按在途拒掉只会把这些行
 * 全部吞掉——一次「报告包为什么没传上来」就变得无迹可寻。归属（`runner_id`）仍是硬
 * 判据，FOR UPDATE 锁行保证与终态写入不交错。
 */
export async function appendPipelineRunLogs(input: {
  runId: string;
  runnerId: string;
  byteOffset: number;
  chunk: string;
}): Promise<AppendLogsResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* 归属锁行判掉：不锁的话「回收器判 aborted」与「收最后一段日志」竞态，终态后日志
       行还在插入，`log_bytes` 与日志表的实际内容自相矛盾。 */
    const run = await client.query(
      `SELECT project_id, runner_id, log_bytes FROM pipeline_runs
         WHERE id = $1 FOR UPDATE`,
      [input.runId],
    );
    if (!run.rowCount) return { ok: false, reason: "not_found" };
    const row = run.rows[0];
    if (String(row.runner_id ?? "") !== input.runnerId) return { ok: false, reason: "not_owner" };

    /* offset 不允许落在已收窗口**之内**重写（重传恰好等于 log_bytes 的那段是幂等收的），
       但不允许倒回或跳空：倒回会撞唯一键静默丢弃（调用方误以为成功），跳空会造出
       「总长比日志表内容长」的永久缺口。 */
    const current = Number(row.log_bytes);
    if (input.byteOffset < current) {
      /* 完全重合的重传：唯一约束会收下它，但对调用方来说答案与第一次相同。 */
      const end = input.byteOffset + Buffer.byteLength(input.chunk, "utf8");
      if (end <= current) {
        await client.query("COMMIT");
        return { ok: true, nextOffset: current, projectId: String(row.project_id), totalLogBytes: current };
      }
      return { ok: false, reason: "bad_offset" };
    }
    if (input.byteOffset > current) return { ok: false, reason: "bad_offset" };

    await client.query(
      `INSERT INTO pipeline_run_logs (pipeline_run_id, byte_offset, chunk)
       VALUES ($1, $2, $3)
       ON CONFLICT (pipeline_run_id, byte_offset) DO NOTHING`,
      [input.runId, input.byteOffset, input.chunk],
    );
    /* 总长是**重算**而不是「当前 + chunk 长度」：唯一约束 DO NOTHING 的重传分支里两者
       会分叉，重算永远与日志表的实际内容一致（settleBatch 同款纪律）。 */
    const updated = await client.query(
      `UPDATE pipeline_runs pr SET log_bytes = (
         SELECT COALESCE(MAX(byte_offset + octet_length(chunk)), 0) FROM pipeline_run_logs
          WHERE pipeline_run_id = pr.id
       ) WHERE pr.id = $1 RETURNING log_bytes, project_id`,
      [input.runId],
    );
    await client.query("COMMIT");
    const total = Number(updated.rows[0].log_bytes);
    return { ok: true, nextOffset: total, projectId: String(updated.rows[0].project_id), totalLogBytes: total };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type CompleteResult =
  | { ok: false; reason: "not_found" | "not_owner" | "conflict"; message?: string }
  | { ok: true; projectId: string; status: CompleteStatus };

/**
 * 落终态（8.2 接口 6）。**必须幂等**（约定 5）：Runner 在收到响应前断线会重发，第二次
 * 撞终态守卫返回 ok 而不是报错——报错会让 Runner 无限重试。守卫形状照抄 `run.ts:497`
 * （`WHERE id=$1 AND status IN ('claimed','running','cancelling')`）。
 *
 * 同一事务里做四件事：
 * 1. 终态守卫 UPDATE `pipeline_runs`（`canceled` 额外要求当前是 `cancelling`）；
 * 2. 首次终态时写 `execution_index`（kind='runner'，`UNIQUE (kind, detail_id)` 保证
 *    重发复用同一行——重发撞守卫根本走不到这里，这是双保险）并回填 `execution_index_id`；
 * 3. `cases[]`（junit/allure 报告解析结果）批插 `pipeline_run_cases`；
 * 4. 吊销 claim 时现签的那张 ingest token（jobSpec.ts 的注释说好的「complete 顺手吊销」，
 *    防行数无界增长）。
 *
 * `ingest_run_id` 的缝合（8.2 约定 8；2026-09-03 迁移 045 改口径）：同 commit 的上报
 * 折同一行 ingest run，这里按 `(repository, commit_sha)` 反查——查到就回填，查不到
 * （任务没开 SDK 上报 / 脚本没跑 SDK）就留空。
 */
export async function completePipelineRun(input: {
  runId: string;
  runnerId: string;
  status: string;
  exitCode?: number;
  commitSha?: string;
  cases?: ReportCase[];
  error?: string;
}): Promise<CompleteResult> {
  const status = String(input.status ?? "").trim() as CompleteStatus;
  if (!COMPLETE_STATUSES.includes(status)) {
    return { ok: false, reason: "conflict", message: `status must be one of ${COMPLETE_STATUSES.join(", ")}` };
  }
  const cases = Array.isArray(input.cases) ? input.cases.slice(0, MAX_REPORT_CASES) : [];
  const commitSha = input.commitSha?.trim() ?? "";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* 守卫 UPDATE：`canceled` 只能从 `cancelling` 来（取消只经心跳下发），其余终态从
       三个在途态都能落（超时/失败/aborted 不依赖任何前置状态）。行锁由 UPDATE 自带。 */
    const guard = status === "canceled"
      ? "status = 'cancelling'"
      : ACTIVE_GUARD;
    const settled = await client.query(
      `UPDATE pipeline_runs SET
         status = $3, stage = 'done', exit_code = $4, error = $5,
         commit_sha = CASE WHEN $6 <> '' THEN $6 ELSE commit_sha END,
         finished_at = now(), lease_expires_at = NULL
       WHERE id = $1 AND runner_id = $2 AND ${guard}
        RETURNING project_id, created_at, claimed_at, run_number, ci_task_id, trigger_source, trigger_ref_id, trigger_ref_name,
                  triggered_by, git_ref, case_total, passed_count, failed_count, skipped_count,
                  log_bytes, case_filter, parameters, commit_sha`,
      [input.runId, input.runnerId, status,
       input.exitCode === undefined || input.exitCode === null ? null : Math.trunc(Number(input.exitCode)),
       input.error ?? null, commitSha],
    );

    /* 撞守卫的两种读法：行还在且属于这台 Runner → 幂等重发，回 ok；行不在或换了主人 →
       409。区分「重发成功」与「不归我管」是幂等语义的全部（约定 5）。 */
    if (!settled.rowCount) {
      const existing = await client.query(
        "SELECT runner_id, status FROM pipeline_runs WHERE id = $1",
        [input.runId],
      );
      if (existing.rowCount && String(existing.rows[0].runner_id ?? "") === input.runnerId) {
        await client.query("COMMIT");
        return { ok: true, projectId: "", status: existing.rows[0].status as CompleteStatus };
      }
      if (!existing.rowCount) return { ok: false, reason: "not_found" };
      return { ok: false, reason: "not_owner" };
    }

    const run = settled.rows[0];
    const projectId = String(run.project_id);

    /* 报告 cases 先落（迁移 038：`source` 只有 junit/allure）。重发撞守卫走不到这里，
       但防御性 ON CONFLICT 仍留着——同一份报告在 complete 与重发之间理论可分两次到。 */
    if (cases.length) {
      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const each of cases) {
        const source = String(each.source ?? "").trim();
        if (source !== "junit" && source !== "allure") continue;
        const suiteName = String(each.suite_name ?? each.suiteName ?? "").slice(0, 512);
        const caseName = String(each.case_name ?? each.caseName ?? "").slice(0, 512);
        if (!caseName) continue;
        const guessed = each.guessed_case_key ?? each.guessedCaseKey;
        const caseStatus = String(each.status ?? "").trim();
        if (!["passed", "failed", "skipped", "error"].includes(caseStatus)) continue;
        const duration = Math.max(0, Math.trunc(Number(each.duration_ms ?? each.durationMs ?? 0)) || 0);
        const message = each.message === undefined || each.message === null ? null : String(each.message).slice(0, 8000);
        /* external_id（迁移 044）：allure 结果文件的 uuid。同名参数化用例的两次执行在
           (run, source, suite, case_name) 上不可分，没有它 ON CONFLICT 会把第二条吞掉。 */
        const externalId = String(each.external_id ?? each.externalId ?? "").trim().slice(0, 128);
        /* P4.5-13：时间戳/host/thread 收口同款纪律（截断 + 归一，垃圾值进 NULL 而不是
           0——0 是 1970 年，会造出假的时间轴原点）。 */
        const startedAt = each.started_at_ms ?? each.startedAtMs ?? null;
        const finishedAt = each.finished_at_ms ?? each.finishedAtMs ?? null;
        const host = each.host === undefined || each.host === null ? null : String(each.host).slice(0, 512) || null;
        const thread = each.thread === undefined || each.thread === null ? null : String(each.thread).slice(0, 512) || null;
        const base = values.length;
        tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14})`);
        values.push(randomUUID(), input.runId, source, suiteName, caseName,
          guessed === undefined || guessed === null || guessed === "" ? null : String(guessed).slice(0, 512),
          caseStatus, duration, message, externalId,
          Number.isFinite(Number(startedAt)) && Number(startedAt) > 0 ? Math.trunc(Number(startedAt)) : null,
          Number.isFinite(Number(finishedAt)) && Number(finishedAt) > 0 ? Math.trunc(Number(finishedAt)) : null,
          host, thread);
      }
      if (tuples.length) {
        await client.query(
          `INSERT INTO pipeline_run_cases (
             id, pipeline_run_id, source, suite_name, case_name, guessed_case_key, status, duration_ms, message,
             external_id, started_at_ms, finished_at_ms, host, thread
           ) VALUES ${tuples.join(", ")}
           ON CONFLICT (pipeline_run_id, source, suite_name, case_name, external_id) DO NOTHING`,
          values,
        );
      }
    }

    /* 报告计数从已插的行走（重算而不是信请求体）：`pipeline_run_cases` 是唯一权威副本。
     * `error`（allure broken/unknown → Runner 映射）算失败不算跳过（2026-09-02 验收反馈
     * 第三批 ③）：前端处处把 error 渲染成失败色，计数却把它塞进跳过，标题与列表对不上。 */
    const counts = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
              COUNT(*) FILTER (WHERE status IN ('failed', 'error'))::int AS failed,
              COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
         FROM pipeline_run_cases WHERE pipeline_run_id = $1`,
      [input.runId],
    );
    const aggregate = counts.rows[0];

    /* SDK 路径缝合：按 (project, commit) 折合行反查（迁移 045 口径变更——同 commit 的
       上报折同一行 ingest run，ci_run_id 不再是查询键）。run 行上有 commit_sha（claim
       时 Runner 报过、complete 守卫 UPDATE 也可能刚写过），仓库归属用 project 下的绑定
       仓库（一项目一仓库，迁移 034 的 UNIQUE）。 */
    const ingestRun = await client.query(
      `SELECT ir.id FROM ingest_runs ir
          JOIN repositories r ON r.id = ir.repository_id
         WHERE ir.project_id = $1 AND ir.commit_sha = $2
         ORDER BY ir.created_at DESC LIMIT 1`,
      [projectId, String(run.commit_sha ?? input.commitSha ?? "")],
    );
    const ingestRunId = ingestRun.rowCount ? String(ingestRun.rows[0].id) : null;

    /* 勾选执行的差集对账（P4.5-9，边界 16）。放在这里而不是 `/ingest` 的事务里：那边
       拿得到「报到了什么」但拿不到 `case_filter`（SDK 不知道平台勾了哪些 key），而这里
       run 行上的 `case_filter` 与反查出的 `ingestRunId` 同时在手。
       时序：SDK 在 `pytest_sessionfinish` 上报，早于 Runner 的 `complete`，所以正常路径
       上 `ingestRunId` 已经能查到。 */
    const filteredKeys = caseFilterKeys(run.case_filter);
    if (filteredKeys.length) {
      await markCaseFilterNotRun(client, projectId, filteredKeys, ingestRunId, run.created_at);
    }

    /* 归一进统一执行记录（P4.5-4 的核心交付）：kind='runner'，detail_id = run id。
       `UNIQUE (kind, detail_id)` 天然防重复；target_id = ci_task_id、target_name 用
       「任务名 #序号」——任务删除级联掉 run，历史索引行靠无 FK 的快照活下来。
       `aborted`/`timed_out` 归一成 `failed`（见 indexStatusOf），run 行上保留原状态。 */
    const task = await client.query("SELECT name FROM ci_tasks WHERE id = $1", [String(run.ci_task_id)]);
    const taskName = task.rowCount ? String(task.rows[0].name) : "ci task";
    const indexId = randomUUID();
    const indexStatus = indexStatusOf(status);
    await client.query(
      `INSERT INTO execution_index (
         id, project_id, kind, target_id, target_name, detail_id, status,
         total, success_count, failed_count, skipped_count, canceled_count,
         trigger_source, trigger_ref_id, trigger_ref_name, started_at, finished_at
       ) VALUES ($1, $2, 'runner', $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $13, $14, now())
       ON CONFLICT (kind, detail_id) DO UPDATE SET
         status = EXCLUDED.status, total = EXCLUDED.total,
         success_count = EXCLUDED.success_count, failed_count = EXCLUDED.failed_count,
         skipped_count = EXCLUDED.skipped_count, finished_at = EXCLUDED.finished_at`,
      [
        indexId, projectId, String(run.ci_task_id), `${taskName} #${Number(run.run_number)}`, input.runId,
        indexStatus, Number(aggregate.total), Number(aggregate.passed), Number(aggregate.failed),
        indexStatus === "canceled" ? 1 : 0,
        String(run.trigger_source ?? "manual"),
        run.trigger_ref_id ? String(run.trigger_ref_id) : null,
        run.trigger_ref_name ? String(run.trigger_ref_name) : null,
        /* started_at 用 claimed_at：execution_index 没有排队等待列，`created_at` 是入队
           时刻，`claimed_at` 才是「开始执行」——统一记录页的耗时口径用后者。 */
        run.claimed_at ?? null,
      ],
    );
    /* ON CONFLICT 的 UPDATE 分支换了另一行索引 id 时（防御分支）不回填旧 id；正常路径
       回填本事务签的那个。 */
    await client.query(
      `UPDATE pipeline_runs SET execution_index_id = $2, ingest_run_id = COALESCE($3, ingest_run_id),
         case_total = $4, passed_count = $5, failed_count = $6, skipped_count = $7
       WHERE id = $1 AND execution_index_id IS NULL`,
      [input.runId, indexId, ingestRunId,
       Number(aggregate.total), Number(aggregate.passed), Number(aggregate.failed), Number(aggregate.skipped)],
    );

    /* 吊销 claim 时现签的 ingest token（jobSpec.ts 注释的另一半）：名字带 `ci ` 前缀的
       才是 CI 签的，绝不动用户手工建的那几张。防的是行数无界增长——每个 run 一张。 */
    await client.query(
      `UPDATE ingest_tokens SET revoked_at = COALESCE(revoked_at, now())
         WHERE project_id = $1 AND name LIKE 'ci %' AND revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM pipeline_runs live
              WHERE live.project_id = $1 AND live.status IN ('queued', 'claimed', 'running', 'cancelling')
           )`,
      [projectId],
    );

    /* 任务级串行的唤醒（P4.5-12）：这条 run 刚离开在途集合，同任务被守卫挡住的那条排队
       run 现在可领了。在事务里发、随 COMMIT 投递——回滚时不会误唤醒。 */
    await notifySerializedQueue(client, String(run.ci_task_id));

    await client.query("COMMIT");

    /* SSE（P4.5-4）：终态事件 + 日志水位快照。发布失败不影响落库——事件是通知不是事实。 */
    await publishEvent({ kind: "pipeline", projectId, pipelineRunId: input.runId, executionIndexId: indexId, status }).catch(() => {});
    await publishEvent({ kind: "pipelineLog", projectId, pipelineRunId: input.runId, logBytes: Number(run.log_bytes) }).catch(() => {});
    return { ok: true, projectId, status };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 在途 run 的状态推进事件（`claimed` / `running` / `cancelling`）。
 *
 * `running` 由第一次 `logs` 推进（收到输出就是「真的在跑了」），`claimed`/`cancelling`
 * 分别在 claim 与 cancel 落库后由调用方顺手发。集中在这一个模块：三种推进的载荷形状
 * 必须是同一份，散在三个路由里迟早漂移。
 */
export async function publishPipelineTransition(projectId: string, runId: string, status: string, stage?: string) {
  await publishEvent({ kind: "pipeline", projectId, pipelineRunId: runId, status, stage }).catch(() => {});
}

/** `pool` 与事务里的 `PoolClient` 都满足它——下面那个唤醒在两种场景都要用。 */
type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };

/**
 * 任务级串行的**唤醒**（P4.5-12，迁移 042）。
 *
 * 一条 run 离开在途集合（落终态、queued 被直接取消），或者串行开关被关掉之后，同任务里
 * 原本被串行守卫挡住的排队 run 就变成可认领了——但没有任何人会告诉正在长轮询的 Runner
 * 这件事：`pg_notify('pipeline_queued')` 只在**入队**时发（`lib/trigger.ts`）。不补这一发，
 * 「上一个跑完自动跑下一个」要等下一个轮询周期，最坏多等一整个窗口（25 秒）。
 *
 * 按**排队 run 自己的标签**发而不是刚结束那条的标签：任务的 `runner_label` 可能在两次
 * 触发之间被改过，run 行上的是触发时冻结的快照。
 *
 * **不按 `single_concurrency` 过滤**：本函数只回答「这个任务还有排队的 run 吗」。关掉串行
 * 的那一刻恰恰需要唤醒（那时列已经是 false），而对从来不串行的任务多发一次通知是无害的
 * ——认领扫描本来就会把它挑走，最坏是一次注定 204 的提前醒。
 *
 * 在事务里调用时 NOTIFY 随 COMMIT 投递（Postgres 语义），所以它不会在回滚的路径上误发。
 */
export async function notifySerializedQueue(client: Queryable, ciTaskId: string): Promise<void> {
  const labels = await client.query(
    "SELECT DISTINCT runner_label FROM pipeline_runs WHERE ci_task_id = $1 AND status = 'queued'",
    [ciTaskId],
  );
  for (const row of labels.rows) {
    await client.query("SELECT pg_notify('pipeline_queued', $1)", [String(row.runner_label)]);
  }
}

/**
 * 租约过期判 `aborted`（scheduler 的回收器调用，约定 4 / 边界 5）。
 *
 * 回收路径也走这一份归一写入：一条被回收的 run 永远等不到 `complete`，若不在这里补
 * `execution_index`（kind='runner'），「执行记录页按 runner 筛」就少一类行——而且是最
 * 需要被看见的那一类（机器没了）。守卫与 `completePipelineRun` 同款：只动在途行，
 * 防与迟到的 `complete` 竞态双写。
 */
export async function abortPipelineRunAfterLease(client: import("pg").PoolClient): Promise<{ id: string; projectId: string }[]> {
  const reaped = await client.query(
    `UPDATE pipeline_runs SET status = 'aborted', error = 'runner lease expired', stage = 'done',
            finished_at = now(), lease_expires_at = NULL
      WHERE status IN ('claimed', 'running', 'cancelling') AND lease_expires_at < now()
      RETURNING id, project_id, ci_task_id, run_number, trigger_source, trigger_ref_id, trigger_ref_name,
                claimed_at, created_at, case_filter, commit_sha`,
  );
  for (const run of reaped.rows) {
    /* 归一（与 complete 同一份口径）：aborted → index 的 'failed'，run 行保留原状态。 */
    const task = await client.query("SELECT name FROM ci_tasks WHERE id = $1", [String(run.ci_task_id)]);
    const taskName = task.rowCount ? String(task.rows[0].name) : "ci task";
    const indexId = randomUUID();
    await client.query(
      `INSERT INTO execution_index (
         id, project_id, kind, target_id, target_name, detail_id, status,
         total, success_count, failed_count, skipped_count, canceled_count,
         trigger_source, trigger_ref_id, trigger_ref_name, started_at, finished_at
       ) VALUES ($1, $2, 'runner', $3, $4, $5, 'failed', 0, 0, 0, 0, 0, $6, $7, $8, $9, now())
       ON CONFLICT (kind, detail_id) DO UPDATE SET status = 'failed', finished_at = EXCLUDED.finished_at`,
      [
        indexId, String(run.project_id), String(run.ci_task_id),
        `${taskName} #${Number(run.run_number)}`, String(run.id),
        String(run.trigger_source ?? "manual"),
        run.trigger_ref_id ? String(run.trigger_ref_id) : null,
        run.trigger_ref_name ? String(run.trigger_ref_name) : null,
        run.claimed_at ?? null,
      ],
    );
    await client.query(
      "UPDATE pipeline_runs SET execution_index_id = $2 WHERE id = $1 AND execution_index_id IS NULL",
      [String(run.id), indexId],
    );
    /* 勾选执行的差集对账也要在回收路径上做（P4.5-9）：一条被回收的 run 永远等不到
       `complete`，若只在那一边算差集，机器没了的那次勾选会把上一轮的 `passed` 一直留在
       树上——那正是最需要看见「这次没跑」的场景。SDK 可能已经报过（脚本跑完了、Runner
       才失联），所以同款反查 ingest run 而不是无条件标全集。 */
    /* 同款折合反查（迁移 045）：按 (project, commit) 找折合行；回收路径 run 行上已有
       commit_sha（claim 时写入）。 */
    const filteredKeys = caseFilterKeys(run.case_filter);
    if (filteredKeys.length) {
      const ingestRun = await client.query(
        `SELECT ir.id FROM ingest_runs ir
            JOIN repositories r ON r.id = ir.repository_id
           WHERE ir.project_id = $1 AND ir.commit_sha = $2
           ORDER BY ir.created_at DESC LIMIT 1`,
        [String(run.project_id), String(run.commit_sha ?? "")],
      );
      await markCaseFilterNotRun(
        client, String(run.project_id), filteredKeys,
        ingestRun.rowCount ? String(ingestRun.rows[0].id) : null,
        run.created_at,
      );
    }
    /* 事件在 commit 之后由调用方发（这里拿不到「已提交」这个事实之前发，事务回滚会让
       界面显示一个不存在的终态）。 */
    /* 串行唤醒与 complete 路径同一份（P4.5-12）：被回收的 run 也离开了在途集合，后面排队
       的那条不该因为「前一台机器失联」而一直等着。 */
    await notifySerializedQueue(client, String(run.ci_task_id));
  }
  return reaped.rows.map((row) => ({ id: String(row.id), projectId: String(row.project_id) }));
}
