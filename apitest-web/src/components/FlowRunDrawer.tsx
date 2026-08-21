import { useState } from "react";
import { Drawer } from "antd";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Execution, ExecutionStep, FlowExecutionDetail } from "../api";
import { toRunStatus } from "../ui";
import { ExecutionStepDetail } from "./ExecutionStepDetail";
import { ExecutionDetail } from "./ExecutionSnapshot";
import { NestedStepList } from "./NestedStepList";
import { RunStatusTag } from "./RunStatusTag";

/**
 * 一次流程运行的完整步骤证据（5.0.9）。
 *
 * 批量调试抽屉的样式：每步一行、点击展开；HTTP 步骤展开请求/响应快照，
 * 非 HTTP 步骤展开各自的结果（数据库 / 脚本 / 条件 / 容器）。
 *
 * 步骤主列表用 `executionSteps`（每节点一行，含 HTTP 步骤经 http_execution_id
 * 关联 `executions`）；只有旧 run（P2-0 之前、无 execution_index_id）才退回
 * 纯 HTTP `steps`——历史数据仍能读，只是非 HTTP 节点没有通用步骤行。
 */
export function FlowRunDrawer({ projectId, run, onClose }: {
  projectId: string;
  run?: FlowExecutionDetail;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string>();

  if (!run) return null;

  const httpById = new Map(run.steps.map((execution) => [execution.id, execution]));
  const generic = run.executionSteps.filter((step) => !step.parentStepId);
  const rows = generic.length
    ? generic.map((step) => ({
        key: step.id,
        name: step.stepName || step.stepType,
        type: step.stepType,
        status: step.status,
        durationMs: step.durationMs,
        error: step.error,
        step,
        execution: step.httpExecutionId ? httpById.get(step.httpExecutionId) : undefined,
      }))
    : run.steps.map((execution) => ({
        key: execution.id,
        name: execution.flowNodeName ?? execution.endpointName,
        type: "request",
        status: execution.status,
        durationMs: execution.durationMs,
        error: execution.error,
        step: undefined,
        execution,
      }));

  return <Drawer
    title={run.flowName || t("flows.runDetail")}
    open
    onClose={onClose}
    width={720}
    extra={<span className="mono muted">{t("flows.stepSummary", { success: run.successCount, total: run.total })}
      {run.failedCount > 0 ? ` · ${t("flows.failedCount", { count: run.failedCount })}` : ""}
      {run.skippedCount > 0 ? ` · ${t("flows.skippedCount", { count: run.skippedCount })}` : ""}</span>}
  >
    <div className="batch-items">
      {run.error && <p className="form-note text-fail mono">{run.error}</p>}
      {rows.map((row) => {
        const open = expanded === row.key;
        return <div className="batch-row" key={row.key}>
          <button className="batch-item batch-item-button" aria-expanded={open} onClick={() => setExpanded(open ? undefined : row.key)}>
            <span className="batch-caret">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
            <span className="truncate">{row.name}</span>
            <RunStatusTag status={toRunStatus(row.status)} />
            {/* 与批量调试同款：状态码 · 耗时，扫描时一眼对齐。 */}
            <span className="mono muted">{row.execution?.statusCode ?? "—"} · {row.execution?.durationMs ?? row.durationMs}ms</span>
          </button>
          {open && <div className="batch-detail">
            <StepEvidence projectId={projectId} row={row} />
          </div>}
        </div>;
      })}
      {!rows.length && <p className="form-note">{t("flows.runStepsEmpty")}</p>}
    </div>
  </Drawer>;
}

type StepRow = {
  key: string;
  name: string;
  type: string;
  status: string;
  durationMs: number;
  error?: string;
  step?: ExecutionStep;
  execution?: Execution;
};

function StepEvidence({ projectId, row }: { projectId: string; row: StepRow }) {
  const { t } = useTranslation();

  /* HTTP step: the request/response snapshot is the whole story. */
  if (row.execution) return row.step
    ? <ExecutionStepDetail step={row.step} execution={row.execution} />
    : <ExecutionDetail result={row.execution} />;

  /* Container steps (loop / subflow / request 并发) carry a summary and hang
     their children off them. 只要 output 里带了 iterations，就需要展开成嵌套列表。 */
  const iterations = (row.step?.output as {
    iterations?: { index: number; item?: string; status: string; durationMs: number; error?: string }[];
  } | undefined)?.iterations;
  if (row.step && (row.step.stepType === "loop" || row.step.stepType === "subflow" || iterations?.length)) {
    return <>
      {row.error && <pre className="mono script-error">{row.error}</pre>}
      <NestedStepList
        projectId={projectId}
        parentStepId={row.step.id}
        iterations={iterations}
      />
    </>;
  }

  /* Non-HTTP leaf steps: database / script / condition / wait evidence. */
  return <ExecutionStepDetail step={row.step!} />;
}
