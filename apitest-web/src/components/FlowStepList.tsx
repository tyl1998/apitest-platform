import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import { Dropdown, type MenuProps } from "antd";
import { useTranslation } from "react-i18next";
import { ArrowDown, ChevronDown, ChevronRight, MoreHorizontal, Plus, X } from "lucide-react";
import type { DataSource, FlowEdge, FlowNode, FlowSummary, LoopFlowNode } from "../api";
import { byPosition } from "../lib/flowCanvas";
import { KIND_BADGE, NodeKindIcon, stepSubtitle } from "./FlowStepPresentation";
import { Method, type RunStatus } from "../ui";

/**
 * 流程的列表模式（5.0.13）：同一份流程文档在画布之外的第二个投影。
 *
 * 纯投影组件——不持状态、不改文档，所有编辑都通过回调交回 `FlowWorkspace`（也就是
 * 画布所在的那一层），保存 / 运行 / 撤销 / 脏检查因此天然跨模式一致。顺序即语义：
 * 列表不渲染连线本身，顶层按服务端计划的执行顺序排，条件分支用行上的 chip 表达。
 */
export function FlowStepList({ steps, edges, order, stages, nodeStatus, dataSources, projectFlows, active, onActive, onOpen, onDelete, onAddAfter, onAddInside, onAddTop, onMoveIntoLoop, onMoveOut, onMoveOutAt, onAddAfterCondition, onReorder }: {
  /** 流程文档树（顶层节点，循环体存在 loop.body 里）。 */
  steps: FlowNode[];
  /** 画布可见的全部连线（顶层 + 循环体内），已转回 FlowEdge 形状。 */
  edges: FlowEdge[];
  /** 服务端计划的执行顺序与并行批次——列表排序与画布编号的同一来源。 */
  order: string[];
  stages: string[][];
  nodeStatus: Record<string, RunStatus>;
  dataSources: DataSource[];
  projectFlows: FlowSummary[];
  /** 「所选行」（最后点过的行）：列表新增步骤默认接在它后面。 */
  active?: string;
  onActive: (id: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  /** 在某一步后加一步；来源是条件节点时带上走哪个分支。 */
  onAddAfter: (nodeId: string, handleId?: string) => void;
  /** 往某个循环体里加一步。 */
  onAddInside: (loopId: string) => void;
  /** 列表尾「添加步骤」：接在所选行（或最后一行）的后面。 */
  onAddTop: () => void;
  onMoveIntoLoop: (nodeId: string, loopId: string) => void;
  onMoveOut: (nodeId: string) => void;
  /** 把体内步骤拖到顶层某行上：移出循环并 splice 进顶层链（topSequence 是顶层显示顺序）。 */
  onMoveOutAt: (node: FlowNode, topSequence: FlowNode[], targetId: string, before: boolean) => void;
  /** 在整个条件后加一步（分支汇合点后插入 / 接到所有分支尾巴，见 afterConditionTarget）。 */
  onAddAfterCondition: (conditionId: string, loopId?: string) => void;
  /**
   * 拖动排序：在同一作用域内把 id 挪到 targetId 的前/后。
   *
   * `sequence` 是该作用域当前的显示顺序（顶层按计划序、循环体按画布位置序）——顺序的
   * 来源在渲染层，改线需要它来算新邻居，所以由这里传出去而不是让调用方再算一遍。
   */
  onReorder: (loopId: string | undefined, sequence: FlowNode[], id: string, targetId: string, before: boolean) => void;
}) {
  const { t } = useTranslation();

  /*
   * 块的折叠（循环 / 条件，5.0.13）：长列表里大块头收起来看主干。默认展开；折叠只藏
   * 子行，块头行的信息（循环的「N 步」副标题、条件行上的折叠计数 chip）还在。往块里
   * 加步骤（+ / 拖入 / 分支按钮）时自动展开——藏起来的新增会让人以为没加成功。
   * 状态不持久化：折叠是阅读动作，不是文档结构，重开页面恢复全展开。
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const expand = (id: string) => setCollapsed((current) => {
    if (!current.has(id)) return current;
    const next = new Set(current);
    next.delete(id);
    return next;
  });
  const collapseChevron = (id: string, hasChildren: boolean) => !hasChildren ? null : <button
    className="flow-collapse"
    aria-expanded={!collapsed.has(id)}
    title={collapsed.has(id) ? t("flows.listExpand") : t("flows.listCollapse")}
    onClick={(event) => { event.stopPropagation(); toggleCollapse(id); }}
  >
    {collapsed.has(id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
  </button>;

  /* 顶层顺序沿用服务端计划（含并行语义）；计划不可用时退回声明顺序，不在 order 里的
     节点沉底并保持相对顺序——sort 稳定，不会乱跳。 */
  const ordered = useMemo(() => {
    const rank = new Map(order.map((id, index) => [id, index] as const));
    return [...steps].sort((a, b) => (rank.get(a.id) ?? steps.length) - (rank.get(b.id) ?? steps.length));
  }, [steps, order]);

  /* 阶段号（并行批次）与画布同一规则：先看 stages，退回 order 里的序号。 */
  const stageByNode = useMemo(() => {
    const map = new Map<string, number>();
    for (const [index, group] of stages.entries()) for (const id of group) map.set(id, index);
    return map;
  }, [stages]);

  const loops = useMemo(() => steps.filter((step): step is LoopFlowNode => step.type === "loop"), [steps]);

  /*
   * 条件分支的归属（IF 缩进，5.0.13）：一个节点属于条件 C 的某条分支，当且仅当它在
   * 那条分支标签边的下游、不在另一条分支的下游（那是**汇合点**，属于「整个条件之后」，
   * 退回外层）、且它的全部入边都来自 C 或同块节点（共享节点退回外层）。按显示序
   * （拓扑序）处理条件：外层先认领、内层后改写——嵌套 if 因此逐层加深缩进。
   */
  const branchOwnersOf = (scopeNodes: FlowNode[]): Map<string, { conditionId: string; on: "true" | "false" }> => {
    const owners = new Map<string, { conditionId: string; on: "true" | "false" }>();
    const ids = new Set(scopeNodes.map((node) => node.id));
    const out = (id: string) => edges.filter((edge) => edge.source === id && ids.has(edge.target));
    const incoming = (id: string) => edges.filter((edge) => edge.target === id && ids.has(edge.source));
    /* 单条分支的可达集：从该标签的边出发，之后沿全部边向下（穿过嵌套条件的两条分支——
       它们整体仍在这一条分支里）。 */
    const chainReach = (conditionId: string, on: "true" | "false") => {
      const seen = new Set<string>();
      const queue = out(conditionId).filter((edge) => edge.on === on).map((edge) => edge.target);
      while (queue.length) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const edge of out(id)) queue.push(edge.target);
      }
      return seen;
    };
    for (const condition of scopeNodes) {
      if (condition.type !== "condition") continue;
      const trueChain = chainReach(condition.id, "true");
      const falseChain = chainReach(condition.id, "false");
      for (const on of ["true", "false"] as const) {
        const chain = on === "true" ? trueChain : falseChain;
        const other = on === "true" ? falseChain : trueChain;
        const block = new Set<string>();
        let changed = true;
        while (changed) {
          changed = false;
          for (const node of scopeNodes) {
            if (node.id === condition.id || block.has(node.id) || other.has(node.id) || !chain.has(node.id)) continue;
            const edgesIn = incoming(node.id);
            if (!edgesIn.length) continue;
            if (edgesIn.every((edge) => edge.source === condition.id || block.has(edge.source))) {
              block.add(node.id);
              changed = true;
            }
          }
        }
        for (const id of block) owners.set(id, { conditionId: condition.id, on });
      }
    }
    return owners;
  };

  const topOwners = useMemo(() => branchOwnersOf(ordered), [ordered, edges]);

  /**
   * 顶层渲染序列：缩进进条件体的行移出主流，由条件块自己渲染。顺序保持 `ordered`——
   * 条件行出现的位置就是它（连同两条分支链）在流程里的位置。
   */
  const renderSequence = useMemo(() => ordered.filter((node) => !topOwners.has(node.id)), [ordered, topOwners]);

  /*
   * 拖动排序：HTML5 DnD，行本身就是拖拽单位。
   *
   * 同作用域换位：指针在行上半/下半判定插前/插后，accent 插入线表达。跨作用域也对齐
   * 画布「拖进框 / 拖出框」的手感：顶层步骤拖到循环容器行的**中段** = 移入该循环；
   * 体内步骤拖到**任何顶层行** = 移出循环并插在该行的前/后，拖到另一个循环行的中段 =
   * 直接换进那个循环。悬在体内行上一律不放行——往体内指定位置需要「移入 + 体内换位」
   * 两步，与画布上先拖进框再摆位置一致。非法落点不给反馈也不放行。
   */
  const [dragging, setDragging] = useState<{ node: FlowNode; loopId?: string }>();
  const [dropAt, setDropAt] = useState<{ id: string; kind: "before" | "after" | "into" | "out-before" | "out-after" }>();
  const clearDrag = () => { setDragging(undefined); setDropAt(undefined); };

  /**
   * 指针悬在 id 行上时的落点语义。
   *
   * 循环容器行同时是顶层序的一员，有两种落法：边缘 = 插在循环前/后（同层）或移出后
   * 插在循环前/后（跨层），中段 = 移入/换入这个循环（悬在自己所属的循环上则是原地，
   * 不放行）。被拖的若是循环本身则没有「移入」——循环不嵌套循环。
   */
  const dropIntent = (event: DragEvent<HTMLDivElement>, id: string, scope: string | undefined, loopRow: boolean): "before" | "after" | "into" | "out-before" | "out-after" | undefined => {
    if (!dragging || dragging.node.id === id) return undefined;
    const sameScope = dragging.loopId === scope;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    if (sameScope) {
      if (loopRow && dragging.node.type !== "loop") {
        if (y < 0.25) return "before";
        if (y > 0.75) return "after";
        return "into";
      }
      return y < 0.5 ? "before" : "after";
    }
    /* 跨作用域只有「体内 → 顶层行」这一种方向走拖拽；顶层 → 体内请拖到循环行中段。 */
    if (dragging.loopId !== undefined && scope === undefined) {
      if (loopRow && y > 0.25 && y < 0.75) return id === dragging.loopId ? undefined : "into";
      return y < 0.5 ? "out-before" : "out-after";
    }
    return undefined;
  };

  /** 各作用域的显示顺序：drop 时交给调用方做改线（新邻居由它算）。 */
  const sequenceByScope = useMemo(() => {
    const map = new Map<string | undefined, FlowNode[]>();
    map.set(undefined, ordered);
    for (const loop of loops) map.set(loop.id, byPosition(loop.body?.nodes ?? []));
    return map;
  }, [ordered, loops]);

  const dragProps = (node: FlowNode, scope: string | undefined, loopRow = false) => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLDivElement>) => {
      setDragging({ node, loopId: scope });
      event.dataTransfer.effectAllowed = "move";
      /* Firefox 不给非空 data 不启动拖拽。 */
      event.dataTransfer.setData("text/plain", node.id);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      const kind = dropIntent(event, node.id, scope, loopRow);
      if (!kind) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropAt((current) => (current?.id === node.id && current.kind === kind ? current : { id: node.id, kind }));
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      const kind = dropIntent(event, node.id, scope, loopRow);
      if (!kind || !dragging) { clearDrag(); return; }
      event.preventDefault();
      const X = dragging.node;
      if (kind === "into") { expand(node.id); onMoveIntoLoop(X.id, node.id); }
      else if (kind === "out-before" || kind === "out-after") onMoveOutAt(X, ordered, node.id, kind === "out-before");
      else {
        const sequence = sequenceByScope.get(scope);
        if (sequence) onReorder(scope, sequence, X.id, node.id, kind === "before");
      }
      clearDrag();
    },
    onDragEnd: clearDrag,
  });

  const rowDragClass = (id: string) => {
    if (dragging?.node.id === id) return " is-dragging";
    if (dropAt?.id !== id) return "";
    return dropAt.kind === "before" ? " drop-before" : dropAt.kind === "after" ? " drop-after" : " drop-into";
  };

  const stageOf = (id: string) => stageByNode.has(id) ? stageByNode.get(id)! : (order.indexOf(id) === -1 ? undefined : order.indexOf(id));

  /** 移入/移出循环的菜单项：顶层步骤可以移进任何循环，体内步骤可以移出。 */
  const moveMenuItems = (node: FlowNode, loopId?: string): NonNullable<MenuProps["items"]> => {
    const items: NonNullable<MenuProps["items"]> = [];
    /* 循环本身不能移入循环：画布上只做一层容器。 */
    if (!loopId && node.type !== "loop" && loops.length) {
      for (const loop of loops) {
        items.push({ key: `in|${loop.id}`, label: `${t("flows.listMoveIntoLoop")} · ${loop.name || t("flows.loopNode")}` });
      }
    }
    if (loopId) items.push({ key: "out", label: t("flows.listMoveOutOfLoop") });
    return items;
  };

  const onMoveMenuClick = (nodeId: string): NonNullable<MenuProps["onClick"]> => ({ key }) => {
    if (key.startsWith("in|")) onMoveIntoLoop(nodeId, key.slice(3));
    else if (key === "out") onMoveOut(nodeId);
  };

  const stepRow = (node: FlowNode, opts: { loopId?: string; stage?: number; leading?: ReactNode; trailing?: ReactNode }) => {
    const status = nodeStatus[node.id];
    /* 分支语义画布画在连线的标签上，列表里用 chip 表达（连线本身不渲染）。 */
    const branches = edges.filter((edge) => edge.target === node.id && (edge.on === "true" || edge.on === "false"));
    const dataSourceName = node.type === "database" ? dataSources.find((item) => item.id === node.dataSourceId)?.name : undefined;
    /* 当前名字优先于保存时的快照——与画布同一条规则（引用不是快照隔离）。 */
    const bodyName = node.type === "subflow" ? projectFlows.find((flow) => flow.id === node.flowId)?.name : undefined;
    const hasChecks = node.type === "request" || node.type === "database";
    const moveItems = moveMenuItems(node, opts.loopId);
    return <div
      key={node.id}
      className={`flow-row${active === node.id ? " is-active" : ""}${rowDragClass(node.id)}`}
      data-status={status}
      onClick={() => { onActive(node.id); onOpen(node.id); }}
      {...dragProps(node, opts.loopId)}
    >
      {/* 阶段号只在顶层有意义：循环体每次迭代都跑一遍，编号会误导（与画布同规则）。 */}
      {opts.leading}
      <span className="flow-row-index mono">{opts.stage !== undefined ? opts.stage + 1 : ""}</span>
      {node.type === "request"
        ? <Method method={node.request.method} />
        : <span className="flow-node-kind mono"><NodeKindIcon type={node.type} size={12} />{KIND_BADGE[node.type]}</span>}
      <span className="flow-row-name truncate">{node.name || "—"}</span>
      <span className="flow-row-sub mono truncate">{stepSubtitle(node, t, dataSourceName, bodyName)}</span>
      {branches.map((edge) => <span key={edge.id} className="chip mono">{t(edge.on === "true" ? "flows.conditionBranchTrue" : "flows.conditionBranchFalse")}</span>)}
      {hasChecks && (node.extracts.length > 0 || node.assertions.length > 0) && <>
        {node.extracts.length > 0 && <span className="chip mono">→ {node.extracts.map((extract) => extract.name).filter(Boolean).join(", ") || node.extracts.length}</span>}
        {node.assertions.length > 0 && <span className="chip mono">✓ {node.assertions.length}</span>}
      </>}
      {opts.trailing}
      <span className="filter-spacer" />
      {/* 条件行有三个加步骤入口：两条分支（带文字按钮）+「条件后」（整个 if 走完再执行，
          接到汇合点后或所有分支尾巴上——分支按钮只往某一条链上挂）。折叠时新增会先展开。 */}
      {node.type === "condition" ? <>
        <button className="flow-row-add" title={t("flows.listAddAfterTrue")} onClick={(event) => { event.stopPropagation(); expand(node.id); onAddAfter(node.id, "true"); }}><Plus size={12} />{t("flows.conditionBranchTrue")}</button>
        <button className="flow-row-add" title={t("flows.listAddAfterFalse")} onClick={(event) => { event.stopPropagation(); expand(node.id); onAddAfter(node.id, "false"); }}><Plus size={12} />{t("flows.conditionBranchFalse")}</button>
        <button className="flow-row-add" title={t("flows.listAddAfterConditionHint")} onClick={(event) => { event.stopPropagation(); expand(node.id); onAddAfterCondition(node.id, opts.loopId); }}><Plus size={12} />{t("flows.listAddAfterCondition")}</button>
      </> : <button className="flow-row-add" title={t("flows.listAddAfter")} onClick={(event) => { event.stopPropagation(); onAddAfter(node.id); }}><Plus size={12} /></button>}
      {moveItems.length > 0 && <Dropdown menu={{ items: moveItems, onClick: onMoveMenuClick(node.id) }} trigger={["click"]}>
        <button className="flow-row-add" title={t("flows.listMoveMenu")} onClick={(event) => event.stopPropagation()}><MoreHorizontal size={12} /></button>
      </Dropdown>}
      <button className="flow-row-delete" title={t("action.delete")} aria-label={t("action.delete")} onClick={(event) => { event.stopPropagation(); onDelete(node.id); }}><X size={13} /></button>
    </div>;
  };

  /** 条件块：条件行 + 两条分支链缩进（嵌套条件/循环递归渲染，汇合点退回外层）。 */
  const conditionBlock = (condition: FlowNode, loopId: string | undefined, owners: Map<string, { conditionId: string; on: "true" | "false" }>, scopeNodes: FlowNode[]) => {
    const members = scopeNodes.filter((node) => owners.get(node.id)?.conditionId === condition.id);
    const isCollapsed = collapsed.has(condition.id);
    return <div key={condition.id} className="flow-cond-block">
      {stepRow(condition, {
        loopId,
        stage: loopId ? undefined : stageOf(condition.id),
        leading: collapseChevron(condition.id, members.length > 0),
        /* 折叠时行上留一个计数 chip：收起来了也要知道里面有几步。 */
        trailing: isCollapsed && members.length > 0 ? <span className="chip mono">{t("flows.listCollapsedCount", { count: members.length })}</span> : undefined,
      })}
      {!isCollapsed && members.length > 0 && <div className="flow-cond-children">
        {members.map((node) => renderNode(node, loopId, owners, scopeNodes))}
      </div>}
    </div>;
  };

  const loopBlock = (loop: LoopFlowNode, stage?: number) => {
    const body = loop.body?.nodes ?? [];
    const bodyOrdered = byPosition(body);
    const bodyOwners = branchOwnersOf(bodyOrdered);
    const isCollapsed = collapsed.has(loop.id);
    return <div key={loop.id} className="flow-loop-block">
      <div
        className={`flow-row flow-row-loop${active === loop.id ? " is-active" : ""}${rowDragClass(loop.id)}`}
        data-status={nodeStatus[loop.id]}
        onClick={() => { onActive(loop.id); onOpen(loop.id); }}
        {...dragProps(loop, undefined, true)}
      >
        {collapseChevron(loop.id, body.length > 0)}
        <span className="flow-row-index mono">{stage !== undefined ? stage + 1 : ""}</span>
        <span className="flow-node-kind mono"><NodeKindIcon type="loop" size={12} />{KIND_BADGE.loop}</span>
        <span className="flow-row-name truncate">{loop.name || t("flows.loopNode")}</span>
        <span className="flow-row-sub mono truncate">{stepSubtitle(loop, t)}</span>
        <span className="filter-spacer" />
        {/* 与画布框等价：+ 往框里加一步；箭头在循环后接一步（画布上框底也有出口圆点）。 */}
        <button className="flow-row-add" title={t("flows.loopAddStep")} onClick={(event) => { event.stopPropagation(); expand(loop.id); onAddInside(loop.id); }}><Plus size={12} /></button>
        <button className="flow-row-add" title={t("flows.listAddAfter")} onClick={(event) => { event.stopPropagation(); onAddAfter(loop.id); }}><ArrowDown size={12} /></button>
        <button className="flow-row-delete" title={t("action.delete")} aria-label={t("action.delete")} onClick={(event) => { event.stopPropagation(); onDelete(loop.id); }}><X size={13} /></button>
      </div>
      {/* 缩进竖线表达「这些步骤在循环体内」；顺序按画布位置（上→下、左→右）。体内的
          条件同样以块缩进——IF 的形状不分内外层。 */}
      {!isCollapsed && <div className="flow-loop-children">
        {body.length
          ? bodyOrdered.filter((node) => !bodyOwners.has(node.id)).map((node) => renderNode(node, loop.id, bodyOwners, bodyOrdered))
          : <p className="flow-loop-child-empty">{t("flows.listLoopEmpty")}</p>}
      </div>}
      {/* 尾部落点条：循环是最后一行时「循环后」没有下一行的上半区可落，这块透明的覆盖
          条（含与下一行之间的间隙）补上——顶层步骤落下 = 插到循环后，体内步骤落下 =
          移出并插到循环后。平时不可见、不占布局高度。 */}
      <div
        className={`flow-loop-tail${dropAt?.id === `${loop.id}#tail` ? " is-active" : ""}`}
        onDragOver={(event) => {
          /* 除被拖的循环自身外都接：顶层换位（含其他循环）与「体内 → 顶层」移出。 */
          if (!dragging || dragging.node.id === loop.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropAt((current) => (current?.id === `${loop.id}#tail` ? current : { id: `${loop.id}#tail`, kind: "after" }));
        }}
        onDrop={(event) => {
          if (!dragging || dragging.node.id === loop.id) { clearDrag(); return; }
          event.preventDefault();
          if (dragging.loopId !== undefined) onMoveOutAt(dragging.node, ordered, loop.id, false);
          else onReorder(undefined, ordered, dragging.node.id, loop.id, false);
          clearDrag();
        }}
      />
    </div>;
  };

  /** 作用域内一行的渲染入口：循环画块（仅顶层）、条件画块（带缩进分支）、其余画行。 */
  const renderNode = (node: FlowNode, loopId: string | undefined, owners: Map<string, { conditionId: string; on: "true" | "false" }>, scopeNodes: FlowNode[]) => {
    if (node.type === "loop") return loopBlock(node, stageOf(node.id));
    if (node.type === "condition") return conditionBlock(node, loopId, owners, scopeNodes);
    return stepRow(node, { loopId, stage: loopId ? undefined : stageOf(node.id) });
  };

  return <div className="flow-list">
    {renderSequence.map((node) => renderNode(node, undefined, topOwners, ordered))}
    <button className="flow-list-add" onClick={onAddTop}><Plus size={14} />{t("flows.addNode")}</button>
  </div>;
}
