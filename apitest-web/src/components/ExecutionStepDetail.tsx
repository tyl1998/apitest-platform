import { useTranslation } from "react-i18next";
import type { Execution, ExecutionStep, ScriptCheck } from "../api";
import { DatabaseResult } from "./DatabaseResult";
import { ExecutionDetail } from "./ExecutionSnapshot";
import { ScriptChecks } from "./AssertionEditor";

/**
 * One step's evidence, expanded in place (5.0.9).
 *
 * HTTP steps show the full request/response/断言 snapshot — the same
 * ExecutionDetail batch debug uses; database / script / condition steps show
 * their own result shape. Shared by the run drawer and nested lists so a
 * loop body step reads the same wherever it is opened.
 */
export function ExecutionStepDetail({ step, execution, publicView }: {
  step: ExecutionStep;
  execution?: Execution;
  /** 公开分享页（P10-1）：透传给 ExecutionDetail，那里据此收起下载完整响应入口。 */
  publicView?: boolean;
}) {
  const { t } = useTranslation();

  /* HTTP step: the request/response snapshot is the whole story. */
  if (execution) return <ExecutionDetail result={execution} publicView={publicView} />;

  if (step.stepType === "database") {
    const output = step.output as { rows?: Record<string, unknown>[]; rowCount?: number; truncated?: boolean; fullScan?: boolean };
    return <DatabaseResult
      result={output.rows ? { rows: output.rows, rowCount: Number(output.rowCount ?? 0), truncated: Boolean(output.truncated), durationMs: step.durationMs, fullScan: Boolean(output.fullScan) } : undefined}
      error={step.error}
    />;
  }

  if (step.stepType === "script") return <ScriptOutcome step={step} />;
  if (step.stepType === "condition") return <ConditionOutcome step={step} />;

  /* wait 节点只有耗时和错误，没有可展示的输出。 */
  return <div className="panel-body">
    {step.error && <pre className="mono script-error">{step.error}</pre>}
    {step.output && Object.keys(step.output).length > 0 && <pre className="code">{JSON.stringify(step.output, null, 2)}</pre>}
  </div>;
}

function ScriptOutcome({ step }: { step: ExecutionStep }) {
  const { t } = useTranslation();
  const output = step.output as {
    logs?: string[]; debug?: { label: string; value: string }[];
    checks?: ScriptCheck[]; returned?: string; variables?: Record<string, string>;
  } | undefined;
  return <div className="panel-body script-node-outcome">
    {step.error && <pre className="mono script-error">{step.error}</pre>}
    <ScriptChecks checks={output?.checks} />
    {output?.debug && output.debug.length > 0 && output.debug.map((entry, index) => <div className="hook-debug" key={index}><span className="hook-debug-label">{entry.label}</span><pre className="mono hook-debug-value">{entry.value}</pre></div>)}
    {output?.logs && output.logs.length > 0 && <pre className="mono script-logs">{output.logs.join("\n")}</pre>}
    {output?.returned !== undefined && <p className="form-note mono">{t("flows.scriptNodeReturned")}<span className="kv-value">{output.returned}</span></p>}
    {output?.variables && Object.keys(output.variables).length > 0 && <div className="kv-list">
      {Object.entries(output.variables).map(([key, value]) => <div key={key} className="kv-row mono"><span className="kv-key">{key}</span><span className="kv-value">= {String(value)}</span></div>)}
    </div>}
  </div>;
}

function ConditionOutcome({ step }: { step: ExecutionStep }) {
  const { t } = useTranslation();
  const output = step.output as {
    mode?: "all" | "any";
    rules?: Array<{ variable: string; operator: string; value?: string; actual?: unknown; result: boolean }>;
    result?: boolean;
  } | undefined;
  return <div className="panel-body">
    {step.error && <pre className="mono script-error">{step.error}</pre>}
    {output && <div className="kv-list">
      <div className="kv-row mono"><span className="kv-key">{t("flows.conditionResult")}</span><span className="kv-value">{String(output.result)}</span></div>
      <div className="kv-row mono"><span className="kv-key">{t("flows.conditionRule")}</span><span className="kv-value">{output.mode === "any" ? "OR" : "AND"}</span></div>
      {(output.rules ?? []).map((rule, index) => <div className="kv-row mono" key={index}><span className="kv-key">#{index + 1} {String(rule.result)}</span><span className="kv-value">{rule.variable} {rule.operator} {rule.value ?? ""} · {rule.actual === undefined ? "—" : String(rule.actual)}</span></div>)}
    </div>}
  </div>;
}
