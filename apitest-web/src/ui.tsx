import type { ReactNode } from "react";

export type RunStatus = "pass" | "fail" | "skip" | "running" | "queued" | "canceled";

const STATUS_LABEL: Record<RunStatus, string> = {
  pass: "通过",
  fail: "失败",
  skip: "跳过",
  running: "执行中",
  queued: "排队中",
  canceled: "已取消",
};

/** Maps the API's execution vocabulary onto the design system's. */
export function toRunStatus(status: string): RunStatus {
  if (status === "success" || status === "pass") return "pass";
  if (status === "failed" || status === "fail") return "fail";
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  if (status === "canceled") return "canceled";
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

export function Readout({ label, value, unit, tone }: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: "pass" | "fail";
}) {
  return (
    <div className="readout">
      <span className="label">{label}</span>
      <strong className="mono" data-tone={tone}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </strong>
    </div>
  );
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
