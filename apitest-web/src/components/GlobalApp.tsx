import { useEffect, useState } from "react";
import { Form, Input, Modal, Select, Switch, message } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { LogOut } from "lucide-react";
import { api, type Dashboard, type Preferences, type ProjectMetric, type WorkerFleet, type WorkerMode } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useRecordLastPage } from "../hooks/useRecordLastPage";
import { useAuthStore } from "../stores/authStore";
import type { ModePreference } from "../theme";
import { Empty, Readout, Status } from "../ui";
import { IconButton } from "./IconButton";

type GlobalPage = "dashboard" | "projects" | "system";

export function GlobalApp({ page, themePreference, onThemeChange }: { page: GlobalPage; themePreference: ModePreference; onThemeChange: (mode: ModePreference) => void }) {
  useRecordLastPage();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, i18n } = useTranslation();
  const logout = useAuthStore((state) => state.logout);
  const nav: [GlobalPage, string][] = [["dashboard", t("nav.dashboard")], ["projects", t("nav.projects")], ["system", t("nav.system")]];

  return <div className="console">
    <aside className="sidebar">
      <div className="lockup"><span className="lockup-mark mono">AT</span><span className="lockup-name">{t("app.name")}</span></div>
      <nav><span className="nav-section">{t("nav.global")}</span>{nav.map(([key, label]) => <button key={key} className={`nav-item${page === key ? " is-active" : ""}`} onClick={() => navigate(`/${key}`)}>{label}</button>)}</nav>
      {/* Same control as the project shell, so signing out looks identical everywhere */}
      <div className="sidebar-foot">
        <IconButton
          icon={<LogOut size={15} />}
          label={t("action.logout")}
          onClick={() => { logout(); navigate(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`); }}
        />
      </div>
    </aside>
    <div className="frame">
      <header className="topbar"><div className="crumb"><strong>{nav.find(([key]) => key === page)?.[1]}</strong></div></header>
      <main className="content">
        {page === "dashboard" && <DashboardPage />}
        {page === "projects" && <ProjectsPage />}
        {page === "system" && <SystemPage themePreference={themePreference} onThemeChange={onThemeChange} language={i18n.language === "en" ? "en" : "zh-CN"} />}
      </main>
    </div>
  </div>;
}

function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [keyword, setKeyword] = useState(searchParams.get("keyword") ?? "");
  const debouncedKeyword = useDebounced(keyword);
  const [data, setData] = useState<Dashboard>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSearchParams({ ...(debouncedKeyword ? { keyword: debouncedKeyword } : {}) }, { replace: true });
    setLoading(true);
    /* No archive state, so the board always aggregates every visible project. */
    void api.dashboard({ keyword: debouncedKeyword }).then(setData).catch(() => message.error(t("dashboard.loadFailed"))).finally(() => setLoading(false));
  }, [debouncedKeyword]);

  return <>
    <div className="page-head">
      <div><h1>{t("dashboard.title")}</h1><p>{t("dashboard.hint")}</p></div>
      <div className="topbar-actions">
        <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("filter.keyword")} />
      </div>
    </div>
    {loading && <p className="muted">{t("filter.searching")}</p>}
    {data && <>
      <div className="readouts">
        <Readout label={t("dashboard.projects")} value={data.projectCount} />
        <Readout label={t("dashboard.endpoints")} value={data.endpointCount} />
        <Readout label={t("dashboard.passRate")} value={data.passRate === null ? "—" : data.passRate.toFixed(1)} unit={data.passRate === null ? undefined : "%"} />
        <Readout label={t("dashboard.completionRate")} value={data.completionRate === null ? "—" : data.completionRate.toFixed(1)} unit={data.completionRate === null ? undefined : "%"} />
        {/* Coverage counts endpoints that have at least one case, so it stays
            null only while a project has no endpoints at all. */}
        <Readout label={t("dashboard.coverageRate")} value={data.coverageRate === null ? "—" : data.coverageRate.toFixed(1)} unit={data.coverageRate === null ? undefined : "%"} />
      </div>
      <div className="readouts">
        <Readout label={t("dashboard.testCases")} value={data.testCaseCount ?? t("dashboard.notEnabled")} />
        <Readout label={t("dashboard.ciTasks")} value={t("dashboard.notEnabled")} />
        <Readout label={t("dashboard.schedules")} value={t("dashboard.notEnabled")} />
      </div>
      <section className="panel"><div className="panel-head"><strong>{t("dashboard.projectTable")}</strong></div><div className="panel-body"><ProjectMetricsTable projects={data.projects} onEnter={(id) => navigate(`/projects/${id}/endpoints`)} /></div></section>
    </>}
  </>;
}

function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [keyword, setKeyword] = useState(searchParams.get("keyword") ?? "");
  const debouncedKeyword = useDebounced(keyword);
  const [projects, setProjects] = useState<ProjectMetric[]>([]);
  const [loading, setLoading] = useState(false);
  const [projectDialog, setProjectDialog] = useState<"create" | "edit">();
  const [editing, setEditing] = useState<ProjectMetric>();
  const [form] = Form.useForm();

  async function load() {
    setLoading(true);
    /* Archiving is not a product concept, so every project is always listed. */
    try { setProjects(await api.projects({ keyword: debouncedKeyword })); }
    catch { message.error(t("projects.loadFailed")); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    setSearchParams({ ...(debouncedKeyword ? { keyword: debouncedKeyword } : {}) }, { replace: true });
    void load();
  }, [debouncedKeyword]);

  function openCreate() { setEditing(undefined); form.resetFields(); setProjectDialog("create"); }
  function openEdit(project: ProjectMetric) { setEditing(project); form.setFieldsValue(project); setProjectDialog("edit"); }
  async function save() {
    const values = await form.validateFields();
    if (editing) { await api.updateProject(editing.id, values); message.success(t("projects.updated")); }
    else { await api.createProject(values.name, values.description ?? ""); message.success(t("projects.created")); }
    setProjectDialog(undefined); await load();
  }
  function remove(project: ProjectMetric) { Modal.confirm({ title: t("projects.deleteTitle", { name: project.name }), content: t("projects.deleteHint"), okText: t("action.delete"), okButtonProps: { danger: true }, onOk: async () => { await api.deleteProject(project.id); await load(); } }); }

  return <>
    <div className="page-head">
      <div><h1>{t("projects.title")}</h1><p>{t("projects.hint")}</p></div>
      <button className="btn btn-primary" onClick={openCreate}>{t("action.createProject")}</button>
    </div>
    <div className="filter-bar">
      <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("filter.keyword")} />
    </div>
    {loading && <p className="muted">{t("filter.searching")}</p>}
    {projects.length ? <div className="project-grid">{projects.map((project) => <article className="project-card" key={project.id}>
      <div className="project-card-head"><div><h2>{project.name}</h2></div><p>{project.description || t("projects.noDescription")}</p></div>
      <dl className="project-facts"><div><dt>{t("dashboard.environments")}</dt><dd className="mono">{project.environmentCount}</dd></div><div><dt>{t("dashboard.endpoints")}</dt><dd className="mono">{project.endpointCount}</dd></div><div><dt>{t("dashboard.passRate")}</dt><dd className="mono">{project.passRate === null ? "—" : `${project.passRate.toFixed(1)}%`}</dd></div></dl>
      <div className="project-actions"><button className="btn btn-primary" onClick={() => navigate(`/projects/${project.id}/endpoints`)}>{t("action.enter")}</button><button className="btn" onClick={() => openEdit(project)}>{t("action.edit")}</button><button className="btn danger" onClick={() => remove(project)}>{t("action.delete")}</button></div>
    </article>)}</div> : !loading && <Empty title={keyword ? t("projects.emptySearchTitle") : t("projects.emptyTitle")} hint={keyword ? t("projects.emptySearchHint") : t("projects.emptyHint")} action={!keyword ? <button className="btn btn-primary" onClick={openCreate}>{t("action.createProject")}</button> : undefined} />}
    <Modal title={editing ? t("projects.editTitle") : t("action.createProject")} open={Boolean(projectDialog)} onCancel={() => setProjectDialog(undefined)} onOk={() => void save()} okText={t("action.save")} cancelText={t("action.cancel")}>
      <Form form={form} layout="vertical"><Form.Item name="name" label={t("projects.name")} rules={[{ required: true, message: t("projects.nameRequired") }]}><Input /></Form.Item><Form.Item name="description" label={t("projects.description")}><Input.TextArea rows={4} /></Form.Item></Form>
    </Modal>
  </>;
}

type SystemTab = "preferences" | "workers";

function SystemPage({ themePreference, onThemeChange, language }: { themePreference: ModePreference; onThemeChange: (mode: ModePreference) => void; language: "zh-CN" | "en" }) {
  const { t, i18n } = useTranslation();
  const isAdmin = useAuthStore((state) => state.user?.isSystemAdmin) ?? false;
  const [tab, setTab] = useState<SystemTab>("preferences");
  const [preferences, setPreferences] = useState<Preferences>({ theme: themePreference, language, restoreLastPage: false });

  useEffect(() => { void api.preferences().then((value) => { setPreferences(value); onThemeChange(value.theme); if (value.language !== i18n.language) void i18n.changeLanguage(value.language); }); }, []);

  async function update(input: Partial<Preferences>) {
    const previous = preferences;
    const next = { ...preferences, ...input };
    setPreferences(next);
    if (input.theme) onThemeChange(input.theme);
    if (input.language) { localStorage.setItem("apitest.language", input.language); await i18n.changeLanguage(input.language); }
    try { setPreferences(await api.updatePreferences(input)); }
    catch {
      setPreferences(previous);
      if (input.theme) onThemeChange(previous.theme);
      if (input.language) { localStorage.setItem("apitest.language", previous.language); await i18n.changeLanguage(previous.language); }
      message.error(t("system.saveFailed"));
    }
  }

  /**
   * 个性设置 is per-user, 执行器 is platform infrastructure — unrelated things
   * that only share a page, which is what tabs are for. The second tab is
   * absent for non-admins rather than disabled: a tab you may never open is
   * just clutter.
   */
  const tabs: [SystemTab, string][] = isAdmin
    ? [["preferences", t("system.tabPreferences")], ["workers", t("workers.title")]]
    : [["preferences", t("system.tabPreferences")]];

  return <>
    <div className="page-head"><div><p>{t("system.hint")}</p></div></div>

    {tabs.length > 1 && <div className="tabs" role="tablist">
      {tabs.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={tab === key} className={`tab${tab === key ? " is-active" : ""}`} onClick={() => setTab(key)}>{label}</button>
      ))}
    </div>}

    {tab === "preferences" && <section className="settings-list">
      <SettingRow title={t("system.theme")} hint={t("system.themeHint")} control={<Select value={preferences.theme} onChange={(theme) => void update({ theme })} options={[{ value: "system", label: t("system.themeSystem") }, { value: "light", label: t("system.themeLight") }, { value: "dark", label: t("system.themeDark") }]} style={{ width: 150 }} />} />
      <SettingRow title={t("system.language")} hint={t("system.languageHint")} control={<Select value={preferences.language} onChange={(nextLanguage) => void update({ language: nextLanguage })} options={[{ value: "zh-CN", label: "简体中文" }, { value: "en", label: "English" }]} style={{ width: 150 }} />} />
      <SettingRow title={t("system.restore")} hint={t("system.restoreHint")} control={<Switch checked={preferences.restoreLastPage} onChange={(restoreLastPage) => void update({ restoreLastPage })} />} />
    </section>}

    {tab === "workers" && isAdmin && <WorkerFleetPanel />}
  </>;
}

/**
 * 执行器 (P1-3). Read-only: the fleet is steered by starting and stopping
 * processes, not from here.
 */
function WorkerFleetPanel() {
  const { t } = useTranslation();
  const [fleet, setFleet] = useState<WorkerFleet>();
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<WorkerMode>("endpoint");

  useEffect(() => {
    let active = true;
    const load = () => api.workers().then((next) => { if (active) { setFleet(next); setFailed(false); } }).catch(() => { if (active) setFailed(true); });
    void load();
    /* Heartbeats land every 10s, so polling faster would only redraw the same
       numbers. There is no event stream for this: it is a page you visit, not
       one you sit on. */
    const timer = setInterval(() => void load(), 10_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  if (failed) return <Empty title={t("workers.loadFailedTitle")} hint={t("workers.loadFailedHint")} />;
  if (!fleet) return null;

  /**
   * Modes are derived from what actually reported in, never hardcoded.
   *
   * Repository workers do not exist yet, so the switcher stays hidden — a
   * single-option control is noise. The day one registers, it appears on its
   * own, with no change here to "unhide" it.
   */
  const modes = [...new Set(fleet.workers.map((each) => each.mode))].sort();
  const active = modes.includes(mode) ? mode : modes[0] ?? "endpoint";
  const shown = fleet.workers.filter((each) => each.mode === active);
  const queue = fleet.queues[active];

  return <>
    {/* Says where requests actually come from — the single most misread thing
        about this page, since the platform is not the sender. */}
    <p className="form-note">{t("workers.hint")}</p>

    {modes.length > 1 && <div className="segmented" role="tablist">
      {modes.map((each) => (
        <button key={each} role="tab" aria-selected={each === active} className={`segmented-item${each === active ? " is-active" : ""}`} onClick={() => setMode(each)}>
          {t(`workers.mode.${each}`)}
        </button>
      ))}
    </div>}

    <div className="readouts">
      <Readout label={t("workers.online")} value={`${shown.filter((each) => each.online).length}/${shown.length}`} />
      <Readout label={t("workers.capacity")} value={fleet.capacity[active] ?? 0} />
      <Readout label={t("workers.inflight")} value={fleet.inflight[active] ?? 0} />
      {/* Only shown when this mode has a queue of its own; a mode without one
          would otherwise read as "nothing waiting" instead of "not applicable". */}
      {queue && <Readout label={t("workers.waiting")} value={queue.waiting} />}
      {queue && <Readout label={t("workers.failedJobs")} value={queue.failed} tone={queue.failed ? "fail" : undefined} />}
    </div>

    {/* 执行分区（P2-8）。放在 worker 表格**上方**，且刻意**不是**第二排 segmented：
        mode segmented 已经占了那个位置，4.5 明确否决过「同页两排下划线 tab」。分区是同一份
        数据的另一个切片，不是导航层级，所以用一张小表呈现。 */}
    <h3 className="subhead" style={{ marginTop: "var(--s5)" }}>{t("workers.partitionTitle")}</h3>
    <p className="form-note">{t("workers.partitionHint")}</p>
    <table className="grid" style={{ marginBottom: "var(--s5)" }}>
      <thead><tr>
        <th>{t("workers.partitionLabel")}</th>
        <th className="col-num">{t("workers.partitionOnline")}</th>
        <th className="col-num">{t("workers.capacity")}</th>
        <th className="col-num">{t("workers.inflight")}</th>
        <th className="col-num">{t("workers.waiting")}</th>
        <th className="col-num">{t("workers.failedJobs")}</th>
      </tr></thead>
      <tbody>{fleet.partitions.map((partition) => <tr key={partition.label}>
        <td className="mono">
          {partition.label}
          {/* online=0 的那一行是这张表存在的理由：指向它的执行会被直接拒绝（错误码
              2004），而不是排队等一个永远不来的执行器。 */}
          {!partition.online && <span className="muted"> · {t("workers.partitionNone")}</span>}
        </td>
        <td className="col-num mono">{partition.online}/{partition.total}</td>
        <td className="col-num mono">{partition.capacity}</td>
        <td className="col-num mono">{partition.inflight}</td>
        <td className="col-num mono">{partition.waiting}</td>
        <td className="col-num mono">{partition.failed}</td>
      </tr>)}</tbody>
    </table>

    {shown.length
      ? <table className="grid">
          <thead><tr>
            <th>{t("workers.worker")}</th>
            <th>{t("workers.partitionColumn")}</th>
            <th className="col-num">{t("workers.load")}</th>
            <th className="col-num">{t("workers.uptime")}</th>
            <th>{t("workers.lastSeen")}</th>
          </tr></thead>
          <tbody>{shown.map((worker) => <tr key={worker.id}>
            <td>
              <Status status={worker.online ? "running" : "canceled"} label={worker.online ? t("workers.statusOnline") : t("workers.statusOffline")} />
              <div className="mono muted">{worker.hostname} · pid {worker.pid}{worker.version ? ` · ${worker.version}` : ""}</div>
            </td>
            {/* 一台 worker 可以服务多个分区（单机开发的便利），所以这里是一组标签而不是
                一个值——它的容量已经在服务端按标签数拆分过。 */}
            <td className="mono">{worker.labels.join(", ")}</td>
            {/* 在途/容量 together, because either number alone says nothing
                about whether this worker is the busy one. */}
            <td className="col-num mono">{worker.inflight}/{worker.concurrency}</td>
            <td className="col-num mono">{formatDuration(Date.now() - new Date(worker.startedAt).getTime())}</td>
            <td className="mono muted">{new Date(worker.lastSeenAt).toLocaleTimeString()}</td>
          </tr>)}</tbody>
        </table>
      : <Empty title={t("workers.emptyTitle")} hint={t("workers.emptyHint")} />}
  </>;
}

/** Coarse by design: an exact uptime to the second is noise on this page. */
function formatDuration(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function SettingRow({ title, hint, control }: { title: string; hint: string; control: React.ReactNode }) { return <div className="setting-row"><div><strong>{title}</strong><p>{hint}</p></div>{control}</div>; }

function ProjectMetricsTable({ projects, onEnter }: { projects: ProjectMetric[]; onEnter: (id: string) => void }) {
  const { t } = useTranslation();
  return projects.length ? <table className="grid"><thead><tr><th>{t("dashboard.projects")}</th><th className="col-num">{t("dashboard.endpoints")}</th><th className="col-num">{t("dashboard.testCases")}</th><th className="col-num">{t("dashboard.coverageRate")}</th><th className="col-num">{t("dashboard.executed")}</th><th className="col-num">{t("dashboard.passRate")}</th><th>{t("dashboard.lastExecution")}</th><th /></tr></thead><tbody>{projects.map((project) => <tr key={project.id}><td><strong>{project.name}</strong><div className="muted">{project.description}</div></td><td className="col-num mono">{project.endpointCount}</td><td className="col-num mono">{project.caseCount}</td>{/* 覆盖 = 有用例的接口占比, so it reads 0% only once endpoints exist */}<td className="col-num mono">{project.coverageRate === null ? "—" : `${project.coverageRate.toFixed(1)}%`}</td><td className="col-num mono">{project.executedEndpointCount}/{project.endpointCount}</td><td className="col-num mono">{project.passRate === null ? "—" : `${project.passRate.toFixed(1)}%`}</td><td className="mono muted">{project.lastExecutionAt ? new Date(project.lastExecutionAt).toLocaleString() : "—"}</td><td><button className="btn" onClick={() => onEnter(project.id)}>{t("dashboard.enterProject")}</button></td></tr>)}</tbody></table> : <Empty title={t("dashboard.emptyTitle")} hint={t("dashboard.emptyHint")} />;
}
