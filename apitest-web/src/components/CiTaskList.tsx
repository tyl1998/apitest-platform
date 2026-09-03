import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pagination, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronDown, ChevronRight, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, noRunnerLabel, type CiTask, type PipelineRun, type RunnerPool } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useProjectStore } from "../stores/projectStore";
import { Empty, Readout, Tip } from "../ui";
import { IconButton } from "./IconButton";
import { RepoPageHead, RepoTabs } from "./RepoShell";
import { RunStatusTag } from "./RunStatusTag";
import { apiMessage } from "./DataSourceList";

/**
 * 仓库任务列表（P4.5-11；P4.5-14 起是仓库模式的第一个标签，交互 3.12.1；P4.5-15 行内
 * 展开执行历史 + 编辑跳独立页）。
 *
 * 一条任务回答「从哪个仓库的哪个 ref 拉、在哪台机器上、跑哪一段 shell」。**不再要求先绑
 * 仓库**（P4.5-14）：Git 地址在任务自己身上，因为仓库行只能由第一次上报创建，而用户来这
 * 里正是因为还没有 CI。
 *
 * 顶部是 **Runner 池实时状态**（在线 / 槽位 / 在途 / 排队 N 个）。它读的是
 * `/system/runner-pool` 而不是 `/system/runners`——后者带机器身份信息、只给系统管理员，
 * 而这一行是任何能看这个项目的人都要看到的：没有在线 Runner 时触发会**直接被拒**
 * （错误码 2004），提前把这件事说清比让人对着一条失败提示猜要好。
 *
 * `queued` 是**跨项目的全局数**：认领扫描按标签取全平台最早的那条，所以「我前面排着
 * 几个」的真实答案就是全局的。文案上要说明这一点，否则会被读成「本项目排队 N 个」。
 *
 * 执行历史是**行内展开**（P4.5-15，8.12 ②）：展开时按 `ciTaskId` 拉最近几条 run，
 * 点某条同页 SPA 跳转直达 run 详情页。P4.5-11 的「历史」按钮跳
 * `reports?kind=runner&keyword=任务名`（跨两页、靠关键字模糊匹配，任务改名就搜不到）
 * 已删除；全局报告页保留「跨任务统一视角」这一个用途，从侧边栏进。
 *
 * **收起行也要有状态与规模**（2026-09-02 验收反馈 ⑦⑧）：`activeRun` 只在有在途 run 时
 * 存在，所以跑完的任务收起来后既读不到「上次是过还是挂」也读不到「一共跑过几次」。
 * 「最近执行」列补上这两件事（服务端同一条 LATERAL 带出，不额外请求）；关键字搜索走
 * 服务端 `ILIKE`——就地过滤只筛得到当前页，而「我那条任务在第几页」正是要搜索的原因。
 */

const PAGE_SIZES = [20, 50, 100];
/** 池状态 10 秒一刷，与执行器面板同款：心跳本来就是这个量级，更快只会重画同一批数字。 */
const POOL_POLL_MS = 10_000;
/** 行内「执行中/排队中」随真实进度走：列表与池状态同一条 10 秒节奏静默刷新（不闪
    loading）。没有单独的按需事件可订阅——pipeline 的 SSE 事件是 run 详情页在消费，
    列表页再开一条只会多一份连接管理。 */
const TASK_POLL_MS = 10_000;
/** 行内展开拉最近 5 条（服务端同款默认 pageSize）。更多历史在全局报告页。 */
const HISTORY_PAGE_SIZE = 5;

/** run 状态 → RunStatusTag 的六值（与 run 详情页 `statusOf` 同一口径：ui.tsx 那个
    `toRunStatus` 不认识 pipeline 专属状态，aborted/timed_out 会落进 skip）。 */
function toRunStatus(status: PipelineRun["status"]): "pass" | "fail" | "running" | "queued" | "canceled" {
  if (status === "success") return "pass";
  if (status === "queued") return "queued";
  if (status === "canceled") return "canceled";
  if (status === "claimed" || status === "running" || status === "cancelling") return "running";
  return "fail";
}

function formatDuration(run: PipelineRun): string {
  const start = run.startedAt ? Date.parse(run.startedAt) : 0;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : 0;
  if (!start || !end || end < start) return "—";
  const seconds = (end - start) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60).toString().padStart(2, "0")}s`;
}

export function CiTaskList() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();

  const [items, setItems] = useState<CiTask[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState("");
  const debouncedKeyword = useDebounced(keyword);
  const [loading, setLoading] = useState(true);
  const [pool, setPool] = useState<RunnerPool>();
  const [running, setRunning] = useState<string>();
  /** 行内展开的执行历史（P4.5-15）：展开的任务 id → 最近几条 run。 */
  const [expanded, setExpanded] = useState<string>();
  const [historyRuns, setHistoryRuns] = useState<PipelineRun[]>();
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  /* 展开中的任务 id 走 ref：慢请求期间用户点了另一行是常态，落地前要核对「还在看它」。 */
  const expandedRef = useRef<string | undefined>(undefined);

  /** `silent`：轮询路径不闪 loading——列表数据在眼前，整表替换成一句「加载中」比
      旧数据多停 10 秒更刺眼。 */
  const load = useCallback(async (silent = false) => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    if (!silent) setLoading(true);
    try {
      const result = await api.ciTasks(projectId, page, pageSize, debouncedKeyword);
      /* 删掉本页最后一行后自动退一页，而不是停在一张空表上（与其它列表页同款）。 */
      if (!result.items.length && result.total > 0 && page > 1) { setPage(page - 1); return; }
      setItems(result.items);
      setTotal(result.total);
    } catch {
      if (!silent) message.error(t("ciTasks.loadFailed"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [projectId, loadedProjectId, projectLoading, page, pageSize, debouncedKeyword, t]);

  useEffect(() => { void load(); }, [load]);

  /* 静默轮询：行内的「执行中/排队中」要跟着 run 的真实状态走（触发后排队 → 认领 →
     执行 → 终态，终态后提示自然消失）。 */
  useEffect(() => {
    const timer = setInterval(() => { void load(true); }, TASK_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  /* Runner 池轮询。拉失败静默（`pool` 留 undefined）：顶部那一行缺席不该挡住任务列表，
     而一个假的「0 在线」比没有更糟——它会让人去重启一台其实活着的机器。 */
  useEffect(() => {
    let alive = true;
    const tick = () => api.runnerPool().then((next) => { if (alive) setPool(next); }).catch(() => {});
    void tick();
    const timer = setInterval(() => void tick(), POOL_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  /**
   * 触发一次全量执行（不带 `case_filter`——勾选执行是用例树上的入口，§8.3）。
   *
   * `Idempotency-Key` 在这里现生成是**对的**：这是一次「我现在要跑一遍」的新意图，没有
   * 需要跨重试保持的键。勾选执行那边不同，它在弹窗打开时就固定一个键，因为撞了 2004
   * 之后起完 Runner 再点是同一次意图（P4.5-8 的注释讲了这个区别）。
   */
  async function run(task: CiTask) {
    if (!projectId) return;
    setRunning(task.id);
    try {
      const created = await api.triggerCiTask(projectId, task.id, { idempotencyKey: crypto.randomUUID() });
      message.success(t("ciTasks.triggered", { number: created.runNumber }));
      navigate(`/projects/${projectId}/pipeline-runs/${created.id}`);
    } catch (error) {
      /* 2004 是「这个分区没有在线 Runner」，与「队列挂了」是两个处置动作（noRunnerLabel
         的单一判定，各执行入口共用）。 */
      const label = noRunnerLabel(error);
      message.error(label === undefined
        ? apiMessage(error) ?? t("ciTasks.triggerFailed")
        : t("ciTasks.noRunner", { label }));
    } finally {
      setRunning(undefined);
    }
  }

  /**
   * 删除。两段式（P4.5-12）：被调度 / Webhook 引用时服务端回 409 带引用清单，第二个确认框
   * 把清单列出来、`force` 之后连带删掉它们。这与环境、套件的删除是同一条纪律——留着一个
   * 悬空的调度就是每天到点记一行失败的僵尸。
   */
  function remove(task: CiTask) {
    if (!projectId) return;
    Modal.confirm({
      title: t("ciTasks.deleteTitle", { name: task.name }),
      /* 删除会级联掉这个任务的全部执行历史（迁移 038 的 ON DELETE CASCADE，刻意如此）。
         要留历史就停用而不是删——这句话必须在确认框里，删完再解释就晚了。 */
      content: t("ciTasks.deleteHint"),
      okText: t("action.delete"), cancelText: t("action.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        try { await api.deleteCiTask(projectId, task.id); await load(); message.success(t("ciTasks.deleted")); }
        catch (error) {
          const body = (error as { response?: { data?: { code?: number; data?: { schedules?: { name: string }[]; webhookTriggers?: { name: string }[] } } } })?.response?.data;
          if (body?.code !== 2003) { message.error(t("ciTasks.deleteFailed")); return; }
          const names = [
            ...(body.data?.schedules ?? []).map((each) => each.name),
            ...(body.data?.webhookTriggers ?? []).map((each) => each.name),
          ];
          Modal.confirm({
            title: t("ciTasks.deleteReferencedTitle", { count: names.length }),
            content: t("ciTasks.deleteReferencedHint", { names: names.join("、") }),
            okText: t("ciTasks.deleteReferencedConfirm"), cancelText: t("action.cancel"),
            okButtonProps: { danger: true },
            onOk: async () => {
              try { await api.deleteCiTask(projectId, task.id, true); await load(); message.success(t("ciTasks.deleted")); }
              catch { message.error(t("ciTasks.deleteFailed")); }
            },
          });
        }
      },
    });
  }

  /** 行内展开执行历史（P4.5-15，8.12 ②）：按 `ciTaskId` 拉最近几条，收起即清。 */
  async function toggleHistory(task: CiTask) {
    if (!projectId) return;
    if (expanded === task.id) { setExpanded(undefined); setHistoryRuns(undefined); return; }
    setExpanded(task.id);
    setHistoryRuns(undefined);
    setHistoryLoading(true);
    try {
      const result = await api.pipelineRuns(projectId, task.id, 1, HISTORY_PAGE_SIZE);
      /* 只在用户还在看这个任务时落地：慢请求期间点了另一行的展开是常态。 */
      if (expandedRef.current !== task.id) return;
      setHistoryRuns(result.items);
      setHistoryTotal(result.total);
    } catch {
      message.error(t("ciTasks.historyLoadFailed"));
      setExpanded(undefined);
    } finally {
      setHistoryLoading(false);
    }
  }
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);

  return <main className="content">
    <RepoPageHead
      title={t("ciTasks.title")}
      hint={t("ciTasks.hint")}
      actions={<button className="btn btn-primary btn-with-icon" onClick={() => navigate(`/projects/${projectId}/repo/tasks/new`)}>
        <Plus size={14} />{t("ciTasks.create")}
      </button>}
    />
    <RepoTabs active="tasks" />

    {/* Runner 池实时状态（交互 3.12.1）。「Runner」与「执行器」是两回事，这一句写明它，
        否则会被当成系统设置里那个面板的重复功能报上来（8.6）。 */}
    {pool && <>
      <div className="readouts">
        <Readout label={t("ciTasks.poolOnline")} value={`${pool.online}/${pool.total}`} />
        <Readout label={t("ciTasks.poolCapacity")} value={pool.capacity} />
        <Readout label={t("ciTasks.poolInflight")} value={pool.inflight} />
        {/* 空闲 = 槽位 − 在途，夹到 0：draining 的机器仍在跑活但不再贡献槽位，差值可以为负。 */}
        <Readout label={t("ciTasks.poolIdle")} value={Math.max(0, pool.capacity - pool.inflight)} />
        <Readout label={t("ciTasks.poolQueued")} value={pool.queued} tone={pool.queued > 0 && pool.online === 0 ? "fail" : undefined} />
      </div>
      <p className="form-note">{pool.online === 0 ? t("ciTasks.poolEmptyHint") : t("ciTasks.poolHint")}</p>
    </>}

    {/* 关键字搜索（服务端 ILIKE：名称 / 描述 / Git 地址）。改关键字回第一页——留在
        第 3 页搜出 2 条结果就是一张空表。 */}
    <div className="filter-bar">
      <input
        className="input"
        value={keyword}
        onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
        placeholder={t("ciTasks.searchPlaceholder")}
      />
    </div>

    {loading && <p className="muted">{t("common.loading")}</p>}

    {!loading && (items.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th className="col-expand" />
        <th>{t("ciTasks.name")}</th>
        <th>{t("ciTasks.gitUrl")}</th>
        <th>{t("ciTasks.gitRef")}</th>
        <th>{t("ciTasks.sandboxMode")}</th>
        <th>{t("ciTasks.runnerLabel")}</th>
        <th className="col-num">{t("ciTasks.timeout")}</th>
        {/* 最近执行列（2026-09-02 第三批 ⑦：移到执行分区/超时之后）——收起行的
            「上次结果 + 跑过几次」，配置列读完了再读结论。 */}
        <th className="col-lastrun">{t("ciTasks.lastRun")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {items.map((task) => <CiTaskRow
          key={task.id}
          task={task}
          expanded={expanded === task.id}
          historyRuns={expanded === task.id ? historyRuns : undefined}
          historyTotal={historyTotal}
          historyLoading={historyLoading && expanded === task.id}
          running={running === task.id}
          onToggleHistory={() => void toggleHistory(task)}
          onEdit={() => navigate(`/projects/${projectId}/repo/tasks/${task.id}`)}
          onRun={() => void run(task)}
          onDelete={() => remove(task)}
          onOpenRun={(runId) => navigate(`/projects/${projectId}/pipeline-runs/${runId}`)}
        />)}
      </tbody>
    </table></div> : <Empty
      title={debouncedKeyword ? t("ciTasks.emptyFilteredTitle") : t("ciTasks.emptyTitle")}
      hint={debouncedKeyword ? t("suites.emptyFilteredHint") : t("ciTasks.emptyHint")}
      action={debouncedKeyword
        ? <button className="btn" onClick={() => { setKeyword(""); setPage(1); }}>{t("filter.clear")}</button>
        : <button className="btn btn-primary" onClick={() => navigate(`/projects/${projectId}/repo/tasks/new`)}>{t("ciTasks.create")}</button>}
    />)}

    {items.length > 0 && <div className="pager">
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

function CiTaskRow({ task, expanded, historyRuns, historyTotal, historyLoading, running, onToggleHistory, onEdit, onRun, onDelete, onOpenRun }: {
  task: CiTask;
  expanded: boolean;
  historyRuns: PipelineRun[] | undefined;
  historyTotal: number;
  historyLoading: boolean;
  running: boolean;
  onToggleHistory: () => void;
  onEdit: () => void;
  onRun: () => void;
  onDelete: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useTranslation();
  /* 提前解构：onClick 闭包里 TS 不保留可选链的收窄（参数绑定不是 const），解构后
     activeRun 在块内是稳定引用。 */
  const activeRun = task.activeRun;
  const activeCount = task.activeRunCount ?? 1;
  const lastRun = task.lastRun;
  const runTotal = task.runTotal;

  return <>
    <tr
      data-clickable=""
      data-removed={task.enabled ? undefined : ""}
      onClick={onEdit}
    >
      <td className="col-expand" onClick={(event) => { event.stopPropagation(); onToggleHistory(); }}>
        <button className="btn btn-icon" aria-label={t("ciTasks.history")} aria-expanded={expanded}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </td>
      <td>
        <span className="cell-name">
          <span className="truncate">{task.name}</span>
          {!task.enabled && <span className="chip chip-warn">{t("ciTasks.disabledChip")}</span>}
          {/* 在途状态不在这里重复（2026-09-03 用户改口径）：「最近执行」列指同一条 run，
              名字列保留「这是什么任务」这一件事就够了。 */}
        </span>
        {task.description && <span className="cell-description truncate">{task.description}</span>}
      </td>
      <td>
        <span className="mono truncate" title={task.gitUrl}>{task.gitUrl}</span>
        {/* 凭据名跟着地址走：它回答「这条地址是用哪把 key 拉的」，分成两列会让两个
            本来要一起读的事实隔开。没引用凭据时说「公开仓库」而不是留空。 */}
        <span className="cell-description truncate">
          {task.gitCredentialName ?? t("ciTasks.gitCredentialNone")}
        </span>
      </td>
      <td className="mono">{task.gitRef}</td>
      <td>{t(task.sandboxMode === "container" ? "ciTasks.sandboxContainerShort" : "ciTasks.sandboxProcessShort")}</td>
      {/* default 用 muted 而不是留空：空单元格读成「没配」，事实是「平台所在网段」。 */}
      <td className={`mono${task.runnerLabel === "default" ? " muted" : ""}`}>{task.runnerLabel}</td>
      <td className="col-num mono">{Math.round(task.timeoutSeconds / 60)}m</td>
      {/* 最近执行（验收反馈 ⑦ + 第三批 ⑦ 列序；2026-09-03 在途状态也收进这一列）：
          有在途 run 时显示它（状态词 + 可点 #序号，并行多条 hover 说全），否则显示最近
          一条的结论 + 规模——「上次是过还是挂、一共跑过几次」收起行也要回答。 */}
      <td className="col-lastrun">
        {activeRun ? <>
          <span className="cell-name">
            <RunStatusTag status={toRunStatus(activeRun.status)} />
            <Tip text={activeCount > 1 ? t("ciTasks.activeRunCount", { count: activeCount }) : undefined}>
              <button
                className="cell-link mono"
                onClick={(event) => { event.stopPropagation(); onOpenRun(activeRun.id); }}
              >#{activeRun.runNumber}</button>
            </Tip>
          </span>
          {runTotal !== undefined && <span className="cell-description mono">{t("ciTasks.runTotal", { count: runTotal })}</span>}
        </> : lastRun ? <>
          <span className="cell-name">
            <RunStatusTag status={toRunStatus(lastRun.status)} />
            <button
              className="cell-link mono"
              onClick={(event) => { event.stopPropagation(); onOpenRun(lastRun.id); }}
            >#{lastRun.runNumber}</button>
          </span>
          {runTotal !== undefined && <span className="cell-description mono">{t("ciTasks.runTotal", { count: runTotal })}</span>}
        </> : <span className="muted">{t("ciTasks.runNever")}</span>}
      </td>
      <td className="col-actions" onClick={(event) => event.stopPropagation()}>
        <div className="row-actions">
          {/* 停用的任务触发会被服务端拒（400）：按钮直接禁用而不是让它去撞那个错误。 */}
          <Tip text={task.enabled ? undefined : t("ciTasks.disabledCannotRun")}>
            <span><IconButton icon={<Play size={14} />} label={t("ciTasks.run")} disabled={!task.enabled || running} onClick={onRun} /></span>
          </Tip>
          <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={onEdit} />
          <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={onDelete} />
        </div>
      </td>
    </tr>
    {expanded && <tr className="detail-row">
      <td colSpan={9} style={{ padding: 0 }}>
        {historyLoading && <p className="muted" style={{ padding: "var(--s3) var(--s4)" }}>{t("common.loading")}</p>}
        {historyRuns && (historyRuns.length ? <>
          <table className="grid history-inline">
            <thead><tr>
              <th className="mono">{t("ciTasks.historyRunNumber")}</th>
              <th className="col-status">{t("endpoints.status")}</th>
              <th>{t("ciTasks.historyTrigger")}</th>
              {/* 计数列（2026-09-02 验收反馈「总和信息」）：不展开到 run 详情页也要
                  读到「跑了多少、过了多少」——与执行记录页的父执行列表同一组列。 */}
              <th className="col-num">{t("reports.itemCount")}</th>
              <th className="col-num">{t("status.pass")}</th>
              <th className="col-num">{t("status.fail")}</th>
              <th className="col-num">{t("pipelineRun.duration")}</th>
              <th className="col-num">{t("ciTasks.historyStartedAt")}</th>
            </tr></thead>
            <tbody>
              {historyRuns.map((run) => <tr key={run.id} data-clickable="" onClick={() => onOpenRun(run.id)}>
                <td className="mono">#{run.runNumber}</td>
                <td className="col-status">
                  <RunStatusTag status={toRunStatus(run.status)} />
                </td>
                <td>{t(`pipelineRun.trigger.${run.triggerSource}`)}</td>
                <td className="col-num mono">{run.caseTotal}</td>
                <td className="col-num mono">{run.passedCount}</td>
                <td className="col-num mono">{run.failedCount > 0 ? <span className="text-fail">{run.failedCount}</span> : "0"}</td>
                <td className="col-num mono">{formatDuration(run)}</td>
                <td className="col-num mono">{run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}</td>
              </tr>)}
            </tbody>
          </table>
          {historyTotal > historyRuns.length && <p className="form-note" style={{ padding: "0 var(--s4) var(--s3)" }}>
            {t("ciTasks.historyMore", { shown: historyRuns.length, total: historyTotal })}
          </p>}
        </> : !historyLoading && <p className="muted" style={{ padding: "var(--s3) var(--s4)" }}>{t("ciTasks.historyEmpty")}</p>)}
      </td>
    </tr>}
  </>;
}
