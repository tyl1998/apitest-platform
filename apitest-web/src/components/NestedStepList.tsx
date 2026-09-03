import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, type Execution, type ExecutionStep } from "../api";
import { RunStatusTag } from "./RunStatusTag";
import { ExecutionStepDetail } from "./ExecutionStepDetail";
import { toRunStatus } from "../ui";

/**
 * 容器节点（循环 / 子流程）内部跑过的步骤（P2-6）。
 *
 * 存在的理由是一句结论不够用：「第 3 次迭代失败」不能告诉用户是里面哪个请求失败、
 * 失败在哪。嵌套步骤本身就是可复盘证据（execution_steps 里 parent_step_id 指回
 * 容器行），这里按迭代分组展示；**每行点开就地展开**该步骤的证据（HTTP 步骤是
 * 请求/响应/断言快照，数据库/脚本/条件步骤是各自的结果）——与批量调试同一种交互。
 *
 * 循环 / 子流程可以再套循环 / 子流程，所以容器行展开后递归再渲染一层 NestedStepList，
 * 每一层都只展示自己的直接子步骤，点击始终落到具体那一次执行的快照上。
 *
 * `shareToken`（2026-09-03）：分享页的公开读法，取数改走 `/public/report-shares/:token/*`
 * （token 即凭据）；站内路径不变。
 */
export function NestedStepList({ projectId, parentStepId, iterations, shareToken }: {
  projectId?: string;
  parentStepId: string;
  /** 循环节点的每次迭代结论；子流程不传（它只跑一次）。 */
  iterations?: { index: number; item?: string; status: string; durationMs: number; error?: string }[];
  shareToken?: string;
}) {
  const { t } = useTranslation();
  const [steps, setSteps] = useState<ExecutionStep[]>();
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [failed, setFailed] = useState(false);
  const [openIteration, setOpenIteration] = useState<Set<number>>(new Set());
  const [openStep, setOpenStep] = useState<string>();

  useEffect(() => {
    setSteps(undefined); setFailed(false); setOpenStep(undefined); setOpenIteration(new Set());
    const request = shareToken
      ? api.publicShareStepChildren(shareToken, parentStepId)
      : projectId
        ? api.executionStepChildren(projectId, parentStepId)
        : Promise.reject(new Error("no project context"));
    void request
      .then((data) => { setSteps(data.steps); setExecutions(data.executions); })
      .catch(() => setFailed(true));
  }, [projectId, parentStepId, shareToken]);

  /* 失败要说出来，而不是显示一个空列表让人以为「里面什么都没跑」。 */
  if (failed) return <p className="form-note text-fail">{t("flows.nestedStepsFailed")}</p>;
  if (!steps) return <p className="muted">{t("common.loading")}</p>;
  if (!steps.length) return <p className="form-note">{t("flows.nestedStepsEmpty")}</p>;

  const httpById = new Map(executions.map((execution) => [execution.id, execution]));

  const row = (step: ExecutionStep) => {
    const open = openStep === step.id;
    const stepIterations = (step.output as {
      iterations?: { index: number; item?: string; status: string; durationMs: number; error?: string }[];
    } | undefined)?.iterations;
    const isContainer = step.stepType === "loop" || step.stepType === "subflow" || (Array.isArray(stepIterations) && stepIterations.length > 0);
    const execution = step.httpExecutionId ? httpById.get(step.httpExecutionId) : undefined;
    return <div className="nested-step" key={step.id}>
      <button
        className="nested-step-row batch-item-button"
        aria-expanded={open}
        onClick={() => setOpenStep(open ? undefined : step.id)}
      >
        <span className="batch-caret">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="nested-step-kind mono">{step.stepType}</span>
        <span className="truncate">{step.stepName || "—"}</span>
        <RunStatusTag status={toRunStatus(step.status)} />
        <span className="mono muted">{execution?.statusCode ?? "—"} · {execution?.durationMs ?? step.durationMs}ms</span>
        {step.error && <span className="mono text-fail truncate">{step.error}</span>}
      </button>
      {open && <div className="batch-detail">
        {/* 容器再套容器：递归展示下一层，各自按迭代/步骤逐层点开。 */}
        {isContainer
          ? <NestedStepList projectId={projectId} parentStepId={step.id} iterations={stepIterations} shareToken={shareToken} />
          : <ExecutionStepDetail step={step} execution={step.httpExecutionId ? httpById.get(step.httpExecutionId) : undefined} />}
      </div>}
    </div>;
  };

  /* 子流程只跑一次：平铺，不需要分组这一层视觉噪音。 */
  if (!iterations?.length) {
    return <div className="nested-steps">{steps.map(row)}</div>;
  }

  const byIteration = new Map<number, ExecutionStep[]>();
  for (const step of steps) {
    const key = step.iteration ?? 0;
    byIteration.set(key, [...(byIteration.get(key) ?? []), step]);
  }

  return <div className="nested-iterations">
    {iterations.map((iteration) => {
      const expanded = openIteration.has(iteration.index);
      const inner = byIteration.get(iteration.index) ?? [];
      return <div className="nested-iteration" key={iteration.index}>
        <button
          className="nested-iteration-head"
          aria-expanded={expanded}
          onClick={() => setOpenIteration((current) => {
            const next = new Set(current);
            if (next.has(iteration.index)) next.delete(iteration.index); else next.add(iteration.index);
            return next;
          })}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="mono">#{iteration.index + 1}</span>
          <RunStatusTag status={toRunStatus(iteration.status)} />
          {/* 列表循环把当前元素显示出来：失败的那次是哪一项，是第一个要问的问题。 */}
          {iteration.item !== undefined && <span className="mono muted truncate">{iteration.item}</span>}
          <span className="mono muted">{iteration.durationMs.toFixed(1)} ms</span>
          {iteration.error && <span className="mono text-fail truncate">{iteration.error}</span>}
        </button>
        {expanded && <div className="nested-steps">{inner.length ? inner.map(row) : <p className="form-note">{t("flows.nestedStepsEmpty")}</p>}</div>}
      </div>;
    })}
  </div>;
}
