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
