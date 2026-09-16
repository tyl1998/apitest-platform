import { useEffect, useState } from "react";
import { Drawer, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { api, type FailureCategory, type ReportAttributionSummary, type SuiteReport, type SuiteReportSummary, type TriggerSource } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useCanWrite } from "../hooks/useMyRole";
import { usePageContext } from "../hooks/usePageContext";
import { useProjectStore } from "../stores/projectStore";
import { Empty, Readout, Tip, toRunStatus } from "../ui";
import { AttributionDrawer, AttributionTag, type AttributionRequest, type AttributionTarget } from "./AttributionDrawer";
import { type DetailCrumbContext } from "./ProjectShell";
import { MemberEvidence, type MemberRow } from "./SuiteRunDrawer";
import { RunStatusTag } from "./RunStatusTag";
import { ShareReportButton } from "./ShareReportButton";

/**
 * 报告列表（P3-9，边界 13~15；2026-09-02 起是**总报告列表**）。
 *
 * 一份报告 = 一次执行的只读视图，三段：标识（报告名/名称/环境/变量覆盖——变量
 * 覆盖必须显示，否则两份跑同一个套件的报告长得一模一样而结论不同）、触发（谁让
 * 它跑的）、结论（通过率/计数/耗时/排队——派生值由服务端算好，界面不自己减时间戳）+
 * 成员明细（不分页：通读「哪几个失败了」不该翻页）。
 *
 * 2026-09-02：列表从「只有套件」扩成**套件 + 仓库执行**（验收反馈：仓库执行产生的
 * 报告也要进总报告列表）。`kind` 区分两类行，点行各走各的详情页；计数列（总/通过/
 * 失败）补齐「总和信息」——通过率是结论，计数是证据，读报告的人两个都要。
 *
 * P8-3：补「归因」列——这份报告的失败行里有多少已归因、都归成了什么。归因在叶子
 * 失败上打（边界 4），列表列是聚合读数；打标入口在报告详情的失败行上。
 */

const PAGE_SIZES = [20, 50, 100];
const TRIGGER_SOURCES: TriggerSource[] = ["manual", "scheduled", "webhook", "ci"];
const REPORT_SOURCES = ["all", "suite", "runner"] as const;
/**
 * 归因筛选的「未归因」伪值（与服务端 `attributionFilterSql` 同款）：分类 code 以小写
 * 字母开头，双下划线前缀不可能是合法 code，不会撞车。ATTRIBUTED 是对称的「已归因」
 * 伪值（看板归因读数下钻，服务端同款支持）。
 */
const UNATTRIBUTED = "__unattributed__";
const ATTRIBUTED = "__attributed__";

/** 触发列的文案：手动 / 定时「名字」 / Webhook「名字」 / CI（边界 13 的快照名）。
    source 可空：入队响应等不含触发列的形状也走这里，缺省读作手动。 */
export function triggerLabel(t: (key: string, vars?: Record<string, unknown>) => string, source?: TriggerSource, refName?: string | null) {
  const resolved = source ?? "manual";
  const base = t(`suiteReports.trigger${resolved.charAt(0).toUpperCase()}${resolved.slice(1)}`);
  return refName ? `${base}「${refName}」` : base;
}

function formatMs(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/** 变量覆盖的紧凑读法：{"lane":"lane-b"} → lane=lane-b。键名机器数据，等宽。 */
function overridesLabel(overrides: Record<string, string>) {
  const entries = Object.entries(overrides);
  if (!entries.length) return "";
  return entries.map(([key, value]) => `${key}=${value}`).join(" ");
}

/**
 * 套件失败成员的归因目标（与服务端随行 JOIN 同一口径）：用例成员（有 httpExecutionId）
 * 归到 executions 行——那才是「接口用例的 HTTP 失败」这个最小可读单元；流程成员归到
 * 成员步骤行自身（非 HTTP 失败）。列表入口与详情页共用这一个推导。
 */
function suiteMemberTarget(step: SuiteReport["members"][number]): AttributionTarget {
  return {
    targetType: step.httpExecutionId ? "execution" : "execution_step",
    targetId: step.httpExecutionId ?? step.id,
    label: step.stepName,
  };
}

/**
 * 列表的归因聚合读数（验收反馈②重排）：无失败 → 空（通过的报告不携带归因信息）；
 * 全未归因 → 「未归因 N」；有归因 → a/f + **最多一个**分类 chip（104px 截断
 * ellipsis）+ `+N`（其余分类数），单行不换行。**完整分布在 hover 面板里**（验收
 * 反馈三轮①）：`Tip`（antd Tooltip，100ms）列出每个分类与计数——原生 title 要等
 * 一秒且样式不可控。`actionable` 时整体是打标入口（验收反馈①）：分类名由服务端
 * 随行带出，读侧不依赖字典请求。
 */
function AttributionSummaryCell({ summary, t, actionable, onClick }: {
  summary: ReportAttributionSummary;
  t: (key: string, vars?: Record<string, unknown>) => string;
  actionable: boolean;
  onClick?: () => void;
}) {
  if (!summary.failed) return null;
  const top = summary.categories[0];
  const rest = summary.categories.length - 1;
  const body = summary.attributed === 0
    ? <span className="chip">{t("attribution.unattributedCount", { count: summary.failed })}</span>
    : <>
        <span className="mono">{summary.attributed}/{summary.failed}</span>
        {top && <span className="chip">{top.name}{top.count > 1 ? `×${top.count}` : ""}</span>}
        {rest > 0 && <span className="muted mono">+{rest}</span>}
      </>;
  const hover = <div className="attribution-hover">
    <span className="mono muted">{t("attribution.coverageTitle", { attributed: summary.attributed, failed: summary.failed })}</span>
    {summary.categories.map((each) => (
      <span key={each.code} className="attribution-hover-row">
        <span className="truncate">{each.name}</span>
        <span className="mono muted">×{each.count}</span>
      </span>
    ))}
    {actionable && <span className="muted">{t("attribution.entryHint")}</span>}
  </div>;
  return <Tip text={hover}>
    {actionable
      ? <button type="button" className="attribution-entry" onClick={(event) => { event.stopPropagation(); onClick?.(); }}>{body}</button>
      : <span className="attribution-cell">{body}</span>}
  </Tip>;
}

export function SuiteReports() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  /* 列表归因入口的角色判定（P8-3 验收反馈①）：viewer 只读聚合，不出现打标入口。 */
  const canWrite = useCanWrite();

  const [keyword, setKeyword] = useState("");
  const debouncedKeyword = useDebounced(keyword);
  const [triggerSource, setTriggerSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [source, setSource] = useState<(typeof REPORT_SOURCES)[number]>("all");
  /* 归因类型多选（验收反馈①）：值是分类 code 或 UNATTRIBUTED 伪值。URL 里的
     `?attribution=` 是统计页归因环形的下钻入口（P8-6，12.2 URL 表）——只做初始化，
     不回写：报告列表自己的筛选交互保持原样，深链进来的人改筛选后地址栏留在本地
     状态即可（与服务端检索铁律不冲突——attribution 是筛选值不是检索结果页）。 */
  const [searchParams] = useSearchParams();
  const [attributionFilter, setAttributionFilter] = useState<string[]>(() =>
    (searchParams.get("attribution") ?? "").split(",").map((code) => code.trim()).filter(Boolean));
  const [reports, setReports] = useState<SuiteReportSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  /* 归因打标后按 key 重拉列表（聚合读数随行跟上）。 */
  const [refreshKey, setRefreshKey] = useState(0);
  /* 列表行打开的归因抽屉 + 取目标中的报告 id（防连点重复拉取）。 */
  const [attribution, setAttribution] = useState<AttributionRequest>();
  const [openingId, setOpeningId] = useState<string>();
  /* 筛选选项的分类字典（active 项；失败时静默降级为只剩「未归因」一项）。 */
  const [categories, setCategories] = useState<FailureCategory[]>([]);

  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    void api.failureCategories(projectId).then(setCategories).catch(() => {});
  }, [projectId, loadedProjectId, projectLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    let alive = true;
    setLoading(true);
    void api.suiteReports(projectId, {
      keyword: debouncedKeyword,
      triggerSource,
      status,
      source,
      attribution: attributionFilter.length ? attributionFilter.join(",") : undefined,
      page,
      pageSize,
    })
      .then((result) => {
        if (!alive) return;
        setReports(result.items);
        setTotal(result.total);
      })
      .catch(() => { if (alive) message.error(t("suiteReports.loadFailed")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, loadedProjectId, projectLoading, debouncedKeyword, triggerSource, status, source, attributionFilter, page, pageSize, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 行点击：两类报告各走各的详情页（kind 由服务端 UNION 时给出）。仓库执行带
      `?from=suite-reports`——面包屑/侧栏归「报告列表」而非「仓库」（验收反馈③：
      从哪进来的就回哪去；仓库模式内的入口不带参数，维持仓库归属）。 */
  function open(report: SuiteReportSummary) {
    if (!projectId) return;
    navigate(report.kind === "runner"
      ? `/projects/${projectId}/pipeline-runs/${report.id}?tab=report&from=suite-reports`
      : `/projects/${projectId}/suite-reports/${report.id}`);
  }

  /**
   * 列表行的归因入口（验收反馈①）：拉取该报告的失败行清单（带各自当前归因），开
   * **同一个归因抽屉**——单条与多条只是清单长度不同（预填、清除、批量语义统一在
   * 抽屉内按「全批是否同分类」推导，验收反馈四轮③）。目标按报告类型取叶子失败：
   * 套件 = 失败成员（suiteMemberTarget），仓库执行 = failed/error 的用例行。
   */
  async function openReportAttribution(report: SuiteReportSummary) {
    if (!projectId || !report.attribution.failed || openingId) return;
    setOpeningId(report.id);
    try {
      let request: AttributionRequest;
      if (report.kind === "suite") {
        const detail = await api.suiteReport(projectId, report.id);
        const failedSteps = detail.members.filter((step) => step.status === "failed");
        request = {
          targets: failedSteps.map((step) => ({ ...suiteMemberTarget(step), attribution: step.attribution })),
          evidenceMessage: failedSteps.length === 1 ? failedSteps[0].error ?? undefined : undefined,
        };
      } else {
        const cases = await api.pipelineRunCases(projectId, report.id);
        const failedRows = cases.filter((row) => row.status === "failed" || row.status === "error");
        request = {
          targets: failedRows.map((row) => ({
            targetType: "pipeline_run_case" as const,
            targetId: row.id,
            label: row.caseName,
            attribution: row.attribution,
          })),
          evidenceMessage: failedRows.length === 1 ? failedRows[0].message : undefined,
        };
      }
      if (request.targets.length) setAttribution(request);
    } catch {
      message.error(t("suiteReports.loadFailed"));
    } finally {
      setOpeningId(undefined);
    }
  }

  return <main className="content">
    <div className="page-head">
      <div><h1>{t("suiteReports.title")}</h1><p>{t("suiteReports.hint")}</p></div>
    </div>

    <div className="filter-bar">
      <input className="input" value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }} placeholder={t("suiteReports.searchPlaceholder")} />
      <Select
        value={source}
        onChange={(value) => { setSource(value); setPage(1); }}
        style={{ width: 148 }}
        options={REPORT_SOURCES.map((each) => ({ value: each, label: t(`suiteReports.source.${each}`) }))}
      />
      <Select
        value={triggerSource}
        onChange={(value) => { setTriggerSource(value); setPage(1); }}
        style={{ width: 148 }}
        options={[{ value: "all", label: t("suiteReports.trigger") }, ...TRIGGER_SOURCES.map((source) => ({ value: source, label: t(`suiteReports.trigger${source.charAt(0).toUpperCase()}${source.slice(1)}`) }))]}
      />
      <Select
        value={status}
        onChange={(value) => { setStatus(value); setPage(1); }}
        style={{ width: 148 }}
        options={[
          { value: "all", label: t("filter.runStatusAll") },
          { value: "success", label: t("status.pass") },
          { value: "failed", label: t("status.fail") },
          /* 仓库执行会停在排队/执行中（Runner 异步终态），筛选项要能选到它们。 */
          { value: "running", label: t("status.running") },
          { value: "queued", label: t("status.queued") },
          { value: "canceled", label: t("status.canceled") },
        ]}
      />
      {/* 归因类型多选（验收反馈①）：服务端过滤（分页列表不能只筛当前页）；「未归因」
          伪值回答「哪些报告还有失败没归因」、「已归因」伪值回答「哪些报告的失败已经
          归因完」（看板归因读数下钻，服务端 attributionFilterSql 认这两个双下划线
          伪值）。 */}
      <Select
        mode="multiple"
        value={attributionFilter}
        onChange={(value) => { setAttributionFilter(value); setPage(1); }}
        style={{ minWidth: 190, maxWidth: 300 }}
        maxTagCount="responsive"
        allowClear
        placeholder={t("attribution.filterPlaceholder")}
        options={[
          ...categories.map((each) => ({ value: each.code, label: each.name })),
          { value: ATTRIBUTED, label: t("attribution.attributed") },
          { value: UNATTRIBUTED, label: t("attribution.unattributed") },
        ]}
      />
    </div>

    {loading && <p className="muted">{t("filter.searching")}</p>}

    {reports.length ? <table className="grid report-grid">
      <colgroup>
        {/* 报告列吃剩余宽度；固定列合计 ~800px，1050px 内容宽下报告名仍有 ~250px。
            名称/通过/失败三列已删（验收反馈②）：报告名兜底读 targetName，通过/失败
            由通过率与总数承担结论，归因列比重复的计数更值得占这 160px。 */}
        <col />
        <col className="report-col-trigger" />
        <col className="col-num" />
        <col className="col-num report-col-count" />
        <col className="col-num" />
        <col className="col-status" />
        <col className="report-col-attribution" />
        <col className="report-col-clock" />
      </colgroup>
      <thead><tr>
        <th>{t("suiteReports.reportName")}</th>
        <th>{t("suiteReports.trigger")}</th>
        <th className="col-num">{t("suiteReports.passRate")}</th>
        <th className="col-num">{t("reports.itemCount")}</th>
        <th className="col-num">{t("suiteReports.duration")}</th>
        <th className="col-status">{t("endpoints.status")}</th>
        <th>{t("attribution.column")}</th>
        <th className="mono">{t("flows.lastRun")}</th>
      </tr></thead>
      <tbody>
        {reports.map((report) => <tr key={`${report.kind}-${report.id}`} data-clickable onClick={() => open(report)}>
          <td>
            <span className="cell-name">
              {/* 类型在收起状态下就能读到：混合清单里名字本身说不清点开会看到什么。
                  报告名缺省时兜底读套件名/任务名（名称列删除后这里是唯一的名字）。 */}
              <span className="chip">{t(`suiteReports.kind.${report.kind}`)}</span>
              <span className="mono truncate">{report.reportName ?? report.targetName ?? report.id}</span>
            </span>
            {/* 变量覆盖是标识段的一部分：不带覆盖的报告长得一样，结论可以完全不同。 */}
            {overridesLabel(report.variableOverrides) && <span className="mono muted report-variables">{overridesLabel(report.variableOverrides)}</span>}
          </td>
          <td className="truncate">{triggerLabel(t, report.triggerSource, report.triggerRefName)}</td>
          <td className="col-num mono">{report.passRate === null ? "—" : `${report.passRate.toFixed(1)}%`}</td>
          <td className="col-num mono">{report.total}</td>
          <td className="col-num mono">{formatMs(report.durationMs)}</td>
          <td className="col-status"><RunStatusTag status={toRunStatus(report.status)} /></td>
          <td><AttributionSummaryCell
            summary={report.attribution}
            t={t}
            actionable={canWrite && Boolean(projectId)}
            onClick={() => void openReportAttribution(report)}
          /></td>
          <td className="mono muted">{new Date(report.createdAt).toLocaleString()}</td>
        </tr>)}
      </tbody>
    </table> : !loading && <Empty
      title={debouncedKeyword || triggerSource !== "all" || status !== "all" || source !== "all" ? t("suiteReports.emptyFiltered") : t("suiteReports.emptyTitle")}
      hint={debouncedKeyword || triggerSource !== "all" || status !== "all" || source !== "all" ? t("suites.emptyFilteredHint") : t("suiteReports.emptyHint")}
    />}

    {reports.length > 0 && <div className="pager">
      <Pagination
        current={page}
        pageSize={pageSize}
        total={total}
        pageSizeOptions={PAGE_SIZES}
        showSizeChanger
        showQuickJumper={total > pageSize * 5}
        onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
      />
    </div>}

    {/* 列表行的归因抽屉（验收反馈①）：单条/批量由该报告的失败数决定；落库后重拉列表。 */}
    {attribution && projectId && (
      <AttributionDrawer
        projectId={projectId}
        targets={attribution.targets}
        evidenceMessage={attribution.evidenceMessage}
        onClose={() => setAttribution(undefined)}
        onDone={() => setRefreshKey((key) => key + 1)}
      />
    )}
  </main>;
}

/* ── 详情：三段只读视图 + 成员明细（不分页，边界 14） ───────────── */

/** 独立路由挂载（`/suite-reports/:executionId`）：报告是只读派生物，没有编辑态。 */
export function SuiteReportPage() {
  const { t } = useTranslation();
  const { projectId, executionId } = useParams();
  /* 报告名推给外壳的面包屑：{项目}/报告列表/{报告名}，加载中回落「当前报告」。 */
  const { setDetailTitle } = useOutletContext<DetailCrumbContext>();
  /* 归因入口的角色判定在这里做（项目路由上下文内）；详情主体只收结果。 */
  const canWrite = useCanWrite();
  const [report, setReport] = useState<SuiteReport>();
  const [failed, setFailed] = useState(false);
  /* 归因打标后按 key 重拉（P8-3）：归因是随行 JOIN 的，落库后必须重新装载报告。 */
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setDetailTitle(report?.reportName ?? report?.id);
    return () => setDetailTitle(undefined);
  }, [report, setDetailTitle]);

  useEffect(() => {
    if (!projectId || !executionId) return;
    let alive = true;
    setReport(undefined); setFailed(false);
    void api.suiteReport(projectId, executionId)
      .then((result) => { if (alive) setReport(result); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [projectId, executionId, refreshKey]);

  /* 助手页面上下文（P9-4c）：URL 已带 executionId，这里补报告/套件名——「第三个
     失败的用例帮我分析」由 agent 拉报告自数序号；分享页（无抽屉）不注册。 */
  usePageContext(executionId ? {
    page: "suite-report",
    entities: {
      executionId,
      ...(report?.reportName ? { reportName: report.reportName } : {}),
      ...(report ? { suiteName: report.suiteName } : {}),
    },
  } : undefined);

  if (failed) return <main className="content"><Empty title={t("suiteReports.loadFailed")} hint={t("suiteReports.emptyHint")} /></main>;
  if (!report) return <main className="content"><p className="muted">{t("common.loading")}</p></main>;

  return <SuiteReportDetail
    report={report}
    projectId={projectId}
    t={t}
    canWrite={canWrite}
    onChanged={() => setRefreshKey((key) => key + 1)}
  />;
}

/**
 * 报告详情主体。`publicView`（分享页）自 2026-09-03 起也开成员证据抽屉：证据按
 * `shareToken` 走公开端点（`/public/report-shares/:token/*`，服务端按报告的证据闭包
 * 校验归属），不再需要登录。仍关闭的只有分享按钮（创建分享要 write 权限）。
 *
 * P8-3：失败成员行上有人工归因入口（chip 即按钮，开归因抽屉）+ 批量勾选。`canWrite`
 * 由**站内调用方**算好传入——分享页没有项目上下文，store 里的角色可能是别的项目的，
 * 在这里自查会得出错误的可写判定。
 */
export function SuiteReportDetail({ projectId, report, t, publicView, shareToken, canWrite, onChanged }: {
  projectId?: string;
  report: SuiteReport;
  t: (key: string, vars?: Record<string, unknown>) => string;
  publicView?: boolean;
  /** 分享页的 token：传了它，成员证据就走公开端点。 */
  shareToken?: string;
  /** developer 及以上（站内详情页传入；分享/只读视图缺省 false——chip 只读）。 */
  canWrite?: boolean;
  /** 归因落库后的刷新回调（重拉报告让随行归因跟上）。 */
  onChanged?: () => void;
}) {
  /** 抽屉里正展示证据的成员；报告是只读派生物，证据按需拉。 */
  const [member, setMember] = useState<MemberRow>();
  /* 归因抽屉的目标批次（单条 = 一项）；undefined = 关闭。 */
  const [attribution, setAttribution] = useState<AttributionRequest>();
  /* 批量勾选的失败成员（步骤 id）。只有失败行可勾——成功行没有归因目标。 */
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const failedMembers = report.members.filter((step) => step.status === "failed");
  /* 批量入口只在「有失败可归因 + 可写 + 站内」时出现；分享页保持纯只读。 */
  const batchAvailable = Boolean(canWrite && projectId && !publicView && failedMembers.length > 0);
  /* 归因列只在该报告有失败时出现（P8-3 验收反馈：通过的报告不携带归因信息）。 */
  const showAttribution = failedMembers.length > 0;

  function toggleChecked(stepId: string, next: boolean) {
    setChecked((current) => {
      const copy = new Set(current);
      if (next) copy.add(stepId); else copy.delete(stepId);
      return copy;
    });
  }

  function openBatchAttribution() {
    const targets = failedMembers
      .filter((step) => checked.has(step.id))
      .map((step) => ({ ...suiteMemberTarget(step), attribution: step.attribution }));
    if (targets.length) setAttribution({ targets });
  }

  function toggleAllFailed(next: boolean) {
    setChecked(next ? new Set(failedMembers.map((step) => step.id)) : new Set());
  }

  const overrides = overridesLabel(report.variableOverrides);

  /* 成员行 → 证据抽屉的行形状：与运行抽屉同一套渲染（MemberEvidence），用例成员
      再补一次单执行快照（报告接口只给步骤行，不含响应正文）。公开视图下快照走
      token 端点——那正是 2026-09-03 修的问题（原先公开页成员行点了没反应）。 */
  const openMember = async (step: SuiteReport["members"][number]) => {
    if (!projectId && !shareToken) return;
    const row: MemberRow = {
      key: step.id,
      type: step.stepType,
      name: step.stepName,
      status: step.status,
      durationMs: step.durationMs,
      error: step.error ?? undefined,
      childIndexId: step.childIndexId,
    };
    if (step.httpExecutionId) {
      try {
        row.execution = shareToken
          ? await api.publicShareExecution(shareToken, step.httpExecutionId)
          : await api.execution(projectId!, step.httpExecutionId);
      } catch { /* 快照拉不到时照常渲染步骤行上的证据（错误文本仍在）。 */ }
    }
    setMember(row);
  };
  /** 有证据可看的成员：httpExecutionId / childIndexId / error 三者之一。 */
  const hasEvidence = (step: SuiteReport["members"][number]) => Boolean(step.httpExecutionId || step.childIndexId || step.error);

  const body = <>
    {/* 返回入口由外壳的面包屑（{项目}/报告列表/{报告名}）承担，页面不再自带返回按钮。 */}
    <div className="page-head">
      <div>
        <h1 className="mono">{report.reportName ?? report.id}</h1>
        <p>{report.suiteName}</p>
      </div>
      {/* 分享是报告的固有能力（2026-09-02）：免登录只读链接。创建要登录（write 权限）。 */}
      {!publicView && projectId && <div className="topbar-actions">
        <ShareReportButton projectId={projectId} targetType="suite" targetId={report.id} />
      </div>}
    </div>

    <div className="readouts">
      <Readout label={t("endpoints.status")} value={<RunStatusTag status={toRunStatus(report.status)} />} />
      <Readout label={t("suiteReports.passRate")} value={report.passRate === null ? "—" : report.passRate.toFixed(1)} unit="%" />
      <Readout label={t("suiteReports.duration")} value={formatMs(report.durationMs)} />
      <Readout label={t("suiteReports.queueTime")} value={formatMs(report.queueMs)} />
      {/* 表头是静态文案，动态数字留给值：把「1/1 个成员通过」写进表头既是语义重复，
          也让每个项目的概览卡片文案都不一样。 */}
      <Readout label={t("suiteReports.memberPass")} value={`${report.successCount}/${report.total}`} />
    </div>

    <section className="panel">
      <div className="panel-head"><strong>{t("suiteReports.identity")}</strong></div>
      <div className="panel-body">
        <dl className="definition-grid">
          <div><dt>{t("suiteReports.reportName")}</dt><dd className="mono">{report.reportName ?? "—"}</dd></div>
          <div><dt>{t("suites.name")}</dt><dd>{report.suiteName}</dd></div>
          <div><dt>{t("flows.environment")}</dt><dd>{report.environmentName ?? t("endpoints.noEnvironment")}</dd></div>
          <div><dt>{t("suiteReports.variables")}</dt><dd className="mono">{overrides || <span className="muted">{t("suiteReports.variablesNone")}</span>}</dd></div>
          <div><dt>{t("suiteReports.trigger")}</dt><dd>{triggerLabel(t, report.triggerSource, report.triggerRefName)}</dd></div>
          <div><dt>{t("environments.runnerLabel")}</dt><dd className="mono">{report.runnerLabel}</dd></div>
          <div><dt>{t("suiteReports.startedAt")}</dt><dd className="mono">{new Date(report.startedAt ?? report.createdAt).toLocaleString()}</dd></div>
          <div><dt>{t("suiteReports.finishedAt")}</dt><dd className="mono">{report.finishedAt ? new Date(report.finishedAt).toLocaleString() : "—"}</dd></div>
        </dl>
        {report.error && <p className="form-note text-fail mono">{report.error}</p>}
      </div>
    </section>

    <section className="panel">
      <div className="panel-head">
        <div className="cell-name">
          <strong>{t("suiteReports.memberDetail")}</strong>
          <span className="mono muted">{t("suites.memberSummary", { success: report.successCount, total: report.total })}</span>
        </div>
        {/* 批量归因（边界 4：一次挂一片同因失败太常见）：勾选失败成员后一次打标。 */}
        {batchAvailable && <div className="topbar-actions">
          <button type="button" className="btn btn-small" disabled={!checked.size} onClick={openBatchAttribution}>
            {t("attribution.batch", { count: checked.size })}
          </button>
        </div>}
      </div>
      <div className="panel-body">
        {report.members.length ? <table className="grid">
          <thead><tr>
            {batchAvailable && <th className="col-select">
              {/* 全选失败：批量归因的主路径；套件成员无筛选，scope 就是全部失败成员。 */}
              <input
                type="checkbox"
                aria-label={t("attribution.selectAllFailed")}
                checked={failedMembers.length > 0 && failedMembers.every((step) => checked.has(step.id))}
                onChange={(event) => toggleAllFailed(event.target.checked)}
              />
            </th>}
            <th>{t("suites.members")}</th>
            <th className="col-status">{t("endpoints.status")}</th>
            {showAttribution && <th>{t("attribution.column")}</th>}
            <th className="col-num mono">{t("endpoints.duration")}</th>
            <th>{t("environments.variables")}</th>
          </tr></thead>
          <tbody>
            {report.members.map((step) => <tr
              key={step.id}
              data-clickable={hasEvidence(step) ? "" : undefined}
              onClick={hasEvidence(step) ? () => void openMember(step) : undefined}
            >
              {batchAvailable && <td className="col-select" onClick={(event) => event.stopPropagation()}>
                {/* 只有失败行可勾：成功/跳过行没有归因目标，混进批次会被服务端整批拒绝。 */}
                {step.status === "failed" && <input
                  type="checkbox"
                  aria-label={t("attribution.selectTarget", { name: step.stepName })}
                  checked={checked.has(step.id)}
                  onChange={(event) => toggleChecked(step.id, event.target.checked)}
                />}
              </td>}
              <td>
                <span className="cell-name">
                  <span className="chip">{step.stepType === "flow" ? t("suites.memberTypeFlow") : t("suites.memberTypeCase")}</span>
                  <span className="truncate">{step.stepName}</span>
                </span>
              </td>
              <td className="col-status"><RunStatusTag status={toRunStatus(step.status)} /></td>
              {showAttribution && <td>
                {step.status === "failed"
                  ? <AttributionTag
                      attribution={step.attribution}
                      actionable={Boolean(canWrite && projectId && !publicView)}
                      onClick={() => setAttribution({
                        targets: [{ ...suiteMemberTarget(step), attribution: step.attribution }],
                        evidenceMessage: step.error ?? undefined,
                      })}
                    />
                  /* 通过/跳过的成员：空单元格——归因列只对失败行有内容。 */
                  : null}
              </td>}
              <td className="col-num mono">{step.durationMs}ms</td>
              <td className="mono muted truncate" title={step.error ?? ""}>{step.error ?? "—"}</td>
            </tr>)}
          </tbody>
        </table> : <p className="form-note">{t("suites.runMembersEmpty")}</p>}
      </div>
    </section>

    {/* 成员证据抽屉：与运行抽屉同一套渲染（用例 = 请求快照，流程 = 步骤树）。
        公开视图同样挂（2026-09-03 起证据走 token 端点，见 openMember）。 */}
    <Drawer
      title={member?.name}
      open={Boolean(member)}
      onClose={() => setMember(undefined)}
      width={720}
    >
      {member && (projectId || shareToken) && (
        <MemberEvidence projectId={projectId} row={member} shareToken={shareToken} />
      )}
    </Drawer>

    {/* 归因抽屉（P8-3）：单条（失败行 chip 点开）与批量（勾选后工具条按钮）同一组件。
        落库成功 → onChanged 重拉报告，随行归因读数立即跟上；勾选随之清空。 */}
    {attribution && projectId && !publicView && (
      <AttributionDrawer
        projectId={projectId}
        targets={attribution.targets}
        evidenceMessage={attribution.evidenceMessage}
        onClose={() => setAttribution(undefined)}
        onDone={() => { setChecked(new Set()); onChanged?.(); }}
      />
    )}
  </>;

  /* 公开视图被嵌进分享页的外壳里，不再自带 <main>（嵌套 main 不合法）。 */
  return publicView ? body : <main className="content">{body}</main>;
}
