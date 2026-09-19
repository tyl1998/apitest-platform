import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Drawer, message, Select } from "antd";
import { useTranslation } from "react-i18next";
import { useOutletContext, useParams, useSearchParams } from "react-router-dom";

import { ChevronDown, ChevronRight, Download, Paperclip } from "lucide-react";
import { api, type AllureReportAttachment, type AllureReportCase, type AllureReportStep, type AllureReportView, type Artifact, type PipelineRun, type PipelineRunCase } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { useExecutionStream } from "../hooks/useExecutionStream";
import { useCanWrite } from "../hooks/useMyRole";
import { usePageContext } from "../hooks/usePageContext";
import { triggerLabel } from "../lib/trigger";
import { Empty, PageToolbar, Readout, Status, Tip, type RunStatus } from "../ui";
import { AttributionDrawer, AttributionTag, type AttributionRequest } from "./AttributionDrawer";
import { formatMsTick, niceMsStep } from "./charts";
import { RepoPageHead } from "./RepoShell";
import { type DetailCrumbContext } from "./ProjectShell";
import { ShareReportButton } from "./ShareReportButton";

/**
 * pipeline run 执行详情页（P4.5-11 + P4.5-13；2026-09-02 起三 tab）。
 *
 * 三个 tab（?tab=log|report|artifacts）：
 * - log：SSE 水位事件驱动 `?offset=` 增量拉取（事件不带内容——8.6 的纪律）；
 * - report：**合并视图**（原 cases tab 并入）——通过率/计数/耗时的概要读数 +
 *   timeline gantt + allure 用例明细（标题/注释/步骤/步骤日志；点开是抽屉，
 *   2026-09-02 第三批 ②）。没有 allure 包时降级为 `pipeline_run_cases` 的纯列表
 *   （junit 任务是正常态）；
 * - artifacts：产物列表 + 5 分钟短活直链下载。
 *
 * 报告主体抽成 `PipelineReportBody`：分享页（免登录只读）回的是同一份数据形状，
 * 两处共用一个渲染，免得「站内看到的」与「分享出去的」长成两份口径。
 */

type TabKey = "log" | "report" | "artifacts";
const TABS: TabKey[] = ["log", "report", "artifacts"];
const STAGES: PipelineRun["stage"][] = ["clone", "cache", "script", "report"];
const TERMINAL_STATUSES = ["success", "failed", "canceled", "aborted", "timed_out"];

/** run 状态 → 设计系统 Status 的六值（aborted/timed_out 归 fail——与 execution_index 归一同一口径）。 */
function statusOf(run: PipelineRun): "pass" | "fail" | "skip" | "running" | "queued" | "canceled" {
  if (run.status === "success") return "pass";
  if (run.status === "queued") return "queued";
  if (run.status === "canceled") return "canceled";
  if (run.status === "claimed" || run.status === "running" || run.status === "cancelling") return "running";
  return "fail";
}

function isTerminal(run: PipelineRun | undefined): boolean {
  return !!run && TERMINAL_STATUSES.includes(run.status);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

/**
 * 墙钟时刻。固定 24 小时制（`hourCycle: "h23"`）：时间轴的刻度与这里的读数要能互相
 * 对照，而 `toLocaleTimeString()` 的默认在 en 语境下是 12 小时制——同一个时刻在图上
 * 写 `16:22:44`、在读数里写 `4:22:44 PM` 就没法对照了。
 */
function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hourCycle: "h23" });
}

/** allure 状态词 → 中文（缺省回原文：allure 的状态词是开放集合）。 */
function reportStatusLabel(t: (key: string) => string, status: string): string {
  const known = ["passed", "failed", "broken", "skipped", "unknown", "interrupted"];
  return known.includes(status) ? t(`pipelineRun.reportStatus.${status}`) : status;
}

/** allure 状态 → 状态点的语义色（broken/unknown/interrupted 都读作失败）。 */
function dotStatus(status: string): string {
  return status === "passed" || status === "failed" || status === "skipped" ? status : "error";
}

/**
 * allure 状态 → 设计系统 Status 的值（2026-09-02 验收反馈 ⑪）。
 *
 * 状态列原先是纯文本，只有行首的点带颜色——一列写着「失败」的黑字要靠 8px 的点去分辨。
 * 颜色由这个映射给（broken/unknown/interrupted 都是失败色），**词仍用 allure 的原词**
 * （错误 / 中断 / 未知）：颜色说结论，词说为什么。
 */
function reportRunStatus(status: string): RunStatus {
  if (status === "passed") return "pass";
  if (status === "skipped") return "skip";
  return "fail";
}

/** `pipeline_run_cases.status` → 设计系统 Status（error 与 failed 同色，同上）。 */
function caseRunStatus(status: PipelineRunCase["status"]): RunStatus {
  if (status === "passed") return "pass";
  if (status === "skipped") return "skip";
  return "fail";
}

/**
 * 用例的**函数名**：`fullName` 是 pytest 的 nodeid（`test_case.projects.test_projects#
 * test_list_projects_returns_envelope`），`#` 之后那段就是函数名。没有 `#` 的（其它
 * allure 适配器）整串就是它，再按 `::` 取尾。
 */
function caseFunctionName(row: AllureReportCase): string {
  const tail = row.fullName.split("#").pop() ?? row.fullName;
  return tail.split("::").pop() ?? tail;
}

/** 参数化后缀：allure 的 `name` 在没有 title 时是 `test_foo[param-id]`。 */
const PARAM_SUFFIX = /\[[^[\]]*\]$/;

/**
 * 列表里显示的用例标题（2026-09-02 验收反馈 ④）。
 *
 * allure 的 `name` 在有 `@allure.title(...)` 时就是标题，没有时它**等于函数名**（参数化
 * 用例是 `函数名[参数 id]`）——而「用例列表里读到一串
 * `test_list_projects_project_ids_drops_invalid`」正是被报上来的问题。所以少了 title 的
 * 用例退一步读 `description`（pytest 的 docstring，解析器已经收了）的第一行，并把参数
 * 后缀接回去（两条参数化用例的 docstring 相同，不带后缀就分不出是哪一条）；docstring
 * 也没有才回落函数名。
 *
 * 函数名不丢：它作为副标题跟在标题下面（`caseSubName`），因为「去仓库里搜哪个函数」
 * 需要的正是它。
 */
function caseTitle(row: AllureReportCase): string {
  const fn = caseFunctionName(row);
  const suffix = row.name.match(PARAM_SUFFIX)?.[0] ?? "";
  /* 去掉参数后缀后仍等于函数名 = 这条用例没有 title。 */
  if (row.name.slice(0, row.name.length - suffix.length) !== fn) return row.name || fn;
  const firstLine = row.description?.split("\n").map((line) => line.trim()).find((line) => line.length);
  return firstLine ? `${firstLine}${suffix}` : row.name || fn;
}

/** 副标题：标题已经是函数名（可能带参数后缀）时不重复显示。 */
function caseSubName(row: AllureReportCase): string | undefined {
  const fn = caseFunctionName(row);
  const title = caseTitle(row);
  return title === fn || title.slice(0, title.length - (title.match(PARAM_SUFFIX)?.[0].length ?? 0)) === fn ? undefined : fn;
}

/** 报告用例表 / 降级列表共用的状态筛选值（`all` + 设计系统的三个结论）。 */
const CASE_FILTERS = ["all", "failed", "passed", "skipped"] as const;
type CaseFilter = (typeof CASE_FILTERS)[number];

/** 状态筛选的判定：`failed` 收 broken/unknown/interrupted/error——它们都是「没通过」。 */
function matchesFilter(status: string, filter: CaseFilter): boolean {
  if (filter === "all") return true;
  if (filter === "passed") return status === "passed";
  if (filter === "skipped") return status === "skipped";
  return status !== "passed" && status !== "skipped";
}

/** 文本类附件（第三批 ① 起收整个附件引用）：展示名是 pytest 捕获的 `log` / `stdout` /
    `stderr`（allure 在没有 `--allure-no-capture` 时附上），或实体/展示名以 `.log` /
    `.txt` 结尾。它们进「执行日志」块并默认展开。 */
function isLogAttachment(attachment: AllureReportAttachment): boolean {
  return /^(log|stdout|stderr)$/i.test(attachment.name.trim())
    || /\.(log|txt)$/i.test(attachment.source)
    || /\.(log|txt)$/i.test(attachment.name);
}

/* ── 归因（P8-3）：allure 视图行 ↔ DB 用例行的匹配 ──────────────────────────── */

/**
 * 视图行与 DB 行的匹配键。两边读的是**同一批 allure 结果文件**（视图 = 报告包 zip 的
 * 解析，DB 行 = Runner complete 时上报的 cases[]），`name` 与 `start`/`stop` 都是文件
 * 原字的透传——拼成复合键稳定可靠；同名参数化用例靠时间戳区分。
 *
 * 不能用视图的 `uid` 匹配 `external_id`：视图解析读的是 `parsed.uid`，而 allure 结果
 * 文件的标识字段叫 `uuid`，`uid` 实际是 name 兜底——两个键根本不是一个东西。缺时间戳
 * 的行两边都缺，键退化为纯 name，仍能对上。
 */
function viewCaseKey(name: string, start?: number, stop?: number): string {
  return `${name}|${start ?? ""}|${stop ?? ""}`;
}

function dbCaseKey(row: PipelineRunCase): string {
  return `${row.caseName}|${row.startedAtMs ?? ""}|${row.finishedAtMs ?? ""}`;
}

export function PipelineRunPage() {
  const { t } = useTranslation();
  const { projectId, runId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  const stream = useExecutionStream(projectId);
  const [searchParams, setSearchParams] = useSearchParams();
  /* 面包屑长出「任务名 #序号」（ProjectShell 的 detailTitle 通道）——与执行记录
     runner 行的身份（execution_index.target_name）同一个词（P8-6 验收反馈）。 */
  const { setDetailTitle } = useOutletContext<DetailCrumbContext>();
  /* viewer：取消（一次写）与分享创建不渲染（P6-4）；日志/报告/产物照读。 */
  const canWrite = useCanWrite();

  /* 旧链接里的 ?tab=cases 已并入 report：不在 TABS 里就落回默认，不硬跳。 */
  const tabParam = searchParams.get("tab") as TabKey | null;
  const tab: TabKey = tabParam && TABS.includes(tabParam) ? tabParam : "log";

  const [run, setRun] = useState<PipelineRun & { blockedBy?: number }>();
  const [logText, setLogText] = useState("");
  const [logOffset, setLogOffset] = useState(0);
  const [cases, setCases] = useState<PipelineRunCase[]>();
  const [report, setReport] = useState<AllureReportView | null>(null);
  const [reportLoaded, setReportLoaded] = useState(false);
  const [artifacts, setArtifacts] = useState<(Artifact & { downloadUrl: string })[]>();
  const [cancelBusy, setCancelBusy] = useState(false);
  const logBox = useRef<HTMLPreElement>(null);

  /* 助手页面上下文（P9-4c）：URL 已带 runId，这里补任务语境与当前 tab——「npm install
     超时帮我看看」时 agent 知道用户正停在日志页还是报告页。 */
  usePageContext(runId ? {
    page: "pipeline-run",
    entities: {
      runId,
      ...(run ? { taskId: run.ciTaskId, runNumber: String(run.runNumber) } : {}),
      ...(run?.taskName ? { taskName: run.taskName } : {}),
    },
    focus: tab,
  } : undefined);

  /* 附件取数器：useCallback 固定身份（2026-09-02 验收反馈第三批 ①）。它原先每次渲染
     都是新函数，AttachmentView 的 effect 依赖它 → 任何一次父级重渲染（SSE 日志事件、
     run 轮询）都会把在途请求的 cleanup 触发掉，响应回来被丢弃，状态永远停在「正在加
     载」。身份稳定后 effect 不再空转，请求能落地。 */
  const loadAttachment = useCallback(
    (source: string) => api.pipelineRunAttachment(projectId!, runId!, source),
    [projectId, runId],
  );

  /* ── 详情 + SSE ─────────────────────────────────────────────────────────── */

  const reload = useCallback(() => {
    if (!projectId || !runId) return;
    void api.pipelineRun(projectId, runId)
      .then((next) => setRun(next))
      .catch(() => message.error(t("pipelineRun.loadFailed")));
  }, [projectId, runId, t]);

  useEffect(() => {
    if (!projectId || !runId || loadedProjectId !== projectId || projectLoading) return;
    reload();
  }, [projectId, runId, loadedProjectId, projectLoading, reload]);

  useEffect(() => {
    setDetailTitle(run ? (run.taskName ? `${run.taskName} #${run.runNumber}` : `#${run.runNumber}`) : undefined);
    return () => setDetailTitle(undefined);
  }, [run?.runNumber, run, setDetailTitle]);

  /* SSE：pipeline 事件推进状态/阶段，pipelineLog 水位事件触发日志增量拉取。终态后
     停止拉取（事件流仍开着——同一个项目里别的 run 还要用）。offset 走 ref：effect
     不因每次拉取而重订阅，闭包里的值却要是最新的。 */
  const logOffsetRef = useRef(0);
  useEffect(() => { logOffsetRef.current = logOffset; }, [logOffset]);

  useEffect(() => {
    if (!projectId || !runId) return;
    let fetching = false;
    let pending = false;
    const pullLogs = async (from: number) => {
      if (fetching) { pending = true; return; }
      fetching = true;
      let offset = from;
      try {
        for (;;) {
          const chunk = await api.pipelineRunLogs(projectId, runId, offset);
          if (chunk.text) setLogText((current) => current + chunk.text);
          offset = chunk.nextOffset;
          if (offset >= chunk.totalBytes) break;
        }
        logOffsetRef.current = offset;
        setLogOffset(offset);
      } catch {
        /* 单次失败等下一个水位事件重试——SSE 的存在保证了还有下一次。 */
      } finally {
        fetching = false;
        if (pending) { pending = false; void pullLogs(logOffsetRef.current); }
      }
    };
    stream.onEvent((event) => {
      if (event.kind === "pipeline" && event.pipelineRunId === runId) {
        reload();
        if (TERMINAL_STATUSES.includes(event.status)) {
          /* 终态后刷一次计数与报告（cases 已落库、报告包可能刚传完）。 */
          setCases(undefined);
          setArtifacts(undefined);
          setReport(null);
          setReportLoaded(false);
        }
      }
      if (event.kind === "pipelineLog" && event.pipelineRunId === runId) {
        if (event.logBytes > logOffsetRef.current) void pullLogs(logOffsetRef.current);
      }
    });
    return () => stream.onEvent(undefined);
  }, [projectId, runId, stream, reload]);

  /* 非 SSE 环境（轮询降级）或刷新后：先拉一次已有日志。 */
  useEffect(() => {
    if (!projectId || !runId || !run || run.logBytes === 0) return;
    if (logText) return;
    let alive = true;
    void api.pipelineRunLogs(projectId, runId, 0, 512 * 1024)
      .then((chunk) => { if (alive) { setLogText(chunk.text); setLogOffset(chunk.nextOffset); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [projectId, runId, run, logText]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 日志自动滚底：只在用户本来就在底部附近时滚（阅读中间内容时不抢滚动条）。 */
  useEffect(() => {
    const box = logBox.current;
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }, [logText]);

  /* ── tab 数据按需拉 ─────────────────────────────────────────────────────── */

  /* report tab（合并视图）要两份数据：cases（timeline + junit 降级列表）与 allure
     视图。一次 effect 里各自按需拉，互不阻塞。 */
  useEffect(() => {
    if (!projectId || !runId || tab !== "report") return;
    if (!cases) {
      void api.pipelineRunCases(projectId, runId)
        .then((rows) => setCases(rows))
        .catch(() => message.error(t("pipelineRun.loadFailed")));
    }
    if (!reportLoaded) {
      void api.pipelineRunReport(projectId, runId)
        .then((view) => { setReport(view ?? null); setReportLoaded(true); })
        .catch(() => { setReportLoaded(true); message.error(t("pipelineRun.reportLoadFailed")); });
    }
  }, [projectId, runId, tab, cases, reportLoaded, t]);

  useEffect(() => {
    if (!projectId || !runId || tab !== "artifacts" || artifacts) return;
    void api.pipelineRunArtifacts(projectId, runId)
      .then((rows) => setArtifacts(rows))
      .catch(() => message.error(t("pipelineRun.loadFailed")));
  }, [projectId, runId, tab, artifacts, t]);

  async function cancelRun() {
    if (!projectId || !runId) return;
    setCancelBusy(true);
    try {
      await api.cancelPipelineRun(projectId, runId);
      reload();
    } catch {
      message.error(t("pipelineRun.cancelFailed"));
    } finally {
      setCancelBusy(false);
    }
  }

  if (!run) {
    return <main className="content">
      <RepoPageHead title={t("pipelineRun.title")} hint={t("pipelineRun.hint")} />
      <p className="muted">{projectLoading || !projectId ? t("common.loading") : t("pipelineRun.loadFailed")}</p>
    </main>;
  }

  const status = statusOf(run);
  const stageIndex = run.stage === "done" ? STAGES.length : STAGES.indexOf(run.stage);

  return <main className="content content-split">
    <PageToolbar>
    {/* 页头与面包屑同一个身份（P8-6 验收反馈四轮②）：任务名 #序号——「仓库执行」
        只在任务已删除、名字拿不到时兜底（LEFT JOIN 落空），历史链接不断。 */}
    <RepoPageHead
      title={`${run.taskName ?? t("pipelineRun.title")} #${run.runNumber}`}
      hint={t("pipelineRun.hint")}
      actions={<>
        {/* 分享是报告的固有能力（2026-09-02）：免登录只读链接，任何状态的 run 都可分享。 */}
        {projectId && canWrite && <ShareReportButton projectId={projectId} targetType="runner" targetId={run.id} />}
        {canWrite && !isTerminal(run) && run.status !== "cancelling" && (
          <button className="btn" disabled={cancelBusy} onClick={() => void cancelRun()}>{t("pipelineRun.cancel")}</button>
        )}
      </>}
    />
    </PageToolbar>

    <div className="list-card">
    <div className="list-scroll">
    {/* 概要事实块（2026-09-02 验收反馈 ②）：状态 / 阶段 / 提交 / 触发 / 结果各占一格，
        带标签、竖线分隔。原先是一整行纯文本混排——阶段词、commit 与三个计数挤在同一条
        基线上，读的人得先分辨「哪几个字是一组」才能开始读内容。 */}
    <div className="pipeline-facts">
      <div className="pipeline-fact">
        <span className="label">{t("pipelineRun.factStatus")}</span>
        <span className="pipeline-fact-value">
          <span className="status" data-status={status}><span className="status-mark" />{t(`pipelineRun.status.${run.status}`)}</span>
        </span>
      </div>
      <div className="pipeline-fact">
        <span className="label">{t("pipelineRun.factStage")}</span>
        <span className="pipeline-fact-value">
          <span className="pipeline-stages" role="progressbar" aria-valuenow={stageIndex} aria-valuemax={STAGES.length}>
            {STAGES.map((stage, index) => (
              <span key={stage} className={`pipeline-stage${index < stageIndex ? " is-done" : ""}${run.stage === stage ? " is-current" : ""}`}>
                {t(`pipelineRun.stage.${stage}`)}
              </span>
            ))}
          </span>
        </span>
      </div>
      <div className="pipeline-fact">
        <span className="label">{t("pipelineRun.factCommit")}</span>
        <span className="pipeline-fact-value mono truncate">
          {run.gitRef}{run.commitSha ? <span className="muted">&nbsp;@&nbsp;{run.commitSha.slice(0, 8)}</span> : null}
        </span>
      </div>
      <div className="pipeline-fact">
        <span className="label">{t("pipelineRun.factTrigger")}</span>
        {/* 触发（P11-8）：触发源「引用名」 · 触发人，与报告列表、运行抽屉同一份拼法
            （`lib/trigger` 的 triggerLabel）。null 触发人 = 非人工（边界 11）。 */}
        <span className="pipeline-fact-value truncate">
          {triggerLabel(t, run.triggerSource, run.triggerRefName, run.triggeredByEmail)}
        </span>
      </div>
      {/* 计数只在终态出现（在途时它们还在变），四个 chip 而不是一句拼接文本：失败数
          带语义色，扫一眼就知道这份报告要不要读下去。 */}
      {isTerminal(run) && <div className="pipeline-fact">
        <span className="label">{t("pipelineRun.factResult")}</span>
        <span className="pipeline-fact-value">
          <span className="chip mono">{t("pipelineRun.caseTotal")} {run.caseTotal}</span>
          <span className="chip mono">{t("status.pass")} {run.passedCount}</span>
          <span className={`chip mono${run.failedCount > 0 ? " chip-fail" : ""}`}>{t("status.fail")} {run.failedCount}</span>
          <span className="chip mono">{t("status.skip")} {run.skippedCount}</span>
        </span>
      </div>}
    </div>

    {/* 整句说明不进事实格：它们要占满一行才读得完。 */}
    {(run.blockedBy !== undefined || run.error) && <div className="pipeline-notes">
      {/* 被任务级串行挡住的排队 run（P4.5-12）：说清「在等谁」。不说的话，一条一直排队的
          run 与「分区没有在线 Runner」在界面上一模一样，而后者要人去起一台机器。 */}
      {run.blockedBy !== undefined && <span className="muted">{t("pipelineRun.blockedBy", { number: run.blockedBy })}</span>}
      {run.error && <span className="pipeline-error mono" title={run.error}>{run.error}</span>}
    </div>}

    <div className="tabs" role="tablist" style={{ paddingInline: 0, marginBottom: "var(--s4)" }}>
      {TABS.map((key) => <button
        key={key}
        role="tab"
        aria-selected={tab === key}
        className={`tab${tab === key ? " is-active" : ""}`}
        onClick={() => setSearchParams((current) => { current.set("tab", key); return current; }, { replace: true })}
      >{t(`pipelineRun.tab.${key}`)}</button>)}
    </div>

    {tab === "log" && <PipelineLogTab logBox={logBox} text={logText} run={run} projectId={projectId} runId={runId} />}
    {tab === "report" && (
      <PipelineReportBody
        run={run}
        cases={cases}
        report={report}
        reportLoaded={reportLoaded}
        loadAttachment={projectId && runId ? loadAttachment : undefined}
        projectId={projectId}
        canWrite={canWrite}
        /* 归因落库后重拉 cases：置 undefined 触发本页的按需加载 effect，随行归因跟上。 */
        onAttributed={() => setCases(undefined)}
      />
    )}
    {tab === "artifacts" && <PipelineArtifactsTab artifacts={artifacts} />}
    </div>
    </div>
  </main>;
}

/* ── log tab ───────────────────────────────────────────────────────────────── */

function PipelineLogTab({ logBox, text, run, projectId, runId }: {
  logBox: RefObject<HTMLPreElement>; text: string; run: PipelineRun; projectId?: string; runId?: string;
}) {
  const { t } = useTranslation();
  return <>
    {/* 整份日志下载（P4.5-15，8.12 ③）：实时与历史都在这一页是 P4.5-11 就有的事实，
        入口可见性靠这个按钮补齐。链接直连下载路由（鉴权 cookie/头与 axios 同源共享，
        不经 axios——下载是浏览器原生流，包进 XHR 只会把几 MB 日志读进内存再吐出来）。 */}
    <div className="filter-bar">
      <span className="muted">{isTerminal(run) ? t("pipelineRun.logTerminalHint") : t("pipelineRun.logStreamingHint")}</span>
      <span className="filter-spacer" />
      {projectId && runId && run.logBytes > 0 && (
        <a className="btn btn-small btn-with-icon" href={`/api/v1/projects/${projectId}/pipeline-runs/${runId}/logs/download`}>
          <Download size={14} />{t("pipelineRun.downloadLog")}
        </a>
      )}
    </div>
    {text
      ? <pre ref={logBox} className="pipeline-log mono">{text}</pre>
      : <Empty title={t("pipelineRun.logEmptyTitle")} hint={isTerminal(run) ? t("pipelineRun.logEmpty") : t("pipelineRun.logWaiting")} />}
  </>;
}

/* ── report tab：概要 + timeline + 用例明细（合并视图）─────────────────────── */

/**
 * 报告主体（详情页 report tab 与分享页共用）。
 *
 * 三段回答验收反馈的三个问题：「通过了哪些」（概要读数）、「有哪些耗时」（timeline
 * + 每行耗时列）、「执行了什么」（用例明细：标题/注释/步骤/日志——点开是抽屉，不是
 * 表格里的下拉展开行）。
 *
 * `loadAttachment` 是附件的取数器（详情页走带 Bearer 头的 axios，分享页走公开路由），
 * 参数是报告包内的实体文件名（allure 的 `source`）。
 */
export function PipelineReportBody({ run, cases, report, reportLoaded, loadAttachment, projectId, canWrite, onAttributed }: {
  run: PipelineRun;
  cases: PipelineRunCase[] | undefined;
  report: AllureReportView | null;
  reportLoaded: boolean;
  loadAttachment?: (source: string) => Promise<Blob>;
  /** 站内详情页传入（打标入口需要）；分享页缺省——归因 chip 只读。 */
  projectId?: string;
  canWrite?: boolean;
  /** 归因落库后的刷新回调（详情页重拉 cases，随行归因跟上）。 */
  onAttributed?: () => void;
}) {
  const { t } = useTranslation();

  const durationMs = run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
  const queueMs = run.startedAt ? Date.parse(run.startedAt) - Date.parse(run.createdAt) : null;
  /* 通过率口径（2026-09-03 用户改口径）：分母 = 通过 + 失败（`failed_count` 已含 error——
     Runner 把 allure broken/unknown 映射成 error、服务端计数把 error 归入失败），跳过
     不进分母——一条被 skip 的用例没有给出结论，把它算进「没通过」会拉低读数。 */
  const judgedCount = run.passedCount + run.failedCount;
  const passRate = judgedCount > 0 ? (run.passedCount / judgedCount) * 100 : null;

  /* timeline 只在全部行都有时间戳时展示；一部分缺（junit 混 allure / 旧 Runner）时
     不画——半张时间轴比没有更误导。 */
  const timed = useMemo(
    () => (cases ?? []).filter((each) => typeof each.startedAtMs === "number" && typeof each.finishedAtMs === "number"),
    [cases],
  );
  const showTimeline = Boolean(cases?.length) && timed.length === (cases?.length ?? 0);

  /* 视图行 → DB 用例行（归因目标住在 DB 行上，见 viewCaseKey 的注释）。 */
  const caseByViewKey = useMemo(() => {
    const map = new Map<string, PipelineRunCase>();
    for (const row of cases ?? []) map.set(dbCaseKey(row), row);
    return map;
  }, [cases]);

  if (!cases || !reportLoaded) return <p className="muted">{t("common.loading")}</p>;

  return <>
    {/* 概要读数：通过率/计数/耗时一眼可读（「报告执行了什么、通过了哪些」的总和段）。 */}
    <div className="readouts">
      <Readout label={t("suiteReports.passRate")} value={passRate === null ? "—" : passRate.toFixed(1)} unit={passRate === null ? undefined : "%"} tone={passRate !== null && passRate >= 100 ? "pass" : undefined} />
      <Readout label={t("pipelineRun.caseTotal")} value={run.caseTotal} />
      <Readout label={t("status.pass")} value={run.passedCount} tone="pass" />
      <Readout label={t("status.fail")} value={run.failedCount} tone={run.failedCount > 0 ? "fail" : undefined} />
      <Readout label={t("status.skip")} value={run.skippedCount} />
      <Readout label={t("pipelineRun.duration")} value={durationMs === null ? "—" : formatDuration(durationMs)} />
      <Readout label={t("suiteReports.queueTime")} value={queueMs === null ? "—" : formatDuration(queueMs)} />
    </div>

    {showTimeline && <TimelineGantt cases={cases!} />}
    {report && report.skippedFiles > 0 && (
      <p className="form-note">{t("pipelineRun.reportSkippedFiles", { count: report.skippedFiles })}</p>
    )}
    {/* 报告包里一个附件都没有时说清原因（2026-09-02 验收反馈 ⑩）：平台**会**展示步骤
        日志，但 allure 只有在没带 `--allure-no-capture` 时才把 pytest 捕获的
        log/stdout/stderr 附到用例上。缺席的原因在用户的命令里，不在这个页面里——不说
        的话它读起来就是「平台没收集日志」。 */}
    {report && report.cases.length > 0 && Object.keys(report.attachments).length === 0 && (
      <p className="form-note">{t("pipelineRun.noAttachmentsHint")}</p>
    )}

    {/* allure 用例明细（有报告包时的主视图）；junit / 没有包时降级为 cases 列表。 */}
    {report && report.cases.length > 0
      ? <AllureCasesTable
          report={report}
          loadAttachment={loadAttachment}
          projectId={projectId}
          canWrite={canWrite}
          caseByViewKey={caseByViewKey}
          onAttributed={onAttributed}
        />
      : cases.length
        ? <CasesFallbackList
            cases={cases}
            projectId={projectId}
            canWrite={canWrite}
            onAttributed={onAttributed}
          />
        : <Empty title={t("pipelineRun.casesEmptyTitle")} hint={t("pipelineRun.casesEmpty")} />}
  </>;
}

/**
 * timeline gantt（P4.5-13 的第一层；2026-09-02 验收反馈重画）。
 *
 * 三件事让它从「三个时间点 + 一堆色块」变成能读的图：
 *
 * ① **刻度落在整齐的时间边界上**，并在同一位置画背景网格线。原先只有起点/中点/终点
 *    三个标签、没有网格——一段 bar 落在图中间时读不出它发生在哪一刻。刻度间隔从
 *    `NICE_STEPS_MS` 里挑「≥ 目标间隔的最小整齐值」（100ms…10min），所以标签永远是
 *    整秒/整十秒这类可对齐的时刻，而不是把跨度机械三等分得到的 16:22:44.667。
 *
 * ② **空档显式画出来**。原先「最右边孤零零一块、中间大片留白」看不出中间是真的没有
 *    用例在跑，还是数据没画出来。这里把「所有泳道都没有 bar」的区间画成带虚线边界的
 *    灰带并标注时长——那段留白从此是一个有解释的事实。阈值取跨度的 4%，避免把并行
 *    执行里的毫秒级缝隙全标成空档。
 *
 * ③ **泳道按最早开始时间排序**，读的顺序与执行顺序一致（原先是 Map 插入序，等于
 *    「服务端返回的顺序」）。
 *
 * bar 仍用语义色（通过/失败/跳过/错误本来就是时间轴要回答的问题），时间为零宽的 case
 * 画最小宽度——跳过的用例常常 duration=0，画成 0 宽会从时间轴上消失。
 */

/** 目标刻度数（含首尾）：6 个标签在 620px 起的绘图区里不会互相挤。 */
const TIMELINE_TICKS = 6;
/** 空档标注阈值：短于跨度这个比例的间隙不标——并行执行里毫秒级缝隙满图都是。 */
const IDLE_MIN_RATIO = 0.04;

function TimelineGantt({ cases }: { cases: PipelineRunCase[] }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<PipelineRunCase>();

  const bounds = useMemo(() => {
    let start = Infinity;
    let end = -Infinity;
    for (const each of cases) {
      if (each.startedAtMs === undefined || each.finishedAtMs === undefined) continue;
      start = Math.min(start, each.startedAtMs);
      end = Math.max(end, each.finishedAtMs);
    }
    if (start === Infinity) return { start: 0, end: 1, span: 1 };
    return { start, end, span: Math.max(1, end - start) };
  }, [cases]);

  /* 泳道按最早开始时间排序；行内的 bar 也排一次——DOM 顺序影响重叠时谁在上面。 */
  const lanes = useMemo(() => {
    const byThread = new Map<string, PipelineRunCase[]>();
    for (const each of cases) {
      const key = each.thread || each.host || "";
      const bucket = byThread.get(key) ?? [];
      bucket.push(each);
      byThread.set(key, bucket);
    }
    return [...byThread.entries()]
      .map(([lane, rows]) => ({
        lane,
        rows: [...rows].sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0)),
      }))
      .sort((a, b) => (a.rows[0]?.startedAtMs ?? 0) - (b.rows[0]?.startedAtMs ?? 0));
  }, [cases]);

  /** 刻度：整齐边界上的时刻，配同位置的背景网格线。间隔挑法收编进图表底座
      （`charts/core.ts` 的 `niceMsStep`——候选表 100ms…10min、之外按 10 分钟
      向上取整、不退回 span 本身，语义与 2026-09-02 验收版一致）。 */
  const ticks = useMemo(() => {
    const step = niceMsStep(bounds.span, TIMELINE_TICKS);
    const first = Math.ceil(bounds.start / step) * step;
    const list: { at: number; label: string; pct: number }[] = [];
    for (let at = first; at <= bounds.end; at += step) {
      list.push({ at, label: formatMsTick(at, step), pct: ((at - bounds.start) / bounds.span) * 100 });
    }
    /* 跨度短于一个刻度间隔时（几百毫秒跑完的 run）循环最多落进一个刻度：退回首尾两点，
       图仍然有可读的边界。首尾同一毫秒时（单条 0 耗时用例）只画一条——两条会撞 key。 */
    if (list.length < 2) {
      const edges = [{ at: bounds.start, label: formatMsTick(bounds.start, step), pct: 0 }];
      if (bounds.end > bounds.start) edges.push({ at: bounds.end, label: formatMsTick(bounds.end, step), pct: 100 });
      return edges;
    }
    return list;
  }, [bounds]);

  /**
   * 空档：把全部区间按开始时间扫一遍，维护「已覆盖到的最右端」，出现真空就记一段。
   * 用真实区间而不是逐泳道判断——并行执行里 A 泳道的空档正被 B 泳道填着，那不是空档。
   */
  const idles = useMemo(() => {
    const spans = cases
      .filter((each) => each.startedAtMs !== undefined && each.finishedAtMs !== undefined)
      .map((each) => ({ from: each.startedAtMs!, to: each.finishedAtMs! }))
      .sort((a, b) => a.from - b.from);
    const gaps: { from: number; to: number }[] = [];
    let covered = bounds.start;
    for (const span of spans) {
      if (span.from > covered) gaps.push({ from: covered, to: span.from });
      covered = Math.max(covered, span.to);
    }
    const min = bounds.span * IDLE_MIN_RATIO;
    return gaps
      .filter((gap) => gap.to - gap.from >= min)
      .map((gap) => ({
        ...gap,
        left: ((gap.from - bounds.start) / bounds.span) * 100,
        width: ((gap.to - gap.from) / bounds.span) * 100,
      }));
  }, [cases, bounds]);

  const idleTotal = idles.reduce((sum, gap) => sum + (gap.to - gap.from), 0);

  return <div className="timeline">
    <div className="timeline-head">
      <strong style={{ fontSize: 12 }}>{t("pipelineRun.timelineTitle")}</strong>
      <span className="timeline-head-facts mono">
        <span>{t("pipelineRun.timelineCases", { count: cases.length })}</span>
        <span>{t("pipelineRun.timelineSpan", { duration: formatDuration(bounds.span) })}</span>
      </span>
    </div>
    <div className="timeline-plot">
      <div className="timeline-ruler mono">
        {/* 标签居中于自己的刻度线；最右侧那个探出的半个标签由 `--tick-gutter` 的留白吃掉
            （CSS 侧有理由）。 */}
        {ticks.map((tick) => <span key={tick.at} className="timeline-tick" style={{ left: `${tick.pct}%` }}>{tick.label}</span>)}
      </div>
      <div className="timeline-lanes">
        {/* 网格线与空档带垫在泳道下面（绝对定位、不吃指针事件），与刻度同一批百分比。 */}
        <div className="timeline-grid" aria-hidden="true">
          {ticks.map((tick) => <span key={tick.at} className="timeline-gridline" style={{ left: `${tick.pct}%` }} />)}
          {idles.map((gap) => <span
            key={gap.from}
            className="timeline-idle"
            style={{ left: `${gap.left}%`, width: `${gap.width}%` }}
          ><span>{t("pipelineRun.timelineGap", { duration: formatDuration(gap.to - gap.from) })}</span></span>)}
        </div>
        {lanes.map(({ lane, rows }) => <div key={lane} className="timeline-lane">
          <div className="timeline-lane-label mono" title={lane || undefined}>{lane || t("pipelineRun.timelineLaneOther")}</div>
          <div className="timeline-track">
            {rows.map((row) => {
              const startPct = ((row.startedAtMs! - bounds.start) / bounds.span) * 100;
              const widthPct = Math.max(((row.finishedAtMs! - row.startedAtMs!) / bounds.span) * 100, 100 / bounds.span);
              return <div
                key={row.id}
                className={`timeline-bar case-${row.status}`}
                style={{ left: `${startPct}%`, width: `${widthPct}%` }}
                onMouseEnter={() => setHovered(row)}
                onMouseLeave={() => setHovered(undefined)}
              />;
            })}
          </div>
        </div>)}
      </div>
    </div>
    {/* 常驻高度的悬停读数：条件渲染整块会在指针进出时把下面的表格上下顶一次。
        P8-5 起与 charts 底座的读数条共用 `.chart-readout`（原 `.timeline-hover`
        的职责），版式收敛成一份。 */}
    <div className="chart-readout timeline-hover mono">
      {hovered && <>
        <span className={`case-dot case-${hovered.status}`} />
        <span className="truncate">{hovered.caseName}</span>
        <span className="muted">{formatClock(hovered.startedAtMs!)} → {formatClock(hovered.finishedAtMs!)}</span>
        <span className="muted">{formatDuration(hovered.durationMs)}</span>
      </>}
    </div>
    {idleTotal > 0 && <p className="timeline-note">{t("pipelineRun.timelineGapHint", { duration: formatDuration(idleTotal) })}</p>}
  </div>;
}

/* ── 用例明细：allure 视图（标题/注释/步骤/日志）──────────────────────────── */

/**
 * 报告用例表（2026-09-02 验收反馈 ③④⑥⑪；第三批 ②⑤）。
 *
 * - **按文件收缩**：分组行可折叠，默认**全收起**（第三批 ⑤——原先「有失败的分组默认
 *   展开」让进入报告时最后一个文件总是摊开的；失败数在收起行上就有红字读数，要展开
 *   哪个文件由人决定）。搜索/筛选时仍全展开——结果藏在收起的分组里等于没搜。
 * - **标题优先**：行首显示 `@allure.title` / docstring 首行，函数名退成副标题（`caseTitle`
 *   的注释讲了回落链）。
 * - **搜索 + 状态筛选**：命中面是标题、函数名与分组名（= 文件路径）。筛选后收缩状态跟着
 *   走——搜出来的东西藏在收起的分组里等于没搜。
 * - **状态列语义色**：设计系统的 Status 原语（点 + 词）。
 * - **点行开抽屉**（第三批 ②）：用例明细不再在表格里下拉展开——展开行会把后面的行
 *   推走、收起时滚动位置也回不来；抽屉里整份明细自滚动，列表保持原位。
 */
function AllureCasesTable({ report, loadAttachment, projectId, canWrite, caseByViewKey, onAttributed }: {
  report: AllureReportView;
  loadAttachment?: (source: string) => Promise<Blob>;
  projectId?: string;
  canWrite?: boolean;
  /** 视图行 → DB 用例行（归因目标住在 DB 行上，匹配键见 viewCaseKey）。 */
  caseByViewKey: Map<string, PipelineRunCase>;
  onAttributed?: () => void;
}) {
  const { t } = useTranslation();
  /** 抽屉正展示的用例（2026-09-02 第三批 ②：点击行 = 打开抽屉，不再展开内嵌行）。 */
  const [detail, setDetail] = useState<AllureReportCase>();
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState<CaseFilter>("all");
  /** 手动折叠的覆盖：分组名 → 是否展开。缺席 = 用默认（默认全收起）。 */
  const [openSuites, setOpenSuites] = useState<Record<string, boolean>>({});
  /* 归因（P8-3）：抽屉目标批次 + 批量勾选（DB 用例行 id）。 */
  const [attribution, setAttribution] = useState<AttributionRequest>();
  const [checked, setChecked] = useState<Set<string>>(new Set());

  /* 可归因的失败行：视图行匹配上 DB 行且 DB 状态是 failed/error（error 已算失败，
     与 run 计数同口径）。匹配不上（旧报告包与上报清单错位）时行上不出入口——归因
     目标必须真实存在于 pipeline_run_cases。 */
  const attributable = useMemo(() => {
    const out: { view: AllureReportCase; caseRow: PipelineRunCase }[] = [];
    for (const view of report.cases) {
      const caseRow = caseByViewKey.get(viewCaseKey(view.name, view.start, view.stop));
      if (caseRow && (caseRow.status === "failed" || caseRow.status === "error")) out.push({ view, caseRow });
    }
    return out;
  }, [report, caseByViewKey]);
  const batchAvailable = Boolean(projectId && canWrite && attributable.length > 0);
  /* 归因列只在该报告有失败时出现（P8-3 验收反馈：通过的报告不携带归因信息）。 */
  const showAttribution = attributable.length > 0;

  function toggleChecked(caseRowId: string, next: boolean) {
    setChecked((current) => {
      const copy = new Set(current);
      if (next) copy.add(caseRowId); else copy.delete(caseRowId);
      return copy;
    });
  }

  function openBatchAttribution() {
    const targets = attributable
      .filter(({ caseRow }) => checked.has(caseRow.id))
      .map(({ view, caseRow }) => ({
        targetType: "pipeline_run_case" as const,
        targetId: caseRow.id,
        label: caseTitle(view),
        attribution: caseRow.attribution,
      }));
    if (targets.length) setAttribution({ targets });
  }

  const needle = keyword.trim().toLowerCase();

  /* 换了关键字/筛选就把手动折叠清空：否则「全部收起 → 搜索」会搜出一堆收着的分组，
     读起来像没搜到。显式折叠只对当前这一组筛选条件有效。函数式 setState + 空对象判断
     是为了不在挂载时多触发一次重渲染（`setState({})` 每次都是新引用，React 不会自己
     判定相等）。「全部展开/收起」按钮改的是 `openSuites` 本身，不在依赖里，不会被这个
     effect 立刻抹掉。 */
  useEffect(() => {
    setOpenSuites((current) => (Object.keys(current).length ? {} : current));
  }, [needle, filter]);

  /* 分组 = parentSuite › suite（pytest 下就是 包 › 模块，即目录 › 文件）。筛选在分组
     之前做：空分组不该留一行标题在表上。 */
  const suites = useMemo(() => {
    const groups = new Map<string, AllureReportCase[]>();
    for (const each of report.cases) {
      const key = each.parentSuiteName ? `${each.parentSuiteName} › ${each.suiteName}` : each.suiteName || "(no suite)";
      if (!matchesFilter(each.status, filter)) continue;
      if (needle) {
        const hay = `${caseTitle(each)}\n${each.fullName}\n${key}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const bucket = groups.get(key) ?? [];
      bucket.push(each);
      groups.set(key, bucket);
    }
    return [...groups.entries()].map(([suite, rows]) => ({
      suite,
      rows,
      passed: rows.filter((row) => row.status === "passed").length,
      failed: rows.filter((row) => row.status !== "passed" && row.status !== "skipped").length,
    }));
  }, [report, needle, filter]);

  const shown = suites.reduce((sum, group) => sum + group.rows.length, 0);
  const filtering = Boolean(needle) || filter !== "all";
  /* 搜索/筛选时默认全展开（结果藏在收起的分组里等于没搜）；平时全收起（第三批 ⑤）。 */
  const isOpen = (group: { suite: string }) => openSuites[group.suite] ?? filtering;
  const allOpen = suites.length > 0 && suites.every(isOpen);

  /* 当前筛选视图内的可归因行（表头「全选失败」的 scope：筛过之后全选圈的是看得见的
      这批，不是整份报告——按文件/状态筛完再批量打标是常见顺序）。 */
  const shownAttributable = useMemo(() => {
    const out: { view: AllureReportCase; caseRow: PipelineRunCase }[] = [];
    for (const group of suites) {
      for (const view of group.rows) {
        const caseRow = caseByViewKey.get(viewCaseKey(view.name, view.start, view.stop));
        if (caseRow && (caseRow.status === "failed" || caseRow.status === "error")) out.push({ view, caseRow });
      }
    }
    return out;
  }, [suites, caseByViewKey]);

  function toggleAllShown(next: boolean) {
    setChecked(next ? new Set(shownAttributable.map(({ caseRow }) => caseRow.id)) : new Set());
  }

  return <>
    <div className="filter-bar">
      <input
        className="input"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder={t("pipelineRun.searchPlaceholder")}
      />
      <Select
        value={filter}
        onChange={(value) => setFilter(value)}
        style={{ width: 132 }}
        options={CASE_FILTERS.map((each) => ({
          value: each,
          label: each === "all" ? t("filter.runStatusAll") : t(`pipelineRun.reportStatus.${each}`),
        }))}
      />
      <button
        className="btn btn-small"
        onClick={() => setOpenSuites(Object.fromEntries(suites.map((group) => [group.suite, !allOpen])))}
      >{allOpen ? t("pipelineRun.collapseAll") : t("pipelineRun.expandAll")}</button>
      {/* 批量归因（边界 4：一次 CI 挂一片同因失败太常见）：勾选失败用例后一次打标。 */}
      {batchAvailable && <button
        type="button"
        className="btn btn-small"
        disabled={!checked.size}
        onClick={openBatchAttribution}
      >{t("attribution.batch", { count: checked.size })}</button>}
      <span className="filter-spacer" />
      <span className="muted mono">{t("pipelineRun.filterMatched", { shown, total: report.cases.length })}</span>
    </div>

    {suites.length === 0
      ? <Empty title={t("pipelineRun.filterEmptyTitle")} hint={t("pipelineRun.filterEmptyHint")} />
      : <div className="table-scroll"><table className="grid grid-fixed report-grid-cases">
        <colgroup>
          {batchAvailable && <col className="col-select" />}
          <col />
          <col className="col-status" />
          {showAttribution && <col className="col-attribution" />}
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-attach" />
        </colgroup>
        <thead><tr>
          {batchAvailable && <th className="col-select">
            {/* 全选失败：批量归因的主路径（一次 CI 挂一片时逐条勾选不现实）；scope 是
                当前筛选视图内的失败行。 */}
            <input
              type="checkbox"
              aria-label={t("attribution.selectAllFailed")}
              checked={shownAttributable.length > 0 && shownAttributable.every(({ caseRow }) => checked.has(caseRow.id))}
              onChange={(event) => toggleAllShown(event.target.checked)}
            />
          </th>}
          <th>{t("pipelineRun.caseName")}</th>
          <th className="col-status">{t("pipelineRun.caseStatus")}</th>
          {showAttribution && <th>{t("attribution.column")}</th>}
          <th className="col-num">{t("pipelineRun.duration")}</th>
          <th className="col-num">{t("pipelineRun.stepsCount")}</th>
          <th className="col-attach" />
        </tr></thead>
        <tbody>
          {suites.map((group) => {
            const open = isOpen(group);
            return <Fragment key={group.suite}>
              <tr
                className="suite-row"
                data-clickable=""
                onClick={() => setOpenSuites((current) => ({ ...current, [group.suite]: !open }))}
              ><td colSpan={5 + (batchAvailable ? 1 : 0) + (showAttribution ? 1 : 0)}>
                <span className="suite-row-head">
                  <span className="suite-row-caret">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                  <span className="suite-name" title={group.suite}>{group.suite}</span>
                  {/* 分组读数：读报告先看分组，「这个文件全绿」是最常用的收尾判断；
                      有失败时把失败数单独标红，收起状态下就能定位到文件。 */}
                  <span className="muted mono">{t("suites.memberSummary", { success: group.passed, total: group.rows.length })}</span>
                  {group.failed > 0 && <span className="text-fail mono">{t("status.fail")} {group.failed}</span>}
                </span>
              </td></tr>
              {open && group.rows.map((row) => {
                const subName = caseSubName(row);
                /* 该行的 DB 用例行：归因状态与目标都住在那里（匹配不上 = 无入口，见
                    attributable 的注释）。 */
                const caseRow = caseByViewKey.get(viewCaseKey(row.name, row.start, row.stop));
                const attributableRow = caseRow && (caseRow.status === "failed" || caseRow.status === "error");
                return <tr key={row.uid} data-clickable="" onClick={() => setDetail(row)}>
                  {batchAvailable && <td className="col-select" onClick={(event) => event.stopPropagation()}>
                    {attributableRow && <input
                      type="checkbox"
                      aria-label={t("attribution.selectTarget", { name: caseTitle(row) })}
                      checked={checked.has(caseRow.id)}
                      onChange={(event) => toggleChecked(caseRow.id, event.target.checked)}
                    />}
                  </td>}
                  <td>
                    <span className="case-title">
                      <span className={`case-dot case-${dotStatus(row.status)}`} />
                      <span className="truncate" title={caseTitle(row)}>{caseTitle(row)}</span>
                    </span>
                    {subName && <span className="case-subname mono truncate" title={row.fullName}>{subName}</span>}
                  </td>
                  <td className="col-status">
                    <Status status={reportRunStatus(row.status)} label={reportStatusLabel(t, row.status)} />
                  </td>
                  {showAttribution && <td>
                    {attributableRow
                      ? <AttributionTag
                          attribution={caseRow.attribution}
                          actionable={Boolean(projectId && canWrite)}
                          onClick={() => setAttribution({
                            targets: [{
                              targetType: "pipeline_run_case",
                              targetId: caseRow.id,
                              label: caseTitle(row),
                              attribution: caseRow.attribution,
                            }],
                            evidenceMessage: caseRow.message ?? row.message ?? undefined,
                          })}
                        />
                      /* 通过/跳过/未匹配上的行：空单元格——归因列只对失败行有内容。 */
                      : null}
                  </td>}
                  <td className="col-num mono">{formatDuration(row.durationMs)}</td>
                  <td className="col-num mono">{countSteps(row.steps)}</td>
                  <td className="col-attach">{row.attachments.length > 0 && <Tip text={row.attachments.map((each) => each.name).join(", ")}><span className="muted"><Paperclip size={13} /></span></Tip>}</td>
                </tr>;
              })}
            </Fragment>;
          })}
        </tbody>
      </table></div>}

    {/* 用例明细抽屉（第三批 ②）：与执行记录页的成员证据抽屉同一交互语汇。 */}
    <Drawer
      title={detail ? caseTitle(detail) : ""}
      open={Boolean(detail)}
      onClose={() => setDetail(undefined)}
      width={760}
      extra={detail && <Status status={reportRunStatus(detail.status)} label={reportStatusLabel(t, detail.status)} />}
    >
      {detail && <ReportCaseDetail caseRow={detail} loadAttachment={loadAttachment} />}
    </Drawer>

    {/* 归因抽屉（P8-3）：单条（失败行 chip）与批量（勾选）同一组件；落库后重拉 cases。 */}
    {attribution && projectId && (
      <AttributionDrawer
        projectId={projectId}
        targets={attribution.targets}
        evidenceMessage={attribution.evidenceMessage}
        onClose={() => setAttribution(undefined)}
        onDone={() => { setChecked(new Set()); onAttributed?.(); }}
      />
    )}
  </>;
}

/**
 * 一条用例的明细（第三批 ② 起住进抽屉）。
 *
 * 两处 2026-09-02 的验收反馈：
 * - **抽屉自滚动**（⑤ 的延续）：一条带几十个步骤和一份长堆栈的用例全高展开会把表格
 *   推到几屏之外；现在明细在抽屉里，抽屉体自己滚，列表保持原位。
 * - **执行日志单独成块**（⑩）：allure-pytest 的 `log` / `stdout` / `stderr` 捕获是挂在
 *   **测试级**而不是步骤上的附件，原先它们混在「附件」清单里、还要点一下 `<details>` 才
 *   展开——而「这条用例打了什么日志」是读失败用例时第一个要看的东西。这里把它们拆成
 *   「执行日志」块并默认展开；截图之类的其余附件留在「附件」里不变。
 */
function ReportCaseDetail({ caseRow, loadAttachment }: {
  caseRow: AllureReportCase;
  loadAttachment?: (source: string) => Promise<Blob>;
}) {
  const { t } = useTranslation();
  const logs = caseRow.attachments.filter(isLogAttachment);
  const others = caseRow.attachments.filter((each) => !isLogAttachment(each));

  return <div className="report-case-detail">
    {caseRow.fullName !== caseRow.name && <div className="detail-block">
      <h4>{t("pipelineRun.fullName")}</h4>
      <p className="mono muted" style={{ margin: 0, wordBreak: "break-all" }}>{caseRow.fullName}</p>
    </div>}
    {caseRow.description && <div className="detail-block">
      <h4>{t("pipelineRun.description")}</h4>
      <p className="report-description">{caseRow.description}</p>
    </div>}
    {caseRow.parameters.length > 0 && <div className="detail-block">
      <h4>{t("pipelineRun.parameters")}</h4>
      {caseRow.parameters.map((param) => <div key={param.name} className="mono param-row">
        <span className="muted">{param.name}</span>
        <span>{param.value || "—"}</span>
      </div>)}
    </div>}
    {caseRow.befores.length > 0 && <div className="detail-block">
      <h4>{t("pipelineRun.befores")}</h4>
      <FixtureList fixtures={caseRow.befores} loadAttachment={loadAttachment} />
    </div>}
    {caseRow.steps.length > 0 && <div className="detail-block">
      <h4>{t("pipelineRun.steps")}</h4>
      <StepTree steps={caseRow.steps} loadAttachment={loadAttachment} />
    </div>}
    {caseRow.afters.length > 0 && <div className="detail-block">
      <h4>{t("pipelineRun.afters")}</h4>
      <FixtureList fixtures={caseRow.afters} loadAttachment={loadAttachment} />
    </div>}
    {(caseRow.message || caseRow.trace) && <div className="detail-block">
      <h4>{t("pipelineRun.failureDetail")}</h4>
      {caseRow.message && <pre className="pipeline-log mono">{caseRow.message}</pre>}
      {caseRow.trace && <details><summary className="muted">{t("pipelineRun.showTrace")}</summary>
        <pre className="pipeline-log mono">{caseRow.trace}</pre>
      </details>}
    </div>}
    {logs.length > 0 && <div className="detail-block">
      <h4>{t("pipelineRun.caseLog")}</h4>
      <ul className="attachment-list">
        {logs.map((each) => <li key={each.source}>
          <AttachmentView attachment={each} loadAttachment={loadAttachment} defaultOpen />
        </li>)}
      </ul>
    </div>}
    {others.length > 0 && <div className="detail-block">
      <h4>{t("pipelineRun.attachments")}</h4>
      <ul className="attachment-list">
        {others.map((each) => <li key={each.source}>
          <AttachmentView attachment={each} loadAttachment={loadAttachment} />
        </li>)}
      </ul>
    </div>}
  </div>;
}

/** fixture（before/after）行：状态点 + 名字 + 耗时，内层步骤复用 StepTree。 */
function FixtureList({ fixtures, loadAttachment }: {
  fixtures: AllureReportCase["befores"];
  loadAttachment?: (source: string) => Promise<Blob>;
}) {
  return <ul className="step-tree">
    {fixtures.map((fixture) => <li key={`${fixture.type}-${fixture.name}`}>
      <span className="step-row">
        <span className={`case-dot case-${dotStatus(fixture.status)}`} />
        <span className="truncate">{fixture.name}</span>
        {fixture.stop !== undefined && fixture.start !== undefined && <span className="muted mono">{formatDuration(fixture.stop - fixture.start)}</span>}
      </span>
      {fixture.steps.length > 0 && <StepTree steps={fixture.steps} loadAttachment={loadAttachment} />}
    </li>)}
  </ul>;
}

/**
 * 步骤树（导出给仓库用例抽屉复用，2026-09-03：用例树点开用例要看「用例内的步骤」，
 * 与报告视图同一份渲染而不是第二种实现）。
 *
 * 有子步骤的行是**真的可折叠**（2026-09-02 验收反馈 ⑤ 的一半）：原先 caret 只是装饰，
 * 一个 100 次迭代的循环步骤永远全展开，把用例明细撑成几屏。默认展开——步骤是「执行了
 * 什么」的主线，收起来读不到；但用户能把不看的那几支合上。
 *
 * 步骤日志（⑩）：`log` / `stdout` 这类文本附件挂在步骤上时**默认展开**读，其余（截图）
 * 保持点开。`loadAttachment` 缺席（仓库用例抽屉）时附件行不取数，只显示名字。
 */
export function StepTree({ steps, loadAttachment }: {
  steps: AllureReportStep[];
  loadAttachment?: (source: string) => Promise<Blob>;
}) {
  return <ul className="step-tree">
    {steps.map((step, index) => <StepNode
      key={`${step.name}-${index}`}
      step={step}
      loadAttachment={loadAttachment}
    />)}
  </ul>;
}

function StepNode({ step, loadAttachment }: {
  step: AllureReportStep;
  loadAttachment?: (source: string) => Promise<Blob>;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = Boolean(step.children?.length);
  const duration = step.stop !== undefined && step.start !== undefined ? formatDuration(step.stop - step.start) : undefined;

  const body = <>
    <span className="step-caret" data-leaf={hasChildren ? undefined : ""}>
      {hasChildren && !open ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
    </span>
    <span className={`case-dot case-${dotStatus(step.status)}`} />
    <span className="truncate" title={step.name}>{step.name}</span>
    {duration && <span className="muted mono">{duration}</span>}
  </>;

  return <li>
    {hasChildren
      ? <button type="button" className="step-row" aria-expanded={open} onClick={() => setOpen(!open)}>{body}</button>
      : <span className="step-row">{body}</span>}
    {hasChildren && open ? <StepTree steps={step.children!} loadAttachment={loadAttachment} /> : null}
    {/* 步骤日志：文本类附件（allure.attach 的 log/文本）就地展开读，图片出缩略图。 */}
    {step.attachments?.length ? <ul className="attachment-list step-attachments">
      {step.attachments.map((each) => <li key={each.source}>
        <AttachmentView attachment={each} loadAttachment={loadAttachment} defaultOpen={isLogAttachment(each)} />
      </li>)}
    </ul> : null}
  </li>;
}

/**
 * 附件的三种读法，全部经 `loadAttachment` 取 Blob——附件路由要 Bearer 头，裸 URL
 * （`<img src>` / `fetch`）带不上（dev 下 web 与 API 还是跨源），只有 axios 的请求
 * 拦截器能带：图片转 objectURL 出缩略图；文本类（log/json）就地展开读；其余给
 * objectURL 下载链接。类型缺失时按扩展名猜（旧报告包的类型清单可能不含未知类型）。
 *
 * `defaultOpen`（2026-09-02）给执行日志用：日志是读失败用例时第一个要看的东西，让它
 * 多一次点击是没有理由的。截图与二进制附件仍保持点开——它们才是「按需」的那一类。
 *
 * 取数按 `attachment.source`（报告包内的实体文件名），显示用 `attachment.name`
 * （allure 的展示名）——两者在参数化/重名的附件上才会分叉，而取数必须用前者（第三批 ①：
 * 原先按 name 取，`?name=log` 在 zip 里没有同名实体，永远 404）。
 */
function AttachmentView({ attachment, loadAttachment, defaultOpen }: {
  attachment: AllureReportAttachment;
  loadAttachment?: (source: string) => Promise<Blob>;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "loading" | "text" | "binary" | "failed">("idle");
  const [text, setText] = useState<string>();
  const [objectUrl, setObjectUrl] = useState<string>();
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const { name, source } = attachment;

  const type = attachment.type;
  const isImage = type.startsWith("image/") || /\.(png|jpe?g|gif|svg)$/i.test(name);
  const isText = !isImage && (type.startsWith("text/") || type === "application/json" || /\.(txt|log|json|xml|md|csv)$/i.test(name));

  /* objectURL 的生命周期跟着组件走；state 变化不影响它，单独一个 effect 收尾。 */
  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);

  /* 请求的落地**不做 cleanup 取消**（2026-09-02 验收反馈第三批 ①）：原先的
     `alive` 旗子在 effect 重跑（父级重渲染换了 loadAttachment 身份、开关 details）
     时把在途响应整个丢弃，而 effect 守卫又因 state 已是 "loading" 不再重发——
     「正在加载」从此永远停在那里。setState 在已卸载组件上是 no-op（React 18），
     迟到的响应落地没有任何代价，去掉旗子才是对的。 */
  useEffect(() => {
    if (state !== "idle" || !loadAttachment || (!open && !isImage)) return;
    setState("loading");
    void loadAttachment(source)
      .then(async (blob) => {
        if (isText) {
          setText(await blob.text());
          setState("text");
        } else {
          setObjectUrl(URL.createObjectURL(blob));
          setState("binary");
        }
      })
      .catch(() => setState("failed"));
  }, [state, open, isImage, isText, source, loadAttachment]);

  if (isImage) {
    if (state === "binary" && objectUrl) {
      return <a href={objectUrl} target="_blank" rel="noreferrer"><img src={objectUrl} alt={name} className="attachment-image" loading="lazy" /></a>;
    }
    return <span className="muted mono">{name}{state === "loading" ? ` · ${t("common.loading")}` : state === "failed" ? ` · ${t("pipelineRun.attachmentLoadFailed")}` : ""}</span>;
  }
  return <details className="attachment-text" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
    <summary className="mono muted">{name}</summary>
    {state === "loading" && <p className="muted" style={{ margin: "var(--s2) 0 0" }}>{t("common.loading")}</p>}
    {state === "failed" && <p className="muted" style={{ margin: "var(--s2) 0 0" }}>{t("pipelineRun.attachmentLoadFailed")}</p>}
    {state === "text" && <pre className="pipeline-log mono">{text}</pre>}
    {state === "binary" && objectUrl && <a className="mono" href={objectUrl} download={name}>{t("pipelineRun.download")}</a>}
  </details>;
}

/* ── 用例明细：junit / 无报告包的降级列表 ──────────────────────────────────── */

/** 降级列表也带搜索与状态筛选（验收反馈 ⑥）+ Status 原语（⑪）——两处列表同一口径。
 *  点行开抽屉读失败信息（第三批 ②，与 allure 用例表同一交互语汇）。 */
function CasesFallbackList({ cases, projectId, canWrite, onAttributed }: {
  cases: PipelineRunCase[];
  projectId?: string;
  canWrite?: boolean;
  onAttributed?: () => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<PipelineRunCase>();
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState<CaseFilter>("all");
  /* 归因（P8-3）：junit 降级列表的行就是 DB 行，归因目标即行自身。 */
  const [attribution, setAttribution] = useState<AttributionRequest>();
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const needle = keyword.trim().toLowerCase();
  const rows = useMemo(() => cases.filter((row) => {
    if (!matchesFilter(row.status, filter)) return false;
    if (!needle) return true;
    return `${row.caseName}\n${row.suiteName}`.toLowerCase().includes(needle);
  }), [cases, needle, filter]);

  const failedRows = rows.filter((row) => row.status === "failed" || row.status === "error");
  const batchAvailable = Boolean(projectId && canWrite && failedRows.length > 0);
  /* 归因列只在有失败时出现（含被筛选隐藏的失败——列不随筛选闪现/消失）。 */
  const showAttribution = cases.some((row) => row.status === "failed" || row.status === "error");

  function toggleChecked(caseRowId: string, next: boolean) {
    setChecked((current) => {
      const copy = new Set(current);
      if (next) copy.add(caseRowId); else copy.delete(caseRowId);
      return copy;
    });
  }

  function openBatchAttribution() {
    const targets = failedRows
      .filter((row) => checked.has(row.id))
      .map((row) => ({
        targetType: "pipeline_run_case" as const,
        targetId: row.id,
        label: row.caseName,
        attribution: row.attribution,
      }));
    if (targets.length) setAttribution({ targets });
  }

  function toggleAllFailed(next: boolean) {
    setChecked(next ? new Set(failedRows.map((row) => row.id)) : new Set());
  }

  return <>
    <div className="filter-bar">
      <input
        className="input"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder={t("pipelineRun.searchPlaceholder")}
      />
      <Select
        value={filter}
        onChange={(value) => setFilter(value)}
        style={{ width: 132 }}
        options={CASE_FILTERS.map((each) => ({
          value: each,
          label: each === "all" ? t("filter.runStatusAll") : t(`pipelineRun.reportStatus.${each}`),
        }))}
      />
      {batchAvailable && <button
        type="button"
        className="btn btn-small"
        disabled={!checked.size}
        onClick={openBatchAttribution}
      >{t("attribution.batch", { count: checked.size })}</button>}
      <span className="filter-spacer" />
      <span className="muted mono">{t("pipelineRun.filterMatched", { shown: rows.length, total: cases.length })}</span>
    </div>

    {rows.length === 0
      ? <Empty title={t("pipelineRun.filterEmptyTitle")} hint={t("pipelineRun.filterEmptyHint")} />
      : <div className="table-scroll"><table className="grid">
        <thead><tr>
          {batchAvailable && <th className="col-select">
            <input
              type="checkbox"
              aria-label={t("attribution.selectAllFailed")}
              checked={failedRows.length > 0 && failedRows.every((row) => checked.has(row.id))}
              onChange={(event) => toggleAllFailed(event.target.checked)}
            />
          </th>}
          <th>{t("pipelineRun.caseName")}</th>
          <th>{t("pipelineRun.suite")}</th>
          <th className="col-status">{t("pipelineRun.caseStatus")}</th>
          {showAttribution && <th>{t("attribution.column")}</th>}
          <th className="col-num">{t("pipelineRun.duration")}</th>
          <th />
        </tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id} data-clickable="" onClick={() => setDetail(row)}>
            {batchAvailable && <td className="col-select" onClick={(event) => event.stopPropagation()}>
              {(row.status === "failed" || row.status === "error") && <input
                type="checkbox"
                aria-label={t("attribution.selectTarget", { name: row.caseName })}
                checked={checked.has(row.id)}
                onChange={(event) => toggleChecked(row.id, event.target.checked)}
              />}
            </td>}
            <td><span className="truncate cell-name"><span className={`case-dot case-${row.status}`} />{row.caseName}</span></td>
            <td><span className="truncate">{row.suiteName || "—"}</span></td>
            <td className="col-status">
              <Status status={caseRunStatus(row.status)} label={t(`pipelineRun.caseStatusValue.${row.status}`)} />
            </td>
            {showAttribution && <td>
              {row.status === "failed" || row.status === "error"
                ? <AttributionTag
                    attribution={row.attribution}
                    actionable={Boolean(projectId && canWrite)}
                    onClick={() => setAttribution({
                      targets: [{
                        targetType: "pipeline_run_case",
                        targetId: row.id,
                        label: row.caseName,
                        attribution: row.attribution,
                      }],
                      evidenceMessage: row.message,
                    })}
                  />
                /* 通过/跳过的行：空单元格——归因列只对失败行有内容。 */
                : null}
            </td>}
            <td className="col-num mono">{formatDuration(row.durationMs)}</td>
            <td>{row.message && <span className="muted">{t("pipelineRun.hasMessage")}</span>}</td>
          </tr>)}
        </tbody>
      </table></div>}

    <Drawer
      title={detail?.caseName ?? ""}
      open={Boolean(detail)}
      onClose={() => setDetail(undefined)}
      width={640}
      extra={detail && <Status status={caseRunStatus(detail.status)} label={t(`pipelineRun.caseStatusValue.${detail.status}`)} />}
    >
      {detail?.message && <pre className="pipeline-log mono">{detail.message}</pre>}
      {!detail?.message && <p className="muted">—</p>}
    </Drawer>

    {attribution && projectId && (
      <AttributionDrawer
        projectId={projectId}
        targets={attribution.targets}
        evidenceMessage={attribution.evidenceMessage}
        onClose={() => setAttribution(undefined)}
        onDone={() => { setChecked(new Set()); onAttributed?.(); }}
      />
    )}
  </>;
}

function countSteps(steps: AllureReportStep[]): number {
  let count = 0;
  for (const step of steps) count += 1 + (step.children ? countSteps(step.children) : 0);
  return count;
}

/* ── artifacts tab ─────────────────────────────────────────────────────────── */

function PipelineArtifactsTab({ artifacts }: { artifacts: (Artifact & { downloadUrl: string })[] | undefined }) {
  const { t } = useTranslation();
  if (!artifacts) return <p className="muted">{t("common.loading")}</p>;
  if (!artifacts.length) return <Empty title={t("pipelineRun.artifactsEmptyTitle")} hint={t("pipelineRun.artifactsEmpty")} />;
  return <div className="table-scroll"><table className="grid">
    <thead><tr>
      <th>{t("pipelineRun.artifactName")}</th>
      <th>{t("pipelineRun.artifactKind")}</th>
      <th className="col-num">{t("pipelineRun.artifactSize")}</th>
      <th className="col-num">{t("pipelineRun.artifactUploadedAt")}</th>
      <th />
    </tr></thead>
    <tbody>
      {artifacts.map((artifact) => <tr key={artifact.id}>
        <td><span className="truncate cell-name">{artifact.name}</span></td>
        <td>{t(`pipelineRun.artifactKindValue.${artifact.kind}`)}</td>
        <td className="col-num mono">{formatSize(artifact.sizeBytes)}</td>
        <td className="col-num mono">{artifact.uploadedAt ? new Date(artifact.uploadedAt).toLocaleString() : "—"}</td>
        <td><a className="btn btn-sm" href={artifact.downloadUrl}>{t("pipelineRun.download")}</a></td>
      </tr>)}
    </tbody>
  </table></div>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
