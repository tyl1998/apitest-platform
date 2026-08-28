import type { FastifyReply } from "fastify";
import { pool } from "../db.js";
import { NoRunnerError, enqueueFlowRun, enqueueSuiteRun } from "./enqueue.js";
import { SUITE_LEAF_BUDGET, toFlowNode, validateFlowGraph } from "./flow.js";
import { checkFlowReferences } from "./flowRefs.js";
import { validateVariableOverrides } from "./resolve.js";
import { fail, failNoRunner } from "./response.js";
import { memberTokenDemand } from "./suiteRun.js";
import { isUuid } from "./uuid.js";
import {
  mapFlow, mapTestSuite,
  SUITE_DEFAULT_CONCURRENCY, SUITE_MAX_CONCURRENCY, SUITE_MAX_MEMBERS,
  type Flow, type FlowEdge, type FlowNode, type SuiteExecutionConfig, type SuiteMemberRef, type SuiteMemberSnapshot, type SuiteSelection, type TestSuite, type TriggerContext,
} from "../models/types.js";

/**
 * 统一触发路径（P3-3，边界 5）。
 *
 * 手动执行、定时调度（P3-4）与 Webhook（P3-6）共用这一条「校验 + 入队」。抽出来是
 * 本阶段唯一的重构，且不可省：留两条入口，就等于定时跑的那条迟早会缺一项检查，而
 * 它恰好是没人盯着的那条。
 *
 * 路由层只保留权限守卫、uuid 预检与错误映射；错误码与 P2 的手动执行完全一致
 * （验收 6.7.1：校验、错误码、202 载荷都不变）——校验失败仍是 1001，准备失败仍是
 * 2002，分区无执行器 2004，队列不可用 503。
 *
 * 本文件同时收留了两条执行路径原来各自内联的校验助手（流程的资源归属、套件的成员
 * 解析/预算）：保存与预览路由也调用它们，所以全部导出——「同一份校验只存在一处」
 * 对保存路径同样成立。
 */

/** 目标资源不存在或不属于该项目——路由映射 404/2001。 */
export class TriggerTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerTargetError";
  }
}

/** 触发前的校验失败——路由映射 400/1001（与既有执行路由同码，不能漂移）。 */
export class TriggerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerValidationError";
  }
}

/** 触发失败的统一映射。调度器（P3-4）不走这里——它捕获原始错误记 schedule_runs。 */
export function failTrigger(reply: FastifyReply, error: unknown, fallback: string) {
  if (error instanceof NoRunnerError) return failNoRunner(reply, error.label, error.message);
  if (error instanceof TriggerTargetError) return fail(reply, 404, 2001, error.message);
  if (error instanceof TriggerValidationError) return fail(reply, 400, 1001, error.message);
  const message = error instanceof Error ? error.message : fallback;
  /* Queue down is infrastructure, not bad input — 503 so the client can say
     「执行队列不可用」rather than blaming the flow or the suite. */
  if (message.includes("queue unavailable")) return fail(reply, 503, 5001, message);
  return fail(reply, 400, 2002, message);
}

/* ---------------------------------------------------------------------------
 * 流程侧校验（自 routes/flows.ts 抽出，保存与两条单步调试路由继续调用）。
 * ------------------------------------------------------------------------- */

/**
 * Every node must point at an endpoint in this project.
 *
 * The FK on `executions.endpoint_id` only proves the endpoint exists, not that
 * it belongs here, so without this a node could attribute its runs to another
 * project's endpoint history.
 */
/** 展平所有节点（含循环体里的内联步骤），供资源归属与脚本用量检查。 */
function flattenNodes(nodes: FlowNode[], into: FlowNode[] = []): FlowNode[] {
  for (const node of nodes) {
    into.push(node);
    if (node.type === "loop") flattenNodes(node.body?.nodes ?? [], into);
  }
  return into;
}

async function endpointsBelong(projectId: string, nodes: FlowNode[]): Promise<string | undefined> {
  const flat = flattenNodes(nodes);
  const ids = [...new Set(flat.filter((node) => node.type === "request").map((node) => node.endpointId))];
  if (!ids.length) return undefined;
  const result = await pool.query("SELECT id FROM endpoints WHERE id = ANY($1::uuid[]) AND project_id = $2", [ids, projectId]);
  if (result.rowCount === ids.length) return undefined;
  return "a node references an endpoint that does not exist in this project";
}

async function databaseResourcesBelong(projectId: string, nodes: FlowNode[]): Promise<string | undefined> {
  const flat = flattenNodes(nodes);
  const databaseNodes = flat.filter((node) => node.type === "database");
  const sourceIds = [...new Set(databaseNodes.map((node) => node.dataSourceId))];
  if (sourceIds.length) {
    const sources = await pool.query("SELECT id FROM data_sources WHERE id = ANY($1::uuid[]) AND project_id = $2", [sourceIds, projectId]);
    if (sources.rowCount !== sourceIds.length) return "a database node references a data source that does not exist in this project";
  }
  const definitionIds = [...new Set(databaseNodes.flatMap((node) => node.sqlDefinitionId ? [node.sqlDefinitionId] : []))];
  if (definitionIds.length) {
    const definitions = await pool.query("SELECT id, data_source_id FROM sql_definitions WHERE id = ANY($1::uuid[]) AND project_id = $2", [definitionIds, projectId]);
    if (definitions.rowCount !== definitionIds.length) return "a database node references an SQL definition that does not exist in this project";
    const expected = new Map(databaseNodes.filter((node) => node.sqlDefinitionId).map((node) => [node.sqlDefinitionId!, node.dataSourceId]));
    if (definitions.rows.some((row) => String(row.data_source_id) !== expected.get(String(row.id)))) return "a database node SQL definition must belong to its selected data source";
  }
  return undefined;
}

export async function resourcesBelong(projectId: string, nodes: FlowNode[]) {
  return await endpointsBelong(projectId, nodes) ?? await databaseResourcesBelong(projectId, nodes);
}

/* ---------------------------------------------------------------------------
 * 套件侧校验（自 routes/suites.ts 抽出，保存与预览路由继续调用）。
 * ------------------------------------------------------------------------- */

export function validateExecution(execution: Partial<SuiteExecutionConfig> | undefined): string | undefined {
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

export type StoredExecutionConfig = {
  concurrency: number;
  failFast: boolean;
  environmentStrategy: "member_default" | "override";
  environmentId: string | null;
};

export function toExecutionConfig(execution: Partial<SuiteExecutionConfig> | undefined): StoredExecutionConfig {
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

export async function environmentBelongs(projectId: string, environmentId: string | null | undefined): Promise<boolean> {
  if (!environmentId) return true;
  const result = await pool.query("SELECT 1 FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  return Boolean(result.rowCount);
}

/** 覆盖环境的名称，用于执行行上的快照（环境改名/删除后报告仍读得通，Spec 4.4）。 */
export async function environmentSnapshot(projectId: string, environmentId: string | null | undefined): Promise<string | undefined> {
  if (!environmentId) return undefined;
  const result = await pool.query("SELECT name FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  return result.rowCount ? String(result.rows[0].name) : undefined;
}

export async function loadSuite(projectId: string, suiteId: string): Promise<TestSuite | undefined> {
  if (!isUuid(suiteId)) return undefined;
  const result = await pool.query("SELECT * FROM test_suites WHERE id = $1 AND project_id = $2", [suiteId, projectId]);
  return result.rowCount ? mapTestSuite(result.rows[0]) : undefined;
}

/** 一次套件解析的结果。missing 与 warnings 都要给到界面上，不静默丢弃。 */
export type ResolvedMembers = {
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
export async function resolveMembers(projectId: string, selection: SuiteSelection): Promise<ResolvedMembers> {
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
export async function concurrencyBudget(projectId: string, members: SuiteMemberSnapshot[], concurrency: number) {
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

/* ---------------------------------------------------------------------------
 * 两条触发路径。手动路由现在只是薄壳；P3-4 的调度器与 P3-6 的 Webhook 入口
 * 调用同一对函数，因此不可能缺一项检查。
 * ------------------------------------------------------------------------- */

export type FlowTriggerInput = {
  projectId: string;
  flowId: string;
  /** 未保存的画布图（手动路径，交互文档 3.1.3）。不传 = 用已存定义（定时 / Webhook）。 */
  nodes?: FlowNode[];
  edges?: FlowEdge[];
  /**
   * 手动画布路径的**整袋**变量（替换语义，既有行为不改——画布发的是编辑器当前
   * 全量）。缺省时走「已存种子变量 + variableOverrides 覆盖」的触发语义。
   */
  variables?: Record<string, string>;
  /** 触发路径的变量覆盖（6.5 泳道第二层）：压过 flow.variables 的同名项。 */
  variableOverrides?: Record<string, string>;
  /** 触发级环境覆盖（边界 4）：不传用流程自己的环境。换环境就是换分区（P2-8）。 */
  environmentId?: string;
  /** 触发者（P3-3）。缺省 manual。 */
  trigger?: TriggerContext;
};

export async function triggerFlowRun(input: FlowTriggerInput): Promise<string> {
  if (!isUuid(input.flowId)) throw new TriggerTargetError("flow not found");
  const found = await pool.query("SELECT * FROM flows WHERE id = $1 AND project_id = $2", [input.flowId, input.projectId]);
  if (!found.rowCount) throw new TriggerTargetError("flow not found");
  const flow: Flow = mapFlow(found.rows[0]);

  const override = input.nodes !== undefined || input.edges !== undefined;
  const nodes = override ? (input.nodes ?? []).map(toFlowNode) : flow.nodes;
  const edges = override ? input.edges ?? [] : flow.edges;
  if (override) {
    const invalid = validateFlowGraph(nodes, edges);
    if (invalid) throw new TriggerValidationError(invalid);
  }
  const owned = await resourcesBelong(input.projectId, nodes);
  if (owned) throw new TriggerValidationError(owned);
  if (!nodes.length) throw new TriggerValidationError("a flow needs at least one node to run");
  /* 执行同样做跨流程递归检测：被引用的流程可能在上次保存后被改坏。 */
  const recursive = await checkFlowReferences(input.projectId, nodes, [{ id: flow.id, name: flow.name }]);
  if (recursive) throw new TriggerValidationError(recursive);

  /* 触发级环境覆盖（边界 4）：直接换 environmentId，沿用既有的环境选择链；名称取
     当下的名字做快照（Spec 4.4）。 */
  let environmentId = flow.environmentId;
  let environmentName = flow.environmentName;
  if (input.environmentId) {
    if (!isUuid(input.environmentId)) throw new TriggerValidationError("environmentId must be a UUID");
    const environment = await pool.query("SELECT name FROM environments WHERE id = $1 AND project_id = $2", [input.environmentId, input.projectId]);
    if (!environment.rowCount) throw new TriggerValidationError("environment must belong to the project");
    environmentId = input.environmentId;
    environmentName = String(environment.rows[0].name);
  }

  /* 变量的合并策略只有这一处：手动 = 画布整袋（或流程自己的种子）；触发 = 种子 +
     覆盖（后者胜）。调度与 Webhook 不各自再算一遍。 */
  const variables = input.variables ?? { ...flow.variables, ...(input.variableOverrides ?? {}) };

  return enqueueFlowRun({
    projectId: input.projectId,
    flowId: flow.id,
    flowName: flow.name,
    environmentId,
    environmentName,
    nodes, edges, variables,
    trigger: input.trigger,
  });
}

export type SuiteTriggerInput = {
  projectId: string;
  suiteId: string;
  /** 手动路径「未保存就想跑一次」的执行配置覆盖（交互文档 3.1.3），部分覆盖。 */
  execution?: Partial<SuiteExecutionConfig>;
  /** 触发时的变量覆盖（6.5 泳道第二层）。手动、调度、Webhook 共用。 */
  variables?: Record<string, string>;
  /**
   * 触发级环境覆盖（边界 4）：有值时这次执行走 environmentStrategy='override' +
   * 这个环境（复用套件既有的覆盖机制，不新造第三条环境选择链）。
   */
  environmentId?: string;
  /** 触发者（P3-3）。缺省 manual。 */
  trigger?: TriggerContext;
};

export async function triggerSuiteRun(input: SuiteTriggerInput): Promise<string> {
  const suite = await loadSuite(input.projectId, input.suiteId);
  if (!suite) throw new TriggerTargetError("test suite not found");

  const invalidVariables = validateVariableOverrides(input.variables);
  if (invalidVariables) throw new TriggerValidationError(invalidVariables);

  /* 手动覆盖是**部分**覆盖，先与已存配置合并；触发级环境（边界 4）最后压成
     override——它连套件自己存的 override 也要盖过。 */
  const merged: Partial<SuiteExecutionConfig> = { ...suite.execution, ...(input.execution ?? {}) };
  if (input.environmentId) {
    if (!isUuid(input.environmentId)) throw new TriggerValidationError("environmentId must be a UUID");
    merged.environmentStrategy = "override";
    merged.environmentId = input.environmentId;
  }
  const invalid = validateExecution(merged);
  if (invalid) throw new TriggerValidationError(invalid);
  const execution = toExecutionConfig(merged);
  if (!await environmentBelongs(input.projectId, execution.environmentId)) throw new TriggerValidationError("environment must belong to the project");

  const resolved = await resolveMembers(input.projectId, suite.selection);
  /* 「套件里没有成员不能运行」是执行时的检查（保存时允许空——新建套件必然从零成员
     开始，见 issue_fix/P2-4_ISSUE_LOG.md）。 */
  if (!resolved.members.length) throw new TriggerValidationError("this suite resolves to no members; add members before running it");
  if (resolved.members.length > SUITE_MAX_MEMBERS) throw new TriggerValidationError(`this suite resolves ${resolved.members.length} members, over the limit of ${SUITE_MAX_MEMBERS}`);
  /* 单个成员一次要的令牌比整个池子还多：原子领取永远凑不齐，拒绝而不是让它跑到那一步
     才失败（与「循环迭代 >100 硬失败」同一原则）。 */
  const budget = await concurrencyBudget(input.projectId, resolved.members, execution.concurrency);
  if (budget.over) throw new TriggerValidationError(`member "${budget.over.member.name}" needs ${budget.over.demand} concurrent requests at once, over this platform's budget of ${budget.budget}`);

  /* 成员在这一刻解析并冻进 member_snapshot：tag/all 是动态选择，报告要可复现就必须
     在入队时定下来。 */
  return enqueueSuiteRun({
    projectId: input.projectId,
    suiteId: suite.id,
    suiteName: suite.name,
    environmentId: execution.environmentId ?? undefined,
    environmentName: await environmentSnapshot(input.projectId, execution.environmentId),
    members: resolved.members,
    execution: { ...execution, environmentId: execution.environmentId ?? undefined },
    variables: input.variables ?? {},
    trigger: input.trigger,
  });
}
