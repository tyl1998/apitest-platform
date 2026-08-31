import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { api, type ReportRange, type ReportSummary, type TrendReport } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { Empty, Readout } from "../ui";

/**
 * 趋势分析（P3-9，边界 11/12）。
 *
 * 图表全部手写 SVG：折线（通过率、耗时分位数）+ 柱（执行量）+ 环形（失败类型），
 * 各几十行。不引入图表库——图表库带的是自己一整套配色与动效，接进来是逐项对抗它的
 * 默认值，而 Quiet Console 只允许一个强调色和四个语义色（边界 12）。
 *
 * 空桶由服务端 `generate_series` 补齐（total=0），所以折线在这里断开表示
 * 「那段时间没有执行」，而不是被画成 0%——两者是不同的事实。
 */

const RANGES: ReportRange[] = ["24h", "7d", "30d"];

/** 桶时间标签：24h 按小时，天桶按日期。轴上只标首/中/尾，多了在窄屏挤成一串。 */
function bucketLabel(iso: string, hourly: boolean) {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hourly
    ? `${pad(date.getHours())}:00`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ── SVG 折线 ───────────────────────────────────────────────────────
 * viewBox 固定、宽度 100% 拉伸：SVG 文本在非整数缩放下会发虚，所以轴标签用 HTML
 * 绝对定位，SVG 里只画线与点。 */

const CHART_W = 720;
const CHART_H = 170;
const PAD_L = 6;
const PAD_R = 6;
const PAD_T = 10;
const PAD_B = 18;

type Series = { values: (number | null)[]; color: string; dash?: string; width?: number };

function LineChart({ buckets, series, yMax, yFormat, hourly, yTicks }: {
  buckets: string[];
  series: Series[];
  yMax: number;
  yFormat: (value: number) => string;
  hourly: boolean;
  yTicks: number[];
}) {
  const { t } = useTranslation();
  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;
  const n = buckets.length;
  const x = (i: number) => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD_T + innerH - (Math.min(v, yMax) / yMax) * innerH;

  const path = (values: (number | null)[]) => {
    /* null 断线：连续段各自 path，跨过「没有执行」的桶而不是画到 0。 */
    const segments: string[][] = [];
    let current: string[] = [];
    values.forEach((value, i) => {
      if (value === null) {
        if (current.length) segments.push(current);
        current = [];
        return;
      }
      current.push(`${current.length ? "L" : "M"}${x(i).toFixed(1)},${y(value).toFixed(1)}`);
    });
    if (current.length) segments.push(current);
    return segments.map((segment) => segment.join(" ")).join(" ");
  };

  const labelAt = [0, Math.floor((n - 1) / 2), n - 1].filter((index, i, all) => all.indexOf(index) === i);

  return <div className="chart" style={{ position: "relative" }}>
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width="100%" height={CHART_H} role="img" aria-label={t("trends.passRateTitle")}>
      {yTicks.map((tick) => <line
        key={tick}
        x1={PAD_L} x2={CHART_W - PAD_R} y1={y(tick)} y2={y(tick)}
        style={{ stroke: "var(--rule)" }}
        strokeWidth={1}
      />)}
      {series.map((each, index) => <path
        key={index}
        d={path(each.values)}
        fill="none"
        style={{ stroke: each.color }}
        strokeWidth={each.width ?? 1.5}
        strokeDasharray={each.dash}
        strokeLinejoin="round"
        strokeLinecap="round"
      />)}
    </svg>
    {/* 轴标签浮在 SVG 上：左端是 y 轴刻度，底下一排是桶时间。 */}
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {yTicks.map((tick) => <span key={tick} className="mono chart-y" style={{ top: y(tick) - 7 }}>{yFormat(tick)}</span>)}
      {labelAt.map((index) => <span key={index} className="mono chart-x" style={{ left: `${(x(index) / CHART_W) * 100}%` }}>
        {bucketLabel(buckets[index], hourly)}
      </span>)}
    </div>
  </div>;
}

/* ── SVG 柱（执行量：通过/失败堆叠） ─────────────────────────────── */

function VolumeBars({ buckets }: { buckets: TrendReport["buckets"] }) {
  const { t } = useTranslation();
  const BAR_H = 110;
  const PAD_B = 18;
  const innerH = BAR_H - PAD_B;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.total));
  const gap = 3;
  const barW = Math.max(2, (CHART_W - 12 - gap * (buckets.length - 1)) / buckets.length);
  const labelAt = [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].filter((index, i, all) => all.indexOf(index) === i);

  return <div className="chart" style={{ position: "relative" }}>
    <svg viewBox={`0 0 ${CHART_W} ${BAR_H}`} width="100%" height={BAR_H} role="img" aria-label={t("trends.volumeTitle")}>
      {buckets.map((bucket, index) => {
        const x = 6 + index * (barW + gap);
        const totalH = (bucket.total / max) * innerH;
        const failedH = (bucket.failedCount / max) * innerH;
        const passH = totalH - failedH;
        return <g key={bucket.bucket}>
          {passH > 0 && <rect x={x} y={innerH - totalH} width={barW} height={Math.max(passH, bucket.total > 0 ? 1 : 0)} style={{ fill: "var(--pass)" }} rx={1} />}
          {failedH > 0 && <rect x={x} y={innerH - failedH} width={barW} height={Math.max(failedH, 1)} style={{ fill: "var(--fail)" }} rx={1} />}
          {/* total=0 的桶画一粒 1px 的灰点：空桶是「没有执行」，与「跑了一两个」在柱高上几乎不可分。 */}
          {bucket.total === 0 && <rect x={x} y={innerH - 1} width={barW} height={1} style={{ fill: "var(--rule)" }} />}
        </g>;
      })}
    </svg>
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {labelAt.map((index) => <span key={index} className="mono chart-x" style={{ left: `${((6 + index * (barW + gap) + barW / 2) / CHART_W) * 100}%` }}>
        {bucketLabel(buckets[index].bucket, buckets.length > 10)}
      </span>)}
    </div>
  </div>;
}

/* ── SVG 环形（失败类型分布） ────────────────────────────────────── */

function FailureDonut({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const { t } = useTranslation();
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const R = 15.915; /* 周长恰为 100 的半径，dasharray 直接用百分比 */
  if (!total) return <p className="form-note">{t("trends.noData")}</p>;
  let offset = 25; /* 从 12 点方向起 */
  return <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
    <svg viewBox="0 0 42 42" width={132} height={132} role="img" aria-label={t("trends.failByType")}>
      <circle cx="21" cy="21" r={R} fill="none" style={{ stroke: "var(--rule)" }} strokeWidth="5" />
      {segments.map((segment) => {
        const share = (segment.value / total) * 100;
        const dash = `${share} ${100 - share}`;
        const element = <circle
          key={segment.label}
          cx="21" cy="21" r={R} fill="none"
          style={{ stroke: segment.color }}
          strokeWidth="5"
          strokeDasharray={dash}
          strokeDashoffset={offset}
        />;
        offset -= share;
        return element;
      })}
      <text x="21" y="20" textAnchor="middle" className="mono" style={{ fill: "var(--ink)", fontSize: 6, fontWeight: 600 }}>{total}</text>
      <text x="21" y="26" textAnchor="middle" style={{ fill: "var(--ink-3)", fontSize: 2.8 }}>{t("trends.summaryFailed")}</text>
    </svg>
    <ul className="chart-legend">
      {segments.map((segment) => <li key={segment.label}>
        <span className="chart-key" style={{ background: segment.color }} />
        <span className="truncate">{segment.label}</span>
        <span className="mono muted">{segment.value}</span>
      </li>)}
    </ul>
  </div>;
}

function formatMs(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  /* 保留一位小数（设计系统：对耗时取整是丢信息）。 */
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/* ── 页面 ────────────────────────────────────────────────────────── */

export function Trends() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const range = (RANGES as string[]).includes(searchParams.get("range") ?? "") ? searchParams.get("range") as ReportRange : "24h";

  const [trend, setTrend] = useState<TrendReport>();
  const [summary, setSummary] = useState<ReportSummary>();
  const [failed, setFailed] = useState(false);
  /**
   * 「含仓库上报」开关（P4 边界 1），**默认关闭**。
   *
   * 关着的时候这两张图算的还是平台自己跑的那些（flow / suite）。打开之后混进外部 CI 的
   * 上报：它的耗时是用户进程里的客户端耗时，与平台的墙钟耗时不是一个口径；一次 `-m smoke`
   * 的局部跑也会把通过率拉出一个台阶。所以它是一个「我知道自己在看混合视图」的显式选择，
   * 不进地址栏——分享一条链接时不该顺手把别人的口径也改掉。
   */
  const [includeIngest, setIncludeIngest] = useState(false);

  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    let alive = true;
    setTrend(undefined); setSummary(undefined); setFailed(false);
    /* 趋势与汇总同一份数据口径（父执行 + 可选的仓库上报），一起取；任一失败都算这页
       没加载出来。 */
    void Promise.all([api.trendReport(projectId, range, includeIngest), api.reportSummary(projectId, range, includeIngest)])
      .then(([trendResult, summaryResult]) => { if (alive) { setTrend(trendResult); setSummary(summaryResult); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [projectId, loadedProjectId, projectLoading, range, includeIngest]);

  const hourly = range === "24h";
  const buckets = trend?.buckets ?? [];
  const settled = buckets.filter((bucket) => bucket.total > 0);

  return <main className="content">
    <div className="page-head">
      <div><h1>{t("trends.title")}</h1><p>{t("trends.hint")}</p></div>
      <div className="tabs" role="tablist" style={{ paddingInline: 0, marginBottom: 0 }}>
        {RANGES.map((each) => <button
          key={each}
          role="tab"
          aria-selected={range === each}
          className={`tab${range === each ? " is-active" : ""}`}
          onClick={() => setSearchParams(each === "24h" ? {} : { range: each }, { replace: true })}
        >{t(`trends.range${each}`)}</button>)}
      </div>
    </div>

    {/* 口径开关（P4 边界 1）：默认关。说明文字必须留着——两个口径混在一条曲线上时，
        「为什么 p90 突然掉了一半」只有这一句能解释。 */}
    <label className="check-field">
      <input type="checkbox" checked={includeIngest} onChange={(event) => setIncludeIngest(event.target.checked)} />
      {t("trends.includeIngest")}
    </label>
    <p className="form-note">{t("trends.includeIngestHint")}</p>

    {failed && <p className="form-error">{t("trends.loadFailed")}</p>}

    {summary && <div className="readouts">
      <Readout label={t("trends.summaryTotal")} value={summary.total} />
      <Readout label={t("suiteReports.passRate")} value={summary.passRate === null ? "—" : summary.passRate.toFixed(1)} unit="%" />
      <Readout label={t("trends.summaryFailed")} value={summary.failedCount} />
      <Readout label={t("trends.summaryAvgDuration")} value={formatMs(summary.avgDurationMs)} />
    </div>}

    {!failed && !trend && <p className="muted">{t("common.loading")}</p>}

    {trend && <>
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
                yMax={100}
                yFormat={(value) => `${value}%`}
                hourly={hourly}
                yTicks={[0, 50, 100]}
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
          <VolumeBars buckets={buckets} />
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
          {settled.some((bucket) => bucket.p50 !== null)
            ? <LineChart
                buckets={buckets.map((bucket) => bucket.bucket)}
                series={[
                  { values: buckets.map((bucket) => bucket.p50), color: "var(--ink)", width: 1.8 },
                  { values: buckets.map((bucket) => bucket.p90), color: "var(--ink-2)" },
                  { values: buckets.map((bucket) => bucket.p99), color: "var(--ink-3)", dash: "4 3" },
                ]}
                yMax={Math.max(1, ...buckets.map((bucket) => bucket.p99 ?? 0))}
                yFormat={(value) => (value >= 1000 ? `${(value / 1000).toFixed(0)}s` : `${Math.round(value)}ms`)}
                hourly={hourly}
                yTicks={[0, Math.round(Math.max(1, ...buckets.map((bucket) => bucket.p99 ?? 0)) / 2), Math.round(Math.max(1, ...buckets.map((bucket) => bucket.p99 ?? 0)))]}
              />
            : <p className="form-note">{t("trends.noData")}</p>}
        </div>
      </section>
    </>}

    {summary && <section className="panel">
      <div className="panel-head"><strong>{t("trends.failByEndpoint")}</strong></div>
      <div className="panel-body">
        {summary.failures.byEndpoint.length
          ? <table className="grid">
              <thead><tr><th>{t("endpoints.name")}</th><th className="col-num">{t("trends.summaryFailed")}</th></tr></thead>
              <tbody>
                {summary.failures.byEndpoint.map((entry) => <tr key={entry.endpoint}>
                  <td className="mono truncate">{entry.endpoint}</td>
                  <td className="col-num mono">{entry.failed}</td>
                </tr>)}
              </tbody>
            </table>
          : <Empty title={t("trends.noData")} hint={t("trends.hint")} />}
      </div>
    </section>}

    {summary && <section className="panel">
      <div className="panel-head"><strong>{t("trends.failByType")}</strong></div>
      <div className="panel-body">
        <FailureDonut segments={[
          { label: t("trends.failTypeAssertion"), value: summary.failures.byType.assertion, color: "var(--fail)" },
          { label: t("trends.failTypeScript"), value: summary.failures.byType.script, color: "var(--skip)" },
          { label: t("trends.failTypeTimeout"), value: summary.failures.byType.timeout, color: "var(--busy)" },
          { label: t("trends.failTypeRequest"), value: summary.failures.byType.request, color: "var(--ink-3)" },
        ]} />
      </div>
    </section>}
  </main>;
}
