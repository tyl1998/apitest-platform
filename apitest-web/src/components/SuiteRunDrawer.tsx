import { useEffect, useState } from "react";
import { Drawer } from "antd";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, type Execution, type ExecutionStep, type FlowExecutionDetail, type SuiteExecutionDetail } from "../api";
import { toRunStatus } from "../ui";
import { ExecutionDetail } from "./ExecutionSnapshot";
import { StepEvidence, flowStepRows } from "./FlowRunDrawer";
import { RunStatusTag } from "./RunStatusTag";

/**
 * 一次套件运行的成员证据（P2-4.3）。
 *
 * 与流程运行抽屉同一种交互（批量调试那一款）：一个成员一行，点开就地展开。展开后看到
 * 什么取决于成员是什么——用例成员是一次请求，展开就是请求/响应/断言快照；流程成员是
 * **一次完整的流程执行**，展开的是那次执行的步骤列表，而不是一句「通过/失败」。
 *
 * 行来自入队时冻结的成员快照而不是步骤行：还没开跑的成员根本没有 `execution_steps`
 * 行，只按步骤行渲染的话，一个 10 成员的套件在跑第 3 个时抽屉里只有 3 行，看起来像
 * 「这个套件只有 3 个成员」。快照是那次运行的完整计划，它才是清单。
 */
type MemberRow = {
  key: string;
  /** `case` 或 `flow`：决定展开后拉哪一种证据。 */
  type: string;
  name: string;
  /** 用例成员所属接口 / 流程成员的环境，扫描时用来区分同名成员。 */
  subtitle?: string;
  status: string;
  durationMs: number;
  error?: string;
  execution?: Execution;
  step?: ExecutionStep;
  /** 流程成员那次流程执行的 index id，只有开跑之后才有。 */
  childIndexId?: string;
};

function memberRows(run: SuiteExecutionDetail): MemberRow[] {
  const httpById = new Map(run.runs.map((execution) => [execution.id, execution]));
  /* 按 type:id 对号而不是按 position：`members` 已经去重，两边都以「哪个用例/流程」
     为准，位置只是它派生出来的顺序。 */
  const stepByMember = new Map(run.executionSteps.map((step) => [`${step.stepType}:${step.stepId}`, step]));
  /**
   * 已经结束的运行里，没有步骤行的成员是**跳过**，不是排队中。
   *
   * fail-fast 停下时服务端会补写 skipped 行，但**取消**只把已存在的行改成 canceled——
   * 没开跑的成员一行都没有，它们只体现在父级的 skippedCount 上。把它们画成「排队中」
   * 会让一次已经结束的运行看起来还在等，那是假的。
   */
  const finished = run.status !== "queued" && run.status !== "running";
  return run.members.map((member) => {
    const step = stepByMember.get(`${member.type}:${member.id}`);
    return {
      key: `${member.type}:${member.id}`,
      type: member.type,
      name: member.name,
      subtitle: member.endpointName ?? member.environmentName,
      status: step?.status ?? (finished ? "skipped" : "queued"),
      durationMs: step?.durationMs ?? 0,
      error: step?.error,
      execution: step?.httpExecutionId ? httpById.get(step.httpExecutionId) : undefined,
      step,
      childIndexId: step?.childIndexId,
    };
  });
}

/** 尾列：用例看状态码，流程看它自己跑过几步——两者都配一个耗时。 */
function trailing(row: MemberRow) {
  /* 没开跑的（排队中、fail-fast 跳过的）没有耗时可言，「— · 0ms」只是噪音。 */
  if (!row.step || row.status === "skipped") return "—";
  if (row.type === "flow") {
    const output = row.step.output as { successCount?: number; failedCount?: number; skippedCount?: number } | undefined;
    if (output?.successCount === undefined) return `— · ${row.durationMs}ms`;
    const total = output.successCount + (output.failedCount ?? 0) + (output.skippedCount ?? 0);
    return `${output.successCount}/${total} · ${row.durationMs}ms`;
  }
  return `${row.execution?.statusCode ?? "—"} · ${row.execution?.durationMs ?? row.durationMs}ms`;
}

export function SuiteRunDrawer({ projectId, run, onClose, onCancel, canceling }: {
  projectId: string;
  run?: SuiteExecutionDetail;
  onClose: () => void;
  /** 取消入口留在抽屉里：进度是在这里看的，让人先关掉抽屉才能停是多余的一步。 */
  onCancel?: () => void;
  canceling?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string>();

  if (!run) return null;

  const rows = memberRows(run);
  const busy = run.status === "queued" || run.status === "running";
  const settled = run.successCount + run.failedCount + run.skippedCount;

  return <Drawer
    title={run.suiteName || t("suites.runDetail")}
    open
    onClose={onClose}
    width={720}
    extra={<span className="mono muted">{t("suites.memberSummary", { success: run.successCount, total: run.total })}
      {run.failedCount > 0 ? ` · ${t("suites.memberFailed", { count: run.failedCount })}` : ""}
      {run.skippedCount > 0 ? ` · ${t("suites.memberSkipped", { count: run.skippedCount })}` : ""}</span>}
  >
    {/* 还在跑的时候，「跑到第几个了」和「停下来」是同一件事的两半，放在一起。 */}
    {busy && <div className="batch-progress">
      <RunStatusTag status={run.status === "queued" ? "queued" : "running"} />
      <span className="mono muted">{t("run.batchProgress", { settled, total: run.total })}</span>
      {onCancel && <button className="btn btn-small" disabled={canceling} onClick={onCancel}>{t("run.cancel")}</button>}
    </div>}

    <div className="batch-items">
      {run.error && <p className="form-note text-fail mono">{run.error}</p>}
      {rows.map((row) => {
        const open = expanded === row.key;
        return <div className="batch-row" key={row.key}>
          <button className="batch-item batch-item-button" aria-expanded={open} onClick={() => setExpanded(open ? undefined : row.key)}>
            <span className="batch-caret">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
            <span className="cell-name">
              {/* 成员是用例还是流程决定了展开后能看到什么，所以它必须在收起状态下就能读到。 */}
              <span className="chip">{row.type === "case" ? t("suites.memberTypeCase") : t("suites.memberTypeFlow")}</span>
              <span className="truncate suite-member-name">{row.name}</span>
              {row.subtitle && <span className="mono muted truncate suite-member-meta">{row.subtitle}</span>}
            </span>
            <RunStatusTag status={toRunStatus(row.status)} />
            <span className="mono muted">{trailing(row)}</span>
          </button>
          {open && <div className="batch-detail"><MemberEvidence projectId={projectId} row={row} /></div>}
        </div>;
      })}
      {!rows.length && <p className="form-note">{t("suites.runMembersEmpty")}</p>}
    </div>
  </Drawer>;
}

function MemberEvidence({ projectId, row }: { projectId: string; row: MemberRow }) {
  const { t } = useTranslation();

  /* 用例成员：一次请求，快照就是全部。 */
  if (row.execution) return <ExecutionDetail result={row.execution} />;
  /* 流程成员：它自己是一次父执行，证据在那棵步骤树里。 */
  if (row.childIndexId) return <FlowMemberSteps projectId={projectId} indexId={row.childIndexId} />;

  /* 起不来的成员（用例/流程被删、子流程成环、并发超预算）没有证据，但有原因。
     错误原文照抄——它是数据，不是文案。 */
  if (row.error) return <div className="panel-body"><pre className="mono script-error">{row.error}</pre></div>;

  /**
   * 剩下的都是没开跑的成员，但「为什么没跑」有三种，不能合成一句。
   *
   * 有 skipped 行 = fail-fast 停在前一个失败上（服务端补写的那一行）；没有行而运行已结束
   * = 取消时它还没排到（服务端不为它写行，只计入 skippedCount）；没有行而运行还在跑
   * = 在等一个并发名额。
   */
  const waiting = row.status !== "skipped";
  return <div className="panel-body">
    <p className="form-note">{waiting
      ? t("suites.memberWaiting")
      : row.step ? t("suites.memberSkippedFailFast") : t("suites.memberNeverStarted")}</p>
  </div>;
}

/**
 * 流程成员展开后的步骤列表。
 *
 * 两跳：`execution_steps.child_index_id` 指向那次流程执行的 index 行，它只给出
 * `detailId`；HTTP 快照要靠流程明细一次带回来。两跳都只在**展开时**才发——一个装了
 * 十条流程的套件详情不该为了摘要把十棵步骤树都搬过来。
 *
 * 走 index id 而不是 `output.flowExecutionId`：后者只在成员跑完时才写，而
 * `child_index_id` 在开跑之前就落库，所以正在跑的成员也能展开来看。
 */
function FlowMemberSteps({ projectId, indexId }: { projectId: string; indexId: string }) {
  const { t } = useTranslation();
  const [run, setRun] = useState<FlowExecutionDetail>();
  const [failed, setFailed] = useState(false);
  const [openStep, setOpenStep] = useState<string>();

  useEffect(() => {
    let alive = true;
    setRun(undefined); setFailed(false); setOpenStep(undefined);
    void api.executionIndexDetail(projectId, indexId)
      .then((index) => api.flowExecution(projectId, index.detailId))
      .then((detail) => { if (alive) setRun(detail); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [projectId, indexId]);

  /* 读失败要说出来，而不是显示一个空列表让人以为这条流程什么都没跑。 */
  if (failed) return <p className="form-note text-fail">{t("suites.memberStepsFailed")}</p>;
  if (!run) return <p className="muted">{t("common.loading")}</p>;

  const rows = flowStepRows(run);
  if (!rows.length) return <p className="form-note">{t("flows.runStepsEmpty")}</p>;

  return <div className="nested-steps">
    {rows.map((row) => {
      const open = openStep === row.key;
      return <div className="nested-step" key={row.key}>
        <button
          className="nested-step-row batch-item-button"
          aria-expanded={open}
          onClick={() => setOpenStep(open ? undefined : row.key)}
        >
          <span className="batch-caret">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
          <span className="nested-step-kind mono">{row.type}</span>
          <span className="truncate">{row.name}</span>
          <RunStatusTag status={toRunStatus(row.status)} />
          <span className="mono muted">{row.execution?.statusCode ?? "—"} · {row.execution?.durationMs ?? row.durationMs}ms</span>
        </button>
        {open && <div className="batch-detail"><StepEvidence projectId={projectId} row={row} /></div>}
      </div>;
    })}
  </div>;
}
