import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { NoRunnerError, cancelSuiteRun, enqueueSuiteRun } from "../lib/enqueue.js";
import { SUITE_LEAF_BUDGET } from "../lib/flow.js";
import { memberTokenDemand } from "../lib/suiteRun.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, failNoRunner, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import {
  mapExecution, mapExecutionStep, mapSuiteExecution, mapTestSuite, normalizeSuiteSelection,
  SUITE_DEFAULT_CONCURRENCY, SUITE_MAX_CONCURRENCY, SUITE_MAX_MEMBERS,
  type FlowNode, type SuiteExecutionConfig, type SuiteMemberRef, type SuiteMemberSnapshot, type SuiteSelection, type TestSuite,
} from "../models/types.js";

/**
 * 测试套件（P2-4）。范围与边界见 DEVELOPMENT_PLAN.md 5.0.11。
 *
 * 套件只编排**成员**：成员是接口用例或流程，各自是一次独立执行，成员之间不传变量
 * ——需要传值的链路本来就该建成一条流程（5.0.6）。所以这里没有请求定义、没有变量
 * 映射、没有前后置脚本，只有「选谁」和「怎么跑」。
 *
 * 执行入口在这里，执行本体在 `lib/suiteRun.ts`（P2-4.2）：成员在套件自己的 worker 槽内
 * 进程内扇出，不单独入队。
 */

type SelectionInput = {
  type?: string;
  members?: SuiteMemberRef[];
  tags?: string[];
  match?: string;
  includeCases?: boolean;
  includeFlows?: boolean;
};

type SuiteInput = {
  name?: string;
  description?: string;
  selection?: SelectionInput;
  execution?: Partial<SuiteExecutionConfig>;
  tags?: string[];
};

const SELECTION_TYPES = ["manual", "tag", "all"];
const MEMBER_TYPES = ["case", "flow"];

function validateSelection(selection: SelectionInput | undefined): string | undefined {
  if (!selection || !selection.type) return "selection.type is required";
  if (!SELECTION_TYPES.includes(selection.type)) return `selection.type must be one of ${SELECTION_TYPES.join(", ")}`;

  /*
   * 空成员 / 空标签在**保存**时是合法的：新建一个套件必然从零成员开始，配置页正是
   * 用来把它填起来的。「套件里没有成员不能运行」是**执行**时的检查，属于 P2-4.2 的
   * 入队路径——放在这里会让创建流程根本走不通。
   */
  if (selection.type === "manual") {
    if (!Array.isArray(selection.members)) return "selection.members must be an array";
    if (selection.members.length > SUITE_MAX_MEMBERS) return `a suite may hold at most ${SUITE_MAX_MEMBERS} members`;
    /* 同一个成员出现两次没有语义：成员之间不传变量，跑两遍同一个用例得到的是两份
       相同的独立结果。明确拒绝而不是静默去重——静默去重会让用户以为自己加上了。 */
    const seen = new Set<string>();
    for (const member of selection.members) {
      if (!member || !MEMBER_TYPES.includes(member.type)) return `each member type must be one of ${MEMBER_TYPES.join(", ")}`;
      if (!isUuid(member.id)) return "each member id must be a UUID";
      const key = `${member.type}:${member.id}`;
      if (seen.has(key)) return "a member may only appear once in a suite";
      seen.add(key);
    }
    return undefined;
  }

  /* tag / all 都是动态选择：成员在入队那一刻才解析，所以这里只校验筛选条件本身。 */
  if (!selection.includeCases && !selection.includeFlows) return "selection must include cases, flows, or both";
  if (selection.type === "tag") {
    if (selection.tags !== undefined && !Array.isArray(selection.tags)) return "selection.tags must be an array";
    if (selection.match !== undefined && selection.match !== "any" && selection.match !== "all") return "selection.match must be any or all";
  }
  return undefined;
}

function validateExecution(execution: Partial<SuiteExecutionConfig> | undefined): string | undefined {
  if (!execution) return undefined;
  if (execution.concurrency !== undefined) {
    const value = Number(execution.concurrency);
    if (!Number.isInteger(value) || value < 1 || value > SUITE_MAX_CONCURRENCY) return `execution.concurrency must be an integer between 1 and ${SUITE_MAX_CONCURRENCY}`;
    /* 成员并发不能超过平台的叶子令牌预算：`C ≤ 池容量` 是「每个在跑的成员至少能拿到
       一枚令牌、一定有进展」的依据（计划 5.0.11 并发预算）。上限是可配置的，所以这条
       与 SUITE_MAX_CONCURRENCY 是两回事，不能只留一个。 */
    if (value > SUITE_LEAF_BUDGET) return `execution.concurrency must be at most ${SUITE_LEAF_BUDGET} on this platform (the shared leaf-token budget)`;
  }
  if (execution.failFast !== undefined && typeof execution.failFast !== "boolean") return "execution.failFast must be a boolean";
  if (execution.environmentStrategy !== undefined && execution.environmentStrategy !== "member_default" && execution.environmentStrategy !== "override") {
    return "execution.environmentStrategy must be member_default or override";
  }
  if (execution.environmentStrategy === "override" && !execution.environmentId) return "execution.environmentId is required when the strategy is override";
  if (execution.environmentId !== undefined && execution.environmentId !== null && !isUuid(String(execution.environmentId))) return "execution.environmentId must be a UUID";
  return undefined;
}

function validate(input: SuiteInput, partial = false): string | undefined {
  if (!partial || input.name !== undefined) if (!input.name?.trim()) return "name is required";
  if (!partial || input.selection !== undefined) {
    const invalid = validateSelection(input.selection);
    if (invalid) return invalid;
  }
  return validateExecution(input.execution);
}

/**
 * 存进 `selection_config` 的形状必须与 `mapTestSuite` 读出来的形状严格对应。
 * 写一套读一套是这类 JSONB 列最常见的分叉来源，所以两处只能有一个人做决定：
 * 这里负责写，mapper 负责读，字段名一字不差。
 */
function toSelectionConfig(selection: SelectionInput): Record<string, unknown> {
  if (selection.type === "manual") return { members: (selection.members ?? []).map((member) => ({ type: member.type, id: member.id })) };
  const include = { includeCases: Boolean(selection.includeCases), includeFlows: Boolean(selection.includeFlows) };
  if (selection.type === "tag") {
    return { ...include, tags: (selection.tags ?? []).map((tag) => tag.trim()).filter(Boolean), match: selection.match === "all" ? "all" : "any" };
  }
  return include;
}

type StoredExecutionConfig = {
  concurrency: number;
  failFast: boolean;
  environmentStrategy: "member_default" | "override";
  environmentId: string | null;
};

function toExecutionConfig(execution: Partial<SuiteExecutionConfig> | undefined): StoredExecutionConfig {
  const strategy = execution?.environmentStrategy === "override" ? "override" : "member_default";
  return {
    concurrency: execution?.concurrency === undefined ? SUITE_DEFAULT_CONCURRENCY : Number(execution.concurrency),
    failFast: Boolean(execution?.failFast ?? false),
    environmentStrategy: strategy,
    /* 只有 override 才存 environmentId：留着一个用不到的环境 id，下次切回 override
       会静默复活一个用户以为早就取消了的选择。 */
    environmentId: strategy === "override" ? execution?.environmentId ?? null : null,
  };
}

async function environmentBelongs(projectId: string, environmentId: string | null | undefined): Promise<boolean> {
  if (!environmentId) return true;
  const result = await pool.query("SELECT 1 FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  return Boolean(result.rowCount);
}

/** 覆盖环境的名称，用于执行行上的快照（环境改名/删除后报告仍读得通，Spec 4.4）。 */
async function environmentSnapshot(projectId: string, environmentId: string | null | undefined): Promise<string | undefined> {
  if (!environmentId) return undefined;
  const result = await pool.query("SELECT name FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  return result.rowCount ? String(result.rows[0].name) : undefined;
}

/** 一次套件解析的结果。missing 与 warnings 都要给到界面上，不静默丢弃。 */
type ResolvedMembers = {
  members: SuiteMemberSnapshot[];
  /** manual 引用了但已不存在的成员（用例/流程被删掉后仍留在配置里）。 */
  missing: SuiteMemberRef[];
};

/**
 * 把选择方式解析成有序成员清单。
 *
 * 顺序必须确定：它就是执行证据里的 `position`，也是报告的阅读顺序。
 * manual 保持用户声明的顺序；tag / all 按「用例（按接口分组）→ 流程」排，
 * 同组内按创建时间。成员之间不传变量，所以顺序只影响可读性，不影响结论。
 */
async function resolveMembers(projectId: string, selection: SuiteSelection): Promise<ResolvedMembers> {
  /* 环境用用例/流程自己的 `environment_name` 快照，不 join environments：
     两处都是 ON DELETE SET NULL + 名称快照（Spec 4.4 历史保留），join 反而会在环境被
     删掉后把名字抹成空，与列表页、编辑页显示的不是同一个答案。
     endpoints 用 INNER JOIN 安全：test_cases.endpoint_id 是 NOT NULL + ON DELETE CASCADE，
     用例活不过它的接口。 */
  const caseRows = async (clause: string, params: unknown[]) => (await pool.query(
    `SELECT c.id, c.name, c.endpoint_id, e.name AS endpoint_name, c.environment_id, c.environment_name
       FROM test_cases c
       JOIN endpoints e ON e.id = c.endpoint_id
      WHERE c.project_id = $1 AND ${clause}
      ORDER BY e.name, c.created_at`,
    [projectId, ...params],
  )).rows;

  const flowRows = async (clause: string, params: unknown[]) => (await pool.query(
    `SELECT f.id, f.name, f.environment_id, f.environment_name
       FROM flows f
      WHERE f.project_id = $1 AND ${clause}
      ORDER BY f.created_at`,
    [projectId, ...params],
  )).rows;

  const toCase = (row: Record<string, unknown>): SuiteMemberSnapshot => ({
    type: "case", id: String(row.id), name: String(row.name),
    endpointId: String(row.endpoint_id), endpointName: String(row.endpoint_name),
    environmentId: row.environment_id ? String(row.environment_id) : undefined,
    environmentName: row.environment_name ? String(row.environment_name) : undefined,
  });
  const toFlow = (row: Record<string, unknown>): SuiteMemberSnapshot => ({
    type: "flow", id: String(row.id), name: String(row.name),
    environmentId: row.environment_id ? String(row.environment_id) : undefined,
    environmentName: row.environment_name ? String(row.environment_name) : undefined,
  });

  if (selection.type === "manual") {
    const caseIds = selection.members.filter((member) => member.type === "case").map((member) => member.id);
    const flowIds = selection.members.filter((member) => member.type === "flow").map((member) => member.id);
    const cases = caseIds.length ? await caseRows("c.id = ANY($2::uuid[])", [caseIds]) : [];
    const flows = flowIds.length ? await flowRows("f.id = ANY($2::uuid[])", [flowIds]) : [];
    const byKey = new Map<string, SuiteMemberSnapshot>();
    for (const row of cases) byKey.set(`case:${String(row.id)}`, toCase(row));
    for (const row of flows) byKey.set(`flow:${String(row.id)}`, toFlow(row));
    /* 声明顺序优先，同时把已消失的引用挑出来：删除用例/流程时的 usage 拦截在 P2-4.5
       才落地，而 ?force=true 之后引用本来就允许悬空，界面必须能说清少了什么。 */
    const members: SuiteMemberSnapshot[] = []; const missing: SuiteMemberRef[] = [];
    for (const member of selection.members) {
      const found = byKey.get(`${member.type}:${member.id}`);
      if (found) members.push(found); else missing.push({ type: member.type, id: member.id });
    }
    return { members, missing };
  }

  /* 标签条件只有一个额外参数（标签数组），所以占位符固定是 $2。判别在闭包外先落成
     普通常量：TS 不会把参数的类型收窄带进回调，写在里面会变成到处 as。 */
  const tagged = selection.type === "tag";
  const tags = tagged ? selection.tags.map((tag) => tag.trim()).filter(Boolean) : [];
  const matchAll = tagged && selection.match === "all";
  /*
   * 还没填标签的 tag 套件解析成**零个成员**，而不是交给 SQL。
   * `tags @> '{}'` 在 Postgres 里对每一行都为真（任何数组都包含空数组），所以
   * 「满足全部标签」配上空标签会静默把整个项目选进来——一个刚建好还没填条件的套件
   * 绝不该是「跑全部」的意思。
   */
  if (tagged && !tags.length) return { members: [], missing: [] };

  const tagFilter = (column: string): { clause: string; params: unknown[] } =>
    tagged ? { clause: matchAll ? `${column} @> $2` : `${column} && $2`, params: [tags] } : { clause: "TRUE", params: [] };

  const members: SuiteMemberSnapshot[] = [];
  if (selection.includeCases) {
    const built = tagFilter("c.tags");
    members.push(...(await caseRows(built.clause, built.params)).map(toCase));
  }
  if (selection.includeFlows) {
    const built = tagFilter("f.tags");
    members.push(...(await flowRows(built.clause, built.params)).map(toFlow));
  }
  return { members, missing: [] };
}

/**
 * 这次执行会向共享令牌池要多少令牌。
 *
 * 预览的提示与入队的硬校验共用这一份算法（`memberTokenDemand`）：提前在别处算一遍就会
 * 出现两个答案，而用户看到的那个会被当成结论。
 *
 * `peak` = 最多同时在跑的 C 个成员里需求最大的那 C 个之和，也就是同一刻可能被要走的
 * 令牌上限。超过池容量不是错误——只是这些请求会分批发出，用户看得见才不会把一份被
 * 分批的报告当成并发结论。`over` 才是错误：单个成员一次要的比整个池子还多，原子领取
 * 永远凑不齐。
 */
async function concurrencyBudget(projectId: string, members: SuiteMemberSnapshot[], concurrency: number) {
  const flowIds = members.filter((member) => member.type === "flow").map((member) => member.id);
  const graphs = flowIds.length
    ? await pool.query("SELECT id, nodes FROM flows WHERE id = ANY($1::uuid[]) AND project_id = $2", [flowIds, projectId])
    : { rows: [] as Record<string, unknown>[] };
  const nodesById = new Map(graphs.rows.map((row) => [String(row.id), (row.nodes ?? []) as FlowNode[]]));
  const demands = members.map((member) => ({ member, demand: memberTokenDemand(member, nodesById.get(member.id)) }));
  const peak = demands
    .map((item) => item.demand)
    .sort((left, right) => right - left)
    .slice(0, Math.max(1, concurrency))
    .reduce((sum, value) => sum + value, 0);
  return { peak, budget: SUITE_LEAF_BUDGET, over: demands.find((item) => item.demand > SUITE_LEAF_BUDGET) };
}

/** 最近一次运行，供套件列表显示「最近结果」（与流程列表同款）。 */
async function latestRuns(suiteIds: string[]) {
  if (!suiteIds.length) return new Map<string, ReturnType<typeof mapSuiteExecution>>();
  const result = await pool.query(
    `SELECT DISTINCT ON (suite_id) * FROM suite_executions
      WHERE suite_id = ANY($1::uuid[]) ORDER BY suite_id, created_at DESC`,
    [suiteIds],
  );
  return new Map(result.rows.map((row) => [String(row.suite_id), mapSuiteExecution(row)]));
}

async function loadSuite(projectId: string, suiteId: string): Promise<TestSuite | undefined> {
  if (!isUuid(suiteId)) return undefined;
  const result = await pool.query("SELECT * FROM test_suites WHERE id = $1 AND project_id = $2", [suiteId, projectId]);
  return result.rowCount ? mapTestSuite(result.rows[0]) : undefined;
}

export async function suiteRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; tag?: string } }>("/api/v1/projects/:id/test-suites", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const params: unknown[] = [context.project.id]; const clauses = ["project_id = $1"];
    const keyword = request.query.keyword?.trim();
    /* Filtering in SQL so a keyword matches every suite, not just a loaded page. */
    if (keyword) { params.push(`%${keyword}%`); clauses.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`); }
    if (request.query.tag?.trim()) { params.push(request.query.tag.trim()); clauses.push(`$${params.length} = ANY(tags)`); }
    const result = await pool.query(`SELECT * FROM test_suites WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`, params);
    const suites = result.rows.map(mapTestSuite);
    const runs = await latestRuns(suites.map((suite) => suite.id));
    /* 刻意不在列表里解析 tag/all 的成员数：那要为每一行跑两条查询，而列表能显示的
       只是「标签: x, y」这类条件本身。真实成员数由 preview 给出。 */
    const data = suites.map((suite) => ({ ...suite, lastRun: runs.get(suite.id) }));
    return success(data, { total: data.length });
  });

  app.get<{ Params: { id: string; suiteId: string } }>("/api/v1/projects/:id/test-suites/:suiteId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const suite = await loadSuite(context.project.id, request.params.suiteId);
    if (!suite) return fail(reply, 404, 2001, "test suite not found");
    return success(suite);
  });

  app.post<{ Params: { id: string }; Body: SuiteInput }>("/api/v1/projects/:id/test-suites", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const invalid = validate(request.body);
    if (invalid) return fail(reply, 400, 1001, invalid);
    const execution = toExecutionConfig(request.body.execution);
    if (!await environmentBelongs(context.project.id, execution.environmentId)) return fail(reply, 400, 1001, "environment must belong to the project");

    const suiteId = randomUUID();
    const result = await pool.query(
      `INSERT INTO test_suites (id, project_id, name, description, selection_type, selection_config, execution_config, tags)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) RETURNING *`,
      [
        suiteId, context.project.id, request.body.name!.trim(), request.body.description?.trim() ?? "",
        request.body.selection!.type, JSON.stringify(toSelectionConfig(request.body.selection!)),
        JSON.stringify(execution), request.body.tags ?? [],
      ],
    );
    return reply.code(201).send(success(mapTestSuite(result.rows[0])));
  });

  app.put<{ Params: { id: string; suiteId: string }; Body: SuiteInput }>("/api/v1/projects/:id/test-suites/:suiteId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.suiteId)) return fail(reply, 404, 2001, "test suite not found");
    const invalid = validate(request.body, true);
    if (invalid) return fail(reply, 400, 1001, invalid);

    /* selection 与 execution 都是整块替换而不是深合并：一个「把标签选择改成手动选择」
       的保存必须能丢掉旧的 tags，深合并会把它们留在库里，下次读出来形状对不上。 */
    const selection = request.body.selection ? JSON.stringify(toSelectionConfig(request.body.selection)) : null;
    let execution: string | null = null;
    if (request.body.execution) {
      const config = toExecutionConfig(request.body.execution);
      if (!await environmentBelongs(context.project.id, config.environmentId)) return fail(reply, 400, 1001, "environment must belong to the project");
      execution = JSON.stringify(config);
    }
    const result = await pool.query(
      `UPDATE test_suites SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         selection_type = COALESCE($3, selection_type),
         selection_config = COALESCE($4::jsonb, selection_config),
         execution_config = COALESCE($5::jsonb, execution_config),
         tags = COALESCE($6, tags),
         updated_at = now()
       WHERE id = $7 AND project_id = $8 RETURNING *`,
      [
        request.body.name?.trim() ?? null,
        request.body.description?.trim() ?? null,
        request.body.selection?.type ?? null, selection, execution,
        request.body.tags ?? null,
        request.params.suiteId, context.project.id,
      ],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "test suite not found");
    return success(mapTestSuite(result.rows[0]));
  });

  /**
   * 删除套件保留它跑过的历史：`suite_executions.suite_id` 是 ON DELETE SET NULL，
   * `suite_name` 已快照（Spec 4.4 历史保留）。套件本身没有被任何资源引用，所以
   * 这里不需要 usage 扫描——反向的「用例/流程被套件引用」在 P2-4.5 落地。
   */
  app.delete<{ Params: { id: string; suiteId: string } }>("/api/v1/projects/:id/test-suites/:suiteId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.suiteId)) return fail(reply, 404, 2001, "test suite not found");
    const result = await pool.query("DELETE FROM test_suites WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.suiteId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "test suite not found");
    return success({ id: request.params.suiteId });
  });

  /**
   * 解析「这个套件现在会跑哪些成员」。
   *
   * 标签/全部是动态选择，成员随项目里的用例和流程变化，所以配置页必须能在保存前
   * 看到真实清单——而入队时会把同一份解析冻进 `member_snapshot`，报告才可复现。
   *
   * 请求体可选：带 selection 就预览「还没保存的这份配置」，不带就预览已存的那份。
   * 前者是编辑页改一下就看一眼的用法，没有它用户只能靠保存来试。
   */
  app.post<{ Params: { id: string; suiteId: string }; Body: { selection?: SelectionInput; execution?: Partial<SuiteExecutionConfig> } }>("/api/v1/projects/:id/test-suites/:suiteId/preview", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const suite = await loadSuite(context.project.id, request.params.suiteId);
    if (!suite) return fail(reply, 404, 2001, "test suite not found");

    let selection = suite.selection;
    if (request.body?.selection) {
      const invalid = validateSelection(request.body.selection);
      if (invalid) return fail(reply, 400, 1001, invalid);
      /* 走存库时的同一条归一路径（写 → 归一 → 解析），预览才不会比保存后更宽松。 */
      selection = normalizeSuiteSelection(request.body.selection.type, toSelectionConfig(request.body.selection));
    }
    /* 并发同理可以预览「还没保存的那个值」：改并发正是为了看峰值提示怎么变。 */
    const concurrency = request.body?.execution?.concurrency === undefined ? suite.execution.concurrency : Number(request.body.execution.concurrency);

    const resolved = await resolveMembers(context.project.id, selection);
    const warnings: string[] = [];
    /* 超过上限不静默截断（与循环迭代 >100 同一原则）：这里只报，执行入队时拒绝。 */
    if (resolved.members.length > SUITE_MAX_MEMBERS) warnings.push(`resolved ${resolved.members.length} members, over the limit of ${SUITE_MAX_MEMBERS}`);
    if (resolved.missing.length) warnings.push(`${resolved.missing.length} referenced member(s) no longer exist`);
    /* 并发峰值：用调度器同一份算法（lib/suiteRun.ts `memberTokenDemand`）算出来的声明
       需求，超过池容量就明确写出来——用户看得见，才不会把一份被分批发出的报告当成
       并发结论。 */
    const budget = await concurrencyBudget(context.project.id, resolved.members, Math.max(1, concurrency));
    if (budget.over) warnings.push(`member "${budget.over.member.name}" needs ${budget.over.demand} concurrent requests at once, over the platform budget of ${budget.budget}; it cannot run`);
    else if (budget.peak > budget.budget) warnings.push(`declared concurrency adds up to ${budget.peak}, over the platform budget of ${budget.budget}; requests will go out in batches`);
    return success({
      members: resolved.members,
      total: resolved.members.length,
      missing: resolved.missing,
      memberLimit: SUITE_MAX_MEMBERS,
      /* 峰值与预算一并返回，界面才能画出「声明 X / 上限 Y」而不是只有一句文字。 */
      concurrency: { declared: Math.max(1, concurrency), peak: budget.peak, budget: budget.budget },
      warnings,
    });
  });

  /**
   * 运行一个套件。
   *
   * 请求体可选带 `execution`：这是「改了并发/环境策略但还没保存就想跑一次」的用法，与
   * 用例、流程的执行同一条规则（交互文档 3.1.3）——覆盖值会被执行并记录，但不落到套件
   * 定义上。成员清单不接受覆盖：选谁由定义说，随手指定一批成员是「批量执行」而不是
   * 「运行这个套件」。
   *
   * 成员在这一刻解析并冻进 `member_snapshot`：tag/all 是动态选择，报告要可复现就必须
   * 在入队时定下来。
   */
  app.post<{ Params: { id: string; suiteId: string }; Body: { execution?: Partial<SuiteExecutionConfig> } }>("/api/v1/projects/:id/test-suites/:suiteId/execute", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const suite = await loadSuite(context.project.id, request.params.suiteId);
    if (!suite) return fail(reply, 404, 2001, "test suite not found");

    /* 覆盖是**部分**覆盖，所以先与已存的那份合并再归一：只传 failFast 的一次运行不该
       把并发与环境策略一起重置回默认值。 */
    const merged = { ...suite.execution, ...(request.body?.execution ?? {}) };
    const invalid = validateExecution(merged);
    if (invalid) return fail(reply, 400, 1001, invalid);
    const execution = toExecutionConfig(merged);
    if (!await environmentBelongs(context.project.id, execution.environmentId)) return fail(reply, 400, 1001, "environment must belong to the project");

    const resolved = await resolveMembers(context.project.id, suite.selection);
    /* 「套件里没有成员不能运行」是执行时的检查（保存时允许空——新建套件必然从零成员
       开始，见 issue_fix/P2-4_ISSUE_LOG.md）。 */
    if (!resolved.members.length) return fail(reply, 400, 1001, "this suite resolves to no members; add members before running it");
    if (resolved.members.length > SUITE_MAX_MEMBERS) return fail(reply, 400, 1001, `this suite resolves ${resolved.members.length} members, over the limit of ${SUITE_MAX_MEMBERS}`);
    /* 单个成员一次要的令牌比整个池子还多：原子领取永远凑不齐，拒绝而不是让它跑到那一步
       才失败（与「循环迭代 >100 硬失败」同一原则）。 */
    const budget = await concurrencyBudget(context.project.id, resolved.members, execution.concurrency);
    if (budget.over) return fail(reply, 400, 1001, `member "${budget.over.member.name}" needs ${budget.over.demand} concurrent requests at once, over this platform's budget of ${budget.budget}`);

    try {
      const suiteExecutionId = await enqueueSuiteRun({
        projectId: context.project.id,
        suiteId: suite.id,
        suiteName: suite.name,
        environmentId: execution.environmentId ?? undefined,
        environmentName: await environmentSnapshot(context.project.id, execution.environmentId),
        members: resolved.members,
        execution: { ...execution, environmentId: execution.environmentId ?? undefined },
      });
      /* 202: an accepted run, not a verdict. The client follows it on the stream. */
      const queued = await pool.query("SELECT * FROM suite_executions WHERE id = $1", [suiteExecutionId]);
      return reply.code(202).send(success(mapSuiteExecution(queued.rows[0])));
    } catch (error) {
      /* 分区没有在线执行器：2004 + label（P2-8 边界 5）。 */
      if (error instanceof NoRunnerError) return failNoRunner(reply, error.label, error.message);
      const message = error instanceof Error ? error.message : "suite could not be started";
      /* 队列不可用是基础设施问题而不是坏输入——503 让客户端说「执行队列不可用」而不是
         去怪这个套件（与流程执行同款）。 */
      if (message.includes("queue unavailable")) return fail(reply, 503, 5001, message);
      /* 「成员跨分区」是 400：套件是进程内扇出的，一次执行只能落在一个网段上，处置办法
         是拆成两个套件或设一个套件级环境——这是配置问题，不是基础设施问题。 */
      return fail(reply, 400, 2002, message);
    }
  });

  /** 一个套件跑过的运行记录（编辑页侧栏与列表页「最近结果」的分页版本）。 */
  app.get<{ Params: { id: string; suiteId: string }; Querystring: { status?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/test-suites/:suiteId/executions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.suiteId)) return fail(reply, 404, 2001, "test suite not found");
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id, request.params.suiteId]; const clauses = ["project_id = $1", "suite_id = $2"];
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`status = $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM suite_executions WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(`SELECT * FROM suite_executions WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return success(result.rows.map(mapSuiteExecution), { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 一次套件执行 + 每个成员的证据行。
   *
   * `executionSteps` 是成员行（用例成员带 `httpExecutionId`，流程成员带 `childIndexId`），
   * `runs` 是用例成员那几行 `executions`——抽屉展开一个用例成员就要看响应，逐行再拉一次
   * 会让一个 50 成员的套件发 50 个请求。流程成员的内层步骤**不**在这里返回：那是一整棵
   * 子树，按需拉（`/execution-index/:childIndexId`）才不会让抽屉一开就很重。
   */
  app.get<{ Params: { id: string; executionId: string } }>("/api/v1/projects/:id/suite-executions/:executionId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.executionId)) return fail(reply, 404, 2001, "suite execution not found");
    const result = await pool.query("SELECT * FROM suite_executions WHERE id = $1 AND project_id = $2", [request.params.executionId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "suite execution not found");
    const indexId = result.rows[0].execution_index_id;
    const steps = indexId
      ? await pool.query("SELECT * FROM execution_steps WHERE index_id = $1 AND parent_step_id IS NULL ORDER BY position, created_at", [indexId])
      : { rows: [] as Record<string, unknown>[] };
    const httpIds = steps.rows.map((row) => row.http_execution_id).filter(Boolean);
    const runs = httpIds.length
      ? await pool.query("SELECT * FROM executions WHERE id = ANY($1::uuid[])", [httpIds])
      : { rows: [] as Record<string, unknown>[] };
    return success({
      ...mapSuiteExecution(result.rows[0]),
      executionSteps: steps.rows.map(mapExecutionStep),
      runs: runs.rows.map(mapExecution),
    });
  });

  app.post<{ Params: { id: string; executionId: string } }>("/api/v1/projects/:id/suite-executions/:executionId/cancel", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.executionId)) return fail(reply, 404, 2001, "suite execution not found");
    const canceled = await cancelSuiteRun(context.project.id, request.params.executionId);
    /* Already terminal: reported as a conflict rather than pretending the cancel
       did something (same as cancelling a single run or a flow). */
    if (!canceled) return fail(reply, 409, 2004, "suite execution is already finished");
    const result = await pool.query("SELECT * FROM suite_executions WHERE id = $1", [request.params.executionId]);
    return success(mapSuiteExecution(result.rows[0]));
  });
}
