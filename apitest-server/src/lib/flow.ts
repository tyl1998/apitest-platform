import { readPath, validateAssertions, validateDeclarativeAssertions } from "./assert.js";
import { BODY_TYPES, METHODS } from "./http.js";
import { isUuid } from "./uuid.js";
import { validateSqlDefinition } from "./sqlExecutor.js";
import type { Assertion, ConditionGroup, ConditionRule, FlowEdge, FlowEdgeCondition, FlowExtract, FlowExtractResult, FlowNode, HookConfig, RequestSnapshot, ResponseScriptConfig } from "../models/types.js";

/**
 * Flow 文档的校验与执行计划（P1-2，DEVELOPMENT_PLAN 4.0.2）。
 *
 * 校验放在这里而不是路由里，是因为同一份规则有三个调用方：保存流程、执行流程、
 * 单步调试。三者对「一个节点是否可执行」必须给出同一个答案，否则会出现能存下来
 * 但一跑就 500 的流程。
 */

/** 够画一条真实业务链路，又不至于让一次保存变成几百 KB 的 JSONB。 */
export const MAX_FLOW_NODES = 50;
/** 循环体是画布上被框住的那几步，不需要 50 的额度；上限让嵌套体积有保障。 */
export const MAX_LOOP_BODY_NODES = 10;
const MAX_FLOW_EDGES = MAX_FLOW_NODES * 4;
const NODE_TYPES: FlowNode["type"][] = ["request", "database", "script", "condition", "wait", "subflow", "loop"];
const EXTRACT_SOURCES: FlowExtract["from"][] = ["body", "header", "status"];
const FAILURE_MODES: FlowNode["onFailure"][] = ["stop", "continue"];
export const CONDITION_OPERATORS: ConditionRule["operator"][] = ["equals", "notEquals", "contains", "exists", "notExists", "greaterThan", "lessThan"];
/** Condition branches name the two exits; everything else is success/failure. */
export const EDGE_CONDITIONS: FlowEdgeCondition[] = ["success", "failure", "true", "false"];
/** 与 resolve.ts 的 `{{name}}` 词法一致：能提取出来的名字必须引用得到。 */
const VARIABLE_NAME = /^[\w.-]+$/;

/**
 * P2-6 的三条硬上限（计划 5.5.2 第 6 条验收）。
 *
 * 都不是可配置项，而是保护性上限：一个节点内部的迭代、一次等待、一层嵌套都不能
 * 把 worker 槽变成停车位。`FLOW_TIMEOUT_MS`（10 分钟）仍然在最外层兜底，这三个
 * 值只保证「跑到上限必停」这件事在校验阶段就能说清楚。
 */
export const MAX_LOOP_ITERATIONS = 100;
/**
 * 单个循环节点允许同时在途的迭代数。
 *
 * 这是「同一个接口发 N 个并发请求」的表达方式：一个 `count` 循环 + 单节点循环体 +
 * `concurrency > 1`。上限与流程并发上限同量级，因为它**不额外增加容量**——叶子步骤
 * 仍然从整次执行共享的 `FLOW_PARALLELISM` 预算里取令牌（见 lib/flowRun.ts），所以
 * 嵌套循环不会把并发乘起来。想压出真实压力应该用专门的压测工具，这里只表达形状。
 */
export const MAX_LOOP_CONCURRENCY = 10;
/**
 * 首版等待是**短等待**：等待期间节点占着流程的并发槽不放，所以上限按「值得同步
 * 等」的量级取，而不是按「业务上可能想等多久」。真正的长等待需要挂起-恢复模型
 * （规范 3.2），不在本切片。
 */
export const MAX_WAIT_MS = 30_000;
/** 子流程/循环体的最大嵌套层数：主流程为 0，它引用的流程为 1。 */
export const MAX_FLOW_DEPTH = 3;

function validateRequest(request: Partial<RequestSnapshot> | undefined, where: string): string | undefined {
  if (!request) return `${where}: request is required`;
  if (!request.method || !METHODS.includes(request.method.toUpperCase())) return `${where}: request.method must be one of ${METHODS.join(", ")}`;
  if (!request.url?.trim()) return `${where}: request.url is required`;
  /* 变量在执行时才展开，所以只对字面量 URL 做协议检查——与 cases.ts 同一条规则。 */
  if (!request.url.includes("{{") && !/^https?:\/\//i.test(request.url.trim())) return `${where}: request.url must start with http:// or https://`;
  if (request.bodyType !== undefined && !BODY_TYPES.includes(request.bodyType)) return `${where}: request.bodyType must be one of ${BODY_TYPES.join(", ")}`;
  return undefined;
}

export function validateExtracts(extracts: unknown, where: string): string | undefined {
  if (extracts === undefined) return undefined;
  if (!Array.isArray(extracts)) return `${where}: extracts must be an array`;
  const seen = new Set<string>();
  for (const item of extracts as FlowExtract[]) {
    const name = item?.name?.trim();
    if (!name) return `${where}: an extract needs a variable name`;
    /**
     * `$` 开头是内置动态变量（`{{$uuid}}` 等）的命名空间，且 resolve.ts 让内置
     * 优先于变量袋——真让用户提取一个 `$foo`，它永远取不到值，报错好过静默失效。
     */
    if (name.startsWith("$")) return `${where}: "${name}" is reserved for built-in variables`;
    if (!VARIABLE_NAME.test(name)) return `${where}: "${name}" is not a usable variable name`;
    if (seen.has(name)) return `${where}: extract "${name}" is declared twice`;
    seen.add(name);
    if (!EXTRACT_SOURCES.includes(item.from)) return `${where}: extract.from must be one of ${EXTRACT_SOURCES.join(", ")}`;
    /* status 没有可寻址的位置，body/header 没有 path 就不知道取什么。 */
    if (item.from !== "status" && !item.path?.trim()) return `${where}: extract "${name}" needs a path`;
  }
  return undefined;
}

/**
 * 前置钩子校验。
 *
 * 只认已注册的 kind——写错 type 的钩子存下来不会报错，只会在执行时静默不签名，
 * 然后被测服务返回 401，用户去查服务端。保存时就拒掉比那便宜得多。
 */
const HOOK_TYPES: HookConfig["type"][] = ["script"];
const MAX_HOOKS_PER_NODE = 5;

export function validateHooks(hooks: unknown, where: string): string | undefined {
  if (hooks === undefined) return undefined;
  if (!Array.isArray(hooks)) return `${where}: preRequestHooks must be an array`;
  if (hooks.length > MAX_HOOKS_PER_NODE) return `${where}: at most ${MAX_HOOKS_PER_NODE} pre-request hooks per node`;
  for (const [index, hook] of (hooks as HookConfig[]).entries()) {
    const at = `${where}: hook ${index + 1}`;
    if (!hook || typeof hook !== "object") return `${at} must be an object`;
    if (!HOOK_TYPES.includes(hook.type)) return `${at}: type must be one of ${HOOK_TYPES.join(", ")}`;
    if (hook.type === "script" && !hook.script?.scriptId && !hook.script?.content?.trim()) {
      return `${at}: a script hook needs a script`;
    }
  }
  return undefined;
}

const MAX_RESPONSE_SCRIPTS_PER_NODE = 5;

export function validateResponseScripts(scripts: unknown, where: string): string | undefined {
  if (scripts === undefined) return undefined;
  if (!Array.isArray(scripts)) return `${where}: responseScripts must be an array`;
  if (scripts.length > MAX_RESPONSE_SCRIPTS_PER_NODE) return `${where}: at most ${MAX_RESPONSE_SCRIPTS_PER_NODE} response scripts per node`;
  for (const [index, config] of (scripts as ResponseScriptConfig[]).entries()) {
    const at = `${where}: response script ${index + 1}`;
    if (!config || typeof config !== "object") return `${at} must be an object`;
    if (config.type !== "script") return `${at}: type must be script`;
    if (!config.script?.scriptId && !config.script?.content?.trim()) return `${at}: a script is required`;
  }
  return undefined;
}

function validateConditionRule(rule: ConditionRule, where: string): string | undefined {
  if (!rule.variable?.trim()) return `${where}: condition needs a variable to test`;
  if (!CONDITION_OPERATORS.includes(rule.operator)) return `${where}: condition operator must be one of ${CONDITION_OPERATORS.join(", ")}`;
  if (rule.operator !== "exists" && rule.operator !== "notExists" && rule.value === undefined) return `${where}: this condition operator requires a value`;
  return undefined;
}

function validateCondition(condition: unknown, where: string): string | undefined {
  if (!condition || typeof condition !== "object") return `${where}: condition is required`;
  const raw = condition as ConditionGroup & ConditionRule;
  const rules = Array.isArray(raw.rules) ? raw.rules : [raw];
  if (raw.mode !== undefined && raw.mode !== "all" && raw.mode !== "any") return `${where}: condition mode must be all or any`;
  if (!rules.length) return `${where}: at least one condition is required`;
  if (rules.length > 20) return `${where}: a condition node can hold at most 20 rules`;
  for (const [index, rule] of rules.entries()) {
    const invalid = validateConditionRule(rule, `${where}, condition ${index + 1}`);
    if (invalid) return invalid;
  }
  return undefined;
}

/**
 * The reference a 子流程 / 循环 node carries (P2-6).
 *
 * Only shape and naming are checked here. Whether the target flow exists, belongs
 * to this project, and does not lead back to the caller needs the database, so it
 * lives in `routes/flows.ts` (`flowReferencesResolve`) — the same split
 * `endpointsBelong` already uses for endpoint ids.
 */
function validateFlowReference(node: FlowNode & { flowId?: string; inputs?: unknown; outputs?: unknown }, where: string): string | undefined {
  if (!isUuid(node.flowId ?? "")) return `${where}: node must reference a flow`;
  if (node.inputs !== undefined) {
    if (typeof node.inputs !== "object" || node.inputs === null || Array.isArray(node.inputs)) return `${where}: inputs must be an object`;
    for (const [name, value] of Object.entries(node.inputs as Record<string, unknown>)) {
      if (!VARIABLE_NAME.test(name)) return `${where}: "${name}" is not a usable variable name`;
      if (typeof value !== "string") return `${where}: input "${name}" must be a string`;
    }
  }
  if (node.outputs !== undefined) {
    if (!Array.isArray(node.outputs)) return `${where}: outputs must be an array of variable names`;
    for (const name of node.outputs as unknown[]) {
      if (typeof name !== "string" || !VARIABLE_NAME.test(name)) return `${where}: "${String(name)}" is not a usable variable name`;
    }
  }
  return undefined;
}

export function validateNode(node: FlowNode | undefined, where: string): string | undefined {
  if (!node) return `${where}: node is required`;
  if (!node.id?.trim()) return `${where}: node id is required`;
  if (!NODE_TYPES.includes(node.type)) return `${where}: node.type must be one of ${NODE_TYPES.join(", ")}`;
  if (!node.name?.trim()) return `${where}: node name is required`;
  if (node.type === "request") {
    if (!isUuid(node.endpointId ?? "")) return `${where}: node must reference an endpoint`;
    const request = validateRequest(node.request, where);
    if (request) return request;
    /* 请求并发：同一个请求跑 N 次并发，提取按迭代序收集成数组。1 是默认值（串行），
       所以只校验显式给出的 N。 */
    if (node.concurrency !== undefined) {
      const concurrency = Number(node.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1) return `${where}: concurrency must be a whole number of at least 1`;
      if (concurrency > MAX_LOOP_CONCURRENCY) return `${where}: a request can run at most ${MAX_LOOP_CONCURRENCY} times at once`;
    }
  } else if (node.type === "database") {
    if (!isUuid(node.dataSourceId ?? "")) return `${where}: node must reference a data source`;
    if (node.sqlDefinitionId !== undefined && !isUuid(node.sqlDefinitionId)) return `${where}: sqlDefinitionId must be a uuid`;
    if (Boolean(node.sqlDefinitionId) === Boolean(node.sql?.trim())) return `${where}: choose either sqlDefinitionId or inline sql`;
    if (node.statementType !== "query" && node.statementType !== "command") return `${where}: statementType must be query or command`;
    if (!node.parameters || typeof node.parameters !== "object" || Array.isArray(node.parameters)) return `${where}: parameters must be an object`;
    if (node.sql) {
      const inferred = Object.entries(node.parameters).map(([name, value]) => ({ name, type: (typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : typeof value === "object" ? "json" : "string") as "number" | "boolean" | "json" | "string" }));
      const invalid = validateSqlDefinition(node.statementType, node.sql, inferred);
      if (invalid) return `${where}: ${invalid}`;
    }
  } else if (node.type === "script") {
    /* Same rule as a hook: an existing script may be referenced by id, a new
       one must carry its body. An id with a body edit is also fine (enqueue
       inlines whichever is newer at that moment). */
    if (!node.script?.scriptId && !node.script?.content?.trim()) return `${where}: a script node needs a script`;
  } else if (node.type === "condition") {
    const condition = validateCondition(node.condition, where);
    if (condition) return condition;
  } else if (node.type === "wait") {
    /* Rejected rather than clamped: a user who typed 5 minutes wants to know the
       platform will not do that, instead of silently waiting 30 seconds. */
    const waitMs = Number(node.waitMs);
    if (!Number.isFinite(waitMs) || !Number.isInteger(waitMs) || waitMs <= 0) return `${where}: waitMs must be a positive whole number of milliseconds`;
    if (waitMs > MAX_WAIT_MS) return `${where}: a wait can be at most ${MAX_WAIT_MS} ms in this version`;
  } else if (node.type === "subflow") {
    const reference = validateFlowReference(node, where);
    if (reference) return reference;
  } else if (node.type === "loop") {
    if (node.mode !== "count" && node.mode !== "list") return `${where}: loop mode must be count or list`;
    if (node.mode === "count") {
      const count = Number(node.count);
      if (!Number.isInteger(count) || count < 1) return `${where}: count must be a whole number of at least 1`;
      if (count > MAX_LOOP_ITERATIONS) return `${where}: a loop can run at most ${MAX_LOOP_ITERATIONS} iterations`;
    } else {
      if (!node.listVariable?.trim()) return `${where}: a list loop needs a variable holding a JSON array`;
      /* The body reads the element through this name; without it a list loop
         would run N identical iterations and look broken rather than wrong. */
      if (!VARIABLE_NAME.test(node.itemVariable?.trim() ?? "")) return `${where}: itemVariable is not a usable variable name`;
    }
    if (!VARIABLE_NAME.test(node.indexVariable?.trim() ?? "")) return `${where}: indexVariable is not a usable variable name`;
    if (node.concurrency !== undefined) {
      const concurrency = Number(node.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1) return `${where}: concurrency must be a whole number of at least 1`;
      if (concurrency > MAX_LOOP_CONCURRENCY) return `${where}: a loop can run at most ${MAX_LOOP_CONCURRENCY} iterations at a time`;
    }
    if (node.outputs !== undefined) {
      if (!Array.isArray(node.outputs)) return `${where}: outputs must be an array of variable names`;
      for (const name of node.outputs as unknown[]) {
        if (typeof name !== "string" || !VARIABLE_NAME.test(name)) return `${where}: "${String(name)}" is not a usable variable name`;
      }
    }
    /* 循环体是画布上被框住的子图：递归校验（包括体内的子流程引用合法性）。 */
    const body = validateFlowGraph(node.body?.nodes, node.body?.edges, `${where} loop body`);
    if (body) return body;
    if (!node.body?.nodes?.length) return `${where}: a loop needs at least one step inside it`;
    if (node.body.nodes.length > MAX_LOOP_BODY_NODES) return `${where}: a loop can wrap at most ${MAX_LOOP_BODY_NODES} steps`;
    /**
     * 体内有条件节点就必须显式连线。
     *
     * 没连线时执行器会按摆放顺序生成一条默认链（「这几步依次做一遍」），但从条件
     * 节点出去的边无法推断走真还是假分支——生成的默认边会按「成功」放行，于是条件
     * 静默失效。宁可要求连线，也不要让一个看起来在判断的节点其实不判断。
     */
    if (node.body.nodes.some((inner) => inner.type === "condition") && !node.body.edges?.length) {
      return `${where}: connect the condition's true/false exits inside the loop, otherwise the branch is ignored`;
    }
  }
  if (node.type === "request" || node.type === "database") {
    const assertions = node.type === "request" ? validateDeclarativeAssertions(node.assertions) : validateAssertions(node.assertions);
    if (assertions) return `${where}: ${assertions}`;
    const extracts = validateExtracts(node.extracts, where);
    if (extracts) return extracts;
  }
  if (node.type === "request") {
    const hooks = validateHooks(node.preRequestHooks, where);
    if (hooks) return hooks;
    const responseScripts = validateResponseScripts(node.responseScripts, where);
    if (responseScripts) return responseScripts;
  }
  if (node.onFailure !== undefined && !FAILURE_MODES.includes(node.onFailure)) return `${where}: node.onFailure must be one of ${FAILURE_MODES.join(", ")}`;
  return undefined;
}

/**
 * 校验整份 DAG。返回用户可读的错误串，由路由转成 400（沿用 endpoints.ts 的
 * `validate()` 风格：不抛异常）。
 */
export function validateFlowGraph(nodes: unknown, edges: unknown, where = ""): string | undefined {
  if (nodes !== undefined && !Array.isArray(nodes)) return `${where} nodes must be an array`.trim();
  if (edges !== undefined && !Array.isArray(edges)) return `${where} edges must be an array`.trim();
  const nodeList = (nodes ?? []) as FlowNode[];
  const edgeList = (edges ?? []) as FlowEdge[];
  const prefix = where ? `${where}: ` : "";
  if (nodeList.length > MAX_FLOW_NODES) return `${prefix}a flow can hold at most ${MAX_FLOW_NODES} nodes`;
  if (edgeList.length > MAX_FLOW_EDGES) return `${prefix}a flow can hold at most ${MAX_FLOW_EDGES} connections`;

  /* Ids are unique across the *whole* document, not just one level: a loop's
     body node and an outer node sharing an id would collide on the canvas. */
  const ids = new Set<string>();
  const allNodes = (list: FlowNode[], into: FlowNode[] = []): FlowNode[] => {
    for (const node of list) { into.push(node); if (node.type === "loop") allNodes(node.body?.nodes ?? [], into); }
    return into;
  };
  const flat = allNodes(nodeList);
  for (const [index, node] of flat.entries()) {
    const invalid = validateNode(node, `${where || "node"} ${index + 1}`);
    if (invalid) return invalid;
    if (ids.has(node.id)) return `${prefix}duplicate node id "${node.id}"`;
    ids.add(node.id);
  }

  const pairs = new Set<string>();
  for (const [index, edge] of edgeList.entries()) {
    const whereEdge = `${prefix}connection ${index + 1}`;
    if (!edge?.source || !edge?.target) return `${whereEdge}: source and target are required`;
    if (!ids.has(edge.source) || !ids.has(edge.target)) return `${whereEdge}: refers to a node that does not exist`;
    if (edge.source === edge.target) return `${whereEdge}: a node cannot depend on itself`;
    const pair = `${edge.source}->${edge.target}`;
    if (pairs.has(pair)) return `${whereEdge}: duplicated`;
    pairs.add(pair);
    /* A condition node decides by routing, so its edges must name an exit;
       every other node activates its default/failure edges by outcome. */
    const sourceNode = nodeList.find((node) => node.id === edge.source);
    if (edge.on !== undefined && !EDGE_CONDITIONS.includes(edge.on)) return `${whereEdge}: edge.on must be one of ${EDGE_CONDITIONS.join(", ")}`;
    if (sourceNode?.type === "condition") {
      if (edge.on !== "true" && edge.on !== "false") return `${whereEdge}: edges from a condition node must pick "true" or "false"`;
    } else if (edge.on === "true" || edge.on === "false") {
      return `${whereEdge}: only edges from a condition node can carry "true"/"false"`;
    }
  }

  /* 环意味着没有可执行顺序。存下来再在 worker 里发现就晚了——那时用户已经离开编辑器。 */
  if (!topologicalOrder(nodeList, edgeList)) return `${prefix}the flow has a cycle, so it has no runnable order`;
  return undefined;
}

/**
 * Kahn 拓扑排序，返回 undefined 表示有环。
 *
 * 同层节点按画布位置（上→下、左→右）排序，最后才退回声明顺序：首轮只做**顺序**
 * 执行，边只表达依赖不表达并行，所以并列的两个节点必须有一个稳定且用户能预测的
 * 先后——按画布位置排，用户挪一下节点就能改顺序，而不需要理解内部数组下标。
 */
export function topologicalOrder(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const index = new Map(nodes.map((node, at) => [node.id, at]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const rank = (id: string) => {
    const node = byId.get(id)!;
    return [node.position?.y ?? 0, node.position?.x ?? 0, index.get(id) ?? 0] as const;
  };
  const sortReady = (ids: string[]) =>
    ids.sort((left, right) => {
      const a = rank(left); const b = rank(right);
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    });

  const ready = sortReady([...indegree].filter(([, degree]) => degree === 0).map(([id]) => id));
  const order: FlowNode[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(byId.get(id)!);
    for (const next of outgoing.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) ready.push(next);
    }
    sortReady(ready);
  }
  return order.length === nodes.length ? order : undefined;
}

/**
 * Parallel stages for the canvas (P2-2).
 *
 * Longest-path layering: a node's stage is 1 + the max stage of its
 * predecessors, so siblings with no edge between them land in the same stage —
 * the set the runner may start concurrently up to its parallelism budget. The
 * runtime stages can differ (a condition defeats a branch), so this is the
 * plan the editor shows, never a claim about what actually ran.
 */
export function planStages(nodes: FlowNode[], edges: FlowEdge[]): string[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const stage = new Map(nodes.map((node) => [node.id, 0]));
  const predecessors = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    predecessors.get(edge.target)!.push(edge.source);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
      const next = (stage.get(edge.source) ?? 0) + 1;
      if (next > (stage.get(edge.target) ?? 0)) { stage.set(edge.target, next); changed = true; }
    }
  }
  const max = Math.max(0, ...stage.values());
  const groups: string[][] = Array.from({ length: max + 1 }, () => []);
  for (const node of nodes) groups[stage.get(node.id) ?? 0].push(node.id);
  return groups;
}

/**
 * The shared part of a 子流程 / 循环 node's reference (P2-6).
 *
 * `outputs: undefined` and `outputs: []` mean different things and must survive
 * the round trip: absent = publish everything the inner run produced, empty =
 * publish nothing. Collapsing them would make "run it for its side effects" and
 * "give me all of it" the same configuration.
 */
function normalizeFlowReference(node: FlowNode & { flowId: string; flowName?: string; inputs?: Record<string, string>; outputs?: string[] }) {
  return {
    flowId: node.flowId,
    flowName: node.flowName?.trim() || undefined,
    inputs: Object.fromEntries(Object.entries(node.inputs ?? {}).map(([name, value]) => [name.trim(), value])),
    outputs: node.outputs === undefined ? undefined : [...new Set(node.outputs.map((name) => name.trim()).filter(Boolean))],
  };
}

/** Fills in what the client may omit, so a stored node is always complete. */
export function toFlowNode(node: FlowNode): FlowNode {
  const common = {
    id: node.id.trim(),
    type: node.type,
    name: node.name.trim(),
    position: { x: Number(node.position?.x ?? 0), y: Number(node.position?.y ?? 0) },
    onFailure: node.onFailure ?? "stop",
  } as const;
  if (node.type === "database") {
    return {
      ...common, type: "database", dataSourceId: node.dataSourceId,
      sqlDefinitionId: node.sqlDefinitionId || undefined, sql: node.sql?.trim() || undefined,
      statementType: node.statementType, parameters: node.parameters ?? {},
      assertions: (node.assertions ?? []).filter((assertion) => assertion.type !== "script") as Assertion[],
      extracts: (node.extracts ?? []).map((extract) => ({ name: extract.name.trim(), from: extract.from, path: extract.path?.trim() || undefined })),
    };
  }
  if (node.type === "script") {
    return { ...common, type: "script", script: { scriptId: node.script?.scriptId, content: node.script?.content, dependencies: node.script?.dependencies } };
  }
  if (node.type === "condition") {
    const raw = node.condition as ConditionGroup & ConditionRule;
    const rules = Array.isArray(raw.rules) ? raw.rules : [raw];
    return { ...common, type: "condition", condition: {
      mode: raw.mode === "any" ? "any" : "all",
      rules: rules.map((rule) => ({ variable: rule.variable.trim(), operator: rule.operator, value: rule.value?.trim() || undefined })),
    } };
  }
  if (node.type === "wait") {
    return { ...common, type: "wait", waitMs: Math.trunc(Number(node.waitMs)) };
  }
  if (node.type === "subflow") {
    return { ...common, type: "subflow", ...normalizeFlowReference(node) };
  }
  if (node.type === "loop") {
    /* 循环体是内联子图：递归归一化，让体内节点与顶层共享同一套清洗规则。 */
    const bodyNodes = (node.body?.nodes ?? []).map(toFlowNode);
    const bodyEdges = (node.body?.edges ?? []).map((edge) => ({
      id: edge.id?.trim(), source: edge.source, target: edge.target, on: edge.on,
    }));
    return {
      ...common, type: "loop",
      mode: node.mode === "list" ? "list" : "count",
      /* Only the field the chosen mode reads is kept, so a mode switch cannot
         leave a stale count behind that validation then complains about. */
      count: node.mode === "list" ? undefined : Math.trunc(Number(node.count)),
      listVariable: node.mode === "list" ? node.listVariable?.trim() : undefined,
      itemVariable: node.mode === "list" ? node.itemVariable?.trim() : undefined,
      indexVariable: node.indexVariable.trim(),
      concurrency: node.concurrency === undefined ? 1 : Math.trunc(Number(node.concurrency)),
      outputs: node.outputs === undefined ? undefined : [...new Set(node.outputs.map((name) => name.trim()).filter(Boolean))],
      /* 画布尺寸：给出就存下来（下限保证框至少放得下一张卡），不给就让前端按体内
         步骤的包围盒算。运行时不读它。 */
      size: node.size ? { width: Math.max(200, Math.trunc(Number(node.size.width))), height: Math.max(160, Math.trunc(Number(node.size.height))) } : undefined,
      body: { nodes: bodyNodes, edges: bodyEdges },
    };
  }
  return {
    ...common,
    type: "request",
    endpointId: node.endpointId,
    concurrency: node.concurrency === undefined ? undefined : Math.trunc(Number(node.concurrency)),
    /* Provenance is displayed only; the request/assertions below are still the
       immutable copy that makes a flow independent of later case edits. */
    sourceCaseId: node.sourceCaseId?.trim() || undefined,
    sourceCaseName: node.sourceCaseName?.trim() || undefined,
    request: {
      method: node.request.method.toUpperCase(),
      url: node.request.url.trim(),
      headers: node.request.headers ?? {},
      queryParams: node.request.queryParams ?? {},
      pathParams: node.request.pathParams ?? {},
      bodyType: node.request.bodyType ?? (node.request.body === undefined ? "none" : "json"),
      body: node.request.body,
      bodyText: node.request.bodyText,
      auth: node.request.auth ?? { type: "none" },
    },
    assertions: (node.assertions ?? []).filter((assertion) => assertion.type !== "script") as Assertion[],
    extracts: (node.extracts ?? []).map((extract) => ({ name: extract.name.trim(), from: extract.from, path: extract.path?.trim() || undefined })),
    preRequestHooks: (node.preRequestHooks ?? []).map((hook) => ({
      type: hook.type,
      name: hook.name?.trim() || undefined,
      /* Absent means enabled: a hook someone added is on unless turned off. */
      enabled: hook.enabled !== false,
      script: hook.script,
    })),
    responseScripts: (node.responseScripts ?? []).map((config) => ({
      type: config.type,
      name: config.name?.trim() || undefined,
      enabled: config.enabled !== false,
      script: config.script,
    })),
  };
}

export type ExtractSubject = { statusCode?: number; headers: Record<string, string>; body?: string };
export type ExtractOutcome = { values: Record<string, string>; results: FlowExtractResult[] };

/**
 * 把一个节点的响应提取成变量。
 *
 * 取不到的变量记为失败而**不**写空串：后继节点里 `{{token}}` 保持字面量，于是执行
 * 快照上直接看得见「这里没拿到值」。塞空串会让请求带着 `token=` 发出去，变成一个
 * 401 而不是一句「上一步没提取到 token」。
 *
 * 每条提取都返回一个带原因的结果。只报「没取到」等于让用户在路径写错、响应不是
 * JSON、字段确实为 null 三种情况之间猜，而这三种的修法完全不同。
 */
export function applyExtracts(extracts: FlowExtract[], subject: ExtractSubject): ExtractOutcome {
  const values: Record<string, string> = {};
  const results: FlowExtractResult[] = [];
  if (!extracts.length) return { values, results };

  /* 响应体最多解析一次，解析失败本身就是一条可报告的原因。 */
  let parsed: unknown;
  let parsedOnce = false;
  let bodyError: string | undefined;
  const body = () => {
    if (!parsedOnce) {
      parsedOnce = true;
      if (subject.body === undefined) bodyError = "response has no body";
      else try { parsed = JSON.parse(subject.body); } catch { bodyError = "response body is not JSON"; }
    }
    return parsed;
  };
  /* RFC 9110: 响应头名大小写不敏感，与 assert.ts 同款折叠。 */
  const headers = Object.fromEntries(Object.entries(subject.headers).map(([key, value]) => [key.toLowerCase(), value]));

  for (const extract of extracts) {
    const base = { name: extract.name, from: extract.from, path: extract.path };
    let value: unknown;
    let reason: string | undefined;

    if (extract.from === "status") {
      value = subject.statusCode;
      if (value === undefined) reason = "the request never got a response";
    } else if (extract.from === "header") {
      value = headers[(extract.path ?? "").toLowerCase()];
      if (value === undefined) reason = `no "${extract.path}" header in the response`;
    } else {
      const root = body();
      if (bodyError) reason = bodyError;
      else {
        value = readPath(root, extract.path ?? "");
        /* null 与「路径不存在」是两回事：前者说明路径写对了但服务端就是返回了 null，
           后者说明路径没走通。分开报，因为一个该去问服务端，一个该改路径。 */
        if (value === null) reason = `${extract.path} is null in this response`;
        else if (value === undefined) reason = `${extract.path} does not exist in this response`;
      }
    }

    if (reason !== undefined || value === undefined || value === null) {
      results.push({ ...base, ok: false, reason: reason ?? "no value at that location" });
      continue;
    }
    /* 变量袋是 Record<string,string>：对象与数组序列化后仍可整段塞进 JSON body。 */
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    values[extract.name] = text;
    results.push({ ...base, ok: true, value: text });
  }
  return { values, results };
}

/**
 * Evaluates a condition node's rule against the variable bag (P2-2).
 *
 * `{{name}}` and bare `name` spell the same lookup, matching how `resolve.ts`
 * reads references. Comparison is the same loose numeric/text rule as
 * `assert.ts` so a bag value "200" and a typed value 200 compare equal.
 */
export function evaluateCondition(rule: ConditionRule, bag: Record<string, unknown>): { result: boolean; actual?: unknown } {
  const name = rule.variable.replace(/^\s*{{|}}\s*$/g, "").trim();
  const has = Object.prototype.hasOwnProperty.call(bag, name);
  const actual = has ? bag[name] : undefined;

  switch (rule.operator) {
    case "exists": return { result: has && actual !== null && actual !== undefined, actual };
    case "notExists": return { result: !has || actual === null || actual === undefined, actual };
  }

  const actualText = actual === undefined || actual === null ? "" : typeof actual === "object" ? JSON.stringify(actual) : String(actual);
  const expected = rule.value === undefined ? "" : rule.value.replace(referencePattern(), (whole, key: string) => (key in bag ? String(bag[key]) : whole));
  const bothNumeric = actualText.trim() !== "" && expected.trim() !== "" && !Number.isNaN(Number(actualText)) && !Number.isNaN(Number(expected));
  let result: boolean;
  switch (rule.operator) {
    case "equals": result = bothNumeric ? Number(actualText) === Number(expected) : actualText === expected; break;
    case "notEquals": result = bothNumeric ? Number(actualText) !== Number(expected) : actualText !== expected; break;
    case "contains": result = actualText.includes(expected); break;
    case "greaterThan": result = bothNumeric && Number(actualText) > Number(expected); break;
    case "lessThan": result = bothNumeric && Number(actualText) < Number(expected); break;
    default: result = false;
  }
  return { result, actual };
}

export function evaluateConditionGroup(group: ConditionGroup, bag: Record<string, unknown>) {
  const rules = group.rules.map((rule) => ({ rule, ...evaluateCondition(rule, bag) }));
  return { result: group.mode === "any" ? rules.some((item) => item.result) : rules.every((item) => item.result), rules };
}

/** A local, non-global `{{var}}` matcher so the expected value can reference the bag. */
function referencePattern() {
  return /{{\s*([\w.-]+)\s*}}/g;
}
