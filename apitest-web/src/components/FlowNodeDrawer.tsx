import { useEffect, useMemo, useState } from "react";
import { Drawer, Modal, Select, message } from "antd";
import Editor from "@monaco-editor/react";
import { useTranslation } from "react-i18next";
import { Braces, Crosshair, GitBranch, Play, Plus, Trash2 } from "lucide-react";
import { api, noRunnerLabel, type Assertion, type AssertionResult, type ConditionFlowNode, type DatabaseFlowNode, type DataSource, type DataSourceType, type Execution, type ExecutionStep, type FlowEdge, type FlowExtract, type FlowExtractResult, type FlowNode, type FlowStepResult, type RequestFlowNode, type Script, type ScriptFlowNode, type SqlDefinition, type TestCaseSummary } from "../api";
import { defaultOperationText, formatOperation, operationLabelFromText, operationTemplates } from "../operationTemplates";
import { variableOptions } from "../lib/flowVariables";
import { useDebounced } from "../hooks/useDebounced";
import { useCanWrite } from "../hooks/useMyRole";
import { useLimitsStore } from "../stores/limitsStore";
import { useProjectStore } from "../stores/projectStore";
import { AssertionEditor, ScriptChecks } from "./AssertionEditor";
import { ExecutionDetail } from "./ExecutionSnapshot";
import { HeaderPicker } from "./HeaderPicker";
import { IconButton } from "./IconButton";
import { JsonPathPicker } from "./JsonPathPicker";
import { KeyValueEditor, fromPairs, toPairs, type Pair } from "./KeyValueEditor";
import { NestedStepList } from "./NestedStepList";
import { PreRequestHookEditor } from "./PreRequestHookEditor";
import { RunStatusTag } from "./RunStatusTag";
import { VariableField } from "./VariableField";
import { toRunStatus } from "../ui";
import { useThemeMode } from "../theme";
import { DatabaseResult } from "./DatabaseResult";
import { ScriptCodeEditor } from "./ScriptCodeEditor";
import { ResponseScriptEditor } from "./ResponseScriptEditor";
import { LoopNodeDrawer, SubflowNodeDrawer, WaitNodeDrawer } from "./FlowAdvancedNodeDrawers";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BODY_TYPES = ["none", "json", "form", "text"] as const;
const EXTRACT_SOURCES: FlowExtract["from"][] = ["body", "header", "status"];
const CONDITION_OPERATORS: ConditionFlowNode["condition"]["rules"][number]["operator"][] = ["equals", "notEquals", "contains", "exists", "notExists", "greaterThan", "lessThan"];

type Tab = "request" | "hooks" | "post" | "assertions";
type SourceKind = "endpoint" | "case";

/**
 * 节点抽屉右上角的操作区（单步调试 + 删除节点），五个节点类型的抽屉共用。
 * viewer 不渲染（P6-4）：调试是一次执行、删除是一次写，都不属于只读角色。
 */
function NodeDrawerActions({ running, onRun, onDelete }: { running: boolean; onRun: () => void; onDelete: () => void }) {
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

/**
 * Node configuration (P1-2, extended P2-2).
 *
 * A drawer rather than a side panel: the canvas is the primary surface and
 * needs its full width to show how steps connect, while a node is edited one at
 * a time. The tabs mirror the endpoint workbench — 请求 describes what to send,
 * 校验 what the answer must satisfy — with 提取 between them, because extracting
 * is the only thing that makes the *next* step possible.
 */
export type FlowNodeDrawerProps = {
  projectId: string;
  flowId: string;
  node?: FlowNode;
  /** The whole graph, so the variable picker can offer upstream output. */
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Seed variables, passed to a single-step debug in place of upstream output. */
  variables: Record<string, string>;
  /** The flow's environment, so the picker lists the values a run would see. */
  environmentId?: string;
  /** Evidence from the run currently restored by `?run=`, if one is open. */
  evidence?: FlowStepResult;
  onChange: (node: FlowNode) => void;
  onClose: () => void;
  onDelete: () => void;
};

export function FlowNodeDrawer(props: FlowNodeDrawerProps) {
  const { node, ...rest } = props;
  if (!node) return null;
  if (node.type === "database") return <DatabaseNodeDrawer {...rest} node={node} />;
  if (node.type === "script") return <ScriptNodeDrawer {...rest} node={node} />;
  if (node.type === "condition") return <ConditionNodeDrawer {...rest} node={node} />;
  /* P2-6 kinds live in their own file: this one is already long, and the three
     advanced editors share a reference/inputs/outputs form the others do not. */
  if (node.type === "wait") return <WaitNodeDrawer {...rest} node={node} />;
  if (node.type === "subflow") return <SubflowNodeDrawer {...rest} node={node} />;
  if (node.type === "loop") return <LoopNodeDrawer {...rest} node={node} />;
  return <RequestNodeDrawer {...rest} node={node} />;
}

function RequestNodeDrawer({ projectId, flowId, node, nodes, edges, variables, environmentId, evidence, onChange, onClose, onDelete }: Omit<FlowNodeDrawerProps, "node"> & { node: RequestFlowNode }) {
  const { t } = useTranslation();
  const { endpoints, environments } = useProjectStore();
  /* viewer：证据区的「重跑」也不给（P6-4）——那是一次执行。 */
  const canWrite = useCanWrite();
  /* 请求并发的上限 = 一次执行的叶子令牌预算（服务端 FLOW_PARALLELISM，P2-4.2）。 */
  const concurrencyMax = useLimitsStore((state) => state.limits.flowParallelism);
  const [tab, setTab] = useState<Tab>("request");
  const [bodyText, setBodyText] = useState("");
  const [bodyError, setBodyError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Execution>();
  /** 并发请求的容器步骤证据（N 条 HTTP 记录挂在它下面）。 */
  const [concurrent, setConcurrent] = useState<ExecutionStep>();
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [sourceKind, setSourceKind] = useState<SourceKind>("endpoint");
  const [cases, setCases] = useState<TestCaseSummary[]>([]);
  /** 用例下拉的搜索词。列表是分页的，所以筛选只能发生在服务端。 */
  const [caseKeyword, setCaseKeyword] = useState("");
  const debouncedCaseKeyword = useDebounced(caseKeyword);
  const [pickBody, setPickBody] = useState<number>();
  const [pickHeader, setPickHeader] = useState<number>();
  /**
   * Params are held as ordered rows, not as the node's record.
   *
   * A blank row added by the user has no key yet, and a record cannot hold it —
   * converting on every keystroke would delete the row the moment it appeared.
   */
  const [query, setQuery] = useState<Pair[]>([]);
  const [path, setPath] = useState<Pair[]>([]);
  const [headers, setHeaders] = useState<Pair[]>([]);

  /* The body is edited as text and parsed on the way out, so an in-progress
     edit is never thrown away by a failed JSON.parse mid-keystroke. */
  useEffect(() => {
    if (!node) return;
    setTab("request");
    setBodyError(undefined);
    setResult(undefined);
    setBodyText(node.request.bodyType === "json"
      ? node.request.body === undefined ? "" : JSON.stringify(node.request.body, null, 2)
      : node.request.bodyText ?? "");
    setQuery(toPairs(node.request.queryParams));
    setPath(toPairs(node.request.pathParams));
    setHeaders(toPairs(node.request.headers));
    /* A saved case-backed node should reopen as a case source, not fall back to
       the endpoint selector just because the drawer was closed. */
    setSourceKind(node.sourceCaseId ? "case" : "endpoint");
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The node's latest run, whichever produced it.
   *
   * Deliberately not restricted to单步调试: right after running the whole flow,
   * the newest evidence for this step is its flow run, and showing the older
   * debug instead makes the drawer look stale exactly when it matters most.
   */
  useEffect(() => {
    if (!node) return;
    const restored = asHttpExecution(evidence);
    if (restored) { setResult(restored); setLoadingRuns(false); return; }
    setLoadingRuns(true);
    void api.flowNodeExecutions(projectId, flowId, node.id)
      .then((runs) => setResult(asHttpExecution(runs[0])))
      .catch(() => { /* a node that has never run has nothing to show */ })
      .finally(() => setLoadingRuns(false));
  }, [projectId, flowId, node?.id, evidence]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Cases are loaded once the user asks for them: most nodes are seeded from an
   * endpoint, and this is a second request per project otherwise.
   *
   * The list is paged server-side (P2-4), so the dropdown shows the first page
   * and narrows by re-querying — a client-side filter would only ever search the
   * page already loaded, which reads as「我的用例不见了」on a large project.
   */
  useEffect(() => {
    if (sourceKind !== "case") return;
    void api.projectCases(projectId, { keyword: debouncedCaseKeyword, pageSize: 50 })
      .then((page) => setCases(page.items))
      .catch(() => message.error(t("flows.sourceFailed")));
  }, [sourceKind, projectId, debouncedCaseKeyword]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = useMemo(
    () => variableOptions({
      nodes, edges, nodeId: node?.id, variables,
      environment: environments.find((item) => item.id === environmentId),
    }),
    [nodes, edges, node?.id, variables, environments, environmentId],
  );

  const current = node;

  function patchRequest(patch: Partial<RequestFlowNode["request"]>) {
    onChange({ ...current, request: { ...current.request, ...patch } });
  }

  function editBody(text: string) {
    setBodyText(text);
    if (current.request.bodyType === "json") {
      if (!text.trim()) { patchRequest({ body: undefined }); setBodyError(undefined); return; }
      try { patchRequest({ body: JSON.parse(text) }); setBodyError(undefined); }
      catch (error) { setBodyError(error instanceof Error ? error.message : "invalid JSON"); }
    } else {
      patchRequest({ bodyText: text });
    }
  }

  /**
   * Replaces the node's snapshot from an endpoint or a case.
   *
   * Resolved server-side so the snapshot rule lives in one place. A case brings
   * its assertions along — a step built from a case that silently dropped its
   * checks would look identical and verify nothing.
   */
  async function seedFrom(source: { endpointId?: string; caseId?: string }) {
    try {
      const seed = await api.flowNodeSource(projectId, source);
      onChange({
        ...current,
        endpointId: seed.endpointId,
        sourceCaseId: seed.sourceCaseId,
        sourceCaseName: seed.sourceCaseName,
        /* An untouched node takes the source's name; a renamed one keeps its own,
           because the name is what identifies the step on the canvas. */
        name: current.name.trim() ? current.name : seed.name,
        request: seed.request,
        /* Existing checks are kept when seeding from a bare endpoint (it has
           none to give) and replaced when seeding from a case. */
        assertions: source.caseId ? seed.assertions : current.assertions,
        preRequestHooks: source.caseId ? seed.preRequestHooks : current.preRequestHooks,
        extracts: source.caseId ? seed.extracts : current.extracts,
        responseScripts: source.caseId ? seed.responseScripts : current.responseScripts,
      });
      setBodyText(seed.request.bodyType === "json"
        ? seed.request.body === undefined ? "" : JSON.stringify(seed.request.body, null, 2)
        : seed.request.bodyText ?? "");
      setQuery(toPairs(seed.request.queryParams));
      setPath(toPairs(seed.request.pathParams));
      setHeaders(toPairs(seed.request.headers));
    } catch { message.error(t("flows.sourceFailed")); }
  }

  function setExtract(index: number, patch: Partial<FlowExtract>) {
    onChange({ ...current, extracts: current.extracts.map((item, at) => (at === index ? { ...item, ...patch } : item)) });
  }

  /** Adds one extract per picked path, named after the last path segment. */
  function addExtracts(from: FlowExtract["from"], picked: string[], replaceAt?: number) {
    const made = picked.map((value) => ({ name: suggestName(value), from, path: value }));
    onChange({
      ...current,
      extracts: replaceAt === undefined
        ? [...current.extracts, ...made]
        : current.extracts.map((item, at) => (at === replaceAt ? { ...made[0], name: item.name.trim() || made[0].name } : item)).concat(made.slice(1)),
    });
  }

  /**
   * 单步调试.
   *
   * Runs this node alone against the seed variables, so a step can be checked
   * without running everything before it. What it cannot do is prove the chain:
   * values a previous step would have produced have to be supplied by hand,
   * which is exactly what the variables panel is for.
   */
  async function runNode() {
    setRunning(true);
    try {
      const queuedResult = await api.executeFlowNode(projectId, flowId, current, variables);
      /* 并发请求是容器语义：一次调试发 N 个请求，服务端返回容器步骤（下面挂 N 条
         HTTP 证据），而不是一条执行记录——所以这里按并发与否分开取结果。 */
      if ((current.concurrency ?? 1) > 1) {
        const step = asGenericStep(queuedResult, "request");
        if (!step) throw new Error(t("flows.nodeResultUnavailable"));
        setConcurrent(step);
        setResult(undefined);
        return;
      }
      const queued = asHttpExecution(queuedResult);
      if (!queued) throw new Error(t("flows.nodeResultUnavailable"));
      /* Polled rather than streamed: this drawer is short-lived, and the poll
         window outlasts the 30s transport cap rather than giving up early. */
      let settled = queued;
      for (let attempt = 0; attempt < 120 && (settled.status === "queued" || settled.status === "running"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        settled = await api.execution(projectId, queued.id);
      }
      setConcurrent(undefined);
      setResult(settled);
      } catch (error) {
        /* 2004 = 这个分区没有在线执行器（P2-8 边界 5）；节点本身没问题。 */
        const label = noRunnerLabel(error);
        const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
        const local = error instanceof Error ? error.message : undefined;
        message.error(label !== undefined ? t("run.noRunner", { label })
          : detail?.includes("queue unavailable") ? t("run.queueUnavailable") : detail ?? local ?? t("flows.nodeRunFailed"));
    } finally { setRunning(false); }
  }

  const tabs: [Tab, string, number][] = [
    ["request", t("flows.tabRequest"), 0],
    /* Between 请求 and 提取 because that is when it runs: after the request is
       built, before it is sent. */
    ["hooks", t("flows.tabHooks"), (current.preRequestHooks ?? []).length],
    ["post", t("flows.tabPost"), current.extracts.length + (current.responseScripts ?? []).length],
    ["assertions", t("flows.tabAssertions"), current.assertions.length],
  ];
  /* Only results for *this* node, so a stale run from another step never gets
     read as evidence about this one. */
  const mine = result?.flowNodeId === current.id ? result : undefined;
  const extractResults = mine?.extractResults ?? [];

  return <>
    <Drawer
      title={t("flows.nodeTitle")}
      open
      onClose={onClose}
      width={760}
      extra={<NodeDrawerActions running={running} onRun={() => void runNode()} onDelete={onDelete} />}
    >
      <div className="form-grid">
        <label className="field">
          <span>{t("flows.nodeName")}</span>
          <input className="input" value={current.name} onChange={(event) => onChange({ ...current, name: event.target.value })} placeholder={t("flows.nodeNamePlaceholder")} />
        </label>
        <div className="field">
          <span>{t("flows.nodeSource")}</span>
          <div className="flow-source">
            {/* A step is usually closer to an existing case than to a bare
                endpoint, so both are first-class sources. */}
            <Select
              value={sourceKind}
              onChange={(kind) => setSourceKind(kind)}
              options={[{ value: "endpoint", label: t("flows.sourceEndpoint") }, { value: "case", label: t("flows.sourceCase") }]}
              style={{ width: 110 }}
            />
            {sourceKind === "endpoint"
              ? <Select
                  value={current.endpointId || undefined}
                  onChange={(endpointId) => void seedFrom({ endpointId })}
                  options={[
                    /* The bound endpoint can be absent from the store list —
                       created out-of-band (MCP tool) after this page loaded, or
                       deleted after the flow was saved. Same fallback as the
                       case source below: a readable option instead of antd
                       rendering the bare uuid as the value. */
                    ...(current.endpointId && !endpoints.some((item) => item.id === current.endpointId)
                      ? [{ value: current.endpointId, label: `${current.request.method}  ${current.name}` }]
                      : []),
                    ...endpoints.map((item) => ({ value: item.id, label: `${item.method}  ${item.name}` })),
                  ]}
                  placeholder={t("flows.pickEndpoint")}
                  showSearch optionFilterProp="label" style={{ flex: 1 }}
                />
              : <Select
                  value={current.sourceCaseId}
                  onChange={(caseId) => void seedFrom({ caseId })}
                  options={[
                    /* The case can have been deleted after the flow was saved.
                       Keep its snapshotted name visible instead of showing an
                       empty control that looks like the node lost its source. */
                    ...(current.sourceCaseId && !cases.some((item) => item.id === current.sourceCaseId)
                      ? [{ value: current.sourceCaseId, label: current.sourceCaseName ?? current.sourceCaseId }]
                      : []),
                    ...cases.map((item) => ({ value: item.id, label: `${item.name}  ·  ${item.endpointName}` })),
                  ]}
                  placeholder={t("flows.pickCase")}
                  /* 搜索走服务端（列表分页）：`filterOption={false}` 关掉 antd 的本地
                     过滤，否则它会在「服务端刚返回的这一页」里再筛一遍，把命中的结果
                     又藏掉。搜索框本身保持非受控，只把词捞出来发查询；收起时清空，
                     免得下次打开还停在上一次的筛选结果上。 */
                  showSearch filterOption={false} onSearch={setCaseKeyword}
                  onDropdownVisibleChange={(open) => { if (!open) setCaseKeyword(""); }}
                  style={{ flex: 1 }}
                />}
          </div>
        </div>
      </div>
      {/* Says plainly that picking a source copies it, so nobody expects a later
          endpoint or case edit to reach a flow already built. */}
      <p className="form-note">{t("flows.snapshotNote")}</p>

      <label className="field" style={{ marginTop: 12 }}>
        <span>{t("flows.onFailure")}</span>
        <Select
          value={current.onFailure}
          onChange={(onFailure) => onChange({ ...current, onFailure })}
          options={[{ value: "stop", label: t("flows.failureStop") }, { value: "continue", label: t("flows.failureContinue") }]}
          style={{ width: 240 }}
        />
      </label>

      {/* P2-6: 请求并发。这个请求自己跑 N 次并发，提取按迭代序收集成数组——
          并发只属于请求，所以只在请求抽屉里有这个字段。
          上限由服务端说（P2-4.2）：N 枚令牌是一次凑齐的，所以「一次执行的并发预算」
          就是这里的上限，而它是环境变量，写死必然与服务端不一致。 */}
      <label className="field" style={{ marginTop: 12 }}>
        <span>{t("flows.requestConcurrency")}</span>
        <div className="form-grid" style={{ gridTemplateColumns: "120px 1fr", alignItems: "end", gap: 8 }}>
          <input
            className="input mono" type="number" min={1} max={concurrencyMax}
            value={current.concurrency ?? 1}
            onChange={(event) => onChange({ ...current, concurrency: Math.min(concurrencyMax, Math.max(1, Math.trunc(Number(event.target.value)) || 1)) })}
            aria-label={t("flows.requestConcurrency")}
          />
          <span className="form-note" style={{ margin: 0 }}>{t("flows.requestConcurrencyHint", { max: concurrencyMax })}</span>
        </div>
      </label>

      <div className="tabs" role="tablist" style={{ paddingInline: 0, marginTop: 16 }}>
        {tabs.map(([key, label, count]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={`tab${tab === key ? " is-active" : ""}`} onClick={() => setTab(key)}>
            {label}{count > 0 && <span className="tab-count mono">{count}</span>}
          </button>
        ))}
      </div>

      {tab === "request" && <div style={{ marginTop: 12 }}>
        <div className="request-line">
          <Select value={current.request.method} onChange={(method) => patchRequest({ method })} options={METHODS.map((value) => ({ value }))} style={{ width: 104 }} />
          <VariableField
            value={current.request.url}
            onChange={(url) => patchRequest({ url })}
            options={options}
            className="input mono request-url"
            placeholder="https://api.example.com/orders/:id"
            spellCheck={false}
            aria-label={t("endpoints.url")}
          />
        </div>
        <KeyValueEditor pairs={query} onChange={(pairs) => { setQuery(pairs); patchRequest({ queryParams: fromPairs(pairs) }); }} keyPlaceholder="page" valuePlaceholder="1" title={t("editor.queryParams")} variableOptions={options} />
        <KeyValueEditor pairs={path} onChange={(pairs) => { setPath(pairs); patchRequest({ pathParams: fromPairs(pairs) }); }} keyPlaceholder="id" valuePlaceholder="{{orderId}}" title={t("editor.pathParams")} variableOptions={options} />
        <KeyValueEditor pairs={headers} onChange={(pairs) => { setHeaders(pairs); patchRequest({ headers: fromPairs(pairs) }); }} keyPlaceholder="Authorization" valuePlaceholder="Bearer {{token}}" title={t("editor.headers")} variableOptions={options} />
        <Select
          value={current.request.bodyType}
          onChange={(bodyType) => { patchRequest({ bodyType }); setBodyError(undefined); }}
          options={BODY_TYPES.map((value) => ({ value, label: t(`editor.bodyType.${value}`) }))}
          style={{ width: 200, marginTop: 16 }}
        />
        {current.request.bodyType !== "none" && <>
          {/* `{{` in a body opens the same completion list as the URL does. */}
          <VariableField
            value={bodyText}
            onChange={(text) => editBody(text)}
            options={options}
            multiline
            rows={8}
            className="input mono body-editor"
            spellCheck={false}
          />
          {bodyError && <p className="form-error">{t("editor.invalidJson", { message: bodyError })}</p>}
        </>}
      </div>}

      {tab === "hooks" && <div style={{ marginTop: 12 }}>
        <PreRequestHookEditor
          projectId={projectId}
          hooks={current.preRequestHooks ?? []}
          onChange={(preRequestHooks) => onChange({ ...current, preRequestHooks })}
          results={mine?.hookResults}
          environmentId={environmentId}
          variables={variables}
        />
      </div>}

      {tab === "post" && <div style={{ marginTop: 12 }}>
        <h3 className="subhead">{t("flows.simpleExtracts")}</h3>
        {/* The only channel between steps, so it says what it is for. */}
        <p className="form-note">{t("flows.extractsHint")}</p>
        {current.extracts.map((extract, index) => {
          /* Matched by name: the result carries the name it was declared with,
             which survives a row being reordered between runs. */
          const outcome = extractResults.find((item) => item.name === extract.name);
          return <div key={index} className="extract-row">
            <div className="extract-fields">
              <input
                className="input mono"
                value={extract.name}
                onChange={(event) => setExtract(index, { name: event.target.value })}
                placeholder="token"
                aria-label={t("flows.extractName")}
              />
              <Select
                value={extract.from}
                onChange={(from) => setExtract(index, { from })}
                options={EXTRACT_SOURCES.map((value) => ({ value, label: t(`flows.extractFrom.${value}`) }))}
                style={{ width: 120 }}
              />
              {extract.from === "status"
                ? <span className="assertion-fixed muted">—</span>
                : <input
                    className="input mono"
                    value={extract.path ?? ""}
                    onChange={(event) => setExtract(index, { path: event.target.value })}
                    placeholder={extract.from === "body" ? "$.data.token" : "x-request-id"}
                    aria-label={t("flows.extractPath")}
                  />}
              {/* Quick pick reads the response on screen, so a chosen path always
                  resolves against a body the user has actually seen. */}
              {extract.from !== "status" && <IconButton
                icon={<Crosshair size={14} />}
                label={t("assertions.pick")}
                disabled={!mine}
                onClick={() => (extract.from === "body" ? setPickBody(index) : setPickHeader(index))}
              />}
              <IconButton
                icon={<Trash2 size={14} />}
                label={t("action.delete")}
                tone="danger"
                onClick={() => onChange({ ...current, extracts: current.extracts.filter((_, at) => at !== index) })}
              />
            </div>
            {/* Per-extract verdict, next to the rule that produced it: "could not
                extract" alone leaves three very different causes indistinguishable. */}
            {outcome && <p className={outcome.ok ? "extract-verdict is-ok mono" : "extract-verdict is-fail mono"}>
              {outcome.ok ? `= ${outcome.value}` : outcome.reason}
            </p>}
          </div>;
        })}
        <button className="btn btn-with-icon" style={{ marginTop: 8 }} onClick={() => onChange({ ...current, extracts: [...current.extracts, { name: "", from: "body", path: "" }] })}>
          <Plus size={14} />{t("flows.addExtract")}
        </button>
        {/* Bulk "pick from response" used to sit here as a second button doing
            the same job as the per-row picker, one column to the left. One way
            to do it: add a row, then pick into that row. */}
        {!mine && <p className="form-note">{t("flows.quickExtractNeedsRun")}</p>}
        <h3 className="subhead" style={{ marginTop: 20 }}>{t("responseScripts.title")}</h3>
        <ResponseScriptEditor
          projectId={projectId}
          scripts={current.responseScripts ?? []}
          onChange={(responseScripts) => onChange({ ...current, responseScripts })}
          results={mine?.responseScriptResults}
          response={{ statusCode: mine?.statusCode, headers: mine?.responseHeaders, body: mine?.responseBody }}
          environmentId={environmentId}
          variables={variables}
        />
      </div>}

      {tab === "assertions" && <div style={{ marginTop: 12 }}>
        <AssertionEditor
          projectId={projectId}
          assertions={current.assertions}
          onChange={(assertions: Assertion[]) => onChange({ ...current, assertions })}
          results={mine?.assertionResults}
          responseBody={mine?.responseBody}
          responseHeaders={mine?.responseHeaders}
          responseStatusCode={mine?.statusCode}
          /* A script assertion reads ctx.variables, so its try-run needs the
             same environment and seed bag the hook editor already gets. */
          environmentId={environmentId}
          variables={variables}
        />
      </div>}

      {/* The latest run sits under the tabs rather than replacing them, so the
          rule that failed stays visible next to the response. Rendered inline
          rather than in a second drawer: stacking one over the other would bury
          the node being debugged. */}
      {loadingRuns && !mine && <p className="muted" style={{ marginTop: 16 }}>{t("common.loading")}</p>}
      {/* 并发请求的调试结果：一行总结 + N 条子请求证据，点开某条看它自己的
          请求/响应快照。单条请求的结果仍走下面的 ExecutionDetail。 */}
      {concurrent && <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <RunStatusTag status={toRunStatus(concurrent.status)} />
          <span className="mono muted">{t("flows.concurrentSummary", {
            success: Number((concurrent.output as { successCount?: number })?.successCount ?? 0),
            total: Number((concurrent.output as { total?: number })?.total ?? 0),
          })}</span>
          <span className="mono muted">{concurrent.durationMs.toFixed(1)} ms</span>
          <span className="filter-spacer" />
          <button className="btn btn-small" onClick={() => setConcurrent(undefined)}>{t("action.close")}</button>
        </div>
        <div className="panel-body">
          {concurrent.error && <pre className="mono script-error">{concurrent.error}</pre>}
          <NestedStepList projectId={projectId} parentStepId={concurrent.id} />
        </div>
      </section>}
      {mine && !concurrent && <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <RunStatusTag status={toRunStatus(mine.status)} />
          {/* Names where this evidence came from: a flow run and a single-step
              debug are both legitimate, and which one is on screen matters. */}
          <span className="mono muted">{mine.flowExecutionId ? t("flows.fromFlowRun") : t("flows.fromNodeRun")}</span>
          <span className="mono muted">{new Date(mine.createdAt).toLocaleString()}</span>
          <span className="filter-spacer" />
          <button className="btn btn-small" onClick={() => setResult(undefined)}>{t("action.close")}</button>
        </div>
        <div className="panel-body">
          <ExecutionDetail result={mine} onRerun={canWrite ? () => void runNode() : undefined} busy={running} />
        </div>
      </section>}
    </Drawer>

    <JsonPathPicker
      open={pickBody !== undefined}
      body={mine?.responseBody}
      onClose={() => setPickBody(undefined)}
      onPick={(paths) => addExtracts("body", paths, pickBody)}
    />
    <HeaderPicker
      open={pickHeader !== undefined}
      headers={mine?.responseHeaders}
      onClose={() => setPickHeader(undefined)}
      onPick={(names) => addExtracts("header", names, pickHeader)}
    />
  </>;
}

type DatabaseTab = "database" | "assertions" | "extracts";

function DatabaseNodeDrawer({ projectId, flowId, node, nodes, edges, variables, environmentId, evidence, onChange, onClose, onDelete }: Omit<FlowNodeDrawerProps, "node"> & { node: DatabaseFlowNode }) {
  const { t } = useTranslation();
  const mode = useThemeMode();
  const { environments } = useProjectStore();
  const [tab, setTab] = useState<DatabaseTab>("database");
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [definitions, setDefinitions] = useState<SqlDefinition[]>([]);
  const [parameters, setParameters] = useState<Pair[]>([]);
  const [operationText, setOperationText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecutionStep>();
  const [pickExtract, setPickExtract] = useState<number>();

  const selectedSource = dataSources.find((item) => item.id === node.dataSourceId);
  const isOperationSource = selectedSource?.type === "mongodb" || selectedSource?.type === "redis";

  useEffect(() => {
    setTab("database");
    setResult(undefined);
    setParameters(toUnknownPairs(node.parameters));
  }, [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 操作编辑器的文本是本地状态，不是节点数据，但它的默认模板取决于数据源类型——
     而数据源是下面那个 effect 异步拉回来的。所以这里必须把 isOperationSource 也列进
     依赖：只在 node.id 变化时算一次的话，首次打开时 dataSources 还是空数组，
     isOperationSource 还是 false，mongo/redis 节点就会开在一个空编辑器上。
     打字不会触发重算（node.operation 不在依赖里），所以不会和输入抢状态。 */
  useEffect(() => {
    if (node.operation) { setOperationText(formatOperation(node.operation)); return; }
    setOperationText(isOperationSource ? defaultOperationText(selectedSource?.type) : "");
  }, [node.id, isOperationSource, selectedSource?.type]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void api.dataSources(projectId).then(setDataSources).catch(() => message.error(t("dataSources.loadFailed")));
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!node.dataSourceId) { setDefinitions([]); return; }
    void api.sqlDefinitions(projectId, node.dataSourceId).then(setDefinitions).catch(() => setDefinitions([]));
  }, [projectId, node.dataSourceId]);

  useEffect(() => {
    setResult(undefined);
    const restored = asDatabaseStep(evidence);
    if (restored) { setResult(restored); return; }
    void api.flowNodeExecutions(projectId, flowId, node.id)
      .then((runs) => setResult(asDatabaseStep(runs[0])))
      .catch(() => { /* a new node has no evidence */ });
  }, [projectId, flowId, node.id, evidence]);

  const variableChoices = useMemo(() => variableOptions({
    nodes, edges, nodeId: node.id, variables,
    environment: environments.find((item) => item.id === environmentId),
  }), [nodes, edges, node.id, variables, environments, environmentId]);

  function change(patch: Partial<DatabaseFlowNode>) { onChange({ ...node, ...patch }); }
  function changeParameters(next: Pair[]) { setParameters(next); change({ parameters: fromUnknownPairs(next) }); }

  function defaultOperation(sourceType: DataSourceType | undefined) { return operationTemplates(sourceType)[0]?.operation; }

  function changeDataSource(dataSourceId?: string) {
    const source = dataSources.find((item) => item.id === dataSourceId);
    setParameters([]);
    if (source && (source.type === "mongodb" || source.type === "redis")) {
      const operation = defaultOperation(source.type);
      setOperationText(formatOperation(operation));
      change({ dataSourceId, sqlDefinitionId: undefined, sql: undefined, operation });
    } else {
      setOperationText("");
      change({ dataSourceId, sqlDefinitionId: undefined, operation: undefined });
    }
  }

  async function selectDefinition(sqlDefinitionId?: string) {
    if (!sqlDefinitionId) {
      if (isOperationSource) {
        const operation = defaultOperation(selectedSource?.type);
        setOperationText(formatOperation(operation));
        change({ sqlDefinitionId: undefined, operation });
      } else {
        change({ sqlDefinitionId: undefined });
      }
      return;
    }
    const definition = definitions.find((item) => item.id === sqlDefinitionId);
    if (!definition) return;
    const nextParameters = definition.params.map((param) => ({ key: param.name, value: param.defaultValue === undefined ? "" : stringifyUnknown(param.defaultValue), enabled: true }));
    setParameters(nextParameters);
    if (definition.kind !== "sql") {
      /* 只写 sqlDefinitionId：节点不能同时带 operation——校验要求
         sqlDefinitionId / 现场 SQL / operation 三者恰好命中一个，而入队时
         (prepareFlowNodes) 本来就会回读定义里的 operation。这里的文本只是编辑器
         的本地预览状态，不是节点数据。 */
      setOperationText(formatOperation(definition.operation));
      change({ sqlDefinitionId, statementType: undefined, operation: undefined, sql: undefined, parameters: fromUnknownPairs(nextParameters) });
    } else {
      change({ sqlDefinitionId, statementType: definition.statementType, sql: undefined, operation: undefined, parameters: fromUnknownPairs(nextParameters) });
    }
  }

  function patchOperationText(text: string) {
    setOperationText(text);
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") change({ operation: parsed });
    } catch { /* keep the text until it parses; the server validates on run/save */ }
  }

  async function runNode() {
    setRunning(true);
    try {
      const next = await api.executeFlowNode(projectId, flowId, node, variables);
      const database = asDatabaseStep(next);
      if (!database) throw new Error(t("flows.nodeResultUnavailable"));
      setResult(database);
    } catch (error) {
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(detail ?? (error instanceof Error ? error.message : t("flows.nodeRunFailed")));
    } finally { setRunning(false); }
  }

  const databaseResult = databaseOutcome(result);
  const dbOutput = result?.output as { assertionResults?: AssertionResult[]; extractResults?: FlowExtractResult[]; rows?: unknown[]; rowCount?: number; truncated?: boolean } | undefined;
  const resultBody = databaseResult ? JSON.stringify({ rows: databaseResult.rows, rowCount: databaseResult.rowCount, truncated: databaseResult.truncated }) : undefined;
  const tabs: [DatabaseTab, string, number][] = [
    ["database", t("flows.tabDatabase"), Object.keys(node.parameters).length],
    ["assertions", t("flows.tabAssertions"), node.assertions.length],
    ["extracts", t("flows.tabExtracts"), node.extracts.length],
  ];

  return <>
    <Drawer title={t("flows.nodeTitle")} open onClose={onClose} width={760} extra={<NodeDrawerActions running={running} onRun={() => void runNode()} onDelete={onDelete} />}>
      <div className="form-grid">
        <label className="field"><span>{t("flows.nodeName")}</span><input className="input" value={node.name} onChange={(event) => change({ name: event.target.value })} placeholder={t("flows.databaseNodeNamePlaceholder")} /></label>
        <label className="field"><span>{t("flows.onFailure")}</span><Select value={node.onFailure} onChange={(onFailure) => change({ onFailure })} options={[{ value: "stop", label: t("flows.failureStop") }, { value: "continue", label: t("flows.failureContinue") }]} style={{ width: "100%" }} /></label>
      </div>
      <div className="tabs" role="tablist" style={{ paddingInline: 0, marginTop: 16 }}>{tabs.map(([key, label, count]) => <button key={key} role="tab" aria-selected={tab === key} className={`tab${tab === key ? " is-active" : ""}`} onClick={() => setTab(key)}>{label}{count > 0 && <span className="tab-count mono">{count}</span>}</button>)}</div>

      {tab === "database" && <div className="database-node-editor">
        <div className="form-grid">
           <label className="field"><span>{t("dataSources.title")}</span><Select value={node.dataSourceId || undefined} onChange={(dataSourceId) => changeDataSource(dataSourceId)} options={dataSources.map((item) => ({ value: item.id, label: item.name }))} placeholder={t("flows.pickDataSource")} showSearch optionFilterProp="label" style={{ width: "100%" }} /></label>
          <label className="field"><span>{isOperationSource ? t("flows.operationSource") : t("flows.sqlSource")}</span><Select value={node.sqlDefinitionId ?? "inline"} onChange={(value) => void selectDefinition(value === "inline" ? undefined : value)} options={[{ value: "inline", label: isOperationSource ? t("flows.inlineOperation") : t("flows.inlineSql") }, ...definitions.map((item) => ({ value: item.id, label: item.name }))]} style={{ width: "100%" }} /></label>
          {!node.sqlDefinitionId && !isOperationSource && <label className="field"><span>{t("dataSources.statementType")}</span><Select value={node.statementType} onChange={(statementType) => change({ statementType })} options={[{ value: "query", label: t("dataSources.query") }, { value: "command", label: t("dataSources.command") }]} style={{ width: "100%" }} /></label>}
        </div>
        {!node.sqlDefinitionId && (isOperationSource ? <div>
          <div className="section-toolbar compact"><h3 className="subhead">{t("flows.operation")}</h3><Select<string> value={operationLabelFromText(operationText)} placeholder={t("flows.opTemplate")} onChange={(label) => { const picked = operationTemplates(selectedSource?.type).find((tpl) => tpl.label === label); if (picked) patchOperationText(formatOperation(picked.operation)); }} options={operationTemplates(selectedSource?.type).map((tpl) => ({ value: tpl.label, label: tpl.label }))} style={{ width: 200 }} /></div>
          <div className="script-code sql-editor"><Editor height="220px" language="json" theme={mode === "dark" ? "vs-dark" : "light"} value={operationText} onChange={(text) => patchOperationText(text ?? "")} options={{ minimap: { enabled: false }, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", scrollBeyondLastLine: false, automaticLayout: true }} /></div>
          <p className="form-note">{t("flows.operationHint")}</p>
        </div> : <div className="script-code sql-editor"><Editor height="220px" language="sql" theme={mode === "dark" ? "vs-dark" : "light"} value={node.sql ?? ""} onChange={(sql) => change({ sql: sql ?? "" })} options={{ minimap: { enabled: false }, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", scrollBeyondLastLine: false, automaticLayout: true }} /></div>)}
        {node.sqlDefinitionId && <p className="form-note">{t("flows.namedSqlSnapshotNote")}</p>}
        <KeyValueEditor pairs={parameters} onChange={changeParameters} keyPlaceholder="userId" valuePlaceholder="{{userId}}" title={t("flows.parameterBindings")} hint={t("flows.parameterBindingsHint")} variableOptions={variableChoices} />
      </div>}

      {tab === "assertions" && <div style={{ marginTop: 12 }}><p className="form-note">{t("flows.databaseAssertionHint")}</p><AssertionEditor projectId={projectId} assertions={node.assertions} onChange={(assertions: Assertion[]) => change({ assertions })} results={dbOutput?.assertionResults} responseBody={resultBody} environmentId={environmentId} variables={variables} /></div>}

      {tab === "extracts" && <div style={{ marginTop: 12 }}>
        <p className="form-note">{t("flows.databaseExtractHint")}</p>
        {node.extracts.map((extract, index) => {
          const outcome = dbOutput?.extractResults?.find((item) => item.name === extract.name);
          return <div className="extract-row" key={index}><div className="extract-fields"><input className="input mono" value={extract.name} onChange={(event) => change({ extracts: node.extracts.map((item, at) => at === index ? { ...item, name: event.target.value } : item) })} placeholder="recordId" /><input className="input mono" value={extract.path ?? ""} onChange={(event) => change({ extracts: node.extracts.map((item, at) => at === index ? { ...item, from: "body", path: event.target.value } : item) })} placeholder="$.rows[0].id" /><IconButton icon={<Crosshair size={14} />} label={t("assertions.pick")} disabled={!resultBody} onClick={() => setPickExtract(index)} /><IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => change({ extracts: node.extracts.filter((_, at) => at !== index) })} /></div>{outcome && <p className={outcome.ok ? "extract-verdict is-ok mono" : "extract-verdict is-fail mono"}>{outcome.ok ? `= ${outcome.value}` : outcome.reason}</p>}</div>;
        })}
        <button className="btn btn-with-icon" onClick={() => change({ extracts: [...node.extracts, { name: "", from: "body", path: "" }] })}><Plus size={14} />{t("flows.addExtract")}</button>
      </div>}

      {result && <section className="panel database-step-result"><div className="panel-head"><RunStatusTag status={toRunStatus(result.status)} /><span className="mono muted">{result.durationMs.toFixed(1)} ms</span><span className="filter-spacer" /><button className="btn btn-small" onClick={() => setResult(undefined)}>{t("action.close")}</button></div><div className="panel-body"><DatabaseResult result={databaseResult} error={result.error} /></div></section>}
    </Drawer>
    <JsonPathPicker open={pickExtract !== undefined} body={resultBody} onClose={() => setPickExtract(undefined)} onPick={(paths) => { if (pickExtract === undefined) return; const made = paths.map((path) => ({ name: suggestName(path), from: "body" as const, path })); change({ extracts: node.extracts.map((item, at) => at === pickExtract ? { ...made[0], name: item.name || made[0].name } : item).concat(made.slice(1)) }); setPickExtract(undefined); }} />
  </>;
}

/** Body of a script node — the follow/copy shape an assertion or hook uses. */
export const DEFAULT_SCRIPT_NODE_TEMPLATE = `// A script node reads and writes the variable bag (P2-2).
//   ctx.variables.anyName          — read a flow/environment value
//   ctx.setVariable("name", value) — write one
//   return { name: value }         — same, as a returned object
// ctx.crypto / ctx.encoding are available; { secret: "NAME" } stays host-side.
// A thrown error or a failed ctx.assert fails this step.

return { at: ctx.variables.token ?? "none" };`;

/**
 * 脚本节点 (P2-2): user JavaScript as a computation step over the bag.
 *
 * The editor follows the same follow/copy model as a hook script: pick a 具名
 * 公共脚本, or edit an anonymous body in place. The 单步调试 button runs the
 * node alone and shows what it produced — the whole point is the variables it
 * writes back for downstream steps.
 */
function ScriptNodeDrawer({ projectId, flowId, node, variables, evidence, onChange, onClose, onDelete }: Omit<FlowNodeDrawerProps, "node"> & { node: ScriptFlowNode }) {
  const { t } = useTranslation();
  const mode = useThemeMode();
  const [publicScripts, setPublicScripts] = useState<Script[]>([]);
  const [libraries, setLibraries] = useState<Script[]>([]);
  const [resolved, setResolved] = useState<Script>();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecutionStep>();
  const [publishFor, setPublishFor] = useState(false);
  const [publishName, setPublishName] = useState("");

  useEffect(() => {
    setResult(undefined);
    const restored = asGenericStep(evidence, "script");
    if (restored) { setResult(restored); return; }
    void api.flowNodeExecutions(projectId, flowId, node.id)
      .then((runs) => setResult(asGenericStep(runs[0], "script")))
      .catch(() => { /* a new node has no evidence */ });
  }, [projectId, flowId, node.id, evidence]);

  useEffect(() => {
    void Promise.all([api.scripts(projectId, undefined, "node"), api.scripts(projectId, undefined, "library")])
      .then(([scripts, libraryScripts]) => { setPublicScripts(scripts); setLibraries(libraryScripts); })
      .catch(() => { setPublicScripts([]); setLibraries([]); message.error(t("scripts.loadFailed")); });
  }, [projectId, t]);

  /* A saved-but-unsaved-again private script carries an id from the anonymous
     scripts row; resolve it by id when it is not in the public list. */
  useEffect(() => {
    const id = node.script?.scriptId;
    if (!id || publicScripts.some((script) => script.id === id)) { setResolved(undefined); return; }
    /* While editing, local content is the source of truth and fetching the
       stored row on every keystroke would only cache a stale copy. Saving strips
       the local body back to `{ scriptId }`; `content` therefore changes from a
       string to undefined, this effect runs again, clears the old cache, and
       reloads the body the server just persisted. */
    if (node.script?.content !== undefined) return;
    setResolved(undefined);
    void api.script(projectId, id).then(setResolved).catch(() => setResolved(undefined));
  }, [projectId, node.script?.scriptId, node.script?.content, publicScripts]);

  const referenced = publicScripts.find((script) => script.id === node.script?.scriptId) ?? resolved;
  /* Public vs private is decided by the *name* — a saved private script also
     carries an id, and that id is not in the public list. */
  const following = Boolean(referenced?.name);
  /* A stored id whose body is still in flight: block the editor rather than
     overwrite the stored script, exactly as the hook editor does. */
  const resolving = Boolean(node.script?.scriptId) && !referenced && node.script?.content === undefined;
  const content = node.script?.content ?? referenced?.content ?? DEFAULT_SCRIPT_NODE_TEMPLATE;
  const dependencyIds = node.script?.dependencies ?? referenced?.dependencies ?? [];
  const selectedLibraries = dependencyIds.map((id) => libraries.find((library) => library.id === id)).filter((item): item is Script => Boolean(item));

  /* The editor used to *display* the template as a fallback without putting it
     into the flow document. Save and publish therefore received an empty ref.
     Seed the real draft once so what the user sees is what the server receives. */
  useEffect(() => {
    if (node.script?.scriptId || node.script?.content !== undefined) return;
    onChange({ ...node, script: { content: DEFAULT_SCRIPT_NODE_TEMPLATE } });
  }, [node.id, node.script?.scriptId, node.script?.content, onChange]);

  function patch(patch: Partial<ScriptFlowNode>) { onChange({ ...node, ...patch }); }

  async function runNode() {
    setRunning(true);
    try {
      const next = await api.executeFlowNode(projectId, flowId, node, variables);
      const step = asGenericStep(next, "script");
      if (!step) throw new Error(t("flows.nodeResultUnavailable"));
      setResult(step);
    } catch (error) {
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(detail ?? (error instanceof Error ? error.message : t("flows.nodeRunFailed")));
    } finally { setRunning(false); }
  }

  async function publish() {
    if (!publishName.trim()) { message.info(t("scripts.nameRequired")); return; }
    try {
      const created = await api.createScript(projectId, { name: publishName.trim(), content, kind: "node", dependencies: dependencyIds });
      setPublicScripts((current) => [...current, created].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")));
      patch({ script: { scriptId: created.id } });
      setPublishFor(false);
      setPublishName("");
      message.success(t("scripts.published"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("scripts.saveFailed"));
    }
  }

  const output = result?.output as { logs?: string[]; debug?: { label: string; value: string }[]; checks?: { label: string; passed: boolean; message?: string }[]; returned?: string; variables?: Record<string, string> } | undefined;

  return <>
    <Drawer title={t("flows.nodeTitle")} open onClose={onClose} width={760} extra={<NodeDrawerActions running={running} onRun={() => void runNode()} onDelete={onDelete} />}>
      <div className="form-grid">
        <label className="field"><span>{t("flows.nodeName")}</span><input className="input" value={node.name} onChange={(event) => patch({ name: event.target.value })} placeholder={t("flows.scriptNodeNamePlaceholder")} /></label>
        <label className="field"><span>{t("flows.onFailure")}</span><Select value={node.onFailure} onChange={(onFailure) => patch({ onFailure })} options={[{ value: "stop", label: t("flows.failureStop") }, { value: "continue", label: t("flows.failureContinue") }]} style={{ width: "100%" }} /></label>
      </div>

      <p className="form-note" style={{ marginTop: 12 }}>{t("flows.scriptNodeBrief")}</p>

      <div className="script-toolbar">
        <Select
          value={following ? node.script?.scriptId : ""}
          onChange={(id) => {
            if (id) { patch({ script: { scriptId: id } }); return; }
            /* Detach: switch the followed script for a local copy. */
            if (following) patch({ script: { content: content || DEFAULT_SCRIPT_NODE_TEMPLATE } });
          }}
          options={[{ value: "", label: t("hooks.privateScript") }, ...publicScripts.map((script) => ({ value: script.id, label: script.name ?? script.id }))]}
          style={{ width: 220 }}
        />
        <div className="script-editor-actions">
          {following
             ? <button type="button" className="btn btn-small" onClick={() => patch({ script: { content, dependencies: referenced?.dependencies ?? [] } })}>{t("scripts.detach")}</button>
            : <button type="button" className="btn btn-small" disabled={!content.trim()} onClick={() => { setPublishName(""); setPublishFor(true); }}>{t("scripts.publish")}</button>}
        </div>
      </div>

      <div className="field script-dependencies-field">
        <span>{t("scripts.dependencies")}</span>
        <Select
          mode="multiple"
          value={dependencyIds}
          disabled={following}
          onChange={(dependencies) => patch({ script: { ...node.script, dependencies } })}
          options={libraries.map((library) => ({ value: library.id, label: library.name ?? library.id }))}
          placeholder={t("scripts.dependenciesPlaceholder")}
          style={{ width: "100%" }}
        />
      </div>

      <div className={`script-code${following ? " is-readonly" : ""}`} style={{ marginTop: 8 }}>
        {resolving
          ? <p className="script-loading muted mono">{t("scripts.loading")}</p>
          : <ScriptCodeEditor
            projectId={projectId}
            runtimeKind="node"
            libraries={selectedLibraries}
            height="220px"
            theme={mode === "dark" ? "vs-dark" : "light"}
            value={content}
            onChange={(next) => { if (!following) patch({ script: { ...node.script, content: next } }); }}
            readOnly={following}
          />}
      </div>
      {following && <p className="form-note">{t("flows.scriptNodeFollowing", { name: referenced?.name ?? "" })}</p>}

      {result && <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <RunStatusTag status={toRunStatus(result.status)} />
          <span className="mono muted">{result.durationMs.toFixed(1)} ms</span>
          <span className="filter-spacer" />
          <button className="btn btn-small" onClick={() => setResult(undefined)}>{t("action.close")}</button>
        </div>
        <div className="panel-body script-node-outcome">
          {result.error && <pre className="mono script-error">{result.error}</pre>}
          <ScriptChecks checks={output?.checks} />
          {output?.debug && output.debug.length > 0 && output.debug.map((entry, index) => <div className="hook-debug" key={index}><span className="hook-debug-label">{entry.label}</span><pre className="mono hook-debug-value">{entry.value}</pre></div>)}
          {output?.logs && output.logs.length > 0 && <pre className="mono script-logs">{output.logs.join("\n")}</pre>}
          {output?.returned !== undefined && <p className="form-note mono">{t("flows.scriptNodeReturned")}<span className="kv-value">{output.returned}</span></p>}
          {output?.variables && Object.keys(output.variables).length > 0 && <div className="kv-list">
            {Object.entries(output.variables).map(([key, value]) => <div key={key} className="kv-row mono"><span className="kv-key">{key}</span><span className="kv-value">= {String(value)}</span></div>)}
          </div>}
        </div>
      </section>}
    </Drawer>

    <Modal
      title={t("scripts.publishTitle")}
      open={publishFor}
      onCancel={() => setPublishFor(false)}
      onOk={() => void publish()}
      okText={t("scripts.publishConfirm")}
      width={420}
    >
      <p className="muted">{t("flows.scriptNodePublishHint")}</p>
      <input className="input" value={publishName} onChange={(event) => setPublishName(event.target.value)} placeholder={t("scripts.namePlaceholder")} aria-label={t("scripts.name")} />
    </Modal>
  </>;
}

/**
 * 条件节点 (P2-2): one rule against the bag routes its true/false edges.
 *
 * The editor is deliberately small — a variable, an operator, a value — because
 * the node's only job is a decision. The 单步调试 shows the rule and the actual
 * value it saw, so a branch that did not fire is reviewable.
 */
function ConditionNodeDrawer({ projectId, flowId, node, nodes, edges, variables, environmentId, evidence, onChange, onClose, onDelete }: Omit<FlowNodeDrawerProps, "node"> & { node: ConditionFlowNode }) {
  const { t } = useTranslation();
  const { environments } = useProjectStore();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecutionStep>();

  useEffect(() => {
    setResult(undefined);
    const restored = asGenericStep(evidence, "condition");
    if (restored) { setResult(restored); return; }
    void api.flowNodeExecutions(projectId, flowId, node.id)
      .then((runs) => setResult(asGenericStep(runs[0], "condition")))
      .catch(() => { /* a new node has no evidence */ });
  }, [projectId, flowId, node.id, evidence]);

  const variableChoices = useMemo(() => variableOptions({
    nodes, edges, nodeId: node.id, variables,
    environment: environments.find((item) => item.id === environmentId),
  }), [nodes, edges, node.id, variables, environments, environmentId]);

  function patch(patch: Partial<ConditionFlowNode>) { onChange({ ...node, ...patch }); }
  function patchCondition(patch: Partial<ConditionFlowNode["condition"]>) { onChange({ ...node, condition: { ...node.condition, ...patch } }); }
  function patchRule(index: number, patch: Partial<ConditionFlowNode["condition"]["rules"][number]>) {
    patchCondition({ rules: node.condition.rules.map((rule, at) => at === index ? { ...rule, ...patch } : rule) });
  }

  async function runNode() {
    setRunning(true);
    try {
      const next = await api.executeFlowNode(projectId, flowId, node, variables);
      const step = asGenericStep(next, "condition");
      if (!step) throw new Error(t("flows.nodeResultUnavailable"));
      setResult(step);
    } catch (error) {
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(detail ?? (error instanceof Error ? error.message : t("flows.nodeRunFailed")));
    } finally { setRunning(false); }
  }

  const output = result?.output as { mode?: "all" | "any"; rules?: Array<{ variable: string; operator: string; value?: string; actual?: unknown; result: boolean }>; result?: boolean } | undefined;

  return <Drawer title={t("flows.nodeTitle")} open onClose={onClose} width={720} extra={<NodeDrawerActions running={running} onRun={() => void runNode()} onDelete={onDelete} />}>
    <div className="form-grid">
      <label className="field"><span>{t("flows.nodeName")}</span><input className="input" value={node.name} onChange={(event) => patch({ name: event.target.value })} placeholder={t("flows.conditionNodeNamePlaceholder")} /></label>
      <label className="field"><span>{t("flows.onFailure")}</span><Select value={node.onFailure} onChange={(onFailure) => patch({ onFailure })} options={[{ value: "stop", label: t("flows.failureStop") }, { value: "continue", label: t("flows.failureContinue") }]} style={{ width: "100%" }} /></label>
    </div>

    <div className="condition-group-head">
      <span>{t("flows.conditionCombine")}</span>
      <Select value={node.condition.mode} onChange={(mode) => patchCondition({ mode })} options={[{ value: "all", label: t("flows.conditionAll") }, { value: "any", label: t("flows.conditionAny") }]} style={{ width: 220 }} />
    </div>
    <p className="form-note">{t("flows.conditionBrief")}</p>
    <div className="condition-rules">
      {node.condition.rules.map((rule, index) => <div className="condition-rule" key={index}>
        <span className="mono muted condition-rule-number">{index + 1}</span>
        <label className="field condition-variable"><span>{t("flows.conditionVariable")}</span><VariableField value={rule.variable} onChange={(variable) => patchRule(index, { variable })} options={variableChoices} className="input mono" placeholder="{{token}}" spellCheck={false} /></label>
        <label className="field"><span>{t("flows.conditionOperator")}</span><Select value={rule.operator} onChange={(operator) => patchRule(index, { operator })} options={CONDITION_OPERATORS.map((value) => ({ value, label: t(`flows.conditionOperator.${value}`) }))} style={{ width: "100%" }} /></label>
        {rule.operator !== "exists" && rule.operator !== "notExists" ? <label className="field condition-value"><span>{t("flows.conditionValue")}</span><VariableField value={rule.value ?? ""} onChange={(value) => patchRule(index, { value })} options={variableChoices} className="input mono" placeholder="200" spellCheck={false} /></label> : <span />}
        <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" disabled={node.condition.rules.length === 1} onClick={() => patchCondition({ rules: node.condition.rules.filter((_, at) => at !== index) })} />
      </div>)}
      <button className="btn btn-with-icon" onClick={() => patchCondition({ rules: [...node.condition.rules, { variable: "", operator: "equals", value: "" }] })}><Plus size={14} />{t("flows.addCondition")}</button>
    </div>
    {result && <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <RunStatusTag status={toRunStatus(result.status)} />
        <span className="mono muted">{result.durationMs.toFixed(1)} ms</span>
        <span className="filter-spacer" />
        <button className="btn btn-small" onClick={() => setResult(undefined)}>{t("action.close")}</button>
      </div>
      <div className="panel-body">
        {output && <div className="kv-list">
          <div className="kv-row mono"><span className="kv-key">{t("flows.conditionResult")}</span><span className="kv-value">{String(output.result)}</span></div>
          <div className="kv-row mono"><span className="kv-key">{t("flows.conditionRule")}</span><span className="kv-value">{output.mode === "any" ? "OR" : "AND"}</span></div>
          {(output.rules ?? []).map((rule, index) => <div className="kv-row mono" key={index}><span className="kv-key">#{index + 1} {String(rule.result)}</span><span className="kv-value">{rule.variable} {rule.operator} {rule.value ?? ""} · {rule.actual === undefined ? "—" : String(rule.actual)}</span></div>)}
        </div>}
        {result.error && <pre className="mono script-error">{result.error}</pre>}
      </div>
    </section>}
  </Drawer>;
}

function asHttpExecution(result?: FlowStepResult): Execution | undefined {
  if (!result) return undefined;
  if ("endpointId" in result) return result;
  return undefined;
}

function asDatabaseStep(result?: FlowStepResult): ExecutionStep | undefined {
  return result && !("endpointId" in result) && result.stepType === "database" ? result : undefined;
}

function asGenericStep(result?: FlowStepResult, type?: string): ExecutionStep | undefined {
  return result && !("endpointId" in result) && (!type || result.stepType === type) ? result : undefined;
}

/** The SQL evidence inside a database step's output_snapshot. */
function databaseOutcome(result: ExecutionStep | undefined) {
  if (!result?.output?.rows) return undefined;
  const output = result.output as { rows: Record<string, unknown>[]; rowCount?: number; truncated?: boolean };
  return { rows: output.rows, rowCount: Number(output.rowCount ?? 0), truncated: Boolean(output.truncated), durationMs: result.durationMs };
}

function toUnknownPairs(record: Record<string, unknown>): Pair[] {
  return Object.entries(record).map(([key, value]) => ({ key, value: stringifyUnknown(value), enabled: true }));
}

function fromUnknownPairs(pairs: Pair[]): Record<string, unknown> {
  return Object.fromEntries(pairs.filter((pair) => pair.enabled && pair.key.trim()).map((pair) => [pair.key.trim(), pair.value]));
}

function stringifyUnknown(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }

/** `$.data.access_token` → `access_token`, so a picked path arrives usable. */
function suggestName(path: string) {
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  const last = segments[segments.length - 1] ?? "value";
  return /^\d+$/.test(last) ? segments[segments.length - 2] ?? "value" : last;
}
