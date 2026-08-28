import { useEffect, useState } from "react";
import { Drawer, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api, type SuiteReport, type SuiteReportSummary, type TriggerSource } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useProjectStore } from "../stores/projectStore";
import { Empty, Readout, toRunStatus } from "../ui";
import { type DetailCrumbContext } from "./ProjectShell";
import { MemberEvidence, type MemberRow } from "./SuiteRunDrawer";
import { RunStatusTag } from "./RunStatusTag";

/**
 * 套件报告（P3-9，边界 13~15）。
 *
 * 一份报告 = 一次套件执行的只读视图，三段：标识（报告名/套件/环境/变量覆盖——变量
 * 覆盖必须显示，否则两份跑同一个套件的报告长得一模一样而结论不同）、触发（谁让
 * 它跑的）、结论（通过率/耗时/排队——派生值由服务端算好，界面不自己减时间戳）+
 * 成员明细（不分页：通读「哪几个失败了」不该翻页）。
 */

const PAGE_SIZES = [20, 50, 100];
const TRIGGER_SOURCES: TriggerSource[] = ["manual", "scheduled", "webhook", "ci"];

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

export function SuiteReports() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();

  const [keyword, setKeyword] = useState("");
  const debouncedKeyword = useDebounced(keyword);
  const [triggerSource, setTriggerSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [reports, setReports] = useState<SuiteReportSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    let alive = true;
    setLoading(true);
    void api.suiteReports(projectId, { keyword: debouncedKeyword, triggerSource, status, page, pageSize })
      .then((result) => {
        if (!alive) return;
        setReports(result.items);
        setTotal(result.total);
      })
      .catch(() => { if (alive) message.error(t("suiteReports.loadFailed")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, loadedProjectId, projectLoading, debouncedKeyword, triggerSource, status, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  return <main className="content">
    <div className="page-head">
      <div><h1>{t("suiteReports.title")}</h1><p>{t("suiteReports.hint")}</p></div>
    </div>

    <div className="filter-bar">
      <input className="input" value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }} placeholder={t("suiteReports.searchPlaceholder")} />
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
        ]}
      />
    </div>

    {loading && <p className="muted">{t("filter.searching")}</p>}

    {reports.length ? <table className="grid report-grid">
      <colgroup>
        <col />
        <col />
        <col className="report-col-trigger" />
        <col className="col-num" />
        <col className="col-num" />
        <col className="col-status" />
        <col className="report-col-clock" />
      </colgroup>
      <thead><tr>
        <th>{t("suiteReports.reportName")}</th>
        <th>{t("suites.name")}</th>
        <th>{t("suiteReports.trigger")}</th>
        <th className="col-num">{t("suiteReports.passRate")}</th>
        <th className="col-num">{t("suiteReports.duration")}</th>
        <th className="col-status">{t("endpoints.status")}</th>
        <th className="mono">{t("flows.lastRun")}</th>
      </tr></thead>
      <tbody>
        {reports.map((report) => <tr key={report.id} data-clickable onClick={() => navigate(`/projects/${projectId}/suite-reports/${report.id}`)}>
          <td><span className="mono truncate">{report.reportName ?? report.id}</span>
            {/* 变量覆盖是标识段的一部分：不带覆盖的报告长得一样，结论可以完全不同。 */}
            {overridesLabel(report.variableOverrides) && <span className="mono muted report-variables">{overridesLabel(report.variableOverrides)}</span>}
          </td>
          <td className="truncate">{report.suiteName}</td>
          <td className="truncate">{triggerLabel(t, report.triggerSource, report.triggerRefName)}</td>
          <td className="col-num mono">{report.passRate === null ? "—" : `${report.passRate.toFixed(1)}%`}</td>
          <td className="col-num mono">{formatMs(report.durationMs)}</td>
          <td className="col-status"><RunStatusTag status={toRunStatus(report.status)} /></td>
          <td className="mono muted">{new Date(report.createdAt).toLocaleString()}</td>
        </tr>)}
      </tbody>
    </table> : !loading && <Empty
      title={debouncedKeyword || triggerSource !== "all" || status !== "all" ? t("suiteReports.emptyFiltered") : t("suiteReports.emptyTitle")}
      hint={debouncedKeyword || triggerSource !== "all" || status !== "all" ? t("suites.emptyFilteredHint") : t("suiteReports.emptyHint")}
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
  </main>;
}

/* ── 详情：三段只读视图 + 成员明细（不分页，边界 14） ───────────── */

/** 独立路由挂载（`/suite-reports/:executionId`）：报告是只读派生物，没有编辑态。 */
export function SuiteReportPage() {
  const { t } = useTranslation();
  const { projectId, executionId } = useParams();
  /* 报告名推给外壳的面包屑：{项目}/报告列表/{报告名}，加载中回落「当前报告」。 */
  const { setDetailTitle } = useOutletContext<DetailCrumbContext>();
  const [report, setReport] = useState<SuiteReport>();
  const [failed, setFailed] = useState(false);

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
  }, [projectId, executionId]);

  if (failed) return <main className="content"><Empty title={t("suiteReports.loadFailed")} hint={t("suiteReports.emptyHint")} /></main>;
  if (!report) return <main className="content"><p className="muted">{t("common.loading")}</p></main>;

  return <SuiteReportDetail report={report} projectId={projectId} t={t} />;
}

function SuiteReportDetail({ projectId, report, t }: {
  projectId?: string;
  report: SuiteReport;
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  /** 抽屉里正展示证据的成员；报告是只读派生物，证据按需拉。 */
  const [member, setMember] = useState<MemberRow>();

  const overrides = overridesLabel(report.variableOverrides);

  /* 成员行 → 证据抽屉的行形状：与运行抽屉同一套渲染（MemberEvidence），用例成员
     再补一次单执行快照（报告接口只给步骤行，不含响应正文）。 */
  const openMember = async (step: SuiteReport["members"][number]) => {
    if (!projectId) return;
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
      try { row.execution = await api.execution(projectId, step.httpExecutionId); }
      catch { /* 快照拉不到时照常渲染步骤行上的证据（错误文本仍在）。 */ }
    }
    setMember(row);
  };
  /** 有证据可看的成员才可点击：httpExecutionId / childIndexId / error 三者之一。 */
  const hasEvidence = (step: SuiteReport["members"][number]) => Boolean(step.httpExecutionId || step.childIndexId || step.error);

  return <main className="content">
    {/* 返回入口由外壳的面包屑（{项目}/报告列表/{报告名}）承担，页面不再自带返回按钮。 */}
    <div className="page-head">
      <div>
        <h1 className="mono">{report.reportName ?? report.id}</h1>
        <p>{report.suiteName}</p>
      </div>
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
      <div className="panel-head"><strong>{t("suiteReports.memberDetail")}</strong><span className="mono muted">{t("suites.memberSummary", { success: report.successCount, total: report.total })}</span></div>
      <div className="panel-body">
        {report.members.length ? <table className="grid">
          <thead><tr>
            <th>{t("suites.members")}</th>
            <th className="col-status">{t("endpoints.status")}</th>
            <th className="col-num mono">{t("endpoints.duration")}</th>
            <th>{t("environments.variables")}</th>
          </tr></thead>
          <tbody>
            {report.members.map((step) => <tr
              key={step.id}
              data-clickable={hasEvidence(step) ? "" : undefined}
              onClick={hasEvidence(step) ? () => void openMember(step) : undefined}
            >
              <td>
                <span className="cell-name">
                  <span className="chip">{step.stepType === "flow" ? t("suites.memberTypeFlow") : t("suites.memberTypeCase")}</span>
                  <span className="truncate">{step.stepName}</span>
                </span>
              </td>
              <td className="col-status"><RunStatusTag status={toRunStatus(step.status)} /></td>
              <td className="col-num mono">{step.durationMs}ms</td>
              <td className="mono muted truncate" title={step.error ?? ""}>{step.error ?? "—"}</td>
            </tr>)}
          </tbody>
        </table> : <p className="form-note">{t("suites.runMembersEmpty")}</p>}
      </div>
    </section>

    {/* 成员证据抽屉：与运行抽屉同一套渲染（用例 = 请求快照，流程 = 步骤树）。 */}
    <Drawer
      title={member?.name}
      open={Boolean(member)}
      onClose={() => setMember(undefined)}
      width={720}
    >
      {member && projectId && <MemberEvidence projectId={projectId} row={member} />}
    </Drawer>
  </main>;
}
