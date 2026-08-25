import { useEffect, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api, type SuiteSelection, type SuiteSummary } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useProjectStore } from "../stores/projectStore";
import { Empty, toRunStatus } from "../ui";
import { IconButton } from "./IconButton";
import { RunStatusTag } from "./RunStatusTag";

/**
 * 测试套件列表 (P2-4)。
 *
 * 一个套件回答两件事：它会跑哪些成员，上次跑得怎么样。成员**怎么选**是列表能显示
 * 的全部——真实成员数要解析（标签/全部是动态的），那属于配置页的预览。
 *
 * 运行入口随 P2-4.3 加上；本批只到定义为止。
 */

/** 列表只显示选择方式本身，不为每一行去解析动态成员（那要两条查询换一个数字）。 */
function selectionSummary(selection: SuiteSelection, t: (key: string, vars?: Record<string, unknown>) => string) {
  if (selection.type === "manual") return t("suites.summaryManual", { count: selection.members.length });
  if (selection.type === "tag") return t("suites.summaryTag", { tags: selection.tags.join(", ") });
  return t("suites.summaryAll");
}

export function SuiteList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();

  const [keyword, setKeyword] = useState(searchParams.get("keyword") ?? "");
  const debouncedKeyword = useDebounced(keyword);
  const [suites, setSuites] = useState<SuiteSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [selectionType, setSelectionType] = useState<SuiteSelection["type"]>("manual");
  const [saving, setSaving] = useState(false);

  async function load() {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    setLoading(true);
    try { setSuites(await api.testSuites(projectId, { keyword: debouncedKeyword })); }
    catch { message.error(t("suites.loadFailed")); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    setSearchParams(debouncedKeyword ? { keyword: debouncedKeyword } : {}, { replace: true });
    void load();
  }, [projectId, loadedProjectId, projectLoading, debouncedKeyword]); // eslint-disable-line react-hooks/exhaustive-deps

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
        try { await api.deleteTestSuite(projectId!, suite.id); await load(); message.success(t("suites.deleted")); }
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
      <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("suites.searchPlaceholder")} />
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
          const busy = last?.status === "queued" || last?.status === "running";
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
                      <span className="mono muted">{t("flows.stepSummary", { success: last.successCount, total: last.total })}</span>
                    </span>
                  : <span className="muted">{t("status.notRun")}</span>}
            </td>
            <td className="col-actions" onClick={(event) => event.stopPropagation()}>
              <div className="row-actions">
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
  </main>;
}
