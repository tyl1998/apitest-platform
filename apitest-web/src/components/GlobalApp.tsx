import { useEffect, useState } from "react";
import { Form, Input, Modal, Pagination, Select, Switch, message } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Folder, LayoutDashboard, LogOut, Settings, type LucideIcon } from "lucide-react";
import { api, isStatsTimeoutError, type Preferences, type ProjectMetric, type StatsFailures, type StatsOverview, type StatsProjectMetric, type StatsProjectRow, type StatsTrendBucket, type WorkerFleet, type WorkerMode } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useRecordLastPage } from "../hooks/useRecordLastPage";
import { useAuthStore } from "../stores/authStore";
import type { ModePreference } from "../theme";
import { Delta, Empty, Readout, Status } from "../ui";
import { Donut, LineChart, Sparkline, StackedBars } from "./charts";
import { IconButton } from "./IconButton";
import { RunnerPoolPanel } from "./RunnerPoolPanel";
import { AssistantProvidersPanel } from "./AssistantProvidersPanel";
import { UsersPanel } from "./UsersPanel";
import { AuditLogsPanel } from "./AuditLogsPanel";
import { FailureCategoriesPanel } from "./FailureCategoriesPanel";
import { NotificationsPage } from "./NotificationsPage";

type GlobalPage = "dashboard" | "projects" | "system" | "notifications";

const PAGE_SIZES = [10, 20, 50, 100];

/* 榜单指标（2026-09-11 用户增补）：默认失败量；三个覆盖率维同列同榜，切换只换排序。
 * passRate 不进榜——通过率与失败量是同一份数据的正反面，榜会完全同构。 */
const BOARD_METRICS: { value: StatsProjectMetric; order: "asc" | "desc" }[] = [
  { value: "failed", order: "desc" },
  { value: "coverage", order: "asc" },
  { value: "automation", order: "asc" },
  { value: "attribution", order: "asc" },
];

/**
 * 归因分布环形的分类色：与项目层统计页（Trends.tsx）同一套纪律——归因分类是
 * **分类**不是**语义**，七类各配一个色相会把面板变成调色盘。已归因各片走强调色
 * 明度阶梯，未归因是中性的 line 灰。复制而不是从 Trends 导出：那是一段排版常量，
 * 两处各自演化比跨页耦合一个色数组便宜（哪天真要改，grep 这个注释能找到两处）。
 */
const ATTRIBUTION_COLORS = [
  "var(--accent)",
  "color-mix(in oklab, var(--accent) 68%, var(--surface))",
  "color-mix(in oklab, var(--accent) 45%, var(--surface))",
  "color-mix(in oklab, var(--accent) 28%, var(--surface))",
  "var(--ink-3)",
  "color-mix(in oklab, var(--ink-3) 55%, var(--surface))",
  "var(--line-strong)",
];

export function GlobalApp({ page, themePreference, onThemeChange }: { page: GlobalPage; themePreference: ModePreference; onThemeChange: (mode: ModePreference) => void }) {
  useRecordLastPage();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, i18n } = useTranslation();
  const logout = useAuthStore((state) => state.logout);
  const nav: [GlobalPage, string, LucideIcon][] = [["dashboard", t("nav.dashboard"), LayoutDashboard], ["projects", t("nav.projects"), Folder], ["system", t("nav.system"), Settings]];

  /* 顶层导航壳（2026-09-10）：全局层只有三个页面，侧栏在这里只会烧掉 210px 宽度
     却给不了分组价值（分组真正干活的地方是项目壳的 15 项导航）。导航移进 topbar，
     与 ≤940px 断点下侧栏溶解成的顶栏模式同构。三区布局（第二轮走查反馈）：
     lockup 左、导航居中（flex:1 吃满中段，不贴 logo）、退出右缘。data-topnav
     让壳 grid 收成单列（见 design-system.css 的 [data-topnav] 块）。 */
  return <div className="console" data-topnav="">
    <div className="frame">
      <header className="topbar">
        <div className="lockup"><span className="lockup-mark mono">AT</span><span className="lockup-name">{t("app.name")}</span></div>
        <nav className="topbar-nav" aria-label={t("nav.global")}>
          {nav.map(([key, label, Icon]) => (
            <button key={key} className={`nav-item${page === key ? " is-active" : ""}`} aria-current={page === key ? "page" : undefined} onClick={() => navigate(`/${key}`)}>
              <Icon size={14} />{label}
            </button>
          ))}
        </nav>
        {/* 与项目壳同款退出控件：topbar 右缘，不随导航滚动。通知入口（2026-09-16）
            移入站内助手——铃铛位现在是助手入口的槽位（AssistantDock portal 进来：
            头像按钮 + 未读徽标），抽屉内有最近通知。 */}
        <div className="topbar-actions">
          <span id="assistant-topbar-slot" className="assistant-topbar-slot" />
          <IconButton
            icon={<LogOut size={15} />}
            label={t("action.logout")}
            onClick={() => { logout(); navigate(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`); }}
          />
        </div>
      </header>
      <main className="content">
        {/* 页面卡片（第四轮走查：内容与顶栏要明确分层）：surface 底 + 边框把
            「这是页面内容」圈出来，与 topbar（同 surface 但有 border-bottom 分界）
            和 --bg 页底构成三层。卡片即全宽——不再有居中窄列。 */}
        <div className="page-card">
          {page === "dashboard" && <DashboardPage />}
          {page === "projects" && <ProjectsPage />}
          {page === "system" && <SystemPage themePreference={themePreference} onThemeChange={onThemeChange} language={i18n.language === "en" ? "en" : "zh-CN"} />}
          {page === "notifications" && <NotificationsPage />}
        </div>
      </main>
    </div>
  </div>;
}

/**
 * 数据看板 = 全局统计页（P8-6，边界 18：加了趋势图之后不再开第二个统计页）。
 * 2026-09-10 验收五轮①②⑥改版，四段自上而下：
 *
 * 1. **项目筛选**（②）：`?project=` 进地址栏；「全部项目」= 全局聚合，选定项目 =
 *    下面所有读数与趋势图都钉在该项目上（`/stats/*` 带 projectIds 复用同一组口径）。
 *    选定项目时跨项目的 Top 10 榜没有意义，整段收起，换「进入项目数据统计」入口。
 * 2. **读数区两行**：执行面（执行量/通过率/失败量 + 接口覆盖率/自动化覆盖率/归因
 *    覆盖率，2026-09-10 验收六轮①补回——前两个带分子分母，归因未归因余量单列一格）
 *    + 资产面六卡（接口总量 + sparkline / 平台用例 / 流程 / 套件 / 仓库用例 / 文本
 *    用例总量）。全部来自 `/stats/overview`（days=30）。
 * 3. **趋势三张图**（⑥：「概览没办法整体看出具体情况」——通过率折线 + 执行量堆叠柱
 *    + 耗时分位，与项目层数据统计页同一套图表底座；选定项目时点桶可下钻，语义与
 *    项目页一致：父执行记录大类 + 桶时间窗，不预置 status/kind——「展示全部」）。
 * 3b. **失败归因分布**（2026-09-10 用户增补）：环形 + 覆盖率纪律行，与项目层统计页
 *    同一份 /stats/failures；看板口径写死 30d + 全部来源，来源筛选归统计页深挖。
 * 4. **项目 Top 10 反向榜**（只「全部项目」时）：默认按失败量降序「最差在前」，
 *    2026-09-11 用户增补指标切换（接口覆盖率/自动化覆盖率/归因覆盖率，升序最低
 *    在前）。归因覆盖率列保留。榜的关键字检索仍撤着——找项目归项目管理页，榜的
 *    职责是「最差在前」不是「找得到」。
 */
function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  /* 手动刷新（边界 16）：统计是聚合读，进入拉一次 + 手动刷新，不接 SSE。 */
  const [revision, setRevision] = useState(0);

  /* 项目筛选（②）：选项就是可见项目集（后端按成员过滤，与管理页同源）。选了项目但
     清单未到时不发统计请求——一个不可见/拼错的 id 会 403，等一拍比闪一次错误态好。 */
  const projectParam = searchParams.get("project") ?? "";
  const [projectOptions, setProjectOptions] = useState<ProjectMetric[]>();
  const project = projectOptions?.find((each) => each.id === projectParam);
  const filtered = Boolean(project);
  const scopeReady = !projectParam || projectOptions !== undefined;

  const [overview, setOverview] = useState<StatsOverview>();
  const [overviewState, setOverviewState] = useState<"loading" | "timeout" | "error">();
  const [buckets, setBuckets] = useState<StatsTrendBucket[]>();
  const [trendState, setTrendState] = useState<"loading" | "timeout" | "error">();
  const [endpointSpark, setEndpointSpark] = useState<number[]>();
  const [projects, setProjects] = useState<StatsProjectRow[]>();
  const [projectsState, setProjectsState] = useState<"loading" | "timeout" | "error">();
  /* 榜单排序指标（2026-09-11 用户增补）：进地址栏与 page/project 同款约定，切指标
     刷新出来的榜可分享。默认失败量（原形态）。 */
  const boardMetricParam = searchParams.get("boardMetric") ?? "failed";
  const boardMetric = BOARD_METRICS.some((each) => each.value === boardMetricParam) ? (boardMetricParam as StatsProjectMetric) : "failed";
  const boardOrder = BOARD_METRICS.find((each) => each.value === boardMetric)?.order ?? "desc";
  /* 失败归因分布（2026-09-10 用户增补）：与项目层统计页同一份 /stats/failures——
     看板窗口恒 30d、不筛来源（human/mcp 的来源筛是统计页深挖位）。 */
  const [failures, setFailures] = useState<StatsFailures>();
  const [failuresState, setFailuresState] = useState<"loading" | "timeout" | "error">();

  useEffect(() => {
    let alive = true;
    void api.projectList({ page: 1, pageSize: 100 })
      .then((result) => { if (alive) setProjectOptions(result.items); })
      .catch(() => { if (alive) setProjectOptions([]); });
    return () => { alive = false; };
  }, []);

  /* 看板固定 30d 窗口（边界 17）：90d/180d 深挖归项目层「数据统计」页。读数与趋势取
     `all` 口径（平台 + 仓库一起算）——看板是盘点页，静默漏掉仓库 CI 会与「全局」自相
     矛盾；混合口径的说明由 trendNote / passRateTip.all 承担。 */
  useEffect(() => {
    if (!scopeReady) return;
    let alive = true;
    setOverview(undefined); setOverviewState("loading");
    void api.statsOverview({ days: 30, scope: "all", ...(project ? { projectIds: [project.id] } : {}) })
      .then((result) => { if (alive) { setOverview(result); setOverviewState(undefined); } })
      .catch((error) => { if (alive) setOverviewState(isStatsTimeoutError(error) ? "timeout" : "error"); });
    return () => { alive = false; };
  }, [scopeReady, project, revision]);

  /* 趋势三张图（⑥）：一次 execution_trend 拉全——三张图共享同一份桶，分三次请求只会
     得到三份相同的数据。独立于 overview 到达——图缺席不该挡住读数，反之亦然。 */
  useEffect(() => {
    if (!scopeReady) return;
    let alive = true;
    setBuckets(undefined); setTrendState("loading");
    void api.statsTrend({ days: 30, scope: "all", ...(project ? { projectIds: [project.id] } : {}) })
      .then((result) => { if (alive && result.metric === "execution_trend") setBuckets(result.buckets); })
      .catch((error) => { if (alive) setTrendState(isStatsTimeoutError(error) ? "timeout" : "error"); });
    return () => { alive = false; };
  }, [scopeReady, project, revision]);

  /* 接口总量 30 天日增形状（asset_trend）：资产面没有下面的图，sparkline 还是它唯一的
     走势位。缺席退成空图，不报错盖住读数。 */
  useEffect(() => {
    if (!scopeReady) return;
    let alive = true;
    setEndpointSpark(undefined);
    void api.statsTrend({ days: 30, metric: "asset_trend", ...(project ? { projectIds: [project.id] } : {}) })
      .then((result) => { if (alive && result.metric === "asset_trend") setEndpointSpark(result.buckets.map((bucket) => bucket.endpoints)); })
      .catch(() => { /* sparkline 缺席不是页面的失败。 */ });
    return () => { alive = false; };
  }, [scopeReady, project, revision]);

  /* Top 10 反向榜：只在「全部项目」时存在（②：筛了项目还看跨项目榜是自相矛盾）。
     默认 failed 降序；覆盖率类指标升序（最低在前 = 最差在前）。同轮把榜的关键字
     检索一并撤了（用户复验：「搜索框没用了」——找项目去项目管理页搜，榜的职责
     是「最差在前」不是「找得到」，一个只服务于榜的搜索框读不出作用）。 */
  useEffect(() => {
    if (filtered || !scopeReady) return;
    let alive = true;
    setProjects(undefined); setProjectsState("loading");
    void api.statsProjects({ days: 30, metric: boardMetric, order: boardOrder, limit: 10, scope: "all" })
      .then((result) => { if (alive) { setProjects(result.projects); setProjectsState(undefined); } })
      .catch((error) => { if (alive) setProjectsState(isStatsTimeoutError(error) ? "timeout" : "error"); });
    return () => { alive = false; };
  }, [filtered, scopeReady, boardMetric, boardOrder, revision]);

  /* 归因分布：无论筛没筛项目都存在（「这个项目/全平台的失败都归到哪些类」两种问法
     都成立）。只取分布段——TopN 榜是统计页的深挖位，看板已有自己的项目榜。 */
  useEffect(() => {
    if (!scopeReady) return;
    let alive = true;
    setFailures(undefined); setFailuresState("loading");
    void api.statsFailures({ days: 30, ...(project ? { projectIds: [project.id] } : {}) })
      .then((result) => { if (alive) { setFailures(result); setFailuresState(undefined); } })
      .catch((error) => { if (alive) setFailuresState(isStatsTimeoutError(error) ? "timeout" : "error"); });
    return () => { alive = false; };
  }, [scopeReady, project, revision]);

  /**
   * 趋势桶下钻（只在选定项目时接线）：与项目层统计页 drillBucket 同一语义——落「父
   * 执行记录」大类 + 桶时间窗，**不预置 status、不预设 kind**（「全部项目」时没有
   * 可去的单项目列表，图不给点；30d 窗口恒为天桶，步长写死 24h）。
   */
  function drillBucket(index: number) {
    if (!project || !buckets?.length) return;
    const from = buckets[index];
    if (!from || from.total === 0) return;
    const to = new Date(new Date(from.bucket).getTime() + 24 * 3_600_000).toISOString();
    navigate(`/projects/${project.id}/reports?type=parent&from=${encodeURIComponent(from.bucket)}&to=${encodeURIComponent(to)}`);
  }

  /**
   * ── 读数下钻（2026-09-10，「选了项目时期望点数据进项目内」）──
   *
   * 只在选定项目时接线（`filtered`）：全部项目时没有单项目落点，与趋势图同判不给点。
   * 三条纪律沿项目层统计页（P8-6 验收三轮「下钻不预置结论」+ 归因片判例）：
   * - 执行量/通过率分边/归因分边 → 父执行记录 + 30d 时间窗；不预置 kind；
   * - 失败量/通过率的失败边 → `status=failed`——数字语义本身就是失败（同归因片）；
   * - 通过率的成功边 → `status=success`（「点 92.7% 的分子」就是问通过了哪些）。
   * 时间窗 = 当前 30d 窗（可清除 chip 呈现，不静默缩窄）。
   */
  function reportUrl(status?: string): string {
    if (!project) return "";
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const to = new Date().toISOString();
    const query = [
      "type=parent",
      ...(status ? [`status=${status}`] : []),
      `from=${encodeURIComponent(from)}`,
      `to=${encodeURIComponent(to)}`,
    ];
    return `/projects/${project.id}/reports?${query.join("&")}`;
  }

  /** 分边下钻面板（悬浮弹出）：通过率「通过 x / 失败 x」两边各带 status。 */
  const passRateDrill = filtered && project ? {
    sides: [
      { label: t("dashboard.drillPassed", { count: overview?.executions.successCount ?? 0 }), onClick: () => navigate(reportUrl("success")) },
      { label: t("dashboard.drillFailed", { count: overview?.executions.failedCount ?? 0 }), onClick: () => navigate(reportUrl("failed")) },
    ],
    note: t("trends.passRateTip.all"),
  } : undefined;
  const attributionDrill = filtered && project && overview ? {
    sides: [
      { label: t("dashboard.drillAttributed", { count: overview.attribution.attributed }), onClick: () => navigate(`/projects/${project.id}/suite-reports?attribution=__attributed__`) },
      { label: t("dashboard.drillUnattributed", { count: overview.attribution.unattributed }), onClick: () => navigate(`/projects/${project.id}/suite-reports?attribution=__unattributed__`) },
    ],
    note: t("trends.attributionTip"),
  } : undefined;
  /** 三个覆盖率读数的分边面板（「已覆盖 x / 未覆盖 x」的两侧各自可点）。 */
  const coverageDrill = filtered && project && overview ? {
    sides: [
      { label: t("dashboard.drillCovered", { count: overview.assets.coveredEndpointTotal }), onClick: () => navigate(`/projects/${project.id}/endpoints?coverage=covered`) },
      { label: t("dashboard.drillUncovered", { count: overview.assets.endpointTotal - overview.assets.coveredEndpointTotal }), onClick: () => navigate(`/projects/${project.id}/endpoints?coverage=uncovered`) },
    ],
    note: t("dashboard.coverageFractionTip", { covered: overview.assets.coveredEndpointTotal, total: overview.assets.endpointTotal }),
  } : undefined;
  const automationDrill = filtered && project && overview ? {
    sides: [
      { label: t("dashboard.drillAutomated", { count: overview.assets.specAutomatedTotal }), onClick: () => navigate(`/projects/${project.id}/spec-cases?status=reviewed&automation=yes`) },
      { label: t("dashboard.drillUnautomated", { count: overview.assets.specReviewedTotal - overview.assets.specAutomatedTotal }), onClick: () => navigate(`/projects/${project.id}/spec-cases?status=reviewed&automation=no`) },
    ],
    note: t("dashboard.automationFractionTip", { automated: overview.assets.specAutomatedTotal, total: overview.assets.specReviewedTotal }),
  } : undefined;

  const deltaTip = t("trends.deltaTip");
  const settled = (buckets ?? []).filter((bucket) => bucket.total > 0);
  return <>
    <div className="page-head">
      <div><h1>{t("dashboard.title")}</h1><p>{t("dashboard.hint")}</p></div>
      <div className="topbar-actions">
        <Select
          value={project?.id}
          onChange={(id) => setSearchParams((current) => {
            if (id) current.set("project", id); else current.delete("project");
            return current;
          }, { replace: true })}
          placeholder={t("dashboard.projectFilterAll")}
          allowClear
          showSearch
          optionFilterProp="label"
          options={(projectOptions ?? []).map((each) => ({ value: each.id, label: each.name }))}
          style={{ width: 200 }}
        />
        {/* filtered 与 project 同真同假（filtered 就是 Boolean(project) 的别名），双重
            判断只为让 TS 收窄——按钮里要取 project.id。 */}
        {filtered && project && <button className="btn" onClick={() => navigate(`/projects/${project.id}/trends`)}>{t("dashboard.enterTrends")}</button>}
        <button className="btn" onClick={() => setRevision((current) => current + 1)}>{t("trends.refresh")}</button>
      </div>
    </div>
    {filtered && <p className="form-note">{t("dashboard.filteredHint")}</p>}

    {overviewState === "timeout" && <Empty title={t("trends.timeoutTitle")} hint={t("trends.timeoutHint")} action={<button className="btn" onClick={() => setRevision((current) => current + 1)}>{t("trends.refresh")}</button>} />}
    {overviewState === "error" && <p className="form-error">{t("dashboard.loadFailed")}</p>}
    {overviewState === "loading" && <p className="muted">{t("filter.searching")}</p>}

    {overview && <>
      {/* 执行面读数（窗口 30d）：量/率 + 三个覆盖率；通过率的形状由下面的图承担，
          读数不再叠 sparkline。选定项目时全部可下钻（悬浮弹分边面板）；执行量与
          失败量整卡直点（全部父执行 / status=failed——失败数字的语义即失败）。 */}
      <div className="readouts">
        <Readout
          label={t("trends.readoutExecutions")}
          value={overview.executions.total}
          onClick={filtered ? () => navigate(reportUrl()) : undefined}
          extra={<Delta value={overview.delta.executions} tip={deltaTip} />}
        />
        <Readout
          label={t("dashboard.passRate")}
          value={overview.executions.passRate === null ? "—" : overview.executions.passRate.toFixed(1)}
          unit={overview.executions.passRate === null ? undefined : "%"}
          tip={t("trends.passRateTip.all")}
          drill={passRateDrill}
          extra={<Delta value={overview.delta.passRate} kind="pp" goodWhenUp tip={deltaTip} />}
        />
        <Readout
          label={t("trends.readoutFailed")}
          value={overview.executions.failedCount}
          onClick={filtered ? () => navigate(reportUrl("failed")) : undefined}
          extra={<Delta value={overview.delta.failed} goodWhenUp={false} tip={deltaTip} />}
        />
        {/* 三个覆盖率带分子分母（验收六轮①：读数单给 68.1% 看不出「总量」——分母是
            多大、离 100% 差多少行，是这些百分比的另一半事实）。接口/自动化覆盖的
            口径同资产面存量；归因覆盖率的分母是 30d 窗口内失败目标数。选定项目时
            悬浮面板分边可点（已覆盖/未覆盖各去各的列表）。 */}
        <Readout
          label={t("dashboard.coverageRate")}
          value={overview.assets.coverageRate === null ? "—" : overview.assets.coverageRate.toFixed(1)}
          unit={overview.assets.coverageRate === null ? undefined : "%"}
          tip={t("dashboard.coverageFractionTip", { covered: overview.assets.coveredEndpointTotal, total: overview.assets.endpointTotal })}
          drill={coverageDrill}
          extra={<span className="delta">{overview.assets.coveredEndpointTotal}/{overview.assets.endpointTotal}</span>}
        />
        <Readout
          label={t("dashboard.automationRate")}
          value={overview.assets.automationRate === null ? "—" : overview.assets.automationRate.toFixed(1)}
          unit={overview.assets.automationRate === null ? undefined : "%"}
          tip={t("dashboard.automationFractionTip", { automated: overview.assets.specAutomatedTotal, total: overview.assets.specReviewedTotal })}
          drill={automationDrill}
          extra={<span className="delta">{overview.assets.specAutomatedTotal}/{overview.assets.specReviewedTotal}</span>}
        />
        <Readout
          label={t("trends.readoutAttribution")}
          value={overview.attribution.coverageRate === null ? "—" : overview.attribution.coverageRate.toFixed(1)}
          unit={overview.attribution.coverageRate === null ? undefined : "%"}
          tip={t("trends.attributionTip")}
          drill={attributionDrill}
          extra={overview.attribution.failedTargets > 0 && <Delta value={overview.delta.attributionCoverageRate} kind="pp" goodWhenUp tip={deltaTip} />}
        />
        {/* 归因的分子分母带在标签位（extra 已让给 delta；分母 0 时整行不渲染）。
            已归因失败整卡直点（报告列表已归因筛选——与上面归因覆盖率的「已归因」边
            同一落点，这格本来就是那个数字）。 */}
        {overview.attribution.failedTargets > 0 && <Readout
          label={t("dashboard.attributionFraction")}
          value={overview.attribution.attributed}
          tip={t("trends.attributionTip")}
          onClick={filtered ? () => navigate(`/projects/${project!.id}/suite-reports?attribution=__attributed__`) : undefined}
          extra={<span className="delta">{overview.attribution.unattributed > 0 ? t("dashboard.attributionRemain", { count: overview.attribution.unattributed }) : undefined}</span>}
        />}
      </div>
      {/* 资产面六卡（①：census 事实格升卡片）。选定项目时整卡可点进对应的资产列表
          （口径注脚在 tip；仓库用例默认 active 与统计口径一致）。 */}
      <div className="readouts">
        <Readout
          label={t("dashboard.assetEndpointTotal")}
          value={overview.assets.endpointTotal}
          onClick={filtered ? () => navigate(`/projects/${project!.id}/endpoints`) : undefined}
          extra={endpointSpark && <Sparkline values={endpointSpark} ariaLabel={t("dashboard.endpointSparkline")} />}
        />
        <Readout label={t("dashboard.assetCaseTotal")} value={overview.assets.caseTotal} onClick={filtered ? () => navigate(`/projects/${project!.id}/endpoints?coverage=covered`) : undefined} />
        <Readout label={t("dashboard.assetFlowTotal")} value={overview.assets.flowTotal} onClick={filtered ? () => navigate(`/projects/${project!.id}/flows`) : undefined} />
        <Readout label={t("dashboard.assetSuiteTotal")} value={overview.assets.suiteTotal} onClick={filtered ? () => navigate(`/projects/${project!.id}/suites`) : undefined} />
        <Readout label={t("dashboard.assetRepoCaseTotal")} value={overview.assets.repoCaseTotal} onClick={filtered ? () => navigate(`/projects/${project!.id}/repo/tree`) : undefined} />
        <Readout label={t("dashboard.assetSpecTotal")} value={overview.assets.specCaseTotal} onClick={filtered ? () => navigate(`/projects/${project!.id}/spec-cases`) : undefined} />
      </div>
    </>}

    {/* ── 趋势三张图（⑥）：与项目层数据统计同一套底座与空态语义 ── */}
    {trendState === "timeout" && <Empty title={t("trends.timeoutTitle")} hint={t("trends.timeoutHint")} />}
    {trendState === "error" && <p className="form-error">{t("dashboard.loadFailed")}</p>}
    {trendState === "loading" && <p className="muted">{t("filter.searching")}</p>}
    {buckets && <>
      <p className="form-note">{t("dashboard.trendNote")}{filtered ? ` ${t("dashboard.trendDrillNote")}` : ""}</p>
      <section className="panel">
        <div className="panel-head"><strong>{t("trends.passRateTitle")}</strong>
          <ul className="chart-legend">
            <li><span className="chart-key" style={{ background: "var(--pass)" }} />{t("suiteReports.passRate")}</li>
          </ul>
        </div>
        <div className="panel-body">
          {settled.length
            ? <LineChart
                buckets={buckets.map((bucket) => bucket.bucket)}
                series={[{ values: buckets.map((bucket) => bucket.passRate), color: "var(--pass)", width: 1.8 }]}
                labels={[t("suiteReports.passRate")]}
                yMax={100}
                yFormat={(value) => `${value}%`}
                hourly={false}
                yTicks={[0, 50, 100]}
                onBucketClick={filtered ? drillBucket : undefined}
                ariaLabel={t("trends.passRateTitle")}
              />
            : <p className="form-note">{t("trends.noData")}</p>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><strong>{t("trends.volumeTitle")}</strong>
          <ul className="chart-legend">
            <li><span className="chart-key" style={{ background: "var(--pass)" }} />{t("status.pass")}</li>
            <li><span className="chart-key" style={{ background: "var(--fail)" }} />{t("status.fail")}</li>
          </ul>
        </div>
        <div className="panel-body">
          <StackedBars
            buckets={buckets.map((bucket) => ({
              bucket: bucket.bucket,
              values: [bucket.successCount, bucket.failedCount],
              total: bucket.total,
            }))}
            layers={[{ color: "var(--pass)" }, { color: "var(--fail)" }]}
            labels={[t("status.pass"), t("status.fail")]}
            hourly={false}
            hourlyLabels={(count) => count <= 10}
            onBucketClick={filtered ? drillBucket : undefined}
            ariaLabel={t("trends.volumeTitle")}
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><strong>{t("trends.durationTitle")}</strong>
          <ul className="chart-legend">
            <li><span className="chart-key chart-key-line" style={{ background: "var(--ink)" }} />{t("trends.p50")}</li>
            <li><span className="chart-key chart-key-line" style={{ background: "var(--ink-2)" }} />{t("trends.p90")}</li>
            <li><span className="chart-key chart-key-line" style={{ background: "var(--ink-3)" }} />{t("trends.p99")}</li>
          </ul>
        </div>
        <div className="panel-body">
          {/* 30d 窗口恒有分位（≤30d 才算，边界 23）；跨空桶连线与项目页同判（分位是
              每桶独立结论，「没执行」由读数条的「—」表达）。 */}
          {settled.some((bucket) => bucket.p50 !== null)
            ? <LineChart
                buckets={buckets.map((bucket) => bucket.bucket)}
                series={[
                  { values: buckets.map((bucket) => bucket.p50), color: "var(--ink)", width: 1.8 },
                  { values: buckets.map((bucket) => bucket.p90), color: "var(--ink-2)" },
                  { values: buckets.map((bucket) => bucket.p99), color: "var(--ink-3)", dash: "4 3" },
                ]}
                labels={[t("trends.p50"), t("trends.p90"), t("trends.p99")]}
                yMax={Math.max(1, ...buckets.map((bucket) => bucket.p99 ?? 0))}
                yFormat={(value) => (value >= 1000 ? `${(value / 1000).toFixed(0)}s` : `${Math.round(value)}ms`)}
                hourly={false}
                yTicks={[0, Math.round(Math.max(1, ...buckets.map((bucket) => bucket.p99 ?? 0)) / 2), Math.round(Math.max(1, ...buckets.map((bucket) => bucket.p99 ?? 0)))]}
                bridgeGaps
                onBucketClick={filtered ? drillBucket : undefined}
                ariaLabel={t("trends.durationTitle")}
              />
            : <p className="form-note">{t("trends.noData")}</p>}
        </div>
      </section>
    </>}

    {/* ── 失败归因分布（2026-09-10 用户增补）：与项目层统计页同一段 /stats/failures，
        看板口径写死 30d + 全部来源。展示纪律照搬边界 7：占比图必须同屏带覆盖率行——
        「40% 是环境问题」在只归因了 10% 失败时没有意义。片可点（选定项目时）：
        与统计页 drillAttribution 同一落点（报告列表 + attribution 筛选）。 ── */}
    <section className="panel">
      <div className="panel-head"><strong>{t("trends.attributionTitle")}</strong></div>
      <div className="panel-body">
        {failuresState === "timeout" && <Empty title={t("trends.timeoutTitle")} hint={t("trends.timeoutHint")} />}
        {failuresState === "error" && <p className="form-error">{t("dashboard.loadFailed")}</p>}
        {failuresState === "loading" && <p className="muted">{t("filter.searching")}</p>}
        {failures && <>
          {(() => {
            /* 已归因各分类（服务端已按量降序）+ 未归因片永远在最后（它在「失败都是
                为什么」这个问题里是第一等公民，不是残渣）。 */
            const segments = [
              ...failures.attribution.distribution.map((entry, index) => ({
                code: entry.code,
                label: entry.name,
                value: entry.count,
                color: ATTRIBUTION_COLORS[index % ATTRIBUTION_COLORS.length],
              })),
              ...(failures.attribution.unattributed > 0
                ? [{ code: "__unattributed__", label: t("dashboard.attributionUnattributed"), value: failures.attribution.unattributed, color: "var(--line)" }]
                : []),
            ];
            if (!segments.length) return <p className="form-note">{t("trends.noFailures")}</p>;
            return <>
              <Donut
                centerLabel={t("trends.summaryFailed")}
                segments={segments}
                onSliceClick={project ? (index) => navigate(`/projects/${project.id}/suite-reports?attribution=${encodeURIComponent(segments[index].code)}`) : undefined}
              />
              {failures.attribution.failedTargets > 0 && <p className="form-note">
                {t("trends.attributionLine", {
                  attributed: failures.attribution.attributed,
                  failed: failures.attribution.failedTargets,
                  unattributed: failures.attribution.unattributed,
                  rate: failures.attribution.coverageRate === null ? "—" : `${failures.attribution.coverageRate.toFixed(1)}%`,
                })}
              </p>}
            </>;
          })()}
        </>}
      </div>
    </section>

    {/* ── Top 10 反向榜（只「全部项目」；2026-09-11 用户增补指标切换：默认失败量，
        覆盖率三维同榜换排序）── */}
    {!filtered && <section className="panel">
      <div className="panel-head">
        <strong>{t("dashboard.projectTable")}</strong>
        {/* segmented 而非第二排下划线 tab：与趋势页口径选择同一形态判例（同页两排
            下划线 tab 在 4.5 否决过）。四列全在表里，切指标只换排序。 */}
        <div className="segmented" role="tablist" aria-label={t("dashboard.boardMetric")}>
          {BOARD_METRICS.map((each) => (
            <button
              key={each.value}
              role="tab"
              aria-selected={boardMetric === each.value}
              className={`segmented-item${boardMetric === each.value ? " is-active" : ""}`}
              onClick={() => setSearchParams((current) => {
                if (each.value === "failed") current.delete("boardMetric");
                else current.set("boardMetric", each.value);
                return current;
              }, { replace: true })}
            >{t(`dashboard.boardMetric.${each.value}`)}</button>
          ))}
        </div>
      </div>
      <div className="panel-body">
        {projectsState === "timeout" && <Empty title={t("trends.timeoutTitle")} hint={t("trends.timeoutHint")} />}
        {projectsState === "error" && <p className="form-error">{t("dashboard.loadFailed")}</p>}
        {projectsState === "loading" && <p className="muted">{t("filter.searching")}</p>}
        {projects && <>
          <p className="form-note">{t("dashboard.boardModeHint")}</p>
          {projects.length
            ? <table className="grid grid-board">
                {/* fixed 布局的列宽契约（见 design-system.css .grid-board 注释）：
                    名字列吃 26%，动作列定宽，七个数字列不指定宽度由浏览器均分
                    余量——八个「接口覆盖率」级的五字表头在 1680px measure 内都有
                    落位，再窄由表头换行兜底。 */}
                <colgroup>
                  <col style={{ width: "26%" }} />
                  <col span={7} />
                  <col style={{ width: 96 }} />
                </colgroup>
                <thead><tr>
                  <th>{t("dashboard.projects")}</th>
                  <th className="col-num">{t("dashboard.endpoints")}</th>
                  <th className="col-num">{t("dashboard.metric.coverage")}</th>
                  <th className="col-num">{t("dashboard.metric.automation")}</th>
                  <th className="col-num">{t("dashboard.executions")}</th>
                  <th className="col-num">{t("dashboard.metric.passRate")}</th>
                  <th className="col-num">{t("dashboard.metric.failed")}</th>
                  <th className="col-num">{t("trends.readoutAttribution")}</th>
                  <th />
                </tr></thead>
                <tbody>{projects.map((projectRow) => <tr key={projectRow.id} data-clickable="" onClick={() => navigate(`/projects/${projectRow.id}/trends`)}>
                  {/* fixed 布局下长名会穿进相邻格：truncate 把溢出收在列内。 */}
                  <td className="truncate"><strong>{projectRow.name}</strong></td>
                  <td className="col-num mono">{projectRow.coveredEndpointCount}/{projectRow.endpointCount}</td>
                  {/* null 与 0% 是两个事实（没有接口 / 全没覆盖），照趋势页同款区分。 */}
                  <td className="col-num mono">{projectRow.coverageRate === null ? "—" : `${projectRow.coverageRate.toFixed(1)}%`}</td>
                  <td className="col-num mono">{projectRow.automationRate === null ? "—" : `${projectRow.automationRate.toFixed(1)}%`}</td>
                  <td className="col-num mono">{projectRow.executionCount}</td>
                  <td className="col-num mono">{projectRow.passRate === null ? "—" : `${projectRow.passRate.toFixed(1)}%`}</td>
                  <td className="col-num mono">{projectRow.failedCount}</td>
                  <td className="col-num mono">{projectRow.attributionFailed === 0 ? "—" : projectRow.attributionRate === null ? "—" : `${projectRow.attributionRate.toFixed(1)}%`}</td>
                  <td><button className="btn" onClick={(event) => { event.stopPropagation(); navigate(`/projects/${projectRow.id}/trends`); }}>{t("dashboard.enterProject")}</button></td>
                </tr>)}</tbody>
              </table>
            : <Empty title={t("dashboard.noProjectsTitle")} hint={t("dashboard.emptyHint")} />}
        </>}
      </div>
    </section>}
  </>;
}

function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [keyword, setKeyword] = useState(searchParams.get("keyword") ?? "");
  const debouncedKeyword = useDebounced(keyword);
  /* 页码进地址栏（与接口列表同款约定）：一页筛好的清单要能贴给别人。`|| 1` / `|| 20`
     兜住 NaN（`?page=abc`）：不兜的话 NaN 会原样发给后端，落进 LIMIT/OFFSET 让整条
     查询炸掉。pageSize 同时按后端同款上限收紧。 */
  const page = Math.max(1, Number(searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("pageSize") ?? 10) || 10));
  const [projects, setProjects] = useState<ProjectMetric[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [projectDialog, setProjectDialog] = useState<"create" | "edit">();
  const [editing, setEditing] = useState<ProjectMetric>();
  const [form] = Form.useForm();

  function patchParams(next: Record<string, string | undefined>) {
    setSearchParams((current) => {
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined || value === "") current.delete(key);
        else current.set(key, value);
      }
      return current;
    }, { replace: true });
  }

  async function load() {
    setLoading(true);
    /* Archiving is not a product concept, so every project is always listed. */
    try {
      const result = await api.projectList({ keyword: debouncedKeyword, page, pageSize });
      /* 删掉本页最后一张卡后自动退一页，而不是停在一张空卡片墙上。 */
      if (!result.items.length && result.total > 0 && page > 1) {
        patchParams({ page: page - 1 === 1 ? undefined : String(page - 1) });
        return;
      }
      setProjects(result.items);
      setTotal(result.total);
    }
    catch { message.error(t("projects.loadFailed")); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    /* keyword 走合并而不是整体替换：整体替换会把 page/pageSize 一并抹掉，翻着页搜字的人
       会被甩回第一页以外的状态丢失。 */
    setSearchParams((current) => {
      if (debouncedKeyword) current.set("keyword", debouncedKeyword); else current.delete("keyword");
      return current;
    }, { replace: true });
    void load();
  }, [debouncedKeyword, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

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
      {/* 换关键字回第一页：旧页码对新结果集多半越界。 */}
      <input className="input" value={keyword} onChange={(event) => { setKeyword(event.target.value); patchParams({ page: undefined }); }} placeholder={t("filter.keyword")} />
      <span className="filter-spacer" />
      <span className="muted mono">{t("projects.totalCount", { count: total })}</span>
    </div>
    {loading && <p className="muted">{t("filter.searching")}</p>}
    {projects.length ? <div className="project-grid">{projects.map((project) => <article className="project-card" key={project.id}>
      <div className="project-card-head"><div><h2>{project.name}</h2></div><p>{project.description || t("projects.noDescription")}</p></div>
      {/* 资产计数七格（2026-09-10 用户确认上卡）：通过率这类执行面读数不上卡
          （归数据看板），卡上数的是「这个项目里有什么」——七格全部来自列表响应
          自带的轻计数（服务端 queryProjectList，executions 一次不碰），翻页与
          渲染都不为它多付一次聚合。 */}
      <dl className="project-facts">
        <div><dt>{t("dashboard.environments")}</dt><dd className="mono">{project.environmentCount}</dd></div>
        <div><dt>{t("dashboard.endpoints")}</dt><dd className="mono">{project.endpointCount}</dd></div>
        <div><dt>{t("dashboard.testCases")}</dt><dd className="mono">{project.caseCount}</dd></div>
        <div><dt>{t("dashboard.assetFlowTotal")}</dt><dd className="mono">{project.flowCount}</dd></div>
        <div><dt>{t("dashboard.assetSuiteTotal")}</dt><dd className="mono">{project.suiteCount}</dd></div>
        <div><dt>{t("dashboard.assetRepoCaseTotal")}</dt><dd className="mono">{project.repoCaseCount}</dd></div>
        <div><dt>{t("dashboard.assetSpecTotal")}</dt><dd className="mono">{project.specCaseCount}</dd></div>
      </dl>
      <div className="project-actions"><button className="btn btn-primary" onClick={() => navigate(`/projects/${project.id}/endpoints`)}>{t("action.enter")}</button><button className="btn" onClick={() => openEdit(project)}>{t("action.edit")}</button><button className="btn danger" onClick={() => remove(project)}>{t("action.delete")}</button></div>
    </article>)}</div> : !loading && <Empty title={keyword ? t("projects.emptySearchTitle") : t("projects.emptyTitle")} hint={keyword ? t("projects.emptySearchHint") : t("projects.emptyHint")} action={!keyword ? <button className="btn btn-primary" onClick={openCreate}>{t("action.createProject")}</button> : undefined} />}
    {projects.length > 0 && <div className="pager">
      <Pagination
        current={page}
        pageSize={pageSize}
        total={total}
        pageSizeOptions={PAGE_SIZES}
        showSizeChanger
        onChange={(nextPage, nextSize) => patchParams({ page: nextPage === 1 ? undefined : String(nextPage), pageSize: nextSize === 10 ? undefined : String(nextSize) })}
      />
    </div>}
    <Modal title={editing ? t("projects.editTitle") : t("action.createProject")} open={Boolean(projectDialog)} onCancel={() => setProjectDialog(undefined)} onOk={() => void save()} okText={t("action.save")} cancelText={t("action.cancel")}>
      <Form form={form} layout="vertical"><Form.Item name="name" label={t("projects.name")} rules={[{ required: true, message: t("projects.nameRequired") }]}><Input /></Form.Item><Form.Item name="description" label={t("projects.description")}><Input.TextArea rows={4} /></Form.Item></Form>
    </Modal>
  </>;
}

type SystemTab = "preferences" | "users" | "workers" | "runners" | "assistantProviders" | "failureCategories" | "auditLogs";

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
   *
   * Runner 池（P4.5-11）是第三个 tab，**紧挨着执行器**：那是最容易被当成重复功能的
   * 一对（8.6）。「执行器」是平台内部的 BullMQ worker，「Runner」是自托管、跑用户仓库
   * 代码的机器；两张表两个概念，所以两个面板并列且各自写明区别，而不是合成一个。
   *
   * 用户与审计（P6-2）排在最前：它是「人」的面板，不是机器的面板，与后三个
   * 基础设施 tab 分属两类读者。非管理员不渲染（边界 6 的 tab 版：藏入口不是禁用）。
   *
   * 归因类型（P8-2）排在 Runner 之后、审计之前：它是「统计口径」的面板——字典数据
   * 而非机器，但读者画像与基础设施 tab 相同（系统管理员），归因统计上线前它先于
   * 审计出现正好构成「数据从哪来 → 谁改了它」的阅读顺序。
   *
   * 助手 provider（P9-3）排在 Runner 与归因类型之间：同是「平台依赖的外部系统」
   * （agent 平台之于 agent-vendor，如 Runner 之于执行机），读者与处置动作（运维配置）
   * 与 workers/runners 一类。
   */
  const tabs: [SystemTab, string][] = isAdmin
    ? [["preferences", t("system.tabPreferences")], ["users", t("users.title")], ["workers", t("workers.title")], ["runners", t("runners.title")], ["assistantProviders", t("assistantProviders.title")], ["failureCategories", t("failureCategories.title")], ["auditLogs", t("audit.title")]]
    : [["preferences", t("system.tabPreferences")]];

  return <>
    {/* topbar 让位给全局导航后，页面标题回到页内（与数据看板/项目管理两页同款）。 */}
    <div className="page-head"><div><h1>{t("system.title")}</h1><p>{t("system.hint")}</p></div></div>

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

    {tab === "users" && isAdmin && <UsersPanel />}
    {tab === "workers" && isAdmin && <WorkerFleetPanel />}
    {tab === "runners" && isAdmin && <RunnerPoolPanel />}
    {tab === "assistantProviders" && isAdmin && <AssistantProvidersPanel />}
    {tab === "failureCategories" && isAdmin && <FailureCategoriesPanel />}
    {tab === "auditLogs" && isAdmin && <AuditLogsPanel />}
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
