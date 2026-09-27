import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import { pool } from "../db.js";
import { writeAuditLogAsync } from "./audit.js";
import { claimIdempotency, fillIdempotencyResult, IDEMPOTENCY_SCOPES, type IdempotencyClaim } from "./idempotency.js";
import { NoRunnerError, enqueueFlowRun, enqueueSuiteRun } from "./enqueue.js";
import { SUITE_LEAF_BUDGET, toFlowNode, validateFlowGraph } from "./flow.js";
import { checkFlowReferences } from "./flowRefs.js";
import { validateVariableOverrides } from "./resolve.js";
import { fail, failNoRunner } from "./response.js";
import { memberTokenDemand } from "./suiteRun.js";
import { isUuid } from "./uuid.js";
import {
  mapCiTask, mapFlow, mapPipelineRun, mapTestSuite,
  RUNNER_OFFLINE_AFTER_SECONDS,
  SUITE_DEFAULT_CONCURRENCY, SUITE_MAX_CONCURRENCY, SUITE_MAX_MEMBERS,
  type Flow, type FlowEdge, type FlowNode, type PipelineRun, type SuiteExecutionConfig, type SuiteMemberRef, type SuiteMemberSnapshot, type SuiteSelection, type TestSuite, type TriggerContext, type CiTask,
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
  /* CI 形状的 2004（P4.5-2）：消息由抛点说清缺的是 Runner 还是沙箱档（验收门槛 4）。 */
  if (error instanceof NoCiRunnerError) return failNoRunner(reply, error.label, error.message);
  if (error instanceof TriggerTargetError) return fail(reply, 404, 2001, error.message);
  if (error instanceof TriggerValidationError) return fail(reply, 400, 1001, error.message);
  const message = error instanceof Error ? error.message : fallback;
  /* Queue down is infrastructure, not bad input — 503 so the client can say
     「执行队列不可用」rather than blaming the flow or the suite. */
  if (message.includes("queue unavailable")) return fail(reply, 503, 5001, message);
  return fail(reply, 400, 2002, message);
}

/**
 * CI 触发的目标分区没有能领这个 job 的 Runner（P4.5-2，错误码 `2004` 的 CI 形状）。
 *
 * 与 `NoRunnerError`（BullMQ worker 那一侧）分开成两个类型而不是复用一个带自定义消息的
 * 基类：`failNoRunner` 的形状复用（503 + 2004 + `data.label`），但判据不同——CI 读
 * `runners` 表且多一层沙箱可满足性，消息也必须说清缺的是「Runner」还是「容器档」，
 * 复用同一个类会让两种检查挤在一个 message 里。
 */
export class NoCiRunnerError extends Error {
  constructor(readonly label: string, message: string) {
    super(message);
    this.name = "NoCiRunnerError";
  }
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

/* ---------------------------------------------------------------------------
 * CI 任务触发（P4.5-2）。与上面两条路径并列（P3 边界 5 的「单一触发路径」）：
 * 调度（`lib/schedule.ts` 的 `fireCiTask`）与 Webhook（`routes/webhookTriggers.ts` 的
 * `ci_task` 分支）在 P4.5-12 接了进来，两者都走这一个函数而不是各自再校验一遍。
 *
 * 与 flow / suite 最大的不同：这里没有 Redis 队列。`pipeline_runs` 本身就是队列
 * （claim 用 `FOR UPDATE SKIP LOCKED` 直接认领行，P4.5-3），所以本函数的职责到
 * 「写下一行 queued 并 NOTIFY」为止。
 * ------------------------------------------------------------------------- */

export type CiTaskTriggerInput = {
  projectId: string;
  ciTaskId: string;
  /** 触发时可顺带填的任务参数（§8.3），键形与变量覆盖同一条规则。 */
  parameters?: Record<string, string>;
  /** `{ caseKeys }` = 勾选执行（§8.3，P4.5-9 贯通）；缺省/null = 全量。 */
  caseFilter?: { caseKeys?: unknown } | null;
  /** 触发者（P3-3 同款形状）。缺省 manual；`scheduled` / `webhook` 由 P4.5-12 的两条
      接入路径产出，`ci` 值仍没有产出方。 */
  trigger?: TriggerContext;
  /** 点按钮的用户（manual 路径）。 */
  triggeredBy?: string;
  /**
   * `Idempotency-Key` 请求头（P4.5-8，边界 17 的通用设施第一次接线）。缺省不防重
   * （与接入前的行为完全一致——双击产出两条 run 是既有事实，不装作它已经被修掉）。
   */
  idempotencyKey?: string;
  /** 审计用：触发请求的来源 IP（`request.ip`）。 */
  requestIp?: string;
};

/** 勾选执行的 key 集合上限：防一次误传全量树把 JobSpec 撑大；正常勾选远到不了这里。 */
const CASE_FILTER_LIMIT = 500;

/**
 * 校验并归一 `caseFilter`；返回落库的 `{ case_keys }`（null = 全量）。
 *
 * 落库键形是 **snake_case `case_keys`**，与 JobSpec 协议（`lib/jobSpec.ts`）、
 * `caseFilterKeys`（lib/pipelineRun.ts）与 `mapPipelineRun`（models/types.ts）三个读侧
 * 同一形状；请求侧键名 `caseKeys` 是 camelCase 信封的形状，归一在这里完成一次性翻译。
 *
 * key 只做非空与去重，**不校验它是否存在于树上**：脚本不认识的 key 由脚本自己跳过、
 * 平台以 `not_run` 差集兜底（边界 16），在触发时拦「树上没有的 key」反而会把跨任务
 * 勾选（§8.3 明确支持）误伤。
 */
function normalizeCaseFilter(filter: CiTaskTriggerInput["caseFilter"]): { case_keys: string[] } | null {
  if (filter === undefined || filter === null) return null;
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw new TriggerValidationError("caseFilter must be an object with a caseKeys array");
  }
  const raw = (filter as { caseKeys?: unknown }).caseKeys;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) throw new TriggerValidationError("caseFilter.caseKeys must be an array of strings");
  const keys = [...new Set((Array.isArray(raw) ? raw : []).map((each) => String(each ?? "").trim()).filter(Boolean))];
  if (!keys.length) throw new TriggerValidationError("caseFilter.caseKeys cannot be empty; omit caseFilter to run the full set");
  if (keys.length > CASE_FILTER_LIMIT) throw new TriggerValidationError(`caseFilter.caseKeys accepts at most ${CASE_FILTER_LIMIT} keys`);
  return { case_keys: keys };
}

/** 幂等命中（`Idempotency-Key` 撞到已有键）：`run` 是首次那条，没有新触发发生。 */
export class IdempotentReplayError extends Error {
  constructor(readonly run: PipelineRun) {
    super("this Idempotency-Key was already used; returning the original run");
    this.name = "IdempotentReplayError";
  }
}

/**
 * 无在线 Runner 时记一条失败 run（2026-09-26 验收需求）。
 *
 * 触发本身成功（验签通过、被接受），只是执行起不来。记两行：
 * - `pipeline_runs`：`status='failed'` + `error`，任务历史里能看到这次「触发但没跑起来」。
 * - `execution_index`（kind='runner'）：执行记录页按 runner 筛也能看到这一类。
 *
 * 与正常 run 同款取 run_number（`MAX+1`）；幂等键不在此占（请求没产出可重试的 run，
 * 失败不是「同一意图重复跑」——撞 2004 后起完 Runner 再点是同一次意图，见 P4.5-8）。
 */
async function recordCiTaskNoRunnerFailure(task: CiTask, input: CiTaskTriggerInput, message: string): Promise<void> {
  const trigger = input.trigger ?? { source: "manual" as const };
  const runId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    /* 锁任务行算 run_number（与正常 run 同款）：并发触发不会都数到同一个 n。 */
    await client.query("SELECT 1 FROM ci_tasks WHERE id = $1 AND project_id = $2 FOR UPDATE", [task.id, input.projectId]);
    const numbered = await client.query("SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM pipeline_runs WHERE ci_task_id = $1", [task.id]);
    const runNumber = Number(numbered.rows[0].next);
    await client.query(
      `INSERT INTO pipeline_runs (
         id, project_id, ci_task_id, run_number, status, stage, runner_label, sandbox_mode,
         trigger_source, trigger_ref_id, trigger_ref_name, trigger_source_url, triggered_by, git_ref, case_filter, parameters, error, finished_at
       ) VALUES ($1, $2, $3, $4, 'failed', 'done', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, now())`,
      [
        runId, input.projectId, task.id, runNumber,
        task.runnerLabel, task.sandboxMode,
        trigger.source, trigger.refId ?? null, trigger.refName ?? null, trigger.sourceUrl ?? null, input.triggeredBy ?? null,
        task.gitRef, null, JSON.stringify(input.parameters ?? {}), message,
      ],
    );
    const indexId = randomUUID();
    await client.query(
      `INSERT INTO execution_index (
         id, project_id, kind, target_id, target_name, detail_id, status,
         total, success_count, failed_count, skipped_count, canceled_count,
         trigger_source, trigger_ref_id, trigger_ref_name, trigger_source_url, started_at, finished_at
       ) VALUES ($1, $2, 'runner', $3, $4, $5, 'failed', 0, 0, 0, 0, 0, $6, $7, $8, $9, now(), now())`,
      [
        indexId, input.projectId, task.id,
        `${task.name} #${runNumber}`, runId,
        trigger.source, trigger.refId ?? null, trigger.refName ?? null, trigger.sourceUrl ?? null,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    /* 失败记录本身就是尽力而为：写不进（库异常等）不应再盖过原始 NoCiRunnerError 的语义，
       静默吞掉，让上层照常返回 503/2004。 */
  } finally {
    client.release();
  }
}

/**
 * 触发一次 CI 任务：校验 → 检查 Runner 可用性 → 写下一行 `queued` 的 pipeline run。
 *
 * 校验全部在**写行之前**（照 P2-8 边界 4 的教训）：分区没有 Runner、沙箱档没人支持、
 * 仓库没配 clone 地址、SDK 上报开着却没有 ingest token——任何一条不满足都一行不写，
 * 用户拿到的是一句说得清的错误，而不是一条永远 `queued` 的 run。
 *
 * `Idempotency-Key`（P4.5-8）：抢占（`INSERT ... ON CONFLICT DO NOTHING`）与回填都在
 * 本函数自己的事务里，与 run 行的写入同进退——触发失败 ROLLBACK 时占位键一起消失，
 * 重试不受影响。校验失败（400/404/2004 那些早期拒绝）发生在**抢占之前**：同一个键
 * 换个参数重试是被允许的，只有真正产出了 run 的那次调用才占用这个键。命中已有键抛
 * `IdempotentReplayError`（路由层映射回首次的 run，`failTrigger` 不认识它——它不是失败）。
 */
export async function triggerCiTaskRun(input: CiTaskTriggerInput): Promise<PipelineRun> {
  if (!isUuid(input.ciTaskId)) throw new TriggerTargetError("CI task not found");
  /* clone 来源在任务自己身上（P4.5-14，迁移 041）：不再 join `repositories`——那张表
     只由上报创建，而建任务不该以「先跑过一次 CI」为前提（计划 8.11 的 A 类）。 */
  const found = await pool.query(
    `SELECT t.*, c.name AS git_credential_name, c.method AS git_credential_method
       FROM ci_tasks t LEFT JOIN git_credentials c ON c.id = t.git_credential_id
      WHERE t.id = $1 AND t.project_id = $2`,
    [input.ciTaskId, input.projectId],
  );
  if (!found.rowCount) throw new TriggerTargetError("CI task not found");
  const task = mapCiTask(found.rows[0]);

  if (!task.enabled) throw new TriggerValidationError("this CI task is disabled");
  /* 存量行可能带着 container 档却没填 image（创建后才会被改坏的场景极少，但 JobSpec
     组装在 P4.5-3，那时再报就是一条 failed 的 run——触发时说清（验收门槛 4 同款原则）。 */
  if (task.sandboxMode === "container" && !task.image) {
    throw new TriggerValidationError(`task "${task.name}" uses the container sandbox but has no image; set one or switch it to process mode`);
  }
  if (!task.gitUrl) {
    throw new TriggerValidationError(`task "${task.name}" has no git URL to clone from; set one in the task first`);
  }

  const invalidParameters = validateVariableOverrides(input.parameters, "parameters");
  if (invalidParameters) throw new TriggerValidationError(invalidParameters);
  const caseFilter = normalizeCaseFilter(input.caseFilter);

  /**
   * `APITRACK_TOKEN` 不在这里检查（P4.5-3 起）：约定 8 写的「复用项目的 ingest_tokens，
   * 没有就在触发时报错」落地时改成了 **claim 时按 run 现签一张**（lib/jobSpec.ts）——
   * 库里只存 scrypt 哈希，明文取不回来，「注入既有 token」没有可实现形状。原 P4.5-2 的
   * 触发前置检查随之撤销：按 run 签发永远能签出来，那个检查只会拦住合法触发。
   */

  /**
   * 无在线 Runner 拒绝（`2004`）+ `sandbox_mode` 可满足性检查，一次查询两个答案。
   *
   * 判据与 Runner 池面板（`routes/runners.ts` 的 claimable）同一份：心跳新鲜度用
   * `RUNNER_OFFLINE_AFTER_SECONDS`，且排除 `draining`。**不读 `workers` 表**：同一个
   * 标签下可以既有 BullMQ worker 又有 Runner，两者互不相领（8.1），CI 只认 Runner。
   */
  const available = await pool.query(
    `SELECT COUNT(*)::int AS online,
            COUNT(*) FILTER (WHERE $3 = ANY(sandbox_modes))::int AS matching
       FROM runners
      WHERE $1 = ANY(labels)
        AND status <> 'draining'
        AND last_seen_at > now() - ($2 || ' seconds')::interval`,
    [task.runnerLabel, RUNNER_OFFLINE_AFTER_SECONDS, task.sandboxMode],
  );
  const online = Number(available.rows[0].online);
  const matching = Number(available.rows[0].matching);
  if (!online) {
    /* 无在线 Runner 也记一条失败 run（2026-09-26 验收需求）：触发本身成功了（HMAC 验签
       通过、被接受），只是执行因为缺 Runner 起不来。不记的话任务历史里「这次触发」什么
       都看不见，外部 CI 回调成功却无从核对。 */
    await recordCiTaskNoRunnerFailure(task, input, `no online runner serves partition "${task.runnerLabel}"; register one with this label first`);
    throw new NoCiRunnerError(task.runnerLabel, `no online runner serves partition "${task.runnerLabel}"; register one with this label first`);
  }
  if (!matching) {
    await recordCiTaskNoRunnerFailure(task, input, `online runners on partition "${task.runnerLabel}" do not support sandbox mode "${task.sandboxMode}"; register a runner with that capability or switch the task to ${task.sandboxMode === "container" ? "process" : "container"} mode`);
    throw new NoCiRunnerError(task.runnerLabel, `online runners on partition "${task.runnerLabel}" do not support sandbox mode "${task.sandboxMode}"; register a runner with that capability or switch the task to ${task.sandboxMode === "container" ? "process" : "container"} mode`);
  }

  const trigger = input.trigger ?? { source: "manual" as const };
  const runId = randomUUID();
  const client = await pool.connect();
  let idempotencyClaim: IdempotencyClaim | undefined;
  try {
    await client.query("BEGIN");
    /* 幂等抢占在事务里、且在锁任务行之前：并发双击的两个事务里只有一个能 INSERT
       成功，另一个走 DO NOTHING 回读——但它读到的是未提交行吗？不会：READ COMMITTED
       下它看不到对方的未提交插入，自己的 INSERT 也会因唯一索引冲突（等对方提交后）
       返回 0 行，回读拿到的已是对方 COMMIT 后回填的真 run id。抢占先于 FOR UPDATE
       是刻意的：撞键的请求不必排队等任务行锁，直接短路。 */
    if (input.idempotencyKey) {
      idempotencyClaim = await claimIdempotency(client, IDEMPOTENCY_SCOPES.ciTaskTrigger, input.projectId, input.idempotencyKey);
      if (!idempotencyClaim.claimed) {
        const replayed = await pool.query("SELECT * FROM pipeline_runs WHERE id = $1", [idempotencyClaim.resultId]);
        /* result_id 理论上可能指向已删除的 run（项目删除会级联掉 runs 但 idempotency_keys
           同项目一起级联，正常路径到不了这里）。查不到按幂等失效处理：删掉占位行重试。 */
        if (replayed.rowCount) {
          throw new IdempotentReplayError(mapPipelineRun(replayed.rows[0]));
        }
        await client.query(
          "DELETE FROM idempotency_keys WHERE scope = $1 AND project_id = $2 AND key = $3 AND result_id = $4",
          [IDEMPOTENCY_SCOPES.ciTaskTrigger, input.projectId, input.idempotencyKey, idempotencyClaim.resultId],
        );
        idempotencyClaim = await claimIdempotency(client, IDEMPOTENCY_SCOPES.ciTaskTrigger, input.projectId, input.idempotencyKey);
      }
    }
    /* 锁任务行把同一任务的并发触发串行化（suiteReportName 同款）：否则两次触发都数到
       n、都写 n+1，撞 pipeline_runs_task_number_idx 的那个拿 500。 */
    await client.query("SELECT 1 FROM ci_tasks WHERE id = $1 AND project_id = $2 FOR UPDATE", [task.id, input.projectId]);
    const numbered = await client.query(
      "SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM pipeline_runs WHERE ci_task_id = $1",
      [task.id],
    );
    const inserted = await client.query(
      `INSERT INTO pipeline_runs (
         id, project_id, ci_task_id, run_number, status, stage, runner_label, sandbox_mode,
         trigger_source, trigger_ref_id, trigger_ref_name, trigger_source_url, triggered_by, git_ref, case_filter, parameters
       ) VALUES ($1, $2, $3, $4, 'queued', 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
       RETURNING *`,
      [
        runId, input.projectId, task.id, Number(numbered.rows[0].next),
        task.runnerLabel, task.sandboxMode,
        trigger.source, trigger.refId ?? null, trigger.refName ?? null, trigger.sourceUrl ?? null, input.triggeredBy ?? null,
        task.gitRef, caseFilter ? JSON.stringify(caseFilter) : null, JSON.stringify(input.parameters ?? {}),
      ],
    );
    /* NOTIFY 在事务里发、commit 时投递（8.2 约定 2）：等待中的 claim 长轮询（P4.5-3）
       立刻醒。载荷带标签供 listener 侧过滤，现在没有监听者也无害。 */
    await client.query("SELECT pg_notify('pipeline_queued', $1)", [task.runnerLabel]);
    if (idempotencyClaim?.claimed) {
      await fillIdempotencyResult(client, IDEMPOTENCY_SCOPES.ciTaskTrigger, input.projectId, input.idempotencyKey!, idempotencyClaim.placeholderId, runId);
    }
    await client.query("COMMIT");
    /* 审计在 COMMIT 之后（fire-and-forget）：run 已是事实，审计写失败不该连累它
       （见 lib/audit.ts 文件头的取舍）。detail 带 case_filter 的 key 数量而不是全量
       列表（§8.3 的纪律），parameters 只记键名——值可能是用户数据。 */
    writeAuditLogAsync({
      action: "ci_task.trigger",
      targetType: "ci_task",
      targetId: task.id,
      projectId: input.projectId,
      userId: input.triggeredBy ?? null,
      detail: {
        runId,
        runNumber: Number(inserted.rows[0].run_number),
        triggerSource: trigger.source,
        caseFilterCount: caseFilter?.case_keys.length ?? 0,
        parameterKeys: Object.keys(input.parameters ?? {}),
      },
      ip: input.requestIp ?? "",
    });
    return mapPipelineRun(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    /* IdempotentReplayError 是「命中」不是「失败」，但 ROLLBACK 仍是必要的：占位键
       行（若有）随回滚消失，键回到可用状态——对方已提交的行不受影响。 */
    throw error;
  } finally {
    client.release();
  }
}
