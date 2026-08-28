import { useEffect, useState } from "react";
import { Modal, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, noRunnerLabel, type SuiteSelection, type SuiteSummary } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useExecutionStream } from "../hooks/useExecutionStream";
import { useProjectStore } from "../stores/projectStore";
import { Empty, toRunStatus } from "../ui";
import { IconButton } from "./IconButton";
import { RunStatusTag } from "./RunStatusTag";
import { SuiteRunModal } from "./SuiteRunModal";

/**
 * 测试套件列表 (P2-4)。
 *
 * 一个套件回答两件事：它会跑哪些成员，上次跑得怎么样。成员**怎么选**是列表能显示
 * 的全部——真实成员数要解析（标签/全部是动态的），那属于配置页的预览。
 *
 * 列表里能直接运行，但**不在列表里看成员进度**：成员级证据属于配置页的运行抽屉，
 * 这里只把最近一次结果换成实时状态。
 */

/** 列表只显示选择方式本身，不为每一行去解析动态成员（那要两条查询换一个数字）。 */
function selectionSummary(selection: SuiteSelection, t: (key: string, vars?: Record<string, unknown>) => string) {
  if (selection.type === "manual") return t("suites.summaryManual", { count: selection.members.length });
  if (selection.type === "tag") return t("suites.summaryTag", { tags: selection.tags.join(", ") });
  return t("suites.summaryAll");
}

/** 与执行记录页同一套分页档位（边界 14）。 */
const PAGE_SIZES = [20, 50, 100];

export function SuiteList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();

  const [keyword, setKeyword] = useState(searchParams.get("keyword") ?? "");
  const debouncedKeyword = useDebounced(keyword);
  const [suites, setSuites] = useState<SuiteSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [selectionType, setSelectionType] = useState<SuiteSelection["type"]>("manual");
  const [saving, setSaving] = useState(false);
  /** 运行请求还在路上的那个套件。入队成功之后由 lastRun.status 接手。 */
  const [running, setRunning] = useState<string>();
  /* 运行确认弹窗（变量覆盖）：与配置页同一个组件；点「运行」先确认参数再入队。 */
  const [runModalOpen, setRunModalOpen] = useState<SuiteSummary>();
  const stream = useExecutionStream(projectId);

  async function load() {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    setLoading(true);
    try {
      const result = await api.testSuites(projectId, { keyword: debouncedKeyword, page, pageSize });
      setSuites(result.items);
      setTotal(result.total);
    }
    catch { message.error(t("suites.loadFailed")); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    setSearchParams(debouncedKeyword ? { keyword: debouncedKeyword } : {}, { replace: true });
    void load();
  }, [projectId, loadedProjectId, projectLoading, debouncedKeyword, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 计数就地更新，终态再整表重取：一行的状态列不需要等一次列表请求才动起来。
     依赖带上筛选与页码，让 onEvent 里那份 load 闭包拿到的是当前页——否则一次运行
     终态会把列表刷回第一页。 */
  useEffect(() => {
    stream.onEvent((event) => {
      if (event.kind !== "suite") return;
      setSuites((current) => current.map((suite) => (suite.lastRun?.id === event.suiteExecutionId
        ? { ...suite, lastRun: { ...suite.lastRun, status: event.status, successCount: event.successCount, failedCount: event.failedCount, skippedCount: event.skippedCount } }
        : suite)));
      if (event.status === "queued" || event.status === "running") return;
      void load();
    });
    return () => stream.onEvent(undefined);
  }, [stream, projectId, debouncedKeyword, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 列表里直接运行的是**已保存的那份配置**，变量覆盖随这次运行入队（与配置页同一弹窗、
   * 同一 API——列表上没有草稿这个概念，但触发入参两边该一样）。
   *
   * 成员数在这里是问不出来的（标签/全部要解析），所以「成员为空」这一类拒绝交给服务端，
   * 界面只把它的话转述出来——本地再猜一次会与服务端的判断分叉。
   */
  async function run(suite: SuiteSummary, variables: Record<string, string>) {
    if (!projectId) return;
    setRunning(suite.id);
    try {
      const queued = await api.executeSuite(projectId, suite.id, undefined, variables);
      /* 换成刚入队的那次执行：状态列从此由它的 status 说，`running` 只盖住请求在路上
         这一小段——否则一次没能发出终态事件的运行会让按钮永远停在禁用上。 */
      setSuites((current) => current.map((item) => (item.id === suite.id ? { ...item, lastRun: queued } : item)));
    } catch (error) {
      /* 2004 = 这个分区没有在线执行器（P2-8 边界 5）。「成员跨分区」是 400 并带具体文案，
         走 detail 分支——那是配置问题，用户要改的是套件而不是去起 worker。 */
      const label = noRunnerLabel(error);
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(label !== undefined ? t("run.noRunner", { label })
        : detail?.includes("queue unavailable") ? t("run.queueUnavailable") : detail ?? t("suites.runFailed"));
    } finally { setRunning(undefined); }
  }

  async function create() {
    if (!projectId || !name.trim()) return;
    setSaving(true);
    try {
      /* 新建时就定下选择方式：手动从空成员起步，标签/全部先给一个能跑的默认范围
         （用例 + 流程都包含），进配置页再收窄。 */
      const selection: SuiteSelection = selectionType === "manual"
        ? { type: "manual", members: [] }
        : selectionType === "tag"
          ? { type: "tag", tags: [], match: "any", includeCases: true, includeFlows: true }
          : { type: "all", includeCases: true, includeFlows: true };
      const suite = await api.createTestSuite(projectId, { name: name.trim(), selection });
      setCreating(false);
      setName("");
      /* 直接进配置页：一个还没有成员的套件在列表里没什么可看的。 */
      navigate(`/projects/${projectId}/suites/${suite.id}`);
    } catch (error) {
      message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("suites.saveFailed"));
    } finally { setSaving(false); }
  }

  function remove(suite: SuiteSummary) {
    Modal.confirm({
      title: t("suites.deleteTitle", { name: suite.name }),
      content: t("suites.deleteHint"),
      okText: t("action.delete"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.deleteTestSuite(projectId!, suite.id);
          /* 删掉的是本页最后一行且不是第一页：先退一页再加载，否则停在一张空页上。 */
          if (suites.length === 1 && page > 1) setPage(page - 1);
          else await load();
          message.success(t("suites.deleted"));
        }
        catch { message.error(t("suites.deleteFailed")); }
      },
    });
  }

  return <main className="content">
    <div className="page-head">
      <div><h1>{t("suites.title")}</h1><p>{t("suites.hint")}</p></div>
      <div className="topbar-actions">
        <button className="btn btn-primary btn-with-icon" onClick={() => setCreating(true)}>
          <Plus size={15} />{t("suites.createTitle")}
        </button>
      </div>
    </div>

    <div className="filter-bar">
      <input className="input" value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }} placeholder={t("suites.searchPlaceholder")} />
    </div>

    {loading && <p className="muted">{t("filter.searching")}</p>}

    {suites.length ? <table className="grid suite-grid">
      <colgroup>
        <col />
        <col className="suite-col-selection" />
        <col className="suite-col-result" />
        <col className="col-actions" />
      </colgroup>
      <thead><tr>
        <th>{t("suites.name")}</th>
        <th>{t("suites.selection")}</th>
        <th className="col-status">{t("flows.lastRun")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {suites.map((suite) => {
          const last = suite.lastRun;
          const busy = running === suite.id || last?.status === "queued" || last?.status === "running";
          return <tr key={suite.id} data-clickable="" onClick={() => navigate(`/projects/${projectId}/suites/${suite.id}`)}>
            <td>
              <div className="cell-name">
                <span className="truncate">{suite.name}</span>
                {suite.tags.length > 0 && <span className="tag-inline">{suite.tags.slice(0, 2).map((tag) => <span className="chip" key={tag}>{tag}</span>)}</span>}
              </div>
            </td>
            <td className="mono muted truncate">{selectionSummary(suite.selection, t)}</td>
            <td className="col-status">
              {busy
                ? <RunStatusTag status={last?.status === "running" ? "running" : "queued"} />
                : last
                  ? <span className="flow-result">
                      <RunStatusTag status={toRunStatus(last.status)} />
                      <span className="mono muted">{t("suites.memberSummary", { success: last.successCount, total: last.total })}</span>
                    </span>
                  : <span className="muted">{t("status.notRun")}</span>}
            </td>
            <td className="col-actions" onClick={(event) => event.stopPropagation()}>
              <div className="row-actions">
                {/* 运行的是已保存的配置（变量覆盖在弹窗里确认）：列表上没有草稿这个概念。 */}
                <IconButton icon={<Play size={14} />} label={t("suites.run")} disabled={busy} onClick={() => setRunModalOpen(suite)} />
                <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => navigate(`/projects/${projectId}/suites/${suite.id}`)} />
                <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => remove(suite)} />
              </div>
            </td>
          </tr>;
        })}
      </tbody>
    </table> : !loading && <Empty
      title={debouncedKeyword ? t("suites.emptyFiltered") : t("suites.emptyTitle")}
      hint={debouncedKeyword ? t("suites.emptyFilteredHint") : t("suites.emptyHint")}
      action={debouncedKeyword ? undefined : <button className="btn btn-primary" onClick={() => setCreating(true)}>{t("suites.createTitle")}</button>}
    />}

    {/* 有内容才有分页器：空态下它只是另一个「这里什么都没有」的提示（与执行记录页同款）。 */}
    {suites.length > 0 && <div className="pager">
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
      title={t("suites.createTitle")}
      open={creating}
      onCancel={() => setCreating(false)}
      onOk={() => void create()}
      okText={t("action.create")}
      cancelText={t("action.cancel")}
      confirmLoading={saving}
      okButtonProps={{ disabled: !name.trim() }}
    >
      <label className="field">
        <span>{t("suites.name")}</span>
        <input className="input" value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder={t("suites.namePlaceholder")} />
      </label>
      <label className="field">
        <span>{t("suites.selection")}</span>
        <Select
          value={selectionType}
          onChange={setSelectionType}
          options={[
            { value: "manual", label: t("suites.selectionManual") },
            { value: "tag", label: t("suites.selectionTag") },
            { value: "all", label: t("suites.selectionAll") },
          ]}
          style={{ width: "100%" }}
        />
      </label>
      <p className="form-note">
        {selectionType === "manual" ? t("suites.selectionHintManual") : selectionType === "tag" ? t("suites.selectionHintTag") : t("suites.selectionHintAll")}
      </p>
    </Modal>

    {/* 与配置页同一个运行弹窗：弹窗标题带上套件名，说清这次要跑的是哪一行。 */}
    <SuiteRunModal
      open={Boolean(runModalOpen)}
      suiteName={runModalOpen?.name}
      running={Boolean(runModalOpen && running === runModalOpen.id)}
      onClose={() => setRunModalOpen(undefined)}
      onRun={(variables) => { const suite = runModalOpen; setRunModalOpen(undefined); if (suite) void run(suite, variables); }}
    />
  </main>;
}
