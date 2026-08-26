import { pool } from "../db.js";
import { MAX_FLOW_DEPTH } from "./flow.js";
import { inlineFlowNodeScripts } from "./scripts.js";
import { mapFlow, type Flow, type FlowEdge, type FlowNode } from "../models/types.js";

/**
 * 子流程与循环体引用的解析（P2-6）。
 *
 * 高级节点引入了流程之间的引用，而引用带来两个图不能自己回答的问题：**这个引用
 * 指向的流程是否属于本项目**，以及**跟着它走下去会不会绕回来**。`lib/flow.ts` 的
 * 环检测只看单张图（回边在画布上根本画不出来，规范 2.2.1：循环是节点内部迭代），
 * 所以跨流程的递归必须在这里检测。
 *
 * 检测在两处调用，且必须给出同一个答案：
 *
 * - **保存/执行前**（`routes/flows.ts`）：`checkFlowReferences` 只读图，返回一句
 *   用户可读的原因，让编辑器当场拒绝，而不是存下来一跑就炸。
 * - **入队时**（`flowRun.ts` 的 `prepareFlowNodes`）：`resolveFlowBodies` 把内层图
 *   连同脚本正文一起冻进 `run_spec`。冻结的理由与内联脚本完全相同——入队之后被改
 *   的子流程不能改变已经排队的这一次执行，执行记录必须描述真正跑过的那份定义。
 *
 * 注意冻结**不等于**快照隔离：请求节点复制 endpoint 是为了让流程独立于后续编辑，
 * 而子流程存在的意义恰恰是「一份定义、多处复用」，所以下一次运行会读到改好的定义。
 *
 * 第三个调用方是**删除前的反向扫描**（P2-4.5）：`flowsReferencing` 回答「谁引用了这个
 * id」。它和上面两处共享同一条前提——循环体是内联子图，所以引用可能藏在任意嵌套深度。
 */

/** One referenced flow, reduced to what running it needs. */
export type FlowGraph = {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** The inner flow's own seed variables, used as defaults under the caller's bag. */
  variables: Record<string, string>;
};

/** Nodes that run another flow. Subflow nodes reference flows; a loop's *body*
 *  may itself contain subflow nodes, so reference-walking must descend into loop
 *  bodies (handled by `collectFlowReferencingNodes`). */
export type FlowReferencingNode = Extract<FlowNode, { type: "subflow" }>;

export function isFlowReferencingNode(node: FlowNode): node is FlowReferencingNode {
  return node.type === "subflow";
}

/** 所有引用流程的节点，含循环体内嵌套的。循环体是内联子图，所以这里要递归。 */
function collectFlowReferencingNodes(nodes: FlowNode[], into: FlowReferencingNode[] = []): FlowReferencingNode[] {
  for (const node of nodes) {
    if (node.type === "subflow") into.push(node);
    else if (node.type === "loop") collectFlowReferencingNodes(node.body?.nodes ?? [], into);
  }
  return into;
}

/** 节点上可以指向别处的那几个 id。写死成联合类型是因为它要拼进 jsonpath——值走参数，
    键必须是代码自己写下的字面量（规范 4.4：请求里的值永远不能拼进语句）。 */
export type FlowNodeRefKey = "flowId" | "dataSourceId" | "sqlDefinitionId" | "sourceCaseId";

/**
 * 「这张图里任意深度存在 `key == value`」的判定条件。
 *
 * 抽出来是因为两个调用方要用**同一条**谓词：`flowsReferencing` 只要 id/name，
 * 同步用例到流程还要把 `nodes` 一起读回来。两处各写一遍 jsonpath，迟早会出现「扫描说
 * 有引用、同步说没找到节点」这种自相矛盾。
 */
function referencePredicate(key: FlowNodeRefKey, valueParam: number, pathParam: number) {
  return {
    path: `$.** ? (@.${key} == $value)`,
    clause: `jsonb_path_exists(nodes, $${pathParam}::jsonpath, jsonb_build_object('value', $${valueParam}::text))`,
  };
}

/**
 * 引用了某个 id 的流程（删除前的 usage 扫描用）。
 *
 * **必须递归**：循环体是内联子图（`LoopFlowNode.body.nodes`），所以一个子流程节点、
 * 数据库节点完全可以躺在循环里。用 `nodes @> '[{"flowId": "…"}]'` 只看得见顶层数组的
 * 元素——循环体里的引用会被漏掉，于是「没人引用」这个结论是错的，删完那条被引用的流程
 * 之后，外层流程要到入队时才报「references a flow that does not exist」。
 * `$.**` 是递归通配，一层查询覆盖任意嵌套深度；值经 `vars` 绑定，不进路径文本。
 */
export async function flowsReferencing(projectId: string, key: FlowNodeRefKey, value: string, excludeFlowId?: string) {
  const predicate = referencePredicate(key, 3, 2);
  const params: unknown[] = [projectId, predicate.path, value];
  let exclude = "";
  if (excludeFlowId) { params.push(excludeFlowId); exclude = ` AND id <> $${params.length}`; }
  const result = await pool.query(
    `SELECT id, name FROM flows
      WHERE project_id = $1
        AND ${predicate.clause}${exclude}
      ORDER BY name`,
    params,
  );
  return result.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
}

/**
 * 同上，但把整张图读回来。
 *
 * 「这个用例绑到了哪些流程、绑在哪个节点上」需要节点本身（节点名、节点 id），而
 * 「同步」还要把它们改写回去。走同一条谓词，所以清单与改写看到的是同一批流程。
 */
export async function flowGraphsReferencing(projectId: string, key: FlowNodeRefKey, value: string) {
  const predicate = referencePredicate(key, 3, 2);
  const result = await pool.query(
    `SELECT * FROM flows
      WHERE project_id = $1 AND ${predicate.clause}
      ORDER BY name`,
    [projectId, predicate.path, value],
  );
  return result.rows.map(mapFlow);
}

async function loadFlow(projectId: string, flowId: string): Promise<Flow | undefined> {
  const result = await pool.query("SELECT * FROM flows WHERE id = $1 AND project_id = $2", [flowId, projectId]);
  return result.rowCount ? mapFlow(result.rows[0]) : undefined;
}

/** 够表达「主流程 + 几层可复用子流程」，又不至于让一次入队冻出几 MB 的 run_spec。 */
const MAX_TOTAL_NESTED_NODES = 200;

/**
 * Why these nodes cannot be run, or `undefined`.
 *
 * `chain` is the flow ids already entered, root first. A referenced flow already
 * in the chain is recursion — including the direct case of a flow referencing
 * itself — and is refused by name rather than by id, because "流程 A 通过 B 又回到
 * A" is the sentence that lets someone fix it.
 *
 * `budget` caps the **total** node count across the whole nesting tree. Depth
 * alone does not bound size: three levels of 50-node flows fanned out by several
 * referencing nodes each would freeze thousands of nodes into one `run_spec` row.
 */
export async function checkFlowReferences(
  projectId: string,
  nodes: FlowNode[],
  chain: { id: string; name: string }[],
  budget = { remaining: MAX_TOTAL_NESTED_NODES },
): Promise<string | undefined> {
  const references = collectFlowReferencingNodes(nodes);
  if (!references.length) return undefined;
  /* Depth is counted in *entered* flows: the root is 0, so a node inside it may
     enter level 1. Checked before loading, so an over-deep chain is reported as
     depth rather than as whatever the next flow happens to contain. */
  if (chain.length >= MAX_FLOW_DEPTH) {
    return `"${references[0].name}" would nest flows more than ${MAX_FLOW_DEPTH} levels deep`;
  }

  /* 同一个流程被菱形引用两次只读一次：既省往返，也避免同一份定义被反复展开。 */
  const seen = new Map<string, Flow>();
  for (const node of references) {
    const inner = seen.get(node.flowId) ?? await loadFlow(projectId, node.flowId);
    if (!inner) return `"${node.name}" references a flow that does not exist in this project`;
    seen.set(node.flowId, inner);
    const revisited = chain.find((entry) => entry.id === inner.id);
    if (revisited) {
      const path = [...chain.map((entry) => entry.name), inner.name].join(" → ");
      return `"${node.name}" would run flows in a circle: ${path}`;
    }
    if (!inner.nodes.length) return `"${node.name}" references "${inner.name}", which has no steps to run`;
    budget.remaining -= inner.nodes.length;
    if (budget.remaining < 0) {
      return `"${node.name}" would nest more than ${MAX_TOTAL_NESTED_NODES} steps in total; split the flow`;
    }
    const deeper = await checkFlowReferences(projectId, inner.nodes, [...chain, { id: inner.id, name: inner.name }], budget);
    if (deeper) return deeper;
  }
  return undefined;
}

/**
 * Loads the graph a referencing node runs, with its scripts already inlined.
 *
 * Returns the inner flow's current definition; the caller (`prepareFlowNodes`)
 * freezes it into `run_spec`, and recurses to resolve nesting. The cycle and
 * depth checks are repeated here rather than trusted from save time: a flow can
 * be edited into a cycle *after* another flow started referencing it, and the
 * enqueue path must refuse that instead of recursing forever.
 */
export async function loadFlowBody(
  projectId: string,
  node: FlowReferencingNode,
  chain: { id: string; name: string }[],
): Promise<FlowGraph> {
  if (chain.length >= MAX_FLOW_DEPTH) throw new Error(`"${node.name}" would nest flows more than ${MAX_FLOW_DEPTH} levels deep`);
  const inner = await loadFlow(projectId, node.flowId);
  if (!inner) throw new Error(`"${node.name}" references a flow that does not exist in this project`);
  if (chain.some((entry) => entry.id === inner.id)) {
    throw new Error(`"${node.name}" would run flows in a circle: ${[...chain.map((entry) => entry.name), inner.name].join(" → ")}`);
  }
  if (!inner.nodes.length) throw new Error(`"${node.name}" references "${inner.name}", which has no steps to run`);
  return {
    id: inner.id,
    name: inner.name,
    nodes: await inlineFlowNodeScripts(projectId, inner.nodes),
    edges: inner.edges,
    variables: inner.variables,
  };
}
