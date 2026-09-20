import { useEffect, useState } from "react";
import { Select } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, isStatsTimeoutError, type AttributionSourceFilter, type SampleScope, type StatsFailures, type StatsFlaky, type StatsOverview, type StatsTopNDim, type StatsTrendBucket, type TriggerSource } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { Delta, Empty, PageToolbar, Readout } from "../ui";
import { Donut, LineChart, StackedBars } from "./charts";

/**
 * 数据统计（P8-6，三段式；路由沿用 `trends` 不换——深链不断，导航文案改）。
 *
 * 数据全部来自 `/stats/*` 六条全局接口（P8-4）：本页只是把 `projectIds` 钉在本项目上
 * 复用同一组查询——项目层与全局层（看板）从此一套口径，不再各算各的。三段各自独立
 * 请求、各自到达各自渲染（边界 16：最慢的段不阻塞最快的段，页面骨架立即出现）；
 * 进入拉一次 + 手动刷新按钮，不接 SSE——统计是聚合读，接事件流意味着每个终态重算
 * 聚合，把读页变订阅端。
 *
 * 图表仍全部手写 SVG（`components/charts/` 底座，边界 12/14：不引图表库）。空桶由
 * 服务端 `generate_series` 补齐（total=0），所以折线断开表示「那段时间没有执行」，
 * 而不是被画成 0%——两者是不同的事实。下钻按 12.2 的 URL 表：趋势桶 → 执行记录
 * （时间窗 + failed）、归因片 → 报告列表（attribution 筛选）、榜单行 → 资产/报告
 * 深链。
 */

/** 时间窗档位（边界 17：默认 30d；90d/180d 是显式深挖，不拿最坏情况当默认体验）。 */
const WINDOWS = [1, 7, 30, 90, 180] as const;

/** TopN 维度 tab（边界 21 的六维——P8-7 扩参：+ 流程 + 仓库用例）。 */
const TOPN_DIMS: StatsTopNDim[] = ["endpoint", "case", "ci_task", "suite", "flow", "repo_case"];

/** SuiteReports 的「未归因」伪值同款（服务端 attributionFilterSql 认这个值）。 */
const UNATTRIBUTED = "__unattributed__";

/**
 * 归因分布环形的分类色：Quiet Console 只有一个强调色 + 四个语义色，而归因分类是
 * **分类**不是**语义**——七类各配一个色相会把面板变成调色盘。已归因各片走强调色的
 * 明度阶梯（color-mix 兑 surface），未归因是中性的 line 灰：「还不知道为什么」在
 * 色彩语言里就该是没有颜色。
 */
const CATEGORY_COLORS = [
  "var(--accent)",
  "color-mix(in oklab, var(--accent) 68%, var(--surface))",
  "color-mix(in oklab, var(--accent) 45%, var(--surface))",
  "color-mix(in oklab, var(--accent) 28%, var(--surface))",
  "var(--ink-3)",
  "color-mix(in oklab, var(--ink-3) 55%, var(--surface))",
  "var(--line-strong)",
];
const UNATTRIBUTED_COLOR = "var(--line)";

function formatMs(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  /* 保留一位小数（设计系统：对耗时取整是丢信息）。 */
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/** MTTR 的时长可能是小时级——毫秒格式器在那里只剩一串 0。 */
function formatDurationMs(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  if (value >= 3_600_000) return `${(value / 3_600_000).toFixed(1)}h`;
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
  return formatMs(value);
}

/** 一段的三态：还没回来 / 回来了 / 失败（超时单列——空态文案不同，不白屏）。 */
type SectionState = "loading" | "timeout" | "error";

/** 把 error 归成段状态；成功路径由调用方自己落 state。 */
function sectionErrorOf(error: unknown): SectionState {
  return isStatsTimeoutError(error) ? "timeout" : "error";
}

/* ── 页面 ────────────────────────────────────────────────────────── */

export function Trends() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  const [searchParams, setSearchParams] = useSearchParams();

  const daysParam = Number(searchParams.get("days"));
  const days = ((WINDOWS as readonly number[]).includes(daysParam) ? daysParam : 30) as number;
  const topN = (TOPN_DIMS as string[]).includes(searchParams.get("topN") ?? "") ? searchParams.get("topN") as StatsTopNDim : "endpoint";

  /**
   * 样本口径三态（与旧趋势页同一套决策，只是数据源换到 /stats/*）：默认 `platform`
   * （平台自己跑的 flow / suite）；`repo` 只算仓库侧（上报 + Runner 一体不拆）；
   * `all` 混合。不进地址栏：分享一条链接时不该顺手把别人的口径也改掉。
   */
  const [scope, setScope] = useState<SampleScope>("platform");
  /** 触发源过滤只作用于趋势段（服务端同款边界）：Readout 与归因读的是整窗事实。 */
  const [triggerSource, setTriggerSource] = useState<TriggerSource | "all">("all");
  /**
   * 归因来源筛选（P8-7，边界 8「这个分类是 AI 打的还是人打的」）：只作用于归因分布
   * 段——筛了来源后未归因行不进视图（服务端同款语义）。不进地址栏：与口径同一条
   * 决策，分享链接不把别人的筛选顺手带过去。
   */
  const [attributionSource, setAttributionSource] = useState<AttributionSourceFilter | "all">("all");
  /** 手动刷新（边界 16）：一页四个段共用一个 revision，一次点击全部重取。 */
  const [revision, setRevision] = useState(0);

  /* 三段各自的独立请求与三态（分段渲染：谁先回来谁先画）。 */
  const [overview, setOverview] = useState<StatsOverview>();
  const [overviewState, setOverviewState] = useState<SectionState>();
  const [buckets, setBuckets] = useState<StatsTrendBucket[]>();
  const [trendState, setTrendState] = useState<SectionState>();
  const [failures, setFailures] = useState<StatsFailures>();
  const [failuresState, setFailuresState] = useState<SectionState>();
  const [flaky, setFlaky] = useState<StatsFlaky>();
  const [flakyState, setFlakyState] = useState<SectionState>();

  const ready = Boolean(projectId) && loadedProjectId === projectId && !projectLoading;

  useEffect(() => {
    if (!ready || !projectId) return;
    let alive = true;
    setOverview(undefined); setOverviewState("loading");
    void api.statsOverview({ days, scope, projectIds: [projectId] })
      .then((result) => { if (alive) { setOverview(result); setOverviewState(undefined); } })
      .catch((error) => { if (alive) setOverviewState(sectionErrorOf(error)); });
    return () => { alive = false; };
  }, [ready, projectId, days, scope, revision]);

  useEffect(() => {
    if (!ready || !projectId) return;
    let alive = true;
    setBuckets(undefined); setTrendState("loading");
    void api.statsTrend({ days, scope, projectIds: [projectId], triggerSource: triggerSource === "all" ? undefined : triggerSource })
      .then((result) => { if (alive) { setBuckets(result.metric === "execution_trend" ? result.buckets : []); setTrendState(undefined); } })
      .catch((error) => { if (alive) setTrendState(sectionErrorOf(error)); });
    return () => { alive = false; };
  }, [ready, projectId, days, scope, triggerSource, revision]);

  useEffect(() => {
    if (!ready || !projectId) return;
    let alive = true;
    setFailures(undefined); setFailuresState("loading");
    void api.statsFailures({ days, projectIds: [projectId], topN, attributionSource: attributionSource === "all" ? undefined : attributionSource })
      .then((result) => { if (alive) { setFailures(result); setFailuresState(undefined); } })
      .catch((error) => { if (alive) setFailuresState(sectionErrorOf(error)); });
    return () => { alive = false; };
  }, [ready, projectId, days, topN, attributionSource, revision]);

  useEffect(() => {
    if (!ready || !projectId) return;
    let alive = true;
    setFlaky(undefined); setFlakyState("loading");
    void api.statsFlaky({ days, projectIds: [projectId] })
      .then((result) => { if (alive) { setFlaky(result); setFlakyState(undefined); } })
      .catch((error) => { if (alive) setFlakyState(sectionErrorOf(error)); });
    return () => { alive = false; };
  }, [ready, projectId, days, revision]);

  /* ── 下钻（12.2 的 URL 表） ── */

  /**
   * 趋势桶 → 执行记录的**父执行记录**大类：那个桶的运行清单（时间窗 = 桶起点到
   * 下一桶起点），**不预置 status**——下钻带的是上下文（窗口），结论（只看失败）
   * 留给列表里的人自己下（P8-6 验收反馈：下钻应展示全部记录）。落父记录而不是
   * 单接口记录，是因为这三张图的样本本来就是执行级（一次流程/套件/仓库 run 一个
   * 样本，P8-1 收口的口径）——桶里点出来的是「那段时间跑了哪些次」，单接口叶子
   * 记录与图的样本不是一个层的东西。kind 不预设：图的口径（platform/repo）在
   * 父记录的 kind 筛选里是 flow+suite / ingest+runner 的多选组合，单个 kind 值
   * 表达不了，窗口是两类口径共享的事实，进列表后自行再收窄。
   */
  function drillBucket(index: number) {
    if (!projectId || !buckets?.length) return;
    const from = buckets[index];
    if (!from || from.total === 0) return;
    const stepMs = (days <= 2 ? 1 : 24) * 3_600_000;
    const to = new Date(new Date(from.bucket).getTime() + stepMs).toISOString();
    navigate(`/projects/${projectId}/reports?type=parent&from=${encodeURIComponent(from.bucket)}&to=${encodeURIComponent(to)}`);
  }

  /** 当前统计窗口的 from/to 查询串：榜单是整窗读数，下钻也带整窗（执行记录里以
   *  可清除的时间窗 chip 呈现，不静默缩窄）。 */
  function timeWindowQuery(): string {
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    const to = new Date().toISOString();
    return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }

  /** 归因片 → 报告列表 + attribution 筛选（未归因片用伪值）。 */
  function drillAttribution(code: string) {
    if (!projectId) return;
    navigate(`/projects/${projectId}/suite-reports?attribution=${encodeURIComponent(code)}`);
  }

  /**
   * 读数下钻（2026-09-10，与看板同款接线）：执行量/通过率分边 → 父执行记录 + 当前
   * 统计窗；失败量整卡 `status=failed`（数字语义即失败，归因片判例）；归因覆盖率
   * 分边 → 报告列表已归因/未归因筛选。不预置 kind（口径在 kind 筛选里是组合值）。
   */
  function reportUrl(status?: string): string {
    if (!projectId) return "";
    const { from, to } = { from: new Date(Date.now() - days * 86_400_000).toISOString(), to: new Date().toISOString() };
    return `/projects/${projectId}/reports?type=parent${status ? `&status=${status}` : ""}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }

  /**
   * 榜单行下钻，筛选项自动填充（各维自己的条件 + 当前时间窗），**不预置
   * status**——榜说的是「谁失败最多」，落进去看的是它这段时间的全部记录（P8-6
   * 验收反馈）。套件 / CI 任务 / 流程落「父执行记录」大类：kind + 名称搜索（runner
   * 行的 target_name 是「任务名 #序号」，ILIKE 子串命中该任务的全部 run）；接口 /
   * 用例落「单接口记录」大类（endpointId / caseId 精确筛选）；仓库用例（P8-7）跳
   * **用例树的关键字检索**（验收五轮④：refId 指向「最近一次失败的 run」等于替用户
   * 挑了一次执行，很奇怪；用例树才是这条用例的资产页——树上能看到它的最近任务，
   * 抽屉里有全部历史 run）。key 在执行记录的任何筛选里都表达不了，keyword 是用例
   * 树检索的名字/case_key/文件路径三入口之一。
   */
  function drillTopRow(row: { name: string; caseId?: string; refId?: string }) {
    if (!projectId) return;
    const window = timeWindowQuery();
    if (topN === "case" && row.caseId) {
      navigate(`/projects/${projectId}/reports?caseId=${encodeURIComponent(row.caseId)}&${window}`);
      return;
    }
    if (topN === "endpoint" && row.refId) {
      navigate(`/projects/${projectId}/reports?endpointId=${encodeURIComponent(row.refId)}&${window}`);
      return;
    }
    if (topN === "ci_task") {
      navigate(`/projects/${projectId}/reports?type=parent&kind=runner&keyword=${encodeURIComponent(row.name)}&${window}`);
      return;
    }
    if (topN === "suite") {
      navigate(`/projects/${projectId}/reports?type=parent&kind=suite&keyword=${encodeURIComponent(row.name)}&${window}`);
      return;
    }
    if (topN === "flow") {
      navigate(`/projects/${projectId}/reports?type=parent&kind=flow&keyword=${encodeURIComponent(row.name)}&${window}`);
      return;
    }
    if (topN === "repo_case") {
      navigate(`/projects/${projectId}/repo/tree?keyword=${encodeURIComponent(row.name)}`);
      return;
    }
  }

  /* ── 派生读数 ── */

  const hourly = days <= 2;
  const settled = (buckets ?? []).filter((bucket) => bucket.total > 0);
  const withQuantiles = days <= 30;
  /* 归因环形：已归因各分类（按量降序，服务端已排）+ 未归因片（永远在最后）。来源
     筛选下不加未归因片——它不在该来源的分布里（分布只数该来源的归因行），加进去
     会让「覆盖率」与环形读成两个世界。 */
  const donutSegments = [
    ...(failures?.attribution.distribution ?? []).map((entry, index) => ({
      code: entry.code,
      label: entry.name,
      value: entry.count,
      color: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
    })),
    ...(failures && attributionSource === "all" && failures.attribution.unattributed > 0
      ? [{ code: UNATTRIBUTED, label: t("attribution.unattributed"), value: failures.attribution.unattributed, color: UNATTRIBUTED_COLOR }]
      : []),
  ];
  const triggerLabel: Record<TriggerSource, string> = {
    manual: t("suiteReports.triggerManual"),
    scheduled: t("suiteReports.triggerScheduled"),
    webhook: t("suiteReports.triggerWebhook"),
    ci: t("suiteReports.triggerCi"),
  };

  return <main className="content content-split">
    <PageToolbar>
    <div className="page-head">
      <div><h1>{t("trends.title")}</h1><p>{t("trends.hint")}</p></div>
      <div className="tabs" role="tablist" style={{ paddingInline: 0, marginBottom: 0 }}>
        {WINDOWS.map((each) => <button
          key={each}
          role="tab"
          aria-selected={days === each}
          className={`tab${days === each ? " is-active" : ""}`}
          /* 合并式更新：切窗口不抹掉 topN（切 tab 丢掉另一个 tab 的选择，两处都会
             被当成「点了没反应」。默认档 30d 不写进地址栏——与既有 range 约定同款。 */
          onClick={() => setSearchParams((current) => {
            const next = new URLSearchParams(current);
            if (each === 30) next.delete("days"); else next.set("days", String(each));
            return next;
          }, { replace: true })}
        >{t(`trends.days${each}`)}</button>)}
      </div>
    </div>

    <div className="filter-bar">
      {/* 口径选择（三态，segmented 而不是第二排下划线 tab——同页两排下划线 tab
          4.5 否决过）。说明文字按口径切换且必须留着：两种耗时混在一条曲线上时，
          「为什么 p90 突然掉了一半」只有这一句能解释。 */}
      <div className="segmented" role="tablist">
        {(["platform", "repo", "all"] as const).map((each) => (
          <button
            key={each}
            role="tab"
            aria-selected={scope === each}
            className={`segmented-item${scope === each ? " is-active" : ""}`}
            onClick={() => setScope(each)}
          >{t(`trends.scope.${each}`)}</button>
        ))}
      </div>
      <Select
        value={triggerSource}
        onChange={setTriggerSource}
        style={{ width: 150 }}
        options={[
          { value: "all", label: t("trends.triggerAll") },
          { value: "manual", label: triggerLabel.manual },
          { value: "scheduled", label: triggerLabel.scheduled },
          { value: "webhook", label: triggerLabel.webhook },
          { value: "ci", label: triggerLabel.ci },
        ]}
      />
      <span className="filter-spacer" />
      <button className="btn" onClick={() => setRevision((current) => current + 1)}>{t("trends.refresh")}</button>
    </div>
    </PageToolbar>

    <div className="list-card">
    <div className="list-scroll">
    <p className="form-note">{t(`trends.scopeHint.${scope}`)}{triggerSource !== "all" ? ` ${t("trends.triggerNote")}` : ""}</p>

    {/* ── 段一：Readout 行（执行面四读数 + delta，overview 独立请求） ── */}
    {overviewState === "timeout" && <SectionTimeout onRefresh={() => setRevision((current) => current + 1)} />}
    {overviewState === "error" && <p className="form-error">{t("trends.loadFailed")}</p>}
    {overviewState === "loading" && <p className="muted">{t("common.loading")}</p>}
    {overview && <>
      <div className="readouts">
        <Readout
          label={t("trends.readoutExecutions")}
          value={overview.executions.total}
          onClick={() => navigate(reportUrl())}
          extra={<Delta value={overview.delta.executions} tip={t("trends.deltaTip")} />}
        />
        {/* 执行级口径在标签上看不出来（2026-09-10 验收反馈「统计的是什么通过了」）：
            悬停说明按当前口径解释样本单位与分母。分边下钻（通过 x / 失败 x）与
            看板同款——两边各带 status，时间窗是当前统计窗。 */}
        <Readout
          label={t("suiteReports.passRate")}
          value={overview.executions.passRate === null ? "—" : overview.executions.passRate.toFixed(1)}
          unit={overview.executions.passRate === null ? undefined : "%"}
          tip={t(`trends.passRateTip.${scope}`)}
          drill={{
            sides: [
              { label: t("dashboard.drillPassed", { count: overview.executions.successCount }), onClick: () => navigate(reportUrl("success")) },
              { label: t("dashboard.drillFailed", { count: overview.executions.failedCount }), onClick: () => navigate(reportUrl("failed")) },
            ],
          }}
          extra={<Delta value={overview.delta.passRate} kind="pp" goodWhenUp tip={t("trends.deltaTip")} />}
        />
        <Readout
          label={t("trends.readoutFailed")}
          value={overview.executions.failedCount}
          onClick={() => navigate(reportUrl("failed"))}
          extra={<Delta value={overview.delta.failed} goodWhenUp={false} tip={t("trends.deltaTip")} />}
        />
        <Readout
          label={t("trends.readoutAttribution")}
          value={overview.attribution.coverageRate === null ? "—" : overview.attribution.coverageRate.toFixed(1)}
          unit={overview.attribution.coverageRate === null ? undefined : "%"}
          tip={t("trends.attributionTip")}
          drill={{
            sides: [
              { label: t("dashboard.drillAttributed", { count: overview.attribution.attributed }), onClick: () => drillAttribution("__attributed__") },
              { label: t("dashboard.drillUnattributed", { count: overview.attribution.unattributed }), onClick: () => drillAttribution(UNATTRIBUTED) },
            ],
            note: t("trends.attributionTip"),
          }}
          extra={<Delta value={overview.delta.attributionCoverageRate} kind="pp" goodWhenUp tip={t("trends.deltaTip")} />}
        />
      </div>
      {/* 触发源分布（12.3「自动化真的在自动跑吗」）：overview 顺带带出，一行事实格
          而不是第五个 readout——它是执行量的切面，不是另一个量。 */}
      <p className="form-note mono">
        {t("trends.triggerLine")}{overview.triggerSources.map((each) => ` ${triggerLabel[each.source]} ${each.count}`).join(" ·")}
      </p>
    </>}

    {/* ── 段二：趋势区（折线 + 堆叠柱，trend 独立请求） ── */}
    {trendState === "timeout" && <SectionTimeout onRefresh={() => setRevision((current) => current + 1)} />}
    {trendState === "error" && <p className="form-error">{t("trends.loadFailed")}</p>}
    {trendState === "loading" && <p className="muted">{t("common.loading")}</p>}
    {buckets && <>
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
                hourly={hourly}
                yTicks={[0, 50, 100]}
                onBucketClick={drillBucket}
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
            hourly={hourly}
            hourlyLabels={(count) => count <= 10}
            onBucketClick={drillBucket}
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
          {/* 分位数只在 ≤30d 窗口提供（边界 23：排序成本随窗口线性涨，砍它是零 UX
              损失的省法）——深挖窗口里这一格解释为什么是空的，而不是静默消失。 */}
          {!withQuantiles && <p className="form-note">{t("trends.quantileWindowHint")}</p>}
          {withQuantiles && (settled.some((bucket) => bucket.p50 !== null)
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
                hourly={hourly}
                yTicks={[0, Math.round(Math.max(1, ...buckets.map((bucket) => bucket.p99 ?? 0)) / 2), Math.round(Math.max(1, ...buckets.map((bucket) => bucket.p99 ?? 0)))]}
                /* 空桶两侧由底座补虚线（2026-09-20 走查：没数据的段要能看出趋势，
                   用线型表达「推断」而不是断成碎段）；「这个桶没样本」仍由读数条
                   的「—」表达。 */
                onBucketClick={drillBucket}
                ariaLabel={t("trends.durationTitle")}
              />
            : <p className="form-note">{t("trends.noData")}</p>)}
        </div>
      </section>
    </>}

    {/* ── 段三：归因与榜单区（failures + flaky 两个独立请求） ── */}
    <section className="panel">
      <div className="panel-head">
        <strong>{t("trends.attributionTitle")}</strong>
        {/* 来源筛选（P8-7，边界 8）：「这个分类是 AI 打的还是人打的」。筛了来源后
            覆盖率行与环都只统计该来源（未归因行不进视图——提示文案写明）。 */}
        <Select
          value={attributionSource}
          onChange={(next) => setAttributionSource(next)}
          style={{ width: 150 }}
          options={[
            { value: "all", label: t("trends.attributionSourceAll") },
            { value: "human", label: t("trends.attributionSourceHuman") },
            { value: "mcp", label: t("trends.attributionSourceMcp") },
          ]}
        />
      </div>
      <div className="panel-body">
        {failuresState === "timeout" && <SectionTimeout onRefresh={() => setRevision((current) => current + 1)} />}
        {failuresState === "error" && <p className="form-error">{t("trends.loadFailed")}</p>}
        {failuresState === "loading" && <p className="muted">{t("common.loading")}</p>}
        {failures && <>
          {donutSegments.length
            ? <Donut
                centerLabel={t("trends.summaryFailed")}
                segments={donutSegments}
                onSliceClick={(index) => drillAttribution(donutSegments[index].code)}
              />
            : <p className="form-note">{t(attributionSource === "all" ? "trends.noFailures" : "trends.noFailuresInSource")}</p>}
          {/* 展示纪律（边界 7）：任何归因占比图必须同屏显示覆盖率——「40% 是环境
              问题」在只归因了 10% 失败时没有意义。覆盖率读数是整窗事实（服务端在
              来源筛选下保持同一分母）；筛了来源时再加一行说明分布段只数该来源。 */}
          {failures.attribution.failedTargets > 0 && <p className="form-note">
            {t("trends.attributionLine", {
              attributed: failures.attribution.attributed,
              failed: failures.attribution.failedTargets,
              unattributed: failures.attribution.unattributed,
              rate: failures.attribution.coverageRate === null ? "—" : `${failures.attribution.coverageRate.toFixed(1)}%`,
            })}
            {attributionSource !== "all" && ` ${t("trends.attributionSourceNote", {
              source: t(attributionSource === "human" ? "trends.attributionSourceHuman" : "trends.attributionSourceMcp"),
            })}`}
          </p>}
        </>}
      </div>
    </section>

    <section className="panel">
      <div className="panel-head">
        <strong>{t("trends.topNTitle")}</strong>
        <div className="tabs" role="tablist" style={{ paddingInline: 0, marginBottom: 0 }}>
          {TOPN_DIMS.map((dim) => <button
            key={dim}
            role="tab"
            aria-selected={topN === dim}
            className={`tab${topN === dim ? " is-active" : ""}`}
            /* tab 文案带「按」字（P8-6 验收反馈：裸维度名会被误读成页面级筛选，
                以为上面的图也跟着切）——它只切换这张榜的分组维度。 */
            onClick={() => setSearchParams((current) => {
              const next = new URLSearchParams(current);
              if (dim === "endpoint") next.delete("topN"); else next.set("topN", dim);
              return next;
            }, { replace: true })}
          >{t(`trends.topNBy.${dim}`)}</button>)}
        </div>
      </div>
      <div className="panel-body">
        {/* 维度与口径的边界写在榜旁边（同上验收反馈）：图与读数归顶部筛选管，这张榜
            只归维度 tab 管；叶子计数不受口径影响是 P8-4 的既定决策。 */}
        <p className="form-note">{t("trends.topNHint")}</p>
        {failures && (failures.top.length
          ? <table className="grid">
              <thead><tr><th>{t(`trends.topN.${topN}`)}</th><th className="col-num">{t("trends.summaryFailed")}</th></tr></thead>
              <tbody>
                {failures.top.map((row) => {
                  /* 套件/CI 任务/流程走名称搜索，恒可下钻；接口/用例要精确 id；
                      仓库用例走规范 case_key 的树检索（验收五轮④），name 恒在，
                      恒可下钻。 */
                  const drillable = topN === "case" ? Boolean(row.caseId)
                    : topN === "endpoint" ? Boolean(row.refId)
                    : true;
                  return <tr
                    key={`${row.projectId}:${row.name}`}
                    data-clickable={drillable ? "" : undefined}
                    onClick={() => drillTopRow(row)}
                  >
                    <td className="mono truncate">{row.name}</td>
                    <td className="col-num mono">{row.failed}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          : <Empty title={t("trends.noData")} hint={t("trends.hint")} />)}
      </div>
    </section>

    <section className="panel">
      <div className="panel-head"><strong>{t("trends.flakyTitle")}</strong></div>
      <div className="panel-body">
        {flakyState === "timeout" && <SectionTimeout onRefresh={() => setRevision((current) => current + 1)} />}
        {flakyState === "error" && <p className="form-error">{t("trends.loadFailed")}</p>}
        {flakyState === "loading" && <p className="muted">{t("common.loading")}</p>}
        {flaky && <>
          <p className="form-note">
            {t("trends.flakyHint", {
              runs: flaky.thresholds.MIN_RUNS,
              flips: flaky.thresholds.MIN_FLIPS,
              passed: flaky.thresholds.MIN_PASSED,
              failed: flaky.thresholds.MIN_FAILED,
            })}
          </p>
          {/* MTTR 与首跑通过率（12.3）：与 Flaky 同一批查询顺带带出，读数一行说清，
              不另起 readout 行——它们是 Flaky 榜的注脚，不是独立的段。 */}
          <p className="form-note mono">
            {t("trends.mttrLine", {
              median: formatDurationMs(flaky.mttr.medianMs),
              p90: formatDurationMs(flaky.mttr.p90Ms),
              rate: flaky.firstPass.rate === null ? "—" : `${flaky.firstPass.rate.toFixed(1)}%`,
            })}
          </p>
          {flaky.flaky.length
            ? <table className="grid">
                <thead><tr>
                  <th>{t("trends.flakyCase")}</th>
                  <th>{t("trends.flakySource")}</th>
                  <th className="col-num">{t("trends.flakyRuns")}</th>
                  <th className="col-num">{t("status.pass")}</th>
                  <th className="col-num">{t("trends.summaryFailed")}</th>
                  <th className="col-num">{t("trends.flakyFlips")}</th>
                </tr></thead>
                <tbody>
                  {flaky.flaky.map((row) => {
                    /* api 腿 → 执行记录 caseId 精确筛选；两条仓库腿（上报/任务）→ 用例树
                        keyword 检索（与 TopN repo_case 同一落点，验收五轮④）——树是这条用例
                        的资产页，历史在抽屉里。 */
                    const drillable = row.source === "api" ? Boolean(row.caseId) : Boolean(row.caseKey);
                    return <tr
                      key={`${row.source}:${row.caseId ?? row.caseKey}`}
                      data-clickable={drillable ? "" : undefined}
                      onClick={() => {
                        if (!projectId || !drillable) return;
                        if (row.source === "api") navigate(`/projects/${projectId}/reports?caseId=${encodeURIComponent(row.caseId!)}&${timeWindowQuery()}`);
                        else navigate(`/projects/${projectId}/repo/tree?keyword=${encodeURIComponent(row.caseKey!)}`);
                      }}
                    >
                      <td className="mono truncate">{row.name}</td>
                      <td className="muted">{t(`trends.flakySource.${row.source}`)}</td>
                      <td className="col-num mono">{row.runs}</td>
                      <td className="col-num mono">{row.passed}</td>
                      <td className="col-num mono">{row.failed}</td>
                      <td className="col-num mono">{row.flips}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            : <Empty title={t("trends.flakyEmptyTitle")} hint={t("trends.flakyEmptyHint")} />}
        </>}
      </div>
    </section>
    </div>
    </div>
  </main>;
}

/* ── 局部组件 ────────────────────────────────────────────────────── */

/**
 * 503 + 2005（statement_timeout 5s 触顶）的空态（边界 23）：不白屏、给缩窗建议、
 * 留一条就地重试的路。每段各自渲染——一段超时不连坐其他段。
 */
function SectionTimeout({ onRefresh }: { onRefresh: () => void }) {
  const { t } = useTranslation();
  return <Empty
    title={t("trends.timeoutTitle")}
    hint={t("trends.timeoutHint")}
    action={<button className="btn" onClick={onRefresh}>{t("trends.refresh")}</button>}
  />;
}
