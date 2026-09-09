import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { Drawer, Modal, Pagination, Select, TreeSelect, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { Dropdown, type MenuProps } from "antd";
import { ChevronDown, ChevronRight, Download, FileDown, Folder, FolderPlus, ListTree, Network, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, type Paged, type SpecCase, type SpecCaseInput, type SpecCaseLink, type SpecCasePriority, type SpecCaseStatus, type SpecCaseStep, type SpecExportFormat, type SpecModule, type TestPlan } from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import { useDebounced } from "../hooks/useDebounced";
import { saveBlob } from "../lib/download";
import { Empty, Status, Tip, toRunStatus, type RunStatus } from "../ui";
import { IconButton } from "./IconButton";
import { SpecImportModal } from "./SpecImportModal";
import { SpecLinkPicker } from "./SpecLinkPicker";
import { SpecMindMap } from "./SpecMindMap";
import { apiMessage } from "./DataSourceList";

const PAGE_SIZES = [20, 50, 100];
const PRIORITIES: SpecCasePriority[] = ["P0", "P1", "P2", "P3"];
const STATUSES: SpecCaseStatus[] = ["unreviewed", "reviewed", "deprecated"];

/** antd TreeSelect 节点：value 用模块 id（改名后仍稳定）。 */
type ModuleNode = { value: string; title: string; children?: ModuleNode[] };

/** 左侧树的节点：要整行 SpecModule（path 悬停、子树计数、展开/选中状态）。 */
type SpecModuleNode = { module: SpecModule; children: SpecModuleNode[] };

/**
 * 接口按 path 排序返回（P7-1）：父模块永远先于子模块出现，一遍挂接即可成森林。
 * 同级排序（P7-6 调序）：(position, name)——position 是树接口带回的手工调序值，
 * 同位（缺省 0）时按名字稳定排。子树的 path 前缀排序只保证父子顺序，同级顺序
 * 在这里补——脑图视图（SpecMindMap 的 childrenByParent）用同一把尺，两视图
 * 同级不换位（与用例行序共用同一序的纪律同款）。
 */
function sortSiblings(nodes: SpecModuleNode[]): SpecModuleNode[] {
  nodes.sort((a, b) => a.module.position - b.module.position || a.module.name.localeCompare(b.module.name));
  return nodes;
}

function buildSpecModuleTree(modules: SpecModule[]): SpecModuleNode[] {
  const roots: SpecModuleNode[] = [];
  const byId = new Map<string, SpecModuleNode>();
  for (const module of modules) {
    const node: SpecModuleNode = { module, children: [] };
    byId.set(module.id, node);
    const parent = module.parentId ? byId.get(module.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  /* 每层的兄弟排序在挂接完成后做一遍（后序也成立——排序不依赖孩子顺序）。 */
  const walk = (nodes: SpecModuleNode[]) => {
    for (const node of nodes) walk(node.children);
    sortSiblings(nodes);
  };
  walk(roots);
  return roots;
}

function toTreeSelectData(nodes: SpecModuleNode[]): ModuleNode[] {
  return nodes.map(({ module, children }) => ({
    value: module.id,
    title: module.name,
    ...(children.length ? { children: toTreeSelectData(children) } : {}),
  }));
}

/**
 * 拍平表里 module 的同级序列（含自己，按 (position, name) 排）：拖拽重排要在
 * 「刚移过去的最新树」上算目标层的完整顺序，树森林版的 findSiblings 在这里用
 * 不上（移完的拖行已在层里）。空 parent（顶层）也在序列里对齐。
 */
function layerSiblings(flat: SpecModule[], module: SpecModule): SpecModule[] {
  const parentId = module.parentId ?? null;
  return flat
    .filter((row) => (row.parentId ?? null) === parentId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** '/模块A/子模块/' → '模块A/子模块'：列里展示去掉首尾分隔符，窄列少占一档。 */
function formatPath(path: string | undefined): string {
  if (!path) return "—";
  return path.replace(/^\//, "").replace(/\/$/, "");
}

/** 生命周期三态映射到 Status 色表（㉘）：reviewed→pass、unreviewed→skip、deprecated→canceled。 */
function statusView(status: SpecCaseStatus): RunStatus {
  if (status === "reviewed") return "pass";
  if (status === "unreviewed") return "skip";
  return "canceled";
}

/**
 * 步骤行的网格模板（表头与数据行共用一份，inline 覆盖 `.kv-row` 的 auto 列）：
 * `.kv-row` 每行是独立 grid，auto 列各自按内容算宽，表头与数据行会错位；钉死
 * 序号 18px / 删除 30px（`.icon-btn` 的宽）后列界必然对齐。
 */
const STEP_ROW_GRID: CSSProperties = { gridTemplateColumns: "18px minmax(0, 1fr) minmax(0, 1.4fr) 30px" };

/**
 * 自动长高的 textarea（步骤 / 预期 / 前置共用，2026-09-07 用户反馈）：长内容换行
 * 不截断（单行 input 的右侧溢出看不见），短内容只占一行高度（固定 rows=2 的前置
 * 框为一条脏数据白占两行）。高度由内容驱动；resize 手柄关掉——手动拖出的高度
 * 会在下一次内容变化时被滚动高度覆盖，留着只会误导。
 */
function AutoGrowTextarea({ value, onChange, placeholder, ariaLabel, disabled }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  /* 量高（⑧：height 先归 auto，再补回 border-box 差掉的上下边框）。元素不在
     渲染树（祖先 display:none）时 scrollHeight 恒为 0——照写就是 2px 细线
     （㊲：antd 抽屉关闭后内容仍留在 DOM，换例重开时表单在隐藏态被换值，前置/
     步骤框全被写成细线，看起来「折叠在一起」）。此时跳过、记为待办，等盒子
     真出现再补量。 */
  const pendingRef = useRef(false);
  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    if (node.offsetWidth === 0) { pendingRef.current = true; return; }
    node.style.height = "auto";
    const borders = node.offsetHeight - node.clientHeight;
    node.style.height = `${node.scrollHeight + borders}px`;
    pendingRef.current = false;
  }, []);

  useLayoutEffect(() => { measure(); }, [value, measure]);

  /* 盒子出现（display:none 解除）或宽度变化（窗口缩放改变了换行数）时重量一
     次：[value] 依赖量不到这类「值没变、排版变了」。自己改 height 也会触发
     observer——宽度没变就跳过，不会成环。 */
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let width = node.offsetWidth;
    const observer = new ResizeObserver(() => {
      const next = node.offsetWidth;
      const reflow = next > 0 && (next !== width || pendingRef.current);
      width = next;
      if (reflow) measure();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  return <textarea
    ref={ref}
    className="input"
    rows={1}
    value={value}
    placeholder={placeholder}
    aria-label={ariaLabel}
    disabled={disabled}
    onChange={(event) => onChange(event.target.value)}
    style={{ resize: "none" }}
  />;
}

/**
 * 新建模块弹窗（左侧树面板与用例抽屉共用）：树面板负责从零搭结构，抽屉里建完
 * 即选中往里录用例——两个入口同一套校验与提示（深度 / `/` 限制在后端 P7-1）。
 */
function ModuleCreateModal({ projectId, open, modules, onClose, onCreated }: {
  projectId: string;
  open: boolean;
  modules: ModuleNode[];
  onClose: () => void;
  onCreated: (module: SpecModule) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string>();
  const [creating, setCreating] = useState(false);

  /* 每次打开重置：上一次没提交就关掉的名字，不该悄悄留给下一次。 */
  useEffect(() => { if (open) { setName(""); setParentId(undefined); } }, [open]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) { message.error(t("specCases.moduleNameRequired")); return; }
    setCreating(true);
    try {
      const created = await api.createSpecModule(projectId, { name: trimmed, parentId: parentId ?? null });
      message.success(t("specCases.moduleCreated"));
      onClose();
      onCreated(created);
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.moduleCreateFailed"));
    } finally {
      setCreating(false);
    }
  }

  return <Modal
    title={t("specCases.createModuleTitle")}
    open={open}
    /* zIndex 压过 Drawer（1000）：抽屉里的「新建模块」入口也用这一个组件。 */
    zIndex={1100}
    okText={t("action.create")}
    cancelText={t("action.cancel")}
    okButtonProps={{ disabled: !name.trim() || creating }}
    confirmLoading={creating}
    onOk={() => void create()}
    onCancel={onClose}
  >
    <label className="field"><span>{t("specCases.moduleName")}</span><input autoFocus className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="field"><span>{t("specCases.moduleParent")}</span>
      <TreeSelect
        value={parentId}
        onChange={(value: string | undefined) => setParentId(value)}
        onClear={() => setParentId(undefined)}
        treeData={modules}
        treeDefaultExpandAll
        allowClear
        placeholder={t("specCases.moduleParentTop")}
        style={{ width: "100%" }}
      />
    </label>
    <p className="form-note">{t("specCases.moduleDepthHint")}</p>
  </Modal>;
}

/**
 * 目录改名弹窗（2026-09-07 反馈：新建撞「同层同名」后，界面上没有任何改名出路）。
 * 只改名字不动父级——后端一条 UPDATE 连整棵子树的物化 path 换前缀；改名牵动右表
 * 的 path 筛，落地回调里由父组件把旧前缀换成新前缀（onRenamed）。
 */
function ModuleRenameModal({ projectId, module, onClose, onRenamed }: {
  projectId: string;
  module: SpecModule;
  onClose: () => void;
  onRenamed: (updated: SpecModule) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(module.name);
  const [saving, setSaving] = useState(false);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { message.error(t("specCases.moduleNameRequired")); return; }
    /* 名字没动 = 用户只是看了一眼：关掉即完成，不打后端。 */
    if (trimmed === module.name) { onClose(); return; }
    setSaving(true);
    try {
      const updated = await api.updateSpecModule(projectId, module.id, { name: trimmed });
      message.success(t("specCases.moduleRenamed"));
      onClose();
      onRenamed(updated);
    } catch (error) {
      /* 409（目标路径被占）等服务端话术直接透传，apiMessage 拿不到才用兜底。 */
      message.error(apiMessage(error) ?? t("specCases.moduleRenameFailed"));
    } finally {
      setSaving(false);
    }
  }

  return <Modal
    title={t("specCases.renameModuleTitle")}
    /* 组件按 renaming 条件挂载，open 恒真——但 antd Modal 的 open 缺省是 false，
       不传就是「点了没反应」（2026-09-07 反馈踩中）。 */
    open
    zIndex={1100}
    okText={t("action.save")}
    cancelText={t("action.cancel")}
    okButtonProps={{ disabled: !name.trim() || saving }}
    confirmLoading={saving}
    onOk={() => void save()}
    onCancel={onClose}
  >
    <label className="field"><span>{t("specCases.moduleName")}</span><input autoFocus className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
    <p className="form-note">{t("specCases.moduleDepthHint")}</p>
  </Modal>;
}

/**
 * 用例库（P7-2 列表 + P7-3 树导航，计划 11.3；2026-09-07 第二轮反馈后定为**经典
 * 左右分栏**）：左侧常驻模块树做导航，右侧表格只专注用例——点一个目录，右表只出
 * 该目录（含子级，path 前缀筛）下的用例；「全部用例」回到全库。
 *
 * 视图只剩两档（2026-09-07 第四/五轮反馈）：**列表**（右表，默认）与**脑图**
 * （XMind 风格，SpecMindMap）——原 tree/list 平表切换删除；树面板在两个视图里
 * 都原样常驻，切换只换右侧。脑图解析**当前目录下的用例**（root = 当前目录 →
 * 用例 → 前置/步骤/预期），不把模块树画进去。勾选集跨视图共享。
 *
 * 文本用例是第三类用例资产：只有设计内容（标题/前置/步骤/预期），平台不执行它。
 * 绑定区与「已自动化」列在 P7-6（原 P7-3）；「加入计划」批量入口已随 P7-7 落地。
 */
export function SpecCases() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const canWrite = useCanWrite();
  const [searchParams, setSearchParams] = useSearchParams();

  /* 旧地址里的 ?view=tree|list 都归入分栏列表（它们都是表格视图）；只有
     view=mindmap 进脑图——书签不失效，语义只往前走。 */
  const [view, setView] = useState<"list" | "mindmap">(searchParams.get("view") === "mindmap" ? "mindmap" : "list");
  const [keyword, setKeyword] = useState(searchParams.get("keyword") ?? "");
  const debouncedKeyword = useDebounced(keyword);
  const [modulePath, setModulePath] = useState(searchParams.get("path") ?? undefined);
  /* URL 里来的字符串断言到受限枚举：渲染假值顶多显示错一项，不会崩（深链
      手改 URL 的兜底口径与执行记录页同款）。 */
  const [priority, setPriority] = useState<SpecCasePriority | "all">((searchParams.get("priority") as SpecCasePriority | "all") ?? "all");
  const [status, setStatus] = useState<SpecCaseStatus | "all">((searchParams.get("status") as SpecCaseStatus | "all") ?? "all");
  /* 已自动化筛选（P7-6 起进 UI——P7-2 时刻意不进：「一个永远筛不出东西的过滤器
      是谎言」；绑定写端落地后它有真实内容了）。语义与覆盖口径同一表达式：
      有 ≥1 条非 endpoint 绑定。 */
  const [automation, setAutomation] = useState<"all" | "yes" | "no">((searchParams.get("automation") as "all" | "yes" | "no") ?? "all");
  const [page, setPage] = useState(Number(searchParams.get("page") ?? 1));
  const [pageSize, setPageSize] = useState(Number(searchParams.get("pageSize") ?? 20));

  const [modules, setModules] = useState<SpecModule[]>([]);
  const [modulesLoading, setModulesLoading] = useState(true);
  const [data, setData] = useState<Paged<SpecCase>>({ items: [], page: 1, pageSize: 20, total: 0 });
  const [loading, setLoading] = useState(true);
  /* editing 只存「意图」：新建 | 用例 id。行对象不进 state——列表行是当次查询
     的快照，脑图就地编辑落库后（⑰）再从列表/脑图点开同一条，闭包里还
     是改动前的旧对象，抽屉展示与库不一致。抽屉挂载时按 id 现拉详情，永远最新。 */
  const [editing, setEditing] = useState<string | "new">();

  /* ── 勾选集（跨视图共享，按用例 id 存） ───────────────────────────────────
     换页 / 改筛选 / 切视图**都不清空**（RepoCaseTree 同款）：跨模块整理的正常路径
     就是「先选一批、再换地方继续选」；清空时机只有批量条上的 × 与批量动作落地。
     切项目必须清——跨项目勾选没有意义。 */
  const [selected, setSelected] = useState<Set<string>>(new Set());

  /* 左侧树的展开集（纯折叠，无懒载——模块森林一次全量，用例永远走右表的服务端分页）。 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /* 任何一次落库（单条建/改/删、批量动作）都推进 revision：右表、模块树计数两处
     读数统一重取——分散在各自回调里刷新迟早漏一处。 */
  const [revision, setRevision] = useState(0);

  /* 左侧树面板的「新建模块」入口（抽屉里有自己的那一个，共用同一个组件）。 */
  const [moduleModalOpen, setModuleModalOpen] = useState(false);

  /* 左侧树面板的「重命名模块」入口（2026-09-07 反馈）：存整行旧模块——落地后
      还要用旧 path 修右表的 path 筛。 */
  const [renaming, setRenaming] = useState<SpecModule>();

  /* 拖拽请求在途（P7-6 拖拽版）：拖行 draggable 收掉，防第二拖与落点写抢同一行。 */
  const [moduleBusy, setModuleBusy] = useState(false);

  /* 导入向导（P7-4/P7-5）：XMind / Excel 两阶段导入的入口；落地后 revision 统一刷新三处读数。 */
  const [importOpen, setImportOpen] = useState(false);

  /* 导出（2026-09-08 用户要求）：**勾选集优先**（2026-09-08 第二轮反馈——勾了就
     导勾的，与批量条同一心智；勾选集跨视图共享）；没勾选 = 按当前筛选（点中的
     目录含子级或「全部用例」）。viewer 也可导——纯读操作。busy 态只挡重复点击。 */
  const [exporting, setExporting] = useState<SpecExportFormat>();
  const runExport = useCallback(async (format: SpecExportFormat) => {
    if (!projectId || exporting) return;
    setExporting(format);
    try {
      const blob = await api.exportSpecCases(
        projectId,
        format,
        {
          keyword: debouncedKeyword,
          path: modulePath,
          priority: priority === "all" ? undefined : (priority as SpecCasePriority),
          status: status === "all" ? undefined : (status as SpecCaseStatus),
          automation: automation === "all" ? undefined : automation,
        },
        selected.size ? [...selected] : undefined,
      );
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      saveBlob(blob, t("specCases.exportName", { date: stamp, ext: format === "xmind" ? "xmind" : "xlsx" }));
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.exportFailed"));
    } finally {
      setExporting(undefined);
    }
  }, [projectId, exporting, debouncedKeyword, modulePath, priority, status, automation, selected, t]);
  const exportItems: MenuProps["items"] = [
    { key: "xmind", label: t("specCases.exportXmind") },
    { key: "excel", label: t("specCases.exportExcel") },
  ];
  /* 悬停提示落到具体范围（三态）：勾选集（跨视图）> 点中的目录（含子级）>
     「全部用例」（modulePath 为空 = 树顶「全部用例」节点选中，不是「未选」）。
     筛选态的条数直接用右表 total——列表与导出走同一套筛选参数，total 就是
     服务端全量命中数（分页前的真总数）。 */
  const exportTip = selected.size
    ? t("specCases.exportScopeSelection", { count: selected.size })
    : modulePath
      ? t("specCases.exportScopeModule", { module: formatPath(modulePath), count: data.total })
      : t("specCases.exportScopeAll", { count: data.total });

  /* 抽屉/脑图的关闭与落库回调提为**稳定身份**（㉑ 复测）：内联箭头函数每次
     渲染都新建，抽屉的详情 effect 依赖 onClose——身份一换就重拉详情并把表单
     重置回库值，正在输入的内容被吃掉（读作「信息错乱」）。 */
  const closeCaseDrawer = useCallback(() => setEditing(undefined), []);
  const bumpRevision = useCallback(() => setRevision((current) => current + 1), []);

  const loadModules = useCallback(() => {
    if (!projectId) return;
    api.specModules(projectId).then((fresh) => {
      /* 保留内容未变行的旧引用（2026-09-08 第三轮反馈：每次落库 revision 重取
         整页换对象，脑图目录节点的 module 引用全断——sameMindNode 全图失效，
         目录行跟着闪；用例行的同款修法在 SpecMindMap 的取数 effect 里）。
         caseCount 是读时计数、不随落库推 updated_at，按渲染相关字段逐项判等。 */
      setModules((current) => {
        if (!current.length) return fresh;
        const local = new Map(current.map((row) => [row.id, row]));
        return fresh.map((row) => {
          const before = local.get(row.id);
          return before
            && before.name === row.name
            && before.parentId === row.parentId
            && before.path === row.path
            && before.position === row.position
            && before.caseCount === row.caseCount
            && before.activeCount === row.activeCount
            && before.automatedCount === row.automatedCount
            ? before : row;
        });
      });
    }).catch(() => setModules([])).finally(() => setModulesLoading(false));
  }, [projectId]);

  useEffect(() => { loadModules(); }, [loadModules, revision]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const result = await api.specCasesPaged(projectId, {
        keyword: debouncedKeyword,
        /* path 前缀筛 = 点中的目录含全部子级（右表与左侧树的计数同一口径）。 */
        path: modulePath,
        priority: priority === "all" ? undefined : (priority as SpecCasePriority),
        status: status === "all" ? undefined : (status as SpecCaseStatus),
        automation: automation === "all" ? undefined : automation,
        page, pageSize,
      });
      /* 删掉本页最后一行后自动退一页，而不是停在一张空表上（MockList 同款）。 */
      if (!result.items.length && result.total > 0 && page > 1) { setPage(page - 1); return; }
      setData(result);
    } catch {
      message.error(t("specCases.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, debouncedKeyword, modulePath, priority, status, automation, page, pageSize, revision, t]);

  useEffect(() => { void load(); }, [load]);

  /* 切项目清空勾选与树展开（跨项目集合没有意义）。 */
  useEffect(() => {
    setSelected(new Set());
    setExpanded(new Set());
  }, [projectId]);

  /* 筛选条件进地址栏（与执行记录页同款）：刷新和转发后结果一致。 */
  useEffect(() => {
    setSearchParams({
      ...(view !== "list" ? { view } : {}),
      ...(debouncedKeyword ? { keyword: debouncedKeyword } : {}),
      ...(modulePath ? { path: modulePath } : {}),
      ...(priority !== "all" ? { priority } : {}),
      ...(status !== "all" ? { status } : {}),
      ...(automation !== "all" ? { automation } : {}),
      ...(page > 1 ? { page: String(page) } : {}),
      ...(pageSize !== 20 ? { pageSize: String(pageSize) } : {}),
    }, { replace: true });
  }, [view, debouncedKeyword, modulePath, priority, status, automation, page, pageSize, setSearchParams]);

  /* 切视图不重置筛选与页码：脑图只是换一种排法看同一批数据，回到列表时
     检索上下文原样等着。 */
  function switchView(next: "list" | "mindmap") {
    if (next !== view) setView(next);
  }

  /** 点目录 = 右表筛到该目录。**单击只有选中语义，没有「再点取消」**（2026-09-08
      第四轮反馈复盘：取消语义与双击天然冲突——双击的第一击发生时无法预知还有
      第二击，守卫窗口调多宽都拦不住它走进「已选中 → 取消」的分支，「双击弹回
      全部用例」就是这么来的）。回「全部用例」走树顶的专用根行。重复点同一目录
      = 同值 setState，React 不重渲染、右表不重取。 */
  function selectModule(module: SpecModule) {
    setModulePath(module.path);
    setPage(1);
  }

  /**
   * 改名落地：子树整棵换 path 前缀，右表与模块树都要重取（revision）。若右表正筛在
   * 被改名子树里，把筛选前缀同步换成新 path 保持语境——否则筛选还挂在旧前缀上，树
   * 不亮、重取名也换不回来（㉔ 当初把存量目录改名后置到管理面的原因就是这一处）。
   */
  function moduleRenamed(previous: SpecModule, updated: SpecModule) {
    setRevision((current) => current + 1);
    if (modulePath?.startsWith(previous.path)) {
      setModulePath(updated.path + modulePath.slice(previous.path.length));
    }
  }

  /**
   * 删模块（2026-09-08 反馈，树面板缺删除出路）：**单层确认**——子树计数
   * （目录数 + 用例数）树面板本地就有（caseCount 直属求和、modules 前缀过滤），
   * 直接摆进确认文案，看过数量后一次 force 删除（后端 409/force 两段语义里的
   * 「先看数量」由文案完成，不再两层弹窗——2026-09-08 第二轮反馈嫌重）。
   * 树面板没有脑图 ⌘Z 撤销栈，确认不能省（脑图 ㉕ 的「不弹确认」只属于有撤销
   * 兜底的画布）；计数是树快照，force 删的是整棵子树、不依赖计数精确。
   */
  function removeModule(module: SpecModule) {
    if (!projectId) return;
    Modal.confirm({
      title: t("specCases.deleteModuleTitle", { name: module.name }),
      content: t("specCases.deleteModuleHint", {
        modules: modules.filter((row) => row.path.startsWith(module.path)).length,
        cases: subtreeCount(module),
      }),
      okText: t("action.delete"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.deleteSpecModule(projectId, module.id, true);
          moduleDeleted(module);
        } catch (error) {
          message.error(apiMessage(error) ?? t("specCases.moduleDeleteFailed"));
        }
      },
    });
  }

  /** 删除落地：右表正筛在被删子树里时回「全部用例」（前缀已指向不存在的目录），计数与列表靠 revision 统一重取。 */
  function moduleDeleted(module: SpecModule) {
    message.success(t("specCases.moduleDeleted"));
    if (modulePath?.startsWith(module.path)) {
      setModulePath(undefined);
      setPage(1);
    }
    setRevision((current) => current + 1);
  }

  /**
   * 拖拽落地（P7-6 改版：上/下/移动三枚按钮删除，全走拖拽——264px 面板每行
   * 悬停 4~5 枚按钮基本没法看）。三种落点语义：
   *   - 拖到目标行**上/下边缘 8px**：插到该行同级的前/后（调序或跨目录移动——
   *     目标行与拖行不同父时，落点父级就是目标行的父级）；
   *   - 拖到目标行**中部**：移进该目录（成为它的子模块，位置排末尾）；
   *   - 拖到「全部用例」行：移到顶层。
   * 调序/跨目录同级插入走 reorder 端点（一次写平该层 position）；移入目录与
   * 移到顶层走 PATCH parentId（后端换整棵子树 path 前缀），不与 reorder 混用。
   */
  async function dropModule(dragId: string, target: SpecModule | "root", place: "before" | "after" | "inside") {
    if (!projectId) return;
    const dragged = modules.find((row) => row.id === dragId);
    if (!dragged) return;
    /* 自家子树内的一切落点都非法：inside = 移进自己（后端 400）；before/after
       落在自家子树行上 = 成为后代的同级 = 还是自己的后代（后端同样 400）。 */
    if (target === "root") {
      if (dragged.parentId) {
        setModuleBusy(true);
        try {
          await api.updateSpecModule(projectId, dragId, { parentId: null });
          message.success(t("specCases.moduleMoved"));
          moduleMoved(dragged);
        } catch (error) {
          message.error(apiMessage(error) ?? t("specCases.moduleMoveFailed"));
        } finally {
          setModuleBusy(false);
        }
      }
      return;
    }
    if (target.id === dragId) return;
    if (place === "inside") {
      if (target.path.startsWith(dragged.path) || dragged.parentId === target.id) {
        /* 移进自己/后代（非法）或已是它的孩子（原地无事）——都不打后端。 */
        return;
      }
      setModuleBusy(true);
      try {
        await api.updateSpecModule(projectId, dragId, { parentId: target.id });
        message.success(t("specCases.moduleMoved"));
        moduleMoved(dragged);
      } catch (error) {
        message.error(apiMessage(error) ?? t("specCases.moduleMoveFailed"));
      } finally {
        setModuleBusy(false);
      }
      return;
    }
    /* before/after：落在自家子树行上 = 成为后代的同级，等价移进自己——拦。 */
    if (target.path.startsWith(dragged.path)) return;
    setModuleBusy(true);
    try {
      /* 跨目录先移过去（同层则跳过）。 */
      if (dragged.parentId !== target.parentId) {
        await api.updateSpecModule(projectId, dragId, { parentId: target.parentId ?? null });
      }
      /* 重排基于最新树（刚移过去的拖行不在旧 state 里）：现拉一份算目标层。 */
      const fresh = await api.specModules(projectId);
      const ids = layerSiblings(fresh, target).map((row) => row.id).filter((id) => id !== dragId);
      const targetIndex = ids.indexOf(target.id);
      ids.splice(place === "before" ? targetIndex : targetIndex + 1, 0, dragId);
      await api.reorderSpecModules(projectId, { parentId: target.parentId ?? null, moduleIds: ids });
      message.success(t("specCases.moduleMoved"));
      moduleMoved(dragged);
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.moduleMoveFailed"));
      setRevision((current) => current + 1);
    } finally {
      setModuleBusy(false);
    }
  }

  /** 移动/重排落地：右表筛选若在被移动子树里回「全部用例」（path 前缀已换，
      旧前缀指向不存在的目录）；revision 统一重取树 / 计数 / 右表。 */
  function moduleMoved(previous: SpecModule) {
    if (modulePath?.startsWith(previous.path)) {
      setModulePath(undefined);
      setPage(1);
    }
    setRevision((current) => current + 1);
  }


  function toggleSelected(caseId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(caseId); else next.delete(caseId);
      return next;
    });
  }

  function setMany(ids: string[], checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
      return next;
    });
  }

  function removeCase(item: SpecCase) {
    if (!projectId) return;
    Modal.confirm({
      title: t("specCases.deleteTitle", { name: item.title }),
      content: t("specCases.deleteHint"),
      okText: t("action.delete"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.deleteSpecCase(projectId, item.id);
          message.success(t("specCases.deleted"));
          setRevision((current) => current + 1);
        } catch (error) {
          message.error(apiMessage(error) ?? t("specCases.deleteFailed"));
        }
      },
    });
  }

  /* ── 批量条（P7-3）：移动模块 / 改优先级 / 改状态（2026-09-08）/ 加入计划
     （P7-7）/ 删除 ──────────────────────────────────────────────────────── */
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string>();
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [batchPriority, setBatchPriority] = useState<SpecCasePriority>("P2");
  const [statusOpen, setStatusOpen] = useState(false);
  const [batchStatus, setBatchStatus] = useState<SpecCaseStatus>("reviewed");
  const [batchBusy, setBatchBusy] = useState(false);
  /* 「加入计划」（P7-7）：Modal 里选既有 open 计划或就地新建；落地后清勾选。 */
  const [planModalOpen, setPlanModalOpen] = useState(false);

  async function applyBatch(input: { moduleId?: string; priority?: SpecCasePriority; status?: SpecCaseStatus }) {
    if (!projectId) return;
    setBatchBusy(true);
    try {
      const result = await api.batchUpdateSpecCases(projectId, { caseIds: [...selected], ...input });
      message.success(t("specCases.batchUpdated", { count: result.updated }));
      /* 批量动作落地即清空勾选：这一批的意图已经执行完，留着旧集合只会喂给下一次
         误操作。 */
      setSelected(new Set());
      setMoveOpen(false);
      setPriorityOpen(false);
      setStatusOpen(false);
      setRevision((current) => current + 1);
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.batchFailed"));
    } finally {
      setBatchBusy(false);
    }
  }

  function batchDelete() {
    if (!projectId) return;
    Modal.confirm({
      title: t("specCases.batchDeleteTitle", { count: selected.size }),
      content: t("specCases.deleteHint"),
      okText: t("action.delete"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          const result = await api.batchDeleteSpecCases(projectId, [...selected]);
          message.success(t("specCases.batchDeleted", { count: result.deleted }));
          setSelected(new Set());
          setRevision((current) => current + 1);
        } catch (error) {
          message.error(apiMessage(error) ?? t("specCases.batchFailed"));
        }
      },
    });
  }

  const moduleTreeNodes = useMemo(() => buildSpecModuleTree(modules), [modules]);
  const moduleTreeData = useMemo(() => toTreeSelectData(moduleTreeNodes), [moduleTreeNodes]);
  /* 当前选中的目录（path 找不到模块——改名后的旧地址栏——时树不亮、但筛选仍按
     path 生效）。 */
  const filterModuleId = modules.find((module) => module.path === modulePath)?.id;
  const filtered = Boolean(debouncedKeyword || modulePath || priority !== "all" || status !== "all" || automation !== "all");

  /* 树节点的计数用**子树**口径（与点它时右表看到的行数一致）；树接口的 caseCount
     是直属口径，这里把后代加回来。path 以 `/` 结尾，startsWith 天然区分 `/需求A/`
     与 `/需求AB/`。根节点「全部用例」= 全部直属之和。 */
  const subtreeCount = useCallback((module: SpecModule) => {
    let total = 0;
    for (const item of modules) {
      if (item.path.startsWith(module.path)) total += item.caseCount ?? 0;
    }
    return total;
  }, [modules]);
  const totalCases = useMemo(() => modules.reduce((sum, module) => sum + (module.caseCount ?? 0), 0), [modules]);
  /* 自动化覆盖率（P7-6，边界 11）：有 ≥1 条非 endpoint 绑定的**已评审**用例 /
     全部已评审用例——子树求和与 caseCount 同一纪律；分母只数已评审（迁移 053
     前 active）。0 条已评审时显示「—」（「还没有用例」与「0% 覆盖」是两个事实）。 */
  const totalActive = useMemo(() => modules.reduce((sum, module) => sum + (module.activeCount ?? 0), 0), [modules]);
  const totalAutomated = useMemo(() => modules.reduce((sum, module) => sum + (module.automatedCount ?? 0), 0), [modules]);
  const automationRate = totalActive > 0 ? Math.round((totalAutomated / totalActive) * 1000) / 10 : null;

  /* 列表表头全选的分母 = 当前页。 */
  const pageIds = data.items.map((item) => item.id);
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  /* ── 拖拽（P7-6 改版）───────────────────────────────────────────────────
     原生 HTML5 DnD：行 draggable（只在 canWrite 且不在拖拽在途时）；拖动经过
     目标行的上/下 8px 判 before/after（同级插入线），其余判 inside（移入目录，
     行底高亮）。拖影文字 = 目录名。状态放 ref 而不是 state：dragover 一秒触发
     数十次，setState 每次都重渲染整棵树，闪烁且掉帧；只在「区段变化」时才写
     state（dropZone：{id, place}）驱动指示线渲染。 */
  const dragModuleRef = useRef<string | null>(null);
  const [dropZone, setDropZone] = useState<{ id: string; place: "before" | "after" | "inside" }>();

  function zoneOf(event: DragEvent<HTMLElement>): "before" | "after" | "inside" {
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = event.clientY - rect.top;
    if (offset < 8) return "before";
    if (offset > rect.height - 8) return "after";
    return "inside";
  }

  function dragOverModule(event: DragEvent<HTMLElement>, module: SpecModule) {
    if (!dragModuleRef.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const place = zoneOf(event);
    if (dropZone?.id !== module.id || dropZone.place !== place) {
      setDropZone({ id: module.id, place });
    }
  }

  function dropOnModule(event: DragEvent<HTMLElement>, module: SpecModule) {
    if (!dragModuleRef.current) return;
    event.preventDefault();
    const place = zoneOf(event);
    setDropZone(undefined);
    void dropModule(dragModuleRef.current, module, place);
  }

  function dragLeaveModule() {
    /* 只清指示线（dragleave 在子元素间穿行也触发，清错会被下一次 dragover 纠正）。 */
    setDropZone(undefined);
  }

  function dragEndModule() {
    dragModuleRef.current = null;
    setDropZone(undefined);
  }

  /** 递归渲染左侧模块树：目录行（caret + Folder + 名字 + 子树计数），点行即筛。 */
  function renderTree(nodes: SpecModuleNode[], depth: number): ReactNode[] {
    return nodes.flatMap(({ module, children }) => {
      const open = expanded.has(module.id);
      const active = filterModuleId === module.id;
      const zone = dropZone?.id === module.id ? dropZone.place : undefined;
      return [
        <div key={module.id}
          className={`tree-item${active ? " is-active" : ""}${zone ? ` is-drop-${zone}` : ""}`}
          style={{ paddingLeft: 4 + depth * 14 }}
          draggable={canWrite && !moduleBusy}
          onDragStart={(event) => {
            dragModuleRef.current = module.id;
            /* 拖影给目录名——拍平的行没有别的可读标识（path 太长）。 */
            event.dataTransfer.setData("text/plain", module.name);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={dragEndModule}
          onDragOver={(event) => dragOverModule(event, module)}
          onDragLeave={dragLeaveModule}
          onDrop={(event) => dropOnModule(event, module)}
        >
          <button type="button" className="tree-caret" aria-expanded={open} aria-label={t("specCases.toggleModule", { name: module.name })}
            onClick={() => setExpanded((current) => {
              const next = new Set(current);
              if (open) next.delete(module.id); else next.add(module.id);
              return next;
            })}>
            {children.length > 0 ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
          </button>
          {/* 同层不同分支可重名（身份是 path）：悬停给全路径（Tip：原生 title
              悬停 ~1 秒才出来，2026-09-08 反馈嫌慢）。双击 = 展开/收起子目录
              （第四轮反馈；文件管理器惯例），叶子目录忽略。单击只选中不取消
              （见 selectModule——取消语义与双击的第一击冲突，是「双击弹回全部
              用例」的根因），所以双击链路里任何一击都不会动筛选，展开之外
              零副作用。 */}
          <Tip text={module.path}>
            <button type="button" className="tree-label" onClick={() => selectModule(module)}
              onDoubleClick={() => {
                if (!children.length) return;
                setExpanded((current) => {
                  const next = new Set(current);
                  if (open) next.delete(module.id); else next.add(module.id);
                  return next;
                });
              }}>
              <Folder size={13} style={{ color: "var(--ink-3)", flex: "0 0 auto" }} />
              <span className="truncate">{module.name}</span>
              <span className="mono tree-count">{subtreeCount(module)}</span>
            </button>
          </Tip>
          {canWrite && <span className="row-actions">
            <button type="button" className="tree-rename" aria-label={t("specCases.renameModule", { name: module.name })} onClick={() => setRenaming(module)}><Pencil size={12} /></button>
            <button type="button" className="tree-rename tree-remove" aria-label={t("specCases.deleteModule", { name: module.name })} onClick={() => removeModule(module)}><Trash2 size={12} /></button>
          </span>}
        </div>,
        ...(open ? renderTree(children, depth + 1) : []),
      ];
    });
  }

  /* 右半共用一套筛选（列表与脑图是同一批数据的两种排法，切换不换语境）；
      切换控件钉在筛选栏右端。 */
  const filterBar = <div className="filter-bar">
    <input className="input" placeholder={t("specCases.searchPlaceholder")} value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }} />
    <Select
      value={priority}
      onChange={(value) => { setPriority(value); setPage(1); }}
      options={[{ value: "all", label: t("specCases.allPriorities") }, ...PRIORITIES.map((value) => ({ value, label: value }))]}
      style={{ width: 140 }}
    />
    <Select
      value={status}
      onChange={(value) => { setStatus(value); setPage(1); }}
      options={[{ value: "all", label: t("specCases.allStatuses") }, ...STATUSES.map((value) => ({ value, label: t(`specCases.status_${value}`) }))]}
      style={{ width: 140 }}
    />
    {/* 已自动化筛选（P7-6）：与覆盖口径同一表达式（≥1 条非 endpoint 绑定）；
        tip 说明口径，避免「覆盖率」一词裸奔（边界 11）。 */}
    <Select
      value={automation}
      onChange={(value) => { setAutomation(value); setPage(1); }}
      options={[
        { value: "all", label: t("specCases.allAutomation") },
        { value: "yes", label: t("specCases.automation_yes") },
        { value: "no", label: t("specCases.automation_no") },
      ]}
      style={{ width: 140 }}
    />
    <span className="filter-spacer" />
    <div className="mode-switch" role="group" aria-label={t("specCases.viewSwitch")}>
      <IconButton icon={<ListTree size={14} />} label={t("specCases.viewList")} active={view === "list"} onClick={() => switchView("list")} />
      <IconButton icon={<Network size={14} />} label={t("specCases.viewMindmap")} active={view === "mindmap"} onClick={() => switchView("mindmap")} />
    </div>
  </div>;

  const bulkBar = canWrite && selected.size > 0 ? <div className="bulk-bar">
    <strong>{t("specCases.selectedCount", { count: selected.size })}</strong>
    <button className="btn" onClick={() => { setMoveTarget(undefined); setMoveOpen(true); }}>{t("specCases.batchMove")}</button>
    <button className="btn" onClick={() => setPriorityOpen(true)}>{t("specCases.batchPriority")}</button>
    <button className="btn" onClick={() => setStatusOpen(true)}>{t("specCases.batchStatus")}</button>
    {/* 加入计划（P7-7）：第五个批量动作——勾选的动机常常就是「这批要进回归」。 */}
    <button className="btn" onClick={() => setPlanModalOpen(true)}>{t("specCases.batchAddToPlan")}</button>
    <button className="btn danger" onClick={batchDelete}>{t("action.delete")}</button>
    <button className="btn btn-icon" title={t("action.cancel")} onClick={() => setSelected(new Set())}><X size={15} /></button>
  </div> : null;

  const caseTable = <>
    {loading ? <p className="muted">{t("common.loading")}…</p> : data.items.length ? <div className="table-scroll"><table className="grid spec-case-grid">
      <thead><tr>
        <th className="col-select">
          {canWrite && <input type="checkbox" aria-label={t("specCases.selectPage")}
            checked={pageAllSelected}
            ref={(node) => { if (node) node.indeterminate = !pageAllSelected && pageIds.some((id) => selected.has(id)); }}
            onChange={(event) => setMany(pageIds, event.target.checked)} />}
        </th>
        <th>{t("specCases.itemKey")}</th>
        <th>{t("specCases.caseTitle")}</th>
        <th>{t("specCases.priority")}</th>
        <th className="col-status">{t("specCases.status")}</th>
        {/* 已自动化（P7-6）：有 ≥1 条非 endpoint 绑定。绑定了但全是接口的行显示
            「仅接口」chip（中间态——设计了但没自动化，边界 10）。 */}
        <th className="col-status">{t("specCases.automation")}</th>
        <th>{t("common.updatedAt")}</th>
        {/* 模块路径放末列（2026-09-08 反馈）：路径随层级任意长，放前段会把
            标题挤到换行；末列 + max-width 上限，超长省略、悬停看全。 */}
        <th>{t("specCases.modulePath")}</th>
        {canWrite && <th className="col-actions" />}
      </tr></thead>
      <tbody>
        {data.items.map((item) => <tr key={item.id} data-clickable data-removed={item.status === "deprecated" ? "" : undefined}
          className={selected.has(item.id) ? "is-selected" : undefined}
          onClick={() => setEditing(item.id)}>
          <td className="col-select" onClick={(event) => event.stopPropagation()}>
            {canWrite && <input type="checkbox" aria-label={t("specCases.selectCase", { name: item.title })}
              checked={selected.has(item.id)} onChange={(event) => toggleSelected(item.id, event.target.checked)} />}
          </td>
          <td className="mono">{item.itemKey ?? "—"}</td>
          <td>
            <strong className="truncate">{item.title}</strong>
            {item.tags.length > 0 && <span className="tag-inline">{item.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}</span>}
          </td>
          <td><span className="chip mono">{item.priority}</span></td>
          <td className="col-status"><Status status={statusView(item.status)} label={t(`specCases.status_${item.status}`)} /></td>
          <td className="col-status">
            {item.automated
              ? <Status status="pass" label={t("specCases.automation_yes")} />
              : (item.linkCount ?? 0) > 0
                ? <span className="chip">{t("specCases.endpointOnly")}</span>
                : <span className="muted">—</span>}
          </td>
          <td className="mono muted">{new Date(item.updatedAt).toLocaleDateString()}</td>
          {/* 悬停看全路径：Tip（100ms）替代原生 title（2026-09-08 反馈嫌慢）；
              span 钉 block 才能铺满 220px 上限的单元格，空白处悬停也出提示。 */}
          <td className="mono col-path"><Tip text={formatPath(item.modulePath)}><span className="truncate">{formatPath(item.modulePath)}</span></Tip></td>
          {canWrite && <td className="col-actions"><div className="row-actions" onClick={(event) => event.stopPropagation()}>
            <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => setEditing(item.id)} />
            <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => removeCase(item)} />
          </div></td>}
        </tr>)}
      </tbody>
    </table></div> : <Empty
      title={filtered ? t("specCases.emptySearchTitle") : t("specCases.emptyTitle")}
      hint={filtered ? t("specCases.emptySearchHint") : t("specCases.emptyHint")}
      action={canWrite && !filtered ? <button className="btn btn-primary" onClick={() => setEditing("new")}>{t("specCases.create")}</button> : undefined}
    />}
    {data.items.length > 0 && <div className="pager"><Pagination current={page} pageSize={pageSize} total={data.total} pageSizeOptions={PAGE_SIZES} showSizeChanger showQuickJumper={data.total > pageSize * 5} onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }} /></div>}
  </>;

  return <main className="content">
    <div className="page-head">
      <div><h1>{t("specCases.title")}</h1><p>{t("specCases.hint")}</p></div>
      <div className="topbar-actions">
        {/* 导出对 viewer 开放（纯读）；按钮收进下拉——两个格式不该占两个常驻位。
            span 是 Dropdown 的触发子元素（rc-trigger 要求 DOM 子元素收 ref/事件，
            Tip（antd Tooltip）不转发事件，直接当子元素会吞掉下拉的点击）；Tip 包
            按钮不包 span——悬停目标就是按钮本身。 */}
        <Dropdown menu={{ items: exportItems, onClick: ({ key }) => void runExport(key as SpecExportFormat) }} trigger={["click"]}>
          <span>
            <Tip text={exportTip}>
              <button className="btn btn-with-icon" disabled={Boolean(exporting)}>
                <FileDown size={14} />{exporting ? `${t("common.loading")}…` : t("action.export")}
              </button>
            </Tip>
          </span>
        </Dropdown>
        {canWrite && <button className="btn btn-with-icon" onClick={() => setImportOpen(true)}><Download size={14} />{t("action.import")}</button>}
        {canWrite && <button className="btn btn-primary btn-with-icon" onClick={() => setEditing("new")}><Plus size={14} />{t("specCases.create")}</button>}
      </div>
    </div>

    {/* 树面板在两个视图里都常驻（第五轮反馈：脑图不解析树，树不动）；切换只换右半。 */}
    <div className="spec-split">
      <aside className="spec-tree">
        <div className="spec-tree-head">
          <span>{t("specCases.modules")}</span>
          {canWrite && <IconButton icon={<FolderPlus size={13} />} label={t("specCases.createModule")} onClick={() => setModuleModalOpen(true)} />}
        </div>
        {/* 自动化覆盖率读数（P7-6，边界 11）：分子/分母都摆在明处 + 一句口径说明
            （避免「覆盖率」一词裸奔）；与接口覆盖率、仓库覆盖率**并列不合并**——
            它们回答三个不同的问题。 */}
        <div className="spec-coverage">
          <div className="spec-coverage-row">
            <span className="spec-coverage-label">{t("specCases.automationCoverage")}</span>
            <span className="mono spec-coverage-value">{automationRate === null ? "—" : `${automationRate}%`}</span>
          </div>
          <span className="spec-coverage-note">{t("specCases.automationCoverageNote", { automated: totalAutomated, total: totalActive })}</span>
        </div>
        {modulesLoading ? <p className="muted" style={{ padding: 8 }}>{t("common.loading")}…</p>
          : modules.length === 0 ? <p className="form-note" style={{ padding: 8 }}>{t("specCases.noModulesPanelHint")}</p>
            : <>
              {/* 「全部用例」= 根节点行，也是拖拽的「移到顶层」落点（P7-6）。 */}
              <div className={`tree-item${!modulePath ? " is-active" : ""}${dropZone?.id === "root" ? " is-drop-inside" : ""}`}
                onDragOver={(event) => {
                  if (!dragModuleRef.current) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (dropZone?.id !== "root") setDropZone({ id: "root", place: "inside" });
                }}
                onDragLeave={() => setDropZone(undefined)}
                onDrop={(event) => {
                  if (!dragModuleRef.current) return;
                  event.preventDefault();
                  setDropZone(undefined);
                  void dropModule(dragModuleRef.current, "root", "inside");
                }}>
                <span className="tree-caret" />
                <button type="button" className="tree-label" onClick={() => { setModulePath(undefined); setPage(1); }}>
                  <ListTree size={13} style={{ color: "var(--ink-3)", flex: "0 0 auto" }} />
                  <span className="truncate">{t("specCases.allCases")}</span>
                  <span className="mono tree-count">{totalCases}</span>
                </button>
              </div>
              {renderTree(moduleTreeNodes, 0)}
            </>}
      </aside>
      <div style={{ minWidth: 0 }}>
        {filterBar}
        {view === "mindmap" ? (projectId && <SpecMindMap
          /* key=projectId：切项目整图重挂（展开集不跨项目）。 */
          key={projectId}
          projectId={projectId}
          rootLabel={modulePath ? (modules.find((module) => module.path === modulePath)?.name ?? formatPath(modulePath)) : t("specCases.allCases")}
          rootModuleId={filterModuleId}
          modules={modules}
          keyword={debouncedKeyword}
          modulePath={modulePath}
          priority={priority}
          status={status}
          /* 自动化筛选（P7-6 修）：此前没透传，列表筛了脑图还读全量——列表/脑图
             是同一批数据的两种排法，筛选语境必须同享。 */
          automation={automation}
          revision={revision}
          canWrite={canWrite}
          onOpenCase={(item) => setEditing(item.id)}
          onSaved={bumpRevision}
        />) : <>{bulkBar}{caseTable}</>}
      </div>
    </div>

    {/* ── 批量动作弹窗 ─────────────────────────────────────────────────────── */}
    <Modal
      title={t("specCases.batchMoveTitle", { count: selected.size })}
      open={moveOpen}
      okText={t("action.save")}
      cancelText={t("action.cancel")}
      okButtonProps={{ disabled: !moveTarget || batchBusy }}
      confirmLoading={batchBusy}
      onOk={() => void applyBatch({ moduleId: moveTarget })}
      onCancel={() => setMoveOpen(false)}
    >
      <label className="field"><span>{t("specCases.batchMoveTarget")}</span>
        <TreeSelect
          value={moveTarget}
          onChange={(value: string | undefined) => setMoveTarget(value)}
          onClear={() => setMoveTarget(undefined)}
          treeData={moduleTreeData}
          treeDefaultExpandAll
          allowClear
          placeholder={t("specCases.modulePlaceholder")}
          style={{ width: "100%" }}
        />
      </label>
    </Modal>

    <Modal
      title={t("specCases.batchPriorityTitle", { count: selected.size })}
      open={priorityOpen}
      okText={t("action.save")}
      cancelText={t("action.cancel")}
      confirmLoading={batchBusy}
      onOk={() => void applyBatch({ priority: batchPriority })}
      onCancel={() => setPriorityOpen(false)}
    >
      <label className="field"><span>{t("specCases.priority")}</span>
        <Select value={batchPriority} onChange={(value) => setBatchPriority(value)} options={PRIORITIES.map((value) => ({ value, label: value }))} style={{ width: "100%" }} />
      </label>
    </Modal>

    {/* 批量改状态（2026-09-08 反馈）：勾选一批直接推进生命周期（未评审/已评审/
        废弃），与批量优先级同一套提交纪律。缺省「已评审」——批量动作的典型意图
        是评审通过，列表勾选改状态正是「评审批量过单」的路径。 */}
    <Modal
      title={t("specCases.batchStatusTitle", { count: selected.size })}
      open={statusOpen}
      okText={t("action.save")}
      cancelText={t("action.cancel")}
      confirmLoading={batchBusy}
      onOk={() => void applyBatch({ status: batchStatus })}
      onCancel={() => setStatusOpen(false)}
    >
       <label className="field"><span>{t("specCases.status")}</span>
         <Select value={batchStatus} onChange={(value) => setBatchStatus(value)} options={STATUSES.map((value) => ({ value, label: t(`specCases.status_${value}`) }))} style={{ width: "100%" }} />
       </label>
     </Modal>

    {/* ── 加入计划（P7-7，批量条第五动作）：既有计划 or 就地新建。落地清勾选。 */}
    {projectId && <AddToPlanModal
      projectId={projectId}
      open={planModalOpen}
      caseIds={[...selected]}
      onClose={() => setPlanModalOpen(false)}
      onDone={() => setSelected(new Set())}
    />}

    {projectId && <ModuleCreateModal
      projectId={projectId}
      open={moduleModalOpen}
      modules={moduleTreeData}
      onClose={() => setModuleModalOpen(false)}
      onCreated={(module) => {
        loadModules();
        /* 建完即选中并展开到它：建模块的下一步就是往里录用例。 */
        setModulePath(module.path);
        setPage(1);
      }}
    />}

    {projectId && renaming && <ModuleRenameModal
      projectId={projectId}
      module={renaming}
      onClose={() => setRenaming(undefined)}
      onRenamed={(updated) => moduleRenamed(renaming, updated)}
    />}

    {projectId && <SpecImportModal
      projectId={projectId}
      /* 既有模块树（TreeSelect 形状）：导入根目录的选择器数据源。 */
      modules={moduleTreeData}
      open={importOpen}
      onClose={() => setImportOpen(false)}
      /* 导入落地会补建模块 + 增改用例：revision 一次推高，右表 / 模块计数 /
         树缓存三处读数统一重取（与单条建/改/删同一套纪律）。 */
      onImported={bumpRevision}
    />}

    {projectId && <SpecCaseDrawer
      projectId={projectId}
      /* id 意图（new | 用例 id）：抽屉自己按 id 拉详情，行快照不进抽屉。 */
      caseId={editing === "new" ? "new" : editing}
      modules={moduleTreeData}
      canWrite={canWrite}
      /* 列表停在某个目录时新建用例，默认就挂在那里——「看着模块A建模块A的用例」。 */
      defaultModuleId={filterModuleId}
      onClose={closeCaseDrawer}
      onSaved={bumpRevision}
    />}
  </main>;
}

export function SpecCaseDrawer({ projectId, caseId, modules, canWrite, readOnly, defaultModuleId, onClose, onSaved }: {
  projectId: string;
  /** new = 新建；uuid = 编辑（挂载时按 id 现拉详情，不信任任何行快照）。 */
  caseId?: string | "new";
  modules?: ModuleNode[];
  canWrite?: boolean;
  /** 只读视角（计划详情点开用例）：字段全禁用、绑定区只读、页脚只剩关闭——计划是
   *  历史记录，从这里改库用例会把「快照读数」与「现值编辑」搅在一个入口里；
   *  要改去用例库改（那里有树、有模块上下文）。 */
  readOnly?: boolean;
  defaultModuleId?: string;
  onClose: () => void;
  onSaved?: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [item, setItem] = useState<SpecCase | "new" | "loading">();
  const [moduleId, setModuleId] = useState<string>();
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<SpecCasePriority>("P2");
  const [status, setStatus] = useState<SpecCaseStatus>("unreviewed");
  const [tagsText, setTagsText] = useState("");
  const [preconditions, setPreconditions] = useState("");
  const [steps, setSteps] = useState<SpecCaseStep[]>([]);
  const [saving, setSaving] = useState(false);
  /* 绑定（P7-6）：links 跟 item 一起从详情读（读时关联、服务端不落结果）；建/删
     绑定后不整抽屉重拉——详情里表单字段与绑定无关，重拉会把正在编辑的草稿吃掉
     （㉑ 同款问题），就地改 links 数组即可。落地后调 onSaved 推 revision，父组件
     重取列表 linkCount / 树计数 / 看板覆盖率三处读数。 */
  const [links, setLinks] = useState<SpecCaseLink[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  /* 可编辑 = 角色可写 且 不是只读视角：抽屉里所有输入禁用态、保存/加绑定/删绑定
     按这一把尺（readOnly 时 canWrite 再真也全灰——计划详情点开只读）。 */
  const editable = Boolean(canWrite) && !readOnly;

  /* 打开与换人都重拉详情：脑图就地编辑（⑰）之后列表行闭包是旧对象，这里按
     id 现取，抽屉永远与库一致。**关闭即清空 item**（㉑ 复测）：不清的话重开
     另一条用例，首帧渲染的还是上一条的完整表单——闪一帧旧数据，读作「打开
     B 看到 A」。详情接口失败时关抽屉 + 报错。 */
  useEffect(() => {
    if (!caseId) { setItem(undefined); return; }
    if (caseId === "new") { setItem("new"); return; }
    setItem("loading");
    let cancelled = false;
    api.specCase(projectId, caseId)
      .then((detail) => { if (!cancelled) setItem(detail); })
      .catch(() => {
        if (cancelled) return;
        message.error(t("specCases.loadFailed"));
        onClose();
      });
    return () => { cancelled = true; };
  }, [caseId, projectId, t, onClose]);

  /* 表单回填走 layout effect（㉑ 复测）：详情进 state 的同一次提交里、浏览器
     绘制**之前**完成——普通 useEffect 会隔出一帧「抽屉已开、字段还是上一条
     用例旧值」的脏画面。links 同批回填（新建用例没有绑定区——绑定挂在已存在
     的用例上，先有 id 才能绑）。 */
  useLayoutEffect(() => {
    if (!item || item === "loading") return;
    if (item === "new") {
      setModuleId(defaultModuleId);
      setTitle(""); setPriority("P2"); setStatus("unreviewed");
      setTagsText(""); setPreconditions(""); setSteps([]);
      setLinks([]);
    } else {
      setModuleId(item.moduleId);
      setTitle(item.title); setPriority(item.priority); setStatus(item.status);
      setTagsText(item.tags.join(", ")); setPreconditions(item.preconditions); setSteps(item.steps);
      setLinks(item.links ?? []);
    }
  }, [item, defaultModuleId]);

  async function removeLink(link: SpecCaseLink) {
    if (!item || item === "new" || item === "loading") return;
    try {
      await api.deleteSpecCaseLink(projectId, item.id, link.id);
      setLinks((current) => current.filter((row) => row.id !== link.id));
      onSaved?.();
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.links.removeFailed"));
    }
  }

  /** 行内步骤表：尾行常驻空行，一输入即成真行。 */
  function updateStep(index: number, field: "step" | "expected", value: string) {
    if (index === steps.length) {
      setSteps([...steps, field === "step" ? { step: value, expected: "" } : { step: "", expected: value }]);
      return;
    }
    setSteps(steps.map((row, i) => i === index ? { ...row, [field]: value } : row));
  }

  async function save() {
    if (!item || item === "loading") return;
    if (!moduleId) { message.error(t("specCases.moduleRequired")); return; }
    if (!title.trim()) { message.error(t("specCases.titleRequired")); return; }
    /* 两列全空的尾行在这里过滤一次，服务端还会再滤一遍（同一规则两端各持一份）。
       编号不进提交体：服务端按项目内 TC- 序列自增生成（2026-09-07 反馈）。 */
    const input: SpecCaseInput = {
      moduleId,
      title: title.trim(),
      preconditions,
      steps: steps.filter((row) => row.step.trim() || row.expected.trim()),
      priority,
      status,
      tags: tagsText.split(",").map((tag) => tag.trim()).filter(Boolean),
    };
    setSaving(true);
    try {
      if (item === "new") await api.createSpecCase(projectId, input);
      else await api.updateSpecCase(projectId, item.id, input);
      message.success(item === "new" ? t("specCases.created") : t("specCases.saved"));
      onClose();
      await onSaved?.();
    } catch (error) {
      /* 服务端话术直接透传——apiMessage 拿不到时才用兜底文案。 */
      message.error(apiMessage(error) ?? t("specCases.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  /* 渲染行 = 已有步骤 + 一条尾随空行（只读视角不需要空行的邀约）。 */
  const stepRows = editable ? [...steps, { step: "", expected: "" }] : steps;

  /* 抽屉占页面 70%（2026-09-07 用户反馈）：640px 装不下步骤/预期两列的长文本，
      步骤表与字段区都需要横向呼吸。详情拉取中先只出抽屉骨架（加载一行），
      不闪一份空表单——空表单会被读成「用例是空的」。
      destroyOnHidden（㊲）：antd 抽屉默认关了也把内容留在 DOM（display:none），
      换用例重开时表单在隐藏态被换值、AutoGrow 量到 0 高——前置/步骤框缩成
      细线「折叠在一起」。关即卸载，每次打开都是可见态的全新挂载，高度只在
      可见时量。 */
  return <Drawer
    title={item === "new" ? t("specCases.createTitle") : readOnly ? t("specCases.viewTitle") : t("specCases.editTitle")}
    open={Boolean(item)} onClose={onClose} width="70%" destroyOnHidden footer={<div className="drawer-actions">
    {/* 只读视角页脚只剩关闭（「取消」暗示有可放弃的编辑，这里没有）。 */}
    <button className="btn" onClick={onClose}>{readOnly ? t("action.close") : t("action.cancel")}</button>
    {editable && item !== "loading" && <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "…" : t("action.save")}</button>}
  </div>}>
    {item === "loading" ? <p className="muted">{t("common.loading")}…</p> : <>
    <div className="form-grid">
      <div className="field field-wide">
        <span>{t("specCases.module")}</span>
        {/* 建模块只在左侧树面板（2026-09-07 第三轮反馈）：抽屉是「录一条用例」的
            地方，不再内嵌结构管理；没有模块时提示去树面板建。只读视角不渲染
            TreeSelect——模块树是调用方的上下文，计划页没有，直接给路径文本。 */}
        {readOnly
          ? <span className="mono" style={{ padding: "6px 0", display: "inline-block" }}>
              {typeof item === "object" ? formatPath(item.modulePath) || "—" : "—"}
            </span>
          : <>
            <TreeSelect
              value={moduleId}
              onChange={(value: string | undefined) => setModuleId(value)}
              treeData={modules ?? []}
              treeDefaultExpandAll
              placeholder={t("specCases.modulePlaceholder")}
              style={{ width: "100%" }}
              disabled={!editable}
            />
            {modules?.length === 0 && <small className="form-note">{t("specCases.noModulesHint")}</small>}
          </>}
      </div>
      <label className="field field-wide"><span>{t("specCases.caseTitle")}</span><input autoFocus className="input" value={title} onChange={(event) => setTitle(event.target.value)} disabled={!editable} /></label>
      {/* 三枚短字段钉成一行（2026-09-07 反馈）：外层 form-grid 是 auto-fit 自适应
          列，列数随抽屉宽度漂移，短字段散排没法保证同排；编号已改服务端自增，不再
          进表单。 */}
      <div className="field-row field-wide">
        <label className="field"><span>{t("specCases.priority")}</span><Select value={priority} onChange={(value) => setPriority(value)} options={PRIORITIES.map((value) => ({ value, label: value }))} style={{ width: "100%" }} disabled={!editable} /></label>
        <label className="field"><span>{t("specCases.status")}</span><Select value={status} onChange={(value) => setStatus(value)} options={STATUSES.map((value) => ({ value, label: t(`specCases.status_${value}`) }))} style={{ width: "100%" }} disabled={!editable} /></label>
        <label className="field"><span>{t("specCases.tags")}</span><input className="input" placeholder={t("specCases.tagsPlaceholder")} value={tagsText} onChange={(event) => setTagsText(event.target.value)} disabled={!editable} /></label>
      </div>
      <label className="field field-wide"><span>{t("specCases.preconditions")}</span><AutoGrowTextarea value={preconditions} onChange={setPreconditions} placeholder={t("specCases.preconditionsPlaceholder")} disabled={!editable} /></label>
    </div>

    {/* 步骤区块与上方表单的间隔给到 32px（第三轮反馈：20px 挤在一起没有呼吸感——
        form-grid 里 field 的 margin-bottom 是 0，全靠这里一档）。 */}
    <div style={{ marginTop: "var(--s7)" }}>
      <div className="kv-head">
        <h3 className="subhead">{t("specCases.steps")}{steps.length > 0 && <span className="tab-count mono">{steps.length}</span>}</h3>
      </div>
      {/* 步骤是一张两列表而不是一堆散框（2026-09-07 第二轮反馈）：容器带边框、
          表头 raised 底、行间分隔线、输入框静息无边框——与全站 .grid 同一视觉。 */}
      <div className="steps-table">
        <div className="kv-row steps-head" style={STEP_ROW_GRID}>
          <span />
          {/* steps-col-label：列名与输入框内文字对齐（textarea 自带 12px 横向内边距）。 */}
          <span className="steps-col-label">{t("specCases.stepPlaceholder")}</span>
          <span className="steps-col-label">{t("specCases.expectedPlaceholder")}</span>
          <span />
        </div>
        {stepRows.map((row, index) => {
          const blank = index === steps.length;
          return <div className={`kv-row${blank ? " is-blank" : ""}`} style={STEP_ROW_GRID} key={index}>
            <span className="mono muted" style={{ width: 18, textAlign: "right" }}>{index + 1}</span>
            <AutoGrowTextarea value={row.step} placeholder={t("specCases.stepPlaceholder")} ariaLabel={t("specCases.stepPlaceholder")} onChange={(value) => updateStep(index, "step", value)} disabled={!editable} />
            <AutoGrowTextarea value={row.expected} placeholder={t("specCases.expectedPlaceholder")} ariaLabel={t("specCases.expectedPlaceholder")} onChange={(value) => updateStep(index, "expected", value)} disabled={!editable} />
            {editable && <button type="button" className="icon-btn is-ghost row-remove" disabled={blank} onClick={() => setSteps(steps.filter((_, i) => i !== index))} aria-label={t("action.delete")}><X size={14} /></button>}
          </div>;
        })}
      </div>
      {steps.length === 0 && editable && <p className="form-note">{t("specCases.stepsHint")}</p>}
    </div>

    {/* ── 绑定区（P7-6）：一条文本用例 → N 条自动化资产（N:N，边界 8）。只读行 =
        目标名 + 类型 + 最近结果（读时关联，Status 原语上语义色；深链跳对应详情页）；
        目标删了显示「目标已删除」、repo_case 对账标 removed 显示「目标已失效」
        （验收 7：悬空不消失、不报错）。endpoint 绑定是「该测什么」的设计意图，
        不算自动化进度（边界 10/11）——行上给 chip 标注「不算自动化」。 */}
    {item !== "new" && <div style={{ marginTop: "var(--s7)" }}>
      <div className="kv-head">
        <h3 className="subhead">{t("specCases.links.title")}{links.length > 0 && <span className="tab-count mono">{links.length}</span>}</h3>
        {editable && <button className="btn btn-with-icon" onClick={() => setPickerOpen(true)}><Plus size={14} />{t("specCases.links.add")}</button>}
      </div>
      {links.length === 0
        ? <p className="form-note">{t("specCases.links.emptyHint")}</p>
        : <div className="table-scroll"><table className="grid">
          <thead><tr>
            <th>{t("specCases.links.target")}</th>
            <th className="col-status">{t("specCases.links.lastResult")}</th>
            <th>{t("specCases.links.lastAt")}</th>
            {editable && <th className="col-actions" />}
          </tr></thead>
          <tbody>
            {links.map((link) => <tr key={link.id}>
              <td>
                <div className="link-target">
                  <span className="chip mono">{t(`specCases.links.type_${link.targetType}`)}</span>
                  {link.targetName
                    ? <Tip text={link.targetType === "repo_case" && link.targetKey ? link.targetKey : undefined}>
                        <span className="truncate">
                          {link.targetName}
                          {link.targetType === "repo_case" && link.targetStatus === "removed" && <em className="link-stale"> · {t("specCases.links.stale")}</em>}
                        </span>
                      </Tip>
                    : <em className="link-stale">{t("specCases.links.deleted")}</em>}
                  {link.targetType === "endpoint" && <span className="link-note">{t("specCases.links.endpointNote")}</span>}
                </div>
              </td>
              <td className="col-status">
                {link.lastResult
                  ? <Status status={linkResultView(link.lastResult.status)} label={t(`specCases.links.result_${link.lastResult.status}`)} />
                  : <span className="muted">—</span>}
              </td>
              <td className="mono muted">{link.lastResult?.at ? new Date(link.lastResult.at).toLocaleString() : "—"}</td>
              {editable && <td className="col-actions"><div className="row-actions">
                <IconButton icon={<Trash2 size={14} />} label={t("specCases.links.remove")} tone="danger" onClick={() => void removeLink(link)} />
              </div></td>}
            </tr>)}
          </tbody>
        </table></div>}
    </div>}

    {/* 绑定选择器（P7-6）：只对已存在的用例开放（新建先保存拿 id）。zIndex 压过
        抽屉（1000）与模块弹窗（1100）同层。`typeof item === "object"` 一刀收掉
        undefined 与两个字符串哨兵值（SpecCase 是对象），比逐串比较少一次收窄。 */}
    {editable && typeof item === "object" && <SpecLinkPicker
      projectId={projectId}
      caseId={item.id}
      open={pickerOpen}
      existing={links}
      onClose={() => setPickerOpen(false)}
      onLinked={(link) => {
        setLinks((current) => [...current, link]);
        onSaved?.();
      }}
    />}
    </>}
  </Drawer>;
}

/** 绑定行的最近结果 → Status 色词：executions 五值与 repo_case 四值共用 toRunStatus
    （passed→pass、failed→fail、unknown→skip 兜底、not_run 原样）。 */
function linkResultView(status: string): RunStatus {
  return toRunStatus(status);
}

/**
 * 「加入计划」弹窗（P7-7，批量条第五动作）：两条路——加入既有 open 计划
 * （重复项服务端静默跳过、如实返回插入数）或就地新建计划（带这批为初始项）。
 * 选项数据源只列 open 计划（closed 是历史档案，往里加项没有语义）；全量
 * pageSize 100——计划是低频资产，下拉缺一个真实存在的计划比翻页更糟
 * （environmentList 全量读法同款取舍）。
 */
function AddToPlanModal({ projectId, open, caseIds, onClose, onDone }: {
  projectId: string;
  open: boolean;
  caseIds: string[];
  onClose: () => void;
  /** 成功落地后的清勾选回调。 */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [plans, setPlans] = useState<TestPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [planId, setPlanId] = useState<string>();
  const [name, setName] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [busy, setBusy] = useState(false);

  /* 每次打开重取 open 计划 + 重置表单（ModuleCreateModal 同款纪律）。 */
  useEffect(() => {
    if (!open) return;
    setMode("existing");
    setPlanId(undefined);
    setName("");
    setDueOn("");
    setPlansLoading(true);
    api.testPlans(projectId)
      .then((page) => setPlans(page.items.filter((row) => row.status === "open")))
      .catch(() => setPlans([]))
      .finally(() => setPlansLoading(false));
  }, [open, projectId]);

  async function submit() {
    if (!caseIds.length || busy) return;
    setBusy(true);
    try {
      if (mode === "existing") {
        if (!planId) return;
        const result = await api.addTestPlanItems(projectId, planId, caseIds);
        message.success(t("specCases.addedToPlan", { count: result.inserted }));
      } else {
        const trimmed = name.trim();
        if (!trimmed) { message.error(t("specCases.planNameRequired")); return; }
        await api.createTestPlan(projectId, { name: trimmed, dueOn: dueOn || null, specCaseIds: caseIds });
        message.success(t("specCases.planCreatedWithItems", { count: caseIds.length }));
      }
      onDone();
      onClose();
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.addToPlanFailed"));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = mode === "existing" ? Boolean(planId) : Boolean(name.trim());

  return <Modal
    title={t("specCases.batchAddToPlanTitle", { count: caseIds.length })}
    open={open}
    okText={mode === "existing" ? t("specCases.batchAddToPlan") : t("action.create")}
    cancelText={t("action.cancel")}
    okButtonProps={{ disabled: !canSubmit || plansLoading }}
    confirmLoading={busy}
    onOk={() => void submit()}
    onCancel={onClose}
  >
    {/* 两条路用 segmented 切换（视图切换控件同款原语）。 */}
    <div className="segmented" style={{ marginBottom: "var(--s4)" }}>
      <button type="button" className={`segmented-item${mode === "existing" ? " is-active" : ""}`} onClick={() => setMode("existing")}>{t("specCases.planPickerExisting")}</button>
      <button type="button" className={`segmented-item${mode === "create" ? " is-active" : ""}`} onClick={() => setMode("create")}>{t("specCases.planPickerCreate")}</button>
    </div>
    {mode === "existing"
      ? plansLoading
        ? <p className="muted">{t("common.loading")}…</p>
        : plans.length
          ? <Select
              value={planId}
              onChange={(value: string | undefined) => setPlanId(value)}
              onClear={() => setPlanId(undefined)}
              placeholder={t("specCases.planPickerExisting")}
              style={{ width: "100%" }}
              allowClear
              options={plans.map((row) => ({
                value: row.id,
                label: `${row.name}（${row.summary.total} 项）`,
              }))}
            />
          : <p className="form-note">{t("specCases.planPickerEmpty")}</p>
      : <>
        <label className="field"><span>{t("specCases.planName")}</span>
          <input autoFocus className="input" placeholder={t("specCases.planNamePlaceholder")} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field"><span>{t("specCases.planDue")}</span>
          <input type="date" className="input" value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
        </label>
      </>}
  </Modal>;
}
