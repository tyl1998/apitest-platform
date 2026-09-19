import type { ReactNode } from "react";
import { Popover, Tooltip } from "antd";

/**
 * `not_run` 是勾选执行（P4.5-9）才会出现的第四态：这一条被勾选了、这一轮却没有报到
 * 结果。它**不能**折进 `skip`——「脚本主动跳过」与「平台勾了它但它没跑」是两回事，
 * 前者说明测试自己做了决定，后者说明这次勾选没生效（脚本不认识 `--apitrack-case-keys`
 * 或崩在中途）。
 */
export type RunStatus = "pass" | "fail" | "skip" | "running" | "queued" | "canceled" | "not_run";

/**
 * 原生 `title` 悬停的替代（2026-08-30）。原生 title 的延迟由浏览器决定（~1 秒）且
 * 不可调，用户已经嫌慢；antd Tooltip 走 `mouseEnterDelay`，100ms 出来，触屏与键盘
 * 可达性也归它。文本为空时直接透传 children——「没有内容就不要包一层」。
 * text 允许 ReactNode（计划详情结果表头的五态计数堆叠，2026-09-09）。
 */
export function Tip({ text, children }: { text?: ReactNode; children: ReactNode }) {
  if (!text) return <>{children}</>;
  return <Tooltip title={text} mouseEnterDelay={0.1}>{children}</Tooltip>;
}

const STATUS_LABEL: Record<RunStatus, string> = {
  pass: "通过",
  fail: "失败",
  skip: "跳过",
  running: "执行中",
  queued: "排队中",
  canceled: "已取消",
  not_run: "未执行",
};

/** Maps the API's execution vocabulary onto the design system's. */
export function toRunStatus(status: string): RunStatus {
  if (status === "success" || status === "pass") return "pass";
  if (status === "failed" || status === "fail") return "fail";
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  if (status === "canceled") return "canceled";
  if (status === "not_run") return "not_run";
  return "skip";
}

/**
 * `label` lets callers pass a translated string. It stays optional so the
 * design-system preview can render without an i18n provider.
 */
export function Status({ status, label }: { status: RunStatus; label?: string }) {
  return (
    <span className="status" data-status={status}>
      <span className="status-mark" />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}

export function Method({ method }: { method: string }) {
  return <span className="method" data-method={method.toUpperCase()}>{method.toUpperCase()}</span>;
}

export function RunStrip({ history }: { history: RunStatus[] }) {
  if (!history.length) return <span className="muted">—</span>;
  return (
    <div className="runstrip" role="img" aria-label={`最近 ${history.length} 次运行`}>
      {history.map((run, index) => <span key={index} className="runstrip-bar" data-status={run} />)}
    </div>
  );
}

/** `tip` 让读数的单位/口径可悬停说明——「通过率统计的是什么通过了」这类问题
 *  由标签自己回答（趋势页 2026-09-10 验收反馈：执行级口径在标签上看不出来）。
 *  `onClick` 让低读数成为下钻入口（P8-6 边界 20：点接口覆盖率 → 项目表 Top 10 的
 *  coverage 列）；`extra` 是数值下方的附加内容（看板 30 天 sparkline）。
 *
 *  `drill`（看板读数下钻，2026-09-10）：悬浮弹出的分边面板——「已覆盖 x / 未覆盖 x」
 *  两侧各是一个链接，点哪边去哪边（接口覆盖率：已覆盖 → 接口列表筛已覆盖，未覆盖 →
 *  筛未覆盖）。与 `onClick` 互斥：整卡单一下钻用 onClick（更平的路径），分边下钻才用
 *  drill。面板本体是 antd Popover（浮层带焦点管理，归 antd 的边界纪律），内容样式归
 *  `.readout-drill`（design-system.css）。触屏没有 hover——这类读数在窄屏同样能从
 *  榜/列表进入，面板是补充不是唯一路径。
 */
export type DrillSide = { label: string; onClick: () => void };

function DrillPanel({ sides, note }: { sides: DrillSide[]; note?: ReactNode }) {
  return <div className="readout-drill">
    {sides.map((side) => (
      <button key={side.label} type="button" className="drill-side" onClick={side.onClick}>
        <span className="drill-label">{side.label}</span>
      </button>
    ))}
    {note && <p className="drill-note">{note}</p>}
  </div>;
}

export function Readout({ label, value, unit, tone, tip, onClick, drill, extra }: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: "pass" | "fail";
  tip?: ReactNode;
  onClick?: () => void;
  /** 分边下钻面板（悬浮弹出）；有 drill 时 onClick 不再整卡接线。 */
  drill?: { sides: DrillSide[]; note?: ReactNode };
  extra?: ReactNode;
}) {
  const body = <>
    <span className="label">{tip ? <Tip text={tip}>{label}</Tip> : label}</span>
    <strong className="mono" data-tone={tone}>
      {value}
      {unit && <span className="unit">{unit}</span>}
    </strong>
    {extra}
  </>;
  if (drill) {
    return <Popover content={<DrillPanel sides={drill.sides} note={drill.note} />} trigger="hover" mouseEnterDelay={0.1} placement="bottom" arrow={false} styles={{ body: { padding: 0 } }}>
      <div className="readout readout-drillable" tabIndex={0}>{body}</div>
    </Popover>;
  }
  if (onClick) {
    return <button type="button" className="readout readout-click" onClick={onClick}>{body}</button>;
  }
  return <div className="readout">{body}</div>;
}

/**
 * 7 天 delta 徽标（P8-6 边界 18）：计数是绝对差、比率是 pp（「从 80% 到 82%」是
 * +2pp 不是 +2.5%）。「升=好」不是公理（失败量升是坏事），由调用方按指标声明
 * `goodWhenUp`；执行量是中性的量变，不给色调。0 与 null 都不渲染——「不可算」与
 * 「没变化」是两个事实，画一个 0 会读成后者。挂在 Readout 的 `extra` 槽里。
 */
export function Delta({ value, kind = "count", goodWhenUp, tip }: {
  value: number | null | undefined;
  kind?: "count" | "pp";
  goodWhenUp?: boolean;
  tip?: ReactNode;
}) {
  if (value === null || value === undefined || value === 0) return null;
  const up = value > 0;
  const tone = goodWhenUp === undefined ? undefined : (up === goodWhenUp ? "pass" : "fail");
  return <Tip text={tip}>
    <span className="delta" data-tone={tone}>
      {up ? "+" : ""}{Math.abs(value * 10) % 10 === 0 ? value : value.toFixed(1)}{kind === "pp" ? "pp" : ""}
    </span>
  </Tip>;
}

export function Empty({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{hint}</p>
      {action}
    </div>
  );
}

/**
 * 列表页顶部操作区吸附条（P10-8）：把 `page-head` 与搜索/新建/筛选行包进来，下滑
 * 时保持可见、正文从其下方穿过。样式全在 design-system.css 的 `.page-toolbar`
 * （sticky / 不透明底 / 铺满滚动条宽度 / 层级 / 纵向间距），这里只提供承载节点，
 * 不引入 position:fixed（那会退化成第二个壳层，违背「只有 .content 滚动」）。
 */
export function PageToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `page-toolbar ${className}` : "page-toolbar"}>{children}</div>;
}

const PHASES = ["dns", "tcp", "tls", "ttfb", "body"] as const;
const PHASE_LABEL: Record<(typeof PHASES)[number], string> = {
  dns: "DNS", tcp: "TCP", tls: "TLS", ttfb: "TTFB", body: "下载",
};

/**
 * Response-time breakdown. Real timings are not exposed by the API yet;
 * when they are, pass them in and drop the estimate flag.
 */
export function Waterfall({ timings, total }: {
  timings?: Partial<Record<(typeof PHASES)[number], number>>;
  total: number;
}) {
  const estimated = !timings;
  const values = timings ?? estimate(total);
  const sum = PHASES.reduce((acc, phase) => acc + (values[phase] ?? 0), 0) || 1;

  return (
    <div className="waterfall">
      <div className="waterfall-head">
        <span className="label">响应时间分解{estimated && " · 估算"}</span>
        <span className="mono waterfall-total">{total} ms</span>
      </div>
      <div className="waterfall-track">
        {PHASES.map((phase) => (
          <div
            key={phase}
            className="waterfall-seg"
            data-phase={phase}
            style={{ width: `${((values[phase] ?? 0) / sum) * 100}%` }}
            title={`${PHASE_LABEL[phase]} ${values[phase] ?? 0}ms`}
          />
        ))}
      </div>
      <dl className="waterfall-legend">
        {PHASES.map((phase) => (
          <div key={phase}>
            <dt><span className="waterfall-key" data-phase={phase} />{PHASE_LABEL[phase]}</dt>
            <dd className="mono">{values[phase] ?? 0}<span className="unit">ms</span></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Typical shares of a single HTTPS request, used until the API reports real phases. */
function estimate(total: number) {
  return {
    dns: Math.round(total * 0.04),
    tcp: Math.round(total * 0.12),
    tls: Math.round(total * 0.21),
    ttfb: Math.round(total * 0.55),
    body: Math.round(total * 0.08),
  };
}
