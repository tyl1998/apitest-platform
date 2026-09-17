import type { PoolClient } from "pg";
import { flowGraphsReferencing } from "./flowRefs.js";
import { adoptScriptRefs } from "./scripts.js";
import type { FlowNode, TestCase } from "../models/types.js";

/**
 * 用例 → 已绑定流程节点的同步（P2-4.5 增补）。
 *
 * 流程请求节点从用例创建时复制了一份完整快照（`RequestFlowNode.sourceCaseId` 只是来源
 * 标记），这条快照隔离规则不变：**改用例永远不会自动改动已存的流程**。但它留下了一件
 * 只能手工做的事——用例修好之后，五条引用它的流程要一个个打开、重新「从用例导入」。
 * 同步就是把这件事显式化：由人选一条流程、点一次按钮，覆盖那几个节点。
 *
 * 覆盖的是**这个节点发什么、校验什么**：请求快照、断言、前置钩子、提取、响应脚本，
 * 以及 `endpointId` 与来源标记。**不覆盖**节点名、画布坐标、失败策略与并发次数——
 * 那些是这张图上的编排决策（节点名是画布上认人的标签，坐标是布局），它们不属于用例。
 */

/** 一个绑定节点。`inLoop` 让界面说清它躺在循环体里——那不是顶层步骤。 */
export type CaseFlowBindingNode = { nodeId: string; nodeName: string; inLoop: boolean };
export type CaseFlowBinding = {
  flowId: string;
  flowName: string;
  updatedAt: string;
  nodes: CaseFlowBindingNode[];
};

/**
 * 一张图里所有 `sourceCaseId` 命中的请求节点，含循环体内的。
 *
 * 必须递归：循环体是内联子图（`LoopFlowNode.body.nodes`），从用例导入的节点完全可以
 * 躺在循环里。只看顶层会让「这个用例绑到了哪几个节点」少报，而同步随后也就漏掉它们。
 */
function collectBoundNodes(nodes: FlowNode[], caseId: string, inLoop = false, into: CaseFlowBindingNode[] = []): CaseFlowBindingNode[] {
  for (const node of nodes) {
    if (node.type === "request" && node.sourceCaseId === caseId) into.push({ nodeId: node.id, nodeName: node.name, inLoop });
    else if (node.type === "loop") collectBoundNodes(node.body?.nodes ?? [], caseId, true, into);
  }
  return into;
}

/** 「这个用例绑到了哪些流程的哪些节点」。 */
export async function caseFlowBindings(projectId: string, caseId: string): Promise<CaseFlowBinding[]> {
  const flows = await flowGraphsReferencing(projectId, "sourceCaseId", caseId);
  return flows
    .map((flow) => ({
      flowId: flow.id,
      flowName: flow.name,
      updatedAt: flow.updatedAt,
      nodes: collectBoundNodes(flow.nodes, caseId),
    }))
    /* 扫描是「图里任意深度存在这个 id」，理论上不会命中零个节点；真出现就不要把一条
       无节点可同步的流程列出来让人点。 */
    .filter((binding) => binding.nodes.length > 0);
}

/** 覆盖用的那一份定义。脚本引用已「接手」过，可以直接存进流程。 */
type CasePayload = Pick<FlowNode & { type: "request" }, "endpointId" | "request" | "assertions" | "extracts" | "preRequestHooks" | "responseScripts"> & {
  sourceCaseId: string;
  sourceCaseName: string;
};

/**
 * 把用例的定义整理成可以写进流程节点的形状。
 *
 * 脚本引用要先 `adoptScriptRefs`：用例的匿名脚本属于那个用例、随它一起删，流程跟随它
 * 会在保存时被拒（「belongs to another case」）。公共脚本保持跟随，匿名脚本复制正文，
 * 与 `flows/node-source` 的导入路径走同一条规则——两条路径给出不同结果就会出现
 * 「导入进来能存、同步过去存不下」。
 */
export async function caseSyncPayload(projectId: string, testCase: TestCase): Promise<CasePayload> {
  return {
    endpointId: testCase.endpointId,
    sourceCaseId: testCase.id,
    sourceCaseName: testCase.name,
    request: testCase.request,
    assertions: await adoptScriptRefs(projectId, testCase.assertions),
    preRequestHooks: await adoptScriptRefs(projectId, testCase.preRequestHooks),
    extracts: testCase.extracts,
    responseScripts: await adoptScriptRefs(projectId, testCase.responseScripts),
  };
}

/**
 * 覆盖指定节点，返回改过的图与真正改到的节点 id。
 *
 * `targetIds` 为 undefined 表示「这条流程里绑着这个用例的全部节点」。返回改到了谁而不是
 * 只回一个布尔：请求里点名的节点可能已经被别人改掉了来源，界面要能说清哪几个没同步到，
 * 而不是报一句成功。
 */
export function applyCaseToFlowNodes(
  nodes: FlowNode[],
  caseId: string,
  targetIds: Set<string> | undefined,
  payload: CasePayload,
  updated: string[] = [],
): { nodes: FlowNode[]; updated: string[] } {
  const next = nodes.map((node): FlowNode => {
    if (node.type === "loop") {
      return { ...node, body: { edges: node.body?.edges ?? [], nodes: applyCaseToFlowNodes(node.body?.nodes ?? [], caseId, targetIds, payload, updated).nodes } };
    }
    if (node.type !== "request" || node.sourceCaseId !== caseId) return node;
    if (targetIds && !targetIds.has(node.id)) return node;
    updated.push(node.id);
    return {
      ...node,
      ...payload,
      /* 编排决策留在图上：节点名是画布上认人的标签，坐标是布局，失败策略与并发次数是
         这条链路怎么跑的决定。用例说的是「发什么、校验什么」，不该顺手改掉这些。 */
      id: node.id, name: node.name, position: node.position, onFailure: node.onFailure, concurrency: node.concurrency,
    };
  });
  return { nodes: next, updated };
}

/**
 * 同步后把图写回去。调用方负责事务与 `persistFlowScripts`。
 *
 * `actorId` **必填**（P11 边界 3 复核）：这个模块的四个导出函数只被 `cases.ts` 的
 * 「同步到流程」路由使用——那是一次人工点击，不是对账。计划 16.0 边界 3 曾把
 * `lib/caseSync.ts` 列为系统路径，复核后更正：这里没有调度/对账入口，写 `updated_by`
 * 才是对的（写 NULL 会让「我点了一次同步」显示成「系统改的」）。必填而不是默认 null：
 * 将来真出现系统调用方，必须显式传 null 说明「这不是人改的」。
 */
export async function writeFlowNodes(client: PoolClient, projectId: string, flowId: string, nodes: FlowNode[], actorId: string | null) {
  await client.query(
    "UPDATE flows SET nodes = $1::jsonb, updated_by = $4, updated_at = now() WHERE id = $2 AND project_id = $3",
    [JSON.stringify(nodes), flowId, projectId, actorId],
  );
}
