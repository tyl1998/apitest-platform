import { useEffect, useState } from "react";
import { Modal, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CopyPlus, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, noRunnerLabel, type FlowSummary, type FlowUsage } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useExecutionStream } from "../hooks/useExecutionStream";
import { useCanWrite } from "../hooks/useMyRole";
import { useProjectStore } from "../stores/projectStore";
import { Empty, toRunStatus } from "../ui";
import { IconButton } from "./IconButton";
import { RunStatusTag } from "./RunStatusTag";

/**
 * 流程列表 (P1-2).
 *
 * A flow is a chain of endpoint calls that pass values to each other, so the
 * list answers two questions: how many steps it has, and how its last run went.
 * Everything else — what those steps are — belongs on the canvas.
 */

/** 与执行记录页同一套分页档位（边界 14）。 */
const PAGE_SIZES = [20, 50, 100];

export function FlowList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projectId: loadedProjectId, environments, loading: projectLoading } = useProjectStore();
  /* viewer：新建/运行/复制/编辑/删除入口全藏（P6-4），行点击进画布仍可用。 */
  const canWrite = useCanWrite();

  const [keyword, setKeyword] = useState(searchParams.get("keyword") ?? "");
  const debouncedKeyword = useDebounced(keyword);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [environmentId, setEnvironmentId] = useState<string>("none");
  const [saving, setSaving] = useState(false);

  /* Flow runs are queued and executed by a worker, exactly like a debug send. */
  const stream = useExecutionStream(projectId);

  async function load() {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    setLoading(true);
    try {
      /* 列表页走服务端分页（成员选择器仍用全量 `flows`，两者互不影响）。 */
      const result = await api.flowsPaged(projectId, { keyword: debouncedKeyword, page, pageSize });
      /* 删掉本页最后一行后自动退一页，而不是停在一张空表上。 */
      if (!result.items.length && result.total > 0 && page > 1) { setPage(page - 1); return; }
      setFlows(result.items);
      setTotal(result.total);
    }
    catch { message.error(t("flows.loadFailed")); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    setSearchParams(debouncedKeyword ? { keyword: debouncedKeyword } : {}, { replace: true });
    void load();
  }, [projectId, loadedProjectId, projectLoading, debouncedKeyword, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 筛选变化回到第一页：旧页码对新结果集来说多半是越界的（与接口列表同一模式）。 */
  useEffect(() => { if (page !== 1) setPage(1); }, [debouncedKeyword]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Live progress for a run started from this list.
   *
   * Only the terminal event triggers a reload: a 20-node flow emits progress
   * per step, and re-reading the whole list each time would be 20 round trips
   * to update one row's status chip.
   */
  useEffect(() => {
    stream.onEvent((event) => {
      if (event.kind !== "flow") return;
      setFlows((current) => current.map((flow) => (flow.lastRun?.id === event.flowExecutionId
        ? { ...flow, lastRun: { ...flow.lastRun, status: event.status, successCount: event.successCount, failedCount: event.failedCount, skippedCount: event.skippedCount } }
        : flow)));
      if (event.status === "queued" || event.status === "running") return;
      setRunning((current) => (current && flows.some((flow) => flow.id === current) ? undefined : current));
      void load();
    });
    return () => stream.onEvent(undefined);
  }, [stream, projectId, flows]);

  async function create() {
    if (!projectId || !name.trim()) return;
    setSaving(true);
    try {
      const flow = await api.createFlow(projectId, {
        name: name.trim(),
        environmentId: environmentId === "none" ? null : environmentId,
        nodes: [], edges: [], variables: {},
      });
      setCreating(false);
      setName("");
      /* Straight into the canvas: an empty flow has nothing to show in a list. */
      navigate(`/projects/${projectId}/flows/${flow.id}`);
    } catch { message.error(t("flows.saveFailed")); }
    finally { setSaving(false); }
  }

  async function run(flow: FlowSummary) {
    if (!projectId) return;
    if (!flow.nodeCount) { message.warning(t("flows.needsNode")); return; }
    setRunning(flow.id);
    try {
      const queued = await api.executeFlow(projectId, flow.id);
      setFlows((current) => current.map((item) => (item.id === flow.id ? { ...item, lastRun: queued } : item)));
    } catch (error) {
      /* 2004 = 这个分区没有在线执行器（P2-8 边界 5），与「队列挂了」分开报。 */
      const label = noRunnerLabel(error);
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(label !== undefined ? t("run.noRunner", { label })
        : detail?.includes("queue unavailable") ? t("run.queueUnavailable") : t("flows.runFailed"));
      setRunning(undefined);
    }
  }

  async function duplicate(flow: FlowSummary) {
    if (!projectId) return;
    try {
      /* Read the full flow first: the list carries a node count, not the nodes. */
      const full = await api.flow(projectId, flow.id);
      await api.createFlow(projectId, {
        name: `${full.name} ${t("flows.copySuffix")}`,
        description: full.description,
        environmentId: full.environmentId ?? null,
        /* Script references are dropped rather than shared: an anonymous script
           belongs to one flow, so the copy re-creates its own on first save. */
        nodes: full.nodes, edges: full.edges, variables: full.variables, tags: full.tags,
      });
      await load();
      message.success(t("flows.duplicated"));
    } catch { message.error(t("flows.duplicateFailed")); }
  }

  /**
   * 删除前先扫描引用（P2-4.5）。
   *
   * 扫描失败就**不删**：一个「查不到有没有人引用」的答案不能当成「没人引用」。有引用时
   * 对话框列出清单并把主按钮换成「仍然删除」——引用清单先给人看过，force 才是一个有依据
   * 的决定，而不是把 409 当成需要重试一次的错误。
   */
  async function remove(flow: FlowSummary) {
    if (!projectId) return;
    let usage: FlowUsage;
    try { usage = await api.flowUsage(projectId, flow.id); }
    catch { message.error(t("flows.usageFailed")); return; }

    const references = [
      ...usage.suites.map((suite) => t("flows.usageSuite", { name: suite.name })),
      ...usage.flows.map((parent) => t("flows.usageFlow", { name: parent.name })),
    ];
    const history = usage.executionCount > 0 ? t("flows.deleteHistoryNote", { count: usage.executionCount }) : undefined;

    Modal.confirm({
      title: usage.blocked ? t("flows.deleteBlockedTitle", { name: flow.name }) : t("flows.deleteTitle", { name: flow.name }),
      content: <div>
        <p>{usage.blocked ? t("flows.deleteBlockedHint") : t("flows.deleteHint")}</p>
        {references.length > 0 && <ul className="usage-list">{references.map((line, index) => <li key={`${line}:${index}`}>{line}</li>)}</ul>}
        {history && <p className="form-note">{history}</p>}
      </div>,
      okText: usage.blocked ? t("action.deleteAnyway") : t("action.delete"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          const deleted = await api.deleteFlow(projectId, flow.id, usage.blocked);
          await load();
          /* 摘掉的套件成员要说出来：它是这次删除的连带改动，不写出来用户下次打开套件
             才会发现成员少了一个。 */
          message.success(deleted.detachedSuites.length
            ? t("flows.deletedDetached", { count: deleted.detachedSuites.length })
            : t("flows.deleted"));
        }
        catch { message.error(t("flows.deleteFailed")); }
      },
    });
  }

  return <main className="content">
    <div className="page-head">
      <div><h1>{t("flows.title")}</h1><p>{t("flows.hint")}</p></div>
      <div className="topbar-actions">
        {canWrite && <button className="btn btn-primary btn-with-icon" onClick={() => setCreating(true)}>
          <Plus size={15} />{t("action.createFlow")}
        </button>}
      </div>
    </div>

    <div className="filter-bar">
      <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("flows.searchPlaceholder")} />
    </div>

    {loading && <p className="muted">{t("filter.searching")}</p>}

    {flows.length ? <table className="grid flow-grid">
      <colgroup>
        <col />
        <col className="flow-col-steps" />
        <col className="flow-col-env" />
        <col className="flow-col-result" />
        <col className="col-actions" />
      </colgroup>
      <thead><tr>
        <th>{t("flows.name")}</th>
        <th className="col-num">{t("flows.steps")}</th>
        <th>{t("flows.environment")}</th>
        <th className="col-status">{t("flows.lastRun")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {flows.map((flow) => {
          const last = flow.lastRun;
          const busy = running === flow.id || last?.status === "queued" || last?.status === "running";
          return <tr key={flow.id} data-clickable="" onClick={() => navigate(`/projects/${projectId}/flows/${flow.id}`)}>
            <td>
              <div className="cell-name">
                <span className="truncate">{flow.name}</span>
                {flow.tags.length > 0 && <span className="tag-inline">{flow.tags.slice(0, 2).map((tag) => <span className="chip" key={tag}>{tag}</span>)}</span>}
              </div>
            </td>
            <td className="col-num mono">{flow.nodeCount || <span className="muted">—</span>}</td>
            <td className="mono muted truncate">{flow.environmentName ?? t("flows.noEnvironment")}</td>
            <td className="col-status">
              {busy
                ? <RunStatusTag status={last?.status === "running" ? "running" : "queued"} />
                : last
                  ? <span className="flow-result">
                      <RunStatusTag status={toRunStatus(last.status)} />
                      <span className="mono muted">{t("flows.stepSummary", { success: last.successCount, total: last.total })}</span>
                    </span>
                  : <span className="muted">{t("status.notRun")}</span>}
            </td>
            <td className="col-actions" onClick={(event) => event.stopPropagation()}>
              {canWrite && <div className="row-actions">
                <IconButton icon={<Play size={14} />} label={t("action.run")} disabled={busy} onClick={() => void run(flow)} />
                <IconButton icon={<CopyPlus size={14} />} label={t("action.duplicate")} onClick={() => void duplicate(flow)} />
                <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => navigate(`/projects/${projectId}/flows/${flow.id}`)} />
                <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => void remove(flow)} />
              </div>}
            </td>
          </tr>;
        })}
      </tbody>
    </table> : !loading && <Empty
      title={debouncedKeyword ? t("flows.emptySearchTitle") : t("flows.emptyTitle")}
      hint={debouncedKeyword ? t("flows.emptySearchHint") : t("flows.emptyHint")}
      action={debouncedKeyword || !canWrite ? undefined : <button className="btn btn-primary" onClick={() => setCreating(true)}>{t("action.createFlow")}</button>}
    />}

    {flows.length > 0 && <div className="pager">
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

    <Modal
      title={t("flows.createTitle")}
      open={creating}
      onCancel={() => setCreating(false)}
      onOk={() => void create()}
      okText={t("action.create")}
      cancelText={t("action.cancel")}
      confirmLoading={saving}
      okButtonProps={{ disabled: !name.trim() }}
    >
      <label className="field">
        <span>{t("flows.name")}</span>
        <input className="input" value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder={t("flows.namePlaceholder")} />
      </label>
      <label className="field">
        <span>{t("flows.environment")}</span>
        <Select
          value={environmentId}
          onChange={setEnvironmentId}
          options={[{ value: "none", label: t("flows.noEnvironment") }, ...environments.map((item) => ({ value: item.id, label: item.name }))]}
          style={{ width: "100%" }}
        />
      </label>
      {/* One environment for the whole flow: a chain that switched environments
          halfway has no answer for whether the token it just got still works. */}
      <p className="form-note">{t("flows.environmentHint")}</p>
    </Modal>
  </main>;
}
