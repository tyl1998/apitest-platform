import type { FlowEdge, FlowNode, LoopFlowNode } from "../api";

/**
 * 循环容器的画布几何与文档读写（P2-6 修订）。
 *
 * 循环是画布上的**大框**：它是一个 React Flow 父节点，被它框住的步骤是真正的画布
 * 子节点（`parentId` 指向循环），因此可以拖进拖出、双击打开各自的抽屉。文档结构仍是
 * 一棵树——循环体存在 `loop.body`，不在顶层 `steps` 里——所以这里集中放「树 ↔ 画布」
 * 的转换，避免这套坐标换算散落在组件里。
 *
 * 坐标约定与 React Flow 一致：顶层节点的 `position` 是绝对坐标，子节点的 `position`
 * 相对父节点左上角。故意**不用** `extent: "parent"`——那会把子节点锁在框内，也就再也
 * 拖不出来了；进出由拖拽结束时的命中判定完成（见 `loopAt`）。
 */

export type XY = { x: number; y: number };

/** 一个步骤及它所在的循环（顶层为 undefined）。 */
export type Located = { node: FlowNode; loopId?: string };

/** 普通步骤卡的画布宽度（与 design-system.css 的 .flow-node 宽度一致）。 */
const NODE_W = 240;
const GAP = 16;
const PAD = 16;
/** 容器标题区高度：子节点从它下方开始摆放，不遮住循环自己的名字与按钮。 */
export const LOOP_HEADER = 76;

/**
 * 一张卡在画布上占多高。
 *
 * 按类型给足余量而不是取一个统一值：条件节点底部多一行「满足/不满足」分支出口，
 * 请求与 SQL 节点可能多一行提取/断言标记。估矮了会让卡片溢出到循环框外面——尤其
 * 条件节点的分支行会掉到框底外侧，看起来像两个分支挤在同一条线上。
 */
function nodeHeight(node: FlowNode): number {
  if (node.type === "condition") return 148;
  if (node.type === "request" || node.type === "database") {
    const marks = (node.extracts?.length ?? 0) > 0 || (node.assertions?.length ?? 0) > 0;
    return marks ? 132 : 108;
  }
  return 108;
}

const LOOP_MIN_W = NODE_W * 2 + PAD * 3;
const LOOP_MIN_H = LOOP_HEADER + 148 + PAD * 2;

/**
 * 展平成画布节点顺序：每个循环紧跟它的体内步骤。
 *
 * 父节点必须排在子节点之前，这是 React Flow 的要求；顺序错了子节点会渲染不出来。
 */
export function flattenSteps(steps: FlowNode[]): Located[] {
  const out: Located[] = [];
  for (const node of steps) {
    out.push({ node });
    if (node.type === "loop") {
      for (const inner of node.body?.nodes ?? []) out.push({ node: inner, loopId: node.id });
    }
  }
  return out;
}

export function findStep(steps: FlowNode[], id: string): Located | undefined {
  return flattenSteps(steps).find((item) => item.node.id === id);
}

/** 就地替换一个步骤，顶层与循环体内都能命中。 */
export function updateStep(steps: FlowNode[], id: string, next: FlowNode): FlowNode[] {
  return steps.map((node) => {
    if (node.id === id) return next;
    if (node.type !== "loop") return node;
    const body = node.body?.nodes ?? [];
    if (!body.some((inner) => inner.id === id)) return node;
    return { ...node, body: { ...node.body, nodes: body.map((inner) => (inner.id === id ? next : inner)) } };
  });
}

/** 删除一个步骤，并清掉所有指向它的连线（顶层与循环体内）。 */
export function removeStep(steps: FlowNode[], id: string): FlowNode[] {
  return steps
    .filter((node) => node.id !== id)
    .map((node) => {
      if (node.type !== "loop") return node;
      const body = node.body?.nodes ?? [];
      if (!body.some((inner) => inner.id === id)) return node;
      return {
        ...node,
        body: {
          nodes: body.filter((inner) => inner.id !== id),
          edges: (node.body?.edges ?? []).filter((edge) => edge.source !== id && edge.target !== id),
        },
      };
    });
}

/** 新步骤落到顶层，或落进某个循环（自动摆在框内空位上）。 */
export function addStep(steps: FlowNode[], step: FlowNode, loopId?: string): FlowNode[] {
  if (!loopId) return [...steps, step];
  return steps.map((node) => {
    if (node.id !== loopId || node.type !== "loop") return node;
    const body = node.body?.nodes ?? [];
    /* 摞在最后一张卡下面：按每张卡的实际高度累加，条件节点比请求卡高。 */
    const stackedY = body.reduce((y, inner) => Math.max(y, (inner.position?.y ?? 0) + nodeHeight(inner) + GAP), LOOP_HEADER + PAD);
    return {
      ...node,
      body: {
        edges: node.body?.edges ?? [],
        nodes: [...body, { ...step, position: { x: PAD, y: stackedY } }],
      },
    };
  });
}

/**
 * 把一个步骤移进某个循环、或移出到顶层。
 *
 * 跨越边界的连线会被丢掉而不是保留：一条从框外指向框内某步的边没有可执行语义
 * （框内每次迭代都要跑一遍，框外只跑一次），留着它只会让人以为它有效。
 */
export function reparentStep(steps: FlowNode[], id: string, toLoopId: string | undefined, position: XY): FlowNode[] {
  const located = findStep(steps, id);
  if (!located || located.loopId === toLoopId) return steps;
  const moved: FlowNode = { ...located.node, position };

  /* 先摘出来（连带清掉它两端的连线），再放进目标位置。 */
  const without = removeStep(steps, id);
  const cleaned = without.map((node) => node);
  return addStepAt(cleaned, moved, toLoopId);
}

function addStepAt(steps: FlowNode[], step: FlowNode, loopId?: string): FlowNode[] {
  if (!loopId) return [...steps, step];
  return steps.map((node) => {
    if (node.id !== loopId || node.type !== "loop") return node;
    return { ...node, body: { edges: node.body?.edges ?? [], nodes: [...(node.body?.nodes ?? []), step] } };
  });
}

/** 画布位置写回文档：顶层存绝对坐标，循环体内存相对坐标。 */
export function foldPositions(steps: FlowNode[], positions: Map<string, XY>): FlowNode[] {
  return steps.map((node) => {
    const position = positions.get(node.id) ?? node.position;
    if (node.type !== "loop") return { ...node, position };
    return {
      ...node,
      position,
      body: {
        edges: node.body?.edges ?? [],
        nodes: (node.body?.nodes ?? []).map((inner) => ({ ...inner, position: positions.get(inner.id) ?? inner.position })),
      },
    };
  });
}

/** 画布要显示的所有连线：顶层的加上每个循环体内的。 */
export function collectEdges(steps: FlowNode[], topEdges: FlowEdge[]): FlowEdge[] {
  const inner = steps.flatMap((node) => (node.type === "loop" ? node.body?.edges ?? [] : []));
  return [...topEdges, ...inner];
}

/**
 * 把画布上的连线分派回它该待的地方。
 *
 * 两端都在同一个循环里 → 那个循环的 body.edges；两端都在顶层 → 顶层 edges；
 * 一端在框内一端在框外 → 丢弃（`onConnect` 已经拒绝，这里是保存前的兜底）。
 */
export function splitEdges(steps: FlowNode[], edges: FlowEdge[]): { top: FlowEdge[]; steps: FlowNode[] } {
  const scope = new Map(flattenSteps(steps).map((item) => [item.node.id, item.loopId]));
  const top: FlowEdge[] = [];
  const byLoop = new Map<string, FlowEdge[]>();
  for (const edge of edges) {
    const from = scope.get(edge.source);
    const to = scope.get(edge.target);
    if (from === undefined && to === undefined) { top.push(edge); continue; }
    if (from && from === to) { byLoop.set(from, [...(byLoop.get(from) ?? []), edge]); continue; }
    /* 跨界：丢弃。 */
  }
  return {
    top,
    steps: steps.map((node) => (node.type === "loop" ? { ...node, body: { nodes: node.body?.nodes ?? [], edges: byLoop.get(node.id) ?? [] } } : node)),
  };
}

/**
 * 容器尺寸。
 *
 * 取「用户调过的尺寸」与「包住体内所有步骤所需尺寸」的较大值，下限是能并排放下两张
 * 卡——默认只够一张卡时，想把条件的两个分支并排就会因为第二张卡的中心落在框外而被
 * 判定为移出循环。用户拉大过的框不会被自动缩回去。
 */
export function loopSize(loop: LoopFlowNode): { width: number; height: number } {
  let width = Math.max(LOOP_MIN_W, loop.size?.width ?? 0);
  let height = Math.max(LOOP_MIN_H, loop.size?.height ?? 0);
  for (const inner of loop.body?.nodes ?? []) {
    width = Math.max(width, (inner.position?.x ?? 0) + NODE_W + PAD);
    height = Math.max(height, (inner.position?.y ?? 0) + nodeHeight(inner) + PAD);
  }
  return { width, height };
}

/** 最小可用框：拉小到放不下内容时用它兜住。 */
export const LOOP_MIN_SIZE = { width: LOOP_MIN_W, height: LOOP_MIN_H };

/**
 * 拖拽落点命中的循环，或 undefined（落在框外）。
 *
 * 用节点中心判定而不是左上角：把卡片拖到框边缘时，按中心判断与肉眼看到的
 * 「它在框里吗」一致。循环不能拖进循环——画布上只做一层容器，嵌套容器的视觉与
 * 坐标换算成本远高于它的价值。
 */
export function loopAt(steps: FlowNode[], center: XY, draggedId: string): string | undefined {
  for (const node of steps) {
    if (node.type !== "loop" || node.id === draggedId) continue;
    const { width, height } = loopSize(node);
    const x = node.position?.x ?? 0;
    const y = node.position?.y ?? 0;
    if (center.x >= x && center.x <= x + width && center.y >= y && center.y <= y + height) return node.id;
  }
  return undefined;
}

/** 子节点在框内的合法落点：不压住标题区，也不越出左上边界。 */
export function clampInsideLoop(position: XY): XY {
  return { x: Math.max(PAD, position.x), y: Math.max(LOOP_HEADER + PAD, position.y) };
}
