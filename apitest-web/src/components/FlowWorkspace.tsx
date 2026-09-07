import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Background, Controls, Handle, NodeResizer, Position, ReactFlow, ReactFlowProvider, SelectionMode, addEdge, useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Braces, Database, GitBranch, Globe2, Hand, LayoutList, MousePointer2, Play, Plus, Redo2, Repeat, Save, Square, Timer, Undo2, Workflow, X } from "lucide-react";
import { api, noRunnerLabel, type DataSource, type Flow, type FlowEdge, type FlowExecution, type FlowExecutionDetail, type FlowNode, type FlowStepResult, type FlowSummary, type Paged } from "../api";
import { addStep as addStepToTree, afterConditionTarget, clampInsideLoop, collectEdges, findStep as findStepIn, findFreePosition, flattenSteps, foldPositions, loopAt, loopSize, moveStepIntoLoop, moveStepOutOfLoop, moveStepOutAt, nodeFootprint, reorderStepEdges, removeStep as removeStepDeep, reparentStep, restackLoopBody, restackTopLevel, splitEdges, unlinkedSteps, updateStep as updateStepDeep, LOOP_MIN_SIZE } from "../lib/flowCanvas";
import { useExecutionStream } from "../hooks/useExecutionStream";
import { useCanWrite } from "../hooks/useMyRole";
import { variableOptions } from "../lib/flowVariables";
import { useNavGuardStore } from "../stores/navGuardStore";
import { useProjectStore } from "../stores/projectStore";
import { Empty, Method, toRunStatus, type RunStatus } from "../ui";
import { DEFAULT_SCRIPT_NODE_TEMPLATE, FlowNodeDrawer } from "./FlowNodeDrawer";
import { FlowRunDrawer } from "./FlowRunDrawer";
import { FlowStepList } from "./FlowStepList";
import { KIND_BADGE, NodeKindIcon, stepSubtitle } from "./FlowStepPresentation";
import { HistorySidebar } from "./HistorySidebar";
import { IconButton } from "./IconButton";
import { KeyValueEditor, fromPairs, toPairs, type Pair } from "./KeyValueEditor";
import { RunStatusTag } from "./RunStatusTag";
import { SidebarPager, SIDEBAR_PAGE_SIZES } from "./SidebarPager";
import { VariablePicker } from "./VariablePicker";

const SAVE_KEY = navigator.platform.toLowerCase().includes("mac") ? "⌘S" : "Ctrl+S";

/** What the canvas renders per node, beyond the flow document itself. */
type StepData = {
  node: FlowNode;
  dataSourceName?: string;
  /** Referenced flow name for a subflow / loop node, resolved for display. */
  bodyName?: string;
  index?: number;
  status?: RunStatus;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  /** 循环容器专用：往这个框里加一步。 */
  onAddInside?: (loopId: string) => void;
  /** 循环容器专用：框被拉伸后记下尺寸。 */
  onResize?: (loopId: string, size: { width: number; height: number }) => void;
  /** 点出口圆点：在这一步下面加一步（条件节点带上真/假分支）。 */
  onAddAfter?: (nodeId: string, handleId?: string) => void;
};
type StepEdgeData = { flowEdge: FlowEdge };

/**
 * 出口圆点上「点击」与「拖拽」的分界（像素）。
 *
 * React Flow 从 mousedown 起就在做一次连线交互，所以点击与拖拽只能靠位移区分。取 6px
 * 而不是 0：按下到松开之间鼠标总会抖一两个像素，阈值为 0 会把点击误判成拖拽。
 */
const ADD_STEP_DRAG_THRESHOLD = 6;

/**
 * 出口圆点。
 *
 * 点一下 = 在这一步下面加一步；按住拖到别的步骤 = 连线。
 *
 * 判定自己做，不用 React Flow 的 `onConnectStart/onConnectEnd`：`connectOnClick`
 * 默认开启时，圆点上的单击会被它当成「点击连线」的第一步进入待连接状态，`onConnectEnd`
 * 根本不触发，于是「点圆点加一步」永远没反应。这里在圆点自身的 pointer 事件上比较
 * 按下与松开的位移——没移动就是点击，移动了就交回给 React Flow 的连线流程。
 */
function SourceHandle({ nodeId, handleId, style, onAddAfter }: {
  nodeId: string;
  handleId?: string;
  style?: React.CSSProperties;
  onAddAfter?: (nodeId: string, handleId?: string) => void;
}) {
  const downAt = useRef<{ x: number; y: number }>();
  return <Handle
    id={handleId}
    type="source"
    position={Position.Bottom}
    style={style}
    onPointerDown={(event) => { downAt.current = { x: event.clientX, y: event.clientY }; }}
    onPointerUp={(event) => {
      const start = downAt.current;
      downAt.current = undefined;
      if (!start || !onAddAfter) return;
      /* 拖走了：那是一次连线动作（连上或没连上都由 React Flow 收尾），不加节点。 */
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= ADD_STEP_DRAG_THRESHOLD) return;
      onAddAfter(nodeId, handleId);
    }}
  />;
}

/**
 * One step on the canvas.
 *
 * Written by hand rather than themed through xyflow's defaults: its stylesheet
 * ships its own palette, and the Quiet Console contract has exactly one accent
 * plus four reserved status colors. Run state reuses `[data-status]` so a node
 * reads the same way as a row in any list.
 */
function StepNode({ data, selected }: NodeProps<Node<StepData>>) {
  const { t } = useTranslation();
  const { node, dataSourceName, bodyName, index, status, onOpen, onDelete, onAddAfter } = data;
  const hasChecks = node.type === "request" || node.type === "database";

  /* 循环是画布容器：这个节点只画「框 + 标题 + 加步骤」，被它框住的步骤是真正的
     画布子节点（parentId 指向它），由 React Flow 渲染在框内——所以那些步骤可以
     拖进拖出、双击打开各自的抽屉，和顶层步骤没有区别。 */
  if (node.type === "loop") {
    return <LoopContainerNode data={data} selected={selected} />;
  }

  return <div className={`flow-node${selected ? " is-selected" : ""}`} data-status={status} onDoubleClick={() => onOpen(node.id)}>
    <Handle type="target" position={Position.Top} />
    <div className="flow-node-head">
      {index !== undefined && <span className="flow-node-index mono">{index + 1}</span>}
      {node.type === "request"
        ? <Method method={node.request.method} />
        : <span className="flow-node-kind mono"><NodeKindIcon type={node.type} size={12} />{KIND_BADGE[node.type]}</span>}
      <span className="flow-node-name truncate">{node.name || "—"}</span>
      {/* Deleting a step should not require opening it first. `nodrag` keeps the
          click from being swallowed by the canvas pan handler. */}
      <button
        className="flow-node-delete nodrag"
        title={t("action.delete")}
        aria-label={t("action.delete")}
        onClick={(event) => { event.stopPropagation(); onDelete(node.id); }}
      >
        <X size={13} />
      </button>
    </div>
    <div className="flow-node-url mono truncate">{stepSubtitle(node, t, dataSourceName, bodyName)}</div>
    {hasChecks && (node.extracts.length > 0 || node.assertions.length > 0) && <div className="flow-node-meta">
      {node.extracts.length > 0 && <span className="chip mono">→ {node.extracts.map((extract) => extract.name).filter(Boolean).join(", ") || node.extracts.length}</span>}
      {node.assertions.length > 0 && <span className="chip mono">✓ {node.assertions.length}</span>}
    </div>}
    {node.type === "condition" ? <>
      <div className="flow-condition-branches" aria-label={t("flows.conditionBranches")}>
        <span>{t("flows.conditionBranchTrue")}</span>
        <span>{t("flows.conditionBranchFalse")}</span>
      </div>
      <SourceHandle nodeId={node.id} handleId="true" style={{ left: "28%" }} onAddAfter={onAddAfter} />
      <SourceHandle nodeId={node.id} handleId="false" style={{ left: "72%" }} onAddAfter={onAddAfter} />
    </> : <SourceHandle nodeId={node.id} onAddAfter={onAddAfter} />}
  </div>;
}

/**
 * 循环容器节点：画布上的大框。
 *
 * 它只负责框、标题和「往框里加步骤」；框住的步骤是独立的画布子节点，因此拖拽、
 * 双击编辑、单步调试全部与顶层步骤一致——这正是「循环包住已有步骤」该有的手感。
 * 拖一个已有步骤进框即可归入循环（见 FlowCanvas 的 onNodeDragStop）。
 */
function LoopContainerNode({ data, selected }: { data: StepData; selected?: boolean }) {
  const { t } = useTranslation();
  const { node, index, status, onOpen, onDelete, onAddInside, onResize, onAddAfter } = data;
  if (node.type !== "loop") return null;
  const count = node.body?.nodes?.length ?? 0;
  return <div className={`flow-loop${selected ? " is-selected" : ""}`} data-status={status}>
    {/* 框要能拉大：默认框只放得下两张卡，想并排更多步骤就得自己调。 */}
    <NodeResizer
      minWidth={LOOP_MIN_SIZE.width}
      minHeight={LOOP_MIN_SIZE.height}
      isVisible={selected}
      onResizeEnd={(_event, params) => onResize?.(node.id, { width: Math.round(params.width), height: Math.round(params.height) })}
    />
    <Handle type="target" position={Position.Top} />
    <div className="flow-loop-head" onDoubleClick={() => onOpen(node.id)}>
      {index !== undefined && <span className="flow-node-index mono">{index + 1}</span>}
      <span className="flow-node-kind mono"><NodeKindIcon type="loop" size={12} />{KIND_BADGE.loop}</span>
      <span className="flow-node-name truncate">{node.name || t("flows.loopNode")}</span>
      <button
        className="flow-loop-add nodrag"
        title={t("flows.loopAddStep")}
        aria-label={t("flows.loopAddStep")}
        onClick={(event) => { event.stopPropagation(); onAddInside?.(node.id); }}
      >
        <Plus size={13} />
      </button>
      <button
        className="flow-node-delete nodrag"
        title={t("action.delete")}
        aria-label={t("action.delete")}
        onClick={(event) => { event.stopPropagation(); onDelete(node.id); }}
      >
        <X size={13} />
      </button>
    </div>
    <div className="flow-loop-meta mono truncate" onDoubleClick={() => onOpen(node.id)}>{stepSubtitle(node, t)}</div>
    {/* 空框要说清下一步做什么，而不是只显示一个空矩形。 */}
    {!count && <div className="flow-loop-empty">{t("flows.loopDropHint")}</div>}
    <SourceHandle nodeId={node.id} onAddAfter={onAddAfter} />
  </div>;
}

/** React Flow 节点壳：把 NodeProps 拆成容器组件要的形状。 */
function LoopNodeShell({ data, selected }: NodeProps<Node<StepData>>) {
  return <LoopContainerNode data={data} selected={selected} />;
}

const NODE_TYPES = { step: StepNode, loop: LoopNodeShell };

export function FlowWorkspace() {
  return <ReactFlowProvider><FlowCanvas /></ReactFlowProvider>;
}

function FlowCanvas() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projectId, flowId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { environments, endpoints, reloadEndpoints } = useProjectStore();
  const setGuard = useNavGuardStore((state) => state.setGuard);
  /* viewer：加节点/运行/保存不渲染（P6-4）；画布浏览、变量弹窗、历史侧栏照旧。 */
  const canWrite = useCanWrite();

  const [flow, setFlow] = useState<Flow>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StepData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  /** The flow document, kept apart from the canvas nodes that render it. */
  const [steps, setSteps] = useState<FlowNode[]>([]);
  const [baseline, setBaseline] = useState("");
  /** 标签与项目里已用过的标签建议（供「按标签」的套件选择命中这条流程）。 */
  const [tags, setTags] = useState<string[]>([]);
  const [memberTags, setMemberTags] = useState<string[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [stages, setStages] = useState<string[][]>([]);
  const [planError, setPlanError] = useState<string>();
  const [nodeStatus, setNodeStatus] = useState<Record<string, RunStatus>>({});
  const [run, setRun] = useState<FlowExecutionDetail>();
  const [running, setRunning] = useState(false);
  /* 侧栏「运行记录」（5.0.9）：同一流程的执行历史，点某次运行打开整次运行的抽屉。 */
  const [historyOpen, setHistoryOpen] = useState(localStorage.getItem("apitest.flowHistoryOpen") !== "false");
  const [runs, setRuns] = useState<Paged<FlowExecution>>({ items: [], page: 1, pageSize: SIDEBAR_PAGE_SIZES[1], total: 0 });
  const [historyStatus, setHistoryStatus] = useState("all");
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(SIDEBAR_PAGE_SIZES[1]);
  const [inspecting, setInspecting] = useState<FlowExecutionDetail>();
  const [openNode, setOpenNode] = useState<string>();
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [variables, setVariables] = useState<Record<string, string>>({});
  /* Ordered rows for the editor; a new blank row has no key yet and a record
     could not hold it. `variables` stays the value the flow is saved with. */
  const [variablePairs, setVariablePairs] = useState<Pair[]>([]);
  const [environmentId, setEnvironmentId] = useState<string>("none");
  const [name, setName] = useState("");
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  /**
   * 本项目其他流程，供子流程/循环节点引用。
   *
   * 存整份列表而不只是数量：节点上的 `flowName` 是保存时的快照，被引用的流程改名后
   * 画布应该显示当前名字——引用不是快照隔离，改一处所有调用方都该看到。
   */
  const [projectFlows, setProjectFlows] = useState<FlowSummary[]>([]);
  const [nodePickerOpen, setNodePickerOpen] = useState(false);
  /** 打开选择器时的目标循环：非空表示「加到这个框里」。 */
  const [loopTarget, setLoopTarget] = useState<string>();
  /**
   * 框选模式。
   *
   * 画布默认左键拖拽是平移；打开框选后左键拖拽画选择框、中键/右键仍可平移，多选之后
   * 可以整组拖动（React Flow 原生支持，拖动结束由同一个 onNodeDragStop 落库）。
   */
  const [selectMode, setSelectMode] = useState(false);
  /**
   * 显示方式：画布或列表——同一份流程文档的两个投影（5.0.13 列表模式）。
   *
   * 记忆在 localStorage（与运行记录侧栏同一约定）：昨天用列表编辑的人，今天打开还是列表。
   * 框选/多选是画布专属交互，列表模式下其入口隐藏。
   */
  const [viewMode, setViewMode] = useState<"canvas" | "list">(localStorage.getItem("apitest.flowViewMode") === "list" ? "list" : "canvas");

  /**
   * 画布视口中心（画布坐标，含当前平移/缩放）：工具栏新增步骤落在这里——用户正在看
   * 哪里，新卡就出现在哪里，而不是固定左上角让人满画布找。`screenToFlowPosition` 把
   * 画布容器的屏幕几何中心换算成流程坐标；列表模式新增由 FlowStepList 锚定，不走这里。
   */
  const { screenToFlowPosition } = useReactFlow();
  function viewportCenter(): { x: number; y: number } {
    const wrapper = document.querySelector(".flow-canvas .react-flow");
    if (!wrapper) return { x: 460, y: 320 };
    const rect = wrapper.getBoundingClientRect();
    const center = screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    return { x: center.x, y: center.y };
  }

  /** 顶层所有卡的占位矩形（绝对坐标，循环框按实际尺寸）：找空位时用来避让。 */
  function occupiedRects() {
    return stepsRef.current.map((node) => {
      const size = nodeFootprint(node);
      return { x: node.position?.x ?? 0, y: node.position?.y ?? 0, width: size.width, height: size.height };
    });
  }

  /* 循环容器上的「+」：打开同一个节点选择器，但落点是这个循环。 */
  const openLoopPicker = useCallback((loopId: string) => {
    setLoopTarget(loopId);
    setNodePickerOpen(true);
  }, []);

  /* 框被拉伸：尺寸是容器文档的一部分（决定它能框住多少），所以要存进节点。 */
  const resizeLoop = useCallback((loopId: string, size: { width: number; height: number }) => {
    setSteps((current) => current.map((step) => (step.id === loopId && step.type === "loop" ? { ...step, size } : step)));
  }, []);

  /** 点圆点新增时的落点：接在这个节点后面（条件节点还要记住走哪个分支）。 */
  const [insertAfter, setInsertAfter] = useState<{ nodeId: string; handleId?: string; splice?: boolean; anchors?: { id: string; on?: FlowEdge["on"] }[] }>();
  /* 圆点回调必须是稳定引用（否则每次 steps 变化都要重建全部画布节点），所以用 ref 读最新文档。 */
  const stepsRef = useRef<FlowNode[]>([]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  /**
   * 点出口圆点：在这一步下面加一步。
   *
   * 落点与作用域跟着来源节点：框内点出来的留在框内；来源是条件节点时记住点的是哪个
   * 出口，新步骤按真/假分支接上。`splice`（列表模式）：不是在后面并列一步，而是
   * **插进链条里**——断开来源节点原来的后继边，改走「来源 → 新步骤 → 原后继」。
   */
  const addAfterNode = useCallback((nodeId: string, handleId?: string, splice?: boolean) => {
    setInsertAfter({ nodeId, handleId, splice });
    setLoopTarget(findStepIn(stepsRef.current, nodeId)?.loopId);
    setNodePickerOpen(true);
  }, []);

  /**
   * 「在整个条件后加一步」（5.0.13）：分支已汇合 → 插在汇合点后（splice）；没汇合 →
   * 接到所有分支尾巴上（未接线的分支由条件按该分支标签引出）；一个分支都没有 →
   * 条件 → 新步骤的无标签边（条件成功即执行，两种结果都跑）。见 afterConditionTarget。
   */
  const addAfterCondition = useCallback((conditionId: string, loopId?: string) => {
    const locatedLoop = loopId ? findStepIn(stepsRef.current, loopId)?.node : undefined;
    const scopeNodes = loopId && locatedLoop?.type === "loop" ? locatedLoop.body?.nodes ?? [] : stepsRef.current;
    const scopeOrder = loopId ? scopeNodes.map((node) => node.id) : order;
    const target = afterConditionTarget(scopeNodes, toFlowEdges(edges), scopeOrder, conditionId);
    if (!target) return;
    if (target.joinId) { addAfterNode(target.joinId, undefined, true); return; }
    setInsertAfter({ nodeId: conditionId, anchors: target.anchors });
    setLoopTarget(loopId);
    setNodePickerOpen(true);
  }, [edges, order, addAfterNode]);

  const stream = useExecutionStream(projectId);

  useEffect(() => {
    if (!projectId || !flowId) return;
    setLoading(true);
    void (async () => {
      try {
        const loaded = await api.flow(projectId, flowId);
        setFlow(loaded);
        setSteps(loaded.nodes);
        setName(loaded.name);
        setTags(loaded.tags);
        setVariables(loaded.variables);
        setVariablePairs(toPairs(loaded.variables));
        setEnvironmentId(loaded.environmentId ?? "none");
        /* 画布要画的连线是顶层的加上每个循环体内的——框内的连线也在画布上。 */
        setEdges(collectEdges(loaded.nodes, loaded.edges).map((edge) => toCanvasEdge(edge, t)));
        setBaseline(snapshot(loaded.name, loaded.environmentId ?? "none", loaded.nodes, loaded.edges, loaded.variables, loaded.tags));
      } catch { message.error(t("flows.loadFailed")); }
      finally { setLoading(false); }
    })();
  }, [projectId, flowId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!projectId) return;
    void api.dataSources(projectId).then(setDataSources).catch(() => setDataSources([]));
    /* 标签建议服务端 DISTINCT：用例与流程共用一套「用来匹配成员」的标签词汇。 */
    void api.projectTags(projectId, "members").then(setMemberTags).catch(() => setMemberTags([]));
    /* 接口清单来自项目 store，而 store 只在进项目时加载一次——MCP 写工具的带外创建
       不会经过任何前端写路径，进编辑器时列表是旧的，节点选择器就拿 endpointId 匹配
       不到选项。dataSources / 标签都是每次进来现拉，接口清单不该是例外。 */
    void reloadEndpoints();
  }, [projectId, reloadEndpoints]);

  /* 可引用的流程：一条流程不能把自己当子流程。 */
  useEffect(() => {
    if (!projectId || !flowId) return;
    void api.flows(projectId)
      .then((all) => setProjectFlows(all.filter((flow) => flow.id !== flowId)))
      .catch(() => setProjectFlows([]));
  }, [projectId, flowId]);

  const openDrawer = useCallback((id: string) => setOpenNode(id), []);

  /** 删除一个步骤：顶层与循环体内都能命中，连带清掉指向它的连线。 */
  function removeStep(id: string) {
    pushHistory();
    setSteps((current) => removeStepDeep(current, id));
    setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id));
    setOpenNode((current) => (current === id ? undefined : current));
  }

  /*
   * Canvas projection, intentionally narrower than the editable document.
   *
   * Updating a request body/header/variable while the node drawer is open used
   * to recreate every React Flow node on every keystroke. With `{{ss` this
   * happens twice before the completion list even appears; React Flow briefly
   * receives an empty set during layout and the entire canvas flashes away.
   *
   * The canvas only displays method/name/url/extract/assertion counts, so its
   * projection deliberately excludes the large mutable request object. Detail
   * edits stay in `steps` for save/run but no longer tear down canvas nodes.
   */
  const canvasSignature = useMemo(
    () => JSON.stringify(flattenSteps(steps).map(({ node: step, loopId }) => ({
      id: step.id,
      loopId,
      position: step.position,
      name: step.name,
      type: step.type,
      descriptor: nodeDescriptor(step),
      extracts: step.type === "request" || step.type === "database" ? step.extracts.map((extract) => extract.name) : [],
      assertionCount: step.type === "request" || step.type === "database" ? step.assertions.length : 0,
    }))),
    [steps],
  );

  /* The stage a node runs in, shown instead of a sequential index so two
     siblings that run in parallel read as such instead of 2 and 3. */
  const stageByNode = useMemo(() => {
    const map = new Map<string, number>();
    for (const [index, group] of stages.entries()) for (const id of group) map.set(id, index);
    return map;
  }, [stages]);

  useEffect(() => {
    /* 循环是画布上的父节点，被它框住的步骤是真正的子节点（parentId 指向循环），
       所以能拖进拖出、双击各自打开抽屉。父必须排在子之前，这是 React Flow 的要求，
       flattenSteps 已经保证了这个顺序。 */
    startTransition(() => setNodes((previous) => {
      /* 选中状态属于画布、不属于文档：重建时必须带过来，否则每次重新取计划都会把
         刚框选出来的一片清空——看起来就是「框选不起作用」。 */
      const wasSelected = new Map(previous.map((node) => [node.id, node.selected]));
      return flattenSteps(steps).map(({ node: step, loopId }) => ({
        id: step.id,
        type: step.type === "loop" ? "loop" : "step",
        position: step.position,
        selected: wasSelected.get(step.id) ?? false,
        /* 容器要有显式尺寸，否则框不出「包住」的视觉；尺寸由体内步骤的包围盒算出。 */
        ...(step.type === "loop" ? { style: loopSize(step) } : {}),
        ...(loopId ? { parentId: loopId } : {}),
        data: {
          node: step,
          dataSourceName: step.type === "database" ? dataSources.find((item) => item.id === step.dataSourceId)?.name : undefined,
          /* 当前名字优先于保存时的快照：引用不是快照隔离，被引用的流程改名后画布
             应当立刻反映出来。 */
          bodyName: step.type === "subflow" ? projectFlows.find((flow) => flow.id === step.flowId)?.name : undefined,
          /* 阶段号只对顶层节点有意义：循环体每次迭代都跑一遍，编号会误导。 */
          index: loopId ? undefined : (stageByNode.has(step.id) ? stageByNode.get(step.id)! : (order.indexOf(step.id) === -1 ? undefined : order.indexOf(step.id))),
          status: nodeStatus[step.id],
          onOpen: openDrawer,
          onDelete: removeStep,
          onAddInside: step.type === "loop" ? openLoopPicker : undefined,
          onResize: step.type === "loop" ? resizeLoop : undefined,
          onAddAfter: addAfterNode,
        },
      }));
    }));
  }, [canvasSignature, order, stages, stageByNode, nodeStatus, dataSources, projectFlows, setNodes, openDrawer, openLoopPicker, resizeLoop, addAfterNode]);

  /**
   * 画布 → 文档。
   *
   * 两件事必须一起做：位置写回（顶层绝对、循环体内相对），以及连线按作用域分派回
   * 顶层或某个循环的 body。保存、运行、计划、脏检查共用它，否则这几条路径迟早
   * 对不上——它们对「文档现在长什么样」必须给出同一个答案。
   */
  /**
   * 画布 → 文档。
   *
   * **只从 `steps` + `edges` 算，不看 React Flow 的 `nodes`**。位置在拖拽结束时已经
   * 写回 `steps`，所以文档不需要再去读画布状态；早先的版本依赖 `nodes`，而投影
   * `setNodes` 会让 `nodes` 变化 → 依赖它的计划 effect 重新取计划 → `order`/`stages`
   * 换成新数组 → 投影又跑一遍，画布因此一直在闪。
   *
   * 连线仍要按作用域分派回顶层或某个循环的 body。保存、运行、计划、脏检查、历史快照
   * 共用它，避免这几条路径对「文档现在长什么样」给出不同答案。
   */
  const documentNow = useCallback(() => {
    const split = splitEdges(steps, toFlowEdges(edges));
    return { nodes: split.steps, edges: split.top };
  }, [steps, edges]);

  /**
   * 撤销 / 重做。
   *
   * 记的是**文档快照**（名称、环境、步骤树、连线、变量），不是 React Flow 的节点数组：
   * 画布只是文档的投影，存投影会在下一次重建时对不上。快照在每个离散动作**之前**入栈
   * （加/删/连/删连/拖动），抽屉与变量面板则在打开时取基线、关闭时若有变化再入栈——
   * 否则每敲一个字符都会进历史，撤销一次只退一个字母。
   */
  type HistoryEntry = { name: string; environmentId: string; steps: FlowNode[]; edges: FlowEdge[]; variables: Record<string, string> };
  const past = useRef<HistoryEntry[]>([]);
  const future = useRef<HistoryEntry[]>([]);
  /** 只为按钮的可用状态：ref 变了不会触发重渲染。 */
  const [historyDepth, setHistoryDepth] = useState({ past: 0, future: 0 });

  const capture = useCallback((): HistoryEntry => {
    const document = documentNow();
    return { name, environmentId, steps: document.nodes, edges: document.edges, variables };
  }, [documentNow, name, environmentId, variables]);

  const pushEntry = useCallback((entry: HistoryEntry) => {
    /* 同一个事件里可能有两个来源都想入栈（删节点会同时产生删连线），两次拿到的
       都是同一份「删之前」的状态，去重后撤销一次就退回一步，而不是两次。 */
    const serialized = JSON.stringify(entry);
    if (past.current.length && JSON.stringify(past.current[past.current.length - 1]) === serialized) return;
    /* 上限 50：足够回退一段编辑，又不会让一张大流程图把内存吃掉。 */
    past.current = [...past.current.slice(-49), entry];
    future.current = [];
    setHistoryDepth({ past: past.current.length, future: 0 });
  }, []);

  const pushHistory = useCallback(() => pushEntry(capture()), [pushEntry, capture]);

  /**
   * 列表模式的「移入/移出循环」（5.0.13）：与画布拖进框同一套树操作，但**自动接线**
   * ——原位置合拢、体内/顶层接入叶子（见 moveStepIntoLoop / moveStepOutOfLoop），
   * 不接线的话保存会被未连线校验拦下。菜单与拖拽共用这两个入口。
   */
  const moveIntoLoop = useCallback((nodeId: string, loopId: string) => {
    const result = moveStepIntoLoop(stepsRef.current, toFlowEdges(edges), nodeId, loopId);
    if (!result) return;
    pushHistory();
    setSteps(result.steps);
    setEdges(result.edges.map((edge) => toCanvasEdge(edge, t)));
    message.info(t("flows.loopStepMovedIn"));
  }, [edges, pushHistory, setSteps, setEdges, t]);

  const moveOutOfLoop = useCallback((nodeId: string) => {
    const result = moveStepOutOfLoop(stepsRef.current, toFlowEdges(edges), nodeId);
    if (!result) return;
    pushHistory();
    setSteps(result.steps);
    setEdges(result.edges.map((edge) => toCanvasEdge(edge, t)));
    message.info(t("flows.loopStepMovedOut"));
  }, [edges, pushHistory, setSteps, setEdges, t]);

  /**
   * 列表模式：把体内步骤拖到顶层的某个位置（移出 + splice 接进顶层链，一次完成）。
   * 落在条件出口上会被 splice 的分支守卫拒绝——与换位同一条规则。
   */
  const moveOutAt = useCallback((node: FlowNode, topSequence: FlowNode[], targetId: string, before: boolean) => {
    const result = moveStepOutAt(stepsRef.current, toFlowEdges(edges), node, topSequence, targetId, before);
    if (!result) { message.warning(t("flows.listReorderRefused")); return; }
    pushHistory();
    setSteps(result.steps);
    setEdges(result.edges.map((edge) => toCanvasEdge(edge, t)));
    /* 顶层行序乐观更新：X 原本不在顶层 order 里，直接插到目标位置（计划回来会校准）。 */
    setOrder((current) => {
      const next = current.filter((step) => step !== node.id);
      const at = next.indexOf(targetId);
      if (at === -1) return current;
      next.splice(before ? at : at + 1, 0, node.id);
      return next;
    });
  }, [edges, pushHistory, setSteps, setEdges, t]);

  /* 列表模式「所选步骤」：最后点过的行。新增步骤默认接在它后面，没有所选行就接在最后。 */
  const [activeRow, setActiveRow] = useState<string>();
  const addFromList = useCallback(() => {
    const flat = flattenSteps(stepsRef.current);
    const anchor = (activeRow ? flat.find((item) => item.node.id === activeRow) : undefined) ?? flat[flat.length - 1];
    /* 空流程走无锚点新增；锚点是循环行时接在循环后面（splice 语义一致）。 */
    if (anchor) addAfterNode(anchor.node.id, undefined, true);
    else setNodePickerOpen(true);
  }, [activeRow, addAfterNode]);

  /**
   * 列表模式的拖动排序（5.0.13 增补）：换位置 = 改连线（splice），不是挪坐标——
   * 画布布局保持原样，执行顺序由新连线决定。多连线步骤被拒绝时说明原因并指回画布。
   */
  const reorder = useCallback((loopId: string | undefined, sequence: FlowNode[], id: string, targetId: string, before: boolean) => {
    const result = reorderStepEdges(sequence, toFlowEdges(edges), id, targetId, before);
    if (!result) { message.warning(t("flows.listReorderRefused")); return; }
    pushHistory();
    setEdges(result.edges.map((edge) => toCanvasEdge(edge, t)));
    if (loopId) {
      /* 循环体的显示顺序按画布坐标算、没有服务端计划：坐标按新序列重排，行才跟着动；
         画布上框内也变成自上而下按新顺序摞放。 */
      setSteps((current) => restackLoopBody(current, loopId, result.sequence));
    } else {
      /* 顶层坐标同样按新序列摞成竖链：切回画布时连线才对得上卡片，不会出现「线从
         下面绕回上面」。行序先乐观更新，计划回来后内容一致会保持原数组，不会闪。 */
      setSteps((current) => restackTopLevel(current, result.sequence));
      setOrder((current) => {
        const next = current.filter((step) => step !== id);
        const at = next.indexOf(targetId);
        if (at === -1) return current;
        next.splice(before ? at : at + 1, 0, id);
        return next;
      });
    }
  }, [edges, pushHistory, setEdges, setSteps, t]);

  const applyEntry = useCallback((entry: HistoryEntry) => {
    setName(entry.name);
    setEnvironmentId(entry.environmentId);
    setSteps(entry.steps);
    setEdges(collectEdges(entry.steps, entry.edges).map((edge) => toCanvasEdge(edge, t)));
    setVariables(entry.variables);
    setVariablePairs(toPairs(entry.variables));
  }, [setEdges, t]);

  const undo = useCallback(() => {
    const entry = past.current.pop();
    if (!entry) return;
    future.current = [capture(), ...future.current].slice(0, 50);
    applyEntry(entry);
    setHistoryDepth({ past: past.current.length, future: future.current.length });
  }, [capture, applyEntry]);

  const redo = useCallback(() => {
    const entry = future.current.shift();
    if (!entry) return;
    past.current = [...past.current, capture()].slice(-50);
    applyEntry(entry);
    setHistoryDepth({ past: past.current.length, future: future.current.length });
  }, [capture, applyEntry]);

  /**
   * 抽屉与变量面板：一次编辑 = 一次撤销。
   *
   * 基线通过 ref 读取，effect 只依赖「哪个抽屉开着」。若把 `capture` 放进依赖，
   * 每次改动都会让 effect 重挂一次，于是每敲一个字符就入栈一条历史——撤销一次只
   * 退回一个字母，而用户想退的是「我刚才改的那个节点」。
   */
  const captureRef = useRef(capture);
  useEffect(() => { captureRef.current = capture; }, [capture]);

  useEffect(() => {
    if (!openNode) return;
    const before = captureRef.current();
    return () => {
      const after = captureRef.current();
      if (JSON.stringify(before) !== JSON.stringify(after)) pushEntry(before);
    };
  }, [openNode, pushEntry]);

  useEffect(() => {
    if (!variablesOpen) return;
    const before = captureRef.current();
    return () => {
      const after = captureRef.current();
      if (JSON.stringify(before) !== JSON.stringify(after)) pushEntry(before);
    };
  }, [variablesOpen, pushEntry]);

  /**
   * The run order comes from the server (计划 4.0.2).
   *
   * Asked rather than computed here: two implementations of "what runs first"
   * would eventually disagree, and the numbers on the canvas are the ones users
   * would trust.
   */
  useEffect(() => {
    if (!projectId || !steps.length) { setOrder([]); setStages([]); setPlanError(undefined); return; }
    const timer = setTimeout(() => {
      /* 计划只针对顶层图：循环是其中一个节点，它的体内连线不参与顶层拓扑排序。
         传 documentNow() 的结果而不是画布原始 edges，否则体内连线会被当成顶层边、
         指向「不存在的节点」而让计划整条报错。 */
      const document = documentNow();
      void api.flowPlan(projectId, document.nodes, document.edges)
        .then((plan) => {
          /* 内容没变就保持原数组：order/stages 是投影 effect 的依赖，每次都换新数组
             会让画布在每次编辑后多重建一遍。 */
          setOrder((current) => (current.join("|") === plan.order.join("|") ? current : plan.order));
          setStages((current) => (JSON.stringify(current) === JSON.stringify(plan.stages) ? current : plan.stages));
          setPlanError(plan.error);
        })
        .catch(() => { /* the canvas keeps the last order it had */ });
    }, 200);
    return () => clearTimeout(timer);
  }, [projectId, documentNow]);

  const dirty = useMemo(() => {
    if (!flow) return false;
    /* 与保存写出的形状对齐：位置写回 + 连线分派，否则循环体内的连线会让流程
       永远显示「未保存」。 */
    const document = documentNow();
    return snapshot(name, environmentId, document.nodes, document.edges, variables, tags) !== baseline;
  }, [flow, name, environmentId, documentNow, variables, tags, baseline]);

  /**
   * Variables a seed value may reference.
   *
   * Step extracts are filtered out: a seed is read before anything has run, so
   * offering an upstream step's output would offer a value guaranteed to be
   * missing at the moment it is used.
   */
  const seedVariableOptions = useMemo(
    () => variableOptions({
      nodes: steps, edges: toFlowEdges(edges), variables,
      environment: environments.find((item) => item.id === environmentId),
    }).filter((option) => option.origin !== "step"),
    [steps, edges, variables, environments, environmentId],
  );

  /* The sidebar knows nothing about this page, so the prompt is registered here
     — the same arrangement the endpoint workspace uses. */
  useEffect(() => {
    if (!dirty) { setGuard(null); return; }
    setGuard(() => new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: t("editor.discardTitle"), content: t("editor.discardHint"),
        okText: t("editor.discard"), cancelText: t("action.cancel"),
        onOk: () => resolve(true), onCancel: () => resolve(false),
      });
    }));
    return () => setGuard(null);
  }, [dirty, setGuard, t]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!projectId || !flowId || !name.trim()) return;
    const document = documentNow();
    /* 未连线的步骤不允许保存：游离节点进不了任何执行批次，存下去等于埋雷。
       单节点作用域没有连线可言，不算未链接（见 unlinkedSteps）。 */
    const unlinked = unlinkedSteps(document.nodes, document.edges);
    if (unlinked.length) {
      message.error(t("flows.saveUnlinked", { names: unlinked.map((node) => node.name || "—").join("、") }));
      return;
    }
    setSaving(true);
    try {
      const saved = await api.updateFlow(projectId, flowId, {
        name: name.trim(),
        environmentId: environmentId === "none" ? null : environmentId,
        nodes: document.nodes, edges: document.edges, variables, tags,
      });
      setFlow(saved);
      /* Re-seeded from the response: the server hands back script ids the client
         did not have when it built the request. */
      setSteps(saved.nodes);
      setTags(saved.tags);
      setBaseline(snapshot(saved.name, saved.environmentId ?? "none", saved.nodes, saved.edges, saved.variables, saved.tags));
      message.success(t("flows.saved"));
    } catch (error) {
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(detail ?? t("flows.saveFailed"));
    } finally { setSaving(false); }
  }, [projectId, flowId, name, environmentId, documentNow, variables, tags, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") { event.preventDefault(); if (canWrite) void save(); return; }
      if (key !== "z") return;
      /**
       * 输入框和 Monaco 里的 Ctrl+Z 归它们自己。
       *
       * 脚本节点用的是 Monaco，它有自己的编辑历史；把它的撤销抢过来会让人在写脚本时
       * 一按撤销就丢掉整个画布动作，而不是回退刚敲的那行代码。
       */
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], .monaco-editor")) return;
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canWrite, save, undo, redo]);

  function addNode(type: FlowNode["type"], intoLoopId?: string) {
    /**
     * A real UUID, not a timestamp.
     *
     * Node ids identify a step in its execution history, and history outlives
     * the flow document. Two flows created in the same millisecond — or a
     * duplicated flow — would otherwise share ids and mix each other's runs.
     */
    const id = crypto.randomUUID();
    /**
     * 落点：工具栏新增落在**视口中心**（用户正在看的地方，而不是固定左上角）；从出口
     * 圆点新增落在锚点下方一格。两处都走碰撞避让——从落点往下逐格让位，直到不压住
     * 任何现有卡（循环框按实际尺寸占位）。之前的「x=80, y=60+序号×130」在节点多了
     * 以后必然盖住别人的卡，序号还会在删除/撤销后失步。循环体内的新步骤不从这里落：
     * `addStep` 会把它摞到框内最后一张卡的下面，天然不冲突。
     */
    const anchor = insertAfter ? findStepIn(stepsRef.current, insertAfter.nodeId) : undefined;
    const center = viewportCenter();
    const start = anchor
      ? { x: anchor.node.position?.x ?? 80, y: (anchor.node.position?.y ?? 60) + nodeFootprint(anchor.node).height + 24 }
      : { x: center.x - 120, y: center.y - 60 };
    const base = { id, name: "", position: findFreePosition(start, occupiedRects()), onFailure: "stop" as const };
    const step: FlowNode = type === "request" ? {
      ...base, type: "request", endpointId: "",
      request: { method: "GET", url: "", headers: {}, queryParams: {}, pathParams: {}, bodyType: "none", auth: { type: "none" } },
      assertions: [], extracts: [], preRequestHooks: [], responseScripts: [],
    } : type === "database" ? {
      ...base, type: "database", dataSourceId: dataSources[0]?.id ?? "", statementType: "query", sql: "", parameters: {}, assertions: [], extracts: [],
    } : type === "script" ? {
      ...base, type: "script", script: { content: DEFAULT_SCRIPT_NODE_TEMPLATE },
    } : type === "condition" ? {
      ...base, type: "condition", condition: { mode: "all", rules: [{ variable: "", operator: "equals", value: "" }] },
    } : type === "wait" ? {
      /* 1s：一个「等一下让异步落库」的合理起点，而不是 0（0 会被校验拒绝）。 */
      ...base, type: "wait", waitMs: 1000,
    } : type === "subflow" ? {
      ...base, type: "subflow", flowId: "", inputs: {},
    } : {
      /* 循环是画布容器：count/1/串行 + 空 body 是最小配置，保存前必须往框里
         加步骤（校验会拒绝空体）。 */
      ...base, type: "loop", mode: "count", count: 1, indexVariable: "index", concurrency: 1, outputs: undefined, body: { nodes: [], edges: [] },
    };
    /* 循环不嵌套循环：画布上只做一层容器，嵌套容器的坐标换算成本远高于价值。 */
    const target = type === "loop" ? undefined : intoLoopId;
    pushHistory();
    /* 位置已按锚点/视口 + 避让算好，直接落树（体内新增由 addStep 摞底覆盖）。 */
    const placed = step;
    setSteps((current) => addStepToTree(current, placed, anchor ? anchor.loopId : target));
    if (insertAfter && anchor) {
      const branch = anchor.node.type === "condition"
        ? (insertAfter.handleId === "false" ? "false" : "true")
        : undefined;
      setEdges((current) => {
        let base = current;
        /* 「在整个条件后」的多锚点：每个分支尾巴（或未接线分支的条件本身，带分支标签）
           都接一条边到新步骤——它要等每条路径走完才轮到。 */
        if (insertAfter.anchors) {
          for (const anchorPoint of insertAfter.anchors) {
            const edge: FlowEdge = { id: `${anchorPoint.id}->${id}`, source: anchorPoint.id, target: id, ...(anchorPoint.on ? { on: anchorPoint.on } : {}) };
            base = addEdge(toCanvasEdge(edge, t), base);
          }
          return base;
        }
        /* 列表插入 = 接进链里：来源节点原来的后继边（同分支那条）由新步骤顶替，新步骤
           再接它——「在这一步后加一步」就该把后面顺次往后推。画布的出口圆点保持原
           语义（另起一条并行线），不 splice。 */
        if (insertAfter.splice) {
          const taken = current.filter((edge) => edge.source === anchor.node.id
            && (branch
              ? (edge.data as StepEdgeData | undefined)?.flowEdge?.on === branch
              : !(edge.data as StepEdgeData | undefined)?.flowEdge?.on));
          if (taken.length === 1) {
            const successor = taken[0].target;
            const spliced: FlowEdge = { id: `${id}->${successor}`, source: id, target: successor, on: type === "condition" ? "true" : undefined };
            base = [...current.filter((edge) => edge.id !== taken[0].id), toCanvasEdge(spliced, t)];
          }
        }
        const flowEdge: FlowEdge = { id: `${insertAfter.nodeId}->${id}`, source: insertAfter.nodeId, target: id, on: branch };
        return addEdge(toCanvasEdge(flowEdge, t), base);
      });
    }
    setInsertAfter(undefined);
    setNodePickerOpen(false);
    setLoopTarget(undefined);
    setOpenNode(id);
  }

  /** 循环体内步骤与顶层步骤共用一套编辑入口：写回时按树查找。 */
  function updateNode(next: FlowNode) {
    setSteps((current) => updateStepDeep(current, next.id, next));
  }

  /* 侧栏运行记录：新开一次运行或收到终态事件时刷新，让侧栏与实际一致。 */
  useEffect(() => { localStorage.setItem("apitest.flowHistoryOpen", String(historyOpen)); }, [historyOpen]);
  useEffect(() => { localStorage.setItem("apitest.flowViewMode", viewMode); }, [viewMode]);
  const loadHistory = useCallback(() => {
    if (!projectId || !flowId) return;
    void api.flowExecutions(projectId, flowId, {
      status: historyStatus === "all" ? undefined : historyStatus,
      page: historyPage, pageSize: historyPageSize,
    })
      .then(setRuns)
      .catch(() => { /* 侧栏是辅助视图，加载失败不能挡住编辑器。 */ });
  }, [projectId, flowId, historyStatus, historyPage, historyPageSize]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  /** Live per-node and per-flow progress. */
  useEffect(() => {
    stream.onEvent((event) => {
       if (event.kind === "execution" || event.kind === "step") {
         if (!event.flowNodeId || !run || event.flowExecutionId !== run.id) return;
         setNodeStatus((current) => ({ ...current, [event.flowNodeId!]: toRunStatus(event.status) }));
        return;
      }
      if (event.kind !== "flow" || !run || event.flowExecutionId !== run.id) return;
      setRun((current) => (current ? { ...current, status: event.status, successCount: event.successCount, failedCount: event.failedCount, skippedCount: event.skippedCount } : current));
       if (event.status === "queued" || event.status === "running") return;
       setRunning(false);
       /* Re-read once terminal: the stream carries ids and counts only, so the
          step list and the extracted variables arrive with this fetch. */
       void api.flowExecution(projectId!, event.flowExecutionId)
         .then((full) => {
           setRun(full);
            setNodeStatus(runStatuses(full));
         })
         .catch(() => { /* the panel keeps the counts it already has */ });
       /* 终态时同步刷新侧栏，否则执行记录看起来没更新。 */
       loadHistory();
    });
    return () => stream.onEvent(undefined);
  }, [stream, run, projectId, loadHistory]);

  function openRun(runId: string) {
    if (!projectId) return;
    void api.flowExecution(projectId, runId)
      .then(setInspecting)
      .catch(() => message.error(t("reports.loadFailed")));
  }

  async function start() {
    if (!projectId || !flowId) return;
    if (!steps.length) { message.warning(t("flows.needsNode")); return; }
    if (planError) { message.error(planError); return; }
    setRunning(true);
    setNodeStatus({});
    try {
      /* The canvas as it stands runs, saved or not — the same edited-but-unsaved
         rule as a case run. */
      const document = documentNow();
      const queued = await api.executeFlow(projectId, flowId, { nodes: document.nodes, edges: document.edges, variables });
      setRun({ ...queued, steps: [], executionSteps: [] });
      setSearchParams({ run: queued.id }, { replace: true });
      loadHistory();
    } catch (error) {
      /* 分区没有执行器（2004）与队列不可用是两个不同的处置动作：一个去那个网段起 worker，
         一个去修 Redis。按错误码判而不是嗅探文案（P2-8 边界 5）。 */
      const label = noRunnerLabel(error);
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(label !== undefined ? t("run.noRunner", { label })
        : detail?.includes("queue unavailable") ? t("run.queueUnavailable") : t("flows.runFailed"));
      setRunning(false);
    }
  }

  async function stop() {
    if (!projectId || !run) return;
    try { await api.cancelFlowExecution(projectId, run.id); }
    catch { message.error(t("run.cancelFailed")); }
  }

  /* Deep link: ?run=<id> reopens a past run with its per-node verdicts. */
  useEffect(() => {
    const runId = searchParams.get("run");
    if (!projectId || !runId || run?.id === runId) return;
    void api.flowExecution(projectId, runId)
      .then((full) => {
        setRun(full);
         setNodeStatus(runStatuses(full));
      })
      .catch(() => { /* a run from another project or already deleted */ });
  }, [projectId, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <main className="content"><p className="muted">{t("common.loading")}</p></main>;
  if (!flow) return <main className="content"><Empty title={t("flows.missingTitle")} hint={t("flows.missingHint")} action={<button className="btn btn-primary" onClick={() => navigate(`/projects/${projectId}/flows`)}>{t("flows.backToList")}</button>} /></main>;

  const busy = running || run?.status === "queued" || run?.status === "running";
  /** 打开的步骤可能在某个循环框内，所以按树查找而不是只看顶层。 */
  const current = findStepIn(steps, openNode ?? "")?.node;

  return <main className="content flow-content">
    <div className="page-head">
      <div className="page-head-main">
        <div className="title-row">
          <input className="title-input" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("flows.namePlaceholder")} aria-label={t("flows.name")} />
          {dirty && <span className="chip chip-warn">{t("editor.unsavedShortcut", { key: SAVE_KEY })}</span>}
        </div>
        <div className="head-meta">
          <Select
            value={environmentId}
            onChange={setEnvironmentId}
            options={[{ value: "none", label: t("flows.noEnvironment") }, ...environments.map((item) => ({ value: item.id, label: item.name }))]}
            style={{ width: 160 }}
          />
          {/* 标签一直存在库里、列表也一直在显示，却没有编辑入口——于是「按标签选择」
              永远选不到任何流程（P2-4）。建议来自项目里已用过的标签，也允许输入新的。 */}
          <Select
            mode="tags" value={tags} onChange={setTags}
            options={memberTags.map((tag) => ({ value: tag, label: tag }))}
            placeholder={t("flows.tagsPlaceholder")} aria-label={t("flows.tags")}
            style={{ minWidth: 180, maxWidth: 320 }} tokenSeparators={[","]}
          />
          <button className="cell-link mono" onClick={() => setVariablesOpen(true)}>
            {t("flows.variableCount", { count: Object.keys(variables).length })}
          </button>
        </div>
      </div>
      <div className="topbar-actions">
        {/* 显示方式：画布 / 列表——同一份文档的两个投影，未保存状态与撤销栈跨模式共享。 */}
        <div className="mode-switch" role="group" aria-label={t("editor.viewMode")}>
          <button
            className={`icon-btn${viewMode === "canvas" ? " is-active" : ""}`}
            aria-pressed={viewMode === "canvas"}
            title={t("flows.viewCanvas")}
            onClick={() => setViewMode("canvas")}
          ><Workflow size={14} /></button>
          <button
            className={`icon-btn${viewMode === "list" ? " is-active" : ""}`}
            aria-pressed={viewMode === "list"}
            title={t("flows.viewList")}
            onClick={() => setViewMode("list")}
          ><LayoutList size={14} /></button>
        </div>
        {/* 框选是画布专属交互：左键拖拽画选择框、多选整组拖动，列表模式没有这个概念。 */}
        {viewMode === "canvas" && <button
          className={`btn btn-with-icon${selectMode ? " is-active" : ""}`}
          aria-pressed={selectMode}
          title={t("flows.selectModeHint")}
          onClick={() => setSelectMode((current) => !current)}
        >
          {selectMode ? <MousePointer2 size={14} /> : <Hand size={14} />}
          {selectMode ? t("flows.selectMode") : t("flows.panMode")}
        </button>}
          <IconButton icon={<Undo2 size={15} />} label={t("action.undo")} disabled={!historyDepth.past} onClick={undo} />
          <IconButton icon={<Redo2 size={15} />} label={t("action.redo")} disabled={!historyDepth.future} onClick={redo} />
          {/* 列表模式的新增接在所选行后面（画布保持无锚点、自由摆放的原语义）。 */}
          {canWrite && <button className="btn btn-with-icon" onClick={() => (viewMode === "list" ? addFromList() : setNodePickerOpen(true))}><Plus size={14} />{t("flows.addNode")}</button>}
        {canWrite && (busy
          ? <button className="btn btn-with-icon" onClick={() => void stop()}><Square size={14} />{t("run.cancel")}</button>
          : <button className="btn btn-with-icon" disabled={!steps.length} onClick={() => void start()}><Play size={14} />{t("flows.run")}</button>)}
        {canWrite && <button className="btn btn-primary btn-with-icon" disabled={saving || !dirty} onClick={() => void save()}>
          <Save size={14} />{saving ? "…" : t("action.save")}
        </button>}
      </div>
    </div>

    {/* A cycle has no runnable order, so it is reported on the canvas rather
        than at save time, where it would arrive too late to act on. */}
    {planError && <div className="bulk-bar flow-warning"><strong className="text-fail">{planError}</strong></div>}
    {/* 操作提示按视图给：画布讲框选与出口圆点，列表讲拖动换位（不写出来没人会试）。 */}
    {viewMode === "canvas"
      ? <p className="flow-canvas-hint">{t("flows.canvasHint")}</p>
      : <p className="flow-canvas-hint">{t("flows.listHint")}</p>}

    {run && <div className="flow-run-bar">
      <RunStatusTag status={busy ? (run.status === "queued" ? "queued" : "running") : toRunStatus(run.status)} />
      <span className="mono muted">{t("flows.stepSummary", { success: run.successCount, total: run.total })}</span>
      {run.failedCount > 0 && <span className="mono text-fail">{t("flows.failedCount", { count: run.failedCount })}</span>}
      {run.skippedCount > 0 && <span className="mono muted">{t("flows.skippedCount", { count: run.skippedCount })}</span>}
      {run.error && <span className="mono truncate">{run.error}</span>}
      <span className="filter-spacer" />
      {/* The variables a run produced are the evidence that chaining worked. */}
      {Object.keys(run.variables).length > 0 && <span className="mono muted truncate">
        {Object.entries(run.variables).map(([key, value]) => `${key}=${value}`).join("  ")}
      </span>}
    </div>}

    <div className={`flow-body${historyOpen ? "" : " is-solo"}`}>
      {/* 列表模式：同一份文档的第二个投影，纯展示与回调，编辑内核（历史/保存/运行）不变。
          空流程时仍走画布分支的 Empty——空态说什么与用哪种视图无关。 */}
      {viewMode === "list" && steps.length ? <div className="flow-list-wrap">
        <FlowStepList
          steps={steps}
          edges={toFlowEdges(edges)}
          order={order}
          stages={stages}
          nodeStatus={nodeStatus}
          dataSources={dataSources}
          projectFlows={projectFlows}
          active={activeRow}
          onActive={setActiveRow}
          onOpen={openDrawer}
          onDelete={removeStep}
          onAddAfter={(nodeId, handleId) => addAfterNode(nodeId, handleId, true)}
          onAddInside={openLoopPicker}
          onAddTop={addFromList}
          onMoveIntoLoop={moveIntoLoop}
          onMoveOut={moveOutOfLoop}
          onMoveOutAt={moveOutAt}
          onAddAfterCondition={addAfterCondition}
          onReorder={reorder}
        />
      </div> : <div className="flow-canvas">
        {steps.length ? <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={(changes) => {
          /* 删连线也要能撤销；选中/高亮之类的变更不进历史。 */
          if (changes.some((change) => change.type === "remove")) pushHistory();
          onEdgesChange(changes);
        }}
          onConnect={(connection: Connection) => {
          /* The server rejects a duplicated or self-referencing connection, so
             the canvas refuses to draw one rather than letting a save fail. */
          if (!connection.source || !connection.target || connection.source === connection.target) return;
          if (edges.some((edge) => edge.source === connection.source && edge.target === connection.target)) return;
          /* 连线不能跨越循环框：框内每次迭代跑一遍、框外只跑一次，一条跨界的边
             没有可执行语义，画布直接拒绝而不是让保存失败。 */
          const from = findStepIn(steps, connection.source);
          const to = findStepIn(steps, connection.target);
          if (!from || !to || from.loopId !== to.loopId) {
            message.warning(t("flows.loopEdgeCrossing"));
            return;
          }
          const on = from.node.type === "condition"
            ? connection.sourceHandle === "false" ? "false" : "true"
            : undefined;
          const flowEdge: FlowEdge = { id: `${connection.source}->${connection.target}`, source: connection.source, target: connection.target, on };
          /* 入栈放在 setEdges 之外：updater 在 StrictMode 下会被调用两次，把副作用
             写进 updater 会让历史多出一条空记录。 */
          pushHistory();
          setEdges((current) => addEdge(toCanvasEdge(flowEdge, t), current));
        }}
        /* 圆点的「点一下加一步」由 SourceHandle 自己判定：connectOnClick 会把单击
           吞成「点击连线」的第一步，onConnectEnd 根本不触发，所以这里关掉它。 */
        connectOnClick={false}
        onNodeClick={selectMode ? undefined : (event, node) => {
          if ((event.target as HTMLElement | null)?.closest(".react-flow__handle")) return;
          setOpenNode(node.id);
        }}
        /* 框选模式下左键拖拽画选择框、中键与右键仍然平移；关闭时左键回到平移。
           判定用 Partial：框只要碰到卡片就选中，要求完全框住会让人反复重画。 */
        selectionOnDrag={selectMode}
        selectionMode={SelectionMode.Partial}
        panOnDrag={selectMode ? [1, 2] : [0, 1, 2]}
        multiSelectionKeyCode={["Meta", "Control", "Shift"]}
        /**
         * 拖拽结束时决定这一步归谁。
         *
         * 落点中心在某个循环框内 → 归入那个循环（坐标转成相对框的），落在框外 →
         * 回到顶层（坐标转成绝对的）。故意不用 `extent: "parent"` 锁住子节点，否则
         * 拖进去的步骤就再也拖不出来了。
         */
        onNodeDragStop={(_event, dragged, draggedNodes) => {
          /* 多选拖动时 React Flow 给出全部被拖的节点；单个拖动只有 dragged。 */
          const moved = draggedNodes?.length ? draggedNodes : [dragged];
          let next = steps;
          const positions = new Map<string, { x: number; y: number }>();
          let movedIn = 0; let movedOut = 0;
          const detached: string[] = [];
          for (const item of moved) {
            const located = findStepIn(next, item.id);
            if (!located) continue;
            const parent = item.parentId ? next.find((step) => step.id === item.parentId) : undefined;
            const absolute = {
              x: (parent?.position?.x ?? 0) + item.position.x,
              y: (parent?.position?.y ?? 0) + item.position.y,
            };
            const center = { x: absolute.x + 120, y: absolute.y + 48 };
            /* 循环不能拖进循环：画布上只做一层容器。 */
            const target = located.node.type === "loop" ? located.loopId : loopAt(next, center, item.id);
            if (target === located.loopId) {
              /**
               * 位置必须写回文档，不能只留在画布 state 里。
               *
               * 投影 effect 依赖 order/stages/nodeStatus，任何一次重新取计划都会用文档
               * 坐标重建节点——位置只存在画布里就会在下一次重建时弹回原处。
               *
               * 但**只在真的动了**才写：React Flow 对「点一下节点」也会走一遍
               * dragStart/dragStop，无条件写回会让单纯的点选或框选把流程标成未保存。
               */
              if (located.node.position?.x !== item.position.x || located.node.position?.y !== item.position.y) {
                positions.set(item.id, item.position);
              }
              continue;
            }
            const loop = target ? next.find((step) => step.id === target) : undefined;
            const landing = target && loop
              ? clampInsideLoop({ x: absolute.x - (loop.position?.x ?? 0), y: absolute.y - (loop.position?.y ?? 0) })
              : absolute;
            next = reparentStep(next, item.id, target, landing);
            detached.push(item.id);
            if (target) movedIn += 1; else movedOut += 1;
          }
          /* 什么都没变就别碰文档，也别进历史。 */
          if (!positions.size && !detached.length) return;
          pushHistory();
          if (positions.size) next = foldPositions(next, positions);
          setSteps(next);
          if (detached.length) {
            /* 跨界连线没有可执行语义（框内每轮跑一遍、框外只跑一次），一并清掉。 */
            setEdges((current) => current.filter((edge) => !detached.includes(edge.source) && !detached.includes(edge.target)));
            message.info(movedIn ? t("flows.loopStepMovedIn") : t("flows.loopStepMovedOut"));
          }
        }}
        /**
         * Backspace/Delete removes the selected step or connection.
         *
         * `onNodesDelete` mirrors it back into the document — the canvas holds
         * only positions, so a node removed from `nodes` alone would reappear on
         * the next rebuild.
         */
         deleteKeyCode={["Backspace", "Delete"]}
         /* React Flow reserves Space globally for temporary canvas panning.
            Monaco's hidden textarea is not consistently recognized as a normal
            input target, so that listener swallowed spaces inside script nodes.
            Dragging already pans the canvas; disable the redundant shortcut. */
         panActivationKeyCode={null}
         onNodesDelete={(deleted) => { for (const item of deleted) removeStep(item.id); }}
        nodeTypes={NODE_TYPES}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow> : <Empty
        title={t("flows.canvasEmptyTitle")}
         hint={endpoints.length || dataSources.length ? t("flows.canvasEmptyHint") : t("flows.canvasNeedsAssets")}
         action={canWrite && (endpoints.length || dataSources.length) ? <button className="btn btn-primary" onClick={() => setNodePickerOpen(true)}>{t("flows.addNode")}</button> : undefined}
      />}
      </div>}
      <HistorySidebar
        open={historyOpen}
        onToggle={() => setHistoryOpen((current) => !current)}
        railLabel={t("flows.runRecords")}
        railCount={runs.total}
        filter={<div className="side-filter">
          <Select
            size="small"
            value={historyStatus}
            onChange={(value) => { setHistoryStatus(value); setHistoryPage(1); }}
            options={[
              { value: "all", label: t("filter.runStatusAll") },
              { value: "success", label: t("status.pass") },
              { value: "failed", label: t("status.fail") },
              { value: "canceled", label: t("status.canceled") },
            ]}
            style={{ width: "100%" }}
          />
        </div>}
        list={runs.items.length ? runs.items.map((item) => (
          <button key={item.id} className="history-item" onClick={() => openRun(item.id)}>
            <div className="history-item-top">
              <RunStatusTag status={toRunStatus(item.status)} />
              <span className="mono muted">{t("flows.stepSummary", { success: item.successCount, total: item.total })}</span>
            </div>
            <span className="mono muted history-time">{new Date(item.createdAt).toLocaleString()}</span>
          </button>
        )) : <p className="muted history-empty">{historyStatus === "all" ? t("flows.runRecordsEmpty") : t("reports.emptyFilterHint")}</p>}
        pager={<SidebarPager
          page={runs.page}
          pageSize={runs.pageSize}
          total={runs.total}
          onPage={setHistoryPage}
          onPageSize={(size) => { setHistoryPageSize(size); setHistoryPage(1); }}
        />}
      />
    </div>

    <FlowRunDrawer projectId={projectId!} run={inspecting} onClose={() => setInspecting(undefined)} />

    <FlowNodeDrawer
      projectId={projectId!}
      flowId={flowId!}
      node={current}
      nodes={flattenSteps(steps).map((item) => item.node)}
      edges={toFlowEdges(edges)}
      variables={variables}
      environmentId={environmentId === "none" ? undefined : environmentId}
      evidence={current ? evidenceFor(run, current.id) : undefined}
      onChange={updateNode}
      onClose={() => setOpenNode(undefined)}
      onDelete={() => current && removeStep(current.id)}
     />

    <Modal
      title={insertAfter ? t("flows.pickNodeTypeAfter") : loopTarget ? t("flows.pickNodeTypeIntoLoop") : t("flows.pickNodeType")}
      open={nodePickerOpen}
      onCancel={() => { setNodePickerOpen(false); setLoopTarget(undefined); setInsertAfter(undefined); }}
      footer={null}
      width={640}
    >
      <div className="node-type-picker">
        <button className="node-type-option" disabled={!endpoints.length} onClick={() => addNode("request", loopTarget)}><Globe2 size={20} /><strong>{t("flows.requestNode")}</strong><span>{endpoints.length ? t("flows.requestNodeHint") : t("flows.requestNodeDisabled")}</span></button>
        <button className="node-type-option" disabled={!dataSources.length} onClick={() => addNode("database", loopTarget)}><Database size={20} /><strong>{t("flows.databaseNode")}</strong><span>{dataSources.length ? t("flows.databaseNodeHint") : t("flows.databaseNodeDisabled")}</span></button>
        <button className="node-type-option" onClick={() => addNode("script", loopTarget)}><Braces size={20} /><strong>{t("flows.scriptNode")}</strong><span>{t("flows.scriptNodeTypeBrief")}</span></button>
        <button className="node-type-option" onClick={() => addNode("condition", loopTarget)}><GitBranch size={20} /><strong>{t("flows.conditionNode")}</strong><span>{t("flows.conditionNodeTypeBrief")}</span></button>
        <button className="node-type-option" onClick={() => addNode("wait", loopTarget)}><Timer size={20} /><strong>{t("flows.waitNode")}</strong><span>{t("flows.waitNodeTypeBrief")}</span></button>
        {/* 子流程需要「另一个流程」当身体，项目里只有这一条流程时先禁用并说明原因，
            而不是让用户点进去面对一个空下拉。循环体内也可以放子流程。 */}
        <button className="node-type-option" disabled={!projectFlows.length} onClick={() => addNode("subflow", loopTarget)}><Workflow size={20} /><strong>{t("flows.subflowNode")}</strong><span>{projectFlows.length ? t("flows.subflowNodeTypeBrief") : t("flows.subflowNodeDisabled")}</span></button>
        {/* 循环不嵌套循环：画布上只做一层容器。 */}
        {!loopTarget && <button className="node-type-option" onClick={() => addNode("loop")}><Repeat size={20} /><strong>{t("flows.loopNode")}</strong><span>{t("flows.loopNodeTypeBrief")}</span></button>}
      </div>
    </Modal>

    <Modal
      title={t("flows.variablesTitle")}
      open={variablesOpen}
      onCancel={() => setVariablesOpen(false)}
      onOk={() => setVariablesOpen(false)}
      okText={t("action.confirm")}
      cancelText={t("action.cancel")}
      width={640}
    >
      {/* Seed values for the first step, and the stand-in a single-step debug
          uses in place of an upstream step's output. */}
      <p className="form-note">{t("flows.variablesHint")}</p>
      {/* Step extracts are deliberately absent from this picker: a seed value is
          read before anything has run, so offering an upstream step's output
          would offer something guaranteed to be empty at that moment. */}
      <div className="kv-head">
        <span className="label">{t("variables.insert")}</span>
        <VariablePicker
          options={seedVariableOptions}
          onPick={(reference) => {
            const next = [...variablePairs, { key: "", value: reference, enabled: true }];
            setVariablePairs(next);
            setVariables(fromPairs(next));
          }}
        />
      </div>
      <KeyValueEditor
        pairs={variablePairs}
        onChange={(pairs) => { setVariablePairs(pairs); setVariables(fromPairs(pairs)); }}
        keyPlaceholder="token"
        valuePlaceholder=""
        title={t("flows.variables")}
      />
    </Modal>
  </main>;
}

/**
 * Everything the canvas actually displays about a node, as one string.
 *
 * Feeds `canvasSignature`, whose whole purpose is to *not* change while a
 * request body or script body is being typed — so it must cover the fields on
 * the card and nothing more.
 */
function nodeDescriptor(step: FlowNode): string {
  if (step.type === "request") return `${step.request.method} ${step.request.url} ×${step.concurrency ?? 1}`;
  if (step.type === "database") return `${step.dataSourceId} ${step.sqlDefinitionId ?? step.statementType}`;
  if (step.type === "script") return "script";
  if (step.type === "condition") return `${step.condition.mode} ${step.condition.rules.map((rule) => `${rule.variable} ${rule.operator} ${rule.value ?? ""}`).join("|")}`;
  if (step.type === "wait") return `wait ${step.waitMs}`;
  if (step.type === "subflow") return `subflow ${step.flowId} ${step.flowName ?? ""}`;
  return `loop ${step.mode} ${step.count ?? ""} ${step.listVariable ?? ""} ${step.concurrency ?? 1} ${step.body.nodes.length} ${step.size?.width ?? 0}x${step.size?.height ?? 0}`;
}

/** Node verdicts from a run: HTTP executions plus generic step rows. */
function runStatuses(run: FlowExecutionDetail): Record<string, RunStatus> {
  const statuses: Record<string, RunStatus> = {};
  for (const step of [...run.steps, ...run.executionSteps]) {
    const nodeId = stepNodeId(step);
    if (nodeId) statuses[nodeId] = toRunStatus(step.status);
  }
  return statuses;
}

function toFlowEdges(edges: Edge[]): FlowEdge[] {
  return edges.map((edge) => ({ ...((edge.data as StepEdgeData | undefined)?.flowEdge ?? {}), id: edge.id, source: edge.source, target: edge.target }));
}

/** Projects branch semantics into React Flow without duplicating it in state. */
function toCanvasEdge(edge: FlowEdge, t: (key: string) => string): Edge {
  const branch = edge.on === "true" || edge.on === "false" ? edge.on : undefined;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: branch,
    label: branch ? t(branch === "true" ? "flows.conditionBranchTrue" : "flows.conditionBranchFalse") : undefined,
    data: { flowEdge: edge },
  };
}

function stepNodeId(step: FlowStepResult) {
  /* An Execution carries flowNodeId; a generic ExecutionStep carries stepId. */
  return "endpointId" in step ? step.flowNodeId ?? "" : step.stepId ?? "";
}

/** The node's evidence in a run, whichever evidence kind it produced. */
function evidenceFor(run: FlowExecutionDetail | undefined, nodeId: string): FlowStepResult | undefined {
  if (!run) return undefined;
  return run.steps.find((step) => stepNodeId(step) === nodeId)
    ?? run.executionSteps.find((step) => stepNodeId(step) === nodeId);
}

/**
 * Dirty tracking by value.
 *
 * Positions are included, because moving a node changes the order the server
 * derives for otherwise-unordered nodes — it is a real edit, not just layout.
 */
/**
 * 深度按键名排序后再序列化。
 *
 * 脏检查必须比较**内容**而不是键顺序：基线来自服务端返回的文档，而那份文档是从
 * Postgres 的 jsonb 读回来的——jsonb 不保留键的插入顺序（`{nodes, edges}` 存进去可能
 * 读出 `{edges, nodes}`）。客户端重建出来的对象键序几乎一定不同，直接 `JSON.stringify`
 * 会让「有循环节点的流程」永久显示未保存。
 */
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, stableJson(source[key])]));
  }
  return value;
}

function snapshot(name: string, environmentId: string, steps: FlowNode[], edges: FlowEdge[], variables: Record<string, string>, tags: string[]) {
  return JSON.stringify(stableJson({ name, environmentId, steps, edges: [...edges].sort((a, b) => a.id.localeCompare(b.id)), variables, tags }));
}
