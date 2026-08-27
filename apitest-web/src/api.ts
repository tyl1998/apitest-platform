import axios from "axios";

export type Project = { id: string; name: string; description: string };
export type User = { id: string; email: string; name: string; isSystemAdmin: boolean };
/** Secret values stay on the server; only their key names are sent (Spec 4.6). */
export type Environment = {
  id: string;
  name: string;
  variables: Record<string, string>;
  secretKeys: string[];
  /**
   * 执行分区：这个环境指向的系统该从哪个网段发请求（P2-8）。
   *
   * 内网的测试/生产网段互不连通，worker 只能从自己所在网段出站，所以「从哪发」必须由
   * 环境说出来。默认 `default`（平台所在网段）。
   */
  runnerLabel: string;
};
export type ProjectSettings = { defaultEnvironmentId?: string; storePlaintext: boolean };

/**
 * Secrets are patched, never replaced: `null` removes a key, a string sets it,
 * and an omitted key keeps whatever the server already holds.
 */
export type EnvironmentInput = { name?: string; variables?: Record<string, string>; secrets?: Record<string, string | null>; runnerLabel?: string };

/** What breaks if an environment is deleted, read before the confirm dialog. */
export type EnvironmentUsage = {
  environmentId: string;
  endpoints: { id: string; name: string; method: string; url: string; variables: string[] }[];
  executionCount: number;
  blocked: boolean;
};

export type DataSourceType = "postgresql" | "mysql" | "sqlserver" | "oracle" | "mongodb" | "redis";
export type DataSourceConfig = {
  host: string;
  port: number;
  database: string;
  username: string;
  ssl: boolean;
  sslRejectUnauthorized?: boolean;
  authSource?: string;
  connectTimeoutMs: number;
  queryTimeoutMs: number;
  maxRows: number;
  maxResultBytes: number;
};
export type DataSource = {
  id: string;
  projectId: string;
  name: string;
  type: DataSourceType;
  config: DataSourceConfig;
  passwordConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};
export type DataSourceInput = {
  name: string;
  type: DataSourceType;
  config: DataSourceConfig;
  /** Omit to keep the current password, send null to remove it. */
  password?: string | null;
};
export type DataSourceUsage = {
  dataSourceId: string;
  sqlDefinitions: { id: string; name: string }[];
  flowNodes: { flowId: string; flowName: string; nodeId: string; nodeName: string }[];
  /** Flows referencing this source, by name. */
  flows?: { id: string; name: string }[];
  blocked: boolean;
};
export type SqlStatementType = "query" | "command";
export type SqlParameterType = "string" | "number" | "boolean" | "date" | "json";
export type SqlParameter = { name: string; type: SqlParameterType; required: boolean; defaultValue?: unknown };
export type SqlDefinition = {
  id: string;
  projectId: string;
  dataSourceId: string;
  name: string;
  /** 'sql' for the relational drivers; mongo/redis carry an `operation`. */
  kind: "sql" | "mongo" | "redis";
  statementType?: SqlStatementType;
  sql?: string;
  operation?: DataSourceOperation;
  params: SqlParameter[];
  description: string;
  createdAt: string;
  updatedAt: string;
};
export type SqlDefinitionInput = {
  name: string;
  description: string;
  kind?: "sql" | "mongo" | "redis";
  statementType?: SqlStatementType;
  sql?: string;
  operation?: DataSourceOperation;
  params: SqlParameter[];
};
export type SqlExecutionResult = { rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; durationMs: number };
export type SqlExecutionInput = { sql?: string; statementType?: SqlStatementType; kind?: "sql" | "mongo" | "redis"; operation?: DataSourceOperation; params?: SqlParameter[]; values: Record<string, unknown> };
export type DataSourceTestResult = SqlExecutionResult;
/** MongoDB operations (P2-7.3). Filter/pipeline values may carry `{{name}}`. */
export type MongoOperation =
  | { op: "find"; collection: string; filter?: Record<string, unknown>; projection?: Record<string, unknown>; sort?: Record<string, unknown>; limit?: number }
  | { op: "aggregate"; collection: string; pipeline: unknown[] }
  | { op: "count"; collection: string; filter?: Record<string, unknown> }
  | { op: "distinct"; collection: string; field: string; filter?: Record<string, unknown> }
  | { op: "insertOne"; collection: string; document: Record<string, unknown> }
  | { op: "insertMany"; collection: string; documents: Record<string, unknown>[] }
  | { op: "updateOne"; collection: string; filter: Record<string, unknown>; update: Record<string, unknown>; upsert?: boolean }
  | { op: "updateMany"; collection: string; filter: Record<string, unknown>; update: Record<string, unknown>; upsert?: boolean }
  | { op: "replaceOne"; collection: string; filter: Record<string, unknown>; replacement: Record<string, unknown>; upsert?: boolean }
  | { op: "deleteOne"; collection: string; filter: Record<string, unknown> }
  | { op: "deleteMany"; collection: string; filter: Record<string, unknown> };
/** Redis operations (P2-7.4): a whitelisted command with raw args. */
export type RedisOperation = { op: "command"; command: string; args: unknown[] };
export type DataSourceOperation = MongoOperation | RedisOperation;
export type BodyType = "none" | "json" | "form" | "text";
export type EndpointAuth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apiKey"; key: string; value: string; in: "header" | "query" };

export type Endpoint = {
  id: string;
  name: string;
  description: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  pathParams: Record<string, string>;
  bodyType: BodyType;
  body?: unknown;
  bodyText?: string;
  auth: EndpointAuth;
  tags: string[];
  defaultEnvironmentId?: string;
  /** How many saved cases this endpoint has. 0 truthfully means "none yet". */
  caseCount?: number | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The request definition a case freezes (交互文档 3.1.3 快照隔离). Editing the
 * endpoint afterwards leaves saved cases running exactly what they captured.
 */
export type RequestSnapshot = {
  method: string;
  url: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  pathParams: Record<string, string>;
  bodyType: BodyType;
  body?: unknown;
  bodyText?: string;
  auth: EndpointAuth;
};

export type AssertionType = "status" | "header" | "jsonPath" | "jsonSchema" | "script";
export type AssertionOperator = "equals" | "notEquals" | "contains" | "exists" | "notExists" | "greaterThan" | "lessThan" | "matchesSchema" | "isTrue";

/** Shared follow/copy reference used by lifecycle and node scripts. */
export type ScriptRef = {
  scriptId?: string;
  content?: string;
  /**
   * Library ids to prepend (P1-2). A shared signing or encryption helper lives
   * in one `kind: "library"` script and is declared here, rather than being
   * pasted into every script that needs it.
   */
  dependencies?: string[];
};

/**
 * A pre-request hook: user code that rewrites the request before it is sent.
 *
 * This is what makes signed and encrypted APIs testable — the signature depends
 * on the final body, so it cannot be a static header or a `{{variable}}`.
 *
 * `script` is the only type today. Built-in signing schemes and a webhook that
 * delegates to an internal signing service are additional entries in the
 * server's provider table (`lib/hooks.ts`), which is why this is a tagged shape
 * rather than a bare script reference.
 */
export type PreRequestHook = {
  /**
   * Optional, and **not persisted** — the server stores hooks positionally.
   * Held only so React can key a row while it is being edited; results are
   * matched back by name (or `hook N` when the name is blank).
   */
  id?: string;
  name?: string;
  type: PreRequestHookType;
  /** Absent means enabled: a hook someone added runs unless it is turned off. */
  enabled?: boolean;
  /** Set when `type` is `script`. */
  script?: ScriptRef;
};

export type PreRequestHookType = "script";

/**
 * What one hook did, per hook rather than as one combined log line.
 *
 * `debug` carries the intermediate values a signature scheme is debugged
 * through — the canonical string above all. When a signature is rejected, the
 * question is always which byte of the canonical string differs, and a hook
 * that only reports "ok" cannot answer it.
 */
export type HookResult = {
  name: string;
  type: string;
  ok: boolean;
  error?: string;
  logs: string[];
  debug: { label: string; value: string }[];
  /** `ctx.assert(...)` calls the hook made. Absent on runs recorded before 4.0.2. */
  checks?: ScriptCheck[];
  /** Which parts of the request it rewrote: `headers`, `body`, `url`, … */
  changed: string[];
};

/** Post-response custom logic in a request node (P2-2.1). */
export type ResponseScript = {
  name?: string;
  type: "script";
  enabled?: boolean;
  script?: ScriptRef;
};

export type ResponseScriptResult = {
  name: string;
  type: string;
  ok: boolean;
  error?: string;
  logs: string[];
  debug: { label: string; value: string }[];
  checks: ScriptCheck[];
  returned?: string;
  variables: Record<string, string>;
};

/**
 * One `ctx.assert(...)` call and how it went (计划 4.0.2).
 *
 * Per call rather than one verdict per script: a script may assert several
 * times, and in soft mode several may fail at once. "脚本失败" is not a
 * diagnosis; "第 3 条 expected 200, got 500" is.
 */
export type ScriptCheck = { label: string; passed: boolean; message?: string };

export type Assertion = {
  type: AssertionType;
  /** Header name or JSONPath. Unused by `status`. */
  target?: string;
  operator: AssertionOperator;
  /**
   * Comparison value; also where a `jsonSchema` assertion keeps its schema
   * document inline as text. Absent for exists / notExists.
   */
  expected?: string;
  /** Historical script assertion input; ignored by P2-2.1 request lifecycles. */
  script?: ScriptRef;
};
export type AssertionResult = Assertion & {
  passed: boolean;
  /** Evidence read by a declarative status/header/JSON rule. */
  actual?: string;
  message?: string;
  /** Historical execution evidence retained for old rows. */
  checks?: ScriptCheck[];
};

/**
 * A stored script. `name` present means 具名公共脚本 — shared, and editing it
 * changes every case that follows it, which is why that edit has its own route
 * rather than riding along with a case save.
 */
export type Script = {
  id: string;
  name?: string;
  language: "javascript";
  /**
   * What the script is for (P1-2).
   *
   * An assertion returns a verdict; a hook rewrites the request and its return
   * value is a patch; a library is never run on its own, only prepended to
   * whoever declares it. Mixing them does not throw — a hook used as an
   * assertion simply never signs anything — so the two are kept apart.
   */
  kind: ScriptKind;
  content: string;
  ownerCaseId?: string;
  /** Library ids prepended before this script runs, in declaration order. */
  dependencies: string[];
  /** Top-level declarations extracted server-side for library completion. */
  symbols?: ScriptCompletionSymbol[];
  createdAt: string;
  updatedAt: string;
};

export type ScriptKind = "assertion" | "hook" | "response" | "library" | "node";
export type ScriptRuntimeKind = Exclude<ScriptKind, "library">;
export type ScriptCompletionSymbol = {
  name: string;
  kind: "function" | "class" | "constant" | "property" | "method";
  insertText: string;
  detail: string;
  documentation: string;
};
export type ScriptContract = {
  ctx: Array<{ kind: ScriptRuntimeKind; symbols: ScriptCompletionSymbol[] }>;
};

/** Who follows a public script, shown before an edit or a delete. */
/**
 * Who follows a public script. `users` is the full set; since P1-2 it also
 * contains flows, so a delete confirmation states the real blast radius.
 */
export type ScriptUsage = {
  /**
   * Everything that follows this script. `script` entries are other scripts
   * that declare it as a library — deleting a shared signing helper has to say
   * so before it silently stops three flows from signing.
   */
  users: { id: string; name: string; kind: "case" | "flow" | "script" }[];
  cases: { id: string; name: string }[];
  total: number;
};

/**
 * Result of a script try-run.
 *
 * `passed` is decided by `ctx.assert`, not by the return value: `returned` is
 * shown as context so a script that still reports by returning can be seen to
 * pass regardless of what it returned (计划 4.0.2).
 */
export type ScriptTryResult = {
  passed: boolean;
  error?: string;
  logs: string[];
  debug?: { label: string; value: string }[];
  /** Every `ctx.assert(...)` call, in order. Empty when the script asserted nothing. */
  checks?: ScriptCheck[];
  /** What the script returned, rendered as text. Evidence, not a verdict. */
  returned?: string;
  /** Values the script wrote with `ctx.setVariable`. */
  variables?: Record<string, string>;
  bodyParseError?: string;
};

export type TestCase = {
  id: string;
  endpointId: string;
  name: string;
  description: string;
  environmentId?: string;
  /** Snapshotted, so a case still names its environment after that env is deleted. */
  environmentName?: string;
  request: RequestSnapshot;
  assertions: Assertion[];
  preRequestHooks: PreRequestHook[];
  extracts: FlowExtract[];
  responseScripts: ResponseScript[];
  tags: string[];
  /** Most recent run, for the用例 list's「最近结果」column. */
  lastRun?: Execution;
  createdAt: string;
  updatedAt: string;
};

/**
 * 列表用的用例摘要（跨接口选择器 / 套件成员）。
 *
 * 没有 request / assertions / hooks / extracts / responseScripts：选择器只需要
 * 认出是哪一条用例。需要完整定义时用 `api.case(projectId, caseId)`。
 */
export type TestCaseSummary = {
  id: string;
  endpointId: string;
  /** 供按接口分组。 */
  endpointName: string;
  name: string;
  description: string;
  environmentId?: string;
  environmentName?: string;
  /** 声明式校验条数。 */
  assertionCount: number;
  tags: string[];
  lastRun?: Execution;
  createdAt: string;
  updatedAt: string;
};

export type TestCaseInput = {
  name: string;
  description?: string;
  environmentId?: string | null;
  request: RequestSnapshot;
  assertions?: Assertion[];
  preRequestHooks?: PreRequestHook[];
  extracts?: FlowExtract[];
  responseScripts?: ResponseScript[];
  tags?: string[];
};

/**
 * What breaks if a case is deleted, read before the confirm dialog (P2-4.5).
 *
 * 只有手动成员引用它的套件会拦。流程请求节点的 `sourceCaseId` 只是来源标记（节点自带
 * 完整快照），所以不在这里；`executionCount` 只报数，历史带着 `caseName` 快照。
 */
export type CaseUsage = {
  caseId: string;
  suites: { id: string; name: string }[];
  executionCount: number;
  blocked: boolean;
};

/**
 * 删除的结果：`detachedSuites` 是被顺带摘掉成员的手动套件。
 *
 * 服务端在同一个事务里把这条引用从套件成员里摘掉（P2-4.5 修订），所以删完不会留下
 * 一行「已不存在」的成员。界面用这份清单说清「还改了哪儿」，而不是让用户下次打开套件
 * 才发现成员少了一个。
 */
export type DeleteWithDetach = { id: string; detachedSuites: { id: string; name: string }[] };

/**
 * 一条引用了某用例的流程，以及引用它的那几个请求节点（P2-4.5 增补）。
 *
 * `inLoop` 说明这个节点躺在循环体里——它不是顶层步骤，同步时同样会被覆盖，但用户需要
 * 知道自己改的是循环内部的一步。
 */
export type CaseFlowBinding = {
  flowId: string;
  flowName: string;
  updatedAt: string;
  nodes: { nodeId: string; nodeName: string; inLoop: boolean }[];
};

export type EndpointInput = {
  name: string;
  description?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  pathParams?: Record<string, string>;
  bodyType?: BodyType;
  body?: unknown;
  bodyText?: string;
  auth?: EndpointAuth;
  tags?: string[];
  defaultEnvironmentId?: string | null;
};
export type EndpointFilters = { keyword?: string; method?: string; environmentId?: string };

export type Execution = {
  id: string;
  endpointId: string;
  endpointName: string;
  environmentId?: string;
  /** Snapshotted at run time, so history stays readable after a delete or rename. */
  environmentName?: string;
  batchId?: string;
  /** Debug sends, case runs and flow steps share this record but stay separable. */
  source: "endpoint_debug" | "test_case" | "flow_step";
  caseId?: string;
  caseName?: string;
  /** Set when this run was one step of a flow (P1-2), or a single-step debug. */
  flowExecutionId?: string;
  flowNodeId?: string;
  flowNodeName?: string;
  /** The flow this step belonged to; project-wide records join it in (5.0.9). */
  flowName?: string;
  /**
   * Runs are queued and executed by a worker (P1-3), so a record exists before
   * it has an outcome. `queued` and `running` are not verdicts.
   */
  status: ExecutionStatus;
  statusCode?: number;
  durationMs: number;
  error?: string;
  request: { url: string; method: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown };
  responseHeaders: Record<string, string>;
  responseContentType?: string;
  responseSizeBytes: number;
  responseTruncated: boolean;
  responseBody?: string;
  /** Empty for a debug send; a case run records every assertion it evaluated. */
  assertionResults: AssertionResult[];
  /** Per-extract outcomes for a flow step or single-step debug (P1-2). */
  extractResults: FlowExtractResult[];
  /**
   * Per-hook outcomes, including the canonical string a signature was built
   * from. Empty when the step had no hooks.
   */
  hookResults: HookResult[];
  /** Response-script evidence, separate from declarative assertion results. */
  responseScriptResults: ResponseScriptResult[];
  /** Enqueue time. `startedAt - createdAt` is queue wait, `durationMs` the request. */
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type ExecutionStatus = "queued" | "running" | "success" | "failed" | "canceled";
/** A step row can also be `skipped` — a condition branch that did not fire. */
export type StepStatus = ExecutionStatus | "skipped";

/** A run past this point will not change again, so the UI can stop watching it. */
export const SETTLED: ExecutionStatus[] = ["success", "failed", "canceled"];
export function isSettled(status: ExecutionStatus) { return SETTLED.includes(status); }

export type BatchDebugResult = {
  id: string;
  type: "endpoint_debug";
  environmentStrategy: "endpoint_default" | "override";
  overrideEnvironmentId?: string;
  total: number;
  successCount: number;
  failedCount: number;
  canceledCount: number;
  status: "queued" | "running" | "completed" | "canceled";
  createdAt: string;
  finishedAt?: string;
  items: { endpointId: string; endpointName: string; execution?: Execution; error?: string }[];
};
export type BatchDebugSummary = Omit<BatchDebugResult, "items">;

/**
 * One value a节点 lifts out of its response into the flow variable bag (P1-2).
 *
 * This is the only channel between steps: without it a DAG is a list of
 * unrelated requests. The name is referenced as a plain `{{name}}`, the same
 * syntax as an environment variable, so a request written against an
 * environment keeps working once the value starts coming from an upstream step.
 */
export type FlowExtract = { name: string; from: "body" | "header" | "status"; path?: string };

/**
 * What one extract actually produced (P1-2 收尾).
 *
 * Recorded per extract rather than collapsed into one "could not extract: a, b"
 * message: the three ways it fails — wrong path, body is not JSON, the field
 * really is null — have three different fixes, and a combined message names
 * none of them.
 */
export type FlowExtractResult = FlowExtract & { ok: boolean; value?: string; reason?: string };

/** What a node is seeded from: an endpoint definition or a接口用例 snapshot. */
export type FlowNodeSource = {
  name: string;
  endpointId: string;
  request: RequestSnapshot;
  assertions: Assertion[];
  preRequestHooks: PreRequestHook[];
  extracts: FlowExtract[];
  responseScripts: ResponseScript[];
  sourceCaseId?: string;
  sourceCaseName?: string;
};

/**
 * A flow node. Kinds arrived in slices: `request` (P1-2), `database` (P2-1),
 * `script` / `condition` (P2-2), `wait` / `subflow` / `loop` (P2-6).
 *
 * `request` is a copy, not a reference: editing the endpoint must not silently
 * change what an existing flow sends. `endpointId` expresses origin only — it
 * names the run in history and keeps接口维度 statistics honest.
 */
export type FlowNodeBase = {
  id: string;
  name: string;
  position: { x: number; y: number };
  /** Only request/database nodes judge a response; script/condition omit these. */
  assertions?: Assertion[];
  extracts?: FlowExtract[];
  /** Run before this step is sent, in order (P1-2 收尾). */
  preRequestHooks?: PreRequestHook[];
  /** `stop` by default: a flow is a chain, so continuing past a failed login
   *  produces a page of failures that all say the same thing. */
  onFailure: "stop" | "continue";
  /** Preserve metadata added by later node slices when this client edits a node. */
  [key: string]: unknown;
};

export type RequestFlowNode = FlowNodeBase & {
  type: "request";
  endpointId: string;
  /** Provenance only; execution still uses the copied request snapshot. */
  sourceCaseId?: string;
  sourceCaseName?: string;
  request: RequestSnapshot;
  assertions: Assertion[];
  extracts: FlowExtract[];
  preRequestHooks: PreRequestHook[];
  responseScripts: ResponseScript[];
  /**
   * 这个请求自己跑 N 次并发 (P2-6)。并发只属于请求——它是「同一个接口发 N 个
   * 并发请求」的表达；数据库/SQL、脚本、等待并发跑没有价值，所以不给它们这个字段。
   * 提取按迭代序收集成 JSON 数组。真实并发仍受整次执行的并发预算封顶。
   */
  concurrency?: number;
};

export type DatabaseFlowNode = FlowNodeBase & {
  type: "database";
  dataSourceId: string;
  sqlDefinitionId?: string;
  statementType?: SqlStatementType;
  sql?: string;
  /** mongo/redis data sources: an inline operation instead of SQL (P2-7.3). */
  operation?: DataSourceOperation;
  parameters: Record<string, unknown>;
  assertions: Assertion[];
  extracts: FlowExtract[];
};

export type ConditionOperator = "equals" | "notEquals" | "contains" | "exists" | "notExists" | "greaterThan" | "lessThan";
export type ConditionRule = {
  variable: string;
  operator: ConditionOperator;
  value?: string;
};
export type ConditionGroup = {
  mode: "all" | "any";
  rules: ConditionRule[];
};

/**
 * A 脚本节点 (P2-2): user JavaScript that reads and writes the variable bag.
 * Its outputs are dynamic — only the script knows what it writes — so the
 * variable picker cannot list them, but the run result shows what it produced.
 */
export type ScriptFlowNode = FlowNodeBase & {
  type: "script";
  script: ScriptRef;
};

/** A 条件节点 (P2-2): evaluates one rule and routes its true/false edges. */
export type ConditionFlowNode = FlowNodeBase & {
  type: "condition";
  condition: ConditionGroup;
};

/**
 * A 等待节点 (P2-6): pauses this branch for a bounded time.
 *
 * First version is a **short** wait, not suspend/resume: the node holds one of
 * the run's concurrency slots while it sleeps, which is why the server caps
 * `waitMs`. 「等到某个条件成立」is a different feature.
 */
export type WaitFlowNode = FlowNodeBase & {
  type: "wait";
  waitMs: number;
};

/**
 * How a 子流程 node points at the flow it runs (P2-6).
 *
 * Referenced, not copied — the opposite of a request node. A request node
 * snapshots its endpoint so editing the endpoint cannot change a stored flow;
 * a subflow exists precisely so **one** definition is reused, so a fix to the
 * login chain must reach every caller. A single run stays reproducible because
 * the inner graph is frozen into the run when it is enqueued.
 */
export type FlowReference = {
  flowId: string;
  /** Snapshot for the canvas and for history after a rename or delete. */
  flowName?: string;
  /** Values handed to the inner bag. May reference the outer bag as `{{name}}`. */
  inputs?: Record<string, string>;
  /**
   * Which inner variables come back out. Absent means all of them; an empty
   * list means none —「跑它只为副作用」and「把结果都给我」are different
   * configurations, so the two must not collapse into one.
   */
  outputs?: string[];
};

/** A 子流程节点 (P2-6): runs another flow of this project once, inline. */
export type SubflowFlowNode = FlowNodeBase & { type: "subflow" } & FlowReference;

export type LoopMode = "count" | "list";

/**
 * A 循环节点是**画布上的容器** (P2-6 修订)。
 *
 * 添加循环后可以直接往里加步骤，画布上它框住这些步骤——循环体就是节点自己 body
 * 里的内联子图，不是引用另一条流程（那是子流程节点的职责，循环体内也可以放子流程
 * 节点）。体内步骤与流程共享变量作用域，直接读外层袋。
 *
 * 迭代在节点内部，画布上永远没有回边，外层图保持 DAG。迭代互相独立——每次从同一
 * 外层快照起步。循环有自己的 `concurrency`（N 次迭代同时在飞），与请求步骤自身的
 * 并发正交。
 */
export type LoopFlowNode = FlowNodeBase & {
  type: "loop";
  mode: LoopMode;
  /** `count` mode: how many times to repeat. */
  count?: number;
  /** `list` mode: a variable holding a JSON array. */
  listVariable?: string;
  /** `list` mode: the name the current element takes inside the body. */
  itemVariable?: string;
  /** The name the 0-based iteration index takes inside the body. */
  indexVariable: string;
  /** Iterations in flight, default 1. Capped by the run-wide parallelism budget. */
  concurrency?: number;
  /**
   * Which inner variables are collected per iteration into JSON arrays.
   * Absent means all of them.
   */
  outputs?: string[];
  /** 内联子图：画布容器，添加循环后往里加步骤。 */
  body: { nodes: FlowNode[]; edges: FlowEdge[] };
  /**
   * 画布上这个框的大小（可拖拽调整）。
   *
   * 容器和普通节点不同：位置决定它在哪，尺寸决定它**能框住多少**。框只放得下一张卡时，
   * 想把两步并排会因为第二张卡的中心落在框外而被移出循环，所以尺寸要能调、也要存下来。
   */
  size?: { width: number; height: number };
};

export type FlowNode = RequestFlowNode | DatabaseFlowNode | ScriptFlowNode | ConditionFlowNode | WaitFlowNode | SubflowFlowNode | LoopFlowNode;

/**
 * When an incoming edge activates (P2-2). Absent means after the source
 * succeeds; `failure` is the explicit failure branch; `true`/`false` name the
 * two exits of a condition node.
 */
export type FlowEdgeCondition = "success" | "failure" | "true" | "false";

/** Additional branch/condition metadata is intentionally open and round-tripped. */
export type FlowEdge = { id: string; source: string; target: string; on?: FlowEdgeCondition; [key: string]: unknown };

export type Flow = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  environmentId?: string;
  environmentName?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Seed variables, visible to the first node. Override environment values. */
  variables: Record<string, string>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type FlowPlanStep = { nodeId: string; name: string; endpointId?: string; type?: FlowNode["type"] };

/**
 * A parent execution record (P2-0), matching `mapExecutionIndex` server-side.
 *
 * Flows and suites each write one of these per run, and the project「执行记录」
 * page lists them as one「父执行记录」category with a kind filter (P2-4.4) — a
 * run opens like a batch run instead of appearing as scattered step rows.
 * `kind: "batch"` is allowed by the schema but nothing writes it: batch debug
 * keeps its own table and its own category.
 */
export type ExecutionIndex = {
  id: string;
  projectId: string;
  kind: "flow" | "suite" | "batch";
  targetId?: string;
  targetName: string;
  detailId: string;
  status: ExecutionStatus;
  total: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  canceledCount: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

/**
 * A generic step record (P2-0), matching `mapExecutionStep` server-side.
 *
 * HTTP request nodes also get an `executions` row (linked via
 * `httpExecutionId`); database / script / condition / wait nodes keep all their
 * evidence here because there is no HTTP snapshot to show.
 *
 * A loop / subflow node is a **container**: its own row carries the summary, and
 * the steps its body ran hang off it via `parentStepId` (with `iteration` set
 * for a loop). Parent counts only ever aggregate top-level rows, so a 20-time
 * loop is one step in `total`.
 */
export type ExecutionStep = {
  id: string;
  indexId: string;
  /** The flow node id — stable across runs, unlike this row's id. */
  stepId: string;
  stepType: string;
  stepName: string;
  status: StepStatus;
  /** Parallel stage: siblings with the same stage may have run concurrently. */
  stage: number;
  position: number;
  /** Set when this step ran inside a loop or subflow node (P2-6). */
  parentStepId?: string;
  /** 0-based iteration a loop body step belongs to. Absent for a subflow. */
  iteration?: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error?: string;
  httpExecutionId?: string;
  /**
   * Set when this step delegates to a **whole parent execution** — a suite
   * member that is a flow (P2-4). `httpExecutionId` covers the one-request
   * case; a flow member has its own index and step tree, so the evidence lives
   * behind this id instead of being copied up.
   */
  childIndexId?: string;
  durationMs: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};
export type FlowStepResult = Execution | ExecutionStep;
/**
 * One parent execution plus its **top-level** step rows.
 *
 * Nested loop / subflow evidence is not included — it is fetched on demand via
 * `executionStepChildren`, so a 100-iteration loop does not ship a thousand
 * snapshots to a caller that only needs the parent row.
 */
export type ExecutionIndexDetail = ExecutionIndex & { steps: ExecutionStep[] };

export type FlowExecution = {
  id: string;
  flowId?: string;
  flowName: string;
  environmentId?: string;
  environmentName?: string;
  status: ExecutionStatus;
  total: number;
  successCount: number;
  failedCount: number;
  /** Nodes the plan contained but never reached, after a stop or a cancel. */
  skippedCount: number;
  error?: string;
  plan: FlowPlanStep[];
  /** Final variable bag, masked. Empty while the run is still queued. */
  variables: Record<string, string>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

/** The list view carries a count instead of every node's request body. */
export type FlowSummary = Flow & { nodeCount: number; lastRun?: FlowExecution };
/**
 * What breaks if a flow is deleted, read before the confirm dialog (P2-4.5).
 *
 * `suites` are手动成员引用它的套件，`flows` 是有子流程节点指向它的流程（含循环体内的）。
 * 两者都拦；`executionCount` 只报数——历史带着 `flowName` 快照，删完仍然读得通。
 */
export type FlowUsage = {
  flowId: string;
  suites: { id: string; name: string }[];
  flows: { id: string; name: string }[];
  executionCount: number;
  blocked: boolean;
};
/** `steps` are the HTTP executions; `executionSteps` every node's step row. */
export type FlowExecutionDetail = FlowExecution & { steps: Execution[]; executionSteps: ExecutionStep[] };
export type FlowInput = {
  name?: string;
  description?: string;
  environmentId?: string | null;
  nodes?: FlowNode[];
  edges?: FlowEdge[];
  variables?: Record<string, string>;
  tags?: string[];
};

/* ── 测试套件 (P2-4) ─────────────────────────────────────────────────────────
   套件只编排成员：成员是用例或流程，各自是一次独立执行，成员之间不传变量。
   需要传值的链路建成一条流程，而不是靠套件的执行顺序隐式串起来。 */

export type SuiteMemberRef = { type: "case" | "flow"; id: string };

/** 入队时冻结的成员：名称快照让报告在成员被删/改名后仍读得通。 */
export type SuiteMemberSnapshot = SuiteMemberRef & {
  name: string;
  /** 用例成员所属接口，供报告分组。流程成员为空。 */
  endpointId?: string;
  endpointName?: string;
  environmentId?: string;
  environmentName?: string;
};

/**
 * 成员选择方式。
 *
 * `manual` 是显式引用，会参与「删用例/流程前的引用检查」；`tag`/`all` 是动态选择，
 * 在入队那一刻才解析成快照，不构成引用。
 */
export type SuiteSelection =
  | { type: "manual"; members: SuiteMemberRef[] }
  | { type: "tag"; tags: string[]; match: "any" | "all"; includeCases: boolean; includeFlows: boolean }
  | { type: "all"; includeCases: boolean; includeFlows: boolean };

/**
 * `concurrency` 是「几个成员同时开跑」，不是「几个请求同时在飞」——后者由平台级
 * 令牌预算封顶，声明再高也不会突破。
 */
export type SuiteExecutionConfig = {
  concurrency: number;
  failFast: boolean;
  /** 'member_default' 用成员自己保存的环境；'override' 全部改用 environmentId。 */
  environmentStrategy: "member_default" | "override";
  environmentId?: string;
};

export type SuiteExecution = {
  id: string;
  suiteId?: string;
  suiteName: string;
  executionIndexId?: string;
  environmentId?: string;
  environmentName?: string;
  status: ExecutionStatus;
  total: number;
  successCount: number;
  failedCount: number;
  /** fail-fast 或取消后没能开跑的成员。 */
  skippedCount: number;
  error?: string;
  members: SuiteMemberSnapshot[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

/**
 * 一次套件执行的成员证据。
 *
 * `executionSteps` 每个成员一行（`stepType` 是 `case` 或 `flow`，`position` 就是报告的
 * 阅读顺序）；用例成员的 HTTP 快照在 `runs` 里，按 `httpExecutionId` 取。流程成员的
 * 内层步骤**不在这里**——它自己是一次完整的父执行，展开时才按 `childIndexId` 去拉，
 * 不然一个装了十条流程的套件详情会把十棵步骤树一起搬过来。
 */
export type SuiteExecutionDetail = SuiteExecution & { executionSteps: ExecutionStep[]; runs: Execution[] };

export type TestSuite = {
  id: string;
  name: string;
  description: string;
  selection: SuiteSelection;
  execution: SuiteExecutionConfig;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

/**
 * 列表不解析 tag/all 的成员数：那要为每一行跑两条查询，而列表能显示的只是筛选
 * 条件本身。真实成员数由 `previewSuite` 给出。
 */
export type SuiteSummary = TestSuite & { lastRun?: SuiteExecution };

export type SuitePreview = {
  members: SuiteMemberSnapshot[];
  total: number;
  /** manual 引用了但已不存在的成员。 */
  missing: SuiteMemberRef[];
  memberLimit: number;
  /**
   * 声明的成员并发、峰值请求需求与平台预算。
   *
   * `peak` 是需求最大的那 C 个成员之和：超过 `budget` 不会报错，但请求会分批发出，
   * 「同时并发 N」的结论因此不成立——所以必须在界面上写出来，而不是让用户把一份
   * 被分批的报告当并发结论。
   */
  concurrency: { declared: number; peak: number; budget: number };
  /** 超上限、引用悬空之类要摊开说的问题；不静默截断。 */
  warnings: string[];
};

export type TestSuiteInput = {
  name?: string;
  description?: string;
  selection?: SuiteSelection;
  execution?: Partial<SuiteExecutionConfig>;
  tags?: string[];
};

export type WorkerMode = "endpoint" | "repository";
/**
 * One execution worker, as it last described itself (P1-3).
 *
 * `online` is derived from heartbeat freshness server-side, so a worker that was
 * killed outright still reads as offline without having reported anything.
 */
export type Worker = {
  id: string;
  hostname: string;
  pid: number;
  /** Only `endpoint` exists today; `repository` is reserved for future workers. */
  mode: WorkerMode;
  /**
   * 这台 worker 服务哪些执行分区（P2-8）。
   *
   * 与 `mode` 正交：只有分区参与队列路由。推荐一个进程只服务一个分区，多标签只是单机
   * 开发的便利（那时 `concurrency` 已经按标签数拆分过）。
   */
  labels: string[];
  /** Capacity this worker was given, i.e. its max simultaneous requests. */
  concurrency: number;
  /** Requests in flight at its last heartbeat. */
  inflight: number;
  version?: string;
  online: boolean;
  startedAt: string;
  lastSeenAt: string;
};

export type QueueDepth = { waiting: number; active: number; delayed: number; failed: number };

/**
 * 一个执行分区标签的注册概况（`/system/runner-labels`）。
 *
 * 比执行器面板少得多：没有 hostname/pid/version，所以任何登录用户可读——环境编辑器
 * 的分区建议与「没有在线执行器」提示需要它，而机器信息仍然只给系统管理员。
 */
export type RunnerLabelStatus = { label: string; online: number; total: number };

/**
 * 一个执行分区的当下状态（P2-8）。
 *
 * 标签全集取的是并集（有 worker 的 ∪ 有环境配置的 ∪ `default`），所以一个「配了但没人
 * 服务」的分区会**显式出现且 online=0**——那正是「为什么这个环境的执行全都报 2004」的
 * 答案所在的那一行。
 */
export type ExecutionPartition = {
  label: string;
  /** 服务这个分区的在线台数 / 注册台数。多分区 worker 在每个分区里各算一次。 */
  online: number;
  total: number;
  capacity: number;
  inflight: number;
  waiting: number;
  failed: number;
};

export type WorkerFleet = {
  workers: Worker[];
  /**
   * Keyed by mode, because each mode has its own queue. Only `endpoint` is
   * populated today — a repository queue does not exist yet, and reporting the
   * endpoint queue against it would be wrong rather than merely empty.
   *
   * P2-8 起这条队列按分区分裂，所以这里的数字是**全部分区的合计**；按分区拆开的那份
   * 在 `partitions` 里。
   */
  queues: Partial<Record<WorkerMode, QueueDepth>>;
  /** Live workers only, summed per mode — modes cannot do each other's work. */
  capacity: Record<WorkerMode, number>;
  inflight: Record<WorkerMode, number>;
  /** 执行分区轴（P2-8）。与 mode 正交，不是嵌套的两层。 */
  partitions: ExecutionPartition[];
};

/**
 * A status change pushed over the project event stream (P1-3).
 *
 * Deliberately without a response body: the stream is project-wide, so putting
 * bodies on it would push every member's responses to every other member. The
 * client re-reads the execution once it reaches a terminal state.
 */
export type ExecutionEvent =
  | { kind: "execution"; projectId: string; executionId: string; status: ExecutionStatus; batchId?: string; caseId?: string; flowExecutionId?: string; flowNodeId?: string; endpointId: string }
  | { kind: "step"; projectId: string; stepId: string; status: StepStatus; flowExecutionId?: string; flowNodeId: string; nodeType: string }
  | { kind: "batch"; projectId: string; batchId: string; status: BatchDebugSummary["status"]; total: number; successCount: number; failedCount: number; canceledCount: number }
  /* Flow parent progress (P1-2). Per-node progress still arrives as `execution`
     or `step` events carrying a flowExecutionId, so the canvas and the执行记录
     page read the same stream. */
  | { kind: "flow"; projectId: string; flowExecutionId: string; executionIndexId?: string; status: ExecutionStatus; total: number; successCount: number; failedCount: number; skippedCount: number }
  /* 套件父记录的进度（P2-4）。成员级进度不需要新事件：一个成员就是一次独立执行，
     它自己已经在流上发 execution / flow 事件，这一条只描述父级计数与终态。
     成员行因此靠一次详情重取来更新，而不是靠事件里的 id 对号——套件的 execution
     事件不带 suiteExecutionId。 */
  | { kind: "suite"; projectId: string; suiteExecutionId: string; executionIndexId?: string; status: ExecutionStatus; total: number; successCount: number; failedCount: number; skippedCount: number };

export type ProjectMetric = Project & {
  endpointCount: number;
  environmentCount: number;
  executedEndpointCount: number;
  executionCount: number;
  passedCount: number;
  caseCount: number;
  /** Endpoints with at least one case — 覆盖 means "has a case", not "was run". */
  coveredEndpointCount: number;
  /** null means "never run" — distinct from 0%, which means "every run failed". */
  passRate: number | null;
  completionRate: number | null;
  coverageRate: number | null;
  lastExecutionAt: string | null;
};

export type Dashboard = {
  projectCount: number;
  activeProjectCount: number;
  endpointCount: number;
  environmentCount: number;
  executionCount: number;
  passRate: number | null;
  completionRate: number | null;
  coverageRate: number | null;
  testCaseCount: number | null;
  /** null means the capability is not built yet; render "未启用", never 0. */
  ciTaskCount: number | null;
  scheduleCount: number | null;
  projects: ProjectMetric[];
};

export type Preferences = { theme: "light" | "dark" | "system"; language: "zh-CN" | "en"; restoreLastPage: boolean };

/**
 * 平台的执行预算与保护性上限（P2-4.2）。
 *
 * 这些数由**服务端**说，界面只显示：`flowParallelism` 与 `suiteLeafBudget` 是环境变量
 * （`FLOW_PARALLELISM` / `SUITE_LEAF_BUDGET`），把它们写死在输入框上必然与服务端不一致
 * ——用户填得进去、保存却被拒。
 *
 * 尤其是 `flowParallelism`：请求节点的并发是**原子领取**的（N 枚令牌一次凑齐），所以它
 * 同时就是「一个请求最多并发几次」的上限。
 */
export type PlatformLimits = {
  flowParallelism: number;
  suiteLeafBudget: number;
  suiteMaxConcurrency: number;
  maxLoopIterations: number;
  maxLoopConcurrency: number;
  maxWaitMs: number;
  suiteMaxMembers: number;
};
export type ProjectFilters = { keyword?: string; projectIds?: string[] };
export type ExecutionSourceFilter = "endpoint_debug" | "test_case" | "flow_step" | "all";
export type ExecutionFilters = { status?: string; endpointId?: string; source?: ExecutionSourceFilter; caseId?: string; page?: number; pageSize?: number };
/** Paged reads keep `total` so the UI can show real page controls. */
export type Paged<T> = { items: T[]; page: number; pageSize: number; total: number };

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api/v1";

const client = axios.create({ baseURL: BASE_URL });

client.interceptors.request.use((config) => {
  const token = localStorage.getItem("apitest.token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

function data<T>(response: { data: { data: T } }) { return response.data.data; }

/**
 * 「这个执行分区没有在线执行器」的判定（P2-8，错误码 2004）。
 *
 * 单一实现，六处执行入口共用：分区化之后「队列挂了」与「这个网段没人服务」是两个完全
 * 不同的处置动作，靠 `detail.includes("queue unavailable")` 那种字符串嗅探分不开——文案
 * 一改判断就失效，而失效的表现是把「去起一台 worker」错报成「去修 Redis」。
 *
 * 返回分区标签（可能是空串，服务端总会带上），不是分区错误则返回 `undefined`。
 */
export function noRunnerLabel(error: unknown): string | undefined {
  const body = (error as { response?: { data?: { code?: number; data?: { label?: string } } } })?.response?.data;
  if (body?.code !== 2004) return undefined;
  return body.data?.label ?? "";
}

function paged<T>(response: { data: { data: T[]; meta?: { page?: number; pageSize?: number; total?: number } } }): Paged<T> {
  const items = response.data.data;
  const meta = response.data.meta ?? {};
  return { items, page: meta.page ?? 1, pageSize: meta.pageSize ?? items.length, total: meta.total ?? items.length };
}

function executionParams(filters?: ExecutionFilters) {
  /* "all" is the UI's word for "no filter", so it must not reach the server as
     a value to match against. */
  return { ...filters, status: filters?.status === "all" ? undefined : filters?.status, source: filters?.source === "all" ? undefined : filters?.source };
}

/** Filters go to the server so a keyword matches every row, not just the loaded page. */
function projectParams(filters?: ProjectFilters) {
  if (!filters) return undefined;
  return {
    keyword: filters.keyword?.trim() || undefined,
    projectIds: filters.projectIds?.length ? filters.projectIds.join(",") : undefined,
  };
}

/**
 * Subscribes to a project's execution event stream (P1-3).
 *
 * `fetch` rather than `EventSource`, which cannot set request headers: the only
 * way to authenticate an `EventSource` is a token in the query string, which
 * then lands in every access log. The cost is reconnecting by hand, done below.
 *
 * Returns a function that closes the stream.
 */
export function subscribeExecutions(projectId: string, onEvent: (event: ExecutionEvent) => void) {
  const controller = new AbortController();
  let attempt = 0;

  async function connect(): Promise<void> {
    const response = await fetch(`${BASE_URL}/projects/${projectId}/executions/stream`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("apitest.token") ?? ""}` },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`stream failed: ${response.status}`);
    attempt = 0;

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      /* SSE frames end with a blank line; a chunk can hold several or half of one. */
      let split = buffer.indexOf("\n\n");
      for (; split !== -1; split = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data:"));
        /* Heartbeats are comment frames with no data line. */
        if (!data) continue;
        try { onEvent(JSON.parse(data.slice(5).trim()) as ExecutionEvent); } catch { /* ignore malformed frame */ }
      }
    }
  }

  void (async () => {
    while (!controller.signal.aborted) {
      try { await connect(); } catch { /* fall through to the backoff below */ }
      if (controller.signal.aborted) return;
      /* Backoff caps at 10s so a restarted server is picked up quickly without
         hammering it while it is still coming up. */
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** Math.min(attempt, 5))));
    }
  })();

  return () => controller.abort();
}

export const api = {
  login: (email: string, password: string) => client.post("/auth/login", { email, password }).then(data<{ token: string; user: User }>),
  me: () => client.get("/auth/me").then(data<User>),

  dashboard: (filters?: ProjectFilters) => client.get("/dashboard", { params: projectParams(filters) }).then(data<Dashboard>),
  preferences: () => client.get("/system/preferences").then(data<Preferences>),
  updatePreferences: (input: Partial<Preferences>) => client.put("/system/preferences", input).then(data<Preferences>),
  /** Execution fleet status. System admin only; read-only (P1-3). */
  workers: () => client.get("/system/workers").then(data<WorkerFleet>),
  /** 执行预算与上限。任何能编辑流程或套件的人都要读它，所以不限系统管理员。 */
  systemLimits: () => client.get("/system/limits").then(data<PlatformLimits>),
  /** 分区标签目录：环境编辑器的分区建议与「无在线执行器」提示用。任何登录用户可读。 */
  runnerLabels: () => client.get("/system/runner-labels").then(data<RunnerLabelStatus[]>),

  projects: (filters?: ProjectFilters) => client.get("/projects", { params: projectParams(filters) }).then(data<ProjectMetric[]>),
  project: (id: string) => client.get(`/projects/${id}`).then(data<Project>),
  createProject: (name: string, description: string) => client.post("/projects", { name, description }).then(data<Project>),
  updateProject: (id: string, input: Partial<Pick<Project, "name" | "description">>) => client.patch(`/projects/${id}`, input).then(data<Project>),
  deleteProject: (id: string) => client.delete(`/projects/${id}`).then(data<{ id: string; deleted: boolean }>),

  environments: (projectId: string) => client.get(`/projects/${projectId}/environments`).then(data<Environment[]>),
  projectSettings: (projectId: string) => client.get(`/projects/${projectId}/settings`).then(data<ProjectSettings>),
  updateProjectSettings: (projectId: string, input: { defaultEnvironmentId: string | null; storePlaintext: boolean }) => client.put(`/projects/${projectId}/settings`, input).then(data<ProjectSettings>),
  createEnvironment: (projectId: string, input: EnvironmentInput) => client.post(`/projects/${projectId}/environments`, input).then(data<Environment>),
  updateEnvironment: (projectId: string, id: string, input: EnvironmentInput) => client.patch(`/projects/${projectId}/environments/${id}`, input).then(data<Environment>),
  /* Server-side duplicate: the client never holds secret plaintext, so a client-side copy would lose every secret. */
  duplicateEnvironment: (projectId: string, id: string, name?: string) => client.post(`/projects/${projectId}/environments/${id}/duplicate`, { name }).then(data<Environment>),
  environmentUsage: (projectId: string, id: string) => client.get(`/projects/${projectId}/environments/${id}/usage`).then(data<EnvironmentUsage>),
  /* force is only sent after the user has seen the references the scan found. */
  deleteEnvironment: (projectId: string, id: string, force = false) =>
    client.delete(`/projects/${projectId}/environments/${id}`, { params: force ? { force: "true" } : undefined }).then(data<{ id: string }>),

  dataSources: (projectId: string) => client.get(`/projects/${projectId}/data-sources`).then(data<DataSource[]>),
  dataSource: (projectId: string, dataSourceId: string) => client.get(`/projects/${projectId}/data-sources/${dataSourceId}`).then(data<DataSource>),
  createDataSource: (projectId: string, input: DataSourceInput) => client.post(`/projects/${projectId}/data-sources`, input).then(data<DataSource>),
  updateDataSource: (projectId: string, dataSourceId: string, input: Partial<DataSourceInput>) => client.put(`/projects/${projectId}/data-sources/${dataSourceId}`, input).then(data<DataSource>),
  dataSourceUsage: (projectId: string, dataSourceId: string) => client.get(`/projects/${projectId}/data-sources/${dataSourceId}/usage`).then(data<DataSourceUsage>),
  deleteDataSource: (projectId: string, dataSourceId: string) => client.delete(`/projects/${projectId}/data-sources/${dataSourceId}`).then(data<{ id: string }>),
  testDataSource: (projectId: string, dataSourceId: string) => client.post(`/projects/${projectId}/data-sources/${dataSourceId}/test`).then(data<DataSourceTestResult>),
  queryDataSource: (projectId: string, dataSourceId: string, input: SqlExecutionInput) => client.post(`/projects/${projectId}/data-sources/${dataSourceId}/query`, input).then(data<SqlExecutionResult>),
  sqlDefinitions: (projectId: string, dataSourceId: string) => client.get(`/projects/${projectId}/data-sources/${dataSourceId}/sql-definitions`).then(data<SqlDefinition[]>),
  sqlDefinition: (projectId: string, sqlId: string) => client.get(`/projects/${projectId}/sql-definitions/${sqlId}`).then(data<SqlDefinition>),
  createSqlDefinition: (projectId: string, dataSourceId: string, input: SqlDefinitionInput) => client.post(`/projects/${projectId}/data-sources/${dataSourceId}/sql-definitions`, input).then(data<SqlDefinition>),
  updateSqlDefinition: (projectId: string, sqlId: string, input: Partial<SqlDefinitionInput>) => client.put(`/projects/${projectId}/sql-definitions/${sqlId}`, input).then(data<SqlDefinition>),
  deleteSqlDefinition: (projectId: string, sqlId: string) => client.delete(`/projects/${projectId}/sql-definitions/${sqlId}`).then(data<{ id: string }>),
  testSqlDefinition: (projectId: string, sqlId: string, values: Record<string, unknown>) => client.post(`/projects/${projectId}/sql-definitions/${sqlId}/test`, { values }).then(data<SqlExecutionResult>),

  endpoints: (projectId: string, filters?: EndpointFilters) => client.get(`/projects/${projectId}/endpoints`, { params: { keyword: filters?.keyword?.trim() || undefined, method: filters?.method && filters.method !== "all" ? filters.method : undefined, environmentId: filters?.environmentId && filters.environmentId !== "all" ? filters.environmentId : undefined } }).then(data<Endpoint[]>),
  endpoint: (projectId: string, endpointId: string) => client.get(`/projects/${projectId}/endpoints/${endpointId}`).then(data<Endpoint>),
  createEndpoint: (projectId: string, endpoint: EndpointInput) => client.post(`/projects/${projectId}/endpoints`, endpoint).then(data<Endpoint>),
  updateEndpoint: (projectId: string, id: string, endpoint: Partial<EndpointInput>) => client.patch(`/projects/${projectId}/endpoints/${id}`, endpoint).then(data<Endpoint>),
  deleteEndpoint: (projectId: string, id: string) => client.delete(`/projects/${projectId}/endpoints/${id}`).then(data<{ id: string }>),
  batchDeleteEndpoints: (projectId: string, endpointIds: string[]) => client.post(`/projects/${projectId}/endpoints/batch-delete`, { endpointIds }).then(data<{ ids: string[]; deleted: number }>),
  duplicateEndpoint: (projectId: string, id: string, name?: string) => client.post(`/projects/${projectId}/endpoints/${id}/duplicate`, { name }).then(data<Endpoint>),
  importEndpoints: (projectId: string, endpoints: EndpointInput[], conflictStrategy: "update" | "skip" | "create") =>
    client.post(`/projects/${projectId}/endpoints/import`, { endpoints, conflictStrategy }).then(data<{ imported: Endpoint[]; updated: Endpoint[]; skipped: string[] }>),

  /**
   * Queues a debug send. Resolves with a `queued` execution, not a result —
   * the outcome arrives on the event stream (P1-3).
   */
  execute: (projectId: string, endpointId: string, environmentId?: string | null) => client.post(`/projects/${projectId}/endpoints/${endpointId}/execute`, environmentId === undefined ? {} : { environmentId }).then(data<Execution>),
  batchDebug: (projectId: string, endpointIds: string[], environmentStrategy: "endpoint_default" | "override", environmentId?: string | null) =>
    client.post(`/projects/${projectId}/endpoints/batch-debug`, { endpointIds, environmentStrategy, ...(environmentStrategy === "override" ? { environmentId: environmentId ?? null } : {}) }).then(data<BatchDebugSummary>),
  batchExecutions: (projectId: string, page = 1, pageSize = 20) => client.get(`/projects/${projectId}/batch-executions`, { params: { page, pageSize } }).then(paged<BatchDebugSummary>),
  batchExecution: (projectId: string, batchId: string) => client.get(`/projects/${projectId}/batch-executions/${batchId}`).then(data<BatchDebugResult>),
  /** Single run, used to fetch the full result once the stream says it settled. */
  execution: (projectId: string, executionId: string) => client.get(`/projects/${projectId}/executions/${executionId}`).then(data<Execution>),
  /** Stops a queued run before it starts, or aborts one already in flight. */
  cancelExecution: (projectId: string, executionId: string) => client.post(`/projects/${projectId}/executions/${executionId}/cancel`).then(data<Execution>),
  cancelBatch: (projectId: string, batchId: string) => client.post(`/projects/${projectId}/batch-executions/${batchId}/cancel`).then(data<BatchDebugSummary & { canceled: number }>),
  executions: (projectId: string, filters?: ExecutionFilters) => client.get(`/projects/${projectId}/executions`, { params: executionParams(filters) }).then(paged<Execution>),
  /** Project-wide parent executions, filtered by kind — flows are a category here (5.0.9). */
  executionIndex: (projectId: string, filters?: { kind?: ExecutionIndex["kind"] | "all"; status?: string; keyword?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/execution-index`, {
      params: {
        kind: filters?.kind === "all" ? undefined : filters?.kind,
        status: filters?.status === "all" ? undefined : filters?.status,
        keyword: filters?.keyword?.trim() || undefined,
        page: filters?.page, pageSize: filters?.pageSize,
      },
    }).then(paged<ExecutionIndex>),
  /**
   * 一条父执行记录 + 它的全部步骤行，按 index id 取。
   *
   * 与 `flowExecution` / `suiteExecution` 的区别是它**不认识 kind**：套件成员里的流程
   * 只留下一个 `childIndexId`，要顺着它找到那次流程执行就只能走这条。返回的 `detailId`
   * 才是对应大类的明细 id。
   */
  executionIndexDetail: (projectId: string, indexId: string) =>
    client.get(`/projects/${projectId}/execution-index/${indexId}`).then(data<ExecutionIndexDetail>),
  /** 取消一条父执行；flow 与 suite 才可取消，batch 有自己的取消入口。 */
  cancelExecutionIndex: (projectId: string, indexId: string) =>
    client.post(`/projects/${projectId}/execution-index/${indexId}/cancel`).then(data<ExecutionIndex>),
  endpointExecutions: (projectId: string, endpointId: string, filters?: ExecutionFilters) =>
    client.get(`/projects/${projectId}/endpoints/${endpointId}/executions`, { params: executionParams(filters) }).then(paged<Execution>),

  /* 用例 live under their endpoint; there is no standalone用例 navigation page. */
  cases: (projectId: string, endpointId: string) => client.get(`/projects/${projectId}/endpoints/${endpointId}/cases`).then(data<TestCase[]>),
  /**
   * Cross-endpoint search, for the跨接口用例选择器 that 测试套件 (P2-4) uses.
   *
   * Paged and summary-only: a picker never needs every case's request body.
   * Search is therefore server-side — filtering a loaded page would only match
   * what happens to be on it.
   */
  projectCases: (projectId: string, filters?: { keyword?: string; tag?: string; endpointId?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/cases`, { params: { keyword: filters?.keyword?.trim() || undefined, tag: filters?.tag || undefined, endpointId: filters?.endpointId || undefined, page: filters?.page, pageSize: filters?.pageSize } }).then(paged<TestCaseSummary>),
  case: (projectId: string, caseId: string) => client.get(`/projects/${projectId}/cases/${caseId}`).then(data<TestCase>),
  createCase: (projectId: string, endpointId: string, input: TestCaseInput) => client.post(`/projects/${projectId}/endpoints/${endpointId}/cases`, input).then(data<TestCase>),
  updateCase: (projectId: string, caseId: string, input: Partial<TestCaseInput>) => client.patch(`/projects/${projectId}/cases/${caseId}`, input).then(data<TestCase>),
  /** 引用清单，删除对话框先读它（P2-4.5）。 */
  caseUsage: (projectId: string, caseId: string) => client.get(`/projects/${projectId}/cases/${caseId}/usage`).then(data<CaseUsage>),
  /** `force` 只在用户看过引用清单之后才发。返回被顺带摘掉成员的套件清单。 */
  deleteCase: (projectId: string, caseId: string, force = false) =>
    client.delete(`/projects/${projectId}/cases/${caseId}`, { params: force ? { force: "true" } : undefined }).then(data<DeleteWithDetach>),
  /**
   * 这个用例被哪些流程的哪些请求节点引用（P2-4.5 增补）。
   *
   * 与 `caseUsage` 是两件事：usage 回答「删掉会坏什么」，绑定清单回答「改好之后还有哪儿
   * 要跟着改」。来源标记不构成依赖，所以它不在 usage 的拦截清单里。
   */
  caseFlowBindings: (projectId: string, caseId: string) =>
    client.get(`/projects/${projectId}/cases/${caseId}/flow-bindings`).then(data<CaseFlowBinding[]>),
  /**
   * 把用例的当前定义覆盖进若干条流程里绑定它的节点。
   *
   * 一次可以推多条：一处改动往往要给所有复用它的链路。服务端一个事务里全部写完——
   * 部分成功会留下「三条已同步、两条还是旧的」这种说不清的中间态。`nodeIds` 缺省表示
   * 每条流程里绑着这个用例的全部节点。节点名、坐标、失败策略、并发次数留在图上不动——
   * 那些是编排决策，不属于用例。
   */
  syncCaseToFlows: (projectId: string, caseId: string, flowIds: string[], nodeIds?: string[]) =>
    client.post(`/projects/${projectId}/cases/${caseId}/sync-to-flows`, { flowIds, ...(nodeIds?.length ? { nodeIds } : {}) })
      .then(data<{ flows: { flowId: string; flowName: string; updatedNodeIds: string[] }[] }>),
  /**
   * Runs a case. Passing a request or assertions runs the edited version on
   * screen without persisting it — 交互文档 3.1.3: edits do not自动落盘.
   */
  executeCase: (projectId: string, caseId: string, override?: { request?: RequestSnapshot; assertions?: Assertion[]; preRequestHooks?: PreRequestHook[]; extracts?: FlowExtract[]; responseScripts?: ResponseScript[] }) =>
    client.post(`/projects/${projectId}/cases/${caseId}/execute`, override ?? {}).then(data<Execution>),
  caseExecutions: (projectId: string, caseId: string, filters?: ExecutionFilters) =>
    client.get(`/projects/${projectId}/cases/${caseId}/executions`, { params: executionParams(filters) }).then(paged<Execution>),
  /**
   * Checks assertions against a response already on screen, without re-sending.
   *
   * `environmentId` loads the same variable bag a real run would, so a script
   * assertion reading `ctx.variables` or signing with `{ secret }` validates
   * here the way it will execute. `variables` comes back with whatever the
   * scripts wrote via `ctx.setVariable`.
   */
  validateAssertions: (projectId: string, input: { assertions: Assertion[]; statusCode?: number; headers?: Record<string, string>; body?: string; environmentId?: string; variables?: Record<string, string> }) =>
    client.post(`/projects/${projectId}/assertions/validate`, input).then(data<{ results: AssertionResult[]; passed: boolean; variables: Record<string, string> }>),

  /**
   * 具名公共脚本 only. Anonymous scripts belong to a case and are written by the
   * case save, so they have no independent lifecycle to expose here.
   */
  scripts: (projectId: string, keyword?: string, kind?: ScriptKind) =>
    client
      .get(`/projects/${projectId}/scripts`, { params: { keyword: keyword?.trim() || undefined, kind } })
      .then(data<Script[]>),
  scriptContract: (projectId: string) => client.get(`/projects/${projectId}/scripts/contract`).then(data<ScriptContract>),
  script: (projectId: string, scriptId: string) => client.get(`/projects/${projectId}/scripts/${scriptId}`).then(data<Script>),
  /** Followers of a public script, so a confirm dialog can state the blast radius. */
  scriptUsage: (projectId: string, scriptId: string) =>
    client.get(`/projects/${projectId}/scripts/${scriptId}/usage`).then(data<ScriptUsage>),
  createScript: (projectId: string, input: { name: string; content: string; kind?: ScriptKind; dependencies?: string[] }) =>
    client.post(`/projects/${projectId}/scripts`, input).then(data<Script>),
  /** Changes behaviour for every follower, which is why it is its own call. */
  updateScript: (projectId: string, scriptId: string, input: { name?: string; content?: string; dependencies?: string[] }) =>
    client.patch(`/projects/${projectId}/scripts/${scriptId}`, input).then(data<Script & { followers: { id: string; name: string }[]; followerCount: number }>),
  /** Refused with 409 and the follower list unless `force` is set. */
  deleteScript: (projectId: string, scriptId: string, force?: boolean) =>
    client.delete(`/projects/${projectId}/scripts/${scriptId}`, { params: { force: force ? "true" : undefined } }).then(data<{ id: string; affectedCases: number }>),
  /** Try-run, separate from validateAssertions because it returns console output.
   *  Hook scripts run against a synthetic request instead of a response. */
  tryScript: (projectId: string, input: {
    content: string; kind?: ScriptKind; dependencies?: string[];
    statusCode?: number; headers?: Record<string, string>; body?: string;
    request?: { method?: string; url?: string; headers?: Record<string, string>; body?: string };
    variables?: Record<string, string>;
    /** Hook try-runs load this environment so ctx.variables and { secret } work. */
    environmentId?: string;
  }) => client.post(`/projects/${projectId}/scripts/try`, input).then(data<ScriptTryResult | HookResult>),

  /** 流程编排 (P1-2). The list omits node bodies and carries a count instead. */
  flows: (projectId: string, filters?: { keyword?: string; tag?: string }) =>
    client.get(`/projects/${projectId}/flows`, { params: { keyword: filters?.keyword?.trim() || undefined, tag: filters?.tag || undefined } }).then(data<FlowSummary[]>),
  flow: (projectId: string, flowId: string) => client.get(`/projects/${projectId}/flows/${flowId}`).then(data<Flow>),
  createFlow: (projectId: string, input: FlowInput) => client.post(`/projects/${projectId}/flows`, input).then(data<Flow>),
  updateFlow: (projectId: string, flowId: string, input: FlowInput) => client.put(`/projects/${projectId}/flows/${flowId}`, input).then(data<Flow>),
  /** 引用清单，删除对话框先读它（P2-4.5）。 */
  flowUsage: (projectId: string, flowId: string) => client.get(`/projects/${projectId}/flows/${flowId}/usage`).then(data<FlowUsage>),
  /** `force` 只在用户看过引用清单之后才发。返回被顺带摘掉成员的套件清单。 */
  deleteFlow: (projectId: string, flowId: string, force = false) =>
    client.delete(`/projects/${projectId}/flows/${flowId}`, { params: force ? { force: "true" } : undefined }).then(data<DeleteWithDetach>),
  /**
   * Runs a flow. Passing nodes/edges runs the canvas as it stands without
   * persisting it, the same edited-but-unsaved rule as a case run.
   */
  executeFlow: (projectId: string, flowId: string, override?: { nodes?: FlowNode[]; edges?: FlowEdge[]; variables?: Record<string, string> }) =>
    client.post(`/projects/${projectId}/flows/${flowId}/execute`, override ?? {}).then(data<FlowExecution>),
  /**
   * 单步调试: request nodes may return their existing HTTP Execution, while
   * non-HTTP nodes return a generic execution step. `variables` stands in for
   * what an upstream step would have produced.
   */
  executeFlowNode: (projectId: string, flowId: string, node: FlowNode, variables?: Record<string, string>) =>
    client.post(`/projects/${projectId}/flows/${flowId}/nodes/execute`, { node, variables }).then(data<FlowStepResult>),
  flowExecutions: (projectId: string, flowId: string, filters?: ExecutionFilters) =>
    client.get(`/projects/${projectId}/flows/${flowId}/executions`, { params: executionParams(filters) }).then(paged<FlowExecution>),
  /** One run plus every step it produced. */
  flowExecution: (projectId: string, flowExecutionId: string) =>
    client.get(`/projects/${projectId}/flow-executions/${flowExecutionId}`).then(data<FlowExecutionDetail>),
  cancelFlowExecution: (projectId: string, flowExecutionId: string) =>
    client.post(`/projects/${projectId}/flow-executions/${flowExecutionId}/cancel`).then(data<FlowExecution>),
  /**
   * The runnable order the server would use, or why there is none.
   *
   * Asked rather than computed locally: two implementations of "what runs first"
   * would eventually disagree, and the one on screen is the one users trust.
   */
  flowPlan: (projectId: string, nodes: FlowNode[], edges: FlowEdge[]) =>
    client.post(`/projects/${projectId}/flows/plan`, { nodes, edges }).then(data<{ order: string[]; stages: string[][]; error?: string }>),
  /**
   * A node's recent runs, newest first — flow steps and single-step debugs
   * together. The drawer must show the newest evidence, not just the last
   * debug, or it looks stale right after the flow was run.
   */
  flowNodeExecutions: (projectId: string, flowId: string, nodeId: string) =>
    client.get(`/projects/${projectId}/flows/${flowId}/nodes/executions`, { params: { nodeId } }).then(data<FlowStepResult[]>),
  /**
   * 项目里已经用过的标签，最常用的排在前面。
   *
   * `members` 是用例 + 流程的标签（套件「按标签」匹配的就是这两者），`suites` 是套件
   * 自己的标签。服务端 DISTINCT 而不是从已加载的一页里收集——分页列表凑出来的标签清单
   * 一定是不全的。
   */
  projectTags: (projectId: string, scope: "members" | "suites") =>
    client.get(`/projects/${projectId}/tags`, { params: { scope } }).then(data<string[]>),

  /** Resolves what a node starts from; a case brings its checks along. */
  flowNodeSource: (projectId: string, source: { endpointId?: string; caseId?: string }) =>
    client.get(`/projects/${projectId}/flows/node-source`, { params: source }).then(data<FlowNodeSource>),

  /* 测试套件 (P2-4)。 */
  testSuites: (projectId: string, filters?: { keyword?: string; tag?: string }) =>
    client.get(`/projects/${projectId}/test-suites`, { params: { keyword: filters?.keyword?.trim() || undefined, tag: filters?.tag || undefined } }).then(data<SuiteSummary[]>),
  testSuite: (projectId: string, suiteId: string) => client.get(`/projects/${projectId}/test-suites/${suiteId}`).then(data<TestSuite>),
  createTestSuite: (projectId: string, input: TestSuiteInput) => client.post(`/projects/${projectId}/test-suites`, input).then(data<TestSuite>),
  updateTestSuite: (projectId: string, suiteId: string, input: TestSuiteInput) => client.put(`/projects/${projectId}/test-suites/${suiteId}`, input).then(data<TestSuite>),
  deleteTestSuite: (projectId: string, suiteId: string) => client.delete(`/projects/${projectId}/test-suites/${suiteId}`).then(data<{ id: string }>),
  /**
   * 「这个套件现在会跑哪些成员」。
   *
   * 传 selection 就预览**还没保存的那份配置**——标签/全部是动态选择，不这样用户只能
   * 靠保存来试。不传就预览已存的那份。`concurrency` 只用来算峰值需求，服务端不会
   * 因此改动存下来的执行设置。
   */
  previewSuite: (projectId: string, suiteId: string, selection?: SuiteSelection, concurrency?: number) =>
    client.post(`/projects/${projectId}/test-suites/${suiteId}/preview`, {
      ...(selection ? { selection } : {}),
      ...(concurrency === undefined ? {} : { execution: { concurrency } }),
    }).then(data<SuitePreview>),
  /**
   * 运行套件。返回的是一次**已接受**的执行（202），不是结论——进度走事件流。
   *
   * `execution` 是「改了还没保存也能跑一次」，与用例、流程同一条规则；成员清单**不接受
   * 覆盖**：随手指定一批成员是「批量执行」，不是「运行这个套件」。所以选择方式改了就
   * 必须先保存，界面负责说清这一点。
   */
  executeSuite: (projectId: string, suiteId: string, execution?: Partial<SuiteExecutionConfig>) =>
    client.post(`/projects/${projectId}/test-suites/${suiteId}/execute`, execution ? { execution } : {}).then(data<SuiteExecution>),
  suiteExecutions: (projectId: string, suiteId: string, filters?: ExecutionFilters) =>
    client.get(`/projects/${projectId}/test-suites/${suiteId}/executions`, { params: executionParams(filters) }).then(paged<SuiteExecution>),
  /** 一次运行 + 每个成员一行证据。流程成员的内层步骤另行按需拉取。 */
  suiteExecution: (projectId: string, suiteExecutionId: string) =>
    client.get(`/projects/${projectId}/suite-executions/${suiteExecutionId}`).then(data<SuiteExecutionDetail>),
  /** 不再开跑新成员，在途成员按取消处理；已经跑完的成员保留自己的结论。 */
  cancelSuiteExecution: (projectId: string, suiteExecutionId: string) =>
    client.post(`/projects/${projectId}/suite-executions/${suiteExecutionId}/cancel`).then(data<SuiteExecution>),
  /**
   * What ran *inside* a loop or subflow step (P2-6).
   *
   * Fetched on demand rather than shipped with the run detail: a 100-iteration
   * loop over a multi-node body has an order of magnitude more nested rows than
   * the flow has top-level steps, and the run panel does not need them until a
   * container node's drawer is opened.
   */
  executionStepChildren: (projectId: string, stepId: string) =>
    client.get(`/projects/${projectId}/execution-steps/${stepId}/children`).then(data<{ steps: ExecutionStep[]; executions: Execution[] }>),
};
