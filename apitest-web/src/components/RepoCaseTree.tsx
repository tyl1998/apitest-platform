import { Fragment, useCallback, useEffect, useState } from "react";
import { Drawer, Modal, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, Play, X } from "lucide-react";
import { api, noRunnerLabel, type CiTask, type CiTaskRecommendation, type RepoCaseDetail, type RepoCaseTree, type RepoTestCase } from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import { usePageContext } from "../hooks/usePageContext";
import { useProjectStore } from "../stores/projectStore";
import { Empty, Method, Readout, Tip, toRunStatus } from "../ui";
import { RepoPageHead, RepoTabs } from "./RepoShell";
import { RunStatusTag } from "./RunStatusTag";
import { StepTree, formatDuration } from "./PipelineRunPage";

/**
 * 仓库用例树（P4-8，交互 3.11.1）。
 *
 * 树是「系统 → 接口 → 用例」：**接口下有用例 = 已覆盖**。分页分在接口上（服务端同款），
 * 因为一个接口下的用例要一起显示才有意义——切页会让「这个接口有几条用例」随页码变。
 *
 * 树底部两个并列分组（边界 21）：**未归位用例**（有用例、一个接口都没打到）与进入未匹配
 * 诊断的入口。两者是同一件事的两端：一个是「有用例找不到接口」，一个是「有记录找不到
 * 接口」。未归位**不能藏掉**——藏了之后「上报了 36 条用例，树上只数出 31 条」会被当成
 * bug 报上来。
 */

const PAGE_SIZES = [20, 50, 100];

/**
 * 用例的最近结果 → 设计系统的状态词。
 *
 * 优先读 `lastReport`（最新任务报告，2026-09-03）：树上的通过状态按用户要求从报告取
 * ——报告是「这轮 CI 到底怎么走的」的权威副本。没有匹配报告行时退回 `lastResult`
 * （SDK 请求桩的推导），两套语义都有 `unknown`（从没跑过 = 没有结论）与 `not_run`
 * （勾选执行没报到）。
 */
function caseStatus(item: Pick<RepoTestCase, "lastResult" | "lastReport">) {
  if (item.lastReport) {
    if (item.lastReport.status === "passed") return "pass" as const;
    if (item.lastReport.status === "failed") return "fail" as const;
    return toRunStatus("skip");
  }
  if (item.lastResult === "passed") return "pass" as const;
  if (item.lastResult === "failed") return "fail" as const;
  if (item.lastResult === "not_run") return "not_run" as const;
  return toRunStatus("skip");
}

/** 树行上「最近执行」时刻：有任务报告读报告的，否则读 ingest 侧的。 */
function caseLastRunAt(item: RepoTestCase): string | undefined {
  return item.lastReport?.runAt ?? item.lastRunAt;
}

/** 一行用例的勾选框（P4.5-9）。`stopPropagation` 拦的是行点击（打开抽屉）与外层接口行
    的折叠——照 `EndpointList.tsx` 的形状。 */
function CaseRow({ item, showEndpointCount, onOpen, selected, onSelect, selectable, onOpenRun }: {
  item: RepoTestCase;
  showEndpointCount?: boolean;
  onOpen?: (item: RepoTestCase) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (caseKey: string, checked: boolean) => void;
  /** 报告出处直达 run 详情页（2026-09-03）：null = 没有可跳的报告。 */
  onOpenRun?: (runId: string) => void;
}) {
  const { t } = useTranslation();
  const lastRunAt = caseLastRunAt(item);
  return <tr
    data-removed={item.status === "removed" ? "" : undefined}
    data-clickable={onOpen ? "" : undefined}
    className={selected ? "is-selected" : undefined}
    onClick={onOpen ? (event) => { event.stopPropagation(); onOpen(item); } : undefined}
  >
    {/* `selectable` 显式传 false（viewer）时保留空占位 td：树表是 grid-fixed + colgroup，
       少一格整行列宽错位；抽屉用法（不传）维持原样不渲染。 */}
    {selectable === undefined ? null : <td className="col-select" onClick={(event) => event.stopPropagation()}>
      {selectable && <input
        type="checkbox"
        aria-label={t("repoCases.selectCase", { name: item.name })}
        checked={Boolean(selected)}
        onChange={(event) => onSelect?.(item.caseKey, event.target.checked)}
      />}
    </td>}
    <td>
      <span className="cell-name">
        <Tip text={item.name}><span className="truncate">{item.name}</span></Tip>
        {/* 软删的用例默认置灰保留（交互 3.11.1）：它的历史与最后结果仍然读得通，
            下次再出现会自动回 active。 */}
        {item.status === "removed" && <span className="chip chip-warn">{t("repoCases.removed")}</span>}
      </span>
      <Tip text={item.caseKey}><span className="resource-type mono truncate">{item.caseKey}</span></Tip>
    </td>
    <Tip text={item.filePath}><td className="mono muted truncate">{item.filePath || "—"}</td></Tip>
    <Tip text={item.tags.join(" ")}><td className="mono muted truncate">{item.tags.length ? item.tags.join(" ") : "—"}</td></Tip>
    {showEndpointCount && <td className="col-num mono">{item.endpoints?.length ?? 0}</td>}
    {/* 最近任务 + 时间并一格（2026-09-03 用户改口径）：原先「最近任务」（run 的
        created_at）与「最近执行」（ingest 的 last_run_at）是两个来源的两个时刻，
        同一次执行差几秒，读起来像矛盾。时间跟随「出处」：有报告读报告的 runAt，
        纯 SDK 直跑（无报告）回落 last_run_at——用例什么时候被执行过仍然有答案。
        没报告不可点；有报告点任务名直达 run 详情。 */}
    <td className="mono muted truncate">
      {item.lastReport
        ? <Tip text={`${item.lastReport.taskName} · ${new Date(item.lastReport.runAt).toLocaleString()}`}>
            <span className="truncate">
              {onOpenRun
                ? <button
                    className="cell-link mono truncate"
                    onClick={(event) => { event.stopPropagation(); onOpenRun(item.lastReport!.runId); }}
                  >{item.lastReport.taskName} #{item.lastReport.runNumber}</button>
                : <span className="truncate">{item.lastReport.taskName} #{item.lastReport.runNumber}</span>}
              <span className="cell-description mono truncate">{new Date(item.lastReport.runAt).toLocaleString()}</span>
            </span>
          </Tip>
        : lastRunAt
          ? <span className="cell-description mono truncate">{new Date(lastRunAt).toLocaleString()}</span>
          : "—"}
    </td>
    <td className="col-status"><RunStatusTag status={caseStatus(item)} /></td>
  </tr>;
}

/**
 * 用例详情抽屉（2026-08-30 第二轮改版 → 2026-09-03 增补任务报告块）。
 *
 * 三层内容，各回答一个问题：
 * 1. **身份事实**（路径/文件/标签/最近执行 + 参数化场景）——原来的主体，保留。
 * 2. **最新任务报告**（`latestReport`）：绑定的任务 + #序号 + 结论/耗时/失败信息——
 *    树上状态列的同一份数据在抽屉里给出处。
 * 3. **用例内执行了什么**：报告包里的 allure 步骤树（`steps`，`@allure.step` 写的那些）
 *    + 那次 run 的 SDK 请求序列（`requests`，按 seq 排序）。「该接口所在的步骤」用
 *    请求序列回答：点开哪个接口下的这条用例，就高亮打到该接口的那些请求。
 *
 * 两部分都可能缺席（junit-only 没有步骤树、关了 SDK 没有请求序列），缺席就写明原因，
 * 不伪造空壳。
 */
function CaseDetailDrawer({ caseId, endpointId, endpointName, onClose }: {
  caseId: string;
  /** 从哪个接口下点开的：请求序列里高亮打到它的请求。未归位分组的用例没有这一格。 */
  endpointId?: string;
  endpointName?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RepoCaseDetail>();

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setDetail(undefined);
    void api.repoCase(projectId, caseId)
      .then((result) => { if (alive) setDetail(result); })
      .catch(() => { if (alive) message.error(t("repoCases.loadFailed")); });
    return () => { alive = false; };
  }, [projectId, caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const report = detail?.latestReport;

  return <Drawer title={t("repoCases.caseDetail")} open onClose={onClose} width={680} destroyOnClose>
    {!detail ? <p className="muted">{t("common.loading")}</p> : <>
      <div className="cell-name">
        <strong className="truncate" title={detail.name}>{detail.name}</strong>
        <RunStatusTag status={caseStatus(detail)} />
        {detail.status === "removed" && <span className="chip chip-warn">{t("repoCases.removed")}</span>}
      </div>
      {detail.description && <p className="form-note">{detail.description}</p>}
      <dl className="detail-facts">
        <div>
          <dt>{t("repoCases.caseKeyLabel")}</dt>
          <dd><Tip text={detail.caseKey}><span className="mono truncate">{detail.caseKey}</span></Tip></dd>
        </div>
        <div>
          <dt>{t("repoCases.filePath")}</dt>
          <dd><Tip text={detail.filePath}><span className="mono truncate">{detail.filePath || "—"}</span></Tip></dd>
        </div>
        <div>
          <dt>{t("repoCases.tags")}</dt>
          <dd>{detail.tags.length ? detail.tags.map((tag) => <span key={tag} className="chip">{tag}</span>) : <span className="muted">—</span>}</dd>
        </div>
        {/* 「最近执行」从身份事实里删（2026-09-03）：时间跟出处走——有报告时在
            「最新任务报告」块里；纯 SDK 直跑时 ingest 侧的 last_run_at 已经是树上
            「最近任务」格的回落值，抽屉里再放一份是重复。 */}
        {detail.params.length > 0 && <div>
          <dt>{t("repoCases.params")}</dt>
          <dd>{detail.params.map((param) => <span key={param} className="chip mono">{param}</span>)}</dd>
        </div>}
      </dl>

      {/* ── 最新任务报告：树上的状态/最近执行在这里给出处 ─────────────────── */}
      {report ? <div className="detail-block">
        <h4>{t("repoCases.latestReportTitle")}</h4>
        <dl className="detail-facts">
          <div>
            <dt>{t("repoCases.reportTask")}</dt>
            {/* 可点的出处（2026-09-03 用户要求）：任务名 #序号直达 run 详情页——
                报告的完整视图（timeline / allure 明细）在那里，这里只是出处摘要。
                ?tab=report（2026-09-11 用户要求）：看的是历史结论，不落在日志页。 */}
            <dd><button
              className="cell-link mono truncate"
              title={t("repoCases.openRunHint")}
              onClick={() => navigate(`/projects/${projectId}/pipeline-runs/${report.runId}?tab=report`)}
            >{report.taskName} #{report.runNumber}</button></dd>
          </div>
          <div>
            <dt>{t("endpoints.status")}</dt>
            <dd><RunStatusTag status={report.status === "passed" ? "pass" : report.status === "failed" ? "fail" : "skip"} /></dd>
          </div>
          <div>
            <dt>{t("endpoints.duration")}</dt>
            <dd className="mono">{formatDuration(report.durationMs)}</dd>
          </div>
          <div>
            <dt>{t("repoCases.runAt")}</dt>
            <dd className="mono muted">{new Date(report.runAt).toLocaleString()}</dd>
          </div>
        </dl>
        {report.message && <pre className="pipeline-log mono">{report.message}</pre>}
      </div> : <div className="detail-block">
        <h4>{t("repoCases.latestReportTitle")}</h4>
        <p className="form-note">{t("repoCases.noReportHint")}</p>
        {/* 纯 SDK 直跑（无报告）的执行时刻：ingest 侧 last_run_at——树上「最近任务」
            格的回落值在这里也给出，不然「这用例跑过没有」在抽屉里没有答案。 */}
        {caseLastRunAt(detail) && <dl className="detail-facts">
          <div>
            <dt>{t("repoCases.runAt")}</dt>
            <dd className="mono muted">{new Date(caseLastRunAt(detail)!).toLocaleString()}</dd>
          </div>
        </dl>}
      </div>}

      {/* ── 用例内的步骤（报告包的 allure 步骤树）────────────────────────── */}
      {report && (report.steps?.length
        ? <div className="detail-block">
            <h4>{t("repoCases.reportSteps")}</h4>
            <StepTree steps={report.steps} />
          </div>
        : <div className="detail-block">
            <h4>{t("repoCases.reportSteps")}</h4>
            <p className="form-note">{t("repoCases.reportStepsEmpty")}</p>
          </div>)}

      {/* ── 请求序列（那次 run 的 SDK 上报，按 seq）：该接口所在的步骤在这里 ── */}
      {report && (report.requests.length
        ? <div className="detail-block">
            <h4>{t("repoCases.requestSequence")}{endpointId ? ` · ${t("repoCases.requestSequenceHint", { endpoint: endpointName ?? endpointId })}` : ""}</h4>
            <ul className="step-tree">
              {report.requests.map((record) => {
                const hit = Boolean(endpointId && record.endpointId === endpointId);
                return <li key={record.id}>
                  <span className={`request-row${hit ? " report-step-hit" : ""}`}>
                    <span className="mono muted">{record.seq}</span>
                    <Method method={record.method} />
                    <span className="mono truncate" title={record.pathRaw}>{record.pathNormalized ?? record.pathRaw}</span>
                    <span className="mono muted col-right">{record.statusCode ?? "—"}</span>
                    <span className="mono muted col-right request-latency">{record.latencyMs !== undefined ? `${record.latencyMs}ms` : "—"}</span>
                    <span className="mono muted">{hit ? t("repoCases.thisEndpoint") : t(`repoCases.phaseValue.${record.phase}`)}</span>
                  </span>
                </li>;
              })}
            </ul>
          </div>
        : <div className="detail-block">
            <h4>{t("repoCases.requestSequence")}</h4>
            <p className="form-note">{t("repoCases.requestSequenceEmpty")}</p>
          </div>)}
    </>}
  </Drawer>;
}

export function RepoCaseTreePage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  const [searchParams, setSearchParams] = useSearchParams();
  /* viewer：勾选执行是「跑已保存资产」（P6-4），勾选框与批量条全藏；树本身照读。 */
  const canWrite = useCanWrite();

  /* 筛选走地址栏（与接口列表同款约定）：一份筛好的树要能被贴给别人。 */
  const keyword = searchParams.get("keyword") ?? "";
  const status = searchParams.get("status") ?? "active";
  const page = Number(searchParams.get("page") ?? 1);
  const pageSize = Number(searchParams.get("pageSize") ?? 20);

  const [tree, setTree] = useState<RepoCaseTree & { total: number }>();
  const [unplaced, setUnplaced] = useState<RepoTestCase[]>([]);
  const [unplacedTotal, setUnplacedTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  /* 默认收起（expanded 集，默认空）：接口层只读计数，点开才看用例。 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [unplacedOpen, setUnplacedOpen] = useState(false);
  /* 抽屉目标：用例 id + 点开时的接口语境（「该接口所在的步骤」高亮靠它）。 */
  const [detail, setDetail] = useState<{ caseId: string; endpointId?: string; endpointName?: string }>();

  /* 报告出处直达（2026-09-03）：树上「最近任务」与抽屉里的任务名共用这一个跳转。
     ?tab=report：看的是历史结论，不落在日志页（2026-09-11 用户要求）。 */
  const openRun = useCallback((runId: string) => {
    if (projectId) navigate(`/projects/${projectId}/pipeline-runs/${runId}?tab=report`);
  }, [projectId, navigate]);

  /* ── 勾选执行（§8.3，P4.5-9） ─────────────────────────────────────
     勾选集按 **case_key** 而不是行 id：同一条用例可以挂在多个接口下、在树上出现多次
     （接口下的「用例数」是关系数，见 countingNote），按行 id 存会让同一条用例被勾两次
     并在触发时重复；而 `case_filter.case_keys` 本来就是按 key 去重的集合。 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [tasks, setTasks] = useState<CiTask[]>();
  const [taskId, setTaskId] = useState<string>();
  const [recommendation, setRecommendation] = useState<CiTaskRecommendation>();
  const [triggering, setTriggering] = useState(false);
  /* 幂等键在**打开弹窗时**生成一次，重试之间不变（P4.5-8）：每次点「触发」现生成一个键
     等于没防重——那正是接入前的行为（双击两条 run）。 */
  const [idempotencyKey, setIdempotencyKey] = useState("");

  /* 助手页面上下文（P9-4c）：筛选已在 URL；抽屉目标（点开的用例 + 接口语境）与
     勾选集（case_key）不在——「这条怎么没匹配上」「把勾选的跑一遍」靠它们。 */
  usePageContext({
    page: "repo-case-tree",
    filters: {
      ...(keyword ? { keyword } : {}),
      ...(status !== "active" ? { status } : {}),
    },
    ...(detail ? {
      entities: {
        caseId: detail.caseId,
        ...(detail.endpointId ? { endpointId: detail.endpointId } : {}),
        ...(detail.endpointName ? { endpointName: detail.endpointName } : {}),
      },
    } : {}),
    ...(selected.size ? { selection: [...selected] } : {}),
  });

  function patchParams(next: Record<string, string | undefined>) {
    setSearchParams((current) => {
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined || value === "") current.delete(key);
        else current.set(key, value);
      }
      return current;
    }, { replace: true });
  }

  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    let alive = true;
    setLoading(true);
    void api.repoCases(projectId, { keyword, status, page, pageSize })
      .then((result) => { if (alive) setTree(result); })
      .catch(() => { if (alive) message.error(t("repoCases.loadFailed")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, loadedProjectId, projectLoading, keyword, status, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 未归位用例单独取：它不在任何接口下，与树的分页无关。展开时才拉明细，但计数一直
     显示——「有几条挂不上」是这一页必须先说清的事实。 */
  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || !unplacedOpen) return;
    let alive = true;
    void api.unplacedRepoCases(projectId, 1, 100)
      .then((result) => { if (alive) { setUnplaced(result.items); setUnplacedTotal(result.total); } })
      .catch(() => { if (alive) message.error(t("repoCases.loadFailed")); });
    return () => { alive = false; };
  }, [projectId, loadedProjectId, unplacedOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 切项目清空勾选（跨项目勾选明确不支持，§8.3）。**换页 / 改筛选不清空**：那正是
     「先搜 order 勾一批、再搜 user 勾一批」的跨任务勾选工作流（§8.3 支持一次勾选触发
     多个任务），而勾选集按 case_key 存，页码变了 key 依旧有效。 */
  useEffect(() => { setSelected(new Set()); }, [projectId]);

  const coverage = tree?.coverage;
  const coverageRate = coverage && coverage.endpointTotal > 0
    ? Math.round((coverage.coveredEndpointTotal / coverage.endpointTotal) * 1000) / 10
    : null;

  /* 当前页树上所有用例的 key（全选框的分母）。未归位分组不进这个集合：它有自己的表，
     而「全选」应当只覆盖眼前这张表能看到的行。 */
  const pageKeys = tree ? [...new Set(tree.endpoints.flatMap((endpoint) => endpoint.cases.map((item) => item.caseKey)))] : [];
  const pageAllSelected = pageKeys.length > 0 && pageKeys.every((key) => selected.has(key));

  function toggleSelected(caseKey: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(caseKey); else next.delete(caseKey);
      return next;
    });
  }

  function togglePage(checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const key of pageKeys) { if (checked) next.add(key); else next.delete(key); }
      return next;
    });
  }

  /**
   * 打开触发弹窗：拉任务列表 + 问一次推荐（§8.3「默认推荐最近成功跑过并上报过这些
   * case_key 的任务」）。
   *
   * 推荐失败不拦住弹窗——它只是个预选值，用户自己能在下拉里选。
   */
  function openTrigger() {
    if (!projectId) return;
    const keys = [...selected];
    setTriggerOpen(true);
    setRecommendation(undefined);
    /* 幂等键随「这一次要触发的意图」生成：同一个弹窗里重试（比如第一次撞了 2004、起了
       Runner 再点）复用同一个键，因此不会产出两条 run。 */
    setIdempotencyKey(crypto.randomUUID());
    void api.ciTasks(projectId, 1, 100)
      .then((result) => {
        setTasks(result.items);
        /*
         * 预选：**只有一个启用的任务时用它**，多个就留空让用户选（P4.5-14 删掉了「默认
         * 任务」那一列——「项目里只有一个任务」这件事数一下就知道，不需要一列去声明）。
         * 推荐命中会在下面覆盖这个预选。
         */
        const enabledTasks = result.items.filter((task) => task.enabled);
        setTaskId((current) => current ?? (enabledTasks.length === 1 ? enabledTasks[0].id : undefined));
      })
      .catch(() => message.error(t("repoCases.taskLoadFailed")));
    void api.recommendCiTask(projectId, keys)
      .then((result) => {
        setRecommendation(result);
        if (result.ciTaskId) setTaskId(result.ciTaskId);
      })
      .catch(() => { /* 推荐是建议不是前提，失败静默 */ });
  }

  /**
   * 触发勾选执行。
   *
   * 成功后**不清空勾选**：§8.3 支持一次勾选触发多个任务（各跑全集筛选，脚本自己跳过
   * 不认识的 key），清掉就要重新勾一遍。清掉的时机由用户按 bulk-bar 上的 × 决定。
   */
  async function runSelected() {
    if (!projectId || !taskId) return;
    setTriggering(true);
    try {
      const run = await api.triggerCiTask(projectId, taskId, { caseKeys: [...selected], idempotencyKey });
      setTriggerOpen(false);
      if (run.idempotentReplay) message.info(t("repoCases.triggerReplayed", { number: run.runNumber }));
      else message.success(t("repoCases.triggered", { number: run.runNumber }));
      navigate(`/projects/${projectId}/pipeline-runs/${run.id}`);
    } catch (error) {
      /* 2004 是「这个分区没有在线 Runner」，与「队列挂了」是两个处置动作（noRunnerLabel
         的单一判定，六处执行入口共用）。 */
      const label = noRunnerLabel(error);
      message.error(label === undefined
        ? (error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("repoCases.triggerFailed")
        : t("repoCases.noRunner", { label }));
    } finally {
      setTriggering(false);
    }
  }

  return <main className="content">
    <RepoPageHead title={t("repoCases.title")} hint={t("repoCases.hint")} />
    <RepoTabs active="tree" />

    {coverage && <div className="readouts">
      {/* 这份覆盖只在本页算、本页显示（边界 2）：看板的覆盖率口径本阶段一个字都不改。 */}
      <Readout label={t("repoCases.coveredEndpoints")} value={`${coverage.coveredEndpointTotal}/${coverage.endpointTotal}`} />
      <Readout label={t("repoCases.coverageRate")} value={coverageRate === null ? "—" : coverageRate.toFixed(1)} unit="%" />
      <Readout label={t("repoCases.distinctCases")} value={coverage.distinctCaseTotal} />
      <Readout label={t("repoCases.unplacedCases")} value={coverage.unplacedCaseTotal} />
    </div>}
    {/* 两个计数口径不同，必须写明（边界 9）：接口上的「用例数」是关系数，项目级是
        distinct case_key，相加不相等。 */}
    <p className="form-note">{t("repoCases.countingNote")}</p>

    <div className="filter-bar">
      <input
        className="input mono"
        value={keyword}
        onChange={(event) => patchParams({ keyword: event.target.value, page: undefined })}
        placeholder={t("repoCases.searchPlaceholder")}
        style={{ width: 260 }}
      />
      <label className="check-field">
        <input
          type="checkbox"
          checked={status === "all"}
          onChange={(event) => patchParams({ status: event.target.checked ? "all" : undefined, page: undefined })}
        />
        {t("repoCases.showRemoved")}
      </label>
      <span className="filter-spacer" />
      {coverage && <span className="muted mono">{t("repoCases.removedTotal", { count: coverage.removedCaseTotal })}</span>}
    </div>

    {/* 勾选执行的操作条（§8.3，照 EndpointList 的 bulk-bar 形状）。**不是接口模式批量
        调试的等价物**：平台不持有测试代码，只传 case_filter + 收结果 + 对账，所以文案
        与那边不同，且必须把「快不快取决于仓库脚本」说出来（§8.3 落地点末条）。 */}
    {canWrite && selected.size > 0 && <div className="bulk-bar">
      <strong>{t("repoCases.selectedCount", { count: selected.size })}</strong>
      <button className="btn btn-primary btn-with-icon" disabled={triggering} onClick={openTrigger}>
        <Play size={14} />{t("repoCases.triggerRepoTask")}
      </button>
      <button className="btn btn-icon" title={t("action.cancel")} onClick={() => setSelected(new Set())}><X size={15} /></button>
    </div>}

    {loading && <p className="muted">{t("common.loading")}</p>}

    {tree && tree.endpoints.length > 0 && <div className="table-scroll"><table className="grid grid-fixed">
      {/* 列宽固定（grid-fixed）：auto 布局下展开一组用例行会让列宽随全部行内容重新
          分配、整表跳一次；fixed + 显式宽度让列宽与展开状态无关。 */}
      <colgroup>
        <col style={{ width: 42 }} />
        <col />
        <col style={{ width: 200 }} />
        <col style={{ width: 120 }} />
        <col style={{ width: 210 }} />
        <col style={{ width: 90 }} />
      </colgroup>
      <thead><tr>
        <th className="col-select">
          {/* 全选覆盖的是**当前页树上的用例**，与展开状态无关：收起的接口下那些用例仍在
              本页数据里，勾了它们是用户的意图（他勾的是「这一页」）。 */}
          {canWrite && <input
            type="checkbox"
            aria-label={t("repoCases.selectPage")}
            checked={pageAllSelected}
            onChange={(event) => togglePage(event.target.checked)}
          />}
        </th>
        <th>{t("repoCases.caseName")}</th>
        <th>{t("repoCases.filePath")}</th>
        <th>{t("repoCases.tags")}</th>
        <th>{t("repoCases.reportTaskWithTime")}</th>
        <th className="col-status">{t("repoCases.lastResult")}</th>
      </tr></thead>
      <tbody>
        {tree.endpoints.map((endpoint) => {
          const open = expanded.has(endpoint.endpointId);
          const endpointKeys = endpoint.cases.map((item) => item.caseKey);
          const allSelected = endpointKeys.length > 0 && endpointKeys.every((key) => selected.has(key));
          return <Fragment key={endpoint.endpointId}>
            {/* 接口是树的中间层，它自己不是一次执行，所以这一行只有身份与计数。 */}
            <tr data-clickable onClick={() => setExpanded((current) => {
              const next = new Set(current);
              if (next.has(endpoint.endpointId)) next.delete(endpoint.endpointId); else next.add(endpoint.endpointId);
              return next;
            })}>
              {/* 接口行的勾选框 = 勾上它下面全部用例（收起时也能整组勾，这是「按接口
                  跑一遍」最短的路径）。三态里的中间态用 indeterminate 表达。 */}
              <td className="col-select" onClick={(event) => event.stopPropagation()}>
                {canWrite && <input
                  type="checkbox"
                  aria-label={t("repoCases.selectEndpointCases", { name: endpoint.name })}
                  checked={allSelected}
                  ref={(node) => { if (node) node.indeterminate = !allSelected && endpointKeys.some((key) => selected.has(key)); }}
                  onChange={(event) => setSelected((current) => {
                    const next = new Set(current);
                    for (const key of endpointKeys) { if (event.target.checked) next.add(key); else next.delete(key); }
                    return next;
                  })}
                />}
              </td>
              <td colSpan={5}>
                <span className="cell-name">
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <Method method={endpoint.method} />
                  <Tip text={endpoint.name}><strong className="truncate">{endpoint.name}</strong></Tip>
                  <Tip text={endpoint.url}><span className="mono muted truncate">{endpoint.url}</span></Tip>
                </span>
              </td>
              <td className="col-status mono">{t("repoCases.caseCount", { count: endpoint.caseCount })}</td>
            </tr>
            {open && endpoint.cases.map((item) => <CaseRow
              key={`${endpoint.endpointId}:${item.id}`}
              item={item}
              selectable={canWrite}
              selected={selected.has(item.caseKey)}
              onSelect={toggleSelected}
              onOpen={(clicked) => setDetail({ caseId: clicked.id, endpointId: endpoint.endpointId, endpointName: endpoint.name })}
              onOpenRun={openRun}
            />)}
          </Fragment>;
        })}
      </tbody>
    </table></div>}

    {tree && !tree.endpoints.length && !loading && <Empty
      title={keyword ? t("repoCases.emptyFilterTitle") : t("repoCases.emptyTitle")}
      hint={keyword ? t("repoCases.emptyFilterHint") : t("repoCases.emptyHint")}
    />}

    {tree && tree.total > pageSize && <div className="pager">
      <Pagination
        current={page}
        pageSize={pageSize}
        total={tree.total}
        pageSizeOptions={PAGE_SIZES}
        showSizeChanger
        onChange={(nextPage, nextSize) => patchParams({ page: String(nextPage), pageSize: nextSize === 20 ? undefined : String(nextSize) })}
      />
    </div>}

    {/* ── 未归位用例（边界 21）：与未匹配诊断并列的第二个分组 ─────────────── */}
    {coverage && coverage.unplacedCaseTotal > 0 && <section className="panel">
      <div className="panel-head">
        <strong>{t("repoCases.unplacedGroup", { count: coverage.unplacedCaseTotal })}</strong>
        <button className="btn" onClick={() => setUnplacedOpen((current) => !current)}>
          {unplacedOpen ? t("action.close") : t("repoCases.expand")}
        </button>
      </div>
      <div className="panel-body">
        <p className="form-note">{t("repoCases.unplacedHint")}</p>
        {unplacedOpen && (unplaced.length ? <div className="table-scroll"><table className="grid grid-fixed">
          {/* 与主树同款固定列宽：展开/收起面板时列宽不跳。 */}
          <colgroup>
            <col style={{ width: 42 }} />
            <col />
            <col style={{ width: 200 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 210 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          <thead><tr>
            {/* 未归位的用例一样能勾选执行：它们是真实的仓库用例，只是没打到本项目登记的
                接口——「没归位」不影响它按 case_key 被筛选执行。这里不给全选框，因为这张
                表是截断显示的（只取前 100 条），全选会造出一个与眼前不符的集合。
                「接口数」列已删：未归位 = 没有任何接口关系，那一列恒为 0。 */}
            <th className="col-select" />
            <th>{t("repoCases.caseName")}</th>
            <th>{t("repoCases.filePath")}</th>
            <th>{t("repoCases.tags")}</th>
            <th>{t("repoCases.reportTaskWithTime")}</th>
            <th className="col-status">{t("repoCases.lastResult")}</th>
          </tr></thead>
          <tbody>{unplaced.map((item) => <CaseRow
            key={item.id}
            item={item}
            selectable={canWrite}
            selected={selected.has(item.caseKey)}
            onSelect={toggleSelected}
            onOpen={(clicked) => setDetail({ caseId: clicked.id })}
            onOpenRun={openRun}
          />)}</tbody>
        </table></div> : <p className="muted">{t("common.loading")}</p>)}
        {unplacedOpen && unplacedTotal > unplaced.length && <p className="form-note">{t("repoCases.unplacedTruncated", { shown: unplaced.length, total: unplacedTotal })}</p>}
      </div>
    </section>}

    {/* ── 勾选执行的任务选择弹窗（§8.3） ────────────────────────────────── */}
    <Modal
      title={t("repoCases.triggerTitle", { count: selected.size })}
      open={triggerOpen}
      onCancel={() => setTriggerOpen(false)}
      onOk={() => void runSelected()}
      okText={triggering ? t("action.running") : t("repoCases.triggerRepoTask")}
      okButtonProps={{ disabled: !taskId }}
      cancelText={t("action.cancel")}
      confirmLoading={triggering}
    >
      {/* 三句话必须说全，否则用户会拿它跟接口模式的批量调试比（§8.3 落地点末条）：
          ① 平台只传筛选参数、真正只跑选中要靠仓库脚本消费；② 没跑到的会标「未执行」
          而不是静默算通过；③ 快慢取决于常驻 Runner 与缓存命中，不是毫秒级。 */}
      <p className="form-note">{t("repoCases.triggerHint")}</p>
      <label className="field">
        <span>{t("repoCases.triggerTask")}</span>
        <Select
          value={taskId}
          onChange={setTaskId}
          placeholder={t("repoCases.triggerTaskPlaceholder")}
          loading={tasks === undefined}
          options={(tasks ?? []).map((task) => ({
            value: task.id,
            disabled: !task.enabled,
            label: `${task.name}${task.enabled ? "" : ` · ${t("repoCases.taskDisabled")}`}`,
          }))}
          style={{ width: "100%" }}
        />
      </label>
      {tasks !== undefined && !tasks.length && <p className="form-note">{t("repoCases.noTasks")}</p>}
      {recommendation?.reason === "recent_hit" && <p className="form-note">
        {t("repoCases.recommendRecentHit", { hits: recommendation.hitCount, total: recommendation.caseKeyTotal })}
      </p>}
      {/* 没有历史命中、且项目里不止一个任务：说明这是在让用户自己选，而不是平台没想法
          （P4.5-14 删掉了「默认任务」那一档兜底——只有一个任务时上面已经预选好了）。 */}
      {recommendation && !recommendation.ciTaskId && (tasks?.length ?? 0) > 1
        && <p className="form-note">{t("repoCases.recommendNone")}</p>}
    </Modal>

    {detail && <CaseDetailDrawer
      caseId={detail.caseId}
      endpointId={detail.endpointId}
      endpointName={detail.endpointName}
      onClose={() => setDetail(undefined)}
    />}
  </main>;
}
