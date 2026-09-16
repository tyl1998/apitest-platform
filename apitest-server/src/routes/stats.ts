import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { currentUser } from "../lib/auth.js";
import { coverageShapeKey, endpointPath } from "../lib/ingestPath.js";
import { FLAKY, NOT_SELF_DEBUG, passRateOf, sampleKinds, type SampleScope } from "../lib/metrics.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import type { User } from "../models/types.js";

/**
 * 全局统计（P8-4，计划 12.2 的六条接口）。
 *
 * 与项目级路由的本质区别：这些查询天然没有项目前缀，靠「有效项目集」参数收敛——
 * 系统管理员不传 projectIds 就是全量，非管理员永远被可见集（user_project_roles）
 * 兜底，显式请求不可见项目直接 403（验收门槛 6：URL 直访别人的项目数据 403）。
 *
 * 三条既定防线（边界 16 / 17 / 23）全部落在这一个文件里：
 * - **30s TTL 内存缓存**（边界 16）：进程内 Map，键 = 路由 + 可见集哈希 + 窗口参数，
 *   可见集相同的用户共享同一份（Readout 缓存命中 < 300ms 的预算靠它）。不进 Redis、
 *   不落表，重启重建；失效逻辑只有 TTL 一条，不做写失效。
 * - **statement_timeout 5s**（边界 23 故障线）：`/stats/*` 每条路由的查询跑在
 *   `BEGIN + SET LOCAL` 的事务里，超时（SQLSTATE 57014）返回 503 + 2005，绝不挂起
 *   等数据库慢慢算。5s 不是性能预算——1.5s 是 90d 出图的验收线（边界 17），超它
 *   触发汇总表立项；5s 是「已经有东西在挤占连接池」的止损线。
 * - **查询纪律**（边界 23）：窗口上限 180 天写死（超了 400 不静默截断）；仓库用例
 *   序列先按 run 集收敛再 join records；`byType`（jsonb 逐行展开）不抬到全局，留在
 *   项目级 summary；分位数（percentile_cont）只在 ≤30d 窗口提供，90d/180d 档位给
 *   null——排序成本随窗口线性涨，砍它是零 UX 损失的省法。
 *
 * EXPLAIN (ANALYZE, BUFFERS) 复核记录（2026-09-09，dev 库：executions 15.4 万行 /
 * execution_steps 15.5 万 / pipeline_run_cases 1863）：execution_index 窗口扫描走
 * `execution_index_created_at_idx`（迁移 054），失败 TopN 接口维走
 * `executions_failed_created_at_idx`（迁移 055 的 partial），Flaky 的 case_id 序列走
 * `executions_case_created_at_idx`（Index Cond 同时吃掉 case_id IS NOT NULL 与窗口），
 * 套件失败成员链（index → suite_executions → execution_steps）全 Nested Loop + 索引。
 * 小表（suite_executions 45 行 / failure_attributions 53 行 / ingest_runs 6 行）上的
 * Seq Scan 是正确计划，不补索引。`ingest_runs` 无 (created_at) 单列索引——每次 CI
 * 上报一行，量级天然低一个数量级，计划 12.1 的索引清单也刻意不含它；仓库序列查询
 * 按 run 集收敛后经 (ingest_run_id, seq) 索引取 records，规模上来 planner 自会切换。
 */

/** 窗口上限（边界 23）：写死校验，超了 400，不静默截断。 */
const MAX_WINDOW_DAYS = 180;
/** 默认窗口 30d（边界 17：90d/180d 是显式深挖，不拿最坏情况当默认体验）。 */
const DEFAULT_WINDOW_DAYS = 30;
/** 缓存 TTL（边界 16）。 */
const STATS_CACHE_TTL_MS = 30_000;
/** 统计超时错误码：前端（P8-6）按它给空态 + 缩窗建议，不白屏。 */
const STATS_TIMEOUT_CODE = 2005;
/** 榜单固定长度：找一个坏接口/坏用例不需要看完 200 行（summary byEndpoint 同款）。 */
const TOP_LIMIT = 20;
/** TopN 维度（边界 21 的六维——P8-4 先落四维，流程/仓库用例两维随 P8-7 扩参进来）。 */
const TOPN_DIMS = ["endpoint", "case", "ci_task", "suite", "flow", "repo_case"] as const;
type TopNDim = (typeof TOPN_DIMS)[number];
/** 项目对比的指标列（边界 19；2026-09-11 用户增补归因覆盖率维）。 */
const PROJECT_METRICS = ["coverage", "automation", "passRate", "failed", "attribution"] as const;
type ProjectMetric = (typeof PROJECT_METRICS)[number];
/** 趋势的触发源过滤（12.4 顶部筛选第三项）：execution_index 的 CHECK 同一套。 */
const TRIGGER_SOURCES = ["manual", "scheduled", "webhook", "ci"] as const;

type StatsQuery = {
  days?: string;
  projectIds?: string;
  scope?: string;
  triggerSource?: string;
  /** 归因来源筛选（P8-7，边界 8）：human | mcp；缺省不过滤。只作用于归因读数段。 */
  attributionSource?: string;
  metric?: string;
  topN?: string;
  order?: string;
  limit?: string;
  keyword?: string;
};

/* ─────────────────────────── 参数构建纪律 ─────────────────────────── */

/**
 * 压一个参数并返回它的 `$n` 序号。每条查询各建各的 params 数组——Postgres 的扩展
 *协议对参数个数敏感（多给报「bind message supplies N … requires M」，跳着引用报
 *「could not determine data type」），共享一个大数组让多条查询各取一段在这里行不通
 * （2026-09-09 用 node-pg 实测）。共享的只有**同一条查询内**多次引用的序号（scope
 * 数组压一次、多处 `$1`）。
 */
function pushParam(params: unknown[], value: unknown): number {
  params.push(value);
  return params.length;
}

/** 有效项目集：`all` = 不加项目过滤（系统管理员且未显式指定）；否则是一份显式
 *  id 列表（非管理员 = 可见集或其子集；管理员 = 显式指定的那几行）。缓存键按这份
 *  集合哈希——可见集相同的两个用户读同一份缓存（边界 16 的原话）。 */
type ProjectScope = { all: boolean; ids: string[] };

/** 把有效项目集压进本查询的 params（all 不压），返回序号或 null。 */
function pushScopeParam(scope: ProjectScope, params: unknown[]): number | null {
  return scope.all ? null : pushParam(params, scope.ids);
}

/** ` AND x.project_id = ANY($n)` / ` WHERE …` 两个形态，配 pushScopeParam 的序号。 */
function scopeAnd(index: number | null, column = "project_id"): string {
  return index === null ? "" : ` AND ${column} = ANY($${index}::uuid[])`;
}
function scopeWhere(index: number | null, column = "project_id"): string {
  return index === null ? "" : ` WHERE ${column} = ANY($${index}::uuid[])`;
}

async function resolveScope(user: User, requestedParam: string | undefined, reply: FastifyReply): Promise<ProjectScope | undefined> {
  /* 非 uuid 直接丢（dashboard.ts 同款纪律）：坏值不配让整个查询 500。 */
  const requested = (requestedParam?.split(",") ?? []).map((id) => id.trim()).filter(isUuid);
  if (user.isSystemAdmin) return { all: requested.length === 0, ids: requested };
  const result = await pool.query("SELECT project_id FROM user_project_roles WHERE user_id = $1", [user.id]);
  const visible = result.rows.map((row) => String(row.project_id));
  if (!requested.length) return { all: false, ids: visible };
  /* 验收门槛 6：请求里出现任何不可见项目（含不存在的 id）→ 403，不静默剔除——
     静默剔除会让「选了 5 个项目」悄悄变成「选了 3 个」，数字对不上无从排查。 */
  const visibleSet = new Set(visible);
  if (requested.some((id) => !visibleSet.has(id))) { fail(reply, 403, 1003, "forbidden"); return undefined; }
  return { all: false, ids: requested };
}

/** 缓存键里的可见集哈希：排序后哈希，顺序不同、集合相同的两个请求命中同一份。 */
function scopeCacheKey(scope: ProjectScope): string {
  if (scope.all) return "all";
  return createHash("sha1").update([...scope.ids].sort().join(",")).digest("hex").slice(0, 16);
}

/** 窗口天数：整数 1..180，超上限 400（边界 23）；缺省/空串回落默认 30d。 */
function readDays(raw: string | undefined, reply: FastifyReply): number | undefined {
  if (raw === undefined || raw === "") return DEFAULT_WINDOW_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
    fail(reply, 400, 1001, `days must be an integer between 1 and ${MAX_WINDOW_DAYS}`);
    return undefined;
  }
  return days;
}

/**
 * `?scope=platform|repo|all`（P8-5 追记：P8-6 接线时 `/stats/*` 直接采用 `SampleScope`
 * 三态，与项目级趋势/汇总同一套词表——`includeRepo` 二态就此退役）。白名单外回
 * `platform`（reports.ts 的 readSampleScope 同款纪律：口径参数不静默报错也不放大）。
 */
function readSampleScope(value: string | undefined): SampleScope {
  return value === "repo" || value === "all" ? value : "platform";
}

/** 趋势的触发源过滤：白名单外的值（含空串）一律不过滤。 */
function readTriggerSource(value: string | undefined): (typeof TRIGGER_SOURCES)[number] | undefined {
  return (TRIGGER_SOURCES as readonly string[]).includes(value ?? "") ? value as (typeof TRIGGER_SOURCES)[number] : undefined;
}

/**
 * 归因来源过滤（P8-7，边界 8「统计页可按来源筛——回答这个分类是 AI 打的还是人
 * 打的」）：`human | mcp`，白名单外不过滤（口径参数不静默报错也不放大）。作用于
 * failures 的分布段——覆盖率读数刻意保持整窗口径（筛哪个来源，「还有多少没归因」
 * 这个事实都不该变）。
 */
function readAttributionSource(value: string | undefined): "human" | "mcp" | undefined {
  return value === "human" || value === "mcp" ? value : undefined;
}

/** 窗口起点（ms → Date 参数化进 SQL，不让请求值碰 SQL 文本）。 */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/* ─────────────────────────── TTL 缓存（边界 16） ─────────────────────────── */

const statsCache = new Map<string, { expiresAt: number; data: unknown }>();

function statsCacheGet<T>(key: string): T | undefined {
  const entry = statsCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { statsCache.delete(key); return undefined; }
  return entry.data as T;
}

function statsCacheSet(key: string, data: unknown): void {
  /* 失效逻辑只有 TTL 一条（边界 16 原话）。写前顺手清一遍过期条目只是防长期驻留的
     卫生动作，不是第二套失效机制；键空间本身有界（枚举参数 × 可见集组合）。 */
  if (statsCache.size > 512) {
    const now = Date.now();
    for (const [key, entry] of statsCache) if (now > entry.expiresAt) statsCache.delete(key);
  }
  statsCache.set(key, { expiresAt: Date.now() + STATS_CACHE_TTL_MS, data });
}

/* ─────────────────────────── 5s 超时护栏（边界 23） ─────────────────────────── */

/**
 * `/stats/*` 专用：查询跑在 `BEGIN + SET LOCAL statement_timeout` 的事务里——SET
 * LOCAL 随事务结束自动还原，不污染连接池里的其他会话。超时（57014）→ 503 + 2005
 * （前端按码渲染「统计窗口过大，请缩小时间范围」的空态）；其他错误原样抛给
 * Fastify 的默认 500，与其余路由一致。
 */
async function withStatsTimeout<T>(reply: FastifyReply, run: (client: PoolClient) => Promise<T>): Promise<T | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const data = await run(client);
    await client.query("COMMIT");
    return data;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "57014") {
      fail(reply, 503, STATS_TIMEOUT_CODE, "stats query timed out; narrow the time window and retry");
      return undefined;
    }
    throw error;
  } finally {
    client.release();
  }
}

/* ─────────────────────────── 失败目标（三处共用） ─────────────────────────── */

/**
 * 窗口内「失败叶子目标」的统一母查询：归因覆盖率（overview）、归因分布（failures）、
 * 项目榜的归因列（projects）三处共用同一份口径——P8-3 报告列表的目标推导原样搬来
 * （套件失败成员：用例成员归 executions 行、流程成员归步骤行；仓库执行 = run 的
 * failed/error 用例行），只是把「按报告」换成「按窗口 + 项目集」。
 *
 * `occurred_at` 是失败**发生**时间（父执行/ run 的 created_at，不是归因时间——
 * failure_attributions.created_at 记的是打标行为，计划 12.1 明确区分）。run 侧不按
 * run 状态收窄：脚本 exit 0 但报告里有失败用例是真实存在的，P8-3 也未按 run 状态
 * 过滤。悬空归因行天然不会命中（join 方向是 target → attribution）。
 */
function failureTargetsSql(base: number, scopeIdx: number | null): string {
  return `
    SELECT ei.project_id AS project_id,
           CASE WHEN es.http_execution_id IS NOT NULL THEN 'execution' ELSE 'execution_step' END AS target_type,
           COALESCE(es.http_execution_id, es.id) AS target_id,
           ei.created_at AS occurred_at
      FROM execution_index ei
      JOIN suite_executions se ON se.execution_index_id = ei.id
      JOIN execution_steps es ON es.index_id = se.execution_index_id AND es.parent_step_id IS NULL AND es.status = 'failed'
     WHERE ei.kind = 'suite' AND ei.created_at >= $${base}${scopeAnd(scopeIdx, "ei.project_id")}
     UNION ALL
    SELECT pr.project_id, 'pipeline_run_case', prc.id, pr.created_at
      FROM pipeline_runs pr
      JOIN pipeline_run_cases prc ON prc.pipeline_run_id = pr.id AND prc.status IN ('failed', 'error')
     WHERE pr.created_at >= $${base}${scopeAnd(scopeIdx, "pr.project_id")}`;
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

/** TS 侧分位数（nearest-rank）。只用于 Flaky/MTTR 的恢复时长——三腿（API 用例 +
 *  两条仓库腿）各出一份时长数组，合并后取分位无法在一条 SQL 里完成；数组规模以窗口
 *  内失败数为上界（不是全量 executions），排序成本可忽略。 */
function percentileOf(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

/** 覆盖率序列的「≤t 计数」：升序时间戳数组上的二分上界。 */
function countUpTo(sorted: number[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 百分比（0.1 精度）；分母为 0 → null（「没有样本」与「0%」是两个事实）。 */
const rate = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;

/* ═══════════════════════════ 路由 ═══════════════════════════ */

export async function statsRoutes(app: FastifyInstance) {
  /**
   * 全局读数（Readout 行，边界 16/20）：执行面（执行量/通过率/失败量）+ 归因覆盖率
   * + 各资产总量 + 资产面四读数（接口总量/接口覆盖率/文本用例自动化覆盖率/文本用例
   * 总量）+ 7 天 delta + 触发源分布。
   *
   * delta 用 pp（百分点）不重除百分比——「从 80% 到 82%」是 +2pp，边界的原话。归因
   * 覆盖率的 delta 与主读数共用一条目标查询（FILTER 出 7d / 前 7d 两段），失败目标
   * 母查询见 failureTargetsSql。
   */
  app.get<{ Querystring: StatsQuery }>("/api/v1/stats/overview", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    const days = readDays(request.query.days, reply);
    if (days === undefined) return;
    /* 样本口径三态（SampleScope）与有效项目集（ProjectScope）是两件事，名字分开。 */
    const sampleScope = readSampleScope(request.query.scope);
    const scope = await resolveScope(user, request.query.projectIds, reply);
    if (!scope) return;

    const cacheKey = `overview|${scopeCacheKey(scope)}|${days}|${sampleScope}`;
    const cached = statsCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) return success(cached);

    const data = await withStatsTimeout(reply, async (client) => {
      /* 执行面 + delta + 触发源分布：一次窗口扫描，FILTER 出各段（dashboard 的
         settled 口径：total 含 canceled 但分母不含——canceled 是用户动作不是质量信号）。 */
      const faceParams: unknown[] = [];
      const faceScopeIdx = pushScopeParam(scope, faceParams);
      const windowStart = daysAgo(days);
      /* delta 是固定 7d vs 前 7d，与 days 无关；扫描范围取两者更早的那个。 */
      const d7 = daysAgo(7);
      const d14 = daysAgo(14);
      const baseStart = windowStart < d14 ? windowStart : d14;
      const windowIdx = pushParam(faceParams, windowStart);
      const d7Idx = pushParam(faceParams, d7);
      const d14Idx = pushParam(faceParams, d14);
      const baseIdx = pushParam(faceParams, baseStart);
      const face = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE created_at >= $${windowIdx} AND status IN ('success', 'failed', 'canceled'))::int AS total,
           COUNT(*) FILTER (WHERE created_at >= $${windowIdx} AND status = 'success')::int AS success_count,
           COUNT(*) FILTER (WHERE created_at >= $${windowIdx} AND status = 'failed')::int AS failed_count,
           COUNT(*) FILTER (WHERE created_at >= $${windowIdx} AND status = 'canceled')::int AS canceled_count,
           COUNT(*) FILTER (WHERE created_at >= $${windowIdx} AND status IN ('success', 'failed', 'canceled') AND trigger_source = 'manual')::int AS src_manual,
           COUNT(*) FILTER (WHERE created_at >= $${windowIdx} AND status IN ('success', 'failed', 'canceled') AND trigger_source = 'scheduled')::int AS src_scheduled,
           COUNT(*) FILTER (WHERE created_at >= $${windowIdx} AND status IN ('success', 'failed', 'canceled') AND trigger_source = 'webhook')::int AS src_webhook,
           COUNT(*) FILTER (WHERE created_at >= $${windowIdx} AND status IN ('success', 'failed', 'canceled') AND trigger_source = 'ci')::int AS src_ci,
           COUNT(*) FILTER (WHERE created_at >= $${d7Idx} AND status IN ('success', 'failed'))::int AS recent_settled,
           COUNT(*) FILTER (WHERE created_at >= $${d7Idx} AND status = 'success')::int AS recent_success,
           COUNT(*) FILTER (WHERE created_at >= $${d7Idx} AND status = 'failed')::int AS recent_failed,
           COUNT(*) FILTER (WHERE created_at >= $${d14Idx} AND created_at < $${d7Idx} AND status IN ('success', 'failed'))::int AS prev_settled,
           COUNT(*) FILTER (WHERE created_at >= $${d14Idx} AND created_at < $${d7Idx} AND status = 'success')::int AS prev_success,
           COUNT(*) FILTER (WHERE created_at >= $${d14Idx} AND created_at < $${d7Idx} AND status = 'failed')::int AS prev_failed
           FROM execution_index
          WHERE created_at >= $${baseIdx} AND kind IN ${sampleKinds(sampleScope)} AND ${NOT_SELF_DEBUG()}${scopeAnd(faceScopeIdx)}`,
        faceParams,
      );
      const faceRow = face.rows[0];

      /* 归因覆盖率 + delta：同一份失败目标，FILTER 出主窗口 / 近 7d / 前 7d。 */
      const attribution = await client.query(
        `WITH targets AS (${failureTargetsSql(baseIdx, faceScopeIdx)})
         SELECT
           COUNT(*) FILTER (WHERE occurred_at >= $${windowIdx})::int AS failed,
           COUNT(fa.id) FILTER (WHERE occurred_at >= $${windowIdx})::int AS attributed,
           COUNT(*) FILTER (WHERE occurred_at >= $${d7Idx})::int AS recent_failed,
           COUNT(fa.id) FILTER (WHERE occurred_at >= $${d7Idx})::int AS recent_attributed,
           COUNT(*) FILTER (WHERE occurred_at >= $${d14Idx} AND occurred_at < $${d7Idx})::int AS prev_failed,
           COUNT(fa.id) FILTER (WHERE occurred_at >= $${d14Idx} AND occurred_at < $${d7Idx})::int AS prev_attributed
          FROM targets t
          LEFT JOIN failure_attributions fa ON fa.target_type = t.target_type AND fa.target_id = t.target_id`,
        faceParams,
      );
      const attributionRow = attribution.rows[0];

      /* 资产面（存量，无窗口）：接口覆盖率的分子分母与 queryProjectMetrics 同口径
          （有用例接口 = distinct endpoint_id）；自动化覆盖率 = 非 endpoint 绑定的已评审
          用例 / 全部已评审（P7 边界 11）；spec_total 是非废弃全量（「文本用例总量」），
          repo_cases 只数 active（removed 是软删的历史，不是存量资产）。
          scope 一律用 `scopeAnd` 拼在既有 WHERE 之后——P8-4 原稿在这些子查询里用
          `scopeWhere`（自带 WHERE）后跟 `WHERE status…`，拼出双 WHERE；scope 全量时
          片段为空才侥幸合法，项目页带 projectIds 一律 500（P8-6 接线触发，缺陷②）。 */
      const assetParams: unknown[] = [];
      const assetScopeIdx = pushScopeParam(scope, assetParams);
      const assets = await client.query(
        `SELECT
            (SELECT COUNT(*)::int FROM endpoints WHERE TRUE${scopeAnd(assetScopeIdx)}) AS endpoint_total,
            (SELECT COUNT(DISTINCT endpoint_id)::int FROM test_cases WHERE TRUE${scopeAnd(assetScopeIdx)}) AS covered_endpoints,
            (SELECT COUNT(*)::int FROM test_cases WHERE TRUE${scopeAnd(assetScopeIdx)}) AS case_total,
            (SELECT COUNT(*)::int FROM flows WHERE TRUE${scopeAnd(assetScopeIdx)}) AS flow_total,
            (SELECT COUNT(*)::int FROM test_suites WHERE TRUE${scopeAnd(assetScopeIdx)}) AS suite_total,
            (SELECT COUNT(*)::int FROM spec_cases WHERE status <> 'deprecated'${scopeAnd(assetScopeIdx)}) AS spec_total,
            (SELECT COUNT(*)::int FROM spec_cases WHERE status = 'reviewed'${scopeAnd(assetScopeIdx)}) AS spec_reviewed,
            (SELECT COUNT(*)::int FROM spec_cases sc WHERE sc.status = 'reviewed' AND EXISTS (
               SELECT 1 FROM spec_case_links l WHERE l.spec_case_id = sc.id AND l.target_type <> 'endpoint')${scopeAnd(assetScopeIdx, "sc.project_id")}) AS spec_automated,
            (SELECT COUNT(*)::int FROM repo_test_cases WHERE status = 'active'${scopeAnd(assetScopeIdx)}) AS repo_case_total`,
        assetParams,
      );
      const assetsRow = assets.rows[0];

      const passRate = passRateOf(Number(faceRow.success_count), Number(faceRow.failed_count));
      const coverageRate = rate(Number(assetsRow.covered_endpoints), Number(assetsRow.endpoint_total));
      const automationRate = rate(Number(assetsRow.spec_automated), Number(assetsRow.spec_reviewed));
      const attributionRate = rate(Number(attributionRow.attributed), Number(attributionRow.failed));
      const recentPassRate = passRateOf(Number(faceRow.recent_success), Number(faceRow.recent_failed));
      const prevPassRate = passRateOf(Number(faceRow.prev_success), Number(faceRow.prev_failed));
      const recentAttributionRate = rate(Number(attributionRow.recent_attributed), Number(attributionRow.recent_failed));
      const prevAttributionRate = rate(Number(attributionRow.prev_attributed), Number(attributionRow.prev_failed));

      return {
        days,
        scope: sampleScope,
        executions: {
          total: Number(faceRow.total),
          successCount: Number(faceRow.success_count),
          failedCount: Number(faceRow.failed_count),
          canceledCount: Number(faceRow.canceled_count),
          passRate,
        },
        /* 归因覆盖率读数 + 未归因余量：低读数本身不可怕，看不见「还有多少没归因」
           才可怕（验收门槛 4）。 */
        attribution: {
          failedTargets: Number(attributionRow.failed),
          attributed: Number(attributionRow.attributed),
          unattributed: Number(attributionRow.failed) - Number(attributionRow.attributed),
          coverageRate: attributionRate,
        },
        triggerSources: [
          { source: "manual", count: Number(faceRow.src_manual) },
          { source: "scheduled", count: Number(faceRow.src_scheduled) },
          { source: "webhook", count: Number(faceRow.src_webhook) },
          { source: "ci", count: Number(faceRow.src_ci) },
        ],
        assets: {
          endpointTotal: Number(assetsRow.endpoint_total),
          coveredEndpointTotal: Number(assetsRow.covered_endpoints),
          coverageRate,
          caseTotal: Number(assetsRow.case_total),
          flowTotal: Number(assetsRow.flow_total),
          suiteTotal: Number(assetsRow.suite_total),
          specCaseTotal: Number(assetsRow.spec_total),
          specReviewedTotal: Number(assetsRow.spec_reviewed),
          specAutomatedTotal: Number(assetsRow.spec_automated),
          automationRate,
          repoCaseTotal: Number(assetsRow.repo_case_total),
        },
        /* 7 天 delta：计数给绝对差，比率给 pp（任一段没有样本 → null，不是 0——
           「不可算」与「没变化」是两个事实）。 */
        delta: {
          executions: Number(faceRow.recent_settled) - Number(faceRow.prev_settled),
          failed: Number(faceRow.recent_failed) - Number(faceRow.prev_failed),
          passRate: recentPassRate !== null && prevPassRate !== null ? Math.round((recentPassRate - prevPassRate) * 10) / 10 : null,
          attributionCoverageRate: recentAttributionRate !== null && prevAttributionRate !== null
            ? Math.round((recentAttributionRate - prevAttributionRate) * 10) / 10
            : null,
        },
      };
    });
    if (!data) return;
    statsCacheSet(cacheKey, data);
    return success(data);
  });

  /**
   * 趋势（12.3 前两行）：execution_trend = 量/通过率/分位（+ 排队分位，报告列表的
   * queue_ms 同款公式 started_at - created_at）；asset_trend = 六类资产的新增序列
   * （各表 created_at 计数；repo_test_cases 含 removed——衡量「新增行为」不是存量）。
   *
   * 桶粒度：days ≤ 2 小时桶，否则天桶（24h/48h 的细粒度看日内节奏，30d+ 看天粒度）。
   * 分位数只在 ≤30d 窗口返回（边界 23：排序成本随窗口线性涨，退化列给 null，前端
   * 画不了就藏）。桶由 SQL 的 date_trunc 生成（reports.ts 同款）——补空桶在 SQL 做，
   * 前端补桶会让「没有执行」与「全失败」长得一样。
   */
  app.get<{ Querystring: StatsQuery }>("/api/v1/stats/trend", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    const days = readDays(request.query.days, reply);
    if (days === undefined) return;
    const metric = request.query.metric === "asset_trend" ? "asset_trend" : "execution_trend";
    const sampleScope = readSampleScope(request.query.scope);
    const triggerSource = readTriggerSource(request.query.triggerSource);
    const scope = await resolveScope(user, request.query.projectIds, reply);
    if (!scope) return;

    const cacheKey = `trend|${scopeCacheKey(scope)}|${days}|${metric}|${sampleScope}|${triggerSource ?? ""}`;
    const cached = statsCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) return success(cached);

    const data = await withStatsTimeout(reply, async (client) => {
      if (metric === "asset_trend") {
        /* 每类资产一个按天聚合的 CTE，LEFT JOIN 到桶上（资产表受人工维护约束、量级
           天然有界，窗口只裁序列长度裁不掉历史，全量扫是诚实的形状）。 */
        const params: unknown[] = [];
        const scopeIdx = pushScopeParam(scope, params);
        const sinceIdx = pushParam(params, daysAgo(days));
        const bucketsBackIdx = pushParam(params, days - 1);
        const result = await client.query(
          `WITH buckets AS (
             SELECT generate_series(date_trunc('day', now()) - make_interval(days => $${bucketsBackIdx}), date_trunc('day', now()), INTERVAL '1 day') AS bucket
           ),
           ep AS (SELECT date_trunc('day', created_at) AS d, COUNT(*)::int AS n FROM endpoints WHERE created_at >= $${sinceIdx}${scopeAnd(scopeIdx)} GROUP BY 1),
           tc AS (SELECT date_trunc('day', created_at) AS d, COUNT(*)::int AS n FROM test_cases WHERE created_at >= $${sinceIdx}${scopeAnd(scopeIdx)} GROUP BY 1),
           fl AS (SELECT date_trunc('day', created_at) AS d, COUNT(*)::int AS n FROM flows WHERE created_at >= $${sinceIdx}${scopeAnd(scopeIdx)} GROUP BY 1),
           su AS (SELECT date_trunc('day', created_at) AS d, COUNT(*)::int AS n FROM test_suites WHERE created_at >= $${sinceIdx}${scopeAnd(scopeIdx)} GROUP BY 1),
           sc AS (SELECT date_trunc('day', created_at) AS d, COUNT(*)::int AS n FROM spec_cases WHERE created_at >= $${sinceIdx}${scopeAnd(scopeIdx)} GROUP BY 1),
           rc AS (SELECT date_trunc('day', created_at) AS d, COUNT(*)::int AS n FROM repo_test_cases WHERE created_at >= $${sinceIdx}${scopeAnd(scopeIdx)} GROUP BY 1)
           SELECT b.bucket,
                  COALESCE(ep.n, 0)::int AS endpoints, COALESCE(tc.n, 0)::int AS cases,
                  COALESCE(fl.n, 0)::int AS flows, COALESCE(su.n, 0)::int AS suites,
                  COALESCE(sc.n, 0)::int AS spec_cases, COALESCE(rc.n, 0)::int AS repo_cases
             FROM buckets b
             LEFT JOIN ep ON ep.d = b.bucket
             LEFT JOIN tc ON tc.d = b.bucket
             LEFT JOIN fl ON fl.d = b.bucket
             LEFT JOIN su ON su.d = b.bucket
             LEFT JOIN sc ON sc.d = b.bucket
             LEFT JOIN rc ON rc.d = b.bucket
            ORDER BY b.bucket`,
          params,
        );
        return {
          metric, days,
          buckets: result.rows.map((row) => ({
            bucket: new Date(String(row.bucket)).toISOString(),
            endpoints: Number(row.endpoints),
            cases: Number(row.cases),
            flows: Number(row.flows),
            suites: Number(row.suites),
            specCases: Number(row.spec_cases),
            repoCases: Number(row.repo_cases),
          })),
        };
      }

      /* execution_trend：样本与项目级趋势同口径（metrics.sampleKinds + NOT_SELF_DEBUG，
          P8-1 收口后的同一段实现）。触发源是样本上的过滤（12.4 顶部筛选），只作用于
          这一段——Readout 行与归因区读的是整窗事实，被它裁掉会互相打架。 */
      const unit = days <= 2 ? "hour" : "day";
      const bucketCount = unit === "hour" ? days * 24 : days;
      const withQuantiles = days <= 30;
      const params: unknown[] = [];
      const scopeIdx = pushScopeParam(scope, params);
      const triggerIdx = triggerSource ? pushParam(params, triggerSource) : null;
      const bucketsBackIdx = pushParam(params, bucketCount - 1);
      const result = await client.query(
        `WITH buckets AS (
           SELECT generate_series(
                    date_trunc('${unit}', now()) - make_interval(${unit}s => $${bucketsBackIdx}),
                    date_trunc('${unit}', now()),
                    INTERVAL '1 ${unit}') AS bucket
         )
         SELECT b.bucket,
                COUNT(ei.id)::int AS total,
                COUNT(ei.id) FILTER (WHERE ei.status = 'success')::int AS success_count,
                COUNT(ei.id) FILTER (WHERE ei.status = 'failed')::int AS failed_count,
                ${withQuantiles
                  ? `percentile_cont(ARRAY[0.5, 0.9, 0.99]) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ei.finished_at - ei.started_at)) * 1000)
                       FILTER (WHERE ei.finished_at IS NOT NULL AND ei.started_at IS NOT NULL) AS durations,
                     percentile_cont(ARRAY[0.5, 0.9]) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ei.started_at - ei.created_at)) * 1000)
                       FILTER (WHERE ei.started_at IS NOT NULL) AS queues`
                  : `NULL::float8[] AS durations, NULL::float8[] AS queues`}
           FROM buckets b
            LEFT JOIN execution_index ei
              ON ei.created_at >= b.bucket AND ei.created_at < b.bucket + INTERVAL '1 ${unit}'
             AND ei.kind IN ${sampleKinds(sampleScope)} AND ei.status IN ('success', 'failed')
             AND ${NOT_SELF_DEBUG("ei")}${scopeAnd(scopeIdx, "ei.project_id")}${triggerIdx ? ` AND ei.trigger_source = $${triggerIdx}` : ""}
           GROUP BY b.bucket ORDER BY b.bucket`,
         params,
       );
      return {
        metric, days, scope: sampleScope, triggerSource: triggerSource ?? null,
        buckets: result.rows.map((row) => ({
          bucket: new Date(String(row.bucket)).toISOString(),
          total: Number(row.total),
          successCount: Number(row.success_count),
          failedCount: Number(row.failed_count),
          /* 通过率口径（P8-1 收口）：与项目级趋势/报告/通知同一公式。 */
          passRate: passRateOf(Number(row.success_count), Number(row.failed_count)),
          p50: row.durations ? Math.round(Number(row.durations[0])) : null,
          p90: row.durations ? Math.round(Number(row.durations[1])) : null,
          p99: row.durations ? Math.round(Number(row.durations[2])) : null,
          queueP50: row.queues ? Math.round(Number(row.queues[0])) : null,
          queueP90: row.queues ? Math.round(Number(row.queues[1])) : null,
        })),
      };
    });
    if (!data) return;
    statsCacheSet(cacheKey, data);
    return success(data);
  });

  /**
   * 失败归因分布（含未归因）+ 失败 TopN（P8-4 四维；边界 21 的流程/仓库用例两维随
   * P8-7 扩参成六维）。分布的失败目标母查询与 overview/projects 同一份
   * （failureTargetsSql）——三处的「归因覆盖率」必须是从同一条 SQL 里长出来的数。
   *
   * `?attributionSource=human|mcp`（P8-7，边界 8）：分布段只数该来源的归因行——
   * 回答「这个分类是 AI 打的还是人打的」。覆盖率读数（failedTargets/attributed/
   * unattributed）**不随来源筛变化**：筛哪个来源，「还有多少没归因」都是同一个整窗
   * 事实，一份扫描顺带带出 fa.source、TS 侧挑行，不为读数再扫一遍。
   *
   * TopN 的样本口径（scope）刻意不生效：维度是显式选择（「我要看 CI 任务榜」），
   * 被别处的口径开关清空会像坏了；scope 管的是通过率/耗时这类**混合聚合**的样本
   * （overview / execution_trend / projects），那里的理由（客户端耗时不是一个口径）在
   * 「数失败次数」上不成立。
   */
  app.get<{ Querystring: StatsQuery }>("/api/v1/stats/failures", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    const days = readDays(request.query.days, reply);
    if (days === undefined) return;
    const topN = (TOPN_DIMS as readonly string[]).includes(request.query.topN ?? "")
      ? (request.query.topN as TopNDim)
      : "endpoint";
    const attributionSource = readAttributionSource(request.query.attributionSource);
    const scope = await resolveScope(user, request.query.projectIds, reply);
    if (!scope) return;

    const cacheKey = `failures|${scopeCacheKey(scope)}|${days}|${topN}|${attributionSource ?? ""}`;
    const cached = statsCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) return success(cached);

    const data = await withStatsTimeout(reply, async (client) => {
      const params: unknown[] = [];
      const scopeIdx = pushScopeParam(scope, params);
      const sinceIdx = pushParam(params, daysAgo(days));

      /* 分布：一查询出「每分类计数 + 未归因行」（category 为 NULL 的那行），
         totals 在 TS 里加总——分类行与未归因行是同一母查询的两个切面。
         筛来源（P8-7）：joined 顺带带出 fa.source，TS 侧按来源挑行——一份扫描出
         两个切面（该来源的分类分布 + 整窗的覆盖率读数），不用为读数再扫一遍。
         「另一来源」与「未归因」都进不了该来源的分布，但仍在 failedTargets 的
         分母里——覆盖率在任何筛法下都是同一个整窗事实。 */
      const distribution = await client.query(
        `WITH targets AS (${failureTargetsSql(sinceIdx, scopeIdx)}),
         joined AS (
           SELECT fa.category, fc.name AS category_name, fa.source AS attribution_source
             FROM targets t
             LEFT JOIN failure_attributions fa ON fa.target_type = t.target_type AND fa.target_id = t.target_id
             LEFT JOIN failure_categories fc ON fc.code = fa.category
         )
         SELECT category, category_name, attribution_source, COUNT(*)::int AS count
           FROM joined GROUP BY category, category_name, attribution_source`,
        params,
      );
      let failedTargets = 0;
      let attributed = 0;
      let unattributed = 0;
      /* 分类计数按 code 归并（Map）：未筛来源时同一分类可能有人打与 agent 打两行，
         分开数会让环形图出现两个「环境问题」片——来源是打标行为的属性，不是分类。 */
      const categoryCounts = new Map<string, { code: string; name: string; count: number }>();
      for (const row of distribution.rows) {
        const count = Number(row.count);
        failedTargets += count;
        if (row.category === null || row.category === undefined) unattributed += count;
        else {
          attributed += count;
          /* 来源筛选下的分布段只数该来源的行（覆盖率分子仍是全部已归因——整窗事实）。 */
          if (attributionSource === undefined || String(row.attribution_source) === attributionSource) {
            const code = String(row.category);
            const existing = categoryCounts.get(code);
            if (existing) existing.count += count;
            else categoryCounts.set(code, { code, name: String(row.category_name ?? row.category), count });
          }
        }
      }
      const categories = [...categoryCounts.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

      /* TopN：四维各一条（只跑选中的那条）。分组键都带 project——同名接口/同名套件
          在不同项目是两个失败源，榜行要能下钻到项目（case 维多带 caseId 供执行记录
          筛选用；其余三维带 refId 指向资产/任务——P8-6「榜单行 → 执行记录，筛选项
          自动填充」）。refId 的取法是 **ARRAY_AGG…[1]** 而不是 MAX/MIN：Postgres 没有
          uuid 类型的 min/max 聚合（42883），取「组内最近一次失败的引用」语义也更对
          ——同名行绝大多数同 id，取哪个都行，取最近的至少可解释。executions 的失败
          窗口走 055 的 partial 索引（EXPLAIN 已复核）。 */
      const topSql: Record<TopNDim, string> = {
        endpoint: `
          SELECT e.project_id, p.name AS project_name, e.endpoint_name AS name,
                 (ARRAY_AGG(e.endpoint_id ORDER BY e.created_at DESC) FILTER (WHERE e.endpoint_id IS NOT NULL))[1] AS ref_id,
                 COUNT(*)::int AS failed
            FROM executions e JOIN projects p ON p.id = e.project_id
           WHERE e.status = 'failed' AND e.created_at >= $${sinceIdx}${scopeAnd(scopeIdx, "e.project_id")}
           GROUP BY e.project_id, p.name, e.endpoint_name
           ORDER BY failed DESC, name, project_name LIMIT ${TOP_LIMIT}`,
        case: `
          SELECT e.project_id, p.name AS project_name, e.case_id AS case_id,
                 COALESCE(NULLIF(e.case_name, ''), e.endpoint_name) AS name, COUNT(*)::int AS failed
            FROM executions e JOIN projects p ON p.id = e.project_id
           WHERE e.status = 'failed' AND e.case_id IS NOT NULL AND e.created_at >= $${sinceIdx}${scopeAnd(scopeIdx, "e.project_id")}
           GROUP BY e.project_id, p.name, e.case_id, COALESCE(NULLIF(e.case_name, ''), e.endpoint_name)
           ORDER BY failed DESC, name, project_name LIMIT ${TOP_LIMIT}`,
        ci_task: `
          SELECT t.project_id, p.name AS project_name, t.id AS ref_id, t.name AS name, COUNT(*)::int AS failed
            FROM pipeline_runs pr
            JOIN ci_tasks t ON t.id = pr.ci_task_id
            JOIN projects p ON p.id = t.project_id
           WHERE pr.status IN ('failed', 'aborted', 'timed_out') AND pr.created_at >= $${sinceIdx}${scopeAnd(scopeIdx, "pr.project_id")}
           GROUP BY t.project_id, p.name, t.id, t.name
           ORDER BY failed DESC, name, project_name LIMIT ${TOP_LIMIT}`,
        suite: `
          SELECT ei.project_id, p.name AS project_name, ei.target_name AS name,
                 (ARRAY_AGG(ei.target_id ORDER BY ei.created_at DESC) FILTER (WHERE ei.target_id IS NOT NULL))[1] AS ref_id,
                 COUNT(*)::int AS failed
            FROM execution_index ei JOIN projects p ON p.id = ei.project_id
           WHERE ei.kind = 'suite' AND ei.status = 'failed' AND ei.created_at >= $${sinceIdx}${scopeAnd(scopeIdx, "ei.project_id")}
           GROUP BY ei.project_id, p.name, ei.target_name
           ORDER BY failed DESC, name, project_name LIMIT ${TOP_LIMIT}`,
        /* 按流程（边界 21 P8-7 扩参）：kind='flow' 的失败父执行按 target_name 分组。
            采样与 suite 维同构（execution_index 的父执行行）；单步调试的自指行
            顺带排除——它不是一次流程运行，count 的是「失败的流程执行」。 */
        flow: `
          SELECT ei.project_id, p.name AS project_name, ei.target_name AS name,
                 (ARRAY_AGG(ei.target_id ORDER BY ei.created_at DESC) FILTER (WHERE ei.target_id IS NOT NULL))[1] AS ref_id,
                 COUNT(*)::int AS failed
            FROM execution_index ei JOIN projects p ON p.id = ei.project_id
           WHERE ei.kind = 'flow' AND ei.status = 'failed' AND ${NOT_SELF_DEBUG("ei")}${scopeAnd(scopeIdx, "ei.project_id")}
             AND ei.created_at >= $${sinceIdx}
           GROUP BY ei.project_id, p.name, ei.target_name
           ORDER BY failed DESC, name, project_name LIMIT ${TOP_LIMIT}`,
        /* 按仓库用例（边界 21 P8-7 扩参）：窗口内 pipeline_run_cases 的 failed/error
         * 行按用例身份归并计数（计划原话——repo_test_cases.last_result 只是最新一次
         * 状态，不拿来数窗口内失败次数）。身份不是裸 guessed_case_key：同一条用例会
         * 以两种 key 形态出现（`pkg.Mod#test` 与 `pkg/Mod.py::test`，参数化后缀另算），
         * 裸 key 分组会把一条用例拆成两行（2026-09-10 验收五轮④）——这里用
         * ingest.ts 匹配 repo_test_cases 的同一把尺（去参数化后缀直等 + `#` 形态折算）
         * 归并到用例行，未匹配的行退回去参数化的裸 key 成组（天然排除 NULL key）。
         * 榜行 name = 规范 case_key（未匹配时退化 key），下钻由前端拿它去用例树的
         * keyword 检索——不再带 refId 指向某一次 run（验收五轮④：「跳到具体某一次
         * 执行记录很奇怪」，用例树才是这条用例的资产页，历史在它的抽屉里）。 */
        repo_case: `
          SELECT pr.project_id, p.name AS project_name,
                 COALESCE(c.case_key, regexp_replace(prc.guessed_case_key, '\\[[^\\]]*\\]$', '')) AS name,
                 COUNT(*)::int AS failed
            FROM pipeline_runs pr
            JOIN pipeline_run_cases prc ON prc.pipeline_run_id = pr.id AND prc.status IN ('failed', 'error')
            JOIN projects p ON p.id = pr.project_id
            LEFT JOIN repo_test_cases c ON c.project_id = pr.project_id AND (
                 regexp_replace(prc.guessed_case_key, '\\[[^\\]]*\\]$', '') = c.case_key
                 OR (prc.guessed_case_key LIKE '%#%'
                     AND c.case_key = concat(replace(split_part(prc.guessed_case_key, '#', 1), '.', '/'), '.py::',
                                             regexp_replace(split_part(prc.guessed_case_key, '#', 2), '\\[[^\\]]*\\]$', ''))))
           WHERE prc.guessed_case_key IS NOT NULL AND pr.created_at >= $${sinceIdx}${scopeAnd(scopeIdx, "pr.project_id")}
           GROUP BY pr.project_id, p.name, COALESCE(c.case_key, regexp_replace(prc.guessed_case_key, '\\[[^\\]]*\\]$', ''))
           ORDER BY failed DESC, name, project_name LIMIT ${TOP_LIMIT}`,
      };
      const top = await client.query(topSql[topN], params);

      return {
        days,
        attribution: {
          failedTargets,
          attributed,
          unattributed,
          coverageRate: rate(attributed, failedTargets),
          distribution: categories,
        },
        /* 随行带出来源筛选（P8-7）：null = 未筛（全量视图）。 */
        attributionSource: attributionSource ?? null,
        topN,
        top: top.rows.map((row) => ({
          projectId: String(row.project_id),
          projectName: String(row.project_name),
          name: String(row.name),
          ...(topN === "case" && row.case_id ? { caseId: String(row.case_id) } : {}),
          ...(topN !== "case" && row.ref_id ? { refId: String(row.ref_id) } : {}),
          failed: Number(row.failed),
        })),
      };
    });
    if (!data) return;
    statsCacheSet(cacheKey, data);
    return success(data);
  });

  /**
   * 不稳定用例榜（12.3）：三条腿——executions 按 case_id 的定局序列（api）、仓库用例
   * 的 SDK 上报序列（repo：ingest_records 按 run 归并出每次上报的用例结论，推断规则与
   * ingest.ts 的 deriveResult 同一条：任一 record passed=false 即 failed，否则任一
   * passed=true 即 passed，没有结论即 unknown 且不入序列）、**仓库任务序列（runner，
   * 2026-09-10 验收五轮⑤：平台 Runner 跑的 CI 任务此前不进榜——「仓库用例老翻」只看
   * 外部上报会漏掉一半通道）**：pipeline_run_cases 按 (run, key) 折出结论（同 run 同
   * key 多行时任一 failed/error 即 failed，否则任一 passed 即 success，全 skipped 不
   * 入序列——与通过率分母同判据），身份用与 TopN repo_case 同一把规范尺（匹配
   * repo_test_cases，未匹配退去参数化裸 key）。判定阈值见 metrics.FLAKY。
   *
   * 同一批查询顺带出 MTTR（失败 → 首次转绿——「首次」不是「下一跑」：失败后连红
   * 三跑再绿，恢复时间算到那次绿上，`MIN(...) FILTER (...) OVER (ROWS 1 FOLLOWING …)`
   * 的窗口形状）与窗口内首跑通过率（新用例质量的近似：以窗口内首跑代替全历史首跑，
   * 全历史 MIN(created_at) 没有窗口下界、是全表扫描，违反边界 23）。三腿的恢复时长
   * 各是数组，合并取分位只能在 TS 做（percentileOf）。仓库两条腿把结论归一成
   * success/failed，与 API 腿共用同一份 HAVING 模板（metrics.FLAKY 拼的数字）。
   */
  app.get<{ Querystring: StatsQuery }>("/api/v1/stats/flaky", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    const days = readDays(request.query.days, reply);
    if (days === undefined) return;
    const scope = await resolveScope(user, request.query.projectIds, reply);
    if (!scope) return;

    const cacheKey = `flaky|${scopeCacheKey(scope)}|${days}`;
    const cached = statsCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) return success(cached);

    const data = await withStatsTimeout(reply, async (client) => {
      const params: unknown[] = [];
      const scopeIdx = pushScopeParam(scope, params);
      const sinceIdx = pushParam(params, daysAgo(days));
      const having = `HAVING COUNT(*) >= ${FLAKY.MIN_RUNS}
             AND COUNT(*) FILTER (WHERE prev_status IS NOT NULL AND status <> prev_status) >= ${FLAKY.MIN_FLIPS}
             AND COUNT(*) FILTER (WHERE status = 'success') >= ${FLAKY.MIN_PASSED}
             AND COUNT(*) FILTER (WHERE status = 'failed') >= ${FLAKY.MIN_FAILED}`;

      /* API 用例腿：榜 + 名字（case_name 快照取最新一条，Spec 4.4 删除后仍读得通）。 */
      const apiFlaky = await client.query(
        `WITH seq AS (
           SELECT id, case_id, project_id, status, case_name, created_at,
                  LAG(status) OVER w AS prev_status
             FROM executions
            WHERE case_id IS NOT NULL AND status IN ('success', 'failed') AND created_at >= $${sinceIdx}${scopeAnd(scopeIdx)}
            WINDOW w AS (PARTITION BY case_id ORDER BY created_at, id)
         )
         SELECT f.case_id, f.project_id, p.name AS project_name, f.case_name,
                f.runs, f.passed, f.failed, f.flips, f.last_run_at
           FROM (
             SELECT case_id, project_id,
                    (ARRAY_AGG(case_name ORDER BY created_at DESC, id DESC))[1] AS case_name,
                    COUNT(*)::int AS runs,
                    COUNT(*) FILTER (WHERE status = 'success')::int AS passed,
                    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                    COUNT(*) FILTER (WHERE prev_status IS NOT NULL AND status <> prev_status)::int AS flips,
                    MAX(created_at) AS last_run_at
               FROM seq
              GROUP BY case_id, project_id
              ${having}
           ) f
           LEFT JOIN projects p ON p.id = f.project_id
          ORDER BY f.flips DESC, f.failed DESC, f.last_run_at DESC
          LIMIT ${TOP_LIMIT}`,
        params,
      );

      /* 仓库用例腿：先按 run 归并出用例结论（边界 23：先按 run 集收敛再取 records，
         绝不反着来），结论归一成 success/failed 后与 API 腿共用判定。 */
      const repoFlaky = await client.query(
        `WITH run_results AS (
           SELECT r.repo_case_id, r.ingest_run_id, ir.project_id, ir.created_at AS run_at,
                  CASE WHEN BOOL_OR(r.passed = false) THEN 'failed'
                       WHEN BOOL_OR(r.passed = true) THEN 'passed'
                       ELSE 'unknown' END AS result
             FROM ingest_runs ir
             JOIN ingest_records r ON r.ingest_run_id = ir.id
            WHERE r.repo_case_id IS NOT NULL AND ir.created_at >= $${sinceIdx}${scopeAnd(scopeIdx, "ir.project_id")}
            GROUP BY r.repo_case_id, r.ingest_run_id, ir.project_id, ir.created_at
         ),
         seq AS (
           SELECT repo_case_id, project_id, run_at,
                  CASE WHEN result = 'passed' THEN 'success' ELSE 'failed' END AS status,
                  LAG(CASE WHEN result = 'passed' THEN 'success' ELSE 'failed' END) OVER w AS prev_status
             FROM run_results
            WHERE result IN ('passed', 'failed')
            WINDOW w AS (PARTITION BY repo_case_id ORDER BY run_at, ingest_run_id)
         )
         SELECT f.repo_case_id, f.project_id, p.name AS project_name, c.case_key, c.name AS case_name,
                f.runs, f.passed, f.failed, f.flips, f.last_run_at
           FROM (
             SELECT repo_case_id, project_id,
                    COUNT(*)::int AS runs,
                    COUNT(*) FILTER (WHERE status = 'success')::int AS passed,
                    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                    COUNT(*) FILTER (WHERE prev_status IS NOT NULL AND status <> prev_status)::int AS flips,
                    MAX(run_at) AS last_run_at
               FROM seq
              GROUP BY repo_case_id, project_id
              ${having}
           ) f
            LEFT JOIN projects p ON p.id = f.project_id
            LEFT JOIN repo_test_cases c ON c.id = f.repo_case_id
           ORDER BY f.flips DESC, f.failed DESC, f.last_run_at DESC
           LIMIT ${TOP_LIMIT}`,
        params,
      );

      /* 仓库任务腿（验收五轮⑤）：一次 run 里同一条用例可能多行（参数化用例各一行），
         先按 (run, key) 折结论再进序列；身份与 TopN repo_case 同一把规范尺——两种
         key 形态折成同一条用例，序列才不会断成两截各数各的。 */
      const runnerFlaky = await client.query(
        `WITH run_results AS (
           SELECT pr.id AS run_id, pr.project_id, pr.created_at AS run_at, prc.guessed_case_key,
                  CASE WHEN BOOL_OR(prc.status IN ('failed', 'error')) THEN 'failed'
                       WHEN BOOL_OR(prc.status = 'passed') THEN 'success'
                       ELSE 'unknown' END AS result
             FROM pipeline_runs pr
             JOIN pipeline_run_cases prc ON prc.pipeline_run_id = pr.id
            WHERE prc.guessed_case_key IS NOT NULL AND pr.created_at >= $${sinceIdx}${scopeAnd(scopeIdx, "pr.project_id")}
            GROUP BY pr.id, pr.project_id, pr.created_at, prc.guessed_case_key
         ),
         seq AS (
           SELECT rr.run_at, rr.project_id,
                  CASE WHEN rr.result = 'success' THEN 'success' ELSE 'failed' END AS status,
                  COALESCE(c.id::text, regexp_replace(rr.guessed_case_key, '\\[[^\\]]*\\]$', '')) AS ident,
                  LAG(CASE WHEN rr.result = 'success' THEN 'success' ELSE 'failed' END) OVER w AS prev_status
             FROM run_results rr
             LEFT JOIN repo_test_cases c ON c.project_id = rr.project_id AND (
                  regexp_replace(rr.guessed_case_key, '\\[[^\\]]*\\]$', '') = c.case_key
                  OR (rr.guessed_case_key LIKE '%#%'
                      AND c.case_key = concat(replace(split_part(rr.guessed_case_key, '#', 1), '.', '/'), '.py::',
                                              regexp_replace(split_part(rr.guessed_case_key, '#', 2), '\\[[^\\]]*\\]$', ''))))
            WHERE rr.result IN ('success', 'failed')
            WINDOW w AS (PARTITION BY COALESCE(c.id::text, regexp_replace(rr.guessed_case_key, '\\[[^\\]]*\\]$', '')) ORDER BY rr.run_at, rr.run_id)
         )
         SELECT f.ident, f.project_id, p.name AS project_name,
                COALESCE(c.case_key, f.ident) AS case_key, c.name AS case_name,
                f.runs, f.passed, f.failed, f.flips, f.last_run_at
           FROM (
             SELECT ident, project_id,
                    MAX(run_at) AS last_run_at,
                    COUNT(*)::int AS runs,
                    COUNT(*) FILTER (WHERE status = 'success')::int AS passed,
                    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                    COUNT(*) FILTER (WHERE prev_status IS NOT NULL AND status <> prev_status)::int AS flips
               FROM seq
              GROUP BY ident, project_id
              ${having}
           ) f
           LEFT JOIN projects p ON p.id = f.project_id
           LEFT JOIN repo_test_cases c ON c.id::text = f.ident
          ORDER BY f.flips DESC, f.failed DESC, f.last_run_at DESC
          LIMIT ${TOP_LIMIT}`,
        params,
      );

      /* MTTR + 首跑通过率（三腿各一条，rn=1 挑出每用例窗口内首跑）。 */
      const apiMttr = await client.query(
        `WITH seq AS (
           SELECT status, created_at,
                  MIN(created_at) FILTER (WHERE status = 'success') OVER next_rows AS next_green_at,
                  ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY created_at, id) AS rn
             FROM executions
            WHERE case_id IS NOT NULL AND status IN ('success', 'failed') AND created_at >= $${sinceIdx}${scopeAnd(scopeIdx)}
            WINDOW next_rows AS (PARTITION BY case_id ORDER BY created_at, id ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)
         )
         SELECT
           COUNT(*) FILTER (WHERE status = 'failed' AND next_green_at IS NOT NULL)::int AS recovered,
           COUNT(*) FILTER (WHERE status = 'failed' AND next_green_at IS NULL)::int AS unrecovered,
           COUNT(*) FILTER (WHERE rn = 1)::int AS cases,
           COUNT(*) FILTER (WHERE rn = 1 AND status = 'success')::int AS first_passed,
           ARRAY_REMOVE(ARRAY_AGG(EXTRACT(EPOCH FROM (next_green_at - created_at)) * 1000)
             FILTER (WHERE status = 'failed' AND next_green_at IS NOT NULL), NULL) AS recovery_ms
           FROM seq`,
        params,
      );
      const repoMttr = await client.query(
        `WITH run_results AS (
           SELECT r.repo_case_id, r.ingest_run_id, ir.created_at AS run_at,
                  CASE WHEN BOOL_OR(r.passed = false) THEN 'failed'
                       WHEN BOOL_OR(r.passed = true) THEN 'passed'
                       ELSE 'unknown' END AS result
             FROM ingest_runs ir
             JOIN ingest_records r ON r.ingest_run_id = ir.id
            WHERE r.repo_case_id IS NOT NULL AND ir.created_at >= $${sinceIdx}${scopeAnd(scopeIdx, "ir.project_id")}
            GROUP BY r.repo_case_id, r.ingest_run_id, ir.created_at
         ),
         seq AS (
           SELECT CASE WHEN result = 'passed' THEN 'success' ELSE 'failed' END AS status, run_at,
                  MIN(run_at) FILTER (WHERE result = 'passed') OVER next_rows AS next_green_at,
                  ROW_NUMBER() OVER (PARTITION BY repo_case_id ORDER BY run_at, ingest_run_id) AS rn
             FROM run_results
            WHERE result IN ('passed', 'failed')
            WINDOW next_rows AS (PARTITION BY repo_case_id ORDER BY run_at, ingest_run_id ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)
         )
          SELECT
            COUNT(*) FILTER (WHERE status = 'failed' AND next_green_at IS NOT NULL)::int AS recovered,
            COUNT(*) FILTER (WHERE status = 'failed' AND next_green_at IS NULL)::int AS unrecovered,
            COUNT(*) FILTER (WHERE rn = 1)::int AS cases,
            COUNT(*) FILTER (WHERE rn = 1 AND status = 'success')::int AS first_passed,
            ARRAY_REMOVE(ARRAY_AGG(EXTRACT(EPOCH FROM (next_green_at - run_at)) * 1000)
              FILTER (WHERE status = 'failed' AND next_green_at IS NOT NULL), NULL) AS recovery_ms
            FROM seq`,
        params,
      );
      /* 仓库任务腿的 MTTR/首跑（验收五轮⑤）：与 runnerFlaky 同一份 run_results 折结论，
         分区键用规范 ident（与榜同一把尺），统计口径与另两腿逐字相同。 */
      const runnerMttr = await client.query(
        `WITH run_results AS (
           SELECT pr.id AS run_id, pr.project_id, pr.created_at AS run_at, prc.guessed_case_key,
                  CASE WHEN BOOL_OR(prc.status IN ('failed', 'error')) THEN 'failed'
                       WHEN BOOL_OR(prc.status = 'passed') THEN 'success'
                       ELSE 'unknown' END AS result
             FROM pipeline_runs pr
             JOIN pipeline_run_cases prc ON prc.pipeline_run_id = pr.id
            WHERE prc.guessed_case_key IS NOT NULL AND pr.created_at >= $${sinceIdx}${scopeAnd(scopeIdx, "pr.project_id")}
            GROUP BY pr.id, pr.project_id, pr.created_at, prc.guessed_case_key
         ),
         seq AS (
           SELECT CASE WHEN rr.result = 'success' THEN 'success' ELSE 'failed' END AS status, rr.run_at,
                  COALESCE(c.id::text, regexp_replace(rr.guessed_case_key, '\\[[^\\]]*\\]$', '')) AS ident,
                  MIN(rr.run_at) FILTER (WHERE rr.result = 'success') OVER next_rows AS next_green_at,
                  ROW_NUMBER() OVER (PARTITION BY COALESCE(c.id::text, regexp_replace(rr.guessed_case_key, '\\[[^\\]]*\\]$', '')) ORDER BY rr.run_at, rr.run_id) AS rn
             FROM run_results rr
             LEFT JOIN repo_test_cases c ON c.project_id = rr.project_id AND (
                  regexp_replace(rr.guessed_case_key, '\\[[^\\]]*\\]$', '') = c.case_key
                  OR (rr.guessed_case_key LIKE '%#%'
                      AND c.case_key = concat(replace(split_part(rr.guessed_case_key, '#', 1), '.', '/'), '.py::',
                                              regexp_replace(split_part(rr.guessed_case_key, '#', 2), '\\[[^\\]]*\\]$', ''))))
            WHERE rr.result IN ('success', 'failed')
            WINDOW next_rows AS (PARTITION BY COALESCE(c.id::text, regexp_replace(rr.guessed_case_key, '\\[[^\\]]*\\]$', '')) ORDER BY rr.run_at, rr.run_id ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)
         )
         SELECT
           COUNT(*) FILTER (WHERE status = 'failed' AND next_green_at IS NOT NULL)::int AS recovered,
           COUNT(*) FILTER (WHERE status = 'failed' AND next_green_at IS NULL)::int AS unrecovered,
           COUNT(*) FILTER (WHERE rn = 1)::int AS cases,
           COUNT(*) FILTER (WHERE rn = 1 AND status = 'success')::int AS first_passed,
           ARRAY_REMOVE(ARRAY_AGG(EXTRACT(EPOCH FROM (next_green_at - run_at)) * 1000)
             FILTER (WHERE status = 'failed' AND next_green_at IS NOT NULL), NULL) AS recovery_ms
           FROM seq`,
        params,
      );
      const apiMttrRow = apiMttr.rows[0];
      const repoMttrRow = repoMttr.rows[0];
      const runnerMttrRow = runnerMttr.rows[0];
      const recoveries = [
        ...((apiMttrRow.recovery_ms ?? []) as number[]).map(Number),
        ...((repoMttrRow.recovery_ms ?? []) as number[]).map(Number),
        ...((runnerMttrRow.recovery_ms ?? []) as number[]).map(Number),
      ];
      const cases = Number(apiMttrRow.cases) + Number(repoMttrRow.cases) + Number(runnerMttrRow.cases);
      const firstPassed = Number(apiMttrRow.first_passed) + Number(repoMttrRow.first_passed) + Number(runnerMttrRow.first_passed);

      const toCase = (row: Record<string, unknown>, source: "api" | "repo" | "runner") => ({
        source,
        projectId: String(row.project_id),
        projectName: String(row.project_name ?? ""),
        caseId: row.case_id ? String(row.case_id) : null,
        caseKey: row.case_key ? String(row.case_key) : null,
        name: String(row.case_name ?? row.case_key ?? ""),
        runs: Number(row.runs),
        passed: Number(row.passed),
        failed: Number(row.failed),
        flips: Number(row.flips),
        lastRunAt: row.last_run_at ? new Date(String(row.last_run_at)).toISOString() : null,
      });
      /* 三腿各自 Top 20 合并成一张榜（翻转多者在前），同名多源靠 source 区分；
         60 行是上限不是目标——Flaky 榜的用途是人工排查起点，不是全量清单。 */
      const flaky = [
        ...apiFlaky.rows.map((row) => toCase(row, "api")),
        ...repoFlaky.rows.map((row) => toCase(row, "repo")),
        ...runnerFlaky.rows.map((row) => toCase(row, "runner")),
      ].sort((a, b) => b.flips - a.flips || b.failed - a.failed || (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""));

      return {
        days,
        flaky,
        thresholds: FLAKY,
        mttr: {
          recoveredFailures: Number(apiMttrRow.recovered) + Number(repoMttrRow.recovered) + Number(runnerMttrRow.recovered),
          unrecoveredFailures: Number(apiMttrRow.unrecovered) + Number(repoMttrRow.unrecovered) + Number(runnerMttrRow.unrecovered),
          medianMs: percentileOf(recoveries, 50),
          p90Ms: percentileOf(recoveries, 90),
        },
        firstPass: { cases, firstPassed, rate: rate(firstPassed, cases) },
      };
    });
    if (!data) return;
    statsCacheSet(cacheKey, data);
    return success(data);
  });

  /**
   * 三个覆盖率口径的日序列（12.3）：接口覆盖（dashboard 口径：有用例接口/全部接口）、
   * 仓库覆盖（形状去重：coverageShapeKey 的等价关系，分母是登记接口的去重形状数）、
   * 自动化覆盖（P7 口径：非 endpoint 绑定已评审用例/全部已评审）。每点是「截至当天」
   * 的存量快照（累计值，不是当日新增）。
   *
   * 仓库覆盖的形状去重必须在 TS 做（归一是 TS 的能力，SQL 复刻一份等价关系迟早漂移
   * ——coverageShapeKey 的注释写明它是唯一事实源），所以三条腿都是「拉小结果集回 TS
   * 组序列」而不是一条大 SQL；资产表量级有界（受人工维护约束），这是诚实的形状。
   * 状态口径用当前值（reviewed/active 的历史变迁不可考），是既定近似。
   */
  app.get<{ Querystring: StatsQuery }>("/api/v1/stats/coverage", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    const days = readDays(request.query.days, reply);
    if (days === undefined) return;
    const scope = await resolveScope(user, undefined, reply);
    if (!scope) return;

    const cacheKey = `coverage|${scopeCacheKey(scope)}|${days}`;
    const cached = statsCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) return success(cached);

    const data = await withStatsTimeout(reply, async (client) => {
      const params: unknown[] = [];
      const scopeIdx = pushScopeParam(scope, params);

      const endpointRows = await client.query(`SELECT id, method, url, created_at FROM endpoints${scopeWhere(scopeIdx)}`, params);
      const firstCaseRows = await client.query(
        `SELECT endpoint_id, MIN(created_at) AS first_at FROM test_cases${scopeWhere(scopeIdx)} GROUP BY endpoint_id`,
        params,
      );
      /* 自动化覆盖的分子只数已评审用例的绑定（P7 边界 11 的分母同款过滤）。scope
          拼接与 assets 查询同款修正（缺陷②：scopeWhere 后跟 WHERE 会双 WHERE）。 */
      const specRows = await client.query(`SELECT id, created_at FROM spec_cases WHERE status = 'reviewed'${scopeAnd(scopeIdx)}`, params);
      const automatedRows = await client.query(
        `SELECT l.spec_case_id, MIN(l.created_at) AS first_at
           FROM spec_case_links l JOIN spec_cases sc ON sc.id = l.spec_case_id
          WHERE sc.status = 'reviewed' AND l.target_type <> 'endpoint'${scopeAnd(scopeIdx, "sc.project_id")} GROUP BY l.spec_case_id`,
        params,
      );
      const repoCoverRows = await client.query(
        `SELECT r.endpoint_id, MIN(ir.created_at) AS first_at
           FROM repo_case_endpoints r
           JOIN repo_test_cases c ON c.id = r.repo_case_id AND c.status = 'active'
           JOIN ingest_runs ir ON ir.id = r.first_seen_run_id
          WHERE TRUE${scopeAnd(scopeIdx, "c.project_id")}
          GROUP BY r.endpoint_id`,
        params,
      );

      /* 接口覆盖：首用例日期 ≤t 的接口数 / 已登记接口数。 */
      const endpointCreatedAt = endpointRows.rows.map((row) => new Date(String(row.created_at)).getTime()).sort((a, b) => a - b);
      const firstCaseAt = firstCaseRows.rows.map((row) => new Date(String(row.first_at)).getTime()).sort((a, b) => a - b);
      /* 自动化覆盖：已评审用例的创建日 ≤t 为分母，其首个非 endpoint 绑定 ≤t 为分子
         （链接可早于评审——两个日期各自 ≤t 即可）。 */
      const specCreatedAt = specRows.rows.map((row) => new Date(String(row.created_at)).getTime()).sort((a, b) => a - b);
      const automatedAt = automatedRows.rows.map((row) => new Date(String(row.first_at)).getTime()).sort((a, b) => a - b);
      /* 仓库覆盖：形状 = coverageShapeKey(method, endpointPath(url))；形状的首次登记
         = 同形各行的最早 created_at，首次覆盖 = 同形各行里最早的首用例关系日
         （first_seen_run 的上报时间，关系表自己没有时间戳）。 */
      const firstRepoAt = new Map<string, number>();
      for (const row of repoCoverRows.rows) firstRepoAt.set(String(row.endpoint_id), new Date(String(row.first_at)).getTime());
      const shapes = new Map<string, { firstRegistered: number; firstCovered?: number }>();
      for (const row of endpointRows.rows) {
        const key = coverageShapeKey(String(row.method), endpointPath(String(row.url)));
        const registered = new Date(String(row.created_at)).getTime();
        const shape = shapes.get(key) ?? { firstRegistered: registered };
        shape.firstRegistered = Math.min(shape.firstRegistered, registered);
        const covered = firstRepoAt.get(String(row.id));
        if (covered !== undefined) shape.firstCovered = Math.min(shape.firstCovered ?? covered, covered);
        shapes.set(key, shape);
      }
      const shapeRegisteredAt = [...shapes.values()].map((s) => s.firstRegistered).sort((a, b) => a - b);
      const shapeCoveredAt = [...shapes.values()].filter((s) => s.firstCovered !== undefined).map((s) => s.firstCovered!).sort((a, b) => a - b);

      /* 桶：本地时区的天粒度序列（trend 的桶由 SQL date_trunc 生成、两侧自洽；这里
         整条序列都在 TS 里组装，同样自洽）。t 取每天末尾，countUpTo 数 ≤t 的存量。 */
      const endDay = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
      const buckets: Record<string, unknown>[] = [];
      for (let offset = days - 1; offset >= 0; offset -= 1) {
        const dayStart = endDay - offset * 86_400_000;
        const t = dayStart + 86_400_000 - 1;
        const apiTotal = countUpTo(endpointCreatedAt, t);
        const apiCovered = countUpTo(firstCaseAt, t);
        const reviewed = countUpTo(specCreatedAt, t);
        const automated = Math.min(countUpTo(automatedAt, t), reviewed);
        const repoTotal = countUpTo(shapeRegisteredAt, t);
        const repoCovered = countUpTo(shapeCoveredAt, t);
        buckets.push({
          bucket: new Date(dayStart).toISOString(),
          apiCoverage: { covered: apiCovered, total: apiTotal, rate: rate(apiCovered, apiTotal) },
          repoCoverage: { covered: repoCovered, total: repoTotal, rate: rate(repoCovered, repoTotal) },
          automationCoverage: { automated, reviewed, rate: rate(automated, reviewed) },
        });
      }
      return { days, buckets };
    });
    if (!data) return;
    statsCacheSet(cacheKey, data);
    return success(data);
  });

  /**
   * 项目对比（边界 19 的 Top 10 反向榜 / 关键字检索）：指标列（接口覆盖率 / 自动化
   * 覆盖率 / 通过率 / 失败量 / 归因覆盖率）可切换，order 默认 asc（升序 = 最差在前——
   * 看板是找问题的页；失败量这种「越大越差」的列由前端显式传 desc）。传 keyword 时
   * 返回命中全量（命中多少展示多少，不做分页翻页器）。
   *
   * 通过率/失败量是窗口读数（样本口径与 overview 一致）；三个覆盖率是存量读数——
   * 与看板卡片同口径（queryProjectMetrics 的公式），不混窗口。覆盖率排序键
   * COALESCE(x, 0)：分母为 0 的 null 在覆盖意义上是 0%（最差），asc 榜排最前。
   */
  app.get<{ Querystring: StatsQuery }>("/api/v1/stats/projects", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    const days = readDays(request.query.days, reply);
    if (days === undefined) return;
    const metric = (PROJECT_METRICS as readonly string[]).includes(request.query.metric ?? "")
      ? (request.query.metric as ProjectMetric)
      : "coverage";
    const order = request.query.order === "desc" ? "DESC" : "ASC";
    const sampleScope = readSampleScope(request.query.scope);
    const scope = await resolveScope(user, request.query.projectIds, reply);
    if (!scope) return;
    const keyword = request.query.keyword?.trim();
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 10) || 10));

    const cacheKey = `projects|${scopeCacheKey(scope)}|${days}|${metric}|${order}|${sampleScope}|${limit}|${keyword ?? ""}`;
    const cached = statsCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) return success(cached);

    const data = await withStatsTimeout(reply, async (client) => {
      const params: unknown[] = [];
      const scopeIdx = pushScopeParam(scope, params);
      const sinceIdx = pushParam(params, daysAgo(days));
      let where = scopeWhere(scopeIdx, "p.id");
      if (keyword) {
        const keywordIdx = pushParam(params, `%${keyword}%`);
        /* 卡片墙同款语义（边界 19）：名称与描述一起搜。 */
        where = `${where ? `${where} AND ` : "WHERE "}(p.name ILIKE $${keywordIdx} OR p.description ILIKE $${keywordIdx})`;
      }
      const orderColumn = metric === "coverage" ? "coverage_rate"
        : metric === "automation" ? "automation_rate"
        : metric === "passRate" ? "pass_rate"
        : metric === "attribution" ? "attribution_rate"
        : "failed_count";
      /* 排序键（2026-09-11 验收：覆盖率三维 asc 时「分母为 0 的 null」排错位）：
       * 覆盖率列的 null 是「没有分母」，不是「没有数据」——没有已评审用例/没有失败
       * 目标的项目在覆盖意义上就是 0%（最差），asc 榜里必须排最前，默认 NULLS LAST
       * 却把它甩到榜尾。修法是 COALESCE(x, 0)——但 ORDER BY 的**表达式内**不解析
       * SELECT 别名（裸 `ORDER BY coverage_rate` 行，包进 COALESCE 就按表列找，
       * 42703），所以这里重复 SELECT 里同款 CASE 表达式而不是引用别名。代码内固定
       * 片段，无请求值进文本。列读数不动：null 仍显示「—」（0% 与「分母为 0」是
       * 两个事实）；passRate/failed 维不 COALESCE，保持裸列引用原语义。 */
      const rateExpression: Record<"coverage" | "automation" | "attribution", string> = {
        coverage: "CASE WHEN COALESCE(ep.n, 0) > 0 THEN ROUND(COALESCE(tc.n, 0)::numeric * 100 / ep.n, 1) END",
        automation: "CASE WHEN COALESCE(sp.total, 0) > 0 THEN ROUND(COALESCE(sp.automated, 0)::numeric * 100 / sp.total, 1) END",
        attribution: "CASE WHEN COALESCE(att.failed, 0) > 0 THEN ROUND(COALESCE(att.attributed, 0)::numeric * 100 / att.failed, 1) END",
      };
      const orderKey = metric === "failed" || metric === "passRate"
        ? orderColumn
        : `COALESCE(${rateExpression[metric]}, 0)`;
      /* LIMIT 走参数（请求值不进 SQL 文本）；keyword 模式返回命中全量，无 LIMIT。 */
      let limitFragment = "";
      if (!keyword) limitFragment = ` LIMIT $${pushParam(params, limit)}`;

      const result = await client.query(
        `SELECT p.id, p.name,
                COALESCE(ep.n, 0)::int AS endpoint_count,
                COALESCE(tc.n, 0)::int AS covered_endpoint_count,
                CASE WHEN COALESCE(ep.n, 0) > 0 THEN ROUND(COALESCE(tc.n, 0)::numeric * 100 / ep.n, 1) END AS coverage_rate,
                COALESCE(sp.total, 0)::int AS spec_reviewed,
                COALESCE(sp.automated, 0)::int AS spec_automated,
                CASE WHEN COALESCE(sp.total, 0) > 0 THEN ROUND(COALESCE(sp.automated, 0)::numeric * 100 / sp.total, 1) END AS automation_rate,
                COALESCE(ex.judged, 0)::int AS execution_count,
                COALESCE(ex.passed, 0)::int AS passed_count,
                COALESCE(ex.failed, 0)::int AS failed_count,
                CASE WHEN COALESCE(ex.judged, 0) > 0 THEN ROUND(COALESCE(ex.passed, 0)::numeric * 100 / ex.judged, 1) END AS pass_rate,
                COALESCE(att.failed, 0)::int AS attribution_failed,
                COALESCE(att.attributed, 0)::int AS attribution_attributed,
                CASE WHEN COALESCE(att.failed, 0) > 0 THEN ROUND(COALESCE(att.attributed, 0)::numeric * 100 / att.failed, 1) END AS attribution_rate
           FROM projects p
           LEFT JOIN (SELECT project_id, COUNT(*)::int AS n FROM endpoints${scopeWhere(scopeIdx)} GROUP BY project_id) ep ON ep.project_id = p.id
           LEFT JOIN (SELECT project_id, COUNT(DISTINCT endpoint_id)::int AS n FROM test_cases${scopeWhere(scopeIdx)} GROUP BY project_id) tc ON tc.project_id = p.id
           LEFT JOIN (
             SELECT project_id,
                    COUNT(*) FILTER (WHERE status = 'reviewed')::int AS total,
                    COUNT(*) FILTER (WHERE status = 'reviewed' AND EXISTS (
                      SELECT 1 FROM spec_case_links l WHERE l.spec_case_id = spec_cases.id AND l.target_type <> 'endpoint'))::int AS automated
               FROM spec_cases${scopeWhere(scopeIdx)} GROUP BY project_id
           ) sp ON sp.project_id = p.id
           LEFT JOIN (
             SELECT project_id,
                    COUNT(*) FILTER (WHERE status IN ('success', 'failed'))::int AS judged,
                    COUNT(*) FILTER (WHERE status = 'success')::int AS passed,
                    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
               FROM execution_index
               WHERE created_at >= $${sinceIdx} AND kind IN ${sampleKinds(sampleScope)} AND ${NOT_SELF_DEBUG()}${scopeAnd(scopeIdx)}
              GROUP BY project_id
           ) ex ON ex.project_id = p.id
           LEFT JOIN (
             SELECT t.project_id, COUNT(*)::int AS failed, COUNT(fa.id)::int AS attributed
               FROM (${failureTargetsSql(sinceIdx, scopeIdx)}) t
               LEFT JOIN failure_attributions fa ON fa.target_type = t.target_type AND fa.target_id = t.target_id
              GROUP BY t.project_id
           ) att ON att.project_id = p.id
          ${where}
          ORDER BY ${orderKey} ${order}, p.name ASC
          ${limitFragment}`,
        params,
      );

      return {
        days,
        metric,
        order: order.toLowerCase(),
        scope: sampleScope,
        projects: result.rows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          endpointCount: Number(row.endpoint_count),
          coveredEndpointCount: Number(row.covered_endpoint_count),
          coverageRate: row.coverage_rate === null || row.coverage_rate === undefined ? null : Number(row.coverage_rate),
          specReviewedTotal: Number(row.spec_reviewed),
          specAutomatedCount: Number(row.spec_automated),
          automationRate: row.automation_rate === null || row.automation_rate === undefined ? null : Number(row.automation_rate),
          executionCount: Number(row.execution_count),
          passedCount: Number(row.passed_count),
          failedCount: Number(row.failed_count),
          passRate: row.pass_rate === null || row.pass_rate === undefined ? null : Number(row.pass_rate),
          attributionFailed: Number(row.attribution_failed),
          attributionAttributed: Number(row.attribution_attributed),
          attributionRate: row.attribution_rate === null || row.attribution_rate === undefined ? null : Number(row.attribution_rate),
        })),
      };
    });
    if (!data) return;
    statsCacheSet(cacheKey, data);
    return success(data);
  });
}
