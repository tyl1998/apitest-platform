import { useEffect, useMemo, useState } from "react";
import { Drawer, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { Braces, Database, GitBranch, Globe2, Play, Plus, Timer, Trash2, Workflow } from "lucide-react";
import { api, type ExecutionStep, type FlowNode, type FlowStepResult, type FlowSummary, type LoopFlowNode, type SubflowFlowNode, type WaitFlowNode } from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import { variableOptions } from "../lib/flowVariables";
import { useLimitsStore } from "../stores/limitsStore";
import { useProjectStore } from "../stores/projectStore";
import { IconButton } from "./IconButton";
import { KeyValueEditor, fromPairs, toPairs, type Pair } from "./KeyValueEditor";
import { NestedStepList } from "./NestedStepList";
import { RunStatusTag } from "./RunStatusTag";
import { VariableField } from "./VariableField";
import { toRunStatus } from "../ui";
import type { FlowNodeDrawerProps } from "./FlowNodeDrawer";

/** 画布容器最多框住几步——上限与后端 MAX_LOOP_BODY_NODES 一致。 */
const MAX_LOOP_BODY = 10;

/** 循环体内步骤的徽标与图标，与画布同款（避免引 FlowWorkspace 造成循环依赖）。 */
const BODY_KIND_BADGE: Record<Exclude<FlowNode["type"], "request">, string> = {
  database: "DB", script: "JS", condition: "IF", wait: "⏱", subflow: "SUB", loop: "LOOP",
};
function NodeKindIcon({ type, size }: { type: FlowNode["type"]; size: number }) {
  if (type === "database") return <Database size={size} />;
  if (type === "script") return <Braces size={size} />;
  if (type === "condition") return <GitBranch size={size} />;
  if (type === "wait") return <Timer size={size} />;
  if (type === "subflow") return <Workflow size={size} />;
  if (type === "loop") return <RepeatIcon size={size} />;
  return <Globe2 size={size} />;
}
function RepeatIcon({ size }: { size: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>; }

/** 循环体内某步骤的一行副标题，供内联列表展示。 */
function loopBodyStepSubtitle(step: FlowNode): string {
  if (step.type === "request") return step.request.url || "—";
  if (step.type === "database") return step.sqlDefinitionId ? "命名 SQL" : step.operation ? "操作" : step.statementType ?? "—";
  if (step.type === "script") return "脚本";
  if (step.type === "condition") return `AND · ${step.condition.rules.length} 条条件`;
  if (step.type === "wait") return `等待 ${step.waitMs}ms`;
  if (step.type === "subflow") return step.flowName ?? step.flowId;
  return `循环 ×${step.count ?? 1}`;
}

/**
 * 高级节点配置抽屉（P2-6：等待 / 子流程 / 循环）。
 *
 * 与前四种节点分开一个文件：`FlowNodeDrawer.tsx` 已经很长，而这三个编辑器共享
 * 「引用一个流程 + 入参 + 出参」这套表单，前四种都没有。
 */

type AdvancedProps<T extends FlowNode> = Omit<FlowNodeDrawerProps, "node"> & { node: T };

/** 只认这个节点自己的证据，避免把别的步骤的结果读成本节点的。 */
function ownStep(result: FlowStepResult | undefined, type: string): ExecutionStep | undefined {
  return result && !("endpointId" in result) && result.stepType === type ? result : undefined;
}

/**
 * 拉取一个节点最近一次证据。
 *
 * 与其他抽屉同一条规则：跑完整条流程之后，这个节点最新的证据就是那次流程运行，
 * 显示更旧的单步调试结果会让抽屉在最需要它的时刻看起来是过期的。
 */
function useNodeEvidence(projectId: string, flowId: string, nodeId: string, type: string, evidence?: FlowStepResult) {
  const [result, setResult] = useState<ExecutionStep>();
  useEffect(() => {
    setResult(undefined);
    const restored = ownStep(evidence, type);
    if (restored) { setResult(restored); return; }
    void api.flowNodeExecutions(projectId, flowId, nodeId)
      .then((runs) => setResult(ownStep(runs[0], type)))
      .catch(() => { /* 新节点没有证据 */ });
  }, [projectId, flowId, nodeId, type, evidence]);
  return [result, setResult] as const;
}

/** 单步调试：本节点单独跑一次，变量由流程变量面板代替上游产出。 */
function useSingleStep(projectId: string, flowId: string, node: FlowNode, variables: Record<string, string>, type: string, setResult: (step?: ExecutionStep) => void) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try {
      const next = await api.executeFlowNode(projectId, flowId, node, variables);
      const step = ownStep(next, type);
      if (!step) throw new Error(t("flows.nodeResultUnavailable"));
      setResult(step);
    } catch (error) {
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(detail ?? (error instanceof Error ? error.message : t("flows.nodeRunFailed")));
    } finally { setRunning(false); }
  };
  return [running, run] as const;
}

/** 抽屉右上角：单步调试 + 删除，与其他节点抽屉一致。viewer 不渲染（P6-4）。 */
function DrawerActions({ running, onRun, onDelete }: { running: boolean; onRun: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  const canWrite = useCanWrite();
  if (!canWrite) return null;
  return <div className="row-actions">
    <button className="btn btn-with-icon" disabled={running} onClick={onRun}>
      <Play size={14} />{running ? t("action.running") : t("flows.runNode")}
    </button>
    <IconButton icon={<Trash2 size={15} />} label={t("action.delete")} tone="danger" onClick={onDelete} />
  </div>;
}

/** 名称 + 失败处理，三种节点共用的头部两栏。 */
function NodeHeader<T extends FlowNode>({ node, placeholder, onChange }: { node: T; placeholder: string; onChange: (node: T) => void }) {
  const { t } = useTranslation();
  return <div className="form-grid">
    <label className="field">
      <span>{t("flows.nodeName")}</span>
      <input className="input" value={node.name} onChange={(event) => onChange({ ...node, name: event.target.value })} placeholder={placeholder} />
    </label>
    <label className="field">
      <span>{t("flows.onFailure")}</span>
      <Select
        value={node.onFailure}
        onChange={(onFailure) => onChange({ ...node, onFailure })}
        options={[{ value: "stop", label: t("flows.failureStop") }, { value: "continue", label: t("flows.failureContinue") }]}
        style={{ width: "100%" }}
      />
    </label>
  </div>;
}

/**
 * 等待节点。
 *
 * 编辑器故意只有一个数字：首版是**短等待**，等待期间这个节点占着流程的并发额度，
 * 所以有 30s 上限，「等到某个条件成立」是另一个能力（需要挂起-恢复模型）。以秒为
 * 单位输入，因为业务上说的是「等两秒再查库」，而不是 2000 毫秒。
 */
export function WaitNodeDrawer({ projectId, flowId, node, variables, evidence, onChange, onClose, onDelete }: AdvancedProps<WaitFlowNode>) {
  const { t } = useTranslation();
  const [result, setResult] = useNodeEvidence(projectId, flowId, node.id, "wait", evidence);
  const [running, run] = useSingleStep(projectId, flowId, node, variables, "wait", setResult);
  const seconds = node.waitMs / 1000;
  /* 等待上限由服务端说（MAX_WAIT_MS）：等待期间节点占着并发槽，上限属于平台而不是页面。 */
  const maxSeconds = useLimitsStore((state) => state.limits.maxWaitMs) / 1000;
  const output = result?.output as { waitMs?: number; waitedMs?: number; interrupted?: boolean } | undefined;

  return <Drawer title={t("flows.nodeTitle")} open onClose={onClose} width={640} extra={<DrawerActions running={running} onRun={() => void run()} onDelete={onDelete} />}>
    <NodeHeader node={node} placeholder={t("flows.waitNodeNamePlaceholder")} onChange={onChange} />
    <label className="field" style={{ marginTop: 12, maxWidth: 240 }}>
      <span>{t("flows.waitSeconds")}</span>
      <input
        className="input mono"
        type="number"
        min={0.1}
        max={maxSeconds}
        step={0.1}
        value={Number.isFinite(seconds) ? seconds : ""}
        onChange={(event) => {
          const next = Number(event.target.value);
          /* 毫秒是存储单位，秒只是输入单位；四舍五入避免 1.1*1000 出现浮点尾数。 */
          onChange({ ...node, waitMs: Number.isFinite(next) ? Math.min(maxSeconds * 1000, Math.round(next * 1000)) : 0 });
        }}
      />
    </label>
    <p className="form-note">{t("flows.waitNodeHint", { max: maxSeconds })}</p>

    {result && <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <RunStatusTag status={toRunStatus(result.status)} />
        <span className="mono muted">{result.durationMs.toFixed(1)} ms</span>
        <span className="filter-spacer" />
        <button className="btn btn-small" onClick={() => setResult(undefined)}>{t("action.close")}</button>
      </div>
      <div className="panel-body">
        <div className="kv-list">
          <div className="kv-row mono"><span className="kv-key">{t("flows.waitPlanned")}</span><span className="kv-value">{output?.waitMs ?? node.waitMs} ms</span></div>
          <div className="kv-row mono"><span className="kv-key">{t("flows.waitActual")}</span><span className="kv-value">{output?.waitedMs ?? "—"} ms</span></div>
        </div>
        {output?.interrupted && <p className="form-note text-fail">{t("flows.waitInterrupted")}</p>}
        {result.error && <pre className="mono script-error">{result.error}</pre>}
      </div>
    </section>}
  </Drawer>;
}

/**
 * 「引用哪个流程 + 传什么进去 + 拿什么出来」——子流程与循环共用。
 *
 * 出参是**白名单**，且「未声明」和「声明为空」是两种不同配置：未声明 = 内层产出
 * 全部带出来，空 = 一个都不带（只要副作用）。所以这里用一个显式开关，而不是让
 * 空列表兼任两种含义。
 */
function FlowReferenceFields<T extends SubflowFlowNode>({ node, flows, options, onChange }: {
  node: T;
  flows: FlowSummary[];
  options: ReturnType<typeof variableOptions>;
  onChange: (node: T) => void;
}) {
  const { t } = useTranslation();
  const [inputs, setInputs] = useState<Pair[]>(toPairs(node.inputs ?? {}));
  useEffect(() => { setInputs(toPairs(node.inputs ?? {})); }, [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = flows.find((flow) => flow.id === node.flowId);
  const publishAll = node.outputs === undefined;

  return <>
    <label className="field" style={{ marginTop: 12 }}>
      <span>{t("flows.referencedFlow")}</span>
      <Select
        value={node.flowId || undefined}
        onChange={(flowId) => onChange({ ...node, flowId, flowName: flows.find((flow) => flow.id === flowId)?.name })}
        options={[
          /* 引用的流程可能已被删除：保留快照名，而不是显示一个空控件让人以为引用丢了。 */
          ...(node.flowId && !flows.some((flow) => flow.id === node.flowId)
            ? [{ value: node.flowId, label: node.flowName ?? node.flowId }]
            : []),
          ...flows.map((flow) => ({ value: flow.id, label: `${flow.name}（${t("flows.stepCount", { count: flow.nodeCount })}）` })),
        ]}
        placeholder={t("flows.pickFlow")}
        showSearch optionFilterProp="label"
        style={{ width: "100%" }}
      />
    </label>
    {/* 引用而非快照，说明白：改子流程会影响所有调用方——这正是它存在的理由。 */}
    <p className="form-note">{t("flows.referenceNote")}</p>
    {selected && !selected.nodeCount && <p className="form-error">{t("flows.referencedFlowEmpty")}</p>}

    <KeyValueEditor
      pairs={inputs}
      onChange={(pairs) => { setInputs(pairs); onChange({ ...node, inputs: fromPairs(pairs) }); }}
      keyPlaceholder="userId"
      valuePlaceholder="{{userId}}"
      title={t("flows.subflowInputs")}
      hint={t("flows.subflowInputsHint")}
      variableOptions={options}
    />

    <div className="field" style={{ marginTop: 16 }}>
      <span>{t("flows.subflowOutputs")}</span>
      <Select
        value={publishAll ? "all" : "pick"}
        onChange={(mode) => onChange({ ...node, outputs: mode === "all" ? undefined : [] })}
        options={[{ value: "all", label: t("flows.outputsAll") }, { value: "pick", label: t("flows.outputsPick") }]}
        style={{ width: 240 }}
      />
    </div>
    {!publishAll && <>
      {(node.outputs ?? []).map((name, index) => <div className="extract-row" key={index}>
        <div className="extract-fields">
          <input
            className="input mono"
            value={name}
            onChange={(event) => onChange({ ...node, outputs: (node.outputs ?? []).map((item, at) => at === index ? event.target.value : item) })}
            placeholder="orderId"
            aria-label={t("flows.subflowOutputName")}
          />
          <IconButton
            icon={<Trash2 size={14} />}
            label={t("action.delete")}
            tone="danger"
            onClick={() => onChange({ ...node, outputs: (node.outputs ?? []).filter((_, at) => at !== index) })}
          />
        </div>
      </div>)}
      <button className="btn btn-with-icon" onClick={() => onChange({ ...node, outputs: [...(node.outputs ?? []), ""] })}>
        <Plus size={14} />{t("flows.addOutput")}
      </button>
    </>}
    <p className="form-note">{publishAll ? t("flows.outputsAllHint") : t("flows.outputsPickHint")}</p>
  </>;
}

/** 项目里可被引用的流程列表，排除当前流程自身（直接自引用一定被后端拒绝）。 */
function useReferencableFlows(projectId: string, flowId: string) {
  const { t } = useTranslation();
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  useEffect(() => {
    void api.flows(projectId)
      .then((all) => setFlows(all.filter((flow) => flow.id !== flowId)))
      .catch(() => { setFlows([]); message.error(t("flows.loadFailed")); });
  }, [projectId, flowId, t]);
  return flows;
}

/**
 * 子流程节点。
 *
 * 内层是隔离作用域：只看到 环境变量 + 内层流程自己的种子变量 + 显式入参。外层
 * 换变量名不会悄悄改变子流程读到的东西，这是复用的前提。
 */
export function SubflowNodeDrawer({ projectId, flowId, node, nodes, edges, variables, environmentId, evidence, onChange, onClose, onDelete }: AdvancedProps<SubflowFlowNode>) {
  const { t } = useTranslation();
  const { environments } = useProjectStore();
  const flows = useReferencableFlows(projectId, flowId);
  const [result, setResult] = useNodeEvidence(projectId, flowId, node.id, "subflow", evidence);
  const [running, run] = useSingleStep(projectId, flowId, node, variables, "subflow", setResult);

  const options = useMemo(() => variableOptions({
    nodes, edges, nodeId: node.id, variables,
    environment: environments.find((item) => item.id === environmentId),
  }), [nodes, edges, node.id, variables, environments, environmentId]);

  const output = result?.output as { flowName?: string; successCount?: number; failedCount?: number; skippedCount?: number } | undefined;

  return <Drawer title={t("flows.nodeTitle")} open onClose={onClose} width={760} extra={<DrawerActions running={running} onRun={() => void run()} onDelete={onDelete} />}>
    <NodeHeader node={node} placeholder={t("flows.subflowNodeNamePlaceholder")} onChange={onChange} />
    <FlowReferenceFields node={node} flows={flows} options={options} onChange={onChange} />

    {result && <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <RunStatusTag status={toRunStatus(result.status)} />
        <span className="mono muted">{result.durationMs.toFixed(1)} ms</span>
        <span className="mono muted">{t("flows.stepSummary", { success: output?.successCount ?? 0, total: (output?.successCount ?? 0) + (output?.failedCount ?? 0) + (output?.skippedCount ?? 0) })}</span>
        <span className="filter-spacer" />
        <button className="btn btn-small" onClick={() => setResult(undefined)}>{t("action.close")}</button>
      </div>
      <div className="panel-body">
        {result.error && <pre className="mono script-error">{result.error}</pre>}
        {/* 内层每一步都有证据行：一次失败的子流程要能看出是里面哪一步失败。 */}
        <NestedStepList projectId={projectId} parentStepId={result.id} />
      </div>
    </section>}
  </Drawer>;
}

/**
 * 循环节点是**画布上的容器** (P2-6 修订)。
 *
 * 添加循环后可以直接往里加步骤，画布上它框住这些步骤；体内步骤可以是任意节点，
 * 包括子流程节点（「循环内引用子流程」由此成立）。循环自身的并发与请求步骤自身的
 * 并发正交——请求并发是「一个请求跑 N 次并发」，循环并发是「N 次迭代在飞」。
 *
 * 抽屉里除了循环设置，还列着体内的步骤：点开某个步骤继续编辑（打开那个步骤自己的
 * 抽屉），从选择器把新步骤加进循环。
 */
export function LoopNodeDrawer({ projectId, flowId, node, nodes, edges, variables, environmentId, evidence, onChange, onClose, onDelete }: AdvancedProps<LoopFlowNode>) {
  const { t } = useTranslation();
  const { environments } = useProjectStore();
  /* 迭代数与循环并发的上限都由服务端说（MAX_LOOP_ITERATIONS / MAX_LOOP_CONCURRENCY）。
     注意循环并发**不受**令牌预算约束：迭代互相独立，池子紧张时分批跑完，结论不变。 */
  const maxIterations = useLimitsStore((state) => state.limits.maxLoopIterations);
  const maxLoopConcurrency = useLimitsStore((state) => state.limits.maxLoopConcurrency);
  const [result, setResult] = useNodeEvidence(projectId, flowId, node.id, "loop", evidence);
  const [running, run] = useSingleStep(projectId, flowId, node, variables, "loop", setResult);

  const options = useMemo(() => variableOptions({
    nodes, edges, nodeId: node.id, variables,
    environment: environments.find((item) => item.id === environmentId),
  }), [nodes, edges, node.id, variables, environments, environmentId]);

  const output = result?.output as {
    mode?: string; total?: number; successCount?: number; failedCount?: number;
    iterations?: { index: number; item?: string; status: string; durationMs: number; error?: string }[];
  } | undefined;

  const bodySteps = node.body?.nodes ?? [];

  return <Drawer title={t("flows.nodeTitle")} open onClose={onClose} width={760} extra={<DrawerActions running={running} onRun={() => void run()} onDelete={onDelete} />}>
    <NodeHeader node={node} placeholder={t("flows.loopNodeNamePlaceholder")} onChange={onChange} />

    <div className="form-grid" style={{ marginTop: 12 }}>
      <label className="field">
        <span>{t("flows.loopMode")}</span>
        <Select
          value={node.mode}
          onChange={(mode) => onChange({
            ...node, mode,
            /* 只保留当前模式读取的字段，避免切换后留下一个校验会抱怨的旧值。 */
            count: mode === "count" ? node.count ?? 1 : undefined,
            listVariable: mode === "list" ? node.listVariable ?? "" : undefined,
            itemVariable: mode === "list" ? node.itemVariable || "item" : undefined,
          })}
          options={[{ value: "count", label: t("flows.loopModeCount") }, { value: "list", label: t("flows.loopModeList") }]}
          style={{ width: "100%" }}
        />
      </label>
      {node.mode === "count"
        ? <label className="field">
            <span>{t("flows.loopCount")}</span>
            <input
              className="input mono" type="number" min={1} max={maxIterations}
              value={node.count ?? 1}
              onChange={(event) => onChange({ ...node, count: Math.min(maxIterations, Math.max(1, Math.trunc(Number(event.target.value)) || 1)) })}
            />
          </label>
        : <label className="field">
            <span>{t("flows.loopListVariable")}</span>
            <VariableField
              value={node.listVariable ?? ""}
              onChange={(listVariable) => onChange({ ...node, listVariable })}
              options={options}
              className="input mono"
              placeholder="{{orderIds}}"
              spellCheck={false}
            />
          </label>}
    </div>

    <div className="form-grid" style={{ marginTop: 12 }}>
      {node.mode === "list" && <label className="field">
        <span>{t("flows.loopItemVariable")}</span>
        <input className="input mono" value={node.itemVariable ?? ""} onChange={(event) => onChange({ ...node, itemVariable: event.target.value })} placeholder="item" />
      </label>}
      <label className="field">
        <span>{t("flows.loopIndexVariable")}</span>
        <input className="input mono" value={node.indexVariable} onChange={(event) => onChange({ ...node, indexVariable: event.target.value })} placeholder="index" />
      </label>
      <label className="field">
        <span>{t("flows.loopConcurrency")}</span>
        <input
          className="input mono" type="number" min={1} max={maxLoopConcurrency}
          value={node.concurrency ?? 1}
          onChange={(event) => onChange({ ...node, concurrency: Math.min(maxLoopConcurrency, Math.max(1, Math.trunc(Number(event.target.value)) || 1)) })}
        />
      </label>
    </div>
    <p className="form-note">{t("flows.loopNodeHint", { max: maxIterations })}</p>
    {(node.concurrency ?? 1) > 1 && <p className="form-note">{t("flows.loopConcurrencyHint")}</p>}

    {/* 体内步骤由**画布**管理：拖进框、或点框上的 + 添加，双击框内的步骤编辑它。
        这里只报数并说明入口，不再放第二套增删——两套入口迟早会给出不同的结果。 */}
    <div className="field" style={{ marginTop: 16 }}>
      <span>{t("flows.loopBodySteps")}（{bodySteps.length}/{MAX_LOOP_BODY}）</span>
      <div className="loop-body-list">
        {bodySteps.map((step, index) => <div className="loop-body-row" key={step.id}>
          <span className="mono muted">{index + 1}</span>
          <span className="flow-node-kind mono"><NodeKindIcon type={step.type} size={12} />{step.type === "request" ? "" : BODY_KIND_BADGE[step.type]}</span>
          <span className="truncate" style={{ color: "var(--ink)" }}>{step.name || `(${step.type})`}</span>
          <span className="mono muted truncate">{loopBodyStepSubtitle(step)}</span>
        </div>)}
        {!bodySteps.length && <p className="form-note">{t("flows.loopBodyEmpty")}</p>}
      </div>
      {bodySteps.length >= MAX_LOOP_BODY && <p className="form-error">{t("flows.loopBodyFull", { count: MAX_LOOP_BODY })}</p>}
      <p className="form-note">{t("flows.loopBodyCanvasHint")}</p>
    </div>

    {/* 循环出参：体内成功步骤写回的变量按迭代收集成数组。「未声明」与「空」不同：
        未声明 = 全部收集，空 = 一个都不收集。 */}
    <div className="field" style={{ marginTop: 16 }}>
      <span>{t("flows.loopOutputs")}</span>
      <Select
        value={node.outputs === undefined ? "all" : "pick"}
        onChange={(mode) => onChange({ ...node, outputs: mode === "all" ? undefined : [] })}
        options={[{ value: "all", label: t("flows.outputsAll") }, { value: "pick", label: t("flows.outputsPick") }]}
        style={{ width: 240 }}
      />
      {node.outputs !== undefined && <>
        {(node.outputs ?? []).map((name, index) => <div className="extract-row" key={index} style={{ marginTop: 6 }}>
          <div className="extract-fields">
            <input
              className="input mono"
              value={name}
              onChange={(event) => onChange({ ...node, outputs: (node.outputs ?? []).map((item, at) => at === index ? event.target.value : item) })}
              placeholder="orderId"
              aria-label={t("flows.subflowOutputName")}
            />
            <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => onChange({ ...node, outputs: (node.outputs ?? []).filter((_, at) => at !== index) })} />
          </div>
        </div>)}
        <button className="btn btn-with-icon" style={{ marginTop: 6 }} onClick={() => onChange({ ...node, outputs: [...(node.outputs ?? []), ""] })}>
          <Plus size={14} />{t("flows.addOutput")}
        </button>
      </>}
      <p className="form-note">{node.outputs === undefined ? t("flows.loopOutputsAllHint") : t("flows.outputsPickHint")}</p>
    </div>

    {result && <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <RunStatusTag status={toRunStatus(result.status)} />
        <span className="mono muted">{result.durationMs.toFixed(1)} ms</span>
        <span className="mono muted">{t("flows.loopIterationSummary", { success: output?.successCount ?? 0, total: output?.total ?? 0 })}</span>
        <span className="filter-spacer" />
        <button className="btn btn-small" onClick={() => setResult(undefined)}>{t("action.close")}</button>
      </div>
      <div className="panel-body">
        {result.error && <pre className="mono script-error">{result.error}</pre>}
        {/* 每次迭代一行结论，展开是那次迭代内部的步骤——「第 3 次失败」要能追到
            是里面哪个请求失败。 */}
        <NestedStepList projectId={projectId} parentStepId={result.id} iterations={output?.iterations} />
      </div>
    </section>}
  </Drawer>;
}
