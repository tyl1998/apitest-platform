import { useEffect, useMemo, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Copy, CopyPlus, Crosshair, History, Maximize2, Play, Plus, Save, SaveAll, Trash2 } from "lucide-react";
import { api, noRunnerLabel, type Assertion, type BodyType, type CaseUsage, type Endpoint, type EndpointAuth, type EndpointInput, type Execution, type ExecutionSourceFilter, type FlowExtract, type Paged, type PreRequestHook, type RequestSnapshot, type ResponseScript, type TestCase } from "../api";
import { useExecutionStream } from "../hooks/useExecutionStream";
import { useCanWrite } from "../hooks/useMyRole";
import { usePageContext } from "../hooks/usePageContext";
import { variableOptions } from "../lib/flowVariables";
import { useNavGuardStore } from "../stores/navGuardStore";
import { useProjectStore } from "../stores/projectStore";
import { KeyValueEditor, fromPairs, toPairs, type Pair } from "./KeyValueEditor";
import { ChangeHistoryDrawer } from "./AuditLogsPanel";
import { ExecutionSnapshot } from "./ExecutionSnapshot";
import { HistorySidebar } from "./HistorySidebar";
import { IconButton } from "./IconButton";
import { RunStatusTag } from "./RunStatusTag";
import { AssertionEditor, AssertionResults } from "./AssertionEditor";
import { CaseBox, CaseDialog, type CaseDialogMode } from "./CaseBox";
import { CaseFlowSync } from "./CaseFlowSync";
import { SidebarPager, SIDEBAR_PAGE_SIZES } from "./SidebarPager";
import { CopyButton } from "./CopyButton";
import { VariableField } from "./VariableField";
import type { VariableOption } from "./VariablePicker";
import { toRunStatus } from "../ui";
import { PreRequestHookEditor } from "./PreRequestHookEditor";
import { ResponseScriptEditor, ResponseScriptResults } from "./ResponseScriptEditor";
import { JsonPathPicker } from "./JsonPathPicker";
import { HeaderPicker } from "./HeaderPicker";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
/** Mac reads ⌘S; everything else reads Ctrl+S. Shown, never parsed. */
const SAVE_KEY = navigator.platform.toLowerCase().includes("mac") ? "⌘S" : "Ctrl+S";
const BODY_TYPES: BodyType[] = ["none", "json", "form", "text"];
type Tab = "params" | "headers" | "body" | "auth" | "pre" | "post" | "assertions" | "sync";
type ResponseTab = "body" | "headers" | "request";
/** The sidebar shows one of these at a time (交互文档 3.1.3). */
type SideTab = "cases" | "history";

type Draft = {
  name: string;
  description: string;
  method: string;
  url: string;
  headers: Pair[];
  queryParams: Pair[];
  pathParams: Pair[];
  bodyType: BodyType;
  bodyText: string;
  auth: EndpointAuth;
  tags: string;
  defaultEnvironmentId?: string;
};

const EMPTY: Draft = {
  name: "", description: "", method: "GET", url: "",
  headers: [], queryParams: [], pathParams: [],
  bodyType: "none", bodyText: "", auth: { type: "none" }, tags: "",
};

/** Splits a stored URL into base + query pairs so the bar and the table agree. */
function splitUrl(url: string): { base: string; query: Pair[] } {
  const index = url.indexOf("?");
  if (index < 0) return { base: safeDecodeUrl(url), query: [] };
  const base = safeDecodeUrl(url.slice(0, index));
  const query = url.slice(index + 1).split("&").filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? "" : part.slice(eq + 1);
    return { key: safeDecode(rawKey), value: safeDecode(rawValue), enabled: true };
  });
  return { base, query };
}

function safeDecode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function safeDecodeUrl(value: string) {
  try { return decodeURI(value); } catch { return value; }
}

/** Rebuilds the address bar from base + enabled pairs. Disabled rows stay out. */
function composeUrl(base: string, query: Pair[]) {
  const active = query.filter((pair) => pair.enabled && pair.key.trim());
  if (!active.length) return base;
  const search = active.map((pair) => `${pair.key.trim()}=${pair.value}`).join("&");
  return `${base}${base.includes("?") ? "&" : "?"}${search}`;
}

function toDraft(endpoint: Endpoint): Draft {
  /* A query string saved inside url is lifted into the table, so both views
     start consistent and editing either one stays predictable. */
  const { base, query } = splitUrl(endpoint.url);
  const stored = toPairs(endpoint.queryParams);
  return {
    name: endpoint.name,
    description: endpoint.description,
    method: endpoint.method,
    url: base,
    headers: toPairs(endpoint.headers),
    queryParams: [...stored, ...query.filter((pair) => !stored.some((item) => item.key === pair.key))],
    pathParams: toPairs(endpoint.pathParams),
    bodyType: endpoint.bodyType,
    bodyText: endpoint.bodyType === "json"
      ? (endpoint.body === undefined ? "" : JSON.stringify(endpoint.body, null, 2))
      : endpoint.bodyText ?? "",
    auth: endpoint.auth,
    tags: endpoint.tags.join(", "),
    defaultEnvironmentId: endpoint.defaultEnvironmentId,
  };
}

/**
 * Freezes what is on screen into the request a case stores.
 *
 * Returns undefined when the JSON body does not parse, because a case that
 * cannot be sent is worse than a refused save.
 */
function toSnapshot(draft: Draft): RequestSnapshot | undefined {
  let body: unknown;
  let bodyText: string | undefined;
  if (draft.bodyType === "json" && draft.bodyText.trim()) {
    try { body = JSON.parse(draft.bodyText); } catch { return undefined; }
  } else if (draft.bodyType !== "none") bodyText = draft.bodyText;

  return {
    method: draft.method,
    url: draft.url.trim(),
    headers: fromPairs(draft.headers),
    queryParams: fromPairs(draft.queryParams),
    pathParams: fromPairs(draft.pathParams),
    bodyType: draft.bodyType,
    body,
    bodyText,
    auth: draft.auth,
  };
}

/** Loads a case's frozen request into the editor, keeping name/description/tags. */
function snapshotToDraft(current: Draft, request: RequestSnapshot): Draft {
  return {
    ...current,
    method: request.method,
    url: request.url,
    headers: toPairs(request.headers),
    queryParams: toPairs(request.queryParams),
    pathParams: toPairs(request.pathParams),
    bodyType: request.bodyType,
    bodyText: request.bodyType === "json"
      ? (request.body === undefined ? "" : JSON.stringify(request.body, null, 2))
      : request.bodyText ?? "",
    auth: request.auth,
  };
}

function toCurl(draft: Draft) {
  const parts = [`curl -X ${draft.method}`, `'${composeUrl(draft.url, draft.queryParams)}'`];
  for (const [key, value] of Object.entries(fromPairs(draft.headers))) parts.push(`-H '${key}: ${value}'`);
  const auth = draft.auth;
  if (auth.type === "bearer") parts.push(`-H 'Authorization: Bearer ${auth.token}'`);
  if (auth.type === "basic") parts.push(`-u '${auth.username}:${auth.password}'`);
  if (auth.type === "apiKey" && auth.in === "header") parts.push(`-H '${auth.key}: ${auth.value}'`);
  if (draft.bodyType !== "none" && draft.bodyText.trim()) parts.push(`--data-raw '${draft.bodyText.replace(/'/g, "'\\''")}'`);
  return parts.join(" \\\n  ");
}

/**
 * Request builder and response viewer on one surface, the way an API client
 * works: edit the request, send it, read the response without leaving.
 *
 * The response is inline rather than in a drawer, because comparing a response
 * against the request that produced it is the core loop; a drawer covers the
 * request you are trying to adjust.
 */
export function EndpointWorkspace() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projectId, endpointId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const isNew = endpointId === "new";
  const { environments, endpoints, defaultEnvironmentId, reloadEndpoints } = useProjectStore();
  const setGuard = useNavGuardStore((state) => state.setGuard);
  /* viewer 隐藏写与执行按钮（P6-4）：编辑器本体保留——本地草稿改了也存不回去，
     路由不藏，后端才是权限事实。 */
  const canWrite = useCanWrite();

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [urlText, setUrlText] = useState("");
  const [tab, setTab] = useState<Tab>("params");
  const [responseTab, setResponseTab] = useState<ResponseTab>("body");
  const [pretty, setPretty] = useState(true);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [running, setRunning] = useState(false);
  const [bodyError, setBodyError] = useState<string>();
  const [runs, setRuns] = useState<Paged<Execution>>({ items: [], page: 1, pageSize: 20, total: 0 });
  const [historyStatus, setHistoryStatus] = useState("all");
  const [historySource, setHistorySource] = useState("all");
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(SIDEBAR_PAGE_SIZES[1]);
  /** The response of the send made from this screen. Only `send` replaces it. */
  const [result, setResult] = useState<Execution>();
  /**
   * The queued or in-flight run started from this screen (P1-3).
   *
   * Separate from `result`: while it is set the response area shows the run's
   * state and offers a cancel, and it is what the cancel button acts on.
   */
  const [pending, setPending] = useState<Execution>();
  const [canceling, setCanceling] = useState(false);
  /** The run the snapshot drawer is showing. Independent of the inline panel. */
  const [inspecting, setInspecting] = useState<Execution>();
  const [historyOpen, setHistoryOpen] = useState(localStorage.getItem("apitest.historyOpen") !== "false");
  /* 用例 is the default view: it is the durable asset, while debug records are
     transient. `?side=history` from a deep link still opens the records. */
  const [sideTab, setSideTab] = useState<SideTab>(searchParams.get("side") === "history" ? "history" : "cases");
  const [cases, setCases] = useState<TestCase[]>([]);
  /**
   * The case whose snapshot currently occupies the request area, plus the draft
   * it displaced. Keeping the displaced draft is what makes [返回调试] able to
   * restore the exact editing state the user left (交互文档 3.1.3).
   */
  const [activeCase, setActiveCase] = useState<TestCase>();
  const [debugDraft, setDebugDraft] = useState<Draft>();
  /* 「变更历史」抽屉（P11-10 边界 8）：跟屏幕上正在编辑的东西走——加载了用例就查用例，
     否则查接口。与 runs 侧栏的 `historyOpen` 是两个东西，名字分开。 */
  const [changeHistoryOpen, setChangeHistoryOpen] = useState(false);
  /**
   * Comparison point while a case is loaded, kept separate from `baseline`.
   *
   * The endpoint baseline has to survive a case visit untouched: reusing it
   * would make [返回调试] restore a draft that compares equal to itself, so
   * unsaved endpoint edits would lose the "unsaved" chip and the nav guard.
   */
  const [caseBaseline, setCaseBaseline] = useState<string>();
  /**
   * The loaded case's assertions, edited in the 校验 tab.
   *
   * Held apart from `draft` because they are not part of the request: the
   * request area describes what to send, assertions describe what the answer
   * must satisfy. Saved explicitly, so editing them mirrors editing a request.
   */
  const [caseAssertions, setCaseAssertions] = useState<Assertion[]>([]);
  const [caseHooks, setCaseHooks] = useState<PreRequestHook[]>([]);
  const [caseExtracts, setCaseExtracts] = useState<FlowExtract[]>([]);
  const [caseResponseScripts, setCaseResponseScripts] = useState<ResponseScript[]>([]);
  const [lifecycleBaseline, setLifecycleBaseline] = useState("{}");
  const [pickExtractBody, setPickExtractBody] = useState<number>();
  const [pickExtractHeader, setPickExtractHeader] = useState<number>();
  const [savingCase, setSavingCase] = useState(false);
  const [caseDialog, setCaseDialog] = useState<CaseDialogMode>();
  const [runningCase, setRunningCase] = useState<string>();
  /**
   * State, not a ref: `dirty` is derived from it, and a ref mutation does not
   * re-render, so after a save the "unsaved" chip stayed on screen until the
   * next keystroke.
   */
  const [baseline, setBaseline] = useState(JSON.stringify(EMPTY));

  /**
   * Variables a request field can reference: the bound environment plus the
   * builtins. There is no flow here, so there is no "upstream step" origin —
   * an endpoint runs against an environment or against nothing.
   */
  const variableChoices = useMemo(
    () => variableOptions({ environment: environments.find((item) => item.id === draft.defaultEnvironmentId) }),
    [environments, draft.defaultEnvironmentId],
  );

  /* Runs are queued and executed by a worker (P1-3); the outcome arrives here. */
  const stream = useExecutionStream(projectId);

  /* 助手页面上下文（P9-4c）：URL 已带 endpointId，这里补不在 URL 里的组件态——
     正在编辑的用例（「改一下当前接口的断言」指向它）、侧栏焦点、最近一次执行。 */
  usePageContext(endpointId && !isNew ? {
    page: "endpoint-workspace",
    entities: {
      endpointId,
      ...(draft.name ? { endpointName: draft.name } : {}),
      method: draft.method,
      ...(draft.url ? { url: draft.url } : {}),
      ...(activeCase ? { caseId: activeCase.id, caseName: activeCase.name } : {}),
      ...(runs.items[0] ? { executionId: runs.items[0].id } : {}),
    },
    focus: activeCase ? "case-editor" : sideTab,
  } : undefined);

  /* Keeps 排队中 → 执行中 visible on the response panel while the run is awaited. */
  useEffect(() => {
    stream.onEvent((event) => {
      if (event.kind !== "execution") return;
      setPending((current) => (current && current.id === event.executionId ? { ...current, status: event.status } : current));
    });
    return () => stream.onEvent(undefined);
  }, [stream]);

  useEffect(() => { localStorage.setItem("apitest.historyOpen", String(historyOpen)); }, [historyOpen]);

  useEffect(() => {
    if (isNew) { setDraft(EMPTY); setUrlText(""); setBaseline(JSON.stringify(EMPTY)); setLoading(false); return; }
    if (!projectId || !endpointId) return;
    setLoading(true);
    setResult(undefined);
    setInspecting(undefined);
    /* A case belongs to one endpoint, so switching endpoints leaves it behind. */
    setActiveCase(undefined);
    setDebugDraft(undefined);
    api.endpoint(projectId, endpointId)
      .then((endpoint) => {
        const next = toDraft(endpoint);
        setBaseline(JSON.stringify(next));
        setDraft(next);
        setUrlText(composeUrl(next.url, next.queryParams));
      })
      .catch(() => message.error(t("endpoints.loadFailed")))
      .finally(() => setLoading(false));
  }, [projectId, endpointId, isNew]);

  async function loadHistory() {
    if (isNew || !projectId || !endpointId) return;
    setRuns(await api.endpointExecutions(projectId, endpointId, { status: historyStatus, source: historySource as ExecutionSourceFilter, page: historyPage, pageSize: historyPageSize }));
  }
  useEffect(() => { void loadHistory(); }, [projectId, endpointId, historyStatus, historySource, historyPage, historyPageSize]);

  async function loadCases() {
    if (isNew || !projectId || !endpointId) return;
    try { setCases(await api.cases(projectId, endpointId)); }
    catch { /* The sidebar is secondary; a failed load must not block the editor. */ }
  }
  useEffect(() => { void loadCases(); }, [projectId, endpointId]);

  /* A loaded case is compared against its own snapshot, so the chip reports
     edits to the case; otherwise the draft is compared against the endpoint. */
  const dirty = useMemo(() => JSON.stringify(draft) !== (activeCase ? caseBaseline : baseline), [draft, baseline, caseBaseline, activeCase]);
  /**
   * Unsaved endpoint edits parked by a case visit still need protecting: with a
   * case loaded and untouched, `dirty` is false while the stashed draft差异 is
   * what would be lost on navigation.
   */
  const stashedDirty = useMemo(() => Boolean(debugDraft) && JSON.stringify(debugDraft) !== baseline, [debugDraft, baseline]);
  /* Assertions save separately from the request, so they carry their own flag. */
  const lifecycleDraft = useMemo(() => ({ assertions: caseAssertions, preRequestHooks: caseHooks, extracts: caseExtracts, responseScripts: caseResponseScripts }), [caseAssertions, caseHooks, caseExtracts, caseResponseScripts]);
  const assertionsDirty = useMemo(() => Boolean(activeCase) && JSON.stringify(lifecycleDraft) !== lifecycleBaseline, [activeCase, lifecycleDraft, lifecycleBaseline]);
  /* One flag for the case's save button: request and assertions save together. */
  const caseDirty = dirty || assertionsDirty;
  const unsaved = dirty || stashedDirty || assertionsDirty;
  /* The title chip speaks for the endpoint definition; the case banner speaks
     for the loaded case, so the two never both claim "unsaved". */
  const endpointDirty = activeCase ? stashedDirty : dirty;

  /**
   * Cmd+S / Ctrl+S saves whatever is on screen: the loaded case, or the
   * endpoint definition. Declared after the dirty flags it reads, and bound to
   * the window so it works regardless of which field has focus.
   */
  useEffect(() => {
    function handleSaveKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      /* The browser's own save dialog is never what the user wants here. */
      event.preventDefault();
      if (!canWrite) return;
      if (activeCase) { if (caseDirty) void saveCase(); return; }
      if (dirty) void save();
    }
    window.addEventListener("keydown", handleSaveKey);
    return () => window.removeEventListener("keydown", handleSaveKey);
  }, [canWrite, activeCase, caseDirty, dirty, draft, lifecycleDraft]);

  /**
   * Confirms before discarding edits.
   *
   * Registered in a store so the shell's sidebar can ask too. Not useBlocker:
   * that requires a data router (createBrowserRouter) and this app mounts
   * <BrowserRouter>, where calling it throws during render.
   */
  useEffect(() => {
    if (!unsaved) { setGuard(null); return; }
    setGuard(() => new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: t("editor.discardTitle"), content: t("editor.discardHint"),
        okText: t("editor.discard"), cancelText: t("action.cancel"), okButtonProps: { danger: true },
        onOk: () => resolve(true), onCancel: () => resolve(false),
      });
    }));
    return () => setGuard(null);
  }, [unsaved, setGuard, t]);

  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  function patch(changes: Partial<Draft>) { setDraft((current) => ({ ...current, ...changes })); }

  /* Typing in the address bar fills the params table. */
  function editUrl(value: string) {
    setUrlText(value);
    const { base, query } = splitUrl(value);
    const disabled = draft.queryParams.filter((pair) => !pair.enabled);
    setDraft((current) => ({ ...current, url: base, queryParams: [...query, ...disabled] }));
  }

  /* Editing the table rewrites the address bar. */
  function editQuery(queryParams: Pair[]) {
    setDraft((current) => ({ ...current, queryParams }));
    setUrlText(composeUrl(draft.url, queryParams));
  }

  function buildPayload(): EndpointInput | undefined {
    if (!draft.name.trim()) { message.error(t("endpoints.nameRequired")); return; }
    if (!draft.url.trim()) { message.error(t("endpoints.urlRequired")); return; }
    let body: unknown;
    let bodyText: string | undefined;
    if (draft.bodyType === "json" && draft.bodyText.trim()) {
      try { body = JSON.parse(draft.bodyText); }
      catch (error) { setBodyError(error instanceof Error ? error.message : "invalid JSON"); setTab("body"); return; }
    } else if (draft.bodyType !== "none") { bodyText = draft.bodyText; }
    setBodyError(undefined);
    return {
      name: draft.name.trim(), description: draft.description.trim(),
      method: draft.method, url: draft.url.trim(),
      headers: fromPairs(draft.headers), queryParams: fromPairs(draft.queryParams), pathParams: fromPairs(draft.pathParams),
      bodyType: draft.bodyType, body, bodyText, auth: draft.auth,
      tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      defaultEnvironmentId: draft.defaultEnvironmentId ?? null,
    };
  }

  /** `silent` suppresses the success toast for the save that precedes a run. */
  async function save(silent = false): Promise<string | undefined> {
    const payload = buildPayload();
    if (!payload || !projectId) return;
    const attempted = draft;
    setSaving(true);
    try {
      const saved = isNew ? await api.createEndpoint(projectId, payload) : await api.updateEndpoint(projectId, endpointId!, payload);
      /**
       * The payload is trimmed and the tag list normalised before it is sent,
       * so the screen has to adopt those same values. Comparing the raw draft
       * against them would leave the editor permanently "unsaved" whenever a
       * field had surrounding whitespace.
       */
      const normalised: Draft = { ...attempted, name: payload.name, description: payload.description ?? "", url: payload.url, tags: (payload.tags ?? []).join(", ") };
      setBaseline(JSON.stringify(normalised));
      /* Only adopt it if the user has not typed since the request went out. */
      setDraft((current) => (current === attempted ? normalised : current));
      setGuard(null);
      await reloadEndpoints();
      /* `send()` calls this silently before executing: a toast after every run
         would become noise. Keep it for manual saves (Cmd+S), hide it for the
         automatic one that precedes execution. */
      if (silent !== true) message.success(isNew ? t("endpoints.created") : t("endpoints.updated"));
      if (isNew) navigate(`/projects/${projectId}/endpoints/${saved.id}`, { replace: true });
      return saved.id;
    } catch { message.error(t("endpoints.saveFailed")); return undefined; }
    finally { setSaving(false); }
  }

  /**
   * Follows a queued run to its terminal state (P1-3).
   *
   * The button keeps spinning throughout, so from the user's side a send still
   * reads as "press, wait, read the response" — the queue is an implementation
   * detail, not a new interaction.
   */
  async function follow(queued: Execution) {
    setPending(queued);
    try {
      const settled = await stream.awaitRun(queued.id);
      setResult(settled);
      /* Switched here, not at send time: the previous response stays on screen
         while the new one runs, so jumping tabs early would re-render the old
         body under a tab the user did not choose. */
      setResponseTab("body");
      return settled;
    } finally {
      setPending(undefined);
    }
  }

  /** Reports a queue that refused the run, which is not the same as a failed request. */
  function reportRunFailure(error: unknown) {
    /* 2004 = 这个分区没有在线执行器（P2-8 边界 5），与队列不可用分开报。 */
    const label = noRunnerLabel(error);
    const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
    message.error(label !== undefined ? t("run.noRunner", { label })
      : detail?.includes("queue unavailable") ? t("run.queueUnavailable") : t("endpoints.runFailed"));
  }

  /* Send always runs what is on screen, so unsaved edits are persisted first. */
  async function send() {
    if (!projectId) return;
    /**
     * While a case is loaded, "send" runs the case: its assertions decide the
     * verdict, and the request on screen is passed through so edits are honoured
     * without being written back to the case (交互文档 3.1.3).
     */
    if (activeCase) { await runCase(activeCase, true); return; }
    let targetId = endpointId;
    /* Executing a debug request requires the definition to be on disk (the
       server reads it from the database), so saving first is automatic. The
       toast is suppressed: every run would announce a save, which is noise. */
    if (isNew || dirty) { targetId = await save(true); if (!targetId) return; }
    setRunning(true);
    try {
      await follow(await api.execute(projectId, targetId!, draft.defaultEnvironmentId ?? undefined));
      await loadHistory();
    } catch (error) { reportRunFailure(error); }
    finally { setRunning(false); }
  }

  /** Stops the run this screen is waiting on, queued or already in flight. */
  async function cancelPending() {
    if (!projectId || !pending) return;
    setCanceling(true);
    try { await api.cancelExecution(projectId, pending.id); }
    catch { message.error(t("run.cancelFailed")); }
    finally { setCanceling(false); }
  }

  /**
   * Loads a case's snapshot into the request area.
   *
   * No confirmation is needed even with unsaved edits: the displaced draft is
   * kept and [返回调试] restores it (交互文档 3.1.3 还原点击前的草稿).
   */
  async function openCase(testCase: TestCase, keepResult = false) {
    if (activeCase?.id === testCase.id) return;
    if (!activeCase) setDebugDraft(draft);
    const next = snapshotToDraft(draft, testCase.request);
    setDraft(next);
    setUrlText(composeUrl(next.url, next.queryParams));
    setCaseBaseline(JSON.stringify(next));
    setCaseAssertions(testCase.assertions);
    const hooks = testCase.preRequestHooks ?? [];
    const extracts = testCase.extracts ?? [];
    const responseScripts = testCase.responseScripts ?? [];
    setCaseHooks(hooks);
    setCaseExtracts(extracts);
    setCaseResponseScripts(responseScripts);
    setLifecycleBaseline(JSON.stringify({ assertions: testCase.assertions, preRequestHooks: hooks, extracts, responseScripts }));
    setActiveCase(testCase);
    /* Cleared because a stored case's snapshot is not what produced the
       response on screen — except right after 保存为用例, where the case was
       frozen from exactly that request. */
    if (!keepResult) setResult(undefined);
    setTab("params");
    setSideTab("cases");
    setSearchParams((current) => { current.set("case", testCase.id); current.delete("run"); return current; }, { replace: true });
  }

  /** Restores the draft a case displaced, leaving the case untouched. */
  function returnToDebug() {
    const restored = debugDraft ?? draft;
    setDraft(restored);
    setUrlText(composeUrl(restored.url, restored.queryParams));
    /* `baseline` was never overwritten, so unsaved endpoint edits stay marked. */
    setCaseBaseline(undefined);
    setCaseAssertions([]);
    setCaseHooks([]); setCaseExtracts([]); setCaseResponseScripts([]);
    setLifecycleBaseline("{}");
    setActiveCase(undefined);
    setDebugDraft(undefined);
    setResult(undefined);
    /* 前置/后置/校验/同步四个 tab 只在用例加载时存在：留在上面会让 tab 头看起来空一格。 */
    setTab((current) => (current === "assertions" || current === "pre" || current === "post" || current === "sync" ? "params" : current));
    setSearchParams((current) => { current.delete("case"); return current; }, { replace: true });
  }

  /**
   * Saves the loaded case: request snapshot and assertions in one write.
   *
   * Splitting these into two buttons meant a request edit had nowhere to go —
   * the screen showed the case, but only its assertions could be persisted.
   * Snapshot isolation still holds: this rewrites the case the user is looking
   * at, never the endpoint definition it was originally taken from.
   */
  async function saveCase() {
    if (!projectId || !activeCase) return;
    const request = toSnapshot(draft);
    if (!request) { setBodyError(t("editor.invalidJsonShort")); setTab("body"); return; }
    if (!request.url) { message.error(t("endpoints.urlRequired")); return; }
    setSavingCase(true);
    try {
      const updated = await api.updateCase(projectId, activeCase.id, { request, assertions: caseAssertions, preRequestHooks: caseHooks, extracts: caseExtracts, responseScripts: caseResponseScripts });
      setActiveCase(updated);
      setCaseBaseline(JSON.stringify(draft));
      setCaseAssertions(updated.assertions);
      setCaseHooks(updated.preRequestHooks); setCaseExtracts(updated.extracts); setCaseResponseScripts(updated.responseScripts);
      setLifecycleBaseline(JSON.stringify({ assertions: updated.assertions, preRequestHooks: updated.preRequestHooks, extracts: updated.extracts, responseScripts: updated.responseScripts }));
      await loadCases();
      message.success(t("cases.updated"));
    } catch { message.error(t("cases.saveFailed")); }
    finally { setSavingCase(false); }
  }

  /**
   * Runs one case. `fromWorkbench` passes the request on screen, which is how a
   * loaded-and-edited case runs; the sidebar's run button sends the stored
   * snapshot instead.
   */
  async function runCase(testCase: TestCase, fromWorkbench = false) {
    if (!projectId) return;
    const override = fromWorkbench ? toSnapshot(draft) : undefined;
    if (fromWorkbench && !override) { setBodyError(t("editor.invalidJsonShort")); setTab("body"); return; }
    setRunningCase(testCase.id);
    if (fromWorkbench) setRunning(true);
    try {
      /* Unsaved 校验 edits run too, so the tab reports on the rules on screen
         rather than the ones last persisted. */
      const lifecycle = fromWorkbench && assertionsDirty ? lifecycleDraft : undefined;
      const queued = await api.executeCase(projectId, testCase.id, override || lifecycle ? { request: override, ...lifecycle } : undefined);
      /* Shown inline when the run came from this screen; the sidebar run only
         needs the list's「最近结果」to refresh. */
      if (fromWorkbench) await follow(queued);
      else await stream.awaitRun(queued.id);
      await loadCases();
    } catch (error) {
      /* 用例执行同款：2004 单独报（P2-8 边界 5）。 */
      const label = noRunnerLabel(error);
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(label !== undefined ? t("run.noRunner", { label })
        : detail?.includes("queue unavailable") ? t("run.queueUnavailable") : t("cases.runFailed"));
    }
    finally { setRunningCase(undefined); if (fromWorkbench) setRunning(false); }
  }

  /** 保存为用例: freezes the request on screen, pre-filling from the last response. */
  function saveAsCase() {
    const request = toSnapshot(draft);
    if (!request) { setBodyError(t("editor.invalidJsonShort")); setTab("body"); return; }
    if (!request.url) { message.error(t("endpoints.urlRequired")); return; }
    setCaseDialog({ kind: "create", request, statusCode: result?.statusCode });
  }

  /**
   * 删除前先扫描引用（P2-4.5）。
   *
   * 扫描失败就**不删**：一个「查不到有没有人引用」的答案不能当成「没人引用」。被套件引用
   * 时列出清单并把主按钮换成「仍然删除」——force 是看过清单之后的决定，不是对 409 的重试。
   */
  async function removeCase(testCase: TestCase) {
    if (!projectId) return;
    let usage: CaseUsage;
    try { usage = await api.caseUsage(projectId, testCase.id); }
    catch { message.error(t("cases.usageFailed")); return; }

    const references = usage.suites.map((suite) => t("cases.usageSuite", { name: suite.name }));
    const history = usage.executionCount > 0 ? t("cases.deleteHistoryNote", { count: usage.executionCount }) : undefined;

    Modal.confirm({
      title: usage.blocked ? t("cases.deleteBlockedTitle", { name: testCase.name }) : t("cases.deleteTitle", { name: testCase.name }),
      content: <div>
        <p>{usage.blocked ? t("cases.deleteBlockedHint") : t("cases.deleteHint")}</p>
        {references.length > 0 && <ul className="usage-list">{references.map((line, index) => <li key={`${line}:${index}`}>{line}</li>)}</ul>}
        {history && <p className="form-note">{history}</p>}
      </div>,
      okText: usage.blocked ? t("action.deleteAnyway") : t("action.delete"),
      cancelText: t("action.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const deleted = await api.deleteCase(projectId, testCase.id, usage.blocked);
          if (activeCase?.id === testCase.id) returnToDebug();
          await loadCases();
          await reloadEndpoints();
          /* 顺带摘掉的套件成员是这次删除的连带改动，说出来才不用等到下次打开套件才发现。 */
          message.success(deleted.detachedSuites.length
            ? t("cases.deletedDetached", { count: deleted.detachedSuites.length })
            : t("cases.deleted"));
        } catch { message.error(t("cases.deleteFailed")); }
      },
    });
  }

  async function afterCaseSaved(testCase: TestCase, created: boolean) {
    setCaseDialog(undefined);
    await loadCases();
    /* The endpoint list shows用例数, so it has to hear about a new case. */
    if (created) await reloadEndpoints();
    setSideTab("cases");
    message.success(created ? t("cases.created") : t("cases.updated"));
    /**
     * A new case is loaded straight away, so 保存为用例 lands the user on the
     * thing they just made — that is where its request and assertions are
     * edited now that the dialog only carries name, tags and environment.
     */
    if (created) { await openCase(testCase, true); return; }
    if (activeCase?.id === testCase.id) setActiveCase(testCase);
  }

  /**
   * Opens the snapshot drawer for one run.
   *
   * A past run is evidence to read, not the response to the request currently
   * on screen, so it never overwrites the inline panel. `?run` tracks the
   * drawer, which keeps the deep link meaning exactly "this run is open".
   */
  function inspect(run: Execution) {
    setInspecting(run);
    setSearchParams((current) => { current.set("run", run.id); return current; }, { replace: true });
  }

  function closeInspector() {
    setInspecting(undefined);
    setSearchParams((current) => { current.delete("run"); return current; }, { replace: true });
  }

  /**
   * Loads a past run's request back into the editor, for the common "tweak one
   * param and send again" loop.
   *
   * Auth is deliberately not restored. The snapshot's Authorization header is
   * redacted to `***`, so writing headers back verbatim would replace a working
   * credential with a literal that fails on the next send. The auth config
   * already on the endpoint stays untouched, and redacted headers are dropped.
   */
  async function loadRequest(run: Execution) {
    if (dirty && !await confirmLoadRequest()) return;

    const { base, query } = splitUrl(run.request.url);
    const restoredHeaders = Object.entries(run.request.headers ?? {})
      .filter(([, value]) => value !== "***")
      .map(([key, value]) => ({ key, value, enabled: true }));

    const body = run.request.body;
    const bodyText = body === undefined || body === null
      ? ""
      : typeof body === "string" ? body : JSON.stringify(body, null, 2);

    setDraft((current) => ({
      ...current,
      method: run.request.method,
      url: base,
      /* The snapshot's query is already resolved and authoritative. */
      queryParams: query.length ? query : toPairs(run.request.query),
      headers: restoredHeaders,
      /* Keep the declared body type when the run carried no body. */
      bodyType: bodyText ? (typeof body === "string" ? current.bodyType === "none" ? "text" : current.bodyType : "json") : current.bodyType,
      bodyText,
    }));
    setUrlText(run.request.url);
    setTab("params");
    closeInspector();
    message.success(t("history.requestLoaded"));
  }

  function confirmLoadRequest() {
    return new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: t("history.loadRequest"),
        content: t("history.loadRequestConfirm"),
        okText: t("action.confirm"),
        cancelText: t("action.cancel"),
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  /* Deep link `?case=` opens a case directly (交互文档 3.1.3 / 第 6 章). */
  useEffect(() => {
    const caseId = searchParams.get("case");
    if (!caseId || activeCase?.id === caseId) return;
    const target = cases.find((item) => item.id === caseId);
    if (target) void openCase(target);
  }, [cases, searchParams]);

  useEffect(() => {
    const runId = searchParams.get("run");
    if (!runId || inspecting?.id === runId) return;
    const run = runs.items.find((item) => item.id === runId) ?? (result?.id === runId ? result : undefined);
    if (run) setInspecting(run);
  }, [runs.items, searchParams, result]);

  function remove() {
    Modal.confirm({
      title: t("endpoints.deleteTitle", { name: draft.name }), content: t("endpoints.deleteHint"),
      okText: t("action.delete"), cancelText: t("action.cancel"), okButtonProps: { danger: true },
      onOk: async () => {
        await api.deleteEndpoint(projectId!, endpointId!);
        setGuard(null);
        await reloadEndpoints();
        message.success(t("endpoints.deleted"));
        navigate(`/projects/${projectId}/endpoints`);
      },
    });
  }

  /* Switching endpoints goes through the same confirm as any other navigation. */
  async function switchTo(id: string) {
    if (id === endpointId) return;
    if (unsaved && !await useNavGuardStore.getState().confirmLeave()) return;
    setGuard(null);
    navigate(`/projects/${projectId}/endpoints/${id}`);
  }

  /* Copies the saved definition, so unsaved edits are persisted first. */
  async function duplicate() {
    if (!projectId || !endpointId) return;
    if (unsaved && !await useNavGuardStore.getState().confirmLeave()) return;
    setDuplicating(true);
    try {
      const copy = await api.duplicateEndpoint(projectId, endpointId, `${draft.name.trim()} ${t("endpoints.copySuffix")}`);
      setGuard(null);
      await reloadEndpoints();
      message.success(t("endpoints.duplicated", { name: copy.name }));
      navigate(`/projects/${projectId}/endpoints/${copy.id}`);
    } catch { message.error(t("endpoints.duplicateFailed")); }
    finally { setDuplicating(false); }
  }

  async function copyCurl() {
    try {
      await navigator.clipboard.writeText(toCurl(draft));
      message.success(t("editor.curlCopied"));
    } catch { message.error(t("editor.copyFailed")); }
  }

  if (loading) return <main className="content"><div className="empty"><p>{t("common.loading")}</p></div></main>;

  const counts: Record<Tab, number> = {
    params: Object.keys(fromPairs(draft.queryParams)).length + Object.keys(fromPairs(draft.pathParams)).length,
    headers: Object.keys(fromPairs(draft.headers)).length,
    body: draft.bodyType === "none" ? 0 : 1,
    auth: draft.auth.type === "none" ? 0 : 1,
    assertions: caseAssertions.length,
    pre: caseHooks.length,
    post: caseExtracts.length + caseResponseScripts.length,
    /* 绑定条数要发一次请求才知道，而 tab 头是同步渲染的：不给它一个数字，而不是让
       这个 tab 的角标去驱动一次额外的列表请求。 */
    sync: 0,
  };
  const tabs: [Tab, string][] = [
    ["params", t("editor.params")], ["headers", t("editor.headers")],
    ["body", t("editor.body")], ["auth", t("editor.auth")],
    /* 校验 belongs to the case, not the endpoint definition, so it is only
       offered while a case is loaded (see the tab body for why). */
    ...(activeCase ? [
      ["pre", t("flows.tabHooks")] as [Tab, string],
      ["post", t("flows.tabPost")] as [Tab, string],
      ["assertions", t("editor.assertions")] as [Tab, string],
      /* 同步排在校验之后：前面几个 tab 说「这条用例是什么」，这一个说「把它推到哪儿」，
          是最后一步而不是编辑的一部分。viewer 没有「推」这一步，tab 也不给（P6-4）。 */
      ...(canWrite ? [["sync", t("caseSync.tab")] as [Tab, string]] : []),
    ] : []),
  ];

  const index = endpoints.findIndex((item) => item.id === endpointId);
  const previous = index > 0 ? endpoints[index - 1] : undefined;
  const next = index >= 0 && index < endpoints.length - 1 ? endpoints[index + 1] : undefined;

  return <main className="content">
    <div className="page-head">
      <div className="page-head-main">
        <div className="title-row">
          {/* Badge sized to the heading so the verb reads as part of the title */}
          <span className="method-badge" data-method={draft.method}>{draft.method}</span>
          <input
            className="title-input"
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder={t("endpoints.namePlaceholder")}
            aria-label={t("endpoints.name")}
          />
          {/* Names the shortcut where the unsaved state is reported, so the
              faster path is learned at the moment it is useful. */}
          {endpointDirty && <span className="chip chip-warn">{t("editor.unsavedShortcut", { key: SAVE_KEY })}</span>}
        </div>
        <div className="head-meta">
          <input
            className="subtitle-input"
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
            placeholder={t("endpoints.descriptionPlaceholder")}
            aria-label={t("endpoints.description")}
          />
          {/* Tags identify the endpoint, so they belong with its name rather
              than below the response, where they read as an afterthought. */}
          <input
            className="subtitle-input tags-input"
            value={draft.tags}
            onChange={(event) => patch({ tags: event.target.value })}
            placeholder={t("endpoints.tagsPlaceholder")}
            aria-label={t("endpoints.tags")}
          />
        </div>
      </div>

      <div className="topbar-actions">
        {!isNew && endpoints.length > 1 && <div className="switcher">
          <IconButton icon={<ChevronLeft size={15} />} label={t("editor.previousEndpoint")} disabled={!previous} onClick={() => previous && void switchTo(previous.id)} />
          <Select
            value={endpointId}
            onChange={(id) => void switchTo(id)}
            options={endpoints.map((item) => ({ value: item.id, label: `${item.method}  ${item.name}` }))}
            style={{ width: 210 }}
            showSearch
            optionFilterProp="label"
            placeholder={t("editor.switchEndpoint")}
          />
          <IconButton icon={<ChevronRight size={15} />} label={t("editor.nextEndpoint")} disabled={!next} onClick={() => next && void switchTo(next.id)} />
        </div>}
        {/* While a case is loaded the screen holds the case's request, so
            endpoint-level writes are withheld: saving would overwrite the
            endpoint with case content, and duplicating would copy the wrong
            definition. The case's own save takes their place. */}
        {!isNew && canWrite && <IconButton icon={<History size={15} />} label={t("audit.history")} onClick={() => setChangeHistoryOpen(true)} />}
        {!isNew && !activeCase && canWrite && <IconButton icon={<CopyPlus size={15} />} label={t("action.duplicate")} disabled={duplicating} onClick={() => void duplicate()} />}
        {!isNew && !activeCase && canWrite && <IconButton icon={<Trash2 size={15} />} label={t("action.delete")} tone="danger" onClick={remove} />}
        {canWrite && (activeCase
          ? <>
              {/* 另存为新用例 keeps the original untouched, for branching a
                  variant; it is secondary to simply saving the case. */}
              <IconButton icon={<SaveAll size={15} />} label={t("cases.saveAsNew")} onClick={saveAsCase} />
              <button className="btn btn-primary btn-with-icon" disabled={savingCase || !caseDirty} onClick={() => void saveCase()}>
                <Save size={14} />{savingCase ? "…" : t("cases.saveCase")}
              </button>
            </>
          : <>
              {/* The one place to turn the current request into a case. The
                  response panel repeats it only as a post-send shortcut. */}
              {!isNew && <IconButton icon={<SaveAll size={15} />} label={t("cases.saveAs")} onClick={saveAsCase} />}
              <button className="btn btn-with-icon" disabled={saving || !dirty} onClick={() => void save()}>
                <Save size={14} />{saving ? "…" : t("action.save")}
              </button>
            </>)}
      </div>
    </div>

    {/* Identifies the loaded case and offers the way back to the draft it
        displaced (交互文档 3.1.3). */}
    {activeCase && <div className="case-banner">
      <span className="case-banner-label">{t("cases.loaded", { name: activeCase.name })}</span>
      <span className="mono muted">{t("cases.snapshotAt", { date: new Date(activeCase.updatedAt).toLocaleDateString() })}</span>
      {activeCase.environmentName && <span className="chip">{activeCase.environmentName}</span>}
      {/* The count is the way into the 校验 tab, so the rules are one click from
          the case they belong to. */}
      <button className="cell-link mono" onClick={() => setTab("assertions")}>{t("cases.assertionCount", { count: caseAssertions.length })}</button>
      {caseDirty && <span className="chip chip-warn">{t("cases.unsavedShortcut", { key: SAVE_KEY })}</span>}
      <span className="filter-spacer" />
      <button className="btn btn-small" onClick={returnToDebug}>{t("cases.returnToDebug")}</button>
    </div>}

    <div className={`workbench${historyOpen && !isNew ? "" : " is-solo"}`}>
      <div className="workbench-main">
        <section className="panel">
          <div className="panel-body request-line">
            <Select value={draft.method} onChange={(method) => patch({ method })} options={METHODS.map((value) => ({ value }))} style={{ width: 104 }} />
            <VariableField
              value={urlText}
              onChange={editUrl}
              options={variableChoices}
              className="input mono request-url"
              placeholder="https://api.example.com/orders/:id?page=1"
              aria-label={t("endpoints.url")}
              spellCheck={false}
            />
            <Select
              value={draft.defaultEnvironmentId}
              onChange={(defaultEnvironmentId) => patch({ defaultEnvironmentId })}
              options={environments.map((environment) => ({ value: environment.id, label: environment.name }))}
              placeholder={defaultEnvironmentId
                ? t("endpoints.projectDefaultEnvironment", { name: environments.find((item) => item.id === defaultEnvironmentId)?.name ?? "—" })
                : t("endpoints.noEnvironment")}
              style={{ width: 140 }}
              allowClear
              /* A loaded case carries its own environment, frozen at save time. */
              disabled={Boolean(activeCase)}
            />
            {canWrite && <button className="btn btn-primary btn-with-icon btn-send" disabled={running || saving} onClick={() => void send()}>
              <Play size={14} />{running ? t("action.running") : activeCase ? t("cases.run") : t("editor.send")}
            </button>}
            <IconButton icon={<Copy size={15} />} label={t("editor.copyCurl")} onClick={() => void copyCurl()} />
          </div>

          <div className="tabs" role="tablist">
            {tabs.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={`tab${tab === key ? " is-active" : ""}`} onClick={() => setTab(key)}>
                {label}{counts[key] > 0 && <span className="tab-count mono">{counts[key]}</span>}
              </button>
            ))}
          </div>

          <div className="panel-body">
            {tab === "params" && <>
              <KeyValueEditor
                pairs={draft.queryParams}
                onChange={editQuery}
                keyPlaceholder="page"
                valuePlaceholder="1"
                title={t("editor.queryParams")}
                hint={t("editor.queryParamsHint")}
                variableOptions={variableChoices}
              />
              <KeyValueEditor
                pairs={draft.pathParams}
                onChange={(pathParams) => patch({ pathParams })}
                keyPlaceholder="id"
                valuePlaceholder="A-100"
                title={t("editor.pathParams")}
                hint={t("editor.pathParamsHint")}
                variableOptions={variableChoices}
              />
            </>}

            {tab === "headers" && <KeyValueEditor
              pairs={draft.headers}
              onChange={(headers) => patch({ headers })}
              keyPlaceholder="Content-Type"
              valuePlaceholder="application/json"
              title={t("editor.headers")}
              variableOptions={variableChoices}
            />}

            {tab === "body" && <>
              <Select
                value={draft.bodyType}
                onChange={(bodyType) => { patch({ bodyType }); setBodyError(undefined); }}
                options={BODY_TYPES.map((value) => ({ value, label: t(`editor.bodyType.${value}`) }))}
                style={{ width: 200 }}
              />
              {draft.bodyType !== "none" && <>
                <VariableField
                  value={draft.bodyText}
                  onChange={(bodyText) => { patch({ bodyText }); setBodyError(undefined); }}
                  options={variableChoices}
                  multiline
                  className="input mono body-editor"
                  placeholder={draft.bodyType === "json" ? '{\n  "key": "value"\n}' : draft.bodyType === "form" ? "key=value&other=value" : ""}
                  spellCheck={false}
                />
                {bodyError && <p className="form-error">{t("editor.invalidJson", { message: bodyError })}</p>}
                {draft.bodyType === "json" && <button className="btn" type="button" onClick={() => {
                  try { patch({ bodyText: JSON.stringify(JSON.parse(draft.bodyText), null, 2) }); setBodyError(undefined); }
                  catch (error) { setBodyError(error instanceof Error ? error.message : "invalid JSON"); }
                }}>{t("editor.format")}</button>}
              </>}
            </>}

            {tab === "auth" && <AuthEditor auth={draft.auth} onChange={(auth) => patch({ auth })} options={variableChoices} />}

            {tab === "pre" && activeCase && <PreRequestHookEditor projectId={projectId!} hooks={caseHooks} onChange={setCaseHooks} results={result?.caseId === activeCase.id ? result.hookResults : undefined} environmentId={activeCase.environmentId ?? draft.defaultEnvironmentId ?? undefined} />}

            {tab === "post" && activeCase && <>
              <h3 className="subhead">{t("flows.simpleExtracts")}</h3>
              <p className="form-note">{t("flows.extractsHint")}</p>
              {caseExtracts.map((extract, index) => <div className="extract-row" key={index}><div className="extract-fields">
                <input className="input mono" value={extract.name} onChange={(event) => setCaseExtracts((current) => current.map((item, at) => at === index ? { ...item, name: event.target.value } : item))} placeholder="token" />
                <Select value={extract.from} onChange={(from) => setCaseExtracts((current) => current.map((item, at) => at === index ? { ...item, from } : item))} options={(["body", "header", "status"] as const).map((value) => ({ value, label: t(`flows.extractFrom.${value}`) }))} style={{ width: 120 }} />
                {extract.from === "status" ? <span className="assertion-fixed muted">—</span> : <input className="input mono" value={extract.path ?? ""} onChange={(event) => setCaseExtracts((current) => current.map((item, at) => at === index ? { ...item, path: event.target.value } : item))} placeholder={extract.from === "body" ? "$.data.token" : "x-request-id"} />}
                {extract.from !== "status" && <IconButton icon={<Crosshair size={14} />} label={t("assertions.pick")} disabled={!result} onClick={() => extract.from === "body" ? setPickExtractBody(index) : setPickExtractHeader(index)} />}
                <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => setCaseExtracts((current) => current.filter((_, at) => at !== index))} />
              </div></div>)}
              <button className="btn btn-with-icon" style={{ marginTop: 8 }} onClick={() => setCaseExtracts((current) => [...current, { name: "", from: "body", path: "" }])}><Plus size={14} />{t("flows.addExtract")}</button>
              <h3 className="subhead" style={{ marginTop: 20 }}>{t("responseScripts.title")}</h3>
              <ResponseScriptEditor projectId={projectId!} scripts={caseResponseScripts} onChange={setCaseResponseScripts} results={result?.caseId === activeCase.id ? result.responseScriptResults : undefined} response={{ statusCode: result?.statusCode, headers: result?.responseHeaders, body: result?.responseBody }} environmentId={activeCase.environmentId ?? draft.defaultEnvironmentId ?? undefined} />
            </>}

            {/* 校验 sits beside the request tabs but belongs to the case, not the
                endpoint: the tabs to its left describe what to send, this one
                describes what the answer must satisfy. It saves on its own
                button so it never rides along with a request edit. */}
            {/* 校验 sits beside the request tabs but belongs to the case, not the
                endpoint: the tabs to its left describe what to send, this one
                describes what the answer must satisfy. */}
            {tab === "assertions" && activeCase && <AssertionEditor
              projectId={projectId!}
              assertions={caseAssertions}
              onChange={setCaseAssertions}
              /* Verdicts from the latest run line up row-by-row with the rules
                 that produced them, so a failure is read where it was written. */
              results={result?.caseId === activeCase.id ? result.assertionResults : undefined}
              /* 快速提取 reads the response on screen, so a picked path always
                 resolves against a body the user has actually seen. */
              responseBody={result?.responseBody}
              responseHeaders={result?.responseHeaders}
              responseStatusCode={result?.statusCode}
              /* The case's own environment, frozen at save time, is what a real
                 run resolves `ctx.variables` and `{ secret }` against — so a
                 script try-run has to load the same one. */
              environmentId={activeCase.environmentId ?? draft.defaultEnvironmentId ?? undefined}
            />}

            {/* 同步：快照隔离让「改用例」与「流程跑什么」分开，这里补上把改动推过去的
                那一步。它是显式操作，不是自动传播。 */}
            {tab === "sync" && activeCase && canWrite && <CaseFlowSync
              projectId={projectId!}
              caseId={activeCase.id}
              caseName={activeCase.name}
              /* 服务端同步的是库里那份用例，所以草稿有改动时先要求保存。 */
              caseDirty={caseDirty}
            />}
          </div>
        </section>

        <ResponsePanel
          result={result}
          running={running}
          pending={pending}
          canceling={canceling}
          onCancel={() => void cancelPending()}
          tab={responseTab}
          onTab={setResponseTab}
          pretty={pretty}
          onPretty={setPretty}
          onExpand={() => result && inspect(result)}
        />

        <div className="meta-row">
          <p className="form-note">{t("editor.variableHint")}</p>
        </div>
      </div>

      {!isNew && <HistorySidebar
        open={historyOpen}
        onToggle={() => setHistoryOpen((current) => !current)}
        railLabel={sideTab === "history" ? t("endpoints.history") : t("cases.title")}
        railCount={sideTab === "history" ? runs.total : cases.length}
        header={
          /* One box, two views: the sidebar must not widen or split, so
             用例 and 调试记录 share it (交互文档 3.1.3). 用例 comes first —
             it is the durable asset; debug records are transient. */
          <div className="segmented" role="tablist">
            {(["cases", "history"] as SideTab[]).map((key) => (
              <button
                key={key}
                role="tab"
                aria-selected={sideTab === key}
                className={`segmented-item${sideTab === key ? " is-active" : ""}`}
                onClick={() => setSideTab(key)}
              >
                {key === "history" ? t("endpoints.history") : t("cases.title")}
                <span className="mono tab-count">{key === "history" ? runs.total : cases.length}</span>
              </button>
            ))}
          </div>
        }
        filter={sideTab === "history" ? <div className="side-filter">
          <Select
            size="small"
            value={historySource}
            onChange={(value) => { setHistorySource(value); setHistoryPage(1); }}
            options={[
              { value: "all", label: t("reports.allSources") },
              { value: "endpoint_debug", label: t("reports.sourceDebug") },
              { value: "test_case", label: t("reports.sourceCase") },
            ]}
            style={{ flex: 1, minWidth: 0 }}
          />
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
            style={{ width: 84 }}
          />
        </div> : undefined}
        list={sideTab === "history" ? <>
          {/* A record opens as a snapshot drawer. It is evidence about a
              past run, so it must not overwrite the response belonging to
              the request currently being edited. */}
          {runs.items.length ? runs.items.map((run) => (
            <button
              key={run.id}
              className={`history-item${inspecting?.id === run.id ? " is-active" : ""}`}
              onClick={() => inspect(run)}
            >
              <div className="history-item-top">
                <RunStatusTag status={toRunStatus(run.status)} />
                <span className="mono">{run.statusCode ?? "—"}</span>
                <span className="mono muted">{run.durationMs} ms</span>
              </div>
              {/* Names the case a run came from, so 用例 runs are legible
                  among debug sends rather than looking identical. */}
              {run.caseName && <span className="history-case truncate"><span className="chip">{t("cases.title")}</span>{run.caseName}</span>}
              <span className="mono muted history-time">{new Date(run.createdAt).toLocaleString()}</span>
            </button>
          )) : <p className="muted history-empty">{historyStatus === "all" && historySource === "all" ? t("endpoints.historyEmpty") : t("reports.emptyFilterHint")}</p>}
        </> : <CaseBox
          cases={cases}
          activeCaseId={activeCase?.id}
          running={runningCase}
          onOpen={(testCase) => void openCase(testCase)}
          onRun={(testCase) => void runCase(testCase)}
          onEdit={(testCase) => setCaseDialog({ kind: "edit", testCase })}
          onDelete={(testCase) => void removeCase(testCase)}
          onInspect={inspect}
        />}
        pager={sideTab === "history" ? <SidebarPager
          page={runs.page}
          pageSize={runs.pageSize}
          total={runs.total}
          onPage={setHistoryPage}
          onPageSize={(size) => { setHistoryPageSize(size); setHistoryPage(1); }}
        /> : undefined}
      />}
    </div>

    {/* Snapshot of one run: either a history record or the expanded inline response. */}
    <ExecutionSnapshot
      result={inspecting}
      onClose={closeInspector}
      onRerun={canWrite ? () => { closeInspector(); void send(); } : undefined}
      onLoadRequest={inspecting ? () => void loadRequest(inspecting) : undefined}
      busy={running}
    />

    {/* The project default is the fallback target环境 when the endpoint has none
        of its own; the store models "unset" as null, the prop as undefined. */}
      <CaseDialog
      mode={caseDialog}
      projectId={projectId!}
      endpointId={endpointId!}
      environments={environments}
      defaultEnvironmentId={draft.defaultEnvironmentId ?? defaultEnvironmentId ?? undefined}
      onClose={() => setCaseDialog(undefined)}
      onSaved={(testCase, created) => void afterCaseSaved(testCase, created)}
      />
      <JsonPathPicker open={pickExtractBody !== undefined} body={result?.responseBody} onClose={() => setPickExtractBody(undefined)} onPick={(paths) => { if (pickExtractBody === undefined || !paths.length) return; const made = paths.map((path) => ({ name: path.split(/[.[\]]/).filter(Boolean).at(-1) ?? "value", from: "body" as const, path })); setCaseExtracts((current) => current.map((item, at) => at === pickExtractBody ? { ...made[0], name: item.name || made[0].name } : item).concat(made.slice(1))); setPickExtractBody(undefined); }} />
      <HeaderPicker open={pickExtractHeader !== undefined} headers={result?.responseHeaders} onClose={() => setPickExtractHeader(undefined)} onPick={(names) => { if (pickExtractHeader === undefined || !names.length) return; const made = names.map((name) => ({ name: name.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, next: string) => next.toUpperCase()), from: "header" as const, path: name })); setCaseExtracts((current) => current.map((item, at) => at === pickExtractHeader ? { ...made[0], name: item.name || made[0].name } : item).concat(made.slice(1))); setPickExtractHeader(undefined); }} />
      {/* 变更历史（P11-10 边界 8）：屏幕上是用例就查用例、否则查接口，与编辑对象一致。 */}
      {!isNew && <ChangeHistoryDrawer
        projectId={projectId!}
        targetType={activeCase ? "test_case" : "endpoint"}
        targetId={activeCase ? activeCase.id : endpointId!}
        name={activeCase ? activeCase.name : draft.name}
        open={changeHistoryOpen}
        onClose={() => setChangeHistoryOpen(false)}
      />}
  </main>;
}

function ResponsePanel({ result, running, pending, canceling, onCancel, tab, onTab, pretty, onPretty, onExpand }: {
  result?: Execution;
  running: boolean;
  /** The queued or in-flight run, present only while one is being awaited. */
  pending?: Execution;
  canceling: boolean;
  onCancel: () => void;
  tab: ResponseTab;
  onTab: (tab: ResponseTab) => void;
  pretty: boolean;
  onPretty: (pretty: boolean) => void;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  const busy = running || Boolean(pending);

  /* Only truly empty before the first run of a session. */
  if (!result && !busy) return <section className="panel response-panel"><div className="panel-body response-empty"><p className="muted">{t("editor.noResponse")}</p></div></section>;

  const tabs: [ResponseTab, string][] = [
    ["body", t("snapshot.responseBody")], ["headers", t("snapshot.responseHeaders")], ["request", t("snapshot.request")],
  ];

  return <section className="panel response-panel">
    <div className="panel-head response-head">
      <div className="response-stats">
        {/**
          * A run in flight replaces only this row, never the body below.
          * Swapping the whole panel made a fast run flash: response → blank →
          * response, several times a minute once runs settled in ~50ms.
          * 排队中 and 执行中 stay distinct — a long queue means the workers are
          * busy, a long 执行中 means the target is slow.
          */}
        {busy
          ? <>
              <RunStatusTag status={pending ? toRunStatus(pending.status) : "running"} />
              <span className="muted">{pending?.status === "queued" ? t("run.queued") : t("editor.sending")}</span>
            </>
          : result && <>
              <RunStatusTag status={toRunStatus(result.status)} />
              <span className="mono">{result.statusCode ?? "—"}</span>
              <span className="mono muted">{result.durationMs} ms</span>
              <span className="mono muted">{result.responseSizeBytes} B</span>
              {result.responseTruncated && <span className="chip chip-warn">{t("status.truncated")}</span>}
            </>}
      </div>
      <div className="history-tools">
        {busy && <button className="btn btn-small" disabled={canceling} onClick={onCancel}>{t("run.cancel")}</button>}
        {!busy && tab === "body" && <button className="btn btn-small" onClick={() => onPretty(!pretty)}>{pretty ? t("editor.raw") : t("editor.pretty")}</button>}
        {result && <IconButton icon={<Maximize2 size={14} />} label={t("editor.expandResponse")} onClick={onExpand} />}
      </div>
    </div>

    {result
      ? <>
          <div className="tabs" role="tablist">
            {tabs.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={`tab${tab === key ? " is-active" : ""}`} onClick={() => onTab(key)}>{label}</button>
            ))}
          </div>

          {/* Dimmed while a new run is outstanding, so a kept response cannot be
              mistaken for the one being waited on. */}
          <div className="panel-body" data-stale={busy || undefined}>
            {result.error && <div className="code-block"><span className="label">{t("snapshot.error")}</span><pre className="code" data-tone="fail">{result.error}</pre></div>}
            {/* A case run's verdict comes from its assertions, so they are shown with
                the response rather than only in the drawer. */}
            <AssertionResults results={result.assertionResults} />
            <ResponseScriptResults results={result.responseScriptResults} />
            {/* Copies exactly what is rendered, including the pretty/raw choice,
                so the clipboard never disagrees with the panel. */}
            <div className="code-block">
              <div className="code-block-head">
                <span className="label">{tabs.find(([key]) => key === tab)?.[1]}</span>
                <CopyButton value={() => responseText(result, tab, pretty)} />
              </div>
              <pre className="code response-body">{responseText(result, tab, pretty)}</pre>
            </div>
          </div>
        </>
      /* First run of the session: there is no earlier response to hold on to. */
      : <div className="panel-body response-empty"><p className="muted">{t("editor.sending")}</p></div>}
  </section>;
}

/** Pretty-prints JSON when asked and when it parses; otherwise returns as-is. */
function formatBody(body: string | undefined, pretty: boolean) {
  if (!body) return "";
  if (!pretty) return body;
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

/**
 * The single source for what the response panel shows, so the rendered text and
 * the copied text cannot drift apart.
 */
function responseText(result: Execution, tab: ResponseTab, pretty: boolean) {
  if (tab === "body") return formatBody(result.responseBody, pretty);
  if (tab === "headers") return JSON.stringify(result.responseHeaders, null, 2);
  return JSON.stringify(result.request, null, 2);
}

function AuthEditor({ auth, onChange, options }: { auth: EndpointAuth; onChange: (auth: EndpointAuth) => void; options: VariableOption[] }) {
  const { t } = useTranslation();

  function switchType(type: EndpointAuth["type"]) {
    if (type === "none") onChange({ type: "none" });
    else if (type === "bearer") onChange({ type: "bearer", token: "" });
    else if (type === "basic") onChange({ type: "basic", username: "", password: "" });
    else onChange({ type: "apiKey", key: "", value: "", in: "header" });
  }

  return <div className="auth-editor">
    <Select
      value={auth.type}
      onChange={switchType}
      options={(["none", "bearer", "basic", "apiKey"] as const).map((value) => ({ value, label: t(`editor.authType.${value}`) }))}
      style={{ width: 200 }}
    />
    {auth.type === "bearer" && <label className="field">
      <span>Token</span>
      <VariableField value={auth.token} onChange={(token) => onChange({ ...auth, token })} options={options} className="input mono" placeholder="{{token}}" spellCheck={false} />
    </label>}
    {auth.type === "basic" && <div className="form-grid">
      <label className="field"><span>{t("editor.username")}</span><VariableField value={auth.username} onChange={(username) => onChange({ ...auth, username })} options={options} className="input" spellCheck={false} /></label>
      <label className="field"><span>{t("editor.password")}</span><VariableField value={auth.password} onChange={(password) => onChange({ ...auth, password })} options={options} className="input" type="password" spellCheck={false} /></label>
    </div>}
    {auth.type === "apiKey" && <div className="form-grid">
      <label className="field"><span>{t("editor.key")}</span><VariableField value={auth.key} onChange={(key) => onChange({ ...auth, key })} options={options} className="input mono" placeholder="X-API-Key" spellCheck={false} /></label>
      <label className="field"><span>{t("editor.value")}</span><VariableField value={auth.value} onChange={(value) => onChange({ ...auth, value })} options={options} className="input mono" placeholder="{{apiKey}}" spellCheck={false} /></label>
      <label className="field">
        <span>{t("editor.sendIn")}</span>
        <Select value={auth.in} onChange={(target) => onChange({ ...auth, in: target })} options={[{ value: "header", label: "Header" }, { value: "query", label: "Query" }]} />
      </label>
    </div>}
    <p className="form-note">{t("editor.authHint")}</p>
  </div>;
}
