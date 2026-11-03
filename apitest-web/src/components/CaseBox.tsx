import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { Pencil, Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type Assertion, type Environment, type Execution, type RequestSnapshot, type TestCase, type TestCaseInput } from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import { AssertionEditor, defaultAssertions } from "./AssertionEditor";
import { IconButton } from "./IconButton";
import { OwnerCell } from "./OwnerCell";
import { RunStatusTag } from "./RunStatusTag";
import { SidebarPager, SIDEBAR_PAGE_SIZES } from "./SidebarPager";
import { toRunStatus } from "../ui";

/**
 * The用例 list inside the workbench sidebar (交互文档 3.1.3).
 *
 * Clicking a case loads its snapshot into the request area rather than opening
 * a detail page, because a case is a request you re-run, not a document.
 */
export function CaseBox({ cases, activeCaseId, running, onOpen, onRun, onEdit, onDelete, onInspect }: {
  cases: TestCase[];
  activeCaseId?: string;
  running?: string;
  onOpen: (testCase: TestCase) => void;
  onRun: (testCase: TestCase) => void;
  onEdit: (testCase: TestCase) => void;
  onDelete: (testCase: TestCase) => void;
  onInspect: (run: Execution) => void;
}) {
  const { t } = useTranslation();
  /* viewer 只读用例列表（P6-4）：跑/改/删的行内入口不渲染，最近结果仍可点开看快照。 */
  const canWrite = useCanWrite();
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("all");
  const [tag, setTag] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(SIDEBAR_PAGE_SIZES[1]);

  /* Every tag in use, so the filter offers only values that can match. */
  const tags = useMemo(() => [...new Set(cases.flatMap((item) => item.tags))].sort(), [cases]);

  /* Filtered client-side: the box holds one endpoint's cases, already loaded. */
  const visible = useMemo(() => cases.filter((item) => {
    if (keyword.trim() && !item.name.toLowerCase().includes(keyword.trim().toLowerCase())) return false;
    if (tag !== "all" && !item.tags.includes(tag)) return false;
    if (status === "notRun") return !item.lastRun;
    if (status !== "all" && item.lastRun?.status !== status) return false;
    return true;
  }), [cases, keyword, status, tag]);

  const filtering = Boolean(keyword.trim()) || status !== "all" || tag !== "all";

  /* A narrowed result set rarely reaches the page you were on. */
  useEffect(() => { setPage(1); }, [keyword, status, tag]);

  /**
   * Paged client-side, matching the filtering above.
   *
   * Server paging would quietly reduce those filters to "within this page",
   * which is worse than no paging at all — and 状态 is derived from `lastRun`,
   * which is assembled in the API rather than in SQL. One endpoint's cases are
   * bounded, so the whole set is worth holding.
   */
  const lastPage = Math.max(1, Math.ceil(visible.length / pageSize));
  const current = Math.min(page, lastPage);
  const paged = visible.slice((current - 1) * pageSize, current * pageSize);

  return <>
    {/* Its own row, so it never competes with the segmented control for width. */}
    <div className="side-filter">
      <input
        className="input side-filter-keyword"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder={t("cases.searchPlaceholder")}
        aria-label={t("cases.searchPlaceholder")}
      />
      <Select
        size="small"
        value={status}
        onChange={setStatus}
        options={[
          { value: "all", label: t("filter.runStatusAll") },
          { value: "success", label: t("status.pass") },
          { value: "failed", label: t("status.fail") },
          { value: "notRun", label: t("status.notRun") },
        ]}
        style={{ width: 84 }}
      />
      {tags.length > 0 && <Select
        size="small"
        value={tag}
        onChange={setTag}
        options={[{ value: "all", label: t("cases.allTags") }, ...tags.map((value) => ({ value, label: value }))]}
        style={{ width: 84 }}
      />}
    </div>

    <div className="history-list">
      {paged.length ? paged.map((testCase) => (
        <div key={testCase.id} className={`case-item${activeCaseId === testCase.id ? " is-active" : ""}`}>
          <button className="case-item-main" onClick={() => onOpen(testCase)} title={t("cases.open")}>
            <span className="case-name truncate">{testCase.name}</span>
            <span className="case-meta">
              {/* 最近结果 reopens that run's snapshot rather than re-running it.
                  Rendered as a span inside the row button (not a nested button,
                  which is invalid HTML) and stops the row's open action. */}
              {testCase.lastRun
                ? <span
                    className="case-last-run"
                    role="button"
                    tabIndex={0}
                    title={t("cases.lastResult")}
                    onClick={(event) => { event.stopPropagation(); onInspect(testCase.lastRun!); }}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onInspect(testCase.lastRun!); } }}
                  >
                    <RunStatusTag status={toRunStatus(testCase.lastRun.status)} />
                    <span className="mono muted">{testCase.lastRun.statusCode ?? "—"}</span>
                  </span>
                : <span className="muted">{t("status.notRun")}</span>}
              <span className="mono muted">{t("cases.assertionCount", { count: testCase.assertions.length })}</span>
              {/* 归属（P11-7）：这是工作台侧栏的卡片列表，没有表头可挂，所以两个数据点并进
                  meta 行（与断言数、环境 chip 同一层）而不是两列——边界 9 说的「加两列」在
                  这个形状上没有可加的列。系统路径改的仍显示「系统」。 */}
              <span className="mono muted truncate">{t("common.createdBy")} <OwnerCell kind="created" email={testCase.createdByEmail} /></span>
              <span className="mono muted truncate">{t("common.updatedBy")} <OwnerCell kind="updated" email={testCase.updatedByEmail} createdAt={testCase.createdAt} updatedAt={testCase.updatedAt} /></span>
              {testCase.environmentName && <span className="chip">{testCase.environmentName}</span>}
              {testCase.tags.slice(0, 2).map((value) => <span className="chip" key={value}>{value}</span>)}
            </span>
          </button>
          {/* Always visible, matching the endpoint list's row actions. */}
          {canWrite && <div className="case-actions">
            <IconButton icon={<Play size={13} />} label={t("action.run")} disabled={Boolean(running)} onClick={() => onRun(testCase)} />
            <IconButton icon={<Pencil size={13} />} label={t("action.edit")} onClick={() => onEdit(testCase)} />
            <IconButton icon={<Trash2 size={13} />} label={t("action.delete")} tone="danger" onClick={() => onDelete(testCase)} />
          </div>}
        </div>
      )) : <p className="muted history-empty">{filtering ? t("cases.emptyFilter") : t("cases.empty")}</p>}
    </div>
    {/* Counts the filtered set, not every case, so the pager agrees with the rows. */}
    <SidebarPager page={current} pageSize={pageSize} total={visible.length} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />
  </>;
}

export type CaseDialogMode = { kind: "create"; request: RequestSnapshot; statusCode?: number } | { kind: "edit"; testCase: TestCase };

/**
 * 保存为用例 / 编辑用例 — name, tags and environment only.
 *
 * Assertions are edited in the workbench's 校验 tab, not here: editing them in
 * a modal meant losing sight of the response they are written against.
 */
export function CaseDialog({ mode, projectId, endpointId, environments, defaultEnvironmentId, onClose, onSaved }: {
  mode?: CaseDialogMode;
  projectId: string;
  endpointId: string;
  environments: Environment[];
  defaultEnvironmentId?: string;
  onClose: () => void;
  onSaved: (testCase: TestCase, created: boolean) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [environmentId, setEnvironmentId] = useState<string>();
  const [assertions, setAssertions] = useState<Assertion[]>([]);
  const [saving, setSaving] = useState(false);
  /* Re-seeded per open rather than in an effect: the dialog is keyed by mode,
     so a fresh open must not inherit the previous case's fields. */
  const [seeded, setSeeded] = useState<CaseDialogMode>();

  if (mode && mode !== seeded) {
    setSeeded(mode);
    if (mode.kind === "edit") {
      setName(mode.testCase.name);
      setTags(mode.testCase.tags.join(", "));
      setEnvironmentId(mode.testCase.environmentId);
      setAssertions(mode.testCase.assertions);
    } else {
      setName("");
      setTags("");
      setEnvironmentId(defaultEnvironmentId);
      /* Pre-filled from the last response's status code, then refined in the
         校验 tab once the case exists. */
      setAssertions(defaultAssertions(mode.statusCode));
    }
  }

  async function submit() {
    if (!mode) return;
    if (!name.trim()) { message.error(t("cases.nameRequired")); return; }
    const tagList = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    setSaving(true);
    try {
      if (mode.kind === "create") {
        const input: TestCaseInput = { name: name.trim(), request: mode.request, assertions, tags: tagList, environmentId: environmentId ?? null };
        onSaved(await api.createCase(projectId, endpointId, input), true);
      } else {
        onSaved(await api.updateCase(projectId, mode.testCase.id, { name: name.trim(), tags: tagList, environmentId: environmentId ?? null }), false);
      }
    } catch { message.error(t("cases.saveFailed")); }
    finally { setSaving(false); }
  }

  return <Modal
    title={mode?.kind === "edit" ? t("cases.editTitle") : t("cases.saveTitle")}
    open={Boolean(mode)}
    onCancel={onClose}
    onOk={() => void submit()}
    okText={t("action.save")}
    cancelText={t("action.cancel")}
    confirmLoading={saving}
    width={520}
  >
    <label className="field">
      <span>{t("cases.name")}</span>
      <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("cases.namePlaceholder")} />
    </label>
    <div className="form-grid">
      <label className="field">
        <span>{t("cases.tags")}</span>
        <input className="input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="smoke, regression" />
      </label>
      <label className="field">
        <span>{t("cases.environment")}</span>
        <Select
          value={environmentId}
          onChange={setEnvironmentId}
          options={environments.map((environment) => ({ value: environment.id, label: environment.name }))}
          placeholder={t("endpoints.noEnvironment")}
          style={{ width: "100%" }}
          allowClear
        />
      </label>
    </div>
    <p className="form-note">{mode?.kind === "edit" ? t("cases.editAssertionsHint") : t("cases.createAssertionsHint")}</p>
  </Modal>;
}
