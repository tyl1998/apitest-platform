import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type BatchDebugResult, type BatchDebugSummary, type Execution, type ExecutionIndex, type ExecutionSourceFilter, type FlowExecutionDetail, type Paged, type SuiteExecutionDetail } from "../api";
import { useExecutionStream } from "../hooks/useExecutionStream";
import { usePageContext } from "../hooks/usePageContext";
import { useProjectStore } from "../stores/projectStore";
import { Empty, toRunStatus } from "../ui";
import { BatchResultList } from "./BatchResultList";
import { ExecutionSnapshot } from "./ExecutionSnapshot";
import { FlowRunDrawer } from "./FlowRunDrawer";
import { RunStatusTag } from "./RunStatusTag";
import { SuiteRunDrawer } from "./SuiteRunDrawer";

/* 服务端把 pageSize 收在 100（`Math.min(100, …)`，三条列表路由都是）。放一个 200 进来
   只会让分页器显示服务端返回的 100、而翻页仍按 200 算偏移，中间那一百条被跳过。 */
const PAGE_SIZES = [20, 50, 100];
const RECORD_TYPES = ["single", "parent", "batch"];
/** 事件流里的终态。批量调试收尾叫 `completed`，其余三类是 success/failed/canceled。 */
const SETTLED = new Set(["success", "failed", "canceled", "completed"]);
/** 一次运行会发很多条进度事件，重取要合并成尾随的一次。 */
const RELOAD_DELAY_MS = 600;

/** ISO → datetime-local 输入值（本地时区，YYYY-MM-DDTHH:mm）。非法值给空串。 */
function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** datetime-local 输入值 → ISO；空串与非法值（输入中途的部分文本）给 undefined。 */
function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** 地址栏里的大类。`flow` 是 5.0.9 那版的「流程执行记录」，现在并进父执行记录。 */
function toRecordType(value: string | null) {
  if (value === "flow") return "parent";
  return value && RECORD_TYPES.includes(value) ? value : "single";
}

/**
 * Every execution in the project, paged.
 *
 * 三个大类：**父执行记录**（流程 + 套件，带类型筛选，P2-4.4）、**单接口记录**、
 * **批量调试记录**。流程与套件合成一个大类而不是各占一个——它们语义完全重叠（都是
 * 「一次运行 + 一批子结果」），两个入口只会让人每次先猜自己要找的那次运行被记到了哪边。
 * 批量调试留在自己的大类里：它从不写 `execution_index`，也没有父执行那套计数。
 *
 * Records are the audit trail, so nothing is dropped: the server reports the
 * true total and this page walks it. An earlier version fetched one capped
 * batch and silently presented it as the whole history.
 */
export function ExecutionRecords() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { endpoints } = useProjectStore();
  const stream = useExecutionStream(projectId);

  const [status, setStatus] = useState(searchParams.get("status") ?? "all");
  const [recordType, setRecordType] = useState(toRecordType(searchParams.get("type")));
  const [kind, setKind] = useState(searchParams.get("kind") ?? "all");
  /**
   * 「只看勾选来的」（§8.3 提到的读法，P4.5-11）。
   *
   * 判据是 `pipeline_runs.case_filter IS NOT NULL`——勾选执行**不加**第五个
   * `trigger_source` 值（边界 10：勾选就是人按了按钮，`manual` 是事实），所以它不能靠
   * 触发源筛出来，只能靠这个复选框。只在 `kind=runner` 下出现：对流程/套件/上报来说这
   * 个条件恒为假，摆在那里只会让人以为自己筛错了。
   */
  const [caseFilterOnly, setCaseFilterOnly] = useState(searchParams.get("caseFilter") === "1");
  const [source, setSource] = useState(searchParams.get("source") ?? "all");
  const [endpointId, setEndpointId] = useState(searchParams.get("endpointId") ?? undefined);
  const [keyword, setKeyword] = useState(searchParams.get("keyword") ?? "");
  /**
   * 时间范围筛选（P8-6 验收反馈：三个大类都要有）：状态存 ISO（URL 与 API 直接用），
   * 输入框另持一份原始文本（datetime-local 输入中途的部分值解析不了，受控值直接绑
   * ISO 会在打字途中把输入框重置——见 onChange 的提交规则）。下钻带来的窗口在这里
   * 就地可见、可改、可清。
   */
  const [from, setFrom] = useState(searchParams.get("from") ?? undefined);
  const [to, setTo] = useState(searchParams.get("to") ?? undefined);
  const [fromInput, setFromInput] = useState(() => isoToLocalInput(searchParams.get("from") ?? ""));
  const [toInput, setToInput] = useState(() => isoToLocalInput(searchParams.get("to") ?? ""));
  const [caseId, setCaseId] = useState(searchParams.get("caseId") ?? undefined);
  const [page, setPage] = useState(Number(searchParams.get("page") ?? 1));
  const [pageSize, setPageSize] = useState(Number(searchParams.get("pageSize") ?? 20));
  /** 事件触发的重取。当成第九个筛选条件，列表的取数就仍然只有一处。 */
  const [revision, setRevision] = useState(0);

  const [data, setData] = useState<Paged<Execution>>({ items: [], page: 1, pageSize: 20, total: 0 });
  const [batches, setBatches] = useState<Paged<BatchDebugSummary>>({ items: [], page: 1, pageSize: 20, total: 0 });
  const [parents, setParents] = useState<Paged<ExecutionIndex>>({ items: [], page: 1, pageSize: 20, total: 0 });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Execution>();
  const [batchResult, setBatchResult] = useState<BatchDebugResult>();
  /** 一条父执行的抽屉：流程与套件各有自己的那一款，但入口只有一个 index id。 */
  const [parent, setParent] = useState<{ indexId: string; flow?: FlowExecutionDetail; suite?: SuiteExecutionDetail }>();

  /* 助手页面上下文（P9-4c）：筛选大多已在 URL，打开中的抽屉不在——「刚才失败的
     那条帮我看看」指向正在看的那次执行。 */
  usePageContext({
    page: "execution-records",
    filters: {
      ...(recordType !== "single" ? { type: recordType } : {}),
      ...(kind !== "all" ? { kind } : {}),
      ...(caseFilterOnly ? { caseFilter: "1" } : {}),
      ...(status !== "all" ? { status } : {}),
      ...(source !== "all" ? { source } : {}),
      ...(endpointId ? { endpointId } : {}),
      ...(caseId ? { caseId } : {}),
      ...(keyword ? { keyword } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
    entities: {
      ...(result ? { executionId: result.id } : {}),
      ...(parent ? { indexId: parent.indexId } : {}),
    },
  });

  /** 当前页有哪些 id：一条打不到当前页的事件才说明有新记录产生。 */
  const idsRef = useRef(new Set<string>());
  const reloadTimer = useRef<number>();

  useEffect(() => {
    if (!projectId) return;
    setSearchParams({
      ...(recordType !== "single" ? { type: recordType } : {}),
      ...(recordType === "parent" && kind !== "all" ? { kind } : {}),
      ...(recordType === "parent" && kind === "runner" && caseFilterOnly ? { caseFilter: "1" } : {}),
      ...(recordType !== "batch" && status !== "all" ? { status } : {}),
      ...(recordType === "single" && source !== "all" ? { source } : {}),
      ...(recordType === "single" && endpointId ? { endpointId } : {}),
      ...(recordType === "single" && caseId ? { caseId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(recordType === "parent" && keyword ? { keyword } : {}),
      ...(page > 1 ? { page: String(page) } : {}),
      ...(pageSize !== 20 ? { pageSize: String(pageSize) } : {}),
      /* 打开中的抽屉也是地址栏的一部分（稳定详情，P2-4.4）：换一个筛选条件不该把正在
         看的那次运行关掉。 */
      ...(searchParams.get("run") ? { run: searchParams.get("run")! } : {}),
      ...(searchParams.get("parent") ? { parent: searchParams.get("parent")! } : {}),
      ...(searchParams.get("batch") ? { batch: searchParams.get("batch")! } : {}),
    }, { replace: true });

    setLoading(true);
    const request: Promise<Paged<Execution> | Paged<BatchDebugSummary> | Paged<ExecutionIndex>> = recordType === "batch"
      ? api.batchExecutions(projectId, page, pageSize, { from, to })
      : recordType === "parent"
          ? api.executionIndex(projectId, { kind: kind as ExecutionIndex["kind"] | "all", status, keyword, caseFilter: kind === "runner" && caseFilterOnly, from, to, page, pageSize })
          : api.executions(projectId, { status, endpointId, source: source as ExecutionSourceFilter, caseId, from, to, page, pageSize });
    request
      .then((next) => {
        if (recordType === "batch") setBatches(next as Paged<BatchDebugSummary>);
        else if (recordType === "parent") setParents(next as Paged<ExecutionIndex>);
        else setData(next as Paged<Execution>);
        idsRef.current = new Set((next.items as { id: string }[]).map((item) => item.id));
      })
      .catch(() => message.error(t("reports.loadFailed")))
      .finally(() => setLoading(false));
  }, [projectId, recordType, kind, status, source, endpointId, keyword, caseFilterOnly, from, to, caseId, page, pageSize, revision]);

  /**
   * 事件比列表快，但列表要重取才有完整字段（单接口的状态码/耗时只在记录里）。
   * 一次运行会发很多条进度事件，所以重取是尾随合并的一次，而不是每条事件一次。
   */
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = undefined;
      setRevision((current) => current + 1);
    }, RELOAD_DELAY_MS);
  }, []);
  useEffect(() => () => { if (reloadTimer.current) window.clearTimeout(reloadTimer.current); }, []);

  /**
   * 读一条父执行的明细。流程与套件的抽屉不同，但入口只有 index 行的三个字段。
   *
   * 失败原样抛出去：三个调用方对失败的处置完全不同——点行的要报「加载失败」，深链要报
   * 「这条记录不在了」并摘掉参数，事件驱动的静默重取则什么都不该说（下一条事件还会再试，
   * 弹一条报错盖在正在看的抽屉上只是噪音）。
   */
  const loadParent = useCallback(async (row: { id: string; kind: ExecutionIndex["kind"]; detailId: string }) => {
    if (!projectId) return;
    setParent(row.kind === "suite"
      ? { indexId: row.id, suite: await api.suiteExecution(projectId, row.detailId) }
      : { indexId: row.id, flow: await api.flowExecution(projectId, row.detailId) });
  }, [projectId]);

  /**
   * 仓库上报（P4 边界 1）没有平台侧的抽屉可开。
   *
   * 它归一进这份清单是为了「来源筛选 + 一个统一入口」，但它的明细在仓库用例的上报记录页
   * ——那里才有 scope、对账状态与请求明细。所以点它是**跳过去**，不是开一个空抽屉：
   * `loadParent` 会把非 suite 的行当成流程去读 `flow_executions`，而 `ingest` 的 `detailId`
   * 指向 `ingest_runs`，那一定 404。
   */
  function openIngest() {
    if (!projectId) return;
    navigate(`/projects/${projectId}/repo/runs`);
  }

  function openParent(row: ExecutionIndex) {
    if (row.kind === "ingest") { openIngest(); return; }
    /* runner 的明细页是独立路由（P4.5-11/13 已落地）：阶段进度 + 实时日志 + cases
       时间轴 + 报告视图 + 产物。不能用 loadParent 兜底——它会把 runner 的 detailId
       当流程 id 去读 flow_executions，那一定 404。`?from=reports` 让面包屑/侧栏归
       「执行记录」而不是仓库——入口归属的既有机制（报告列表同款，P8-3 反馈③），
       从执行记录进的必须能回执行记录（P8-6 验收反馈）。 */
    if (row.kind === "runner") {
      if (projectId) navigate(`/projects/${projectId}/pipeline-runs/${row.detailId}?tab=report&from=reports`);
      return;
    }
    void loadParent(row)
      .then(() => setSearchParams((current) => { current.set("parent", row.id); return current; }, { replace: true }))
      .catch(() => message.error(t("reports.loadFailed")));
  }

  function closeParent() {
    setParent(undefined);
    setSearchParams((current) => { current.delete("parent"); return current; }, { replace: true });
  }

  function openBatch(batchId: string) {
    if (!projectId) return;
    void api.batchExecution(projectId, batchId)
      .then((batch) => {
        setBatchResult(batch);
        setSearchParams((current) => { current.set("batch", batchId); return current; }, { replace: true });
      })
      .catch(() => message.error(t("reports.loadFailed")));
  }

  function closeBatch() {
    setBatchResult(undefined);
    setSearchParams((current) => { current.delete("batch"); return current; }, { replace: true });
  }

  function openResult(run: Execution) {
    setResult(run);
    setSearchParams((current) => { current.set("run", run.id); return current; }, { replace: true });
  }

  function closeResult() {
    setResult(undefined);
    setSearchParams((current) => { current.delete("run"); return current; }, { replace: true });
  }

  /**
   * 稳定详情（P2-4.4）：`?parent=`、`?run=`、`?batch=` 三个都**按 id 拉取**。
   *
   * 早先的写法是在刚取回的那一页里 `find` 一遍，于是「刷新后回到刚才在看的那次运行」
   * 只在这一行正好落在当前页时才成立——深页、换过筛选条件都恢复不了，而流程与批量调试
   * 连参数都没写进地址栏。按 id 取还顺带修掉一个哑掉的分支：id 已经不存在时能明确说出来，
   * 而不是静默地什么都不打开。读失败就摘掉参数，免得每次筛选变化都重试一次注定失败的请求。
   */
  useEffect(() => {
    const indexId = searchParams.get("parent");
    if (!projectId || !indexId || parent?.indexId === indexId) return;
    void api.executionIndexDetail(projectId, indexId)
      .then((row) => {
        /* 深链指到一条仓库上报时同样不开抽屉（见 `openIngest`）：`?parent=` 是可以被贴出来
           的，而它指向的那一行完全可能是 `ingest`。摘掉参数再跳，否则回退回来又会试一次。 */
        if (row.kind === "ingest") {
          setSearchParams((current) => { current.delete("parent"); return current; }, { replace: true });
          openIngest();
          return;
        }
        /* runner 同理（见 `openParent`）：跳详情页而不是开抽屉，`?from=reports`
           保住「从执行记录进、回执行记录」的归属。 */
        if (row.kind === "runner") {
          setSearchParams((current) => { current.delete("parent"); return current; }, { replace: true });
          if (projectId) navigate(`/projects/${projectId}/pipeline-runs/${row.detailId}?tab=report&from=reports`);
          return;
        }
        return loadParent(row);
      })
      .catch(() => {
        message.error(t("reports.detailGone"));
        setSearchParams((current) => { current.delete("parent"); return current; }, { replace: true });
      });
  }, [projectId, searchParams, parent?.indexId, loadParent, setSearchParams, t]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const runId = searchParams.get("run");
    if (!projectId || !runId || result?.id === runId) return;
    void api.execution(projectId, runId)
      .then(setResult)
      .catch(() => {
        message.error(t("reports.detailGone"));
        setSearchParams((current) => { current.delete("run"); return current; }, { replace: true });
      });
  }, [projectId, searchParams, result?.id, setSearchParams, t]);

  useEffect(() => {
    const batchId = searchParams.get("batch");
    if (!projectId || !batchId || batchResult?.id === batchId) return;
    void api.batchExecution(projectId, batchId)
      .then(setBatchResult)
      .catch(() => {
        message.error(t("reports.detailGone"));
        setSearchParams((current) => { current.delete("batch"); return current; }, { replace: true });
      });
  }, [projectId, searchParams, batchResult?.id, setSearchParams, t]);

  /**
   * 记录页接入执行事件流（P2-4.4）。
   *
   * 事件只带 id、状态与计数，不带响应正文，所以分工是固定的：**状态与计数就地打补丁**，
   * 要完整字段（状态码、耗时、成员行）的地方才重取。重取的时机两种——终态一次，以及
   * 停在第一页时收到一条打不到当前页的事件（那是刚产生的新记录）。深页不为新记录重取：
   * 偏移分页会让整页往后错一行，正在读的人会以为自己看错了。
   */
  useEffect(() => {
    stream.onEvent((event) => {
      /* `pipelineLog` 是唯一一个**没有 status** 的事件变体（它只报日志水位，P4.5-4），
         而这一页只关心状态与计数——先把它挡在门外，`event.status` 才是全类型可读的。
         不挡的话 union 收窄不过，整个仓的 `pnpm check` 就编不过去。 */
      if (event.kind === "pipelineLog") return;
      const terminal = SETTLED.has(event.status);

      if (event.kind === "execution") {
        if (recordType === "single") {
          if (idsRef.current.has(event.executionId)) {
            setData((current) => ({ ...current, items: current.items.map((item) => (item.id === event.executionId ? { ...item, status: event.status } : item)) }));
            if (terminal) scheduleReload();
          } else if (page === 1) scheduleReload();
        }
        /* 抽屉里那次跑完了就换成完整快照：事件没有正文，只改状态会让人以为请求通过了
           却什么都没返回。 */
        if (projectId && terminal && result?.id === event.executionId) {
          void api.execution(projectId, event.executionId).then(setResult).catch(() => { /* 留着手上那份快照 */ });
        }
        return;
      }

      if (event.kind === "batch") {
        if (recordType === "batch") {
          if (idsRef.current.has(event.batchId)) {
            setBatches((current) => ({ ...current, items: current.items.map((item) => (item.id === event.batchId ? { ...item, status: event.status, total: event.total, successCount: event.successCount, failedCount: event.failedCount, canceledCount: event.canceledCount } : item)) }));
            if (terminal) scheduleReload();
          } else if (page === 1) scheduleReload();
        }
        if (projectId && terminal && batchResult?.id === event.batchId) {
          void api.batchExecution(projectId, event.batchId).then(setBatchResult).catch(() => { /* 同上 */ });
        }
        return;
      }

      if (event.kind !== "flow" && event.kind !== "suite") return;
      const indexId = event.executionIndexId;
      /* 父执行的事件一定带 index id（`flowRun.ts` / `suiteRun.ts` 每一处 publish 都带），
         但类型上它是可选的：真缺了就只能靠重取，对不上号硬猜会把补丁打到别的行上。 */
      if (!indexId) { if (recordType === "parent" && page === 1) scheduleReload(); return; }
      if (recordType === "parent") {
        if (idsRef.current.has(indexId)) {
          setParents((current) => ({ ...current, items: current.items.map((item) => (item.id === indexId ? { ...item, status: event.status, total: event.total, successCount: event.successCount, failedCount: event.failedCount, skippedCount: event.skippedCount } : item)) }));
          if (terminal) scheduleReload();
        } else if (page === 1) scheduleReload();
      }
      /* 抽屉开着就按事件重取详情：父级每落地一个成员/步骤才发一条进度，所以这个频率
         本来就是对的（与套件编辑器同一条规则）。静默重取——读失败下一条事件还会再试。 */
      if (parent?.indexId === indexId) {
        void loadParent({
          id: indexId,
          kind: event.kind,
          detailId: event.kind === "suite" ? event.suiteExecutionId : event.flowExecutionId,
        }).catch(() => { /* 留着手上那份明细 */ });
      }
    });
    return () => stream.onEvent(undefined);
  }, [stream, projectId, recordType, page, result?.id, batchResult?.id, parent?.indexId, loadParent, scheduleReload]);

  const total = recordType === "batch" ? batches.total : recordType === "parent" ? parents.total : data.total;
  /* 空清单要说清是「还没跑过」还是「被筛掉了」——两者的下一步动作完全不同。批量调试
     没有筛选条件，所以它永远是前者。 */
  const timeFiltered = Boolean(from || to);
  const filtered = recordType === "batch"
    ? timeFiltered
    : recordType === "single"
      ? status !== "all" || source !== "all" || Boolean(endpointId) || Boolean(caseId) || timeFiltered
      : status !== "all" || kind !== "all" || caseFilterOnly || Boolean(keyword.trim()) || timeFiltered;

  return <main className="content">
    <div className="page-head">
      <div><h1>{t("reports.title")}</h1><p>{t("reports.hint")}</p></div>
    </div>

    <div className="filter-bar">
      <Select
        value={recordType}
        onChange={(next) => { setRecordType(next); setPage(1); }}
        options={[
          { value: "single", label: t("reports.singleRuns") },
          { value: "parent", label: t("reports.parentRuns") },
          { value: "batch", label: t("reports.batchDebugRuns") },
        ]}
        style={{ width: 150 }}
      />
      {recordType === "single" && <>
      <Select
        value={status}
        onChange={(next) => { setStatus(next); setPage(1); }}
        options={[
          { value: "all", label: t("filter.runStatusAll") },
          { value: "success", label: t("status.pass") },
          { value: "failed", label: t("status.fail") },
          /* Runs are queued now (P1-3), so these are real rows a user can hit. */
          { value: "running", label: t("status.running") },
          { value: "queued", label: t("status.queued") },
          { value: "canceled", label: t("status.canceled") },
        ]}
        style={{ width: 130 }}
      />
      <Select
        value={source}
        onChange={(next) => { setSource(next); setPage(1); }}
        options={[
          { value: "all", label: t("reports.allSources") },
          { value: "endpoint_debug", label: t("reports.sourceDebug") },
          { value: "test_case", label: t("reports.sourceCase") },
        ]}
        style={{ width: 130 }}
      />
      <Select
        value={endpointId}
        onChange={(next) => { setEndpointId(next); setPage(1); }}
        options={endpoints.map((endpoint) => ({ value: endpoint.id, label: `${endpoint.method} ${endpoint.name}` }))}
        placeholder={t("reports.allEndpoints")}
        style={{ minWidth: 220 }}
        allowClear
        showSearch
        optionFilterProp="label"
      />
      {caseId && <button
        type="button"
        className="chip chip-action mono"
        onClick={() => { setCaseId(undefined); setPage(1); }}
        title={t("reports.clearCase")}
      >
        {t("reports.caseFilterChip")} ×
      </button>}
      </>}
      {recordType === "parent" && <>
        {/* 类型筛选取代了「流程记录 / 套件记录」两个大类：同一份清单，缩一下范围。 */}
        <Select
          value={kind}
          onChange={(next) => { setKind(next); setPage(1); }}
          options={[
            { value: "all", label: t("reports.kindAll") },
            { value: "flow", label: t("reports.kindFlow") },
            { value: "suite", label: t("reports.kindSuite") },
            /* 仓库上报（P4 边界 1）：来源筛选一处不改就能看到它，这正是把它归一进
               execution_index 的理由。 */
            { value: "ingest", label: t("reports.kindIngest") },
            /* 自研 Runner 的 pipeline run（P4.5-4）：验收门槛 15——执行记录页能按 runner
               筛出来，点行跳 `pipeline-runs/:id` 执行详情页（P4.5-11/13 已落地）。 */
            { value: "runner", label: t("reports.kindRunner") },
          ]}
          style={{ width: 120 }}
        />
        {/* 只在 runner 下出现：对别的 kind 这个条件恒为假（见 caseFilterOnly 的注释）。 */}
        {kind === "runner" && <label className="check-field">
          <input type="checkbox" checked={caseFilterOnly} onChange={(event) => { setCaseFilterOnly(event.target.checked); setPage(1); }} />
          {t("reports.caseFilterOnly")}
        </label>}
        <Select
          value={status}
          onChange={(next) => { setStatus(next); setPage(1); }}
          options={[
            { value: "all", label: t("filter.runStatusAll") },
            { value: "success", label: t("status.pass") },
            { value: "failed", label: t("status.fail") },
            { value: "running", label: t("status.running") },
            { value: "queued", label: t("status.queued") },
            { value: "canceled", label: t("status.canceled") },
          ]}
          style={{ width: 130 }}
        />
        <input
          className="input mono"
          value={keyword}
          onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
          placeholder={t("reports.searchParent")}
          style={{ width: 220 }}
        />
      </>}
      {/* 时间范围筛选（三个大类共用，P8-6 验收反馈）：原生 datetime-local + .input
          皮肤——TestPlans 的既定纪律（antd DatePicker 的面板与国际化是多余的新增面）。
          提交规则见 fromInput 的注释：清空即清筛，输入中途的部分值不动已提交的窗。 */}
      <input
        type="datetime-local"
        className="input mono"
        style={{ width: 200 }}
        aria-label={t("reports.timeFrom")}
        title={t("reports.timeFrom")}
        value={fromInput}
        onChange={(event) => {
          setFromInput(event.target.value);
          if (!event.target.value) { setFrom(undefined); setPage(1); return; }
          const iso = localInputToIso(event.target.value);
          if (iso) { setFrom(iso); setPage(1); }
        }}
      />
      <span className="muted mono">–</span>
      <input
        type="datetime-local"
        className="input mono"
        style={{ width: 200 }}
        aria-label={t("reports.timeTo")}
        title={t("reports.timeTo")}
        value={toInput}
        onChange={(event) => {
          setToInput(event.target.value);
          if (!event.target.value) { setTo(undefined); setPage(1); return; }
          const iso = localInputToIso(event.target.value);
          if (iso) { setTo(iso); setPage(1); }
        }}
      />
      {/* 一键清窗（P8-6 验收反馈：清两个输入框太费手）：同时复位提交值与输入框
          原文——只清 state 不清输入框，框里还留着字，会读成「清了没生效」。 */}
      {(from || to) && <button
        type="button"
        className="chip chip-action"
        onClick={() => { setFrom(undefined); setTo(undefined); setFromInput(""); setToInput(""); setPage(1); }}
      >{t("reports.clearTime")}</button>}
      {recordType === "single" && caseId && <button
        type="button"
        className="chip chip-action mono"
        onClick={() => { setCaseId(undefined); setPage(1); }}
        title={t("reports.clearCase")}
      >
        {t("reports.caseFilterChip")} ×
      </button>}
      <span className="filter-spacer" />
      <span className="muted mono">{t("reports.total", { total })}</span>
    </div>

    {loading && <p className="muted">{t("common.loading")}</p>}

    {recordType === "batch" && batches.items.length ? <>
      <table className="grid">
        <thead><tr>
          <th>{t("reports.batchDebugRuns")}</th>
          <th className="col-num">{t("reports.totalCount")}</th>
          <th className="col-num">{t("status.pass")}</th>
          <th className="col-num">{t("status.fail")}</th>
          <th>{t("status.time")}</th>
          <th className="col-status">{t("endpoints.status")}</th>
        </tr></thead>
        <tbody>
          {batches.items.map((batch) => <tr key={batch.id} data-clickable="" onClick={() => openBatch(batch.id)}>
            <td>{t("endpoints.batchDebug")}</td>
            <td className="col-num mono">{batch.total}</td>
            <td className="col-num mono">{batch.successCount}</td>
            <td className="col-num mono">{batch.failedCount}</td>
            <td className="mono muted">{new Date(batch.createdAt).toLocaleString()}</td>
            <td className="col-status"><RunStatusTag status={batch.status === "running" ? "running" : batch.failedCount ? "fail" : "pass"} /></td>
          </tr>)}
        </tbody>
      </table>
      <div className="pager"><Pagination current={batches.page} pageSize={batches.pageSize} total={batches.total} pageSizeOptions={PAGE_SIZES} showSizeChanger onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }} /></div>
    </> : recordType === "parent" && parents.items.length ? <>
      <table className="grid">
        <thead><tr>
          <th>{t("reports.parentRuns")}</th>
          <th className="col-num">{t("reports.itemCount")}</th>
          <th className="col-num">{t("status.pass")}</th>
          <th className="col-num">{t("status.fail")}</th>
          <th className="col-num">{t("status.skip")}</th>
          <th>{t("status.time")}</th>
          <th className="col-status">{t("endpoints.status")}</th>
        </tr></thead>
        <tbody>
          {parents.items.map((run) => <tr key={run.id} data-clickable="" onClick={() => openParent(run)}>
            {/* 流程、套件还是仓库上报，决定了点开看到什么（步骤树 / 成员行 / 跳去上报记录
                页），所以类型要在收起状态下就能读到——一份混着三种运行的清单里，名字本身
                说不清这一点。 */}
            <td>
              <span className="cell-name">
                <span className="chip">{run.kind === "suite" ? t("reports.kindSuite") : run.kind === "ingest" ? t("reports.kindIngest") : run.kind === "runner" ? t("reports.kindRunner") : t("reports.kindFlow")}</span>
                <span className="truncate">{run.targetName}</span>
              </span>
            </td>
            <td className="col-num mono">{run.total}</td>
            <td className="col-num mono">{run.successCount}</td>
            <td className="col-num mono">{run.failedCount}</td>
            {/* 跳过多数时候是 0（只有 fail-fast 与取消才产生），写成 0 会让人以为它有意义。 */}
            <td className="col-num mono">{run.skippedCount || "—"}</td>
            <td className="mono muted">{new Date(run.createdAt).toLocaleString()}</td>
            <td className="col-status"><RunStatusTag status={toRunStatus(run.status)} /></td>
          </tr>)}
        </tbody>
      </table>
      <div className="pager"><Pagination current={parents.page} pageSize={parents.pageSize} total={parents.total} pageSizeOptions={PAGE_SIZES} showSizeChanger onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }} /></div>
    </> : recordType === "single" && data.items.length ? <>
      <table className="grid">
        <thead><tr>
          <th>{t("reports.subject")}</th>
          <th className="col-num">{t("status.code")}</th>
          <th className="col-num">{t("status.duration")}</th>
          <th>{t("status.time")}</th>
          <th className="col-status">{t("endpoints.status")}</th>
        </tr></thead>
        <tbody>
          {data.items.map((run) => <tr key={run.id} data-clickable="" onClick={() => openResult(run)}>
            {/* A case run is identified by its case; the endpoint it belongs to
                is secondary context, so it follows in muted type. */}
            <td className="truncate">
              {run.caseName ? <>
                <span className="chip">{t("cases.title")}</span>
                {run.caseName}
                <span className="muted run-subject-parent">{run.endpointName}</span>
              </> : <>
                {/* 与用例行同款 chip：混排清单里先读类型再读名字（接口调试发起的
                   行没有 caseName，此前只有光秃秃的接口名）。 */}
                <span className="chip">{t("reports.chipEndpoint")}</span>
                {run.endpointName}
              </>}
              {run.batchId && <span className="chip batch-source">{t("reports.batchSource")}</span>}
            </td>
            <td className="col-num mono">{run.statusCode ?? "—"}</td>
            <td className="col-num mono">{run.durationMs}</td>
            <td className="mono muted">{new Date(run.createdAt).toLocaleString()}</td>
            <td className="col-status"><RunStatusTag status={toRunStatus(run.status)} /></td>
          </tr>)}
        </tbody>
      </table>
      <div className="pager">
        <Pagination
          current={data.page}
          pageSize={data.pageSize}
          total={data.total}
          pageSizeOptions={PAGE_SIZES}
          showSizeChanger
          showQuickJumper={data.total > data.pageSize * 5}
          onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
        />
      </div>
    </> : !loading && <Empty
      title={filtered ? t("reports.emptyFilterTitle") : t("reports.emptyTitle")}
      hint={filtered ? t("reports.emptyFilterHint") : recordType === "parent" ? t("reports.emptyParentHint") : t("reports.emptyHint")}
    />}

    <ExecutionSnapshot result={result} onClose={closeResult} />
    <Drawer title={t("endpoints.batchResult")} open={Boolean(batchResult)} onClose={closeBatch} width={720} extra={batchResult && <span className="mono muted">{t("endpoints.batchSummary", { total: batchResult.total, success: batchResult.successCount, failed: batchResult.failedCount })}</span>}>
      {batchResult && <BatchResultList batch={batchResult} />}
    </Drawer>
    {/* 一条父执行按类型进对应的抽屉。两个都常挂着，各自靠 run 为空时不渲染。 */}
    <FlowRunDrawer projectId={projectId!} run={parent?.flow} onClose={closeParent} />
    <SuiteRunDrawer projectId={projectId!} run={parent?.suite} onClose={closeParent} />
  </main>;
}
