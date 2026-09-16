import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { Play, Plus, Square, Trash2 } from "lucide-react";
import {
  api,
  noRunnerLabel,
  type NotificationChannel,
  type Paged,
  type SuiteExecution,
  type SuiteExecutionConfig,
  type SuiteExecutionDetail,
  type SuiteMemberSnapshot,
  type SuiteNotifyConfig,
  type SuitePreview,
  type SuiteSelection,
  type TestSuite,
} from "../api";
import { useExecutionStream } from "../hooks/useExecutionStream";
import { useDebounced } from "../hooks/useDebounced";
import { useCanWrite } from "../hooks/useMyRole";
import { usePageContext } from "../hooks/usePageContext";
import { useNavGuardStore } from "../stores/navGuardStore";
import { useLimitsStore } from "../stores/limitsStore";
import { useProjectStore } from "../stores/projectStore";
import { toRunStatus } from "../ui";
import { HistorySidebar } from "./HistorySidebar";
import { IconButton } from "./IconButton";
import { ResourceSchedules } from "./ResourceSchedules";
import { RunStatusTag } from "./RunStatusTag";
import { SIDEBAR_PAGE_SIZES, SidebarPager } from "./SidebarPager";
import { SuiteMemberPicker } from "./SuiteMemberPicker";
import { SuiteRunDrawer } from "./SuiteRunDrawer";
import { SuiteRunModal } from "./SuiteRunModal";

/**
 * 套件配置页 (P2-4)。
 *
 * 三块：选谁（选择方式）、怎么跑（并发 / 失败即停 / 环境）、会跑到谁（预览）。
 * 预览是这一页的关键：标签与全部是**动态选择**，成员随项目里的用例和流程变化，
 * 不给一个「现在会跑这些」的答案，用户只能靠运行一次来试。
 *
 * 运行也在这一页：成员证据只有在「这个套件是怎么配的」旁边才读得通。运行记录在侧栏，
 * 一次运行的成员清单在抽屉里（P2-4.3）。
 */

/**
 * 手动成员在页面上带着快照走：加进来就能显示名字，不必为一个列表再回查一次。
 *
 * **解析不到的引用不再留在列表里。** 删用例/流程时服务端已经把它从每个引用它的手动套件里
 * 摘掉（`detachSuiteMember`，与删除同一个事务），所以一条解析不到的引用只可能是那条路径
 * 之前留下的旧数据。把它画成一行「已不存在」除了解释自己为什么在那儿之外没有用途：
 * 它不能运行、不能打开、也没有可修的内容。所以这里就地清掉，并让页面进入未保存状态——
 * 清理是一次真实的配置改动，由用户按保存确认，而不是偷偷写库。
 */
type DraftMember = SuiteMemberSnapshot;

/** 成员清单（手动列表 / 解析预览）就地分页的页大小：数据已整份在手，只是展示分页。 */
const MEMBER_PAGE_SIZE = 20;

/** 平台对应的保存快捷键文案，与流程工作台同一份判断。 */
const SAVE_KEY = navigator.platform.toLowerCase().includes("mac") ? "⌘S" : "Ctrl+S";

type Draft = {
  name: string;
  description: string;
  tags: string[];
  selection: SuiteSelection;
  execution: SuiteExecutionConfig;
  /** 套件级通知设置（P3-11）：随整份草稿保存，脏检测与其它字段同一口径。 */
  notify: SuiteNotifyConfig;
  /** manual 选择时的成员快照，与 selection.members 严格一一对应、同序。 */
  members: DraftMember[];
};

/**
 * 比较用的稳定序列化。
 *
 * 直接 `JSON.stringify` 比不出「有没有改」：键的书写顺序不同就会得到不同的字符串，
 * 于是页面上什么都没动、或者刚存完，也会一直挂着「未保存」。名字两端空格同样按无差异
 * 处理——保存时是 trim 过的，比较时不 trim 就永远对不上。
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return typeof value === "string" ? value.trim() : value;
}

/**
 * 模版输入的合并器：两个输入框都清空时把 template 整个置空（undefined），否则
 * 「填过再删掉」会留下 `{title:"", body:""}`——它与「从没填过」渲染结果相同，
 * 脏检测却会一直亮着。
 */
function templateOf(notify: SuiteNotifyConfig, next: { title?: string; body?: string }): SuiteNotifyConfig["template"] {
  const title = next.title ?? notify.template?.title ?? "";
  const body = next.body ?? notify.template?.body ?? "";
  if (!title.trim() && !body.trim()) return undefined;
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
}

export function SuiteWorkspace() {
  const { t } = useTranslation();
  const { projectId, suiteId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { environments } = useProjectStore();
  const setGuard = useNavGuardStore((state) => state.setGuard);
  const stream = useExecutionStream(projectId);
  /* viewer：运行/保存（含 ⌘S）不渲染、不触发（P6-4）。 */
  const canWrite = useCanWrite();
  /**
   * 成员并发的上限 = 服务端两条约束里更严的那个：保护性硬上限 `SUITE_MAX_CONCURRENCY`
   * 与共享令牌预算 `SUITE_LEAF_BUDGET`（后者是环境变量）。`C ≤ 池容量` 是「每个在跑的
   * 成员至少拿得到一枚令牌、一定有进展」的依据，所以两者都不能越过。
   */
  const concurrencyMax = useLimitsStore((state) => Math.min(state.limits.suiteMaxConcurrency, state.limits.suiteLeafBudget));

  const [suite, setSuite] = useState<TestSuite>();
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  /** 打开页面时清掉的悬空引用条数（旧数据），保存后归零。 */
  const [staleDropped, setStaleDropped] = useState(0);
  const [preview, setPreview] = useState<SuitePreview>();
  const [previewing, setPreviewing] = useState(false);
  /* 成员清单的分页（数据已整份在手）：预览与手动列表各自记一页。 */
  const [previewPage, setPreviewPage] = useState(1);
  const [memberPage, setMemberPage] = useState(1);
  /** 项目里已用过的标签，给两处标签框做建议。服务端 DISTINCT，不从分页数据里凑。 */
  const [memberTags, setMemberTags] = useState<string[]>([]);
  const [suiteTags, setSuiteTags] = useState<string[]>([]);
  /** 通知渠道（P3-11）：通知设置面板的选项；加载失败按空处理，面板提示先建渠道。 */
  const [channels, setChannels] = useState<NotificationChannel[]>([]);

  /* 运行：一次执行 + 它的成员证据，加上这个套件的运行记录侧栏。 */
  const [starting, setStarting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [run, setRun] = useState<SuiteExecutionDetail>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  /* 运行确认弹窗（变量覆盖在弹窗组件里持有）。 */
  const [runOpen, setRunOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(localStorage.getItem("apitest.suiteHistoryOpen") !== "false");
  const [runs, setRuns] = useState<Paged<SuiteExecution>>({ items: [], page: 1, pageSize: SIDEBAR_PAGE_SIZES[1], total: 0 });
  const [historyStatus, setHistoryStatus] = useState("all");
  const [historyPage, setHistoryPage] = useState(1);

  /* 助手页面上下文（P9-4c）：URL 已带 suiteId，这里补套件名与最近一次报告——
     「这个套件最近怎么老失败」让 agent 直接拿 executionId 下钻。 */
  usePageContext(suiteId ? {
    page: "suite-workspace",
    entities: {
      suiteId,
      ...(draft?.name ? { suiteName: draft.name } : suite?.name ? { suiteName: suite.name } : {}),
      ...(runs.items[0] ? { executionId: runs.items[0].id } : {}),
    },
  } : undefined);
  const [historyPageSize, setHistoryPageSize] = useState(SIDEBAR_PAGE_SIZES[1]);

  useEffect(() => {
    if (!projectId) return;
    void api.projectTags(projectId, "members").then(setMemberTags).catch(() => setMemberTags([]));
    void api.projectTags(projectId, "suites").then(setSuiteTags).catch(() => setSuiteTags([]));
    void api.notificationChannels(projectId).then(setChannels).catch(() => setChannels([]));
    void api.projectTags(projectId, "suites").then(setSuiteTags).catch(() => setSuiteTags([]));
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !suiteId) return;
    void api.testSuite(projectId, suiteId)
      .then(async (loaded) => {
        /* manual 成员只存了引用，名字要靠一次解析补齐——preview 正是干这个的，
           所以打开页面就用它，而不是再写一条「只取名字」的接口。 */
        let members: DraftMember[] = [];
        let selection = loaded.selection;
        let dropped = 0;
        if (loaded.selection.type === "manual" && loaded.selection.members.length) {
          const refs = loaded.selection.members;
          try {
            const resolved = await api.previewSuite(projectId, suiteId, undefined, loaded.execution.concurrency);
            const found = new Map(resolved.members.map((member) => [`${member.type}:${member.id}`, member]));
            /* 声明顺序优先，解析不到的直接落地丢掉：删除路径已经会摘成员，所以这里
               只会遇到那条路径之前留下的旧引用，而一行「已不存在」是没有用途的。 */
            members = refs.flatMap((ref) => {
              const hit = found.get(`${ref.type}:${ref.id}`);
              if (hit) return [hit];
              dropped += 1;
              return [];
            });
            /* 草稿的 selection 跟着清理后的列表走，于是脏标记自己就亮起来：清理是一次
               真实的配置改动，要由用户按保存确认，不能偷偷写库。 */
            if (dropped) selection = { type: "manual", members: members.map((member) => ({ type: member.type, id: member.id })) };
            /* 这一次解析同时带回了并发峰值：手动选择没有「解析成员」按钮，不留下它，
               「声明的并发合计超预算」这件事在手动套件上就永远说不出来。 */
            setPreview(resolved);
          } catch {
            /* 解析失败**不当成「成员都不存在」**：那会把一次读失败变成一份清空成员的草稿。
               先按引用本身占位，让用户看到有几个成员，等他重开页面再解析。 */
            members = refs.map((ref) => ({ ...ref, name: ref.id }));
          }
        }
        setSuite(loaded);
        setStaleDropped(dropped);
        setDraft({
          name: loaded.name, description: loaded.description, tags: loaded.tags,
          selection, execution: loaded.execution, notify: loaded.notify, members,
        });
      })
      .catch(() => message.error(t("suites.loadFailed")));
  }, [projectId, suiteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => {
    if (!suite || !draft) return false;
    const compare = (source: { name: string; description: string; tags: string[]; selection: SuiteSelection; execution: SuiteExecutionConfig; notify: SuiteNotifyConfig }) =>
      JSON.stringify(canonical({ name: source.name, description: source.description, tags: source.tags, selection: source.selection, execution: source.execution, notify: source.notify }));
    return compare(suite) !== compare(draft);
  }, [suite, draft]);

  /* 侧栏对这一页一无所知，所以离开提示在这里注册——与流程/接口编辑器同一套安排。 */
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

  useEffect(() => { localStorage.setItem("apitest.suiteHistoryOpen", String(historyOpen)); }, [historyOpen]);

  const loadHistory = useCallback(() => {
    if (!projectId || !suiteId) return;
    void api.suiteExecutions(projectId, suiteId, {
      status: historyStatus === "all" ? undefined : historyStatus,
      page: historyPage, pageSize: historyPageSize,
    })
      .then(setRuns)
      .catch(() => { /* 侧栏是辅助视图，加载失败不能挡住编辑器。 */ });
  }, [projectId, suiteId, historyStatus, historyPage, historyPageSize]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const openRun = useCallback((suiteExecutionId: string, focus = true) => {
    if (!projectId) return;
    void api.suiteExecution(projectId, suiteExecutionId)
      .then((detail) => {
        setRun(detail);
        /* 打开一次运行就把地址栏改成它：刷新后回到的应该是正在看的那一次，
           而不是上一次点开的那一次。 */
        if (focus) { setDrawerOpen(true); setSearchParams({ run: suiteExecutionId }, { replace: true }); }
      })
      .catch(() => message.error(t("reports.loadFailed")));
  }, [projectId, setSearchParams, t]);

  /**
   * 父级进度走事件，成员行靠一次详情重取。
   *
   * 成员级事件是没有的：一个成员就是一次独立执行，它在流上发的是自己的 execution /
   * flow 事件，不带套件的 id——想靠事件对号入座就必须在前端维护一份「这次运行有哪些
   * 子 id」的映射，而它在 fail-fast 跳过的成员上根本不成立。父级每落地一个成员就发一条
   * 进度，所以重取的时机本来就是准的。
   */
  useEffect(() => {
    stream.onEvent((event) => {
      if (event.kind !== "suite" || !run || event.suiteExecutionId !== run.id) return;
      const terminal = event.status !== "queued" && event.status !== "running";
      setRun((current) => (current ? {
        ...current,
        status: event.status, total: event.total,
        successCount: event.successCount, failedCount: event.failedCount, skippedCount: event.skippedCount,
      } : current));
      /* 成员行只在有人在看的时候重取：详情里带着每个用例成员的完整响应快照，按事件次数
         取会让一个 200 成员的套件把同一批证据反复搬上来，而抽屉关着时没人需要它。 */
      if (projectId && (drawerOpen || terminal)) {
        void api.suiteExecution(projectId, event.suiteExecutionId)
          .then(setRun)
          .catch(() => { /* 保留已有计数，下一条事件还会再试 */ });
      }
      if (!terminal) return;
      setCanceling(false);
      loadHistory();
    });
    return () => stream.onEvent(undefined);
  }, [stream, run, projectId, drawerOpen, loadHistory]);

  /**
   * 深链 `?run=<id>`：刷新后还能回到刚才在看的那次运行。
   *
   * 只恢复数据不弹抽屉——地址栏里带着一个 id 不等于用户此刻想看抽屉，运行条会显示它。
   */
  useEffect(() => {
    const runId = searchParams.get("run");
    if (!projectId || !runId || run?.id === runId) return;
    openRun(runId, false);
  }, [projectId, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * tag / all 的成员清单自动解析：进页面一次，条件改一次再一次。
   *
   * 手动选择的成员就在列表里，而**标签与全部的成员是算出来的**——不解析的话这一页只显示
   * 「标签: x, y」这几个条件，用户看不到它到底会跑到谁。原先要点一次「解析当前成员」才有
   * 答案，于是最需要答案的那一刻（刚改完标签）反而是空的。
   *
   * 键里带上 concurrency：峰值预算是按「需求最大的 C 个成员」算的，C 变了同一批成员的
   * 「会分批发出」结论也会变。防抖是必须的——`mode="tags"` 每敲一个字符都会触发 onChange。
   *
   * 用序列化后的键当依赖而不是 `draft.selection` 本身：每次 `patch` 都产生新对象，
   * 按引用比较会让这个 effect 在任何一次编辑（改名字、改并发）之后都重新解析一遍。
   */
  const autoPreviewKey = useMemo(() => {
    const selection = draft?.selection;
    if (!selection || selection.type === "manual") return "";
    /* 两个范围都没勾时服务端会拒绝，不去发一个必然 400 的请求。 */
    if (!selection.includeCases && !selection.includeFlows) return "";
    return JSON.stringify(canonical({ selection, concurrency: draft!.execution.concurrency }));
  }, [draft?.selection, draft?.execution.concurrency]); // eslint-disable-line react-hooks/exhaustive-deps
  const debouncedAutoPreview = useDebounced(autoPreviewKey, 400);

  useEffect(() => {
    if (!projectId || !suiteId || !debouncedAutoPreview) return;
    const { selection, concurrency } = JSON.parse(debouncedAutoPreview) as { selection: SuiteSelection; concurrency: number };
    let alive = true;
    setPreviewing(true);
    void api.previewSuite(projectId, suiteId, selection, concurrency)
      .then((resolved) => { if (alive) setPreview(resolved); })
      /* 自动解析失败保持静默：它不是用户点出来的动作，弹一条报错只是噪音，
         旁边的「解析当前成员」按钮仍然能手动重试并把错误说出来。 */
      .catch(() => { /* 手动按钮会报错 */ })
      .finally(() => { if (alive) setPreviewing(false); });
    return () => { alive = false; };
  }, [projectId, suiteId, debouncedAutoPreview]);

  /* 新一份解析结果从第一页看起：条件变了，旧页码对应的那批成员已经没有意义。 */
  useEffect(() => { setPreviewPage(1); }, [preview]);

  /**
   * Cmd+S / Ctrl+S 保存当前草稿，与接口/流程工作台同一条约定：绑在 window 上，无论
   * 焦点在哪个输入框都生效；拦掉浏览器自己的「保存网页」对话框。没改动时按键是空操作
   * ——不弹「已保存」的假反馈。
   *
   * 必须挂在「草稿还没加载」的早退之前：条件返回之后再声明 Hook，draft 一到位就会
   * 「比上一次渲染多一个 Hook」而整页崩掉（Rules of Hooks）。`save` 是函数声明，有
   * 提升，这里先引用是安全的。
   */
  useEffect(() => {
    function handleSaveKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (canWrite && dirty && !saving) void save();
    }
    window.addEventListener("keydown", handleSaveKey);
    return () => window.removeEventListener("keydown", handleSaveKey);
  }, [canWrite, dirty, saving, draft, suiteId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!draft) return <main className="content"><p className="muted">{t("filter.searching")}</p></main>;

  function patch(next: Partial<Draft>) { setDraft((current) => (current ? { ...current, ...next } : current)); }

  /** 切换选择方式时整块换掉配置：把旧的 tags 留在里面，保存后读出来形状对不上。 */
  function changeSelectionType(type: SuiteSelection["type"]) {
    const previous = draft!.selection;
    if (previous.type === type) return;
    /* 预览描述的是上一种选择方式，换了就必须收起，否则它会看起来像新方式的答案。 */
    setPreview(undefined);
    const includeCases = previous.type === "manual" ? true : previous.includeCases;
    const includeFlows = previous.type === "manual" ? true : previous.includeFlows;
    if (type === "manual") { patch({ selection: { type: "manual", members: draft!.members.map((member) => ({ type: member.type, id: member.id })) } }); return; }
    if (type === "tag") { patch({ selection: { type: "tag", tags: previous.type === "tag" ? previous.tags : [], match: "any", includeCases, includeFlows } }); return; }
    patch({ selection: { type: "all", includeCases, includeFlows } });
  }

  function addMembers(added: SuiteMemberSnapshot[]) {
    const members = [...draft!.members, ...added];
    /* 新成员追加在清单末尾：翻到最后一页，「刚加进来的」立即可见。 */
    setMemberPage(Math.max(1, Math.ceil(members.length / MEMBER_PAGE_SIZE)));
    patch({ members, selection: { type: "manual", members: members.map((member) => ({ type: member.type, id: member.id })) } });
  }

  function removeMember(index: number) {
    const members = draft!.members.filter((_, position) => position !== index);
    patch({ members, selection: { type: "manual", members: members.map((member) => ({ type: member.type, id: member.id })) } });
  }

  /**
   * 成员范围开关。
   *
   * 每个分支显式重建整个 selection，而不是 `{ ...selection, includeCases }`：
   * 在被收窄成联合类型的值上做展开，得到的是「联合的展开」，与判别联合的赋值目标经常
   * 对不上；写全字面量反而更短也更稳。
   */
  function setInclude(next: { includeCases?: boolean; includeFlows?: boolean }) {
    const current = draft!.selection;
    if (current.type === "manual") return;
    setPreview(undefined);
    const includeCases = next.includeCases ?? current.includeCases;
    const includeFlows = next.includeFlows ?? current.includeFlows;
    patch({
      selection: current.type === "tag"
        ? { type: "tag", tags: current.tags, match: current.match, includeCases, includeFlows }
        : { type: "all", includeCases, includeFlows },
    });
  }

  async function save() {
    if (!projectId || !suiteId || !draft!.name.trim()) return;
    setSaving(true);
    try {
      const saved = await api.updateTestSuite(projectId, suiteId, {
        name: draft!.name.trim(), description: draft!.description, tags: draft!.tags,
        selection: draft!.selection, execution: draft!.execution, notify: draft!.notify,
      });
      setSuite(saved);
      /* 悬空引用的清理随这次保存落库，提示不再需要。 */
      setStaleDropped(0);
      /* 用服务端存下来的那份回填草稿：它才是「现在库里是什么」。少了这一步，任何一处
          规范化（trim、标签去空、environmentId 被清掉）都会让页面继续显示「未保存」，
          而用户明明刚看到保存成功。 */
      setDraft((current) => (current ? {
        ...current,
        name: saved.name, description: saved.description, tags: saved.tags,
        selection: saved.selection, execution: saved.execution, notify: saved.notify,
      } : current));
      message.success(t("suites.saved"));
    } catch (error) {
      message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("suites.saveFailed"));
    } finally { setSaving(false); }
  }

  /* 预览未保存的这份配置：改一下就看一眼，不必先保存才知道会跑到谁。 */
  async function runPreview() {
    if (!projectId || !suiteId) return;
    setPreviewing(true);
    try { setPreview(await api.previewSuite(projectId, suiteId, draft!.selection, draft!.execution.concurrency)); }
    catch (error) {
      message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("suites.previewFailed"));
    } finally { setPreviewing(false); }
  }

  const selection = draft.selection;
  const includeInvalid = selection.type !== "manual" && !selection.includeCases && !selection.includeFlows;
  /* 只有选择方式的改动会让「跑的和看到的」不一致：执行设置是随运行请求一起发过去的。 */
  const selectionDirty = Boolean(suite) && JSON.stringify(canonical(suite!.selection)) !== JSON.stringify(canonical(selection));
  const busy = starting || run?.status === "queued" || run?.status === "running";

  /* 成员清单（手动 / 解析预览）就地分页：删掉本页最后一行时钳回最后一页，
     避免停在一张空表上。 */
  const currentMemberPage = Math.min(memberPage, Math.max(1, Math.ceil(draft.members.length / MEMBER_PAGE_SIZE)));
  const visibleMembers = draft.members.slice((currentMemberPage - 1) * MEMBER_PAGE_SIZE, currentMemberPage * MEMBER_PAGE_SIZE);
  const currentPreviewPage = Math.min(previewPage, Math.max(1, Math.ceil((preview?.members.length ?? 0) / MEMBER_PAGE_SIZE)));
  const visiblePreviewMembers = preview ? preview.members.slice((currentPreviewPage - 1) * MEMBER_PAGE_SIZE, currentPreviewPage * MEMBER_PAGE_SIZE) : [];

  /**
   * 运行这个套件（从运行弹窗确认，变量覆盖随行——校验在弹窗里，键约束同一条正则）。
   *
   * `execution` 跟着草稿走（改了并发/失败即停不必先保存就能跑一次，与用例、流程同一条
   * 规则），但**成员清单不跟**：服务端只按已保存的选择方式解析成员。所以选择方式没保存
   * 时先说清楚这一点，而不是让用户以为刚加的成员会跑到。
   */
  async function start(variables: Record<string, string>) {
    if (!projectId || !suiteId) return;
    if (selectionDirty) { message.warning(t("suites.runNeedsSave")); return; }
    setStarting(true);
    try {
      const queued = await api.executeSuite(projectId, suiteId, draft!.execution, variables);
      /* 入队返回的成员快照就是那次运行的完整清单，抽屉靠它先把所有成员行画出来。
         手动运行的触发三列由这里补上：202 响应是 suite_executions 的形状，不带
         execution_index 上的触发列（详情路由才 join），缺了它运行抽屉的标识段会崩。 */
      setRun({ ...queued, triggerSource: "manual", executionSteps: [], runs: [] });
      setDrawerOpen(true);
      setSearchParams({ run: queued.id }, { replace: true });
      setRunOpen(false);
      loadHistory();
    } catch (error) {
      /* 2004 = 这个分区没有在线执行器（P2-8 边界 5）；「成员跨分区」是 400，走 detail。 */
      const label = noRunnerLabel(error);
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(label !== undefined ? t("run.noRunner", { label })
        : detail?.includes("queue unavailable") ? t("run.queueUnavailable") : detail ?? t("suites.runFailed"));
    } finally {
      /* 只覆盖「请求还在路上」这一小段：入队成功之后 busy 由 run.status 自己说。 */
      setStarting(false);
    }
  }

  async function stop() {
    if (!projectId || !run) return;
    setCanceling(true);
    try {
      /* 取消的结论直接写回来，不等事件：事件丢了的话按钮会一直停在「取消执行」上。 */
      const canceled = await api.cancelSuiteExecution(projectId, run.id);
      setRun((current) => (current && current.id === canceled.id ? { ...current, ...canceled } : current));
    } catch { message.error(t("run.cancelFailed")); }
    finally { setCanceling(false); }
  }

  return <main className="content">
    <div className="page-head">
      <div className="page-head-main">
        <div className="title-row">
          <h1>{draft.name || t("suites.title")}</h1>
          {/* 与流程工作台同款提示：警告色 chip 并带上保存快捷键——本页也有 Cmd+S，
              「按什么能存」应该出现在「有改动」的同一眼位置。 */}
          {dirty && <span className="chip chip-warn">{t("editor.unsavedShortcut", { key: SAVE_KEY })}</span>}
        </div>
        <p>{selection.type === "manual" ? t("suites.selectionHintManual") : selection.type === "tag" ? t("suites.selectionHintTag") : t("suites.selectionHintAll")}</p>
      </div>
      <div className="topbar-actions">
        {/* 「解析成员」放在选择条件旁边，不放这里：它回答的是那几个条件命中了谁，
            离开条件就没有语境。手动选择根本不需要它——成员清单就在下面。 */}
        {canWrite && (busy
          ? <button className="btn btn-with-icon" disabled={canceling} onClick={() => void stop()}><Square size={14} />{t("run.cancel")}</button>
          : <button className="btn btn-with-icon" disabled={includeInvalid} onClick={() => setRunOpen(true)}><Play size={14} />{t("suites.run")}</button>)}
        {canWrite && <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !draft.name.trim() || includeInvalid}>{t("action.save")}</button>}
      </div>
    </div>

    {/* 抽屉可以被关掉，所以页面上要留一条「现在跑到哪了」，并且能把抽屉再打开。 */}
    {run && <div className="suite-run-bar">
      <RunStatusTag status={busy ? (run.status === "queued" ? "queued" : "running") : toRunStatus(run.status)} />
      <span className="mono muted">{t("suites.memberSummary", { success: run.successCount, total: run.total })}</span>
      {run.failedCount > 0 && <span className="mono text-fail">{t("suites.memberFailed", { count: run.failedCount })}</span>}
      {run.skippedCount > 0 && <span className="mono muted">{t("suites.memberSkipped", { count: run.skippedCount })}</span>}
      {run.error && <span className="mono truncate">{run.error}</span>}
      <span className="filter-spacer" />
      <button className="btn btn-small" onClick={() => setDrawerOpen(true)}>{t("suites.viewMembers")}</button>
    </div>}

    <div className={`workbench${historyOpen ? "" : " is-solo"}`}>
      <div className="workbench-main">
        <section className="panel">
          <div className="panel-head"><strong>{t("suites.basics")}</strong></div>
          <div className="panel-body">
            <label className="field">
              <span>{t("suites.name")}</span>
              <input className="input" value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder={t("suites.namePlaceholder")} />
            </label>
            <label className="field">
              <span>{t("suites.description")}</span>
              <input className="input" value={draft.description} onChange={(event) => patch({ description: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("suites.tags")}</span>
              <Select
                mode="tags" value={draft.tags} onChange={(tags: string[]) => patch({ tags })}
                /* 已有标签作为建议，同时仍然允许输入新的（mode="tags" 的语义）。 */
                options={suiteTags.map((tag) => ({ value: tag, label: tag }))}
                placeholder={t("suites.tagsPlaceholder")} style={{ width: "100%" }} tokenSeparators={[","]}
              />
            </label>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <strong>{t("suites.selection")}</strong>
            <div className="segmented">
              {(["manual", "tag", "all"] as const).map((type) => <button
                key={type}
                className={`segmented-item${selection.type === type ? " is-active" : ""}`}
                onClick={() => changeSelectionType(type)}
              >
                {type === "manual" ? t("suites.selectionManual") : type === "tag" ? t("suites.selectionTag") : t("suites.selectionAll")}
              </button>)}
            </div>
          </div>
          <div className="panel-body">
            {/* 选择方式改了但没保存：运行按的是库里那份，先说清楚，不要让人以为刚加的成员会跑到。 */}
            {selectionDirty && <p className="form-note">{t("suites.runNeedsSave")}</p>}
            {selection.type === "manual" ? <>
              {/* 旧数据留下的悬空引用已经就地清掉，但那是一次配置改动，要说出来并由保存确认。 */}
              {staleDropped > 0 && <p className="form-note">{t("suites.staleMembersDropped", { count: staleDropped })}</p>}
              <div className="filter-bar">
                <span className="mono muted">{t("suites.memberCount", { count: draft.members.length })}</span>
                <span className="filter-spacer" />
                <button className="btn btn-small btn-with-icon" onClick={() => setPicking(true)}><Plus size={14} />{t("suites.addMembers")}</button>
              </div>
              {draft.members.length ? <table className="grid picker-grid">
                <tbody>
                  {visibleMembers.map((member, index) => <tr key={`${member.type}:${member.id}`}>
                    <td className="suite-col-kind mono muted">{member.type === "case" ? t("suites.memberTypeCase") : t("suites.memberTypeFlow")}</td>
                    <td><span className="truncate">{member.name}</span></td>
                    <td className="mono muted truncate">{member.endpointName ?? member.environmentName ?? ""}</td>
                    <td className="col-actions">
                      <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => removeMember((currentMemberPage - 1) * MEMBER_PAGE_SIZE + index)} />
                    </td>
                  </tr>)}
                </tbody>
              </table> : <p className="muted">{t("suites.membersEmpty")}</p>}
              {draft.members.length > MEMBER_PAGE_SIZE && <div className="pager">
                <Pagination current={currentMemberPage} pageSize={MEMBER_PAGE_SIZE} total={draft.members.length} showSizeChanger={false} onChange={setMemberPage} />
              </div>}
            </> : <>
              {selection.type === "tag" && <>
                <label className="field">
                  <span>{t("suites.tags")}</span>
                  <Select
                    mode="tags" value={selection.tags}
                    onChange={(tags: string[]) => { setPreview(undefined); patch({ selection: { type: "tag", tags, match: selection.match, includeCases: selection.includeCases, includeFlows: selection.includeFlows } }); }}
                    /* 建议来自用例与流程已用过的标签——「按标签」匹配的正是这两者。 */
                    options={memberTags.map((tag) => ({ value: tag, label: tag }))}
                    placeholder={t("suites.tagsPlaceholder")} style={{ width: "100%" }} tokenSeparators={[","]}
                  />
                </label>
                <label className="field">
                  <span>{t("suites.tagMatch")}</span>
                  <Select
                    value={selection.match}
                    onChange={(match: "any" | "all") => { setPreview(undefined); patch({ selection: { type: "tag", tags: selection.tags, match, includeCases: selection.includeCases, includeFlows: selection.includeFlows } }); }}
                    options={[{ value: "any", label: t("suites.matchAny") }, { value: "all", label: t("suites.matchAll") }]}
                    style={{ width: 220 }}
                  />
                </label>
              </>}
              <div className="field">
                <span>{t("suites.include")}</span>
                <div className="check-row">
                  <label className="check-field">
                    <input type="checkbox" checked={selection.includeCases} onChange={(event) => setInclude({ includeCases: event.target.checked })} />
                    {t("suites.includeCases")}
                  </label>
                  <label className="check-field">
                    <input type="checkbox" checked={selection.includeFlows} onChange={(event) => setInclude({ includeFlows: event.target.checked })} />
                    {t("suites.includeFlows")}
                  </label>
                </div>
              </div>
              {includeInvalid && <p className="form-error">{t("suites.includeRequired")}</p>}
              {/*
                解析结果就地展开在条件下面，并且**自动**解析：改完标签就是最想知道
                「现在会跑到谁」的那一刻，让它停在「尚未解析」上等一次点击等于没给答案。
                按钮保留下来做手动重试——自动解析失败是静默的（它不是用户点出来的动作），
                需要看到错误原因时点它。
              */}
              <div className="filter-bar">
                <span className="mono muted">{previewing ? t("filter.searching") : preview ? t("suites.previewTotal", { total: preview.total }) : t("suites.previewIdle")}</span>
                <span className="filter-spacer" />
                <button className="btn btn-small" onClick={() => void runPreview()} disabled={previewing || includeInvalid}>{t("suites.previewAgain")}</button>
              </div>
              <p className="form-note">{t("suites.previewHint")}</p>
              {preview && <>
                {/* 超上限摊开说：运行会被拒绝，而不是静默截断到 200 个。悬空引用在这里
                    不可能出现——tag/all 按条件现算，`missing` 只属于手动选择。 */}
                {preview.total > preview.memberLimit && <p className="form-error">{t("suites.overLimit", { total: preview.total, limit: preview.memberLimit })}</p>}
                {preview.members.length ? <table className="grid picker-grid">
                  <tbody>
                    {visiblePreviewMembers.map((member) => <tr key={`${member.type}:${member.id}`}>
                      <td className="suite-col-kind mono muted">{member.type === "case" ? t("suites.memberTypeCase") : t("suites.memberTypeFlow")}</td>
                      <td><span className="truncate">{member.name}</span></td>
                      <td className="mono muted truncate">{member.endpointName ?? member.environmentName ?? ""}</td>
                    </tr>)}
                  </tbody>
                </table> : <p className="muted">{t("suites.previewEmpty")}</p>}
                {preview.members.length > MEMBER_PAGE_SIZE && <div className="pager">
                  <Pagination current={currentPreviewPage} pageSize={MEMBER_PAGE_SIZE} total={preview.members.length} showSizeChanger={false} onChange={setPreviewPage} />
                </div>}
              </>}
            </>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><strong>{t("suites.execution")}</strong></div>
          <div className="panel-body">
            <label className="field">
              <span>{t("suites.concurrency")}</span>
              <input
                className="input mono" type="number" min={1} max={concurrencyMax} value={draft.execution.concurrency}
                onChange={(event) => patch({ execution: { ...draft.execution, concurrency: Math.min(concurrencyMax, Math.max(1, Number(event.target.value) || 1)) } })}
                style={{ width: 110 }}
              />
            </label>
            {/* 说清这里不是「几个请求同时在飞」：那个数由平台预算封顶，写大了也不会突破。 */}
            <p className="form-note">{t("suites.concurrencyHint", { max: concurrencyMax })}</p>
            {/* 峰值超预算不拒绝运行，但报告里的「并发 N」会被分批打散——不写出来，
                用户就会把一份分批发出的结果当并发结论。只提「分批」是够的：单个成员要得
                比整池还多那一档在保存时就被挡住了（请求节点并发 ≤ 流程池容量 ≤ 套件池
                容量），走不到这里。 */}
            {preview && preview.concurrency.peak > preview.concurrency.budget && <p className="form-note">
              {t("suites.concurrencyBatched", { peak: preview.concurrency.peak, budget: preview.concurrency.budget })}
            </p>}
            <label className="check-field">
              <input type="checkbox" checked={draft.execution.failFast} onChange={(event) => patch({ execution: { ...draft.execution, failFast: event.target.checked } })} />
              {t("suites.failFast")}
            </label>
            <p className="form-note">{t("suites.failFastHint")}</p>
            <label className="field">
              <span>{t("suites.environmentStrategy")}</span>
              <Select
                value={draft.execution.environmentStrategy}
                onChange={(environmentStrategy: SuiteExecutionConfig["environmentStrategy"]) => patch({
                  execution: { ...draft.execution, environmentStrategy, environmentId: environmentStrategy === "override" ? draft.execution.environmentId : undefined },
                })}
                options={[{ value: "member_default", label: t("suites.envMemberDefault") }, { value: "override", label: t("suites.envOverride") }]}
                style={{ width: 220 }}
              />
            </label>
            {draft.execution.environmentStrategy === "override" && <label className="field">
              <span>{t("suites.pickEnvironment")}</span>
              <Select
                value={draft.execution.environmentId}
                onChange={(environmentId: string) => patch({ execution: { ...draft.execution, environmentId } })}
                options={environments.map((item) => ({ value: item.id, label: item.name }))}
                placeholder={t("suites.pickEnvironment")}
                style={{ width: 260 }}
              />
            </label>}
          </div>
        </section>

        {/* 定时调度（P3-11）：独立调度页已删除，配置入口收进它的目标。
            排在通知设置之前（验收反馈）：调度是「怎么跑」，通知是「跑完之后」，
            阅读顺序与执行顺序一致。P4.5-12 起同一个组件也挂在 CI 任务上。 */}
        <ResourceSchedules projectId={projectId!} targetType="suite" targetId={suiteId!} />

        {/* 通知设置（P3-11）：终态按开关投递。配置跟套件走——「这个套件跑完了告诉我」
            与「项目的质量指标怎么了」（告警规则页）是两个问题，两处配置互不替代。 */}
        <section className="panel">
          <div className="panel-head"><strong>{t("suites.notify.title")}</strong></div>
          <div className="panel-body">
            <div className="check-row">
              <label className="check-field">
                <input type="checkbox" checked={draft.notify.onSuccess} onChange={(event) => patch({ notify: { ...draft.notify, onSuccess: event.target.checked } })} />
                {t("suites.notify.onSuccess")}
              </label>
              <label className="check-field">
                <input type="checkbox" checked={draft.notify.onFailure} onChange={(event) => patch({ notify: { ...draft.notify, onFailure: event.target.checked } })} />
                {t("suites.notify.onFailure")}
              </label>
            </div>
            <p className="form-note">{t("suites.notify.hint")}</p>
            <label className="field">
              <span>{t("suites.notify.channels")}</span>
              <Select
                mode="multiple"
                value={draft.notify.channelIds}
                onChange={(channelIds: string[]) => patch({ notify: { ...draft.notify, channelIds } })}
                options={channels.map((channel) => ({ value: channel.id, label: channel.name }))}
                placeholder={t("suites.notify.channelsPlaceholder")}
                style={{ width: "100%" }}
              />
              {!channels.length && <p className="form-note">{t("suites.notify.noChannels")}</p>}
            </label>
            <label className="field">
              <span>{t("suites.notify.templateTitle")}</span>
              <input className="input" value={draft.notify.template?.title ?? ""} onChange={(event) => patch({ notify: { ...draft.notify, template: templateOf(draft.notify, { title: event.target.value }) } })} placeholder={t("suites.notify.templateTitlePlaceholder")} spellCheck={false} />
            </label>
            <label className="field">
              <span>{t("suites.notify.templateBody")}</span>
              <textarea
                className="input mono"
                rows={5}
                value={draft.notify.template?.body ?? ""}
                onChange={(event) => patch({ notify: { ...draft.notify, template: templateOf(draft.notify, { body: event.target.value }) } })}
                placeholder={t("suites.notify.templateBodyPlaceholder")}
                spellCheck={false}
              />
              <p className="form-note">{t("suites.notify.templateHint")}</p>
            </label>
          </div>
        </section>
      </div>

      <HistorySidebar
        open={historyOpen}
        onToggle={() => setHistoryOpen((current) => !current)}
        railLabel={t("suites.runRecords")}
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
          <button
            key={item.id}
            className={`history-item${run?.id === item.id ? " is-active" : ""}`}
            onClick={() => openRun(item.id)}
          >
            <div className="history-item-top">
              <RunStatusTag status={toRunStatus(item.status)} />
              <span className="mono muted">{t("suites.memberSummary", { success: item.successCount, total: item.total })}</span>
            </div>
            <span className="mono muted history-time">{new Date(item.createdAt).toLocaleString()}</span>
          </button>
        )) : <p className="muted history-empty">{historyStatus === "all" ? t("suites.runRecordsEmpty") : t("reports.emptyFilterHint")}</p>}
        pager={<SidebarPager
          page={runs.page}
          pageSize={runs.pageSize}
          total={runs.total}
          onPage={setHistoryPage}
          onPageSize={(size) => { setHistoryPageSize(size); setHistoryPage(1); }}
        />}
      />
    </div>

    <SuiteMemberPicker
      projectId={projectId!}
      open={picking}
      existing={draft.members.map((member) => ({ type: member.type, id: member.id }))}
      onClose={() => setPicking(false)}
      onAdd={addMembers}
    />

    {/* 运行确认弹窗（变量覆盖）：与套件列表行共用同一个组件，值在本页会话内保留。 */}
    <SuiteRunModal
      open={runOpen}
      running={starting}
      onClose={() => setRunOpen(false)}
      onRun={(variables) => { setRunOpen(false); void start(variables); }}
    />

    <SuiteRunDrawer
      projectId={projectId!}
      run={drawerOpen ? run : undefined}
      onClose={() => setDrawerOpen(false)}
      /* viewer 也能看到别人触发的运行抽屉（SSE 是广播），但取消不给（P6-4）。 */
      onCancel={canWrite ? () => void stop() : undefined}
      canceling={canceling}
    />
  </main>;
}
