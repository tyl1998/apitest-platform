import { useCallback, useEffect, useState } from "react";
import { Drawer, Modal, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { CalendarClock, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, type Schedule, type SchedulePreview, type ScheduleRun } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { IconButton } from "./IconButton";
import { RunStatusTag } from "./RunStatusTag";
import { fromPairs, toPairs, type Pair } from "./KeyValueEditor";
import { VariableRowsEditor } from "./VariableRowsEditor";

/**
 * 套件详情页的「定时调度」面板（P3-11，6.8）。
 *
 * 独立调度页已删除：调度的配置入口收进它唯一的目标——套件。这里列出的就是
 * 「这个套件」的调度（`GET /schedules?targetId=`），创建时目标固定为当前套件，
 * 编辑抽屉里没有目标选择器。触发历史与「立即跑一次」随面板一起进来。
 *
 * 调度的增删改走的是与原先同一个 REST 资源（`/schedules`），没有任何新路由：
 * 面板只是换了收件人，没有换邮局。
 */

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type ScheduleForm = {
  name: string;
  cron: string;
  timezone: string;
  environmentId: string;
  enabled: boolean;
};

function emptyForm(): ScheduleForm {
  return { name: "", cron: "", timezone: "Asia/Shanghai", environmentId: "", enabled: true };
}

export function SuiteSchedules({ projectId, suiteId }: { projectId: string; suiteId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { environments } = useProjectStore();

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [total, setTotal] = useState(0);
  const [overdue, setOverdue] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const [editing, setEditing] = useState<Schedule | "new">();
  const [form, setForm] = useState<ScheduleForm>(emptyForm());
  const [variables, setVariables] = useState<Pair[]>([]);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<SchedulePreview>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState<string>();

  const [runsDrawer, setRunsDrawer] = useState<Schedule>();
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsPage, setRunsPage] = useState(1);
  const [runsLoading, setRunsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.schedules(projectId, { targetId: suiteId, page, pageSize: 20 });
      setSchedules(result.items);
      setTotal(result.total);
      setOverdue(result.scheduler.overdue);
    } catch {
      message.error(t("schedules.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, suiteId, page, t]);

  useEffect(() => { void load(); }, [load]);

  function openEdit(schedule: Schedule | "new") {
    setEditing(schedule);
    setPreview(undefined);
    setPreviewError(undefined);
    if (schedule === "new") {
      setForm(emptyForm());
      setVariables([]);
      return;
    }
    setForm({
      name: schedule.name,
      cron: schedule.cron,
      timezone: schedule.timezone,
      environmentId: schedule.environmentId ?? "",
      enabled: schedule.enabled,
    });
    setVariables(toPairs(schedule.variables));
  }

  /* cron 预览：防抖后自动算（与服务端同一个解析，预览说几点跑就几点跑）。 */
  useEffect(() => {
    if (!editing || !form.cron.trim()) { setPreview(undefined); setPreviewError(undefined); return; }
    const timer = setTimeout(() => {
      setPreviewing(true);
      api.schedulePreview(projectId, form.cron.trim(), form.timezone.trim() || "Asia/Shanghai")
        .then((result) => { setPreview(result); setPreviewError(undefined); })
        .catch((error: { response?: { data?: { message?: string } } }) => {
          setPreview(undefined);
          setPreviewError(error.response?.data?.message ?? t("schedules.previewFailed"));
        })
        .finally(() => setPreviewing(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [editing, projectId, form.cron, form.timezone]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!editing) return;
    if (!form.name.trim()) { message.error(t("schedules.namePlaceholder")); return; }
    const invalidKey = variables.find((pair) => pair.key.trim() && !VARIABLE_NAME_PATTERN.test(pair.key.trim()));
    if (invalidKey) { message.error(t("schedules.variableKeyInvalid", { key: invalidKey.key })); return; }
    setSaving(true);
    try {
      const input = {
        name: form.name.trim(),
        targetId: suiteId,
        cron: form.cron.trim(),
        timezone: form.timezone.trim() || "Asia/Shanghai",
        environmentId: form.environmentId || null,
        enabled: form.enabled,
        variables: fromPairs(variables),
      };
      if (editing === "new") await api.createSchedule(projectId, input);
      else await api.updateSchedule(projectId, editing.id, input);
      message.success(t("schedules.saved"));
      setEditing(undefined);
      await load();
    } catch (error) {
      message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("schedules.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function remove(schedule: Schedule) {
    Modal.confirm({
      title: t("schedules.deleteTitle", { name: schedule.name }),
      content: t("schedules.deleteHint"),
      okText: t("action.delete"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.deleteSchedule(projectId, schedule.id);
          if (schedules.length === 1 && page > 1) setPage(page - 1); else await load();
          message.success(t("schedules.deleted"));
        } catch { message.error(t("schedules.deleteFailed")); }
      },
    });
  }

  /** 立即跑一次：手动触发（trigger_source=manual），失败原因原样转述。 */
  async function runNow(schedule: Schedule) {
    setRunning(schedule.id);
    try {
      const queued = await api.runScheduleNow(projectId, schedule.id);
      message.success(`${t("suiteReports.reportName")}: ${queued.reportName ?? queued.id}`);
    } catch (error) {
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(detail ?? t("schedules.runNowFailed"));
    } finally {
      setRunning(undefined);
    }
  }

  const loadRuns = useCallback(async () => {
    if (!runsDrawer) return;
    setRunsLoading(true);
    try {
      const result = await api.scheduleRuns(projectId, runsDrawer.id, { page: runsPage, pageSize: 10 });
      setRuns(result.items);
      setRunsTotal(result.total);
    } catch {
      message.error(t("schedules.loadFailed"));
    } finally {
      setRunsLoading(false);
    }
  }, [projectId, runsDrawer, runsPage, t]);

  useEffect(() => { void loadRuns(); }, [loadRuns]);

  function openRuns(schedule: Schedule) {
    setRunsDrawer(schedule);
    setRunsPage(1);
  }

  /** triggered 行点开是那次执行的报告：index id → detailId 一跳转换。 */
  async function openRunExecution(indexId: string) {
    try {
      const index = await api.executionIndexDetail(projectId, indexId);
      navigate(`/projects/${projectId}/suite-reports/${index.detailId}`);
    } catch {
      message.error(t("suiteReports.loadFailed"));
    }
  }

  return <section className="panel">
    <div className="panel-head">
      <strong>{t("schedules.title")}</strong>
      <div className="topbar-actions">
        <button className="btn btn-small btn-with-icon" onClick={() => openEdit("new")}><Plus size={14} />{t("schedules.createTitle")}</button>
      </div>
    </div>
    <div className="panel-body">
      <p className="form-note">{t("schedules.hint")}</p>
      {overdue > 0 && <p className="form-error">{t("schedules.overdue", { count: overdue })}</p>}
      {loading && <p className="muted">{t("common.loading")}</p>}
      {schedules.length ? <table className="grid schedule-grid">
        <colgroup>
          <col />
          <col className="schedule-col-cron" />
          <col className="schedule-col-clock" />
          <col className="schedule-col-clock" />
          <col className="col-status" />
          <col className="col-actions" />
        </colgroup>
        <thead><tr>
          <th>{t("schedules.name")}</th>
          <th className="mono">{t("schedules.cron")}</th>
          <th>{t("schedules.nextRun")}</th>
          <th>{t("schedules.lastRun")}</th>
          <th className="col-status">{t("schedules.enabled")}</th>
          <th className="col-actions" />
        </tr></thead>
        <tbody>
          {schedules.map((schedule) => <tr key={schedule.id}>
            <td><div className="cell-name"><span className="truncate">{schedule.name}</span></div></td>
            <td className="mono">{schedule.cron}</td>
            <td className="mono muted">
              {schedule.enabled
                ? schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "—"
                : <span className="muted">{t("schedules.disabled")}</span>}
            </td>
            <td className="mono muted">
              {schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : t("schedules.neverRun")}
            </td>
            <td className="col-status">
              <span className="status" data-status={schedule.enabled ? "pass" : "skip"}>
                <span className="status-mark" />{schedule.enabled ? t("schedules.enabled") : t("schedules.disabled")}
              </span>
            </td>
            <td className="col-actions">
              <div className="row-actions">
                <IconButton icon={<Play size={14} />} label={t("schedules.runNow")} disabled={running === schedule.id} onClick={() => void runNow(schedule)} />
                <IconButton icon={<CalendarClock size={14} />} label={t("schedules.runsTitle")} onClick={() => openRuns(schedule)} />
                <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => openEdit(schedule)} />
                <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => remove(schedule)} />
              </div>
            </td>
          </tr>)}
        </tbody>
      {/* 空态就是表里的一行「暂无数据」：新建入口常驻在面板头上，空态卡片只会把
          页面拉长、还和旁边的表头抢视觉。 */}
      </table> : !loading && <p className="muted">{t("common.noData")}</p>}
      {total > 20 && <div className="pager">
        <Pagination simple current={page} pageSize={20} total={total} onChange={setPage} />
      </div>}
    </div>

    {/* 编辑抽屉：目标固定为当前套件，没有目标选择器。 */}
    <Drawer
      title={editing === "new" ? t("schedules.createTitle") : t("schedules.editTitle")}
      open={Boolean(editing)}
      onClose={() => setEditing(undefined)}
      width={560}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={() => setEditing(undefined)}>{t("action.cancel")}</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "…" : t("action.save")}</button>
        </div>
      }
    >
      <label className="field">
        <span>{t("schedules.name")}</span>
        <input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t("schedules.namePlaceholder")} autoFocus />
      </label>

      <div className="field" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 160px)", gap: 8 }}>
        <label className="field" style={{ marginTop: 0 }}>
          <span>{t("schedules.cron")}</span>
          <input className="input mono" value={form.cron} onChange={(event) => setForm({ ...form, cron: event.target.value })} placeholder={t("schedules.cronPlaceholder")} spellCheck={false} />
        </label>
        <label className="field" style={{ marginTop: 0 }}>
          <span>{t("schedules.timezone")}</span>
          <input className="input mono" value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} spellCheck={false} />
        </label>
      </div>

      {form.cron.trim() && (previewError
        ? <p className="form-error">{previewError}</p>
        : preview && <div className="cron-preview">
            <p className="form-note">{t("schedules.preview")}</p>
            <ol className="mono cron-preview-list">
              {preview.next.map((iso) => <li key={iso}>{new Date(iso).toLocaleString()}</li>)}
            </ol>
          </div>)}
      {previewing && <p className="muted">{t("common.loading")}</p>}

      <label className="field">
        <span>{t("schedules.envOverride")}</span>
        <Select
          value={form.environmentId || undefined}
          onChange={(environmentId) => setForm({ ...form, environmentId: environmentId ?? "" })}
          options={environments.map((environment) => ({ value: environment.id, label: environment.name }))}
          placeholder={t("endpoints.noEnvironment")}
          allowClear
          style={{ width: "100%" }}
        />
        <p className="form-note">{t("schedules.envOverrideHint")}</p>
      </label>

      <VariableRowsEditor
        title={t("schedules.variables")}
        hint={t("schedules.variablesHint")}
        pairs={variables}
        onChange={setVariables}
        keyPlaceholder="lane"
      />

      <label className="check-field" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
        {t("schedules.enabled")}
      </label>
    </Drawer>

    {/* 触发历史：一个到期时刻一行，skipped/failed 没有「点进执行」一说。 */}
    <Drawer
      title={`${t("schedules.runsTitle")} · ${runsDrawer?.name ?? ""}`}
      open={Boolean(runsDrawer)}
      onClose={() => setRunsDrawer(undefined)}
      width={640}
    >
      {runsLoading && <p className="muted">{t("common.loading")}</p>}
      {runs.length ? <table className="grid">
        <thead><tr>
          <th className="mono">{t("schedules.plannedAt")}</th>
          <th className="col-status">{t("endpoints.status")}</th>
          <th>{t("schedules.runNote")}</th>
        </tr></thead>
        <tbody>
          {runs.map((run) => <tr
            key={run.id}
            data-clickable={run.executionIndexId ? "" : undefined}
            onClick={run.executionIndexId ? () => void openRunExecution(run.executionIndexId!) : undefined}
          >
            <td className="mono">{new Date(run.plannedAt).toLocaleString()}</td>
            <td className="col-status">
              {run.status === "triggered"
                ? <RunStatusTag status="pass" />
                : run.status === "skipped"
                  ? <RunStatusTag status="skip" />
                  : <RunStatusTag status="fail" />}
              <span className="muted" style={{ marginLeft: 6 }}>{t(`schedules.status${run.status.charAt(0).toUpperCase()}${run.status.slice(1)}`)}</span>
            </td>
            <td className="mono muted truncate" title={run.error ?? ""}>
              {run.error ?? (run.executionIndexId ? t("suiteReports.trigger") : "—")}
            </td>
          </tr>)}
        </tbody>
      </table> : !runsLoading && <p className="form-note">{t("schedules.runsEmpty")}</p>}
      {runsTotal > 10 && <div className="pager">
        <Pagination simple current={runsPage} pageSize={10} total={runsTotal} onChange={setRunsPage} />
      </div>}
    </Drawer>
  </section>;
}
