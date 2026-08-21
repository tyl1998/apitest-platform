import { useEffect, useMemo, useRef, useState } from "react";
import { Drawer, Form, Input, Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Download, CopyPlus, ListChecks, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { api, type BatchDebugResult, type Endpoint, type Execution } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useExecutionStream } from "../hooks/useExecutionStream";
import { useProjectStore } from "../stores/projectStore";
import { Empty, Method, RunStrip, toRunStatus, type RunStatus } from "../ui";
import { BatchResultList } from "./BatchResultList";
import { ExecutionSnapshot } from "./ExecutionSnapshot";
import { IconButton } from "./IconButton";
import { RunStatusTag } from "./RunStatusTag";
import { hasUnsupportedShell, parseCurl, parseOpenApi } from "../lib/importers";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function EndpointList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  /* The workspace switcher reads the store, so a copy has to land there too. */
  const { projectId: loadedProjectId, environments, loading: projectLoading, reloadEndpoints } = useProjectStore();

  const [keyword, setKeyword] = useState(searchParams.get("keyword") ?? "");
  const [method, setMethod] = useState(searchParams.get("method") ?? "all");
  const [environmentFilter, setEnvironmentFilter] = useState(searchParams.get("environmentId") ?? "all");
  const debouncedKeyword = useDebounced(keyword);

  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [recent, setRecent] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<string>();
  const [duplicating, setDuplicating] = useState<string>();
  const [result, setResult] = useState<Execution>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchEnvironment, setBatchEnvironment] = useState("endpoint_default");
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchDebugResult>();
  const [batchResultOpen, setBatchResultOpen] = useState(false);
  const [batchCanceling, setBatchCanceling] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importForm] = Form.useForm();
  const previousProjectId = useRef(projectId);

  /* Runs are queued and executed by a worker (P1-3); progress arrives here. */
  const stream = useExecutionStream(projectId);

  useEffect(() => {
    if (previousProjectId.current !== projectId) {
      previousProjectId.current = projectId;
      setEnvironmentFilter("all");
      setSelected(new Set());
      /* The result belongs to the project that produced it. */
      setBatchResult(undefined);
      setBatchResultOpen(false);
    }
  }, [projectId]);

  useEffect(() => { setSelected(new Set()); }, [debouncedKeyword, method, environmentFilter]);

  async function load() {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    setLoading(true);
    try {
      const [list, runs] = await Promise.all([
        api.endpoints(projectId, { keyword: debouncedKeyword, method, environmentId: environmentFilter }),
        /* Enough recent runs to draw the history strip, not the full archive. */
        api.executions(projectId, { pageSize: 200 }),
      ]);
      setEndpoints(list);
      setRecent(runs.items);
    } catch { message.error(t("endpoints.loadFailed")); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    setSearchParams({ ...(debouncedKeyword ? { keyword: debouncedKeyword } : {}), ...(method !== "all" ? { method } : {}), ...(environmentFilter !== "all" ? { environmentId: environmentFilter } : {}) }, { replace: true });
    void load();
  }, [projectId, loadedProjectId, projectLoading, debouncedKeyword, method, environmentFilter]);

  const runsByEndpoint = useMemo(() => {
    const map = new Map<string, Execution[]>();
    for (const run of recent) map.set(run.endpointId, [...(map.get(run.endpointId) ?? []), run]);
    return map;
  }, [recent]);

  async function execute(endpoint: Endpoint) {
    if (!projectId) return;
    setRunning(endpoint.id);
    try {
      /* The POST only queues the run; the result arrives on the stream. */
      const queued = await api.execute(projectId, endpoint.id);
      setResult(await stream.awaitRun(queued.id));
      await load();
    }
    catch (error) {
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(detail?.includes("queue unavailable") ? t("run.queueUnavailable") : t("endpoints.runFailed"));
    }
    finally { setRunning(undefined); }
  }

  function toggleSelected(endpointId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(endpointId); else next.delete(endpointId);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(endpoints.map((endpoint) => endpoint.id)) : new Set());
  }

  /**
   * Queues the batch and follows it (P1-3).
   *
   * The request returns as soon as every run is queued, so the drawer opens on
   * a batch that is still filling in — previously this call sat open for as
   * long as the whole batch took.
   */
  async function runBatch() {
    if (!projectId || !selected.size) return;
    setBatchRunning(true);
    try {
      const strategy = batchEnvironment === "endpoint_default" ? "endpoint_default" : "override";
      const environmentId = batchEnvironment === "none" ? null : batchEnvironment;
      const summary = await api.batchDebug(projectId, [...selected], strategy, environmentId);
      setBatchResult({ ...summary, items: [] });
      setBatchResultOpen(true);
      setBatchOpen(false);
      setSelected(new Set());
    } catch (error) {
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(detail?.includes("queue unavailable") ? t("run.queueUnavailable") : t("endpoints.batchFailed"));
    }
    finally { setBatchRunning(false); }
  }

  /**
   * Live batch progress.
   *
   * Counts come straight off the event, and the item list is fetched only once
   * the batch settles. Re-reading the detail per completed item would pull
   * every response body in the batch down the wire on every tick.
   */
  useEffect(() => {
    stream.onEvent((event) => {
      if (event.kind !== "batch") return;
      setBatchResult((current) => {
        if (!current || current.id !== event.batchId) return current;
        return { ...current, status: event.status, successCount: event.successCount, failedCount: event.failedCount, canceledCount: event.canceledCount };
      });
      if (event.status !== "completed" && event.status !== "canceled") return;
      void (async () => {
        if (!projectId) return;
        try {
          const full = await api.batchExecution(projectId, event.batchId);
          setBatchResult((current) => (current?.id === full.id ? full : current));
        } catch { /* the drawer keeps the counts it already has */ }
        await load();
      })();
    });
    return () => stream.onEvent(undefined);
  }, [stream, projectId]);

  /** Stops whatever of the batch has not started yet. */
  async function stopBatch() {
    if (!projectId || !batchResult) return;
    setBatchCanceling(true);
    try {
      const outcome = await api.cancelBatch(projectId, batchResult.id);
      message.success(t("run.batchCanceled", { count: outcome.canceled }));
    } catch { message.error(t("run.cancelFailed")); }
    finally { setBatchCanceling(false); }
  }

  function batchDelete() {
    if (!projectId || !selected.size) return;
    Modal.confirm({
      title: t("endpoints.batchDeleteTitle", { count: selected.size }),
      content: t("endpoints.batchDeleteHint"),
      okText: t("endpoints.batchDelete"),
      cancelText: t("action.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setBatchDeleting(true);
        try {
          const outcome = await api.batchDeleteEndpoints(projectId, [...selected]);
          setSelected(new Set());
          await load();
          await reloadEndpoints();
          message.success(t("endpoints.batchDeleted", { count: outcome.deleted }));
        } catch { message.error(t("endpoints.batchDeleteFailed")); }
        finally { setBatchDeleting(false); }
      },
    });
  }

  function remove(endpoint: Endpoint) {
    Modal.confirm({
      title: t("endpoints.deleteTitle", { name: endpoint.name }),
      content: t("endpoints.deleteHint"),
      okText: t("action.delete"),
      cancelText: t("action.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => { await api.deleteEndpoint(projectId!, endpoint.id); await load(); message.success(t("endpoints.deleted")); },
    });
  }

  /**
   * Copies an endpoint in place. The list stays put rather than opening the
   * copy, because duplicating is usually the first of several copies.
   */
  async function duplicate(endpoint: Endpoint) {
    if (!projectId) return;
    setDuplicating(endpoint.id);
    try {
      const copy = await api.duplicateEndpoint(projectId, endpoint.id, `${endpoint.name} ${t("endpoints.copySuffix")}`);
      await load();
      await reloadEndpoints();
      message.success(t("endpoints.duplicated", { name: copy.name }));
    } catch { message.error(t("endpoints.duplicateFailed")); }
    finally { setDuplicating(undefined); }
  }

  async function runImport() {
    if (!projectId) return;
    const values = await importForm.validateFields();
    const source: string = values.source.trim();
    let items;
    try { items = values.format === "curl" ? parseCurl(source) : parseOpenApi(source); }
    catch { message.error(t("import.parseFailed")); return; }
    if (!items.length) { message.error(t("import.nothingFound")); return; }
    if (values.format === "curl" && hasUnsupportedShell(source)) message.warning(t("import.shellWarning"));

    const outcome = await api.importEndpoints(projectId, items, values.strategy);
    message.success(t("import.done", { created: outcome.imported.length, updated: outcome.updated.length, skipped: outcome.skipped.length }));
    importForm.resetFields();
    setImportOpen(false);
    await load();
  }

  const filtering = Boolean(debouncedKeyword) || method !== "all" || environmentFilter !== "all";

  return <main className="content">
    <div className="page-head">
      <div><h1>{t("endpoints.title")}</h1><p>{t("endpoints.hint")}</p></div>
      {/* Page-level primary actions keep their wording; icon-only is for
          repeated per-row actions where the column header supplies context. */}
      <div className="topbar-actions">
        <button className="btn btn-with-icon" onClick={() => setImportOpen(true)}>
          <Download size={14} />{t("action.import")}
        </button>
        <button className="btn btn-primary btn-with-icon" onClick={() => navigate(`/projects/${projectId}/endpoints/new`)}>
          <Plus size={15} />{t("action.createEndpoint")}
        </button>
      </div>
    </div>

    <div className="filter-bar">
      <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("endpoints.searchPlaceholder")} />
      <Select
        value={method}
        onChange={setMethod}
        options={[{ value: "all", label: t("endpoints.allMethods") }, ...METHODS.map((value) => ({ value, label: value }))]}
        style={{ width: 124 }}
      />
      <Select
        value={environmentFilter}
        onChange={setEnvironmentFilter}
        options={[
          { value: "all", label: t("endpoints.allEnvironments") },
          { value: "unset", label: t("endpoints.unsetEnvironment") },
          ...environments.map((environment) => ({ value: environment.id, label: environment.name })),
        ]}
        style={{ width: 148 }}
      />
      <span className="filter-spacer" />
      {/* The batch result outlives its drawer, so closing it is not losing it. */}
      {batchResult && <button className="btn btn-with-icon" onClick={() => setBatchResultOpen(true)}>
        <ListChecks size={14} />{t("endpoints.lastBatchResult", { total: batchResult.total, failed: batchResult.failedCount })}
      </button>}
    </div>

    {selected.size > 0 && <div className="bulk-bar">
      <strong>{t("endpoints.selectedCount", { count: selected.size })}</strong>
      <button className="btn btn-primary btn-with-icon" disabled={batchRunning} onClick={() => setBatchOpen(true)}>
        <Play size={14} />{t("endpoints.batchDebug")}
      </button>
      <button className="btn btn-with-icon bulk-delete" disabled={batchRunning || batchDeleting} onClick={batchDelete}>
        <Trash2 size={14} />{batchDeleting ? t("action.deleting") : t("endpoints.batchDelete")}
      </button>
      <button className="btn btn-icon" title={t("action.cancel")} onClick={() => setSelected(new Set())}><X size={15} /></button>
    </div>}

    {loading && <p className="muted">{t("filter.searching")}</p>}

    {endpoints.length ? <table className="grid endpoint-grid">
      <thead><tr>
        <th className="col-select"><input type="checkbox" aria-label={t("endpoints.selectAll")} checked={endpoints.length > 0 && selected.size === endpoints.length} onChange={(event) => toggleAll(event.target.checked)} /></th>
        <th>{t("endpoints.name")}</th>
        <th className="col-path">{t("endpoints.path")}</th>
        <th className="col-num col-cases">{t("endpoints.cases")}</th>
        <th className="col-num">{t("endpoints.duration")}</th>
        <th className="col-history">{t("endpoints.recentRuns")}</th>
        <th className="col-status">{t("endpoints.status")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {endpoints.map((endpoint) => {
          const runs = runsByEndpoint.get(endpoint.id) ?? [];
          const latest = runs[0];
          const status: RunStatus | undefined = running === endpoint.id || (batchRunning && selected.has(endpoint.id)) ? "running" : latest ? toRunStatus(latest.status) : undefined;
          return <tr key={endpoint.id} data-clickable="" className={selected.has(endpoint.id) ? "is-selected" : undefined} onClick={() => navigate(`/projects/${projectId}/endpoints/${endpoint.id}`)}>
            <td className="col-select" onClick={(event) => event.stopPropagation()}>
              <input type="checkbox" aria-label={t("endpoints.selectEndpoint", { name: endpoint.name })} checked={selected.has(endpoint.id)} disabled={batchRunning} onChange={(event) => toggleSelected(endpoint.id, event.target.checked)} />
            </td>
            <td>
              <div className="cell-name">
                <Method method={endpoint.method} />
                <span className="truncate">{endpoint.name}</span>
                {/* Tags share the row instead of wrapping, so row heights stay uniform */}
                {endpoint.tags.length > 0 && <span className="tag-inline">{endpoint.tags.slice(0, 2).map((tag) => <span className="chip" key={tag}>{tag}</span>)}{endpoint.tags.length > 2 && <span className="chip">+{endpoint.tags.length - 2}</span>}</span>}
              </div>
            </td>
            <td className="col-path mono truncate">{endpoint.url}</td>
            {/* Clicking the count opens the workbench with the用例 box selected. */}
            <td className="col-num col-cases mono" onClick={(event) => event.stopPropagation()}>
              {endpoint.caseCount === undefined || endpoint.caseCount === null
                ? <span className="muted">—</span>
                : <button className="cell-link mono" onClick={() => navigate(`/projects/${projectId}/endpoints/${endpoint.id}?side=cases`)}>{endpoint.caseCount}</button>}
            </td>
            <td className="col-num mono">{latest ? <>{latest.durationMs}<span className="unit">ms</span></> : <span className="muted">—</span>}</td>
            <td className="col-history">
              <span
                className="runstrip-hit"
                role={latest ? "button" : undefined}
                onClick={(event) => { event.stopPropagation(); if (latest) setResult(latest); }}
              >
                <RunStrip history={runs.slice(0, 10).reverse().map((run) => toRunStatus(run.status))} />
              </span>
            </td>
            <td className="col-status">{status ? <RunStatusTag status={status} /> : <span className="muted">{t("status.notRun")}</span>}</td>
            <td className="col-actions" onClick={(event) => event.stopPropagation()}>
              <div className="row-actions">
                <IconButton icon={<Play size={14} />} label={t("action.run")} disabled={Boolean(running) || batchRunning} onClick={() => void execute(endpoint)} />
                <IconButton icon={<CopyPlus size={14} />} label={t("action.duplicate")} disabled={duplicating === endpoint.id} onClick={() => void duplicate(endpoint)} />
                <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => navigate(`/projects/${projectId}/endpoints/${endpoint.id}`)} />
                <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => remove(endpoint)} />
              </div>
            </td>
          </tr>;
        })}
      </tbody>
    </table> : !loading && <Empty
      title={filtering ? t("endpoints.emptySearchTitle") : t("endpoints.emptyTitle")}
      hint={filtering ? t("endpoints.emptySearchHint") : t("endpoints.emptyHint")}
      action={filtering ? undefined : <button className="btn btn-primary" onClick={() => navigate(`/projects/${projectId}/endpoints/new`)}>{t("action.createEndpoint")}</button>}
    />}

    <Modal
      title={t("endpoints.batchDebugTitle", { count: selected.size })}
      open={batchOpen}
      onCancel={() => setBatchOpen(false)}
      onOk={() => void runBatch()}
      okText={batchRunning ? t("action.running") : t("endpoints.batchDebug")}
      cancelText={t("action.cancel")}
      confirmLoading={batchRunning}
    >
      <p className="form-note">{t("endpoints.batchDebugHint")}</p>
      <label className="field">
        <span>{t("endpoints.batchEnvironment")}</span>
        <Select
          value={batchEnvironment}
          onChange={setBatchEnvironment}
          options={[
            { value: "endpoint_default", label: t("endpoints.eachDefaultEnvironment") },
            { value: "none", label: t("endpoints.noEnvironment") },
            ...environments.map((environment) => ({ value: environment.id, label: t("endpoints.overrideEnvironment", { name: environment.name }) })),
          ]}
          style={{ width: "100%" }}
        />
      </label>
    </Modal>

    <Drawer
      title={t("endpoints.batchResult")}
      width={720}
      open={batchResultOpen}
      onClose={() => setBatchResultOpen(false)}
      extra={batchResult && <span className="mono muted">{t("endpoints.batchSummary", { total: batchResult.total, success: batchResult.successCount, failed: batchResult.failedCount })}</span>}
    >
      {batchResult && <>
        {/* While the batch is still being worked through, the item list is not
            fetched yet (see the progress effect), so the drawer reports counts
            and offers to stop the rest. */}
        {(batchResult.status === "queued" || batchResult.status === "running") && <div className="batch-progress">
          <RunStatusTag status={batchResult.status === "queued" ? "queued" : "running"} />
          <span className="mono muted">
            {t("run.batchProgress", { settled: batchResult.successCount + batchResult.failedCount + batchResult.canceledCount, total: batchResult.total })}
          </span>
          <button className="btn btn-small" disabled={batchCanceling} onClick={() => void stopBatch()}>{t("run.cancelBatch")}</button>
        </div>}
        <BatchResultList batch={batchResult} />
      </>}
    </Drawer>

    <Modal
      title={t("import.title")}
      open={importOpen}
      onCancel={() => setImportOpen(false)}
      onOk={() => void runImport()}
      okText={t("action.import")}
      cancelText={t("action.cancel")}
      width={640}
    >
      <Form form={importForm} layout="vertical" initialValues={{ strategy: "skip", format: "openapi" }}>
        <Form.Item name="format" label={t("import.format")}>
          <Select options={[{ value: "openapi", label: t("import.openapi") }, { value: "curl", label: t("import.curl") }]} />
        </Form.Item>
        <Form.Item name="source" label={t("import.source")} rules={[{ required: true, message: t("import.sourceRequired") }]}>
          <Input.TextArea rows={12} className="mono" />
        </Form.Item>
        <Form.Item name="strategy" label={t("import.strategy")} extra={t("import.strategyHint")}>
          <Select options={[
            { value: "skip", label: t("import.skip") },
            { value: "update", label: t("import.update") },
            { value: "create", label: t("import.createAlways") },
          ]} />
        </Form.Item>
      </Form>
    </Modal>

    <ExecutionSnapshot
      result={result}
      onClose={() => setResult(undefined)}
      onRerun={() => { const endpoint = endpoints.find((item) => item.id === result?.endpointId); if (endpoint) void execute(endpoint); }}
      busy={Boolean(running)}
    />
  </main>;
}
