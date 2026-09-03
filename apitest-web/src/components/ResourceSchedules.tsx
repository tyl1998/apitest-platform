import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer, Modal, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { CalendarClock, Pencil, Play, Plus, Trash2 } from "lucide-react";
import {
  api, noRunnerLabel,
  type Schedule, type SchedulePreview, type ScheduleRun, type ScheduleTargetType,
} from "../api";
import { useProjectStore } from "../stores/projectStore";
import type { RunStatus } from "../ui";
import { IconButton } from "./IconButton";
import { RunStatusTag } from "./RunStatusTag";
import { fromPairs, toPairs, type Pair } from "./KeyValueEditor";
import { VariableRowsEditor } from "./VariableRowsEditor";

/**
 * 一个资源的「定时调度」面板（P3-11，6.8；P4.5-12 泛化到 CI 任务，计划 8.7）。
 *
 * 独立调度页在 P3-11 已删除：调度的配置入口收进它的目标本身。所以这个组件永远只列
 * 「这一个资源」的调度（`GET /schedules?targetType=&targetId=`），创建时目标固定为传进来
 * 的那个，编辑抽屉里**没有目标选择器**——两步选资源（交互 3.7 原设计）是独立调度页才需要
 * 的东西，从资源里进来的人已经回答了那一步。
 *
 * 两处按目标类型分叉，其余完全共用：
 * - **环境覆盖只对套件出现**。CI 任务跑的是仓库里的脚本，环境由脚本自己决定，平台不注入
 *   （服务端也不拿 `environment_id` 做任何事）。给它留一个不起作用的下拉是在撒谎。
 * - **变量覆盖在 CI 目标下叫「触发参数」**。同一列 `variables`、同一条键形约束，服务端把它
 *   当 `parameters` 传给 `triggerCiTaskRun`；换个标题是因为「变量」在仓库模式里没有对应物，
 *   用户看到的是环境变量。
 *
 * 增删改走的是与原先同一个 REST 资源（`/schedules`），没有任何新路由。
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

export function ResourceSchedules({ projectId, targetType, targetId, autoOpenCreate = false }: {
  projectId: string;
  targetType: ScheduleTargetType;
  targetId: string;
  /**
   * 挂载时直接打开「新建调度」抽屉（任务编辑页的场景：新建页点「新建调度」→ 任务被
   * 静默保存 → 面板带着新任务 id 挂载 → 抽屉自动打开，用户不需要再点一次）。
   * 只在挂载那一次生效：父级会在面板挂载后把 armed 清掉，这里用 ref 固定初值。
   */
  autoOpenCreate?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { environments } = useProjectStore();
  const isCiTask = targetType === "ci_task";

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
      const result = await api.schedules(projectId, { targetType, targetId, page, pageSize: 20 });
      setSchedules(result.items);
      setTotal(result.total);
      setOverdue(result.scheduler.overdue);
    } catch {
      message.error(t("schedules.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, targetType, targetId, page, t]);

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

  const armedRef = useRef(autoOpenCreate);
  useEffect(() => { if (armedRef.current) openEdit("new"); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        targetType,
        targetId,
        cron: form.cron.trim(),
        timezone: form.timezone.trim() || "Asia/Shanghai",
        /* CI 目标不显示环境下拉，也就永远不发它（服务端那一列在这条路径上无意义）。 */
        environmentId: isCiTask ? null : form.environmentId || null,
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

  /**
   * 立即跑一次：手动触发（trigger_source=manual），失败原因原样转述。
   *
   * 结果按 `targetType` 判别（服务端 P4.5-12 的联合响应）：套件报出报告名，CI 任务报出
   * 执行序号并直接跳到那条 run 的详情页——那一页是 CI 执行唯一的看处（实时日志在那里）。
   * `Idempotency-Key` 只在 CI 路径生成：那是一次全新的「我现在要跑一遍」，键即用即弃，
   * 作用只是挡住双击产出两条 run。
   */
  async function runNow(schedule: Schedule) {
    setRunning(schedule.id);
    try {
      const result = await api.runScheduleNow(projectId, schedule.id, isCiTask ? { idempotencyKey: crypto.randomUUID() } : undefined);
      if (result.targetType === "ci_task") {
        message.success(t("ciTasks.triggered", { number: result.pipelineRun.runNumber }));
        navigate(`/projects/${projectId}/pipeline-runs/${result.pipelineRun.id}`);
        return;
      }
      message.success(`${t("suiteReports.reportName")}: ${result.suiteExecution.reportName ?? result.suiteExecution.id}`);
    } catch (error) {
      /* 2004 是「这个分区没有在线执行器 / Runner」，与「队列挂了」是两个处置动作
         （noRunnerLabel 的单一判定，各执行入口共用）。 */
      const label = noRunnerLabel(error);
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(label === undefined
        ? detail ?? t("schedules.runNowFailed")
        : t(isCiTask ? "ciTasks.noRunner" : "run.noRunner", { label }));
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

  /**
   * 一行触发记录能点开什么：套件路径顺 `executionIndexId` 跳报告，CI 路径顺
   * `pipelineRunId` 跳 run 详情页（它的 index 行要到终态才写，触发时还没有——迁移 042
   * 加那一列的全部理由）。skipped / failed 两者都没有，不可点。
   */
  function runTarget(run: ScheduleRun): (() => void) | undefined {
    if (run.pipelineRunId) return () => navigate(`/projects/${projectId}/pipeline-runs/${run.pipelineRunId}`);
    if (run.executionIndexId) return () => void openRunExecution(run.executionIndexId!);
    return undefined;
  }

  /**
   * 触发行的状态显示（2026-09-03 验收修正）：`triggered` 只是拉起事实，不能画成绿色
   * 通过——执行结果以 `executionStatus` 为准（CI=run 行状态，套件=index 行状态）。
   * 归一到设计系统 Status 六值：success→pass、queued/claimed/running/cancelling→
   * running 或 queued、其余→fail；executionStatus 缺席（目标被删）时回退「已触发」
   * 中性文案，调度证据仍可读。
   */
  function execStatusOf(run: ScheduleRun): { status: RunStatus; label: string; fallback: boolean } {
    const raw = run.executionStatus;
    if (!raw) return { status: "skip", label: t("schedules.statusTriggered"), fallback: true };
    if (raw === "success") return { status: "pass", label: t("schedules.execSuccess"), fallback: false };
    if (raw === "queued") return { status: "queued", label: t("schedules.execQueued"), fallback: false };
    if (raw === "claimed" || raw === "running" || raw === "cancelling") return { status: "running", label: t("schedules.execRunning"), fallback: false };
    if (raw === "canceled") return { status: "canceled", label: t("schedules.execCanceled"), fallback: false };
    return { status: "fail", label: t("schedules.execFailed"), fallback: false };
  }

  return <section className="panel">
    <div className="panel-head">
      <strong>{t("schedules.title")}</strong>
      <div className="topbar-actions">
        <button className="btn btn-small btn-with-icon" onClick={() => openEdit("new")}><Plus size={14} />{t("schedules.createTitle")}</button>
      </div>
    </div>
    <div className="panel-body">
      <p className="form-note">{t(isCiTask ? "schedules.hintCiTask" : "schedules.hint")}</p>
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

    {/* 编辑抽屉：目标固定为传进来的那个资源，没有目标选择器。 */}
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

      {/* 环境覆盖只对套件出现：CI 任务的环境由仓库里的脚本决定，平台不注入。 */}
      {!isCiTask && <label className="field">
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
      </label>}

      <VariableRowsEditor
        title={t(isCiTask ? "schedules.parameters" : "schedules.variables")}
        hint={t(isCiTask ? "schedules.parametersHint" : "schedules.variablesHint")}
        pairs={variables}
        onChange={setVariables}
        keyPlaceholder={isCiTask ? "BUILD_TAG" : "lane"}
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
          {runs.map((run) => {
            const open = runTarget(run);
            return <tr
              key={run.id}
              data-clickable={open ? "" : undefined}
              onClick={open}
            >
              <td className="mono">{new Date(run.plannedAt).toLocaleString()}</td>
              <td className="col-status">
                {run.status === "skipped"
                  ? <><RunStatusTag status="skip" /><span className="muted" style={{ marginLeft: 6 }}>{t("schedules.statusSkipped")}</span></>
                  : run.status === "failed"
                    ? <><RunStatusTag status="fail" /><span className="muted" style={{ marginLeft: 6 }}>{t("schedules.statusFailed")}</span></>
                    : (() => {
                      /* triggered：显示执行的真实状态（execStatusOf）；拉起成功只是
                         背景事实，降级进结果列的副文案。 */
                      const exec = execStatusOf(run);
                      return <><RunStatusTag status={exec.status} /><span className="muted" style={{ marginLeft: 6 }}>{exec.label}</span></>;
                    })()}
              </td>
              <td className="mono muted truncate" title={run.error ?? ""}>
                {run.error ?? (run.status === "triggered" && !run.executionStatus
                  ? t("schedules.launchedNote")
                  : open ? t("suiteReports.trigger") : "—")}
              </td>
            </tr>;
          })}
        </tbody>
      </table> : !runsLoading && <p className="form-note">{t("schedules.runsEmpty")}</p>}
      {runsTotal > 10 && <div className="pager">
        <Pagination simple current={runsPage} pageSize={10} total={runsTotal} onChange={setRunsPage} />
      </div>}
    </Drawer>
  </section>;
}
