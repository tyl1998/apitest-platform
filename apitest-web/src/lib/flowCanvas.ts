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
/** 顶层链的起始横坐标（与 addNode / restackTopLevel 同一支左缘）。 */
const DEFAULT_X = 80;
/** 顶层竖链的纵向间距（2026-10-21）：比容器内间距（GAP）更紧——顶层是一条直线
 *  链，卡与卡之间只需看清连线，8px 足够；10 步因此比原来少 80px。 */
const ROW_GAP = 8;
/** 循环体内的纵向间距（2026-10-21）：与顶层同口径收紧——框内一条竖链同样只需
 *  看清连线；框的高度由 loopSize 按包围盒算，间距变小后框也跟着变矮。 */
const LOOP_GAP = 8;
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
    const stackedY = body.reduce((y, inner) => Math.max(y, (inner.position?.y ?? 0) + nodeHeight(inner) + LOOP_GAP), LOOP_HEADER + PAD);
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

/**
 * 列表模式的「移入循环」（5.0.13，2026-08-30 升级自动接线）：画布靠把卡片拖进框，
 * 列表靠菜单/拖到循环行中段——两者最终都落到同一棵树上，位置排在框内最后一张卡下面。
 *
 * 只挪卡片不接线，列表里看不出「没连上」，保存又会被未连线校验拦下，所以两头的线
 * 都自动接好：
 * 1. **原位置合拢**：P→X→S 变回 P→S（沿用 P 那条边的分支标签）；X 是头/尾则链自然缩短。
 * 2. **体内接入**：X 接在体内所有「无出边的叶子」后面——简单链就是接在最后一步后面；
 *    并行分支则成为公共尾巴（每次迭代所有路径走完才轮到它）。
 *
 * X 原位置有多条入边/出线时合拢没有唯一答案，退回画布行为（只清线不接，跨界线本来
 * 就没有可执行语义）。循环本身不能移入循环：画布上只做一层容器。
 */
export function moveStepIntoLoop(steps: FlowNode[], allEdges: FlowEdge[], id: string, loopId: string): { steps: FlowNode[]; edges: FlowEdge[] } | undefined {
  const located = findStep(steps, id);
  const loop = steps.find((node): node is LoopFlowNode => node.id === loopId && node.type === "loop");
  if (!located || !loop || located.loopId === loopId || located.node.type === "loop") return undefined;
  const flat = allEdges.filter((edge) => edge.source !== id && edge.target !== id);
  const added: FlowEdge[] = [];
  const push = (source: string, target: string, on?: FlowEdge["on"]) => {
    if (flat.some((edge) => edge.source === source && edge.target === target)) return;
    if (added.some((edge) => edge.source === source && edge.target === target)) return;
    added.push({ id: `${source}->${target}`, source, target, ...(on ? { on } : {}) });
  };
  /* 1. 原位置合拢（X 的连线全在它原作用域里，跨界线不存在）。 */
  const inEdges = allEdges.filter((edge) => edge.target === id);
  const outEdges = allEdges.filter((edge) => edge.source === id);
  if (inEdges.length <= 1 && outEdges.length <= 1 && inEdges[0] && outEdges[0]) push(inEdges[0].source, outEdges[0].target, inEdges[0].on);
  /* 2. 接到体内叶子后面。 */
  const body = loop.body?.nodes ?? [];
  const bodyIds = new Set(body.map((node) => node.id));
  const hasOut = new Set(flat.filter((edge) => bodyIds.has(edge.source)).map((edge) => edge.source));
  for (const leaf of body) {
    if (!hasOut.has(leaf.id)) push(leaf.id, id, leaf.type === "condition" ? "true" : undefined);
  }
  return { steps: addStep(removeStep(steps, id), located.node, loopId), edges: [...flat, ...added] };
}

/**
 * 列表模式的「移出循环」（菜单路径）：体内缺口合拢，X 放回顶层末尾并接在所有顶层
 * 叶子之后。拖拽路径走 `moveStepOutAt`（可以指定落点），这里是它的「追加到末尾」版。
 */
export function moveStepOutOfLoop(steps: FlowNode[], allEdges: FlowEdge[], id: string): { steps: FlowNode[]; edges: FlowEdge[] } | undefined {
  const located = findStep(steps, id);
  if (!located?.loopId) return undefined;
  const flat = allEdges.filter((edge) => edge.source !== id && edge.target !== id);
  const added: FlowEdge[] = [];
  const push = (source: string, target: string, on?: FlowEdge["on"]) => {
    if (flat.some((edge) => edge.source === source && edge.target === target)) return;
    if (added.some((edge) => edge.source === source && edge.target === target)) return;
    added.push({ id: `${source}->${target}`, source, target, ...(on ? { on } : {}) });
  };
  /* 1. 体内缺口合拢。 */
  const inEdges = allEdges.filter((edge) => edge.target === id);
  const outEdges = allEdges.filter((edge) => edge.source === id);
  if (inEdges.length <= 1 && outEdges.length <= 1 && inEdges[0] && outEdges[0]) push(inEdges[0].source, outEdges[0].target, inEdges[0].on);
  /* 2. 接在顶层所有叶子后面（简单链 = 最后一步；并行分支 = 公共尾巴）。 */
  const hasOut = new Set(flat.filter((edge) => steps.some((node) => node.id === edge.source)).map((edge) => edge.source));
  for (const leaf of steps) {
    if (!hasOut.has(leaf.id)) push(leaf.id, id, leaf.type === "condition" ? "true" : undefined);
  }
  /* 位置：顶层最下方（循环按框的实际尺寸占位，不压框）。 */
  const bottom = steps.reduce((y, node) => Math.max(y, (node.position?.y ?? 0) + (node.type === "loop" ? loopSize(node).height : nodeHeight(node)) + GAP), 60);
  return { steps: reparentStep(steps, id, undefined, { x: 80, y: bottom }), edges: [...flat, ...added] };
}

/**
 * 列表模式的拖动排序（5.0.13 增补）：把一个步骤挪到同作用域的新位置。
 *
 * 列表「顺序即语义」，而顺序由连线决定（计划按拓扑分层）——所以换位置不是挪坐标，
 * 而是**改连线**：像链表 splice 一样，把 X 的入边/出边改接到新邻居，缺口的两侧直接
 * 接上。顶层画布坐标一个不动（顺序已由新连线决定，不靠坐标 tie-break）；循环体例外：
 * 体内没有服务端计划、显示顺序本来就按坐标排，所以坐标要按新顺序重排（见
 * `restackLoopBody`），否则列表根本不会动。
 *
 * 拒绝（返回 undefined）：X 在该作用域里有多条入边或多条出线（分支源头 / 汇聚点 /
 * 并行扇出）——这种节点的「位置」没有单一答案，偷偷改线等于改语义，应回画布调整。
 * 跨作用域（顶层 ↔ 循环体）也无效：换框走「移入/移出循环」。
 *
 * 返回**全量**连线列表（其他作用域的边原样保留）与新序列，调用方直接整体替换。
 */
export function reorderStepEdges(scopeNodes: FlowNode[], allEdges: FlowEdge[], id: string, targetId: string, before: boolean): { edges: FlowEdge[]; sequence: FlowNode[] } | undefined {
  const inScope = new Set(scopeNodes.map((node) => node.id));
  if (id === targetId || !inScope.has(id) || !inScope.has(targetId)) return undefined;
  const dragged = scopeNodes.find((node) => node.id === id);
  if (!dragged) return undefined;
  const scopeEdges = allEdges.filter((edge) => inScope.has(edge.source) && inScope.has(edge.target));
  const inEdges = scopeEdges.filter((edge) => edge.target === id);
  const outEdges = scopeEdges.filter((edge) => edge.source === id);
  if (inEdges.length > 1 || outEdges.length > 1) return undefined;

  /* 新序列：拔出 X，插到目标行前/后；新邻居 L 与 R 决定要接的两条边。 */
  const without = scopeNodes.filter((node) => node.id !== id);
  const at = without.findIndex((node) => node.id === targetId);
  if (at === -1) return undefined;
  const insertAt = before ? at : at + 1;
  const sequence = [...without.slice(0, insertAt), dragged, ...without.slice(insertAt)];
  const left = insertAt > 0 ? without[insertAt - 1] : undefined;
  const right = without[insertAt] ?? undefined;

  const pred = inEdges[0];
  const succ = outEdges[0];
  /* 插入点原本若有 L→R 的桥接边，X 现在顶替 R 在 L 分支里的位置：删桥、沿用它的分支标签。 */
  const bridge = left && right ? scopeEdges.find((edge) => edge.source === left.id && edge.target === right.id) : undefined;

  /*
   * 分支边界守卫（「拖动后执行顺序变乱」的根因修复）。
   *
   * splice 假定列表段是一条链，条件分支不是：X 换了挂点、或顶替了另一条分支的后继，
   * 都会静默改「走哪条路」——分支归属一变，执行顺序就乱了。这里一律拒绝并让用户回
   * 画布改连线；唯一的例外是 X 仍挂在原来的条件出口下面（只是挪个位置），标签原样带走。
   */
  const staysWithPred = left !== undefined && pred !== undefined && pred.source === left.id;
  /* 贴身换位（X 挪到自己原后继的正后方）永远安全：X 仍在原路径下游，分支归属不变。 */
  const pastSuccessor = left !== undefined && succ !== undefined && left.id === succ.target;
  if (pred?.on && !staysWithPred && !pastSuccessor) return undefined;
  if (!staysWithPred && !pastSuccessor && (left?.type === "condition" || bridge?.on)) return undefined;
  if (staysWithPred && bridge?.on && bridge.on !== pred?.on) return undefined;

  const removedIds = new Set([...inEdges, ...outEdges].map((edge) => edge.id));
  if (bridge) removedIds.add(bridge.id);
  const kept = allEdges.filter((edge) => !removedIds.has(edge.id));
  const added: FlowEdge[] = [];
  const push = (source: string, target: string, on?: FlowEdge["on"]) => {
    /* 同一对节点只留一条边：P→S 若本来就有，别再压一条同 id 的重复边。 */
    if (kept.some((edge) => edge.source === source && edge.target === target)) return;
    if (added.some((edge) => edge.source === source && edge.target === target)) return;
    added.push({ id: `${source}->${target}`, source, target, ...(on ? { on } : {}) });
  };

  /* 1. 合拢 X 留下的缺口：P 直接接 S，沿用 P 那条边的分支标签。X 若被放回原位
        （仍在 P 与 S 之间），缺口由 X 自己填上，不能再压一条 P→S 的捷径边。 */
  if (pred && succ && !(left?.id === pred.source && right?.id === succ.target)) push(pred.source, succ.target, pred.on);
  /* 2. 接进新位置：L→X 的分支标签按「X 顶替了谁」取——插入点原有 L→R 桥接边就用
        它的标签；X 原本就挂在 L 上（拖回原位的净空操作）就沿用自己那条；都没有而 L
        是条件节点时按「满足」接。X→R 沿用 X 自己原来的出边标签。 */
  if (left) {
    const onLeft = bridge?.on ?? (pred && pred.source === left.id ? pred.on : undefined) ?? (left.type === "condition" ? "true" : undefined);
    push(left.id, id, onLeft);
  }
  if (right) push(id, right.id, succ?.on ?? (dragged.type === "condition" ? "true" : undefined));

  return { edges: [...kept, ...added], sequence };
}

/**
 * 列表排序后把循环体坐标按新顺序重排：体内的显示顺序按画布位置算、没有服务端计划，
 * 只改连线行不会动——坐标跟新序列对齐后，列表与画布（框内自上而下）才一起生效。
 * 摞放规则与 `addStep` 一致：x 贴左缘、y 按各卡实际高度累加，不压住标题区。
 */
export function restackLoopBody(steps: FlowNode[], loopId: string, sequence: FlowNode[]): FlowNode[] {
  return steps.map((node) => {
    if (node.id !== loopId || node.type !== "loop") return node;
    let y = LOOP_HEADER + PAD;
    const nodes = sequence.map((step) => {
      const placed = { ...step, position: { x: PAD, y } };
      y += nodeHeight(step) + LOOP_GAP;
      return placed;
    });
    return { ...node, body: { ...node.body, nodes } };
  });
}

/**
 * 列表排序后把顶层坐标按新序列摞成竖链（5.0.13 增补，修订「顶层坐标不动」）。
 *
 * 只改连线不动坐标时，切回画布会看到「连线是新的、位置是旧的」：边从下面的节点绕回
 * 上面，线对不上卡片。顶层顺序既然由新连线决定，坐标就按新序列自上而下摞放（x=80、
 * y 按各节点实际高度累加，与 addNode 同一起点与间距），画布与列表从此一一对应。
 * 循环体坐标不动——它跟着所在的循环行整体挪。
 */
export function restackTopLevel(steps: FlowNode[], sequence: FlowNode[]): FlowNode[] {
  const y = new Map<string, number>();
  let cursor = 60;
  for (const node of sequence) {
    y.set(node.id, cursor);
    /* 循环占的高度是框的实际尺寸（框住体内步骤的最小包围盒），否则下一个节点会压在框上。 */
    cursor += (node.type === "loop" ? loopSize(node).height : nodeHeight(node)) + ROW_GAP;
  }
  return steps.map((node) => (y.has(node.id) ? { ...node, position: { x: 80, y: y.get(node.id)! } } : node));
}

/**
 * 列表模式：把体内步骤拖到顶层的某个位置（移出循环 + 接进顶层链，一次完成）。
 *
 * 先摘出（体内连线一并清掉——跨界边没有可执行语义），X 以无连线状态进入顶层，再复用
 * `reorderStepEdges` 的 splice 接到目标行的前/后（分支守卫同样生效：落点在条件出口上
 * 就拒绝）。返回新文档（顶层坐标已按新序列摞好）与全量连线。
 */
export function moveStepOutAt(steps: FlowNode[], allEdges: FlowEdge[], node: FlowNode, topSequence: FlowNode[], targetId: string, before: boolean): { steps: FlowNode[]; edges: FlowEdge[] } | undefined {
  const located = findStep(steps, node.id);
  if (!located?.loopId || located.node.type === "loop") return undefined;
  let flat = allEdges.filter((edge) => edge.source !== node.id && edge.target !== node.id);
  /* X 离开的体内缺口同样要合拢（P→X→S 变回 P→S，沿用 P 的分支标签）——否则体内
     链断开、后继悬空，保存会被未连线校验拦下。多入多出没有唯一答案，退回只清线。 */
  const inEdges = allEdges.filter((edge) => edge.target === node.id);
  const outEdges = allEdges.filter((edge) => edge.source === node.id);
  if (inEdges.length <= 1 && outEdges.length <= 1 && inEdges[0] && outEdges[0]
    && !flat.some((edge) => edge.source === inEdges[0].source && edge.target === outEdges[0].target)) {
    flat = [...flat, { id: `${inEdges[0].source}->${outEdges[0].target}`, source: inEdges[0].source, target: outEdges[0].target, ...(inEdges[0].on ? { on: inEdges[0].on } : {}) }];
  }
  const spliced = reorderStepEdges([...topSequence, node], flat, node.id, targetId, before);
  if (!spliced) return undefined;
  const restacked = restackTopLevel([...removeStep(steps, node.id), node], spliced.sequence);
  return { steps: restacked, edges: spliced.edges };
}

/** 循环体不在服务端计划内：按画布位置排（上→下、左→右），与计划的同层 tie-break 同一约定。 */
export function byPosition(nodes: FlowNode[]): FlowNode[] {
  return [...nodes].sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0));
}

/**
 * 「在整个条件后加一步」的接线方案（5.0.13，2026-08-30）。
 *
 * 执行器里无标签边 = 来源成功即激活（`edgeActivates`），与分支标签 true/false 互补，
 * 三种情况各有唯一正确的接法：
 * 1. **分支已汇合**（两分支都能到达同一节点）：在最早的汇合点后插入（joinId）——
 *    它已经「等」过两条分支，接在它后面就是「整个 if 之后」。
 * 2. **分支没汇合**：新步骤接到**所有分支尾巴**上（每条路径走完才轮到它）；没接线的
 *    分支由条件本身按该分支标签引出（该结果发生时立即执行新步骤）。
 * 3. **一个分支都没接**：条件 → 新步骤的**无标签边**——条件步骤成功即激活，两种结果
 *    都会执行，正是「整个条件后」。
 */
export function afterConditionTarget(scopeNodes: FlowNode[], allEdges: FlowEdge[], scopeOrder: string[], conditionId: string): { joinId?: string; anchors: { id: string; on?: FlowEdge["on"] }[] } | undefined {
  const condition = scopeNodes.find((node) => node.id === conditionId && node.type === "condition");
  if (!condition) return undefined;
  const ids = new Set(scopeNodes.map((node) => node.id));
  const scopeEdges = allEdges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const out = (id: string) => scopeEdges.filter((edge) => edge.source === id);
  const labeled = out(conditionId).filter((edge) => edge.on === "true" || edge.on === "false");
  if (!labeled.length) return { anchors: [{ id: conditionId }] };

  const reach = (heads: string[]) => {
    const seen = new Set<string>();
    const queue = [...heads];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const edge of out(id)) queue.push(edge.target);
    }
    return seen;
  };
  const trueReach = reach(labeled.filter((edge) => edge.on === "true").map((edge) => edge.target));
  const falseReach = reach(labeled.filter((edge) => edge.on === "false").map((edge) => edge.target));
  const joins = [...trueReach].filter((id) => falseReach.has(id));
  if (joins.length) {
    /* 显示顺序里最早的汇合点（通常是唯一的那个）。 */
    return { joinId: scopeOrder.find((id) => joins.includes(id)) ?? joins[0], anchors: [] };
  }
  const anchors: { id: string; on?: FlowEdge["on"] }[] = [];
  for (const id of ids) {
    if (id === conditionId || (!trueReach.has(id) && !falseReach.has(id))) continue;
    /* 分支尾巴：可达且无出边——每条路径的终点。 */
    if (out(id).length === 0) anchors.push({ id });
  }
  if (!labeled.some((edge) => edge.on === "true")) anchors.push({ id: conditionId, on: "true" });
  if (!labeled.some((edge) => edge.on === "false")) anchors.push({ id: conditionId, on: "false" });
  return { anchors };
}

/**
 * 未连线的步骤（保存拦截用）：每个作用域里超过一个节点时，没有任何连线（既无入也无出）
 * 的节点就是游离的——它进不了任何执行批次。单个节点的作用域没有连线可言，不算未链接。
 */
export function unlinkedSteps(steps: FlowNode[], topEdges: FlowEdge[]): FlowNode[] {
  const connected = new Set<string>();
  for (const edge of topEdges) { connected.add(edge.source); connected.add(edge.target); }
  const out: FlowNode[] = [];
  if (steps.length > 1) for (const node of steps) if (!connected.has(node.id)) out.push(node);
  for (const node of steps) {
    if (node.type !== "loop") continue;
    const body = node.body?.nodes ?? [];
    if (body.length <= 1) continue;
    const inner = new Set<string>();
    for (const edge of node.body?.edges ?? []) { inner.add(edge.source); inner.add(edge.target); }
    for (const step of body) if (!inner.has(step.id)) out.push(step);
  }
  return out;
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
  /* 框紧贴内容（2026-10-21「循环内的线没有变短」的根因之一）：此前不存 size 时也
     按 `max(保存尺寸, 内容包围盒 + PAD)` 叠，旧版本按 16px 间距算出的包围盒被画进
     库里，卡片间距收紧后框仍拖着空白，出口离下一个节点就更远。现在没被显式拉过
     （没有 size）的框一律按**当前**内容包围盒 + PAD 算，卡片收紧它跟着变矮；用户
     拉过的框仍尊重那个尺寸（见上方注释：拉大过的不自动缩回）。 */
  if (loop.size?.width && loop.size?.height) {
    const boxed = loop.body?.nodes ?? [];
    const right = boxed.reduce((value, inner) => Math.max(value, (inner.position?.x ?? 0) + NODE_W), 0);
    const bottom = boxed.reduce((value, inner) => Math.max(value, (inner.position?.y ?? 0) + nodeHeight(inner)), 0);
    return {
      width: Math.max(LOOP_MIN_W, loop.size.width, right + PAD),
      height: Math.max(LOOP_MIN_H, loop.size.height, bottom + PAD),
    };
  }
  let width = LOOP_MIN_W;
  let height = LOOP_MIN_H;
  for (const inner of loop.body?.nodes ?? []) {
    width = Math.max(width, (inner.position?.x ?? 0) + NODE_W + PAD);
    height = Math.max(height, (inner.position?.y ?? 0) + nodeHeight(inner) + PAD);
  }
  return { width, height };
}

/** 最小可用框：拉小到放不下内容时用它兜住。 */
export const LOOP_MIN_SIZE = { width: LOOP_MIN_W, height: LOOP_MIN_H };

/**
 * 画布上一张卡的占位（含循环框的实际尺寸），供「找个空位」做碰撞检测。
 *
 * 新增步骤的默认落点固定在左上角，节点一多就会盖在别人的卡上——落点好不好，取决于
 * 知不知道现有卡都占着哪块地方。
 */
export function nodeFootprint(node: FlowNode): { width: number; height: number } {
  if (node.type === "loop") return loopSize(node);
  return { width: NODE_W, height: nodeHeight(node) };
}

/**
 * 从 start 出发往下找一个不压住任何现有卡的空位。
 *
 * 沿 y 每行让一格（150px，一张卡加间距的高度），直到与所有占位都不相交；让一百格
 * 还找不到就原样返回（理论不可能——画布无限高）。新卡高度按 120 估：各类型 108–148，
 * 估小半格只影响紧凑度，不影响「不盖住别人」。
 */
export function findFreePosition(start: XY, occupied: { x: number; y: number; width: number; height: number }[]): XY {
  const intersects = (p: XY) => occupied.some((rect) =>
    p.x < rect.x + rect.width && p.x + NODE_W > rect.x && p.y < rect.y + rect.height && p.y + 120 > rect.y);
  let position = { ...start };
  for (let i = 0; i < 100 && intersects(position); i += 1) position = { ...position, y: position.y + 150 };
  return position;
}

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

/* ────────────────────────────────────────────────────────────────────────────
 * 连线长度（2026-10-21「线太长」反馈的第二处）：条件分叉的横向绕行、循环体内
 * 默认间距。两件都是纯几何，读文档算，不依赖画布状态。
 * ──────────────────────────────────────────────────────────────────────── */

/** 条件分叉的侧向错位：真相往下、假象往右各错半张卡——两条出线一眼分得开，
 *  也不会叠在一条竖线上互相盖住。 */
const BRANCH_OFFSET = NODE_W / 2 + 8;
/** 循环体内右移这一条分支时用的横向间距（一张卡 + 一条连线通道）。 */
const BRANCH_PITCH = NODE_W + GAP * 2;

/** 作用域内某节点的出边（顶层或某个循环体，取决于节点在树里的位置）。 */
function scopedEdges(steps: FlowNode[], id: string): FlowEdge[] {
  for (const node of steps) {
    if (node.type !== "loop") continue;
    if ((node.body?.edges ?? []).some((edge) => edge.source === id || edge.target === id)) return node.body?.edges ?? [];
  }
  return [];
}

/** 一条链上最深的位置（跨循环框：框像「行」一样占一整段，取框内最深 + 1）。 */
function depthOf(steps: FlowNode[], start: string, edges: FlowEdge[], seen = new Set<string>()): number {
  let best = 0;
  for (const edge of edges) {
    if (edge.source !== start || seen.has(edge.target)) continue;
    seen.add(edge.target);
    if (!findStep(steps, edge.target)) continue;
    best = Math.max(best, 1 + depthOf(steps, edge.target, edges, seen));
  }
  return best;
}

/**
 * 条件节点两条出线的落点：谁能往下走。
 *
 * 条件卡下面有「真 / 假」两个出口，两条线最后汇到同一张卡时，那条**本应比另一条
 * 更短**的分支不该被挤在别人后面。规则只有一条、不猜业务语义：**更深的那条分支
 * 保持 DEFAULT_X 直下**（它后面步骤多，直下最省长度），另一条横向让开——它的终点
 * 若与直下那条在同一条竖线上，就往右让到一条不重叠的列（让多少看直下分支的深度，
 * 以及 x 方向上已经排着谁）。两条深度相同（典型是并行两路在下一张卡汇合）时保真
 * 让假，与条件的阅读顺序一致。
 *
 * 只看**条件出口**，不看拖拽：用户手摆的位置永远优先，这里只在新增/插入节点时
 * 调一次。返回 undefined 表示这个节点不是分叉点，调用方按普通落点处理。
 */
export function conditionBranchShift(
  steps: FlowNode[],
  allEdges: FlowEdge[],
  conditionId: string,
  branch: "true" | "false",
): { x: number; y: number } | undefined {
  const condition = findStep(steps, conditionId);
  if (!condition || condition.node.type !== "condition") return undefined;
  const edges = scopedEdges(steps, conditionId);
  const outgoing = edges.filter((edge) => edge.source === conditionId);
  if (!outgoing.length) return undefined;
  /* 两条分支各自的走势深度：只沿本分支的出边数节点（分叉点自己的出边仍参与，
     所以汇合点会被两条都数到——这是对的，汇合之后的路不计入比较）。 */
  const branchEdges = (keep: "true" | "false") => edges.filter((edge) =>
    edge.source !== conditionId || (edge.on ?? "true") === keep);
  const trueDepth = depthOf(steps, conditionId, branchEdges("true"));
  const falseDepth = depthOf(steps, conditionId, branchEdges("false"));
  /* 直下的是更深的那条；一样深就保真（阅读顺序在上）。 */
  const straight: "true" | "false" = falseDepth > trueDepth ? "false" : "true";
  const baseX = condition.node.position?.x ?? DEFAULT_X;
  const baseY = condition.node.position?.y ?? 0;
  const straightOffset = (straight === "true" ? -BRANCH_OFFSET : BRANCH_OFFSET);
  const detourOffset = (straight === "true" ? BRANCH_OFFSET : -BRANCH_OFFSET);
  if (branch === straight) return { x: baseX + straightOffset, y: baseY + nodeHeight(condition.node) + ROW_GAP };

  /* 让开的那条：先按半个卡位错开（与直下一左一右，两条出线一眼分得开），再逐列
     右移，直到不落在任何已有卡的竖线附近——同一条竖线上还排着别人时，线会穿过
     它们。只在同一作用域里找（循环体内看体内，顶层看顶层）。 */
  const parentLoop = condition.loopId ? steps.find((node): node is LoopFlowNode => node.id === condition.loopId && node.type === "loop") : undefined;
  const sameScope: FlowNode[] = parentLoop ? parentLoop.body?.nodes ?? [] : steps.filter((node) => node.type !== "loop");
  const occupied = sameScope.map((node) => node.position?.x ?? DEFAULT_X);
  const collides = (candidate: number) => occupied.some((x) => Math.abs(x - candidate) < NODE_W + GAP);
  let x = baseX + detourOffset;
  let guard = 0;
  while (collides(x) && guard < 20) { x += BRANCH_PITCH; guard += 1; }
  return { x, y: baseY + nodeHeight(condition.node) + ROW_GAP };
}
