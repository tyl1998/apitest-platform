import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Input, Modal, message } from "antd";
import { Check, ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, useStoreApi, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type Paged, type SpecCase, type SpecCaseInput, type SpecCaseLink, type SpecCasePriority, type SpecCaseStatus, type SpecModule } from "../api";
import { Empty, Tip } from "../ui";
import { apiMessage } from "./DataSourceList";
import { SpecLinkPicker } from "./SpecLinkPicker";

/* ── XMind 风格脑图（P7-3 第四~九轮，2026-09-07）───────────────────────────
   画布跑在 @xyflow/react 上（FlowWorkspace 同一个库，零新增依赖）：平移缩放、
   选中、连线交给库，节点/布局/交互自己写。解析对象是**当前范围**（全部用例或
   点中的目录）下的完整结构（㉔ 复测：目录层必须进图，用户的心智模型是
   XMind——「全部用例 → 测试 → dd + 用例」）：

     全部用例 / 当前目录（root，不可编辑）
     ├── 目录（可折叠；Enter 加同级目录，Tab 在此建用例）
     │   └── 目录 ……
     ├── 用例标题（编号 · 生命周期点 · 优先级）—— ⊕/⊖ 展开收起
     │   ├── 前置 · ……（空槽有「＋ 前置」占位节点，点了就建）
     │   ├── 1. 步骤一
     │   │   └── 预期 · ……（Tab 补预期）
     │   └── ＋ 步骤（用例还没有步骤时的占位槽）
     └── ……

   交互按 XMind 惯例：**单击选中、双击就地编辑、⊕/⊖ 折叠**；选中后 Tab 加
   子级（目录→用例、用例→步骤、步骤→预期）、Enter 加同级（目录→同级目
   录、用例→同模块用例、步骤→后续步骤）、Delete/Backspace 直接删除（不
   弹确认）、⌘Z/Ctrl+Z 撤销（⇧ 重做，Y 同）；**右键出菜单**（㉗）——条
   目按节点种类自动生成：加目录/用例/步骤/预期、添加标签、标记优先级、
   删除，与键位同一套路由。用例节点带标签 chip（原编号位，编号不进节
   点）与优先级徽章。每个节点带种类徽记（目录/用例/前置/步骤/预期），
   **编辑态徽记保留**——新增那一刻正是最需要确认「在建什么」的时刻。

   落库走**最小提交**（只 PATCH 改动字段，服务端本就按键局部更新），响应
   （服务端真值）**即时合入**本地 data / 模块表（applyLocalCase / extraModules），
   下一个动作立刻读到最新内容。键盘动作有在途守卫（busyRef）。

   **节点对象引用是硬约束（㉓ 白屏根因）**：React Flow 受控节点按引用判等，
   引用一换内部就整重置 measured/handleBounds（节点回未测量态 = visibility:
   hidden、连线消失），靠 ResizeObserver 重测恢复；乐观合入 → loading → 重取
   连续换代时观察器追不上，节点**永久卡在 hidden**——画布空白。因此 nodes
   按 [graph, selectedId, edit] memo，且每个节点把 store 里的 measured 随身
   带回——adopt 时测量结果与 handleBounds 不清空，换代不再闪没。 */

/** 列距（节点最大宽 300 + 连线通道）；节点横向定列，纵向 tidy tree 推开。
 *  第五轮加宽：224/280 → 300/360——长标题/步骤折行行数减半，编辑框也宽一倍。 */
const PITCH = 360;
const MAX_W = 300;
const GAP_Y = 12;

/** 「加载更多」每批条数（目录级局部加载）：一批 50——够填一屏，不至于一次拉全。 */
const LOAD_MORE_PAGE = 50;

type MindKind = "root" | "dir" | "case" | "pre" | "step" | "exp" | "add" | "more";

/** CJK/全角字符（第五轮①「数据折叠」的根因之一：此前按字符数平估，16 字/行
 *  对 224px−padding 的实际容量（case ≈15.5 字）会**低估行数**——节点 DOM 比
 *  布局预留的高、文字压到下邻节点上，读作「数据被折叠」。改按显示宽度加权：
 *  CJK 记 1（字宽 ≈ 字号），ASCII 记 0.6（≈ 0.5 字号，取 0.6 偏保守——
 *  高估行数只是多留白，低估才会重叠）。 */
const CJK_RE = /[\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += CJK_RE.test(ch) ? 1 : 0.6;
  return units;
}

/** 节点高（CSS 同步钉死——布局按它算，CSS 不钉会漂）。root/dir/add/more 是
 *  固定高度的结构行；case/pre/step/exp **一律块布局完整折行**：徽记独占首行，
 *  正文全宽按估算行数完整折行，没有任何 line-clamp。高度由 estimateLines /
 *  nodeHeight 同一估算驱动（DOM 与布局共用，坐标不漂）。 */
function estimateLines(label: string, kind: MindKind): number {
  const text = label || "—";
  /* 每行容量按「正文吃满节点内容宽」估（300 − padding − border）：
     case 13px → 276/13 ≈ 21 字，取 20；pre/step/exp 12px → 282/12 ≈ 23 字，取 22。 */
  const perLine = kind === "case" ? 20 : 22;
  let lines = 0;
  for (const seg of text.split("\n")) {
    lines += Math.max(1, Math.ceil(textUnits(seg) / perLine));
  }
  return lines;
}
function nodeHeight(kind: MindKind, label: string): number {
  if (kind === "root") return 36;
  if (kind === "dir") return 32;
  if (kind === "add" || kind === "more") return 24;
  /* 内容族块布局几何：边框 2 + 上下 padding(4+4) + 徽记行 20 + 行距 3 =
     33，+2 呼吸；正文 = lines × 1.5 行高（case 13px→19.5，其余 12px→18）。
     标签 chips 有 72px 线夹 + 容器 150px 封顶（第四轮②），徽记行不会折行。 */
  return 35 + Math.round(estimateLines(label, kind) * (kind === "case" ? 19.5 : 18));
}

type MindNodeData = {
  kind: MindKind;
  /** 节点徽记（目录/用例/前置/步骤/预期）——shape 一眼可辨，位置不再是唯一线索。 */
  kindTag?: string;
  /** 就地编辑的**初值**（用例=标题，前置/步骤/预期=各自内容，目录=名字）；
      编辑中的文本不回流父级（㊴，见 MindEditInput）。 */
  label: string;
  /** 归属用例（root/dir/more 没有）。 */
  caseItem?: SpecCase;
  /** 目录节点归属的模块（㉔ 目录层进图）。 */
  module?: SpecModule;
  /** 占位槽（add）要补的内容：前置 / 步骤。 */
  addKind?: "pre" | "step";
  /** 步骤序号（1 起，与节点 id 同源）。 */
  stepIndex?: number;
  count?: number;
  status?: SpecCaseStatus;
  priority?: SpecCasePriority;
  /** 用例标签（㉗：展示在原编号位，编号不进节点）。 */
  tags?: string[];
  mark?: string;
  /** 筛选态（keyword/priority/status 有值）：目录计数是未过滤口径，节点
      隐藏计数避免「徽章 N、下面没 case」的口径矛盾（第四轮④）。 */
  filtered?: boolean;
  /** 就地编辑的选区策略：true = 全选（新建占位，打字即覆盖）；缺省 = 光标
      置尾（双击存量内容，2026-09-08 第六轮反馈）。 */
  selectAll?: boolean;
  expandable?: boolean;
  open?: boolean;
  editing?: string;
  onCommit?: (value: string) => void;
  onCancel?: () => void;
};

type MindFlowNode = Node<MindNodeData, "mind">;

/**
 * 输入法组合态守卫（㉟ 复测，㊲）：isComposing / keyCode 229 只覆盖「组合进行
 * 中」的 keydown（Chrome/Firefox）。两个残余——① Safari 把**确认候选**的 Enter
 * 排在 compositionend 之后派发，此时 isComposing 已是 false、keyCode 是 13，
 * 229 兜不住，选字回车被当提交、组合文本拦腰截断；② 反过来，部分输入法在
 * 非组合态也把 keydown 报成 229，裸 229 检查会把真正的提交键一起吞掉（表现
 * 为「回车提交不了」）。改按事件跟踪：compositionstart/end 记组合态与结束
 * 时刻，组合结束后极短窗口内的 Enter/Tab 视作选字确认键放行一次（只吞一次，
 * 紧接着的第二次按键是用户真意图）；229 裸检查撤销。
 */
function useImeGuard() {
  const composingRef = useRef(false);
  const composedAtRef = useRef(0);
  return {
    onCompositionStart: useCallback(() => { composingRef.current = true; }, []),
    onCompositionEnd: useCallback(() => {
      composingRef.current = false;
      composedAtRef.current = performance.now();
    }, []),
    /** 组合期（含 Safari 刚结束的选字键）返回 true：本按键属于输入法，不是编辑框的提交/取消。 */
    isImeKey: useCallback((event: ReactKeyboardEvent, commitKeys: string[]) => {
      if (composingRef.current || event.nativeEvent.isComposing) return true;
      const at = composedAtRef.current;
      if (at && commitKeys.includes(event.key) && performance.now() - at < 100) {
        composedAtRef.current = 0;
        return true;
      }
      return false;
    }, []),
  };
}

/**
 * 就地编辑输入框（㊴）：草稿是**组件本地态**。此前 value 挂在画布节点 data 上、
 * 每个按键走 setEdit → nodes prop → React Flow store（passive effect，慢一拍）→
 * 节点重渲染的往返——React 受控输入的事后校正（restoreStateIfNeeded）在往返
 * 完成前拿**旧 props** 回写 DOM，普通英文打字能被下一帧自愈，但**组合进行中
 * 回写 value 会拆掉输入法会话**——中文永远打不进就地编辑框（㉟/㊲ 的键位守卫
 * 只管 Enter/Tab，不是这一处）。本地 setState 的受控回显与按键同一次提交完成，
 * 无往返、无回写；终值在提交时交给父级（onCommit(value)）。
 *
 * 多行 textarea + **自动量高**（2026-09-08 第五轮反馈③：第四轮的 rows 估算
 * 仍会截断输入）。rows 只是初值，草稿每次变化后 useLayoutEffect 把高度钉到
 * scrollHeight（精确，不再依赖估算）；Esc 取消、Enter/Tab 提交（Shift+Enter
 * 换行——预期/前置本就是多行文本）。编辑节点本体在 CSS 里放宽到 360px。
 */
function MindEditInput({ seed, kind, selectAll, ariaLabel, onCommit, onCancel }: {
  seed: string;
  kind: MindKind;
  /** true = 挂载全选（新建占位，打字即覆盖）；缺省 = 光标置尾（双击存量
      内容，2026-09-08 第六轮反馈：此前一律全选，按方向键才落到尾部）。 */
  selectAll?: boolean;
  ariaLabel?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ime = useImeGuard();
  const [draft, setDraft] = useState(seed);
  const elRef = useRef<HTMLTextAreaElement | null>(null);
  /* 稳定 ref（依赖只有 selectAll，编辑会话内恒定）：inline ref 每次渲染都会
     被 React 重调，每敲一个字就重新 focus + 选区，光标永远定不住。只在挂载
     时聚焦一次。新建的节点挂载瞬间还是未测量态（React Flow 先
     visibility:hidden 等 ResizeObserver），此刻 focus() 会静默失败——逐帧
     重试到真正拿到焦点（㉓：拿不到焦点的自动编辑是死陷阱——Tab 落到
     document 层又被 edit 态挡掉，看起来像键盘失灵）。 */
  const focusOnce = useCallback((node: HTMLTextAreaElement | null) => {
    elRef.current = node;
    if (!node) return;
    let tries = 0;
    const attempt = () => {
      if (!node.isConnected) return;
      node.focus();
      if (selectAll) node.select();
      else { const end = node.value.length; node.setSelectionRange(end, end); }
      if (document.activeElement === node || ++tries > 30) return;
      requestAnimationFrame(attempt);
    };
    attempt();
  }, [selectAll]);
  /* 自动量高：高度 = scrollHeight（+1px 亚像素兜底），任何草稿都完整可见。
     useLayoutEffect 在绘制前跑，用户看不到中间态。 */
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 1}px`;
  }, [draft]);
  return <textarea
    className="mindmap-input"
    rows={estimateLines(draft, kind) || 1}
    value={draft}
    /* 就地编辑的焦点是交互本体：挂载即聚焦并全选，直接打字即覆盖。 */
    ref={focusOnce}
    onChange={(event) => setDraft(event.target.value)}
    onCompositionStart={ime.onCompositionStart}
    onCompositionEnd={ime.onCompositionEnd}
    onKeyDown={(event) => {
      event.stopPropagation();
      /* 输入法组合期间与其结束瞬间的 Enter/Tab 是选字确认键，不是编辑框
          的提交键（㉟/㊲：组合文本被拦腰截断提交、输入框随即关闭）。 */
      if (ime.isImeKey(event, ["Enter", "Tab"])) return;
      if (event.key === "Enter" && !event.shiftKey || event.key === "Tab") { event.preventDefault(); onCommit(draft); }
      else if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    }}
    onBlur={() => onCommit(draft)}
    aria-label={ariaLabel}
  />;
}

function MindNodeView({ data, selected }: NodeProps<MindFlowNode>) {
  const kind = data.kind;
  const editing = data.editing !== undefined;
  /* 内容族（case/pre/step/exp）一律块布局（2026-09-08 第二轮：阈值判断不可
     救——单行模式里徽记把正文挤到 ~90px，常见标题仍被线夹省略）：徽记首行 +
     全宽正文完整折行，无 line-clamp。root/dir/add/more 维持旧行布局。 */
  const block = kind === "case" || kind === "pre" || kind === "step" || kind === "exp";
  /* 内容族已经完整展示，不再需要悬停 Tip（2026-09-08 第四轮反馈③）；结构行
     （root/dir 名字 + 计数）仍是单行截断，保留 Tip。编辑态草稿就在眼前。 */
  const tip = block || editing ? undefined : (data.label || undefined);
  return <Tip text={tip}>
    <div
      className={`mindmap-node is-${kind}${block && !editing ? " is-multiline" : ""}${selected ? " is-selected" : ""}${editing ? " is-editing" : ""}`}
      style={block && !editing ? { minHeight: nodeHeight(kind, data.label) } : undefined}
      data-removed={kind === "case" && data.status === "deprecated" ? "" : undefined}
    >
    {kind !== "root" && <Handle type="target" position={Position.Left} isConnectable={false} />}
    {editing ? <div className={`mindmap-edit${block ? " is-block" : ""}`}>
      {/* 编辑态保留徽记与步骤序号（⑳ 复测）：新增/改名那一刻正是要确认
          「在建的是什么」的时刻，输入框不能把徽记整个顶掉。
          内容族（block）编辑走块布局：徽记独占首行、输入框整行 <textarea>
          全宽折行——编辑长前置/步骤/预期时能看到全部输入（㊴ 第四轮反馈③）。 */}
      {data.kindTag && <span className="mindmap-tag">{data.kindTag}</span>}
      {kind === "step" && <span className="mono mindmap-mark">{data.mark}</span>}
      <MindEditInput
        seed={data.editing ?? ""}
        kind={kind}
        selectAll={data.selectAll}
        ariaLabel={data.label}
        onCommit={data.onCommit ?? (() => {})}
        onCancel={data.onCancel ?? (() => {})}
      />
    </div> : block ? <div className="mindmap-block">
      <div className="mindmap-block-head">
        {kind === "case" && <span className="mindmap-dot" data-status={data.status === "reviewed" ? "pass" : data.status === "unreviewed" ? "skip" : "canceled"} />}
        {data.kindTag && <span className="mindmap-tag">{data.kindTag}</span>}
        {/* 标签（㉗）长在原编号位（编号不进节点）；最多两枚 + 溢出计数，
            超长标签截断（第四轮②：长标签把徽记行撑爆）——chip 自身
            max-width 线夹，标签列表 flex-wrap 折行兜底。 */}
        {kind === "case" && (data.tags?.length ?? 0) > 0 && <span className="mindmap-tags">
          {data.tags!.slice(0, 2).map((tag) => <span key={tag} className="mindmap-tagchip">{tag}</span>)}
          {data.tags!.length > 2 ? <span className="mindmap-tagchip">+{data.tags!.length - 2}</span> : null}
        </span>}
        {kind === "step" && <span className="mono mindmap-mark">{data.mark}</span>}
        {/* 优先级徽章（㉗）：P0 最重（实心边框重一档）、P3 最轻（弱字），
            色彩克制——语义色留给 pass/fail，优先级用线宽与字重分层。 */}
        {kind === "case" && data.priority && <span className="mindmap-priority" data-priority={data.priority}>{data.priority}</span>}
        {data.expandable && <span className="mindmap-toggle">{data.open ? <Minus size={10} /> : <Plus size={10} />}</span>}
      </div>
      <div className="mindmap-block-body">{data.label || "—"}</div>
    </div> : <>
      {data.kindTag && <span className="mindmap-tag">{data.kindTag}</span>}
      <span className="truncate mindmap-label">{data.label || "—"}</span>
      {/* 筛选态计数隐藏（第四轮④）：计数是未过滤的树口径，画布内容已按
          筛选收敛——「徽章 N、下面没 case」读作矛盾。无筛选时口径一致，保留。 */}
      {(kind === "root" || kind === "dir") && !data.filtered && <span className="mono mindmap-count">{data.count}</span>}
      {data.expandable && <span className="mindmap-toggle">{data.open ? <Minus size={10} /> : <Plus size={10} />}</span>}
    </>}
    {(kind === "root" || kind === "dir" || kind === "case" || kind === "step") && <Handle type="source" position={Position.Right} isConnectable={false} />}
  </div>
  </Tip>;
}

const NODE_TYPES = { mind: MindNodeView };

/**
 * 两个 user 节点是否「渲染等价」（2026-09-08 折叠空白修复）：React Flow 受控
 * 节点按 `userNode === internalNode.internals.userNode` 判等走快路径——引用
 * 不变则内部 measured / handleBounds 原封不动；换新引用则内部态整条重建、节点
 * 回未测量态（visibility:hidden）等 ResizeObserver 异步恢复，连续换代时恢复
 * 追不上重置就永久卡 hidden（㉓ 白屏的病理）。本函数比较全部会进渲染的字段
 * （含 position / selected / 编辑闭包），等价即可把**旧对象原样送回**。
 *
 * onCommit / onCancel 只在编辑节点上存在且每次 memo 都是新闭包（捕获当次的
 * graph/modulePath）——引用比较在这里是**承重**的：等价误判会把上一代的旧闭包
 * 留在编辑框上，提交读到旧图。非编辑节点两者恒 undefined。
 */
function sameMindNode(a: MindFlowNode, b: MindFlowNode): boolean {
  if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false;
  if (a.selected !== b.selected) return false;
  const x = a.data;
  const y = b.data;
  return x.kind === y.kind
    && x.kindTag === y.kindTag
    && x.label === y.label
    && x.caseItem === y.caseItem
    && x.module === y.module
    && x.addKind === y.addKind
    && x.stepIndex === y.stepIndex
    && x.count === y.count
    && x.status === y.status
    && x.priority === y.priority
    && x.tags === y.tags
    && x.mark === y.mark
    && x.filtered === y.filtered
    && x.selectAll === y.selectAll
    && x.expandable === y.expandable
    && x.open === y.open
    && x.editing === y.editing
    && x.onCommit === y.onCommit
    && x.onCancel === y.onCancel;
}

/** 树形骨架（kid 递归），布局前的中间结构。 */
type Kid = { id: string; kind: MindKind; data: MindNodeData; kids?: Kid[] };

type Entry = { id: string; kind: MindKind; depth: number; y: number; data: MindNodeData };

/**
 * 经典 tidy tree（后序）：叶子逐行占位，父节点居中于子代跨度；父节点自身
 * 高于子代跨度时子代整体让位（measure 先量，2026-09-09「步骤盖住下一步骤」
 * 反馈——占位只看子代跨度，高个子父节点居中于子代、溢出压进兄弟的槽）。
 * 横向按深度定列（depth × PITCH），节点宽度交给 CSS（max-content 封顶 MAX_W）。
 *
 * 骨架（㉔）：root（全部用例 / 点中的目录）→ 目录子树（modules 按 parentId
 * 挂接，path 前缀限定在范围内）→ 每个目录挂直属用例 → 前置/步骤/预期。目录
 * 节点来自模块表（结构完整，不受用例分页影响），用例来自已载集（初始页 +
 * 各目录 load-more 追加，见 allCases）。用例的空子槽（前置 / 步骤）给
 * 「＋ …」占位节点——前置没有别的入口，步骤的占位只在一条步骤都没有时出现
 * （补步骤有 Tab）。
 *
 * 局部加载（2026-09-08）：lazyDirs 时每个「直属已载 < 树计数」的目录（含
 * 范围根本身）在子末尾挂一枚 `more:<moduleId>` 节点，点击由父组件按 moduleId
 * 取下一批；有关键字/优先级/状态筛选时退回根级 more 节点（total 是过滤后的
 * 准确值，目录级树计数算不出过滤口径）。
 */
function buildGraph(cases: SpecCase[], total: number, modules: SpecModule[], scopePath: string | undefined, openCases: Set<string>, closedDirs: Set<string>, rootLabel: string, moreLabel: string, addable: boolean, lazyDirs: boolean, filtered: boolean, remainingByModule: Map<string, number>, t: TFunction): { nodes: MindFlowNode[]; edges: Edge[] } {
  const entries: Entry[] = [];
  const edges: Edge[] = [];

  function caseKids(item: SpecCase): Kid[] {
    if (!openCases.has(item.id)) return [];
    const kids: Kid[] = [];
    if (item.preconditions.trim()) {
      kids.push({ id: `pre:${item.id}`, kind: "pre", data: { kind: "pre", kindTag: t("specCases.mindmapPre"), label: item.preconditions, caseItem: item } });
    } else if (addable) {
      kids.push({ id: `add:${item.id}:pre`, kind: "add", data: { kind: "add", label: t("specCases.mindmapAddPre"), caseItem: item, addKind: "pre" } });
    }
    item.steps.forEach((row, index) => {
      const stepKid: Kid = { id: `step:${item.id}:${index + 1}`, kind: "step", data: { kind: "step", kindTag: t("specCases.mindmapStep"), label: row.step, caseItem: item, stepIndex: index + 1, mark: String(index + 1) } };
      if (row.expected.trim()) {
        stepKid.kids = [{ id: `exp:${item.id}:${index + 1}`, kind: "exp", data: { kind: "exp", kindTag: t("specCases.mindmapExpected"), label: row.expected, caseItem: item, stepIndex: index + 1 } }];
      }
      kids.push(stepKid);
    });
    if (addable && item.steps.length === 0) {
      kids.push({ id: `add:${item.id}:step`, kind: "add", data: { kind: "add", label: t("specCases.mindmapAddStep"), caseItem: item, addKind: "step" } });
    }
    return kids;
  }

  /** 子树占位高（2026-09-09 反馈：步骤内容过大盖住下一步骤）——先量后排。
   *  place 旧实现给父节点让位只看**子代跨度**：父节点自身比子代高时（长
   *  步骤只带一条短预期、长标题用例只剩「＋」占位槽），父节点居中于子代、
   *  上下各溢出 (h−span)/2，下方溢出吃掉 GAP_Y 后压进兄弟的槽。占位高 =
   *  max(自身高, 子代跨度)，place 据此给高个子父节点下移子代让位。 */
  const subtreeH = new Map<Kid, number>();
  function measure(kid: Kid): number {
    const cached = subtreeH.get(kid);
    if (cached !== undefined) return cached;
    const h = nodeHeight(kid.kind, kid.data.label);
    const children = kid.kids ?? [];
    let total = h;
    if (children.length > 0) {
      let span = -GAP_Y;
      for (const child of children) span += measure(child) + GAP_Y;
      total = Math.max(h, span);
    }
    subtreeH.set(kid, total);
    return total;
  }

  function place(kid: Kid, depth: number, top: number): { id: string; center: number; bottom: number } {
    const h = nodeHeight(kid.kind, kid.data.label);
    const children = kid.kids ?? [];
    if (children.length === 0) {
      entries.push({ id: kid.id, kind: kid.kind, depth, y: top, data: kid.data });
      return { id: kid.id, center: top + h / 2, bottom: top + h };
    }
    /* 自身高 > 子代跨度时子代整体下移 lead 让位（父节点钉在槽顶、子代居
       中于它），父节点不再溢出到兄弟的槽；bottom 同步扩张到自身底部——
       下一个兄弟从真正的底缘排起。自身 ≤ 跨度时保持原行为（居中于首末
       子代中心），max 只兜极不对称下 1px 级的下探。 */
    let span = -GAP_Y;
    for (const child of children) span += measure(child) + GAP_Y;
    const lead = Math.max(0, (h - span) / 2);
    let cursor = top + lead;
    let firstCenter = 0;
    let lastCenter = 0;
    for (let i = 0; i < children.length; i++) {
      const child = place(children[i], depth + 1, cursor);
      edges.push({ id: `${kid.id}->${child.id}`, source: kid.id, target: child.id });
      if (i === 0) firstCenter = child.center;
      lastCenter = child.center;
      cursor = child.bottom + GAP_Y;
    }
    const y = Math.round(lead > 0 ? top : (firstCenter + lastCenter) / 2 - h / 2);
    entries.push({ id: kid.id, kind: kid.kind, depth, y, data: kid.data });
    return { id: kid.id, center: y + h / 2, bottom: Math.max(cursor - GAP_Y, y + h) };
  }

  /* ── 目录层（㉔）：modules 拍平表 → 范围内森林；用例按 moduleId 挂到直属
     目录。计数口径与左侧树一致（path 前缀求和，含全部状态）。同级按
     (position, name) 排（P7-6 调序）——与左侧树同一把尺，两视图同级不换位。 ── */
  const inScope = modules.filter((module) => (scopePath ? module.path.startsWith(scopePath) && module.path !== scopePath : true));
  const scopeModule = scopePath ? modules.find((module) => module.path === scopePath) : undefined;
  const childrenByParent = new Map<string, SpecModule[]>();
  for (const module of inScope) {
    const parentKey = module.parentId ?? "";
    const siblings = childrenByParent.get(parentKey);
    if (siblings) siblings.push(module); else childrenByParent.set(parentKey, [module]);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }
  const casesByModule = new Map<string, SpecCase[]>();
  for (const item of cases) {
    const siblings = casesByModule.get(item.moduleId);
    if (siblings) siblings.push(item); else casesByModule.set(item.moduleId, [item]);
  }
  function subtreeCount(module: SpecModule): number {
    let total = module.caseCount ?? 0;
    for (const other of inScope) {
      if (other.path.startsWith(module.path) && other.id !== module.id) total += other.caseCount ?? 0;
    }
    return total;
  }
  function dirKid(module: SpecModule): Kid {
    const subdirs = childrenByParent.get(module.id) ?? [];
    const directCases = casesByModule.get(module.id) ?? [];
    const open = !closedDirs.has(module.id);
    const kids: Kid[] = open ? [
      ...subdirs.map(dirKid),
      ...directCases.map((item) => caseKid(item)),
    ] : [];
    /* 局部加载：直属没载完的目录挂「加载更多」在子末尾（树计数口径，全状态）。 */
    if (open && lazyDirs) {
      const remaining = remainingByModule.get(module.id) ?? 0;
      if (remaining > 0) {
        kids.push({ id: `more:${module.id}`, kind: "more", data: { kind: "more", label: t("specCases.mindmapLoadMore", { count: remaining }), module } });
      }
    }
    return {
      id: `dir:${module.id}`,
      kind: "dir",
      data: {
        kind: "dir",
        kindTag: t("specCases.mindmapDirTag"),
        label: module.name,
        module,
        count: subtreeCount(module),
        filtered,
        expandable: subdirs.length > 0 || directCases.length > 0 || remainingByModule.has(module.id),
        open,
      },
      kids,
    };
  }
  function caseKid(item: SpecCase): Kid {
    return {
      id: `case:${item.id}`,
      kind: "case",
      data: {
        kind: "case",
        kindTag: t("specCases.mindmapCaseTag"),
        label: item.title,
        caseItem: item,
        status: item.status,
        priority: item.priority,
        tags: item.tags,
        expandable: Boolean(item.preconditions.trim()) || item.steps.length > 0,
        open: openCases.has(item.id),
      },
      kids: caseKids(item),
    };
  }

  /* root 的孩子 = 范围内顶层目录（点中目录时是它的子目录）+ 该层直属用例；
     挂不上任何目录的用例（模块表尚未重取到的瞬时态）直接挂 root，不丢行。
     范围根本身直属没载完时同样挂「加载更多」（全部用例 root 只有孤儿行，
     不给加载入口）。有筛选时退回根级 more 兜底（total 是过滤后的准确值）。 */
  const topKey = scopeModule?.id ?? "";
  const rootKids: Kid[] = [
    ...(childrenByParent.get(topKey) ?? []).map(dirKid),
    ...(casesByModule.get(topKey) ?? []).map((item) => caseKid(item)),
    ...cases.filter((item) => !modules.some((module) => module.id === item.moduleId)).map((item) => caseKid(item)),
  ];
  if (lazyDirs && scopeModule) {
    const remaining = remainingByModule.get(scopeModule.id) ?? 0;
    if (remaining > 0) {
      rootKids.push({ id: `more:${scopeModule.id}`, kind: "more", data: { kind: "more", label: t("specCases.mindmapLoadMore", { count: remaining }), module: scopeModule } });
    }
  } else if (total > cases.length) {
    rootKids.push({ id: "more", kind: "more", data: { kind: "more", label: moreLabel } });
  }
  place({ id: "root", kind: "root", data: { kind: "root", kindTag: t("specCases.mindmapDirTag"), label: rootLabel, count: total, filtered }, kids: rootKids }, 0, 0);

  return {
    nodes: entries.map((entry) => ({ id: entry.id, type: "mind" as const, position: { x: entry.depth * PITCH, y: entry.y }, data: entry.data })),
    edges,
  };
}

export function SpecMindMap(props: {
  projectId: string;
  rootLabel: string;
  rootModuleId?: string;
  modules: SpecModule[];
  keyword: string;
  modulePath?: string;
  priority: SpecCasePriority | "all";
  status: SpecCaseStatus | "all";
  /** 已自动化筛选（P7-6）：与列表同一筛选语境（列表/脑图是同一批数据的两种排法，
      切换不换语境——automation 不透传时脑图读的是「全量」，列表筛了脑图没变）。 */
  automation: "all" | "yes" | "no";
  revision: number;
  canWrite: boolean;
  onOpenCase: (item: SpecCase) => void;
  onSaved: () => void;
}) {
  return <ReactFlowProvider><MindMapCanvas {...props} /></ReactFlowProvider>;
}

function MindMapCanvas({ projectId, rootLabel, rootModuleId, modules, keyword, modulePath, priority, status, automation, revision, canWrite, onOpenCase, onSaved }: {
  projectId: string;
  rootLabel: string;
  rootModuleId?: string;
  modules: SpecModule[];
  keyword: string;
  modulePath?: string;
  priority: SpecCasePriority | "all";
  status: SpecCaseStatus | "all";
  automation: "all" | "yes" | "no";
  revision: number;
  canWrite: boolean;
  onOpenCase: (item: SpecCase) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { getViewport, setCenter } = useReactFlow();
  const store = useStoreApi();

  const [data, setData] = useState<Paged<SpecCase>>({ items: [], page: 1, pageSize: 100, total: 0 });
  const [loading, setLoading] = useState(true);
  /* 展开集（用例 id）：⊕/⊖ 只换这张图的可见性；目录相反——默认全开，
     收起集（closedDirs）记录被折起来的。 */
  const [openCases, setOpenCases] = useState<Set<string>>(new Set());
  const [closedDirs, setClosedDirs] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string>();
  /* 就地编辑只记目标节点（㊴）：编辑文本是 MindEditInput 的本地草稿，提交时
      才交给 commitEdit(value)——不进这里、也就不随每个按键推画布 store。
      selectAll 区分两类入口（2026-09-08 第六轮反馈：双击存量用例，光标默认
      应在**末尾**，此前全选、按方向键才落到尾部）：新建占位（Tab/Enter 建的
      「新用例」等）全选——打字即覆盖占位文本；双击存量内容不选——光标置尾。 */
  const [edit, setEdit] = useState<{ nodeId: string; selectAll?: boolean }>();
  /* 键盘动作在途守卫（⑲ 复测）：PATCH 未返回前 Tab/Enter 不叠加——连按会
     用同一份旧图发两次（双建用例 / 第二条步骤顶掉第一条）。 */
  const busyRef = useRef(false);
  /* 请求代数：每次取数推进；在途/作废的响应按代数丢弃。 */
  const dataGenRef = useRef(0);
  /* 当前目录的实时镜像：撤销/重做闭包晚于入栈很久才执行，闭包里的 modulePath
     prop 是旧值。合入守卫改读 ref（调用时刻的真值）——切走后不合入、切回来
     又能合入，正是 ㉒ 守卫的本意。2026-09-08 第三轮：撤销/重做从此也走本地
     合入——此前只靠 onSaved 重取，大范围（首页 100 条装不下）下恢复的行不在
     首页里，画布上什么都不发生，⌘Z 读作「失效」。 */
  const modulePathRef = useRef(modulePath);
  useEffect(() => { modulePathRef.current = modulePath; });
  /* ── 撤销 / 重做（㉖）─────────────────────────────────────────────────
     删除不再确认（㉕ 复测）之后，⌘Z 就是安全网。每条操作入栈时记录 undo /
     redo 两个闭包（资源重建用可变 id 持有：重建后 id 变，redo 删的是新 id）。
     闭包里落库 + 本地合入（applyLocalCase / removeLocalCase，守卫读
     modulePathRef 的**调用时刻真值**）+ onSaved 刷新——2026-09-08 第三轮：
     大范围（首页 100 条装不下）下不合入的话，恢复的行不在重取首页里，画布
     上什么都不发生，⌘Z 读作「失效」；合入守卫由 ref 化解了旧闭包捕获旧
     modulePath 的危险（㉒ 当初因此才不做合入）。 */
  const pastRef = useRef<{ undo: () => Promise<void>; redo: () => Promise<void> }[]>([]);
  const futureRef = useRef<{ undo: () => Promise<void>; redo: () => Promise<void> }[]>([]);
  function pushOp(undo: () => Promise<void>, redo: () => Promise<void>) {
    pastRef.current = [...pastRef.current.slice(-49), { undo, redo }];
    futureRef.current = [];
  }
  /** 用例字段类操作（标题/前置/步骤/优先级/标签/状态）的通用入栈：
      before 只带 after 动过的字段，从动作时的 item 上取旧值。撤销/重做同样
      本地合入（守卫读 modulePathRef）：大范围下重取首页装不下恢复的行，
      不合入就等于「撤销没反应」。 */
  function pushCasePatch(item: SpecCase, after: SpecCaseInput) {
    const before: SpecCaseInput = {};
    if ("title" in after) before.title = item.title;
    if ("preconditions" in after) before.preconditions = item.preconditions;
    if ("steps" in after) before.steps = item.steps;
    if ("priority" in after) before.priority = item.priority;
    if ("status" in after) before.status = item.status;
    if ("tags" in after) before.tags = item.tags;
    const pathAtStart = modulePath;
    pushOp(
      async () => { const restored = await api.updateSpecCase(projectId, item.id, before); applyLocalCase(restored, pathAtStart); onSaved(); },
      async () => { const restored = await api.updateSpecCase(projectId, item.id, after); applyLocalCase(restored, pathAtStart); onSaved(); },
    );
  }
  async function undoOp() {
    if (busyRef.current) return;
    const op = pastRef.current.pop();
    if (!op) return;
    busyRef.current = true;
    try {
      await op.undo();
      futureRef.current = [...futureRef.current, op];
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      busyRef.current = false;
    }
  }
  async function redoOp() {
    if (busyRef.current) return;
    const op = futureRef.current.pop();
    if (!op) return;
    busyRef.current = true;
    try {
      await op.redo();
      pastRef.current = [...pastRef.current, op];
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      busyRef.current = false;
    }
  }
  /* 就地新建 / 改名的目录（㉔）：modules 是父组件的快照，revision 重取落地前，
     把落库响应先记在这里——新目录立刻进图、就地改名立即生效，不等网络。按
     id 覆盖合并（新表里没有的追加、有的换新），父表跟上后瞬态自然消散。 */
  const [extraModules, setExtraModules] = useState<SpecModule[]>([]);
  const allModules = useMemo(() => {
    if (!extraModules.length) return modules;
    const overrides = new Map(extraModules.map((module) => [module.id, module]));
    const known = new Set(modules.map((module) => module.id));
    return [
      ...modules.map((module) => overrides.get(module.id) ?? module),
      ...extraModules.filter((module) => !known.has(module.id)),
    ];
  }, [modules, extraModules]);

  useEffect(() => {
    let cancelled = false;
    const gen = ++dataGenRef.current;
    setLoading(true);
    api.specCasesPaged(projectId, {
      keyword,
      path: modulePath,
      priority: priority === "all" ? undefined : priority,
      status: status === "all" ? undefined : status,
      automation: automation === "all" ? undefined : automation,
      page: 1,
      pageSize: 100,
    }).then((result) => {
      /* 比较 gen 而不是只看 cancelled：目录切换/筛选变化会让本 effect 重跑，
         cleanup 置 cancelled 的同时 gen 已推进——只有代数仍然等于当前值的
         响应才允许进 state，旧目录/旧筛选的迟到响应一律丢弃。 */
      if (cancelled || gen !== dataGenRef.current) return;
      /* 保留内容未变行的旧引用（2026-09-08 第三轮反馈：每次添加/删除后步骤
         内容闪一下）：revision 重取此前整页换新对象，所有行的 caseItem 引用
         全断，sameMindNode 的「渲染等价保留」对全图失效——每个节点都被打进
         React Flow 重新测量的慢路径（㉓），整树闪一帧。按 id + updatedAt 判
         等（任何落库都会推 updated_at，等价即内容未变）：没变的行用旧对象，
         节点判等走快路径零重置；自己刚编辑的行引用已在 applyLocalCase 里延
         续，远端真改了的行（updatedAt 不同）才换新对象。 */
      setData((current) => {
        if (!current.items.length) return result;
        const local = new Map(current.items.map((row) => [row.id, row]));
        return {
          ...result,
          items: result.items.map((row) => {
            const before = local.get(row.id);
            return before && before.updatedAt === row.updatedAt ? before : row;
          }),
        };
      });
    })
      .catch(() => { if (!cancelled && gen === dataGenRef.current) message.error(t("specCases.loadFailed")); })
      .finally(() => { if (!cancelled && gen === dataGenRef.current) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, keyword, modulePath, priority, status, automation, revision, t]);

  /* 换目录：展开/选中/编辑都是旧目录的语境，整体归零，data 清空回加载态
      （⑱：不归零时新数据未到，旧图还挂在画布上，坐标全在同一套
      position——React Flow 按节点 id 淼合新旧两代节点，渲染错乱/重叠。清空
      再等新图，等价于整图重挂。㉒：目录切换瞬间的在途动作由 applyLocalCase
      的 pathAtStart 守卫拦下，不合入新目录视图）。 */
  const prevModulePathRef = useRef(modulePath);
  useEffect(() => {
    if (prevModulePathRef.current === modulePath) return;
    prevModulePathRef.current = modulePath;
    setOpenCases(new Set());
    setClosedDirs(new Set());
    setSelectedId(undefined);
    setEdit(undefined);
    setData({ items: [], page: 1, pageSize: 100, total: 0 });
    setLoading(true);
  }, [modulePath]);

  /* ── 目录级局部加载（2026-09-08 反馈：case 扩张后单目录数据过大）─────────
     初始取数仍是「当前范围一页 100 条」，但每个目录（含范围根）只要直属已载
     数 < 树计数（caseCount），就在其子末尾画一枚「加载更多（还有 N 条）」节
     点——点了按 moduleId 精确取该目录下一批（50/批）追加，按 id 全局去重。
     有关键字/优先级/状态筛选时不启用（树计数是全状态口径，剩余数会虚高；
     筛选态维持根级 more 节点的旧兜底，它的 total 是过滤后的准确值）。 */
  const [moduleExtra, setModuleExtra] = useState<Record<string, SpecCase[]>>({});
  /* 计数快照与库有一拍延迟：按剩余数去取却取回空页（并发删了行）时把该目录
     标记取尽，节点撤下，不再空转点击。 */
  const [exhaustedModules, setExhaustedModules] = useState<Set<string>>(new Set());
  const busyModulesRef = useRef<Set<string>>(new Set());
  /* 范围/筛选变化即作废（初始页重取，追加页跟着重来）；revision 不清——写动作
     推高 revision 只为刷新首页与计数，追加页按 id 去重合并，保留不闪。 */
  useEffect(() => {
    setModuleExtra({});
    setExhaustedModules(new Set());
  }, [keyword, modulePath, priority, status, automation]);

  const lazyDirs = !keyword && priority === "all" && status === "all" && automation === "all";
  const allCases = useMemo(() => {
    if (!Object.keys(moduleExtra).length) return data.items;
    /* keep-first：初始页优先，追加页只补 id 没见过的行——重取页与追加页重叠
       时引用稳定（节点判等不受影响）。 */
    const seen = new Set(data.items.map((row) => row.id));
    const extra: SpecCase[] = [];
    for (const rows of Object.values(moduleExtra)) {
      for (const row of rows) {
        if (!seen.has(row.id)) { seen.add(row.id); extra.push(row); }
      }
    }
    return extra.length ? [...data.items, ...extra] : data.items;
  }, [data, moduleExtra]);

  /** 每目录「直属还剩多少没载」：树 caseCount（全状态导航口径）− 已载直属数。 */
  const remainingByModule = useMemo(() => {
    const map = new Map<string, number>();
    if (!lazyDirs) return map;
    const loadedByModule = new Map<string, number>();
    for (const row of allCases) loadedByModule.set(row.moduleId, (loadedByModule.get(row.moduleId) ?? 0) + 1);
    for (const module of allModules) {
      if (exhaustedModules.has(module.id)) continue;
      const remaining = (module.caseCount ?? 0) - (loadedByModule.get(module.id) ?? 0);
      if (remaining > 0) map.set(module.id, remaining);
    }
    return map;
  }, [lazyDirs, allCases, allModules, exhaustedModules]);

  /** 「加载更多」节点点击：按 moduleId 取下一批。页码从已载数换算——已载 37
      条时取第 1 页（50 条）重叠 13 条由合并去重吸收，绝不跳号。 */
  async function loadMoreCases(module: SpecModule) {
    if (busyModulesRef.current.has(module.id)) return;
    busyModulesRef.current.add(module.id);
    try {
      const loaded = allCases.filter((row) => row.moduleId === module.id).length;
      const result = await api.specCasesPaged(projectId, {
        moduleId: module.id,
        page: Math.floor(loaded / LOAD_MORE_PAGE) + 1,
        pageSize: LOAD_MORE_PAGE,
      });
      if (!result.items.length) {
        setExhaustedModules((current) => new Set(current).add(module.id));
        return;
      }
      setModuleExtra((current) => ({ ...current, [module.id]: [...(current[module.id] ?? []), ...result.items] }));
      /* 顺手展开该目录：加载的动作本身就带着「看这批用例」的意图。 */
      setClosedDirs((current) => {
        if (!current.has(module.id)) return current;
        const next = new Set(current);
        next.delete(module.id);
        return next;
      });
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.loadFailed"));
    } finally {
      busyModulesRef.current.delete(module.id);
    }
  }

  /* 筛选态（第四轮④）：目录/根的计数徽章取树导航口径（全状态），与被筛选
     后的画布内容对不上——筛选取数时传 filtered，节点隐藏计数。 */
  const filtered = Boolean(keyword) || priority !== "all" || status !== "all" || automation !== "all";
  const graph = useMemo(
    () => buildGraph(allCases, data.total, allModules, modulePath, openCases, closedDirs, rootLabel, t("specCases.mindmapMore", { count: data.total - allCases.length }), canWrite, lazyDirs, filtered, remainingByModule, t),
    [allCases, data.total, allModules, modulePath, openCases, closedDirs, rootLabel, canWrite, lazyDirs, filtered, remainingByModule, t],
  );

  /* 视口策略（㉙ + ㊲ 复测）：画布的「整图框定」只属于 ReactFlow 的 fitView
      prop——它只在画布**挂载**时发生（首载 / 换目录都会走 加载态卸载 → 新数据
      重挂，见上）。数据换代一律**保持用户视口**，只把正在操作的节点在跑出视口
      时以当前缩放平移进来。旧实现按「空 → 有数据」补一次 fitView——但这条
      路径不止换目录：**空目录里建第一条用例**（0 → 1，画布没重挂）也命中，
      整树被重新框定、缩放掉下去，刚打开的编辑输入框跟着缩成细线（㊲）。 */
  useEffect(() => {
    if (data.items.length === 0) return;
    const targetId = edit?.nodeId ?? selectedId;
    const node = targetId ? graph.nodes.find((item) => item.id === targetId) : undefined;
    if (!node) return;
    const { x, y, zoom } = getViewport();
    const pane = store.getState();
    const left = -x / zoom;
    const top = -y / zoom;
    const right = left + (pane.width ?? 0) / zoom;
    const bottom = top + (pane.height ?? 0) / zoom;
    const centerX = node.position.x + 80;
    const centerY = node.position.y + 16;
    if (centerX < left || centerX > right || centerY < top || centerY > bottom) {
      setCenter(centerX, centerY, { zoom, duration: 200 });
    }
  }, [data, graph, edit, selectedId, getViewport, setCenter, store]);

  /* 编辑目标不在当前图里（目录切换 / 筛选变化把节点换掉了）时撤销编辑态
     （㉒）：留着它，键位处理被 edit 占着、目标节点又不存在，Tab/Enter 死等。 */
  useEffect(() => {
    if (!edit) return;
    if (!graph.nodes.some((node) => node.id === edit.nodeId)) setEdit(undefined);
  }, [graph, edit]);

  /**
   * ⊕/⊖：用例按 openCases 展开；目录按 closedDirs 收起（默认全开）。
   *
   * 视口策略（2026-09-08 第三轮反馈，替代上一轮的「目录折叠/展开后 fitView
   * 重框定」）：整图框定每次都带着**缩放跳变**——展开大目录时整树被缩出去一
   * 大截，用户定位丢失，反馈明确说「跳转体验很差」。改回㉙ 的纪律：**缩放
   * 永不变**，折叠/展开后标记该目录为选中，视口 effect 会在它跑出视野时按
   * 当前缩放平移回来。上一轮「折叠后用例消失」（视口悬空在已折叠的大区域）
   * 由同一条兜底：操作的节点被平移回视野，剩余内容聚在它周围，不会空白。
   */
  function toggleNode(nodeId: string) {
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node?.data.expandable) return;
    if (node.data.kind === "case") {
      const caseId = node.data.caseItem?.id;
      if (!caseId) return;
      setSelectedId(nodeId);
      setOpenCases((current) => {
        const next = new Set(current);
        if (current.has(caseId)) next.delete(caseId); else next.add(caseId);
        return next;
      });
    } else if (node.data.kind === "dir" && node.data.module) {
      const dirId = node.data.module.id;
      setSelectedId(nodeId);
      setClosedDirs((current) => {
        const next = new Set(current);
        if (current.has(dirId)) next.delete(dirId); else next.add(dirId);
        return next;
      });
    }
  }

  function startEdit(nodeId: string) {
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    setSelectedId(nodeId);
    setEdit({ nodeId });
  }

  /** 就地编辑落库：**最小提交**——只 PATCH 被改的字段（⑲：整份快照会把旧图
      里的标题/步骤一起发回去，覆盖并发的其它改动），没改不发请求。目录名的
      编辑来自「建完即改名」的就地输入（㉔），存量目录的双击改名等 P7-6 的
      完整管理面（改名牵动 scope path 的场景需要父组件配合换筛）。 */
  async function commitEdit(value: string) {
    if (!edit) return;
    const node = graph.nodes.find((item) => item.id === edit.nodeId);
    if (!node) { setEdit(undefined); return; }
    if ((node.data.kind === "case" || node.data.kind === "dir") && !value.trim()) {
      message.error(node.data.kind === "case" ? t("specCases.titleRequired") : t("specCases.moduleNameRequired"));
      return; /* 名字不能空：留在编辑态让用户改。 */
    }
    if (value === node.data.label) { setEdit(undefined); return; }
    const pathAtStart = modulePath;
    setEdit(undefined);
    try {
      if (node.data.kind === "dir" && node.data.module) {
        const before = node.data.module.name;
        const after = value.trim();
        const moduleId = node.data.module.id;
        const renamed = await api.updateSpecModule(projectId, moduleId, { name: after });
        /* modules 是父组件快照：改名结果先记进 extraModules（按 id 覆盖），
           目录标签立即换新；revision 重取后自然对齐。改名可撤销（㉖）。 */
        setExtraModules((current) => {
          const next = new Map(current.map((module) => [module.id, module]));
          next.set(renamed.id, renamed);
          return [...next.values()];
        });
        pushOp(
          async () => { await api.updateSpecModule(projectId, moduleId, { name: before }); onSaved(); },
          async () => { await api.updateSpecModule(projectId, moduleId, { name: after }); onSaved(); },
        );
        onSaved();
        return;
      }
      const item = node.data.caseItem;
      if (!item) { setEdit(undefined); return; }
      let input: SpecCaseInput;
      if (node.data.kind === "case") input = { title: value.trim() };
      else if (node.data.kind === "pre") input = { preconditions: value };
      else if (node.data.kind === "step" && node.data.stepIndex) {
        input = { steps: item.steps.map((row, i) => i === node.data.stepIndex! - 1 ? { ...row, step: value } : row) };
      } else if (node.data.kind === "exp" && node.data.stepIndex) {
        input = { steps: item.steps.map((row, i) => i === node.data.stepIndex! - 1 ? { ...row, expected: value } : row) };
      } else { setEdit(undefined); return; }
      pushCasePatch(item, input);
      const updated = await api.updateSpecCase(projectId, item.id, input);
      applyLocalCase(updated, pathAtStart);
      onSaved();
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    }
  }

  function cancelEdit() {
    setEdit(undefined);
  }

  /** 落库响应（服务端真值）即时合入本地视图（⑲）：不等重取，下一个键盘动作
      立刻读到最新的步骤表/标题——连按 Tab 不再互相覆盖。PATCH/POST 响应不带
      module_path，替换时保留行上原值；新建（items 里没有）追加并推进 total。
      pathAtStart = 动作发出时的目录：在途期间目录已切走就不合入（㉒），新
      目录的视图交给重取，不闪旧目录的行。
      2026-09-08 第三轮反馈（编辑/删除不生效）：合入必须**两处都写**——画布行
      集 = data.items（范围首页 100 条）+ moduleExtra（目录级「加载更多」的追
      加批）。此前只写 data.items：住在追加页里的行，编辑先是短暂生效、随后
      被 revision 重取（只换首页）顶回旧值；新建用例按 item_key 排在范围末
      尾，超过 100 条时根本不在首页里，重取后节点直接消失。现在：页内行照旧
      合入 items；行同时/只在追加页里时合入 moduleExtra；未知行（新建）两处
      都落——追加页是它在 revision 重取后的唯一宿主。total 只对「两处都没有」
      的行 +1（此前只查 items，追加息行会虚增）。 */
  function applyLocalCase(updated: SpecCase, pathAtStart: string | undefined) {
    if (pathAtStart !== modulePathRef.current) return;
    const known = data.items.some((row) => row.id === updated.id)
      || Object.values(moduleExtra).some((rows) => rows.some((row) => row.id === updated.id));
    setData((current) => {
      const exists = current.items.some((row) => row.id === updated.id);
      return {
        ...current,
        total: current.total + (exists || known ? 0 : 1),
        items: exists
          ? current.items.map((row) => row.id === updated.id ? { ...row, ...updated, modulePath: row.modulePath } : row)
          : known ? current.items : [...current.items, updated],
      };
    });
    setModuleExtra((current) => {
      const rows = current[updated.moduleId] ?? [];
      if (rows.some((row) => row.id === updated.id)) {
        return { ...current, [updated.moduleId]: rows.map((row) => row.id === updated.id ? { ...row, ...updated, modulePath: row.modulePath } : row) };
      }
      return { ...current, [updated.moduleId]: [...rows, updated] };
    });
  }

  /** 在 moduleId 下建占位用例并立即进入编辑（㉔：Tab 在目录/root 上即建在该
      目录，全部用例下 Tab root 仍需先点目录）。 */
  async function createCaseIn(moduleId: string | undefined) {
    if (busyRef.current) return;
    if (!moduleId) { message.error(t("specCases.mindmapNeedModule")); return; }
    busyRef.current = true;
    const pathAtStart = modulePath;
    /* 无筛选才乐观追加：占位新用例多半不命中筛选，追进去只会闪现一帧再被
       重取抹掉；有筛选时是否可见交给重取（⑲）。 */
    const unfiltered = !keyword && priority === "all" && status === "all" && automation === "all";
    try {
      /* 占位标题先落库（平台要求标题非空），建完立即进入编辑直接改名。 */
      const created = await api.createSpecCase(projectId, {
        moduleId,
        title: t("specCases.mindmapNewCase"),
        preconditions: "",
        steps: [],
        priority: "P2",
        status: "unreviewed",
        tags: [],
      });
      pushOp(
        async () => { await api.deleteSpecCase(projectId, created.id); removeLocalCase(created.id, pathAtStart); onSaved(); },
        async () => {
          const recreated = await api.createSpecCase(projectId, { moduleId, title: created.title, preconditions: "", steps: [], priority: created.priority, status: created.status, tags: [] });
          applyLocalCase(recreated, pathAtStart);
          onSaved();
        },
      );
      const nodeId = `case:${created.id}`;
      if (unfiltered) applyLocalCase(created, pathAtStart);
      onSaved();
      setSelectedId(nodeId);
      /* 目标目录顺手展开（目录默认全开，这里只是防御被收起过的场景）。 */
      setClosedDirs((current) => {
        if (!current.has(moduleId)) return current;
        const next = new Set(current);
        next.delete(moduleId);
        return next;
      });
      /* 乐观图里节点是自己刚建的（id 即构造），建完即编辑不再等重取——
         等，正是连按时读到旧图的窗口（⑲）。有筛选时新用例多半不在图上，
         编辑输入交给重取后手动双击。 */
      if (unfiltered) setEdit({ nodeId, selectAll: true }); /* 占位标题全选，打字即覆盖 */
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      busyRef.current = false;
    }
  }

  /** Enter（同级目录）：parentId 缺省 = 顶层。占位名建完就地改名（㉔：
      目录添加在图内闭环；改名走 updateSpecModule 的最小提交）。可撤销（㉖）。 */
  async function createModule(parentId: string | undefined) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const created = await api.createSpecModule(projectId, { name: t("specCases.mindmapNewModule"), parentId: parentId ?? null });
      pushOp(
        async () => { await api.deleteSpecModule(projectId, created.id); onSaved(); },
        async () => { await api.createSpecModule(projectId, { name: created.name, parentId: parentId ?? null }); onSaved(); },
      );
      const nodeId = `dir:${created.id}`;
      /* 新目录先进 extraModules 立即上图（父表还没回来），改名输入直接开在
         它身上；onSaved 推 revision 让左树与计数跟上。 */
      setExtraModules((current) => {
        const next = new Map(current.map((module) => [module.id, module]));
        next.set(created.id, created);
        return [...next.values()];
      });
      onSaved();
      setSelectedId(nodeId);
      setEdit({ nodeId, selectAll: true });
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      busyRef.current = false;
    }
  }

  /** 「＋ 前置」占位节点 / Tab 在 add 节点：给没有前置的用例补占位前置并
      就地编辑（㉔：前置此前没有任何图内入口）。可撤销（㉖）。 */
  async function addPre(item: SpecCase) {
    if (busyRef.current) return;
    busyRef.current = true;
    const pathAtStart = modulePath;
    try {
      pushCasePatch(item, { preconditions: t("specCases.mindmapNewPre") });
      const updated = await api.updateSpecCase(projectId, item.id, { preconditions: t("specCases.mindmapNewPre") });
      applyLocalCase(updated, pathAtStart);
      const nodeId = `pre:${item.id}`;
      onSaved();
      setSelectedId(nodeId);
      setEdit({ nodeId, selectAll: true });
      setOpenCases((current) => new Set(current).add(item.id));
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      busyRef.current = false;
    }
  }

  /** 在 insertAt（0 起）插入一条占位步骤并进入编辑；用例顺手展开。只提交
      steps：并发中的标题/前置改动不被旧快照覆盖（⑲）。可撤销（㉖）。 */
  async function addStep(item: SpecCase, insertAt: number) {
    if (busyRef.current) return;
    busyRef.current = true;
    const pathAtStart = modulePath;
    const steps = [...item.steps];
    steps.splice(insertAt, 0, { step: t("specCases.mindmapNewStep"), expected: "" });
    try {
      pushCasePatch(item, { steps });
      const updated = await api.updateSpecCase(projectId, item.id, { steps });
      applyLocalCase(updated, pathAtStart);
      const nodeId = `step:${item.id}:${insertAt + 1}`;
      onSaved();
      setSelectedId(nodeId);
      setEdit({ nodeId, selectAll: true });
      setOpenCases((current) => new Set(current).add(item.id));
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      busyRef.current = false;
    }
  }

  /** 给没有预期的步骤补预期（步骤的子槽只有一个）。同样只提交 steps（⑲）。可撤销（㉖）。 */
  async function addExpected(item: SpecCase, stepIndex: number) {
    if (busyRef.current) return;
    busyRef.current = true;
    const pathAtStart = modulePath;
    const steps = item.steps.map((row, i) => i === stepIndex - 1 ? { ...row, expected: t("specCases.mindmapNewExpected") } : row);
    try {
      pushCasePatch(item, { steps });
      const updated = await api.updateSpecCase(projectId, item.id, { steps });
      applyLocalCase(updated, pathAtStart);
      const nodeId = `exp:${item.id}:${stepIndex}`;
      onSaved();
      setSelectedId(nodeId);
      setEdit({ nodeId, selectAll: true });
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      busyRef.current = false;
    }
  }

  /** Tab：加子级——目录/root→用例、用例→步骤、缺预期的步骤→预期、占位
      槽→补对应内容（㉔：目录层进图后，「在哪建用例」有了直接答案）。 */
  async function addChild(nodeId: string) {
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const { kind, caseItem, module, stepIndex, addKind } = node.data;
    if (kind === "root") return createCaseIn(rootModuleId);
    if (kind === "dir" && module) return createCaseIn(module.id);
    if (kind === "add" && caseItem) return addKind === "pre" ? addPre(caseItem) : addStep(caseItem, caseItem.steps.length);
    if (!caseItem) return;
    if (kind === "case") return addStep(caseItem, caseItem.steps.length);
    if (kind === "step" && stepIndex) {
      if (!caseItem.steps[stepIndex - 1]?.expected.trim()) return addExpected(caseItem, stepIndex);
      return;
    }
    if (kind === "pre" || kind === "exp") return addStep(caseItem, caseItem.steps.length);
  }

  /** Enter：加同级——目录/root→同级目录（全部用例 root→顶层目录）、用例→
      同模块用例、步骤/前置/预期→后续步骤、占位槽→补对应内容（㉔）。 */
  async function addSibling(nodeId: string) {
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const { kind, caseItem, module, stepIndex, addKind } = node.data;
    if (kind === "root") {
      /* 点中的目录做 root 时，同级 = 它的父级；全部用例 root 同级 = 顶层。 */
      const scopeModule = modulePath ? allModules.find((row) => row.path === modulePath) : undefined;
      return createModule(scopeModule?.parentId);
    }
    if (kind === "dir" && module) return createModule(module.parentId);
    if (kind === "add" && caseItem) return addKind === "pre" ? addPre(caseItem) : addStep(caseItem, caseItem.steps.length);
    if (!caseItem) return;
    if (kind === "case") return createCaseIn(caseItem.moduleId);
    if (kind === "step" || kind === "exp") return addStep(caseItem, stepIndex ?? caseItem.steps.length);
    if (kind === "pre") return addStep(caseItem, caseItem.steps.length);
  }

  /* ── 删除（㉕：选中 + Delete/Backspace）─────────────────────────────────
     分量级：用例/目录是资源级删除（Modal 确认，目录含用例时 409 后二次确
     认才 force）；前置/步骤/预期是字段编辑（直接落库，最小提交），和 XMind
     一样不打断——误删一行步骤的代价是重打一行，误删一个用例的代价是整条
     设计，确认只给后者。占位槽/root/more 不可删。 */
  /** 删除同样两处清（2026-09-08 第三轮反馈：Delete 后节点不消失的根因——行住
      在 moduleExtra 里，removeLocalCase 只滤 data.items，revision 重取又只换
      首页，追加页里的行永远删不掉）。 */
  function removeLocalCase(caseId: string, pathAtStart: string | undefined) {
    if (pathAtStart !== modulePathRef.current) return;
    setData((current) => ({
      ...current,
      total: Math.max(0, current.total - 1),
      items: current.items.filter((row) => row.id !== caseId),
    }));
    setModuleExtra((current) => {
      let changed = false;
      const next: Record<string, SpecCase[]> = {};
      for (const [key, rows] of Object.entries(current)) {
        const kept = rows.filter((row) => row.id !== caseId);
        if (kept.length !== rows.length) changed = true;
        next[key] = kept;
      }
      return changed ? next : current;
    });
  }

  /** 前置/步骤/预期：删的是用例内的一个字段位，PATCH 最小提交 + 即时合入
      （㉕ 复测：删除一律不弹确认，⌘Z 兜底）。可撤销（㉖）。 */
  async function deleteContentRow(item: SpecCase, stepIndex: number | undefined, field: "pre" | "step" | "exp") {
    if (busyRef.current) return;
    busyRef.current = true;
    const pathAtStart = modulePath;
    try {
      let input: SpecCaseInput;
      if (field === "pre") input = { preconditions: "" };
      else if (field === "step") input = { steps: item.steps.filter((_, index) => index !== stepIndex! - 1) };
      else input = { steps: item.steps.map((row, index) => index === stepIndex! - 1 ? { ...row, expected: "" } : row) };
      pushCasePatch(item, input);
      const updated = await api.updateSpecCase(projectId, item.id, input);
      applyLocalCase(updated, pathAtStart);
      setSelectedId(undefined);
      onSaved();
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      busyRef.current = false;
    }
  }

  /** 删用例（㉕ 复测：不弹确认）：本地行即时移除 + ⌘Z 兜底——撤销按保存的
      字段原样重建（新 id；编号是服务端自增身份，重建即新号，2026-09-07 反馈后
      编号不再随快照回填），键盘/菜单共用。 */
  async function deleteCaseNow(item: SpecCase) {
    if (busyRef.current) return;
    busyRef.current = true;
    const pathAtStart = modulePath;
    const input: SpecCaseInput = {
      moduleId: item.moduleId,
      title: item.title,
      preconditions: item.preconditions,
      steps: item.steps,
      priority: item.priority,
      status: item.status,
      tags: item.tags,
    };
    let currentId = item.id;
    try {
      await api.deleteSpecCase(projectId, item.id);
      pushOp(
        async () => {
          const recreated = await api.createSpecCase(projectId, input);
          currentId = recreated.id;
          applyLocalCase(recreated, pathAtStart);
          onSaved();
        },
        async () => { await api.deleteSpecCase(projectId, currentId); removeLocalCase(currentId, pathAtStart); onSaved(); },
      );
      removeLocalCase(item.id, pathAtStart);
      setSelectedId(undefined);
      onSaved();
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.deleteFailed"));
    } finally {
      busyRef.current = false;
    }
  }

  /** 删目录的本地清场：两处行集按**子树 moduleId 集**滤除（total 先按计数减，
      重取落地后对齐）。删除本体与 redo 共用——redo 删的是重建后的新子树，按
      闭包捕获的新 id 集清。 */
  function removeLocalModuleRows(moduleIds: Set<string>, count: number, pathAtStart: string | undefined) {
    if (pathAtStart !== modulePathRef.current) return;
    setData((current) => ({
      ...current,
      total: Math.max(0, current.total - count),
      items: current.items.filter((row) => !moduleIds.has(row.moduleId)),
    }));
    setModuleExtra((current) => {
      let changed = false;
      const next: Record<string, SpecCase[]> = {};
      for (const [key, rows] of Object.entries(current)) {
        const kept = rows.filter((row) => !moduleIds.has(row.moduleId));
        if (kept.length !== rows.length) changed = true;
        next[key] = kept;
      }
      return changed ? next : current;
    });
  }

  /** 删目录（㉕ 复测：不弹确认，直接 force——含用例也删）：先抓子树结构 +
      子树用例快照（分页上限 100），⌘Z 撤销时按快照整树重建（重建的目录与
      用例都是新 id，快照按旧 parentId/moduleId 逐层重挂）。本地清场 + 撤销
      合入见各行内注释（2026-09-08 第三轮：追加页里的行不随重取消失，目录
      节点撤下后它们会以「孤儿」身份挂回 root；重建的行也要即时上图）。 */
  async function deleteModuleNow(module: SpecModule) {
    if (busyRef.current) return;
    busyRef.current = true;
    const pathAtStart = modulePath;
    try {
      const subtree = allModules.filter((row) => row.path.startsWith(module.path));
      const snapshot = await api.specCasesPaged(projectId, { path: module.path, page: 1, pageSize: 100 });
      await api.deleteSpecModule(projectId, module.id, true);
      let currentRootId = module.id;
      /* redo 再删时按「重建后的新子树 id 集」清场（行已重挂到新目录下）；入栈
         时先按原子树初始化。 */
      let recreatedIds = new Set(subtree.map((row) => row.id));
      pushOp(
        async () => {
          /* 先建目录根，再按parentId映射逐层重建子目录，最后按 moduleId 映射重挂用例。
             每条重建的用例即时合入（新 id 不在两处行集里，走追加路径上图）。 */
          const moduleMap = new Map<string, string>();
          const root = await api.createSpecModule(projectId, { name: module.name, parentId: module.parentId });
          moduleMap.set(module.id, root.id);
          const ids = new Set<string>([root.id]);
          for (const row of subtree) {
            if (row.id === module.id) continue;
            const recreated = await api.createSpecModule(projectId, { name: row.name, parentId: moduleMap.get(row.parentId ?? "") ?? root.id });
            moduleMap.set(row.id, recreated.id);
            ids.add(recreated.id);
          }
          for (const caseRow of snapshot.items) {
            const recreated = await api.createSpecCase(projectId, {
              moduleId: moduleMap.get(caseRow.moduleId) ?? root.id,
              title: caseRow.title,
              preconditions: caseRow.preconditions,
              steps: caseRow.steps,
              priority: caseRow.priority,
              status: caseRow.status,
              tags: caseRow.tags,
            });
            applyLocalCase(recreated, pathAtStart);
          }
          recreatedIds = ids;
          currentRootId = root.id;
          onSaved();
        },
        async () => { await api.deleteSpecModule(projectId, currentRootId, true); removeLocalModuleRows(recreatedIds, snapshot.items.length, pathAtStart); onSaved(); },
      );
      removeLocalModuleRows(recreatedIds, snapshot.total, pathAtStart);
      setSelectedId(undefined);
      onSaved();
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.deleteFailed"));
    } finally {
      busyRef.current = false;
    }
  }

  /** 右键菜单（㉗）：标记优先级——最小提交 + 即时合入 + 可撤销。 */
  async function setCasePriority(item: SpecCase, priority: SpecCasePriority) {
    if (busyRef.current || priority === item.priority) return;
    busyRef.current = true;
    const pathAtStart = modulePath;
    try {
      pushCasePatch(item, { priority });
      const updated = await api.updateSpecCase(projectId, item.id, { priority });
      applyLocalCase(updated, pathAtStart);
      onSaved();
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      busyRef.current = false;
    }
  }

  /** 右键菜单（2026-09-08 反馈）：改用例状态——与优先级同一套纪律（最小提交 +
      即时合入 + 可撤销）；状态点（data-status）随合入立即换色。 */
  async function setCaseStatus(item: SpecCase, status: SpecCaseStatus) {
    if (busyRef.current || status === item.status) return;
    busyRef.current = true;
    const pathAtStart = modulePath;
    try {
      pushCasePatch(item, { status });
      const updated = await api.updateSpecCase(projectId, item.id, { status });
      applyLocalCase(updated, pathAtStart);
      onSaved();
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      busyRef.current = false;
    }
  }

  /** 右键菜单（㉗）：添加标签——Modal 里逗号分隔录入，语义与抽屉一致。 */
  const [tagsTarget, setTagsTarget] = useState<SpecCase>();
  const [tagsDraft, setTagsDraft] = useState("");
  const tagsIme = useImeGuard();

  /* 右键「绑定自动化」（P7-6，2026-09-08 反馈）：脑图里给用例绑自动化资产，
     不必切回列表开抽屉。打开前现拉一次详情——选择器要 `existing`（已绑清单，
     置灰重复项），画布行的 SpecCase 没带 links（列表行不带，读时成本高的那份
     只在详情读法里）。挂载即 open（同 ModuleRenameModal 的按需挂载约定）。 */
  const [linkTarget, setLinkTarget] = useState<{ caseId: string; links: SpecCaseLink[] }>();
  async function openLinkPicker(item: SpecCase) {
    try {
      const detail = await api.specCase(projectId, item.id);
      setLinkTarget({ caseId: item.id, links: detail.links ?? [] });
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.loadFailed"));
    }
  }

  /* 右键菜单（㉗）：条目按节点种类自动生成——加什么、删什么、能不能标记
      优先级/标签由选中节点的种类唯一决定；动作与键位（Tab/Enter/Delete）走
      同一套路由，菜单是显式入口、键位是肌肉记忆入口。 */
  const [menu, setMenu] = useState<{ nodeId: string; x: number; y: number }>();
  useEffect(() => {
    if (!menu) return;
    function close(event: MouseEvent) {
      if (!(event.target as HTMLElement).closest(".mindmap-menu")) setMenu(undefined);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenu(undefined);
    }
    /* 监听挂**捕获阶段**（2026-09-08 反馈：点画布关不掉菜单）：画布的 mousedown
       被 d3-zoom 的 nopropagation 截在目标层（zoom.js mousedowned，平移手势
       拦截冒泡），冒泡阶段的 document 监听根本收不到「点画布」这一下。捕获先
       于目标处理派发，stopPropagation 拦不住；Esc 顺带可关（编辑态的 Esc 由
       MindEditInput 自己 stopPropagation，不会误伤）。 */
    document.addEventListener("mousedown", close, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  /* children = 悬停展开的子菜单（2026-09-08 第三轮反馈：菜单太长，优先级/状态
     收进子菜单）；current 标记当前值（勾 + accent 字色）。 */
  type MenuItem = { key: string; label: string; danger?: boolean; current?: boolean; children?: MenuItem[]; onClick?: () => void };
  function menuItemsFor(nodeId: string): MenuItem[] {
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) return [];
    const { kind, caseItem, module, stepIndex } = node.data;
    const items: MenuItem[] = [];
    if (kind === "root") {
      if (rootModuleId) items.push({ key: "case", label: t("specCases.mindmapMenuAddCase"), onClick: () => void createCaseIn(rootModuleId) });
      items.push({ key: "module", label: t("specCases.mindmapMenuAddModule"), onClick: () => void createModule(modulePath ? allModules.find((row) => row.path === modulePath)?.parentId : undefined) });
      return items;
    }
    if (kind === "dir" && module) {
      items.push({ key: "module", label: t("specCases.mindmapMenuAddSubmodule"), onClick: () => void createModule(module.id) });
      items.push({ key: "case", label: t("specCases.mindmapMenuAddCase"), onClick: () => void createCaseIn(module.id) });
      items.push({ key: "del", label: t("specCases.mindmapMenuDeleteModule"), danger: true, onClick: () => void deleteModuleNow(module) });
      return items;
    }
    if (kind === "case" && caseItem) {
      items.push({ key: "step", label: t("specCases.mindmapMenuAddStep"), onClick: () => void addStep(caseItem, caseItem.steps.length) });
      items.push({ key: "case", label: t("specCases.mindmapMenuAddCase"), onClick: () => void createCaseIn(caseItem.moduleId) });
      items.push({ key: "tags", label: t("specCases.mindmapMenuTags"), onClick: () => { setTagsDraft(caseItem.tags.join(", ")); setTagsTarget(caseItem); } });
      /* 绑定自动化（P7-6，2026-09-08 反馈）：与标签同一层级——都是「给这条用例
         挂元信息」的动作；放在优先级/状态子菜单之前，属于高频内容操作。 */
      if (canWrite) items.push({ key: "link", label: t("specCases.mindmapMenuLink"), onClick: () => void openLinkPicker(caseItem) });
      /* 优先级/状态收进子菜单（2026-09-08 第三轮反馈：用例菜单 12 行太长）——
         当前值打勾标出，子项动作与键位同一套路由；当前态再点是 no-op（相等
         短路在 setCasePriority / setCaseStatus 里）。 */
      items.push({
        key: "pri",
        label: t("specCases.mindmapMenuPriority"),
        children: (["P0", "P1", "P2", "P3"] as const).map((priority) => ({
          key: `pri-${priority}`,
          label: priority,
          current: priority === caseItem.priority,
          onClick: () => void setCasePriority(caseItem, priority),
        })),
      });
      items.push({
        key: "st",
        label: t("specCases.mindmapMenuStatus"),
        children: (["unreviewed", "reviewed", "deprecated"] as const).map((status) => ({
          key: `st-${status}`,
          label: t(`specCases.status_${status}`),
          current: status === caseItem.status,
          onClick: () => void setCaseStatus(caseItem, status),
        })),
      });
      items.push({ key: "del", label: t("specCases.mindmapMenuDeleteCase"), danger: true, onClick: () => void deleteCaseNow(caseItem) });
      return items;
    }
    if (kind === "step" && caseItem && stepIndex) {
      if (!caseItem.steps[stepIndex - 1]?.expected.trim()) {
        items.push({ key: "exp", label: t("specCases.mindmapMenuAddExpected"), onClick: () => void addExpected(caseItem, stepIndex) });
      }
      items.push({ key: "step", label: t("specCases.mindmapMenuAddStepAfter"), onClick: () => void addStep(caseItem, stepIndex) });
      items.push({ key: "del", label: t("specCases.mindmapMenuDeleteStep"), danger: true, onClick: () => void deleteContentRow(caseItem, stepIndex, "step") });
      return items;
    }
    if (kind === "pre" && caseItem) {
      items.push({ key: "del", label: t("specCases.mindmapMenuDeletePre"), danger: true, onClick: () => void deleteContentRow(caseItem, undefined, "pre") });
      return items;
    }
    if (kind === "exp" && caseItem && stepIndex) {
      items.push({ key: "del", label: t("specCases.mindmapMenuDeleteExpected"), danger: true, onClick: () => void deleteContentRow(caseItem, stepIndex, "exp") });
      return items;
    }
    return [];
  }
  async function saveTags() {
    const item = tagsTarget;
    if (!item) { setTagsTarget(undefined); return; }
    const tags = tagsDraft.split(",").map((tag) => tag.trim()).filter(Boolean);
    setTagsTarget(undefined);
    if (tags.join(",") === item.tags.join(",")) return;
    if (busyRef.current) return;
    busyRef.current = true;
    const pathAtStart = modulePath;
    try {
      pushCasePatch(item, { tags });
      const updated = await api.updateSpecCase(projectId, item.id, { tags });
      applyLocalCase(updated, pathAtStart);
      onSaved();
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      busyRef.current = false;
    }
  }

  /** Delete/Backspace 的路由：种类决定删除语义（资源级 / 字段级），全部
      直接删、⌘Z 兜底（㉕ 复测 + ㉖）。 */
  function deleteNode(nodeId: string) {
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const { kind, caseItem, module, stepIndex } = node.data;
    if (kind === "case" && caseItem) return void deleteCaseNow(caseItem);
    if (kind === "dir" && module) return void deleteModuleNow(module);
    if (kind === "pre" && caseItem) return void deleteContentRow(caseItem, undefined, "pre");
    if (kind === "step" && caseItem && stepIndex) return void deleteContentRow(caseItem, stepIndex, "step");
    if (kind === "exp" && caseItem && stepIndex) return void deleteContentRow(caseItem, stepIndex, "exp");
  }

  /* Tab / Enter / Delete / ⌘Z 只作用于脑图自己的选中节点；输入框（筛选栏、
     编辑框）里的按键一律不管——焦点在表单元素上时不劫持（⌘Z 在编辑框里是
     文本撤销，交给浏览器）。动作在途（busyRef）时同样不响应：连按会带着
     同一份旧图发两次请求（⑲）。Backspace 与 Delete 等同（Mac 键盘没有独立
     Delete，Backspace 就是删除键）。 */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        if (!canWrite || edit || busyRef.current) return;
        event.preventDefault();
        void (event.shiftKey ? redoOp() : undoOp());
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        if (!canWrite || edit || busyRef.current) return;
        event.preventDefault();
        void redoOp();
        return;
      }
      if (!canWrite || edit || !selectedId || busyRef.current) return;
      if (event.key === "Tab") { event.preventDefault(); void addChild(selectedId); }
      else if (event.key === "Enter") { event.preventDefault(); void addSibling(selectedId); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteNode(selectedId); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  /* 节点对象是 React Flow 的判等边界（㉓ 白屏根因）：引用一换，内部 measured/
      handleBounds 整重置，节点回未测量态（visibility:hidden、连线消失）。因此：
      ① 数组按 [graph, selectedId, edit] memo——loading 翻转这类无关渲染不再
      触发 store 同步；② 每个节点把 store 里的 measured 随身带回——真换代时
      adoptUserNodes 沿用测量结果与 handleBounds，节点不闪没；③ **渲染等价的
      节点把上一代的旧对象原样送回**（2026-09-08 折叠空白修复）：折叠/展开目录
      时全图节点被逐个重建引用，幸存节点也被打进慢路径重置；引用稳定后没变的
      节点不再经过重置，ResizeObserver 恢复竞态的风险面收缩到真正变化的节点。 */
  const prevNodesRef = useRef<MindFlowNode[]>([]);
  const nodes = useMemo(() => {
    const lookup = store.getState().nodeLookup;
    const prev = new Map(prevNodesRef.current.map((node) => [node.id, node]));
    const next = graph.nodes.map((node) => {
      const measured = lookup.get(node.id)?.measured;
      const candidate: MindFlowNode = {
        ...node,
        selected: node.id === selectedId,
        measured,
        /* editing 只在**编辑开始时**变化（seed = 节点当前 label）——按键期间的
           文本是 MindEditInput 的本地草稿，不经过这里（㊴：经 store 往返的
           value 会被 React 的受控回写拆掉输入法组合）。 */
         data: node.id === edit?.nodeId
           ? {
             ...node.data,
             editing: node.data.label,
             selectAll: edit.selectAll,
             onCommit: (value: string) => { void commitEdit(value); },
             onCancel: cancelEdit,
           }
           : node.data,
      };
      const before = prev.get(node.id);
      return before && sameMindNode(before, candidate) ? before : candidate;
    });
    prevNodesRef.current = next;
    return next;
  }, [graph, selectedId, edit, store]);

  if (loading && data.items.length === 0) {
    return <p className="muted" style={{ padding: 8 }}>{t("common.loading")}…</p>;
  }
  /* 空态的判定要算上目录层（㉔）：有目录没用例时图上仍有结构可看可建，
     只有范围内既无目录也无用例才是真空。 */
  const hasStructure = allModules.some((module) => !modulePath || module.path === modulePath || module.path.startsWith(modulePath));
  if (data.items.length === 0 && !hasStructure) {
    const filtered = Boolean(keyword || modulePath || priority !== "all" || status !== "all");
    return <Empty
      title={filtered ? t("specCases.emptySearchTitle") : t("specCases.emptyTitle")}
      hint={filtered ? t("specCases.emptySearchHint") : t("specCases.emptyHint")}
    />;
  }

  return <div className="mindmap-canvas">
    {/* 键位提示（⑳ 复测：添加规则无处可学，用户无从知道 Tab 会建什么）。
        静态一行字，pointer-events:none 不挡平移；只读视角没有键盘添加，不显示。 */}
    {canWrite && <div className="mindmap-hint">{t("specCases.mindmapHint")}</div>}
    <ReactFlow
      nodes={nodes}
      edges={graph.edges}
      nodeTypes={NODE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
      zoomOnDoubleClick={false}
      /* 脑图是自动布局：拖动会跟布局打架，连线条数就是层级本身。 */
      onNodeClick={(event, node) => {
        /* ⊕/⊖ 是折叠开关；「＋ …」占位槽点了就补；「加载更多」按目录取下一批
           （只读视角也能加载——它是读操作不是编辑）；节点本体单击 = 选中（XMind 惯例）。 */
        if ((event.target as HTMLElement).closest(".mindmap-toggle")) {
          toggleNode(node.id);
          return;
        }
        if (node.data.kind === "more" && node.data.module) {
          void loadMoreCases(node.data.module);
          return;
        }
        if (node.data.kind === "add" && node.data.caseItem && canWrite) {
          if (node.data.addKind === "pre") void addPre(node.data.caseItem);
          else void addStep(node.data.caseItem, node.data.caseItem.steps.length);
          return;
        }
        setSelectedId(node.id);
      }}
      onNodeDoubleClick={(_event, node) => {
        if (node.data.kind === "root" || node.data.kind === "more") return;
        if (node.data.kind === "add" && node.data.caseItem && canWrite) {
          if (node.data.addKind === "pre") void addPre(node.data.caseItem);
          else void addStep(node.data.caseItem, node.data.caseItem.steps.length);
          return;
        }
        /* 目录的双击改名等 P7-6 完整管理面（改名牵动 scope path 的场景需要
           父组件配合换筛）；存量节点里只有用例内容族支持就地编辑。 */
        if (node.data.kind === "dir") return;
        if (!canWrite) {
          /* viewer 双击用例 = 打开只读抽屉看全量字段。 */
          if (node.data.kind === "case" && node.data.caseItem) onOpenCase(node.data.caseItem);
          return;
        }
        startEdit(node.id);
      }}
      onPaneClick={() => setSelectedId(undefined)}
      onNodeContextMenu={(event, node) => {
        /* 右键 = 显式菜单（㉗）：条目按节点种类生成，见 menuItemsFor；
           viewer 保留浏览器默认菜单，占位槽/more 没有菜单。 */
        if (!canWrite) return;
        if (node.data.kind === "add" || node.data.kind === "more") return;
        event.preventDefault();
        setSelectedId(node.id);
        setMenu({ nodeId: node.id, x: event.clientX, y: event.clientY });
      }}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
    {menu && (() => {
      /* 右缘翻转：菜单贴着窗口右边打开时，子菜单向左伸（避免溢出屏幕外）。 */
      const left = Math.min(menu.x, window.innerWidth - 200);
      const flip = left > window.innerWidth - 380;
      return <div className={`mindmap-menu${flip ? " is-flip" : ""}`} style={{ left, top: Math.min(menu.y, window.innerHeight - 260) }} role="menu">
        {menuItemsFor(menu.nodeId).map((item) => item.children ? (
          <div key={item.key} className="mindmap-subwrap">
            <button type="button" className="mindmap-menu-item has-sub">
              <span>{item.label}</span>
              {flip ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
            </button>
            <div className="mindmap-submenu" role="menu">
              {item.children.map((child) => (
                <button key={child.key} type="button" className={`mindmap-menu-item${child.current ? " is-current" : ""}`} onClick={() => { setMenu(undefined); child.onClick?.(); }}>
                  <span>{child.label}</span>
                  {child.current && <Check size={12} className="mindmap-menu-check" />}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button key={item.key} type="button" className={`mindmap-menu-item${item.danger ? " is-danger" : ""}`} onClick={() => { setMenu(undefined); item.onClick?.(); }}>{item.label}</button>
        ))}
      </div>;
    })()}
    <Modal
      open={Boolean(tagsTarget)}
      title={t("specCases.mindmapTagsTitle")}
      okText={t("action.save")}
      cancelText={t("action.cancel")}
      onOk={() => void saveTags()}
      onCancel={() => setTagsTarget(undefined)}
      destroyOnHidden
    >
      <p className="muted">{t("specCases.mindmapTagsHint")}</p>
      <Input value={tagsDraft} onChange={(event) => setTagsDraft(event.target.value)} placeholder={t("specCases.mindmapTagsPlaceholder")}
        /* 不用 onPressEnter：antd 不滤输入法组合期，回车选字会提前保存截断中文
            （与就地编辑同一缺陷类，2026-09-07 反馈一并修；守卫同 ㊲——组合事件
            跟踪 + 选字键窗口，不再裸查 229）。 */
        onCompositionStart={tagsIme.onCompositionStart}
        onCompositionEnd={tagsIme.onCompositionEnd}
        onKeyDown={(event) => {
          if (tagsIme.isImeKey(event, ["Enter"])) return;
          if (event.key === "Enter") { event.preventDefault(); void saveTags(); }
        }} />
    </Modal>

    {/* 绑定选择器（P7-6）：右键「绑定自动化」挂载即开；onLinked 就地合入本地
        links（选择器置灰新绑定不重拉）+ onSaved 推 revision（计数/覆盖率刷新）。 */}
    {canWrite && linkTarget && <SpecLinkPicker
      projectId={projectId}
      caseId={linkTarget.caseId}
      open
      existing={linkTarget.links}
      onClose={() => setLinkTarget(undefined)}
      onLinked={(link) => {
        setLinkTarget((current) => current ? { ...current, links: [...current.links, link] } : current);
        onSaved();
      }}
    />}
  </div>;
}
