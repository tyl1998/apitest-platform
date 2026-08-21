import { useEffect, useState } from "react";
import { Drawer, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { api, type BatchDebugResult, type BatchDebugSummary, type Execution, type ExecutionIndex, type ExecutionSourceFilter, type FlowExecutionDetail, type Paged } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { Empty, toRunStatus } from "../ui";
import { BatchResultList } from "./BatchResultList";
import { ExecutionSnapshot } from "./ExecutionSnapshot";
import { FlowRunDrawer } from "./FlowRunDrawer";
import { RunStatusTag } from "./RunStatusTag";

const PAGE_SIZES = [20, 50, 100, 200];

/**
 * Every execution in the project, paged.
 *
 * Records are the audit trail, so nothing is dropped: the server reports the
 * true total and this page walks it. An earlier version fetched one capped
 * batch and silently presented it as the whole history.
 */
export function ExecutionRecords() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { endpoints } = useProjectStore();

  const [status, setStatus] = useState(searchParams.get("status") ?? "all");
  const [recordType, setRecordType] = useState(searchParams.get("type") ?? "single");
  const [source, setSource] = useState(searchParams.get("source") ?? "all");
  const [endpointId, setEndpointId] = useState(searchParams.get("endpointId") ?? undefined);
  const [keyword, setKeyword] = useState(searchParams.get("keyword") ?? "");
  const [page, setPage] = useState(Number(searchParams.get("page") ?? 1));
  const [pageSize, setPageSize] = useState(Number(searchParams.get("pageSize") ?? 20));

  const [data, setData] = useState<Paged<Execution>>({ items: [], page: 1, pageSize: 20, total: 0 });
  const [batches, setBatches] = useState<Paged<BatchDebugSummary>>({ items: [], page: 1, pageSize: 20, total: 0 });
  const [flows, setFlows] = useState<Paged<ExecutionIndex>>({ items: [], page: 1, pageSize: 20, total: 0 });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Execution>();
  const [batchResult, setBatchResult] = useState<BatchDebugResult>();
  const [flowRun, setFlowRun] = useState<FlowExecutionDetail>();

  useEffect(() => {
    if (!projectId) return;
    setSearchParams({
      ...(recordType === "single" && status !== "all" ? { status } : {}),
      ...(recordType === "single" && source !== "all" ? { source } : {}),
      ...(recordType === "single" && endpointId ? { endpointId } : {}),
      ...(recordType !== "single" ? { type: recordType } : {}),
      ...(recordType !== "single" && status !== "all" ? { status } : {}),
      ...(recordType === "flow" && keyword ? { keyword } : {}),
      ...(page > 1 ? { page: String(page) } : {}),
      ...(pageSize !== 20 ? { pageSize: String(pageSize) } : {}),
      ...(searchParams.get("run") ? { run: searchParams.get("run")! } : {}),
    }, { replace: true });

    setLoading(true);
    const request: Promise<Paged<Execution> | Paged<BatchDebugSummary> | Paged<ExecutionIndex>> = recordType === "batch"
      ? api.batchExecutions(projectId, page, pageSize)
      : recordType === "flow"
        ? api.executionIndex(projectId, { kind: "flow", status, keyword, page, pageSize })
        : api.executions(projectId, { status, endpointId, source: source as ExecutionSourceFilter, page, pageSize });
    request
      .then((next) => {
        if (recordType === "batch") setBatches(next as Paged<BatchDebugSummary>);
        else if (recordType === "flow") setFlows(next as Paged<ExecutionIndex>);
        else setData(next as Paged<Execution>);
        /* Deep link with ?run= opens that snapshot once its page is loaded. */
        const runId = searchParams.get("run");
        if (runId && recordType === "single") setResult((next as Paged<Execution>).items.find((item) => item.id === runId));
      })
      .catch(() => message.error(t("reports.loadFailed")))
      .finally(() => setLoading(false));
  }, [projectId, recordType, status, source, endpointId, keyword, page, pageSize]);

  async function openBatch(batchId: string) {
    if (!projectId) return;
    try { setBatchResult(await api.batchExecution(projectId, batchId)); }
    catch { message.error(t("reports.loadFailed")); }
  }

  function openFlowRun(index: ExecutionIndex) {
    if (!projectId) return;
    void api.flowExecution(projectId, index.detailId)
      .then(setFlowRun)
      .catch(() => message.error(t("reports.loadFailed")));
  }

  function openResult(run: Execution) {
    setResult(run);
    setSearchParams((current) => { current.set("run", run.id); return current; }, { replace: true });
  }

  function closeResult() {
    setResult(undefined);
    setSearchParams((current) => { current.delete("run"); return current; }, { replace: true });
  }

  const total = recordType === "batch" ? batches.total : recordType === "flow" ? flows.total : data.total;
  const visible = recordType === "batch" ? batches.items : recordType === "flow" ? flows.items : data.items;

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
          { value: "flow", label: t("reports.flowRuns") },
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
      </>}
      {recordType === "flow" && <>
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
          placeholder={t("reports.searchFlow")}
          style={{ width: 180 }}
        />
      </>}
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
          {batches.items.map((batch) => <tr key={batch.id} data-clickable="" onClick={() => void openBatch(batch.id)}>
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
    </> : recordType === "flow" && flows.items.length ? <>
      <table className="grid">
        <thead><tr>
          <th>{t("reports.flowRuns")}</th>
          <th className="col-num">{t("reports.totalCount")}</th>
          <th className="col-num">{t("status.pass")}</th>
          <th className="col-num">{t("status.fail")}</th>
          <th>{t("status.time")}</th>
          <th className="col-status">{t("endpoints.status")}</th>
        </tr></thead>
        <tbody>
          {flows.items.map((run) => <tr key={run.id} data-clickable="" onClick={() => openFlowRun(run)}>
            <td>{run.targetName}</td>
            <td className="col-num mono">{run.total}</td>
            <td className="col-num mono">{run.successCount}</td>
            <td className="col-num mono">{run.failedCount}</td>
            <td className="mono muted">{new Date(run.createdAt).toLocaleString()}</td>
            <td className="col-status"><RunStatusTag status={toRunStatus(run.status)} /></td>
          </tr>)}
        </tbody>
      </table>
      <div className="pager"><Pagination current={flows.page} pageSize={flows.pageSize} total={flows.total} pageSizeOptions={PAGE_SIZES} showSizeChanger onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }} /></div>
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
              </> : run.endpointName}
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
      title={recordType === "single" && (status !== "all" || source !== "all" || endpointId) ? t("reports.emptyFilterTitle") : t("reports.emptyTitle")}
      hint={recordType === "single" && (status !== "all" || source !== "all" || endpointId) ? t("reports.emptyFilterHint") : t("reports.emptyHint")}
    />}

    <ExecutionSnapshot result={result} onClose={closeResult} />
    <Drawer title={t("endpoints.batchResult")} open={Boolean(batchResult)} onClose={() => setBatchResult(undefined)} width={720} extra={batchResult && <span className="mono muted">{t("endpoints.batchSummary", { total: batchResult.total, success: batchResult.successCount, failed: batchResult.failedCount })}</span>}>
      {batchResult && <BatchResultList batch={batchResult} />}
    </Drawer>
    <FlowRunDrawer projectId={projectId!} run={flowRun} onClose={() => setFlowRun(undefined)} />
  </main>;
}
