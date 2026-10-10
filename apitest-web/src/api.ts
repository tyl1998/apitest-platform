import axios from "axios";
import { message } from "antd";
import i18next from "i18next";
import type { SentPageContext as AssistantPageContext } from "./stores/pageContextStore";

export type Project = { id: string; name: string; description: string; myRole?: MyRole };
/**
 * 项目三级角色 + 系统管理员短路（P6 边界 5 的词汇决策：与 DB CHECK 同一套，不做
 * admin ↔ project_admin 映射）。`useMyRole` 读的就是这个值。
 */
export type ProjectRole = "project_admin" | "developer" | "viewer";
export type MyRole = ProjectRole | "system_admin";
/**
 * `/auth/me`（P6-3 起带 `mustChangePassword`）：登录后的一次刷新会丢登录响应里的
 * 旗，读时从 me() 恢复（服务端改密后即时清，无缓存窗口）。
 */
export type User = { id: string; email: string; name: string; isSystemAdmin: boolean; mustChangePassword?: boolean };
/**
 * 列级归属（P11 边界 7/9）：谁建的 / 谁最后改的，以 **email 快照** 随行返回
 * （后端 `Ownership`；不是表上的列，是读时 `LEFT JOIN users` 的产物）。
 *
 * 两个字段都可选可空，`undefined` / `null` 的语义是「这个响应没有这个值」：
 * - 列表接口带 join，所以列表上显示的是真话；create / update 的返回值没有 join，
 *   读成 undefined —— 列会在列表刷新后补齐（列表页本就重拉）。
 * - `updatedByEmail` 为空而 `updatedAt` 晚于 `createdAt` = **系统路径**改的（调度器 /
 *   告警引擎 / 对账），显示「系统」；两者都为空才是「—」。
 * - `environments` 表没有 created_at / updated_at，所以那两列永远走「—」分支。
 *
 * `spec_cases` 只有 `createdByEmail`（后端没有 updated_by 列）——见 `SpecCase`。
 */
export type Ownership = { createdByEmail?: string | null; updatedByEmail?: string | null };
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
  /**
   * 环境默认头（P3-2，6.5 泳道第一层）：buildRequest 里以最低优先级合并进每一个
   * 请求。值可引用 `{{变量}}`（如 `{"X-Env-Tag": "{{lane}}"}`），泳道值由触发时的
   * 变量覆盖决定。
   */
  defaultHeaders: Record<string, string>;
} & Ownership;
export type ProjectSettings = { defaultEnvironmentId?: string; storePlaintext: boolean; mcpEnabled: boolean; offloadLargeResponse: boolean };

/**
 * Secrets are patched, never replaced: `null` removes a key, a string sets it,
 * and an omitted key keeps whatever the server already holds.
 */
export type EnvironmentInput = { name?: string; variables?: Record<string, string>; secrets?: Record<string, string | null>; runnerLabel?: string; defaultHeaders?: Record<string, string> };

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
} & Ownership;

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
} & Ownership;
export type SqlDefinitionInput = {
  name: string;
  description: string;
  kind?: "sql" | "mongo" | "redis";
  statementType?: SqlStatementType;
  sql?: string;
  operation?: DataSourceOperation;
  params: SqlParameter[];
};
export type SqlExecutionResult = { rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; durationMs: number; fullScan?: boolean };
export type SqlExecutionInput = { sql?: string; statementType?: SqlStatementType; kind?: "sql" | "mongo" | "redis"; operation?: DataSourceOperation; params?: SqlParameter[]; values: Record<string, unknown> };
/**
 * 交互式查询面板一次 /query 的执行历史（P2-1 增量）。元数据永久留，`resultPreview` 是被
 * 独立截断的小预览（`historyTruncated` 标注这一层是否截过，与结果本身的 `truncated` 分开）。
 * 失败行只有 `error`，没有 rowCount / durationMs / resultPreview。
 */
export type SqlExecutionHistory = {
  id: string;
  projectId: string;
  dataSourceId: string;
  userId: string;
  /** 执行人 email（读侧 LEFT JOIN users 带出）；历史只返回本人记录，故必然是当前用户。 */
  userEmail?: string | null;
  statementType: SqlStatementType;
  sql: string;
  params: SqlParameter[];
  values: Record<string, unknown>;
  status: "success" | "error";
  error?: string;
  rowCount?: number;
  durationMs?: number;
  truncated: boolean;
  resultPreview?: Record<string, unknown>[];
  historyTruncated: boolean;
  createdAt: string;
};
export type DataSourceTestResult = SqlExecutionResult;
export type MockMode = "auto" | "fixed" | "template" | "proxy";
export type MockResponse = { statusCode: number; headers: Record<string, string>; body?: unknown };
export type MockProxyPathMode = "append" | "fixed" | "replace";
export type MockProxyQueryMode = "forward" | "drop" | "append";
export type MockProxyConfig = { targetUrl: string; allowedHosts: string[]; timeoutMs: number; maxResponseBytes: number; pathMode?: MockProxyPathMode; queryMode?: MockProxyQueryMode; fixedQuery?: Record<string, string> };
export type Mock = { id: string; endpointId?: string; snapshotExecutionId?: string; name: string; publicId: string; mode: MockMode; enabled: boolean; priority: number; requestMatch: Record<string, unknown>; response: MockResponse; proxyConfig?: MockProxyConfig; delayMs: number; createdAt: string; updatedAt: string } & Ownership;
export type MockInput = { endpointId?: string | null; executionId?: string | null; name: string; mode: MockMode; enabled: boolean; priority: number; requestMatch: Record<string, unknown>; response: MockResponse; proxyConfig?: MockProxyConfig; delayMs: number };
export type MockRequestLog = { id: string; method: string; path: string; matched: boolean; statusCode: number; durationMs: number; requestSnapshot: Record<string, unknown>; responseSizeBytes: number; createdAt: string };
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
  /** 最近一次执行（不含流程步骤）的状态与耗时：服务端 LATERAL 随行带出，列表页不再
      为「最近运行」另拉一份 /executions。 */
  lastStatus?: string;
  lastDurationMs?: number;
  createdAt: string;
  updatedAt: string;
} & Ownership;

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
} & Ownership;

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
} & Ownership;

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
} & Ownership;

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
export type EndpointFilters = { keyword?: string; method?: string; environmentId?: string; coverage?: "covered" | "uncovered" | "all" };

export type Execution = {
  id: string;
  /** Server-mapped `executions.project_id`；下载完整响应（P10-1）按它拼项目端点。 */
  projectId: string;
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
  /**
   * 完整正文已转存对象存储（P10-1）：true 时详情页可拉「下载完整响应」直链；false
   * 覆盖 历史行 / 项目关闭转存 / 超落盘上限 / 写入失败 四种情况，都是合法的「无全量」。
   */
  responseBodyStored: boolean;
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
} & TriggeredByEmail;

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
} & TriggeredByEmail;
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
} & Ownership;

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
  /** `ingest` 是仓库模式的一次上报（P4 边界 1）：它归一进这张清单，但不参与趋势口径。
      `runner` 是自研 Runner 的一次 pipeline run（P4.5-4）：可筛选、可看计数，详情页
      （pipeline-runs/:id）是 P4.5-11。 */
  kind: "flow" | "suite" | "batch" | "ingest" | "runner";
  targetId?: string;
  targetName: string;
  detailId: string;
  /** 谁触发的（P3）：manual/scheduled/webhook/ci。报告列表与执行记录共用这一列。 */
  triggerSource: TriggerSource;
  triggerRefId?: string;
  /** 触发者名字快照：调度被删后报告仍说得出「谁让它跑的」（边界 13）。 */
  triggerRefName?: string;
  triggerSourceUrl?: string;
  status: ExecutionStatus;
  total: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  canceledCount: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
} & TriggeredByEmail;

/** 触发源（P3，迁移 030 的 CHECK 值域）。 */
export type TriggerSource = "manual" | "scheduled" | "webhook" | "ci";
/**
 * 触发人（P11 边界 11，前端）：`triggeredBy` 存 uuid，`triggeredByEmail` 是读时 JOIN 的
 * email 快照——列表上能直接显示的是后者（后端 `TriggeredByEmail`）。
 *
 * 语义与资产归属（`Ownership`）**不同**：这里 `null` 表示「**没有人工触发人**」
 * （定时 / Webhook / 非人 CI），显示「系统」；只有「触发源是手动而 email 缺失」才是
 * 「—」（这次响应没取到，如入队回执）。两个 null 的话术不同，不要统一。
 */
export type TriggeredByEmail = { triggeredByEmail?: string | null };

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
  /**
   * 该失败行当前的人工归因（P8-3，报告成员行随行带出；失败成员有 httpExecutionId 时
   * 归因挂在 executions 行、否则挂在本步骤行——与服务端 JOIN 同一口径）。其余使用方
   * （流程步骤树等）不返回归因列，恒 undefined。
   */
  attribution?: FailureAttributionLite;
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
  /** 报告名 `套件名_YYYYMMDD[_n]`（边界 13）：入队时一次定终身。历史行为空。 */
  reportName?: string;
  /** 触发时下发的变量覆盖（6.5 泳道第二层）：报告标识段展示它。 */
  variableOverrides: Record<string, string>;
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
/** 运行抽屉的「谁触发的」一行来自这里（边界 15：与报告列表同一份 index 口径）。 */
export type SuiteExecutionDetail = SuiteExecution & {
  triggerSource: TriggerSource;
  triggerRefId?: string;
  triggerRefName?: string;
  triggerSourceUrl?: string;
  executionSteps: ExecutionStep[];
  runs: Execution[];
} & TriggeredByEmail;

/**
 * 套件级通知设置（P3-11）：终态按开关投递到所选渠道，模版可覆盖默认。
 * 占位符：{{suiteName}} {{status}} {{passRate}} {{successCount}} {{failedCount}}
 * {{skippedCount}} {{total}} {{duration}} {{reportName}} {{trigger}} {{finishedAt}}。
 */
export type SuiteNotifyConfig = {
  onSuccess: boolean;
  onFailure: boolean;
  channelIds: string[];
  template?: { title?: string; body?: string };
};

export type TestSuite = {
  id: string;
  name: string;
  description: string;
  selection: SuiteSelection;
  execution: SuiteExecutionConfig;
  notify: SuiteNotifyConfig;
  tags: string[];
  createdAt: string;
  updatedAt: string;
} & Ownership;

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
  /** 整块替换（与 selection 同一种 PUT 语义）。 */
  notify?: SuiteNotifyConfig;
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
 * 执行历史的一个**存储**分区（P10-2，`/system/execution-partitions`）。
 *
 * 命名刻意带上 `Storage`：与上面的 `ExecutionPartition` 撞名的只有中文「分区」二字，
 * 两者是无关的东西——那个是 P2-8 的网段标签（`runner_label`，决定一次执行从哪个网段
 * 发出），这个是 `executions` 表按季切出来的物理分区。类型名分开，读代码时不必再猜。
 */
export type ExecutionStoragePartition = {
  /** `executions_YYYYqN`；兜底分区是 `executions_default`。 */
  name: string;
  /** `2026q1`；兜底分区没有季，为 null。 */
  quarter: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  /** 兜底分区：维护拍停摆时行落到这里，正常应当恒空。 */
  isDefault: boolean;
  /** 规划器**估算**行数（reltuples）；从未 ANALYZE 过的新分区为 null（不是 0）。 */
  approxRows: number | null;
  bytes: number;
};

/**
 * 一张已脱离的归档分区（P10-2）。表名既是台账主键，也是清理端点的目标标识。
 *
 * `present=false` 表示表已清除而**台账行保留**——「哪一季、多少条、何时脱离、被谁清掉」
 * 是一条永久事实，也是表没了之后唯一还说得出清掉多少的地方。
 */
export type ArchivedExecutionPartition = {
  tableName: string;
  quarterStart: string;
  quarterEnd: string;
  /** 脱离那一刻的精确行数。 */
  rowCount: number;
  detachedAt: string;
  droppedAt: string | null;
  droppedBy: string | null;
  present: boolean;
  /** 表还在时的占用；已清除为 null。 */
  bytes: number | null;
};

export type ExecutionPartitionView = {
  /** 0 = 自动归档关闭（默认），维护拍只预建分区。 */
  retentionMonths: number;
  maintenanceIntervalHours: number;
  /** 清理时驱动对不上的大响应体会被跳过，所以 `objectsSkipped` 要配上这个字段才读得懂。 */
  storageDriver: "fs" | "s3";
  /** 兜底分区里的滞留行数，正常恒为 0；非 0 = 维护拍停过，需人工搬行。 */
  strandedRows: number | null;
  partitions: ExecutionStoragePartition[];
  archives: ArchivedExecutionPartition[];
};

/** 清理一张归档分区的结果（不可逆）。 */
export type ExecutionPartitionDropResult = {
  tableName: string;
  rowCount: number;
  objectsDeleted: number;
  /** 驱动对不上而**没有**删的对象数——不假装删干净了。 */
  objectsSkipped: number;
  /** 被置空的悬垂指针数（execution_steps + mocks）。 */
  pointersCleared: number;
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
   | { kind: "suite"; projectId: string; suiteExecutionId: string; executionIndexId?: string; status: ExecutionStatus; total: number; successCount: number; failedCount: number; skippedCount: number }
  /* CI pipeline run 的状态变化与日志水位（P4.5-4）。日志内容不进事件体——前端按
     `logBytes` 走 `GET …/pipeline-runs/:id/logs?offset=` 拉增量，与后端
     lib/events.ts 的同一条纪律。 */
  | { kind: "pipeline"; projectId: string; pipelineRunId: string; executionIndexId?: string; status: string; stage?: string }
  | { kind: "pipelineLog"; projectId: string; pipelineRunId: string; logBytes: number };

/**
 * `/projects` 的行（2026-09-10 服务端拆轻后随行收缩）：身份 + 资产计数——执行面
 * 字段（passRate/executionCount/…）不再随列表下发，那类读数全部来自 `/stats/*`
 * （P8-4 起全局层统计的单一来源）。计数口径与服务端 queryProjectList 同注释：
 * specCaseCount 数非废弃文本用例、repoCaseCount 只数 active 仓库用例。
 *
 * P14-1 可见性两层（边界 1）：`isMember` 标记这一行我是不是成员。非成员行只带身份
 * （名称/描述），全部资产计数为 `null`——「看得到 ≠ 拿到数据」。项目目录页据此对
 * 非成员卡藏掉计数与管理操作，只留「查看」进落地页。
 */
export type ProjectMetric = Project & {
  isMember: boolean;
  endpointCount: number | null;
  environmentCount: number | null;
  caseCount: number | null;
  flowCount: number | null;
  suiteCount: number | null;
  repoCaseCount: number | null;
  specCaseCount: number | null;
};

/**
 * 项目身份 + 管理员线索（P14-1 边界 2）：`GET /projects/:id/identity` 的响应。登录即可
 * 读（非成员也能拿），无权限落地页用它渲染「找管理员」降级态。`admins` 是 project_admin
 * 的姓名 + 邮箱（边界 7 粒度），非成员照此找人要权限；申请入口在 P14-2 接。
 */
export type ProjectIdentity = {
  id: string;
  name: string;
  description: string;
  isMember: boolean;
  myRole: MyRole | null;
  admins: { name: string; email: string }[];
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
  /** CI 任务数（P4.5-11 起是真值；此前是 null 占位、渲染成「未启用」）。 */
  ciTaskCount: number | null;
  /** Real numbers now that schedules exist (P3-6). */
  scheduleCount: number;
  /** 自动化覆盖率（P7-6）：跨项目先合分子分母再除。 */
  specCaseTotal: number;
  specAutomatedCount: number;
  automationRate: number | null;
  /** `/dashboard` 的项目行仍是重聚合形状（executions 聚合在其职责内），与拆轻后的
      `/projects` 行不是同一类型——前端当前无调用方（统计走 /stats/*），类型保留
      仅为了接口契约不失忆。 */
  projects: ProjectMetric[] & Record<string, unknown>[];
};

/* avatarSeed / avatarNightmare（P9-6 人物生成器）：种子覆盖与 nightmare 物种
   开关都是可选键——未写 = 身份种子 users.id / 物种默认移出。 */
export type Preferences = { theme: "light" | "dark" | "system"; language: "zh-CN" | "en"; restoreLastPage: boolean; avatarSeed?: string; avatarNightmare?: boolean };

/* ---------------------------------------------------------------------------
 * P3：定时调度 / Webhook 触发 / 告警 / 报告（计划第六节）。
 * 页面在 P3-9 落地；这里是它们要用的全部类型与调用。
 * ------------------------------------------------------------------------- */

/**
 * 可被定时调度 / Webhook 触发的目标类型（P4.5-12）。
 *
 * 调度没有 `flow`（P3 边界 1：要按时跑一条流程，把它放进只含它的套件）；Webhook 有
 * （外部业务事件天然是单链路且要带入参）。两个列表刻意分开而不是求并集——它们不是同一个
 * 集合恰好差一项，是两个问题各自的答案。
 */
export const SCHEDULE_TARGET_TYPES = ["suite", "ci_task"] as const;
export type ScheduleTargetType = (typeof SCHEDULE_TARGET_TYPES)[number];
export const WEBHOOK_TARGET_TYPES = ["flow", "suite", "ci_task"] as const;
export type WebhookTargetType = (typeof WEBHOOK_TARGET_TYPES)[number];

/** 一条定时调度（目标是套件或 CI 任务，P4.5-12）。 */
export type Schedule = {
  id: string;
  projectId: string;
  name: string;
  targetType: ScheduleTargetType;
  targetId: string;
  /** 列表/详情接口 join 出的目标名；目标被删后为空。 */
  targetName?: string;
  /** 为空 = 套件自己的环境配置；有值 = 触发时覆盖（边界 4）。CI 目标上无意义。 */
  environmentId?: string;
  cron: string;
  /** 用户按墙上时钟写 cron，默认 Asia/Shanghai。 */
  timezone: string;
  enabled: boolean;
  /** 每次触发都带的变量覆盖（6.5 泳道第二层），如 {"lane":"lane-b"}。
      CI 目标下它就是任务 `parameters`（同一条键形约束、同一句语义）。 */
  variables: Record<string, string>;
  /** 禁用为空；调度器认领后快进。界面显示「下次执行」就靠它。 */
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
} & Ownership;

export type ScheduleInput = {
  name?: string;
  /** 创建时缺省 `'suite'`（服务端兜底）；编辑时不改类型就不用带。 */
  targetType?: ScheduleTargetType;
  targetId?: string;
  cron?: string;
  timezone?: string;
  environmentId?: string | null;
  enabled?: boolean;
  variables?: Record<string, string>;
};

/** 一个到期时刻及其结果（边界 2/3）：skipped 是漏跑的证据，failed 是触发失败。 */
export type ScheduleRun = {
  id: string;
  projectId: string;
  scheduleId: string;
  /** 到期时刻本身；skipped 行的 triggeredAt 为空。 */
  plannedAt: string;
  triggeredAt?: string;
  status: "triggered" | "skipped" | "failed";
  /** 套件目标触发成功后指向产生的父执行；skipped/failed 没有。 */
  executionIndexId?: string;
  /** CI 目标触发成功后指向那条 pipeline run——它的 index 行要到终态才写（P4.5-12）。 */
  pipelineRunId?: string;
  /**
   * 那次执行自己的状态（服务端 runs 列表 JOIN 出来）：`triggered` 只表示拉起成功，
   * 执行结果在这——CI 目标为 `pipeline_runs.status`，套件目标为 `execution_index.status`。
   * skipped / failed 或引用悬空（目标被删）时为 undefined。
   */
  executionStatus?: string;
  error?: string;
  createdAt: string;
};

/**
 * 「立即跑一次」的结果（P4.5-12 起是按 `targetType` 判别的联合）。
 *
 * 两条路径产出的是两种东西（一行 `suite_executions` / 一行 `pipeline_runs`），后续跳转
 * 目标也不同（套件报告 / run 详情页）。判别式把「我拿到的是什么」写在数据里，而不是让
 * 调用方按字段有无去猜。
 */
export type ScheduleRunNowResult =
  | { targetType: "suite"; suiteExecution: SuiteExecution }
  | { targetType: "ci_task"; pipelineRun: PipelineRun & { idempotentReplay?: boolean } };

/** cron 预览（`POST /schedules/preview`）：服务端算出的下几次执行时间。 */
export type SchedulePreview = { cron: string; timezone: string; next: string[] };

/** 外部触发器（边界 6）：公开路由凭 HMAC 准入，密钥只在创建/轮换时回一次。 */
export type WebhookTrigger = {
  id: string;
  projectId: string;
  name: string;
  targetType: WebhookTargetType;
  targetId: string;
  targetName?: string;
  environmentId?: string;
  publicId: string;
  hasSecret: boolean;
  enabled: boolean;
  lastTriggeredAt?: string;
  lastRunId?: string;
  lastRunStatus?: string;
  createdAt: string;
  updatedAt: string;
} & Ownership;

export type WebhookTriggerInput = {
  name?: string;
  targetType?: WebhookTargetType;
  targetId?: string;
  environmentId?: string | null;
  enabled?: boolean;
};

/** 四种「POST 一段 JSON 到一个 URL」渠道（边界 8：Email 不做）。 */
export type NotificationChannelType = "webhook" | "wecom" | "dingtalk" | "slack";

export type NotificationChannel = {
  id: string;
  projectId: string;
  name: string;
  type: NotificationChannelType;
  url: string;
  /** 加签密钥是否已配置；明文永不回显。 */
  secretConfigured: boolean;
  /** 可选前缀文案，不是模板语言。 */
  templatePrefix?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
} & Ownership;

export type NotificationChannelInput = {
  name?: string;
  type?: NotificationChannelType;
  url?: string;
  /** 三态：null 清除、字符串设置、缺省不动（PUT）。 */
  secret?: string | null;
  templatePrefix?: string | null;
  enabled?: boolean;
};

export type AlertMetric = "execution_failed" | "consecutive_failures" | "success_rate" | "avg_duration";
export type AlertComparator = "gt" | "gte" | "lt" | "lte";

export type AlertRule = {
  id: string;
  projectId: string;
  name: string;
  metric: AlertMetric;
  comparator: AlertComparator;
  /** 量纲按指标：success_rate 百分比、avg_duration 毫秒、连败次数。 */
  threshold: number;
  /** 事件型指标（execution_failed）为空。 */
  windowMinutes?: number;
  cooldownSeconds: number;
  channelIds: string[];
  enabled: boolean;
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
} & Ownership;

export type AlertRuleInput = {
  name?: string;
  metric?: AlertMetric;
  comparator?: AlertComparator;
  threshold?: number;
  windowMinutes?: number | null;
  cooldownSeconds?: number;
  channelIds?: string[];
  enabled?: boolean;
};

/** 一次投递的证据（边界 10）。 */
export type NotificationDelivery = {
  id: string;
  projectId: string;
  channelId?: string;
  ruleId?: string;
  executionIndexId?: string;
  status: "sent" | "failed";
  statusCode?: number;
  error?: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

/** 列表接口 join 出的名字（渠道/规则被删后为 null，行本身仍是证据）。 */
export type NotificationDeliveryRow = NotificationDelivery & { channelName: string | null; ruleName: string | null };

/** 报告列表行（边界 13/14）：派生值（耗时/排队/通过率）由服务端算好。 */
/** 报告列表行（2026-09-02 起两个来源：套件 + 仓库执行，`kind` 决定点行去哪个详情页）。 */
export type SuiteReportSummary = {
  id: string;
  kind: "suite" | "runner";
  reportName: string | null;
  /** 套件名（suite）或任务名（runner）。 */
  targetName: string;
  environmentName: string | null;
  runnerLabel: string;
  triggerSource: TriggerSource;
  triggerRefId: string | null;
  triggerRefName: string | null;
  triggerSourceUrl?: string;
  variableOverrides: Record<string, string>;
  status: ExecutionStatus;
  total: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  passRate: number | null;
  durationMs: number | null;
  queueMs: number | null;
  /** 该报告失败行的归因聚合（P8-3）：无失败行时 failed=0。 */
  attribution: ReportAttributionSummary;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
} & TriggeredByEmail;

/** 一份报告（6.4 的四段）：标识 / 触发 / 结论 / 成员明细（不分页）。 */
export type SuiteReport = {
  id: string;
  executionIndexId: string;
  reportName: string | null;
  suiteName: string;
  environmentName: string | null;
  runnerLabel: string;
  triggerSource: TriggerSource;
  triggerRefId: string | null;
  triggerRefName: string | null;
  triggerSourceUrl?: string;
  variableOverrides: Record<string, string>;
  status: ExecutionStatus;
  error: string | null;
  total: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  passRate: number | null;
  durationMs: number | null;
  queueMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  members: ExecutionStep[];
} & TriggeredByEmail;

/** 趋势桶（边界 11）：空桶由服务端 generate_series 补齐，total=0 就是「没执行」。 */
export type TrendBucket = {
  bucket: string;
  total: number;
  successCount: number;
  failedCount: number;
  passRate: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
};

export type TrendReport = { range: "24h" | "7d" | "30d"; scope: SampleScope; buckets: TrendBucket[] };

export type ReportRange = "24h" | "7d" | "30d";

/**
 * 趋势与汇总的样本口径（2026-09-10 用户验收反馈起三态化，`metrics.sampleKinds`
 * 同款）：`platform` 平台自己跑的 flow/suite；`repo` 仓库侧（上报 + Runner，
 * 两者一体不拆——P4.5 边界 2）；`all` 混合。
 */
export type SampleScope = "platform" | "repo" | "all";

/** 汇总：总量 + 失败分布（按接口 Top20 / 按错误类型；`repo` 口径下 failures 为空）。 */
export type ReportSummary = {
  range: ReportRange;
  scope: SampleScope;
  total: number;
  successCount: number;
  failedCount: number;
  canceledCount: number;
  passRate: number | null;
  avgDurationMs: number | null;
  failures: {
    byEndpoint: { endpoint: string; failed: number }[];
    byType: { assertion: number; script: number; timeout: number; request: number };
  };
};

/* ── P8：全局统计（/stats/*）。项目层「数据统计」页带 projectIds 复用同一组接口 ── */

/**
 * 全局读数（P8-4 overview）：执行面四读数 + 触发源分布 + 资产面（含边界 20 的
 * 四读数：endpointTotal / coverageRate / automationRate / specCaseTotal）+ 7 天
 * delta。delta 的计数是绝对差、比率是 pp（「从 80% 到 82%」是 +2pp）；任一段没有
 * 样本 → null（「不可算」与「没变化」是两个事实）。
 */
export type StatsOverview = {
  days: number;
  scope: SampleScope;
  executions: { total: number; successCount: number; failedCount: number; canceledCount: number; passRate: number | null };
  attribution: { failedTargets: number; attributed: number; unattributed: number; coverageRate: number | null };
  triggerSources: { source: TriggerSource; count: number }[];
  assets: {
    endpointTotal: number;
    coveredEndpointTotal: number;
    coverageRate: number | null;
    caseTotal: number;
    flowTotal: number;
    suiteTotal: number;
    specCaseTotal: number;
    specReviewedTotal: number;
    specAutomatedTotal: number;
    automationRate: number | null;
    repoCaseTotal: number;
  };
  delta: { executions: number; failed: number; passRate: number | null; attributionCoverageRate: number | null };
};

/** 执行趋势桶（服务端补空桶，total=0 即「没执行」；分位只在 ≤30d 窗口返回）。 */
export type StatsTrendBucket = {
  bucket: string;
  total: number;
  successCount: number;
  failedCount: number;
  passRate: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  queueP50: number | null;
  queueP90: number | null;
};

/** 资产新增趋势桶（repo_cases 含 removed——「新增行为」不是存量）。 */
export type StatsAssetTrendBucket = {
  bucket: string;
  endpoints: number;
  cases: number;
  flows: number;
  suites: number;
  specCases: number;
  repoCases: number;
};

export type StatsTrendReport =
  | { metric: "execution_trend"; days: number; scope: SampleScope; triggerSource: TriggerSource | null; buckets: StatsTrendBucket[] }
  | { metric: "asset_trend"; days: number; buckets: StatsAssetTrendBucket[] };

/** 失败 TopN 维度（边界 21 的六维——P8-7 扩参后全量）。 */
export type StatsTopNDim = "endpoint" | "case" | "ci_task" | "suite" | "flow" | "repo_case";

/** 归因来源筛选（P8-7，边界 8）：human | mcp；null = 未筛。 */
export type AttributionSourceFilter = "human" | "mcp";

/** case 维带 caseId（执行记录筛选用）；其余三维带 refId（接口/任务/套件的深链目标）。 */
export type StatsFailureTop = { projectId: string; projectName: string; name: string; caseId?: string; refId?: string; failed: number };

export type StatsFailures = {
  days: number;
  attribution: {
    failedTargets: number;
    attributed: number;
    unattributed: number;
    coverageRate: number | null;
    distribution: { code: string; name: string; count: number }[];
  };
  /** 归因来源筛选（P8-7）：human | mcp | null（未筛）。 */
  attributionSource: AttributionSourceFilter | null;
  topN: StatsTopNDim;
  top: StatsFailureTop[];
};

/** Flaky 榜（三腿：api = 平台用例执行序列；repo = SDK 上报序列；runner = 仓库任务序列，
 *  2026-09-10 验收五轮⑤——平台 Runner 跑的 CI 任务用例也进榜）。 */
export type StatsFlakyCase = {
  source: "api" | "repo" | "runner";
  projectId: string;
  projectName: string;
  caseId: string | null;
  caseKey: string | null;
  name: string;
  runs: number;
  passed: number;
  failed: number;
  flips: number;
  lastRunAt: string | null;
};

export type StatsFlaky = {
  days: number;
  flaky: StatsFlakyCase[];
  thresholds: { MIN_RUNS: number; MIN_FLIPS: number; MIN_PASSED: number; MIN_FAILED: number };
  mttr: { recoveredFailures: number; unrecoveredFailures: number; medianMs: number | null; p90Ms: number | null };
  firstPass: { cases: number; firstPassed: number; rate: number | null };
};

/** 项目对比（边界 19 的 Top 10 反向榜 / 关键字检索；归因覆盖率既作列也可作排序指标）。 */
export type StatsProjectMetric = "coverage" | "automation" | "passRate" | "failed" | "attribution";

export type StatsProjectRow = {
  id: string;
  name: string;
  endpointCount: number;
  coveredEndpointCount: number;
  coverageRate: number | null;
  specReviewedTotal: number;
  specAutomatedCount: number;
  automationRate: number | null;
  executionCount: number;
  passedCount: number;
  failedCount: number;
  passRate: number | null;
  attributionFailed: number;
  attributionAttributed: number;
  attributionRate: number | null;
};

export type StatsProjects = { days: number; metric: StatsProjectMetric; order: "asc" | "desc"; scope: SampleScope; projects: StatsProjectRow[] };

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

/* ── P4: 仓库模式（上报式用例）。范围与边界见 DEVELOPMENT_PLAN.md 7.0 ───────────── */

export type RepositoryProvider = "github" | "gitlab" | "gitee" | "bitbucket" | "other";

/**
 * 项目绑定的唯一仓库。**绑定由首次上报完成**，前端没有「创建仓库」这件事——所以未绑定
 * 时接口回的是 `null` 而不是 404，接入指引页把它当成一个正常的初始状态显示。
 */
export type Repository = {
  id: string;
  projectId: string;
  gitUrl: string;
  provider: RepositoryProvider;
  /** 删除对账的第二道闸门：只有这个分支上的全量上报才会软删用例。 */
  trackingBranch: string;
  status: "active" | "unbound";
  firstSeenCommit?: string;
  lastIngestAt?: string;
  createdAt: string;
  updatedAt: string;
  activeCaseCount: number;
  ingestRunCount: number;
};

/**
 * 项目级命名 Git 凭据（P4.5-14）。
 *
 * 取代了原先挂在仓库行上的 `cloneMethod` / `hasCredential`：那三列要求「先有一次上报才
 * 能配 clone」，而用户来这里正是因为还没有 CI。多个任务共用一把 key，换 token 只改一处。
 *
 * 明文永不回（只写不读）：这里只有名字、方式与更新时间。「公开仓库」由任务不引用凭据
 * 表达，所以没有 `none` 档。
 */
export type GitCredential = {
  id: string;
  projectId: string;
  name: string;
  method: "https_token" | "ssh_key";
  credentialUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
  /** 引用它的 CI 任务数：删除确认前要先说清「删了它会影响几个任务」。 */
  taskCount?: number;
};

/** 上报 Token。明文只在创建响应里出现一次，列表只回 `tokenPrefix`。 */
export type IngestToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt?: string;
  revokedAt?: string;
  createdAt: string;
};

export type RepoCaseResult = "passed" | "failed" | "unknown" | "not_run";

/**
 * 该用例最新一条**任务报告**（2026-09-03，验收反馈 ⑦）：通过状态、最近执行与
 * 「绑定的仓库任务」都从 pipeline_run_cases（Runner 解析 junit/allure 落的行）读时
 * 关联出来——报告是「这轮 CI 到底怎么走的」的权威副本。
 */
export type RepoCaseLastReport = {
  runId: string;
  runNumber: number;
  taskName: string;
  status: "passed" | "failed" | "skipped";
  runAt: string;
};

export type RepoTestCase = {
  id: string;
  caseKey: string;
  name: string;
  description: string;
  filePath: string;
  tags: string[];
  status: "active" | "removed";
  lastResult: RepoCaseResult;
  lastSeenCommit?: string;
  lastRunAt?: string;
  removedAt?: string;
  /** 最新任务报告（没有匹配的报告行时缺席——junit 的 guessed key 对不上就是没有）。 */
  lastReport?: RepoCaseLastReport;
  endpoints?: { endpointId: string; endpointName: string; method: string; url: string; requestCount: number }[];
};

/**
 * 用例树的一页：**按接口分组**（树是「系统 → 接口 → 用例」），分页分在接口上。
 *
 * `caseCount` 与 `coverage.distinctCaseTotal` 是**两个不同口径**（边界 9）：前者数关系数
 * （一个用例打三个接口就在三处各算一次），后者数 distinct case_key。两者相加不相等，
 * 界面上必须写明，否则会被当成 bug 报上来。
 */
export type RepoCaseTree = {
  endpoints: { endpointId: string; name: string; method: string; url: string; caseCount: number; cases: RepoTestCase[] }[];
  coverage: {
    endpointTotal: number;
    coveredEndpointTotal: number;
    distinctCaseTotal: number;
    removedCaseTotal: number;
    /** 有用例但一个接口都没打到（边界 21）：树上挂不住，单独一个分组。 */
    unplacedCaseTotal: number;
  };
};

/**
 * 单条仓库用例的详情（抽屉读）：身份事实 + 参数化场景 + 最近记录 + 最新任务报告。
 *
 * `latestReport.requests` 是那次 run 的 SDK 请求序列（按 seq 排序，行上带 endpointId，
 * 抽屉据此高亮「该接口所在的步骤」）；`latestReport.steps` 是报告包里的 allure 步骤树
 * （junit-only 的任务没有包，缺席）。
 */
export type RepoCaseDetail = RepoTestCase & {
  params: string[];
  records: IngestRecord[];
  latestReport?: {
    runId: string;
    runNumber: number;
    taskName: string;
    status: "passed" | "failed" | "skipped";
    durationMs: number;
    message: string | null;
    runAt: string;
    steps?: AllureReportStep[];
    requests: IngestRecord[];
  };
};

export type IngestRun = {
  id: string;
  commitSha: string;
  branch: string;
  /** 最近一次上报的 CI 来源（迁移 045 起同 commit 折同一行，不再随执行新增行）。 */
  ciRunId: string;
  ciRunUrl?: string;
  /** 这个 commit 在 CI 上执行过的次数（SDK 直跑不计入）。 */
  ciExecutionCount: number;
  /** 本次跑的范围，相对仓库根。空数组 = 全仓。 */
  scope: string[];
  /** 「这个范围内没有过滤」，不是「跑了整个仓库」。 */
  isFullInventory: boolean;
  /** **实际**有没有参与删除对账（全量 + 跟踪分支两道闸门都成立才为 true）。 */
  reconciled: boolean;
  caseTotal: number;
  passedCount: number;
  failedCount: number;
  requestCount: number;
  addedCount: number;
  removedCount: number;
  updatedCount: number;
  unmatchedCount: number;
  unplacedCount: number;
  sdkName: string;
  sdkVersion: string;
  warnings: string[];
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
};

export type IngestRecord = {
  id: string;
  phase: "setup" | "call" | "teardown";
  paramId?: string;
  seq: number;
  method: string;
  pathRaw: string;
  pathNormalized?: string;
  statusCode?: number;
  latencyMs?: number;
  passed?: boolean;
  error?: string;
  requestSummary: Record<string, unknown>;
  createdAt: string;
  caseName?: string;
  caseKey?: string;
  endpointName?: string;
  /** 打到的登记接口（未匹配为 undefined）。服务端 mapIngestRecord 一直回，用例抽屉的
      「该接口」高亮按它比对。 */
  endpointId?: string;
};

export type IngestRunDetail = IngestRun & { records: IngestRecord[] };

/**
 * 未匹配诊断视图的一行（边界 20）。
 *
 * **这是诊断视图，不是待办清单**：界面上不要待处理计数、不要红点、不要「全部处理」，
 * 也不要「补登记接口」的按钮。三样字段都是**读时标注**而不是判定——`phases` 里集中在
 * `setup` 的几乎一定是跨系统前置，`registeredInProjects` 空着不代表「这是我们的」
 * （别人还没做自动化时它就是空的）。
 */
export type UnmatchedPath = {
  method: string;
  path: string;
  hitCount: number;
  caseCount: number;
  caseNames: string[];
  phases: { setup: number; call: number; teardown: number };
  lastSeenAt?: string;
  /** 别的项目登记过这条路径，只有项目名。从不参与任何判定。 */
  registeredInProjects: string[];
};

/** 人工标注的外部依赖前缀。只影响诊断列表的显示，不影响任何统计。 */
export type IngestPathRule = { id: string; pathPrefix: string; note: string; createdAt: string };

/* ── P4.5: pipeline run（P4.5-11 执行详情页 + P4.5-13 报告视图） ─────────────── */

/**
 * 一条仓库任务（服务端 `mapCiTask` 的前端副本）。
 *
 * P4.5-9 只读它的身份字段（选任务用）；完整 CRUD 表单是 P4.5-11。任务级 secret 在
 * P4.5-14 被删掉了——敏感值现在只有明文 `env` 一条路（代价见服务端注释）。
 */
export type CiTask = {
  id: string;
  projectId: string;
  /**
   * 任务自带的 clone 来源（P4.5-14）。`gitCredentialId` 为空 = 公开仓库。
   *
   * 与 `Repository.gitUrl` 同名不同角色：后者是上报身份，这里只回答「Runner 去哪 clone」。
   * 搬到任务上的理由是配置顺序——仓库行只能由第一次上报创建。
   */
  gitUrl: string;
  gitCredentialId?: string;
  gitCredentialName?: string;
  gitCredentialMethod?: GitCredential["method"];
  name: string;
  description: string;
  gitRef: string;
  runnerLabel: string;
  sandboxMode: "process" | "container";
  isolationMode: "shared";
  image: string;
  steps: string;
  env: Record<string, string>;
  cachePaths: string[];
  cacheKeyFiles: string[];
  /**
   * 从 `steps` 里解析出的 allure 结果目录，**服务端算的只读派生值**。
   *
   * 报告格式下拉与路径输入框在 P4.5-14 一起删了：目录已经写在命令里
   * （`--alluredir=…`）。为 `null` 时界面提示「跑完不会有报告」——提示而不是拦保存，
   * 因为它可能写在用户仓库的 `pytest.ini` 里，平台看不见那份文件。
   */
  allureDir: string | null;
  sdkIngestEnabled: boolean;
  /**
   * 终态结果通知（P4.5-12）。**与套件复用同一个类型**：形状逐字相同，只有占位符词表不同
   * （CI 语境：{{taskName}} {{runNumber}} {{status}} {{passedCount}} {{failedCount}}
   * {{skippedCount}} {{total}} {{duration}} {{gitRef}} {{commitSha}} {{trigger}}
   * {{finishedAt}}）。
   */
  notify: SuiteNotifyConfig;
  /**
   * 任务级串行（P4.5-12）。默认开：同一份仓库用例并发跑两遍互不干扰，是需要被证明的
   * 性质而不是默认成立的性质。语义是**排队而不是拒绝**——触发照常受理，只是要等前一条。
   */
  singleConcurrency: boolean;
  timeoutSeconds: number;
  enabled: boolean;
  /**
   * 任务当前在途（排队/执行中）的最新一条 run：列表页的行内提示，点击直达 run 详情。
   * 只有列表接口填充，其余调用方为 `undefined`（「未知」，不与「没有在途」混同——后者
   * 是 `activeRunCount` 为 0）。
   */
  activeRun?: { id: string; runNumber: number; status: PipelineRun["status"] };
  /** 在途条数：串行任务恒 ≤1；关掉串行后可并行多条。仅列表接口填充。 */
  activeRunCount?: number;
  /**
   * 最近一条执行（任何状态）与历史总条数。仅列表接口填充。
   *
   * `activeRun` 只在有在途 run 时存在——跑完的任务收起来后就既没有状态也没有规模。
   * 这两个字段让收起的任务行自己回答「上次是过还是挂、一共跑过几次」。
   */
  lastRun?: { id: string; runNumber: number; status: PipelineRun["status"] };
  /** 历史执行总条数。`0` = 从没跑过；`undefined` = 这个读法没查（详情/编辑页）。 */
  runTotal?: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * 勾选执行的任务推荐（§8.3）。
 *
 * `ciTaskId` 为 null = 没有历史命中，由前端按「只有一个任务就用它、多个让用户选」处理
 * （P4.5-14 删掉了「默认任务」那一档兜底）。
 */
export type CiTaskRecommendation = {
  ciTaskId: string | null;
  reason: "recent_hit" | null;
  /** `recent_hit` 时：这个任务最近上报过勾选集里的几条。 */
  hitCount: number;
  caseKeyTotal: number;
};

/** 一次 CI 任务的执行（服务端 PipelineRun mapper 的前端副本）。 */
export type PipelineRun = {
  id: string;
  projectId: string;
  ciTaskId: string;
  /** 详情路由带出的任务名（P8-6）：面包屑显示「任务名 #序号」，与执行记录行的
      身份同一个词；列表路由不带。 */
  taskName?: string;
  executionIndexId?: string;
  runNumber: number;
  status: "queued" | "claimed" | "running" | "cancelling" | "success" | "failed" | "canceled" | "aborted" | "timed_out";
  stage: "pending" | "clone" | "cache" | "script" | "report" | "done";
  runnerLabel: string;
  sandboxMode: string;
  runnerId?: string;
  leaseExpiresAt?: string;
  triggerSource: TriggerSource;
  triggerRefName?: string;
  triggerSourceUrl?: string;
  triggeredBy?: string;
  gitRef: string;
  commitSha: string;
  caseFilter?: { caseKeys: string[] };
  parameters: Record<string, unknown>;
  exitCode?: number;
  error?: string;
  logBytes: number;
  caseTotal: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  ingestRunId?: string;
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  finishedAt?: string;
} & TriggeredByEmail;

/** 报告解析出的 case 级结果（junit/allure；时间戳是 allure 的 epoch 毫秒）。 */
export type PipelineRunCase = {
  id: string;
  pipelineRunId: string;
  source: "junit" | "allure";
  suiteName: string;
  caseName: string;
  guessedCaseKey?: string;
  status: "passed" | "failed" | "skipped" | "error";
  durationMs: number;
  message?: string;
  startedAtMs?: number;
  finishedAtMs?: number;
  host?: string;
  thread?: string;
  /** 该失败行当前的人工归因（P8-3；failed/error 行才可能有值，undefined = 未归因）。 */
  attribution?: FailureAttributionLite;
};

/** 一份已上传产物（列表读法带下载直链）。 */
export type Artifact = {
  id: string;
  projectId: string;
  ownerType: "pipeline_run";
  ownerId: string;
  kind: "log" | "report" | "file";
  name: string;
  storageDriver: "fs" | "s3";
  storageKey: string;
  sizeBytes: number;
  contentType: string;
  checksum: string;
  uploadedAt?: string;
  createdAt: string;
};

/**
 * CI 任务的写入体（P4.5-11）。
 *
 * 全部可选是**部分覆盖**语义：PUT 时缺省的字段保持原值（服务端 `mergeDraft`）。
 * `secrets` 是 patch（字符串写、`null` 删、缺省不动）——客户端从未持有明文，发不回全量。
 * `repositoryId` 不在这里：代码来源只读，继承项目唯一仓库（交互 3.12.2）。
 */
export type CiTaskInput = {
  name?: string;
  description?: string;
  gitUrl?: string;
  /** `null` 是显式的「不用凭据」（公开仓库）；缺省 = 不动。 */
  gitCredentialId?: string | null;
  gitRef?: string;
  runnerLabel?: string;
  sandboxMode?: "process" | "container";
  image?: string;
  steps?: string;
  env?: Record<string, string>;
  cachePaths?: string[];
  cacheKeyFiles?: string[];
  sdkIngestEnabled?: boolean;
  /** 整块覆盖（与套件同款）：缺省 = 不动，给了就整份写。 */
  notify?: SuiteNotifyConfig;
  singleConcurrency?: boolean;
  timeoutSeconds?: number;
  enabled?: boolean;
};

/** Git 凭据的写入体。`credential` 是明文，只在这一个方向出现（更新时缺省 = 不换）。 */
export type GitCredentialInput = {
  name: string;
  method: GitCredential["method"];
  credential?: string;
};

/**
 * 一个 Runner 标签下的池状态（`/system/runner-pool`，任何能看这个项目的人可读）。
 *
 * 与 `RunnerLabelStatus`（BullMQ worker 的分区目录）**不是**一回事：那是平台内部执行器，
 * 这是自托管 Runner。`queued` 是**跨项目的全局数**——认领扫描按标签取全平台最早的那条，
 * 所以「我前面排着几个」的真实答案就是全局的。
 */
export type RunnerPoolLabel = {
  label: string;
  /** 可认领的台数（在线且不 draining）/ 注册台数。多标签 Runner 在每个标签下各算一次。 */
  online: number;
  total: number;
  /** 可认领 Runner 的槽位之和（不按标签数均摊——跑哪个标签的 job 由 claim 决定）。 */
  capacity: number;
  inflight: number;
  queued: number;
};

export type RunnerPool = {
  offlineAfterSeconds: number;
  labels: RunnerPoolLabel[];
  /** 合计从 runner 行算，不是把 labels 求和（一台多标签机器只算一台）。 */
  online: number;
  total: number;
  capacity: number;
  inflight: number;
  queued: number;
};

/**
 * 一张 Runner 注册 Token（系统管理员）。明文只在创建响应里出现一次。
 *
 * `labels` 是**这张 token 允许声明的分区**：注册时校验 `runner.labels ⊆ token.labels`，
 * 否则任何拿到 token 的机器都能自称在生产网段并领那边的任务。
 */
export type RunnerToken = {
  id: string;
  name: string;
  /** 明文前 8 位，供列表辨认，不足以反推 Token。 */
  tokenPrefix: string;
  labels: string[];
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  createdAt: string;
  runnerCount?: number;
};

/**
 * 一台已注册的 Runner（系统管理员）。
 *
 * 与 `Worker` 是两张表两个概念：「执行器」是平台内部 BullMQ worker，「Runner」是自托管、
 * 跑仓库代码的机器。界面上要挨着放并写明区别（8.6）。
 */
export type Runner = {
  id: string;
  runnerTokenId: string;
  runnerTokenName?: string;
  name: string;
  labels: string[];
  capacity: number;
  sandboxModes: ("process" | "container")[];
  /** 容器档通道（Runner 自报）：`cli`（docker run 命令）/ `api`（Engine API over socket）。
      缺席 = 这台机器没自报（进程档 only 或旧版 Runner）。 */
  dockerTransport?: string;
  version: string;
  protocolVersion: string;
  /** `draining` 是唯一一个人可以改的值：不再参与 claim，在跑的任务跑完。 */
  status: "online" | "draining" | "offline";
  /** 由查询按心跳新鲜度算出，从不存储。 */
  online: boolean;
  lastSeenAt: string;
  registeredAt: string;
};

export type RunnerFleet = {
  runners: Runner[];
  offlineAfterSeconds: number;
  capacity: number;
  online: number;
  total: number;
};

/** 报告视图（P4.5-13）：allure-results 包在服务端解析后的归一形状。 */
export type AllureReportAttachment = {
  /** allure 的展示名（log / stdout / 截图名）。 */
  name: string;
  /** 报告包内的实体文件名（allure 的 `source`）——附件下载路由按它取数。 */
  source: string;
  /** allure 报的媒体类型；空串时按扩展名猜。 */
  type: string;
};

export type AllureReportStep = {
  name: string;
  status: string;
  start?: number;
  stop?: number;
  children?: AllureReportStep[];
  attachments?: AllureReportAttachment[];
};

export type AllureReportCase = {
  uid: string;
  name: string;
  fullName: string;
  /** 注释（pytest 的 docstring 落这里）；没有时为 null。 */
  description: string | null;
  suiteName: string;
  parentSuiteName: string;
  status: string;
  message: string | null;
  trace: string | null;
  start?: number;
  stop?: number;
  durationMs: number;
  host: string | null;
  thread: string | null;
  parameters: { name: string; value: string }[];
  labels: { name: string; value: string }[];
  steps: AllureReportStep[];
  /** fixture（container 的 before/after）：case 执行前后做了什么。 */
  befores: AllureReportFixture[];
  afters: AllureReportFixture[];
  attachments: AllureReportAttachment[];
};

export type AllureReportFixture = {
  name: string;
  type: "before" | "after";
  status: string;
  start?: number;
  stop?: number;
  steps: AllureReportStep[];
  attachments: AllureReportAttachment[];
};

export type AllureReportContainer = {
  uid: string;
  children: string[];
  befores: AllureReportFixture[];
  afters: AllureReportFixture[];
};

export type AllureReportView = {
  cases: AllureReportCase[];
  containers: AllureReportContainer[];
  /** 附件实体名（source）→ content-type。 */
  attachments: Record<string, string>;
  skippedFiles: number;
};
export type ExecutionSourceFilter = "endpoint_debug" | "test_case" | "flow_step" | "all";
/** `from`/`to`（ISO 时间戳，下钻前置——统计页趋势桶点击进来的时间窗）与 `caseId`
 *  （TopN 用例维的失败记录筛选）由服务端 400 兜底非法值，前端只透传。 */
export type ExecutionFilters = { status?: string; endpointId?: string; source?: ExecutionSourceFilter; caseId?: string; from?: string; to?: string; page?: number; pageSize?: number };
/** Paged reads keep `total` so the UI can show real page controls. */
export type Paged<T> = { items: T[]; page: number; pageSize: number; total: number };

/* 缺省走相对路径 `/api/v1`（同源）——dev 由 Vite proxy、生产由 Nginx 反代到后端，避免跨源/CORS。
   设了 `VITE_API_BASE_URL`（绝对地址）时改为直连该地址（双域名不反代的逃生口）。 */
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

const client = axios.create({ baseURL: BASE_URL });

client.interceptors.request.use((config) => {
  const token = localStorage.getItem("apitest.token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * 401 / 403 的统一出口（P6-5，计划 10.0 边界 8）。
 *
 * 公开页前缀（/login、/register、/share）对两个分支都豁免：登录/注册页的 401 / 403
 * 是「凭据不对 / 邀请码无效或被吊销」的领域语义，页面有自己的分路报错——全局重定向
 * 会把错误抹掉，全局 toast 又词不达意；分享页是公开落地页，匿名访客不该被一枚过期
 * token 从公开报告页踢去登录。
 *
 * - **401**：token 失效（过期 / 改密后 pwdEpoch 不等 / 账号被禁用）。清 token 并带
 *   `returnTo` 硬跳登录——硬导航连内存里的 store 一起重置，比在拦截器里反向 import
 *   authStore（会与它 import api 成环）干净。
 * - **403**：顶部提示无权限、**不跳转**——用户可能正停在刚被降权的编辑页上，跳走会
 *   丢上下文。限 3 秒一条：一页并发请求同时撞 403 时不该弹出五条叠着的 toast。
 */
const PUBLIC_PATH_PREFIXES = ["/login", "/register", "/share"];
let lastForbiddenToastAt = 0;

client.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = (error as { response?: { status?: number } })?.response?.status;
    const isPublicPath = PUBLIC_PATH_PREFIXES.some((prefix) => window.location.pathname.startsWith(prefix));
    if (status === 401) {
      localStorage.removeItem("apitest.token");
      if (!isPublicPath) {
        const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.assign(`/login?returnTo=${returnTo}`);
      }
    } else if (status === 403 && !isPublicPath) {
      const now = Date.now();
      if (now - lastForbiddenToastAt > 3000) {
        lastForbiddenToastAt = now;
        message.error(i18next.t("errors.forbidden"));
      }
    }
    return Promise.reject(error);
  },
);

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

/**
 * 「统计窗口过大」的判定（P8-4 边界 23，错误码 2005 = statement_timeout 5s 触顶）。
 *
 * 与 noRunnerLabel 同一层：单一实现，靠码分路——字符串嗅探会随文案改版失效。调用方
 * （P8-6 统计页 / 看板）按它渲染「缩小时间范围」的空态，不白屏。
 */
export function isStatsTimeoutError(error: unknown): boolean {
  const body = (error as { response?: { data?: { code?: number } } })?.response?.data;
  return body?.code === 2005;
}

/**
 * `/stats/*` 的查询串拼装：undefined/null 不发（服务端有缺省）；数组（projectIds）
 * 折成逗号串。days/limit 等数值由调用方保证形状，这里不做二次校验。
 */
function statsParams(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    out[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return out;
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

/* ── P6-2: 用户管理 + 审计日志（系统管理员） ──────────────────────────────── */

/**
 * 管理面用户行（`/system/users*`）。`initialPassword` 只出现在建号与重置密码那一次
 * 响应里——与 Runner Token / 仓库凭据同一条「明文只出现一次」纪律。
 */
export type ManagedUser = {
  id: string;
  email: string;
  name: string;
  isSystemAdmin: boolean;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** 审计日志行：userEmail / projectName 是读时快照，系统级动作两者皆空。 */
export type AuditLog = {
  id: number;
  projectId?: string;
  projectName?: string;
  userId?: string;
  userEmail?: string;
  action: string;
  targetType: string;
  targetId?: string;
  detail: Record<string, unknown>;
  ip: string;
  createdAt: string;
};

/* ── P10-5：资产版本（读侧）——版本列表 / 两版 diff / 回滚 ───────────────────── */

/** 版本覆盖的资产类型（与后端 AssetVersionType / 迁移 067/068 的 CHECK 同步）。P10-6 扩面到
    7 类用户编写型内容资产（Mock/脚本/流程/套件/数据源/SQL 定义/仓库任务）。 */
export type AssetVersionType =
  | "endpoint" | "test_case" | "spec_case" | "environment"
  | "mock" | "script" | "flow" | "test_suite" | "data_source" | "sql_definition" | "ci_task";

/**
 * 一个资产的一版内容快照。`snapshot` 是与该资产 API 出参同形的内容子集（环境的
 * secrets 只含键名，绝不含值）。`createdByEmail` = 谁在何时存的（读侧 JOIN users 带出）。
 */
export type AssetVersion = {
  id: string;
  projectId: string;
  assetType: AssetVersionType;
  assetId: string;
  versionNo: number;
  snapshot: Record<string, unknown>;
  /** 动作标签：创建 / 更新 / 复制 / 回滚至 vN。 */
  changeSummary: string;
  createdByEmail?: string | null;
  createdAt: string;
};

/** 逐行 diff 的一行（服务端算好，前端只上色）。 */
export type LineDiff = { kind: "add" | "del" | "same"; text: string };

/** 一个顶层字段的 diff：kind + 逐行着色。环境 secret 只在 secretKeys 字段上显示键名增删。 */
export type FieldDiff = {
  field: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
  lines: LineDiff[];
};

/** 两版 diff 结果：有改动的字段 + 「一处未改」标记。 */
export type SnapshotDiff = { fields: FieldDiff[]; identical: boolean };

/** diff 接口响应：比对的两版号（from 可为 null，表示只有一版、与空比）+ diff。 */
export type AssetVersionDiff = { from: number | null; to: number; diff: SnapshotDiff };

/* ── P6-3: 邀请码 + 注册 + 强制改密 ─────────────────────────────────────────── */

/**
 * 邀请码行（`/system/invitations*`）。`token`（明文码）只附加在签发那一次的响应里；
 * 列表行只有 `tokenPrefix`。`createdByEmail` / `consumedByEmail` 回答「谁签的、
 * 被谁用了」——预分配的 `projectId` + `role` 决定注册后落什么角色。
 */
export type Invitation = {
  id: string;
  note: string;
  projectId?: string;
  role?: "project_admin" | "developer" | "viewer";
  tokenPrefix: string;
  createdBy?: string;
  createdByEmail?: string;
  expiresAt: string;
  consumedAt?: string;
  consumedBy?: string;
  consumedByEmail?: string;
  revokedAt?: string;
  createdAt: string;
};

/* ── P6-4: 项目成员 ──────────────────────────────────────────────────────────── */

/**
 * 成员行（`GET /projects/:id/members`，viewer 可读——「知道找谁要权限」）。email/name
 * 是读时快照（用户改名后成员表跟着新名走）；`grantedByEmail` 回答「谁把谁加进来的」。
 */
export type ProjectMember = {
  userId: string;
  email: string;
  name: string;
  status: "active" | "disabled";
  role: ProjectRole;
  grantedBy?: string;
  grantedByEmail?: string;
  grantedAt: string;
};

/**
 * 权限申请（P14-2）：非成员自助申请加入、或成员申请提权（P16-1）的一条记录。
 * `suggestedRole` 可空（加入申请未带建议，最终角色以批准动作为准；提权申请必带且
 * 高于 `fromRole`）。`fromRole` 是申请提交时的角色快照：null = 加入申请，有值 =
 * 提权申请（审批列表据此显示「当前 X → 申请 Y」）。按视角带出快照：管理员审批列表看
 * `applicantEmail` / `applicantName` / `handledByEmail`，本人「我的申请」看
 * `projectName`——缺列即 null。
 */
export type AccessRequest = {
  id: string;
  projectId: string;
  projectName: string | null;
  userId: string;
  applicantEmail: string | null;
  applicantName: string | null;
  fromRole: ProjectRole | null;
  suggestedRole: ProjectRole | null;
  status: "pending" | "approved" | "rejected";
  handledBy: string | null;
  handledByEmail: string | null;
  handledAt: string | null;
  note: string;
  createdAt: string;
};

/** 添加成员的候选行（project_admin 的收窄目录读：三列、只 active、只非成员）。 */
export type MemberCandidate = { id: string; email: string; name: string };

/* ── P7: 测试管理（文本用例） ────────────────────────────────────────────────── */

/**
 * 模块树行（`GET /projects/:id/spec-modules`，P7-1）：拍平的森林，前端按 parentId
 * 挂接。`caseCount` 是该模块**直属**用例数（含全部状态——导航口径，非覆盖口径）；
 * `activeCount` / `automatedCount` 是覆盖口径（P7-6）：直属已评审用例数与其中
 * 「已自动化」（≥1 条非 endpoint 绑定）的条数，子树求和归前端。
 */
export type SpecModule = {
  id: string;
  projectId: string;
  parentId?: string;
  name: string;
  path: string;
  position: number;
  caseCount?: number;
  activeCount?: number;
  automatedCount?: number;
  createdAt: string;
  updatedAt: string;
} & Ownership;

/** 文本用例的一个步骤：步骤 + 预期成对（行内两列）。 */
export type SpecCaseStep = { step: string; expected: string };

export type SpecCasePriority = "P0" | "P1" | "P2" | "P3";
/** 用例生命周期（㉘）：unreviewed 未评审 → reviewed 已评审 → deprecated 废弃。 */
export type SpecCaseStatus = "unreviewed" | "reviewed" | "deprecated";

/**
 * 文本用例行（P7，第三类用例资产——只有设计内容，平台不执行它）。`modulePath` /
 * `linkCount` 只在列表与详情读法里带出；`itemKey` 是服务端生成的项目内自增编号
 * （TC-001，新建时分配，只读）。绑定接口在 P7-3 之前 linkCount 恒为 0。
 */
export type SpecCase = {
  id: string;
  projectId: string;
  moduleId: string;
  modulePath?: string;
  itemKey?: string;
  title: string;
  preconditions: string;
  steps: SpecCaseStep[];
  priority: SpecCasePriority;
  tags: string[];
  status: SpecCaseStatus;
  source?: string;
  linkCount?: number;
  /** 已自动化（P7-6）：有 ≥1 条非 endpoint 绑定（与筛选、覆盖口径同一表达式）。 */
  automated?: boolean;
  /** 绑定清单：只有详情读法带（列表行不带，抽屉挂载时按 id 现拉）。 */
  links?: SpecCaseLink[];
  createdAt: string;
  updatedAt: string;
  /**
   * 归属（P11 边界 7/9）：**只有创建人**。`spec_cases` 从 P7 起就有 `created_by`，但按
   * 边界 2 没有 `updated_by` 列（后端 `SpecCase` 同一句话），所以列表**只加「创建人」一列**
   * ——一列永远显示「—」比不显示更糟（边界 9 原写「两列」，这里按数据事实收成一列）。
   * 要「更新人」得先给表加列（另立项）。
   */
  createdByEmail?: string | null;
};

/** 手工建/改的提交体（后端 `validateSpecCase` 同一套约束）。编号由服务端自增生成，不进提交体。 */
export type SpecCaseInput = {
  moduleId?: string;
  title?: string;
  preconditions?: string;
  steps?: SpecCaseStep[];
  priority?: SpecCasePriority;
  tags?: string[];
  status?: SpecCaseStatus;
};

/** 绑定目标四类（P7-6，边界 8）：endpoint 表达「该测什么」，不算自动化。 */
export type SpecLinkTargetType = "endpoint" | "case" | "flow" | "repo_case";

/** 绑定行的最近自动化结果（读时关联，服务端绝不回写）。 */
export type SpecLinkLastResult = {
  status: string;
  at?: string;
  /** 深链目标：executions 行 id（case/flow）或 pipeline run id（repo_case）。 */
  runId?: string;
};

/**
 * 一条绑定行（P7-6，详情 `links[]`）。`targetName` 缺席 = 目标已删除；
 * repo_case 的 `targetStatus === 'removed'` = 对账判失效（「目标已失效」）。
 */
export type SpecCaseLink = {
  id: string;
  specCaseId: string;
  targetType: SpecLinkTargetType;
  targetId: string;
  targetKey?: string;
  targetName?: string;
  targetStatus?: string;
  /** 仅 case：宿主接口 id（读时关联；拼 `endpoints/:id?case=` 深链用）。 */
  targetEndpointId?: string;
  lastResult?: SpecLinkLastResult;
  createdAt: string;
};

/** 列表筛选（服务端分页 + 筛选，计划 11.2）：`path` 是模块路径前缀（含全部子级），
    `moduleId` 是单模块直属精确匹配；`automation` 已自动化筛选（P7-6 起 UI 接入——
    有 ≥1 条非 endpoint 绑定才算，与覆盖口径同一表达式）。 */
export type SpecCaseFilters = {
  keyword?: string;
  path?: string;
  moduleId?: string;
  priority?: SpecCasePriority;
  status?: SpecCaseStatus;
  automation?: "yes" | "no";
  page?: number;
  pageSize?: number;
};

/** 导入的层级映射只有 tc: 标记一种（2026-09-08 用户收窄：「叶子即用例」解析出的
 *  全是碎片，删除；无 tc 约定的文件解析为 0 条，如实返回）。 */

/** 逐条判定（preview）：新增 / 已存在未变 / 已存在有变 / 文件内重复（后者是平台侧
    补的第四态——同文件里同名同路径的行不该被二次落库）。 */
export type SpecImportJudgment = "new" | "unchanged" | "changed" | "duplicate";

/** 归一化用例（preview 返回与 commit 提交共用一个形状；XMind 无编号位，itemKey 恒空）。 */
export type SpecImportCase = {
  modulePath: string;
  title: string;
  preconditions: string;
  steps: SpecCaseStep[];
  priority: SpecCasePriority;
  tags: string[];
  itemKey?: string | null;
  /** 模块链超过 6 层被截断——预览里如实标出来，否则「目录少一层」读作丢数据。 */
  pathClamped?: boolean;
};

export type SpecImportPreviewCase = SpecImportCase & {
  judgment: SpecImportJudgment;
  existingId?: string;
};

export type SpecImportPreview = {
  /** 工作簿格式：json = 新版（content.json），xml = 旧版 XMind 8（content.xml，兼容读取），
      excel = 固定模板 .xlsx（P7-5）。 */
  format: "json" | "xml" | "excel";
  cases: SpecImportPreviewCase[];
  summary: {
    total: number;
    new: number;
    unchanged: number;
    changed: number;
    duplicate: number;
    exceededLimit: boolean;
  };
};

export type SpecImportCommitResult = {
  created: number;
  updated: number;
  skipped: number;
  duplicate: number;
  modulesCreated: number;
};

/** 导出格式（2026-09-08 用户要求）：XMind 脑图快照（回导走 (路径,标题) 判重）/
    Excel 模板同列（带编号，回导按编号判重）。 */
export type SpecExportFormat = "xmind" | "excel";

/* ── P7-7: 测试计划 ───────────────────────────────────────────────────────── */

/** 计划项结果四值（第五态「未执行」是 result 缺席，边界 12）。 */
export type TestPlanItemResult = "passed" | "failed" | "blocked" | "skipped";

/**
 * 一个测试计划（列表行与详情头共用）：一批文本用例的一次手工执行记录。
 * `summary` 五计数由服务端一条分组子查询算好（通过率 = passed/(passed+failed)、
 * 进度 = 已标记/total 的口径只产在一个地方）；未执行数 = total - 四者之和。
 */
export type TestPlan = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: "open" | "closed";
  owner?: string;
  ownerName?: string;
  startedOn?: string;
  dueOn?: string;
  summary: { total: number; passed: number; failed: number; blocked: number; skipped: number };
  createdAt: string;
  updatedAt: string;
};

/**
 * 一个计划项：`titleSnapshot` / `modulePathSnapshot` 是入计划时的冻结快照（用例
 * 改名/移动后旧计划仍读得通）；`specCaseKey` / `specCaseStatus` 是活数据，用例
 * 被删后缺席（读「用例已删除」）。（自动化参考列 2026-09-09 整列删除。）
 */
export type TestPlanItem = {
  id: string;
  planId: string;
  specCaseId?: string;
  titleSnapshot: string;
  modulePathSnapshot: string;
  assignee?: string;
  assigneeName?: string;
  result?: TestPlanItemResult;
  note: string;
  defectUrl?: string;
  executedAt?: string;
  specCaseKey?: string;
  specCaseStatus?: string;
};

export type TestPlanDetail = TestPlan & { items: TestPlanItem[] };

export type TestPlanInput = {
  name?: string;
  description?: string;
  status?: "open" | "closed";
  owner?: string | null;
  startedOn?: string | null;
  dueOn?: string | null;
};

export type TestPlanItemInput = {
  assignee?: string | null;
  result?: TestPlanItemResult | null;
  note?: string;
  defectUrl?: string;
};

/* ── P8: 失败归因（计划十二章 12.1；REST 在 P8-2，入口 UI 在 P8-3）──────────── */

/** 归因目标三类（边界 4：叶子失败——接口执行行 / 仓库 run 的 case 行 / 非 HTTP 步骤行）。 */
export type AttributionTargetType = "execution" | "pipeline_run_case" | "execution_step";

/** 归因分类字典行（平台级一份，边界 5）。停用项不进打标选项，但历史行照常显示。 */
export type FailureCategory = {
  code: string;
  name: string;
  position: number;
  active: boolean;
};

/** 一条失败的归因（边界 6：一条失败只有一个；重打标覆盖）。 */
export type FailureAttribution = {
  id: string;
  projectId: string;
  targetType: AttributionTargetType;
  targetId: string;
  category: string;
  note: string;
  /** 绑定的 bug 链接（P8-3 验收反馈；空串 = 未绑定）。 */
  bugUrl: string;
  source: "human" | "mcp";
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * 行内嵌的归因读数（P8-3）：报告成员行 / CI 用例行 / 报告列表聚合随行带出的展示形状。
 * `categoryName` 服务端冗余好——读侧显示不再依赖字典请求（分享页免登录更不能发）。
 * undefined = 未归因（没有行 = 未归因，边界 7）。
 */
export type FailureAttributionLite = {
  category: string;
  categoryName: string;
  note: string;
  /** 绑定的 bug 链接；空串 = 未绑定。 */
  bugUrl: string;
  source: "human" | "mcp";
  updatedAt: string;
};

/** 报告列表行的归因聚合（P8-3）：失败行里有多少已归因、都归成了什么（按条数降序）。 */
export type ReportAttributionSummary = {
  failed: number;
  attributed: number;
  categories: { code: string; name: string; count: number }[];
};

/* ── P5 起家 / P12 改形的 MCP（Token 归人、绑定归项目 + 工具清单展示） ────────── */


/** scope 三值（计划 9.0 边界 1）：read 恒在，write / execute 绑定项目时显式勾选。 */
export type McpScope = "read" | "write" | "execute";

/**
 * 绑定（P12 边界 2）：`scope` 挂在绑定上而不是 Token 上——一把 Token 绑 N 个项目时
 * 「A 可写、B 只读」必须可表达。read 恒在（服务端归一，写与执行的工具都要求先能读）。
 */
export type McpBinding = { projectId: string; scope: McpScope[]; boundAt?: string };

/**
 * 用户级的 MCP Token 行（P12：列表 / 签发 / 吊销响应共用）。`token_hash` 永不出现
 * 在 API 面（`mapMcpToken` 刻意不映射它）；明文 `token` 只附加在签发那一次的响应里。
 *
 * Token 本体**没有 `projectId` 也没有 `scope`**——两者都在 `bindings` 上；`createdBy`
 * 为空 = 签发人已被删，整把 Token 失效（鉴权侧 401）。
 */
export type McpToken = {
  id: string;
  name: string;
  /** 明文前 8 位（`apimcp_` 之后那段），供列表辨认，不足以反推 Token。 */
  tokenPrefix: string;
  bindings: McpBinding[];
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  createdAt: string;
};

/** 可绑定项目（`/me/bindable-projects`）：本人有角色的项目 + 该角色的 scope 上限。 */
export type BindableProject = { projectId: string; name: string; role: MyRole; maxScope: McpScope[] };

/**
 * 项目侧看到的绑定行（`GET /projects/:id/mcp/bindings`）：回答「谁的钥匙开了我这扇门」。
 * owner 三列是读时 JOIN 快照——项目管理员要能指着具体的人说「这把钥匙收回来」。
 */
export type McpProjectBinding = {
  tokenId: string;
  tokenName: string;
  tokenPrefix: string;
  ownerId: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  scope: McpScope[];
  lastUsedAt?: string;
  boundAt: string;
};

/** 工具清单行（前端展示用，非 MCP 协议面）：description 是给模型读的原文，不翻译。 */
export type McpToolSummary = { name: string; description: string; scope: McpScope };

/**
 * MCP 绑定许可申请（2026-09-21，迁移 070）。成员在项目 MCP 页申请角色上限之外的
 * write / execute 档位；批准行本身就是授权（有效 scope 实时聚合，服务端
 * `lib/mcpScopes.ts`）——批的是「这个项目里能绑哪几档」，不是角色。
 */
export type McpBindingRequest = {
  id: string;
  projectId: string;
  projectName: string | null;
  userId: string;
  applicantEmail: string | null;
  applicantName: string | null;
  scope: McpScope[];
  status: "pending" | "approved" | "rejected";
  handledBy: string | null;
  handledByEmail: string | null;
  handledAt: string | null;
  note: string;
  createdAt: string;
};

/** 个人中心基本信息（`GET /me/profile`，`/auth/me` 的聚合别名）。 */
export type MeProfile = { id: string; email: string; name: string; isSystemAdmin: boolean; mustChangePassword: boolean };

/** 用户级 API 密钥（个人中心，调用平台开放 API 的凭据）的元数据：读接口永不含明文。 */
export type ApiKey = { keyId: string; createdAt: string; rotatedAt: string };
/** 生成 / 轮换的一次性响应：`key` 是明文密钥，只出现这一次；`rotated` 区分覆盖了旧密钥。 */
export type ApiKeyIssued = ApiKey & { key: string; rotated: boolean };
/**
 * 构造 SQL 快速调用凭据的服务端产物。
 * - `token` 是本人 API 密钥加密的 `{projectId, sqlId}`（既是凭据又指明跑哪条定义）；
 * - `params` 是该定义的参数名清单，用来在 curl 的 `-d` 里生成一个可改的 body 模板。
 */
export type SqlQuickCall = { keyId: string; token: string; method: "POST"; params: string[] };

/**
 * 快速调用所用的 API 根地址（透出给用户看的「实际配置」）。
 *
 * 优先 `VITE_API_BASE_URL`（部署时配置的对外可达地址）；未配置时回退到**当前访问来源**
 * 的 3000 端口（与 `mcpEndpointUrl` 同一拼法）——而不是写死的 localhost，否则从局域网/
 * 线上访问时复制出来的地址对外部调用方不可用。末尾去掉多余斜杠。
 */
export function sqlQuickCallBaseUrl() {
  const base = import.meta.env.VITE_API_BASE_URL ?? `${window.location.origin.replace(/:\d+$/, ":3000")}/api/v1`;
  return String(base).replace(/\/$/, "");
}

/**
 * 拼一条可直接运行的 cURL：凭据放请求头 `Authorization: ApiKey <keyId>.<token>`，入参放
 * 请求体 `{ "param": { ... } }`（可动态改）。base 已含 /api/v1，随 curl 一起把实际配置透出。
 */
export function sqlQuickCallCurl(built: SqlQuickCall, param: Record<string, unknown>) {
  const url = `${sqlQuickCallBaseUrl()}/public/sql-quick-call`;
  const body = JSON.stringify({ param });
  return [
    `curl -X POST '${url}' \\`,
    `  -H 'Authorization: ApiKey ${built.keyId}.${built.token}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${body}'`,
  ].join("\n");
}

export const api = {
  /**
   * 登录响应带 `mustChangePassword`（P6-3）：为 true 时前端只放行 /change-password。
   * `expiresAt`（P6-5，ISO 串）是 token 的过期时刻，随 JWT_EXPIRES_IN（默认 7 天）。
   */
  login: (email: string, password: string) => client.post("/auth/login", { email, password }).then(data<{ token: string; expiresAt: string | null; user: User; mustChangePassword: boolean }>),
  me: () => client.get("/auth/me").then(data<User>),
  /**
   * 邀请码注册（P6-3，公开路由）。注册即登录（token 直接落地，注册完不再登一次）。
   * 过期（410）/吊销（403）/无效（401）/已用（409）各带不同 message，页面据此指路。
   */
  register: (input: { invite: string; email: string; name: string; password: string }) =>
    client.post("/auth/register", input).then(data<{ token: string; expiresAt: string | null; user: User }>),
  /**
   * 强制改密提交端（P6-5）：改密使旧 token 全部失效（pwdEpoch +1），响应带换发的
   * 新 token——前端必须落地替换，否则改完密下一个请求就 401 跳登录。
   */
  changePassword: (currentPassword: string, newPassword: string) =>
    client.post("/auth/change-password", { currentPassword, newPassword }).then(data<{ token: string; expiresAt: string | null; user: User; mustChangePassword: boolean }>),

  /** 邀请码列表（P6-3，系统管理员）：全量，未消费/未吊销在前。 */
  invitations: () => client.get("/system/invitations").then(data<Invitation[]>),
  /** 签发：明文码只在这一次响应里，丢了只能吊销重发。 */
  createInvitation: (input: { note?: string; projectId?: string; role?: "project_admin" | "developer" | "viewer" }) =>
    client.post("/system/invitations", input).then(data<Invitation & { token: string }>),
  /** 吊销即时生效（注册的候选查询排除吊销行）。 */
  revokeInvitation: (invitationId: string) =>
    client.post(`/system/invitations/${invitationId}/revoke`).then(data<Invitation>),

  dashboard: (filters?: ProjectFilters) => client.get("/dashboard", { params: projectParams(filters) }).then(data<Dashboard>),
  preferences: () => client.get("/system/preferences").then(data<Preferences>),
  updatePreferences: (input: Partial<Preferences>) => client.put("/system/preferences", input).then(data<Preferences>),
  /** Execution fleet status. System admin only; read-only (P1-3). */
  workers: () => client.get("/system/workers").then(data<WorkerFleet>),
  /** 执行预算与上限。任何能编辑流程或套件的人都要读它，所以不限系统管理员。 */
  systemLimits: () => client.get("/system/limits").then(data<PlatformLimits>),
  /** 分区标签目录：环境编辑器的分区建议与「无在线执行器」提示用。任何登录用户可读。 */
  runnerLabels: () => client.get("/system/runner-labels").then(data<RunnerLabelStatus[]>),
  /**
   * 执行历史的存储分区与归档现状（P10-2）。系统管理员，纯读。
   *
   * 与 `workers().partitions` 无关（那里是 P2-8 的网段标签），见 `ExecutionStoragePartition`。
   */
  executionPartitions: () => client.get("/system/execution-partitions").then(data<ExecutionPartitionView>),
  /**
   * 清理一张已脱离的归档分区：**删对象 → 断指针 → DROP**，不可逆。
   *
   * 这是平台里唯一会删除大响应体对象的通路。绕过它直接在 psql 里 DROP 会留下永久孤儿对象。
   */
  dropExecutionPartition: (name: string) =>
    client.delete(`/system/execution-partitions/${encodeURIComponent(name)}`).then(data<ExecutionPartitionDropResult>),
  /**
   * 自托管 Runner 池的**聚合**状态（P4.5-11）。任何登录用户可读——CI 任务列表顶部要
   * 显示「在线 / 槽位 / 空闲 / 排队 N 个」，而 Runner 清单（`runnerFleet`）只给系统
   * 管理员。与 `runnerLabels` 不是一回事：那是平台内部 BullMQ 执行器。
   */
  runnerPool: () => client.get("/system/runner-pool").then(data<RunnerPool>),
  /** Runner 清单 + 可认领容量。系统管理员，带机器身份信息。 */
  runnerFleet: () => client.get("/system/runners").then(data<RunnerFleet>),
  /** 只能改 status，且只在 online ↔ draining 之间（offline 是心跳算出来的事实）。 */
  updateRunner: (runnerId: string, status: "online" | "draining") =>
    client.patch(`/system/runners/${runnerId}`, { status }).then(data<Runner>),
  runnerTokens: () => client.get("/system/runner-tokens").then(data<RunnerToken[]>),
  /** 创建：`token` 明文**只在这一次响应里**，丢了只能吊销重发。 */
  createRunnerToken: (input: { name: string; labels?: string[] }) =>
    client.post("/system/runner-tokens", input).then(data<RunnerToken & { token: string }>),
  /** 吊销是软删（留 `revokedAt`）：硬删会级联掉 runners，「那台机器拿哪张 token 注册的」就答不出来了。 */
  revokeRunnerToken: (tokenId: string) =>
    client.delete(`/system/runner-tokens/${tokenId}`).then(data<RunnerToken>),
  /** 重新取回明文（2026-09-28 可重复复制）：可逆加密存储，丢了不必吊销重发。已吊销的取不到。 */
  runnerTokenSecret: (tokenId: string) =>
    client.get(`/system/runner-tokens/${tokenId}/secret`).then(data<{ id: string; token: string }>),

  /* ── P6-2：用户管理 + 审计日志 ── */
  /** 用户列表（keyword 在 SQL 过滤，覆盖全量；total 是全量命中数）。 */
  systemUsers: (filters?: { keyword?: string; page?: number; pageSize?: number }) =>
    client.get("/system/users", { params: { keyword: filters?.keyword?.trim() || undefined, page: filters?.page, pageSize: filters?.pageSize } }).then(paged<ManagedUser>),
  /** 建号：`initialPassword` 只在这一次响应里，首登强制改密。 */
  createSystemUser: (input: { email: string; name: string; isSystemAdmin?: boolean }) =>
    client.post("/system/users", input).then(data<ManagedUser & { initialPassword: string }>),
  /** 就地改 name / status / isSystemAdmin（partial，只发出现的键）。 */
  updateSystemUser: (userId: string, input: { name?: string; status?: "active" | "disabled"; isSystemAdmin?: boolean }) =>
    client.patch(`/system/users/${userId}`, input).then(data<ManagedUser>),
  /** 重置密码：新密码只在这一次响应里，`mustChangePassword` 同时置上。 */
  resetSystemUserPassword: (userId: string) =>
    client.post(`/system/users/${userId}/reset-password`).then(data<ManagedUser & { initialPassword: string }>),
  /** 全局审计日志（分页 + action / project 筛选）。 */
  auditLogs: (filters?: { page?: number; pageSize?: number; action?: string; projectId?: string }) =>
    client.get("/system/audit-logs", { params: { page: filters?.page, pageSize: filters?.pageSize, action: filters?.action?.trim() || undefined, projectId: filters?.projectId || undefined } }).then(paged<AuditLog>),
  /**
   * 项目级审计（P11-10 边界 7/8）：developer 及以上可读（viewer 403），支持
   * `action` / `targetType` / `targetId` 过滤与分页——资源详情的「变更历史」抽屉
   * 就是 `targetType + targetId` 这一路（缺省第 1 页、每页 50 条，与旧「最近 50 条」同量）。
   */
  projectAuditLogs: (projectId: string, filters?: { page?: number; pageSize?: number; action?: string; targetType?: string; targetId?: string }) =>
    client.get(`/projects/${projectId}/audit-logs`, {
      params: {
        page: filters?.page, pageSize: filters?.pageSize,
        action: filters?.action?.trim() || undefined,
        targetType: filters?.targetType?.trim() || undefined,
        targetId: filters?.targetId || undefined,
      },
    }).then(paged<AuditLog>),

  /* ── P10-5：资产版本（读侧）── */
  /**
   * 某资产的版本列表（viewer 可读，倒序、最新在前，带 snapshot 与「谁在何时存的」）。
   * `assetType` 走枚举，四类资产共用一条路由（后端统一版本模型）。
   */
  assetVersions: (projectId: string, assetType: AssetVersionType, assetId: string) =>
    client.get(`/projects/${projectId}/assets/${assetType}/${assetId}/versions`).then(data<AssetVersion[]>),
  /** 相邻两版 diff（最新与次新）；不足两版时 diff.identical 为 true。 */
  assetVersionLatestDiff: (projectId: string, assetType: AssetVersionType, assetId: string) =>
    client.get(`/projects/${projectId}/assets/${assetType}/${assetId}/versions/diff`).then(data<AssetVersionDiff>),
  /** 任意两版 diff（`a` 旧、`b` 新，与前端「左旧右新」一致）；服务端逐字段 + 逐行算。 */
  assetVersionDiff: (projectId: string, assetType: AssetVersionType, assetId: string, a: number, b: number) =>
    client.get(`/projects/${projectId}/assets/${assetType}/${assetId}/versions/${a}/diff/${b}`).then(data<AssetVersionDiff>),
  /**
   * 回滚到某一版（写权限）：把该版快照写回资产 → 再产一个新版本（不删历史）。
   * 环境回滚不复原 secret 值（快照只有键名），响应 `secretsPreserved` 为 true 时前端提示。
   * 环境重名等当下库状态冲突回 409，调用方按 apiMessage 展示。
   */
  rollbackAssetVersion: (projectId: string, assetType: AssetVersionType, assetId: string, versionNo: number) =>
    client.post(`/projects/${projectId}/assets/${assetType}/${assetId}/versions/${versionNo}/rollback`)
      .then(data<{ asset: unknown; rolledBackTo: number; secretsPreserved: boolean }>),

  /* ── P6-4：项目成员 ── */
  /** 成员表（viewer 可读；total = 成员数）。 */
  members: (projectId: string) =>
    client.get(`/projects/${projectId}/members`).then(data<ProjectMember[]>),
  /** 添加成员的候选搜索（project_admin）：keyword 空 = 最新 20 个可加的人。 */
  memberCandidates: (projectId: string, keyword: string) =>
    client.get(`/projects/${projectId}/members/candidates`, { params: { keyword: keyword.trim() || undefined } }).then(data<MemberCandidate[]>),
  /** 添加 / 就地改角色（upsert 语义；最后一个 project_admin 降级 409）。 */
  upsertMember: (projectId: string, input: { userId: string; role: ProjectRole }) =>
    client.post(`/projects/${projectId}/members`, input).then(data<ProjectMember>),
  /** 角色下拉就地改的落点。 */
  updateMemberRole: (projectId: string, userId: string, role: ProjectRole) =>
    client.patch(`/projects/${projectId}/members/${userId}`, { role }).then(data<{ userId: string; role: ProjectRole }>),
  /** 移除成员（角色行删除即失去访问，判定端每请求查库、即时生效）。 */
  removeMember: (projectId: string, userId: string) =>
    client.delete(`/projects/${projectId}/members/${userId}`).then(data<{ userId: string; removed: boolean }>),

  /* ── P14-2：权限申请审批流 ── */
  /** 提交申请（非成员）。suggestedRole 可选；已是成员 / 已有 pending 回 409。 */
  createAccessRequest: (projectId: string, input?: { suggestedRole?: ProjectRole }) =>
    client.post(`/projects/${projectId}/access-requests`, input ?? {}).then(data<AccessRequest>),
  /** 本项目申请列表（project_admin）；status 过滤可选。pending 置顶。 */
  accessRequests: (projectId: string, status?: "pending" | "approved" | "rejected") =>
    client.get(`/projects/${projectId}/access-requests`, { params: { status } }).then(data<AccessRequest[]>),
  /** 本人跨项目的申请与状态（全局层）。 */
  myAccessRequests: () =>
    client.get("/access-requests/me").then(data<AccessRequest[]>),
  /** 批准（= 既有成员 upsert）：role 可改定申请的建议角色；未给则用建议角色。 */
  approveAccessRequest: (id: string, role?: ProjectRole) =>
    client.post(`/access-requests/${id}/approve`, role ? { role } : {}).then(data<AccessRequest>),
  /** 拒绝（只记状态 + 可选 note）；被拒后可再申请。 */
  rejectAccessRequest: (id: string, note?: string) =>
    client.post(`/access-requests/${id}/reject`, note ? { note } : {}).then(data<AccessRequest>),

  /* ── P7: 测试管理（文本用例）────────────────────────────────────────────── */

  /** 模块树全量（P7-1）：拍平森林 + 直属用例计数，模块选择器与路径筛选共用。 */
  specModules: (projectId: string) =>
    client.get(`/projects/${projectId}/spec-modules`).then(data<SpecModule[]>),
  /** 建模块（P7-2 只做「让手工建用例可用」的最小模块管理；树的完整管理面在 P7-6）。 */
  createSpecModule: (projectId: string, input: { name: string; parentId?: string | null }) =>
    client.post(`/projects/${projectId}/spec-modules`, input).then(data<SpecModule>),
  /** 模块改名 / 移动（后端一条 UPDATE 换整棵子树的物化 path 前缀）：
      parentId 三态（缺省不动 / null 移到顶层 / uuid 移过去）。改名入口（脑图就地
      命名 + 树面板）只带 name。 */
  updateSpecModule: (projectId: string, moduleId: string, input: { name?: string; parentId?: string | null; position?: number }) =>
    client.patch(`/projects/${projectId}/spec-modules/${moduleId}`, input).then(data<SpecModule>),
  /** 同级批量重排（P7-6 拖拽调序）：一次写平一个父级下全部直属子模块的顺序
      （moduleIds 即最终顺序；服务端校验集合恰好等于当前直属，过期即 400）。 */
  reorderSpecModules: (projectId: string, input: { parentId?: string | null; moduleIds: string[] }) =>
    client.post(`/projects/${projectId}/spec-modules/reorder`, input).then(data<{ updated: number }>),
  /** 删目录（P7-3 脑图）：子树含用例时 409 + 计数；`force` 只在用户看过计数之后才发
      （environments 扫引用同款语义——空目录树的级联不算破坏性操作）。 */
  deleteSpecModule: (projectId: string, moduleId: string, force = false) =>
    client.delete(`/projects/${projectId}/spec-modules/${moduleId}`, { params: force ? { force: "true" } : undefined }).then(data<{ id: string }>),
  /** 文本用例列表（P7-2）：服务端分页 + keyword/path/moduleId/priority/status 筛选。 */
  specCasesPaged: (projectId: string, filters?: SpecCaseFilters) =>
    client.get(`/projects/${projectId}/spec-cases`, {
      params: {
        keyword: filters?.keyword?.trim() || undefined,
        path: filters?.path || undefined,
        moduleId: filters?.moduleId || undefined,
        priority: filters?.priority || undefined,
        status: filters?.status || undefined,
        automation: filters?.automation || undefined,
        page: filters?.page, pageSize: filters?.pageSize,
      },
    }).then(paged<SpecCase>),
  specCase: (projectId: string, caseId: string) =>
    client.get(`/projects/${projectId}/spec-cases/${caseId}`).then(data<SpecCase>),
  createSpecCase: (projectId: string, input: SpecCaseInput) =>
    client.post(`/projects/${projectId}/spec-cases`, input).then(data<SpecCase>),
  updateSpecCase: (projectId: string, caseId: string, input: SpecCaseInput) =>
    client.patch(`/projects/${projectId}/spec-cases/${caseId}`, input).then(data<SpecCase>),
  deleteSpecCase: (projectId: string, caseId: string) =>
    client.delete(`/projects/${projectId}/spec-cases/${caseId}`).then(data<{ id: string }>),
  /** 建绑定（P7-6）：repo_case 按 case_key 绑定（后端取身份行 + 同 key 就地换行 id）。 */
  createSpecCaseLink: (projectId: string, caseId: string, input: { targetType: SpecLinkTargetType; targetId: string }) =>
    client.post(`/projects/${projectId}/spec-cases/${caseId}/links`, input).then(data<SpecCaseLink>),
  deleteSpecCaseLink: (projectId: string, caseId: string, linkId: string) =>
    client.delete(`/projects/${projectId}/spec-cases/${caseId}/links/${linkId}`).then(data<{ id: string }>),
  /** 勾选批量条（P7-3）：一份 patch 应用到一批（移动模块 / 改优先级 / 改状态，2026-09-08）。 */
  batchUpdateSpecCases: (projectId: string, input: { caseIds: string[]; moduleId?: string; priority?: SpecCasePriority; status?: SpecCaseStatus }) =>
    client.post(`/projects/${projectId}/spec-cases/batch-update`, input).then(data<{ updated: number }>),
  batchDeleteSpecCases: (projectId: string, caseIds: string[]) =>
    client.post(`/projects/${projectId}/spec-cases/batch-delete`, { caseIds }).then(data<{ ids: string[]; deleted: number }>),
  /** 导入预览（P7-4/P7-5）：`.xmind` / `.xlsx` 原始流上传（octet-stream，文件名与
      导入根目录走 query），返回归一化树 + 逐条判定；不落库、不落暂存——归一化
      JSON 由前端持有到 commit。rootModuleId 不传 = 按文件自身结构建目录。 */
  previewSpecImport: (projectId: string, file: File, rootModuleId?: string) =>
    client.post(`/projects/${projectId}/spec-cases/import/preview`, file, {
      headers: { "content-type": "application/octet-stream" },
      params: { filename: file.name, rootModuleId: rootModuleId || undefined },
    }).then(data<SpecImportPreview>),
  /** 导入提交（P7-4/P7-5）：只发用户勾选的归一化用例；判定在服务端事务里重跑，不信预览结论。 */
  commitSpecImport: (projectId: string, input: { source: "xmind" | "excel"; cases: SpecImportCase[] }) =>
    client.post(`/projects/${projectId}/spec-cases/import`, input).then(data<SpecImportCommitResult>),
  /** 模板下载（P7-5；`?format=xmind` 为 2026-09-08 增补）：走 axios 拿 Blob（路由要
      Bearer 头，裸链接触发不了认证），本地化文件名由调用方在落盘时另存。 */
  downloadSpecImportTemplate: (projectId: string, format: "excel" | "xmind" = "excel") =>
    client.get(`/projects/${projectId}/spec-cases/import/template`, { responseType: "blob", params: { format } })
      .then((response) => response.data as Blob),
  /** 用例导出（2026-09-08）：POST（勾选集一批 uuid 放不进 query string）。勾选集
      （caseIds）非空 = 精确导这批（跨视图勾选集）；空 = 按筛选导全量命中集
      （「看到什么导什么」，不分页）；Blob 由调用方定文件名。 */
  exportSpecCases: (projectId: string, format: SpecExportFormat, filters?: SpecCaseFilters, caseIds?: string[]) =>
    client.post(`/projects/${projectId}/spec-cases/export`, {
      format,
      caseIds: caseIds?.length ? caseIds : undefined,
      keyword: filters?.keyword?.trim() || undefined,
      path: filters?.path || undefined,
      moduleId: filters?.moduleId || undefined,
      priority: filters?.priority || undefined,
      status: filters?.status || undefined,
      automation: filters?.automation || undefined,
    }, { responseType: "blob" }).then((response) => response.data as Blob),

  /* ── P7-7：测试计划 ── */

  /** 列表（viewer 可读）：keyword / status / owner 筛选 + 服务端分页 + 汇总计数。 */
  testPlansPaged: (projectId: string, filters?: { keyword?: string; status?: string; owner?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/test-plans`, {
      params: {
        keyword: filters?.keyword?.trim() || undefined,
        status: filters?.status || undefined,
        owner: filters?.owner || undefined,
        page: filters?.page, pageSize: filters?.pageSize,
      },
    }).then(paged<TestPlan>),
  /** 全量 open 计划（批量条「加入计划」的计划选择器数据源——下拉里缺一个真实
      存在的计划比多列几个更糟，environmentList 全量读法同款取舍）。 */
  testPlans: (projectId: string) =>
    client.get(`/projects/${projectId}/test-plans`, { params: { pageSize: 100 } }).then(paged<TestPlan>),
  testPlan: (projectId: string, planId: string) =>
    client.get(`/projects/${projectId}/test-plans/${planId}`).then(data<TestPlanDetail>),
  createTestPlan: (projectId: string, input: TestPlanInput & { specCaseIds?: string[] }) =>
    client.post(`/projects/${projectId}/test-plans`, input).then(data<TestPlan>),
  updateTestPlan: (projectId: string, planId: string, input: TestPlanInput) =>
    client.patch(`/projects/${projectId}/test-plans/${planId}`, input).then(data<TestPlan>),
  deleteTestPlan: (projectId: string, planId: string) =>
    client.delete(`/projects/${projectId}/test-plans/${planId}`).then(data<{ id: string }>),
  /** 加项（批量条「加入计划」）：重复项服务端静默跳过，返回真实插入数。 */
  addTestPlanItems: (projectId: string, planId: string, specCaseIds: string[]) =>
    client.post(`/projects/${projectId}/test-plans/${planId}/items`, { specCaseIds }).then(data<{ inserted: number }>),
  updateTestPlanItem: (projectId: string, planId: string, itemId: string, input: TestPlanItemInput) =>
    client.patch(`/projects/${projectId}/test-plans/${planId}/items/${itemId}`, input).then(data<TestPlanItem>),
  deleteTestPlanItem: (projectId: string, planId: string, itemId: string) =>
    client.delete(`/projects/${projectId}/test-plans/${planId}/items/${itemId}`).then(data<{ id: string }>),
  /** CSV 导出（UTF-8 BOM，Excel 直开）：viewer 可导（纯读）；Blob 文件名由调用方定。 */
  exportTestPlan: (projectId: string, planId: string) =>
    client.get(`/projects/${projectId}/test-plans/${planId}/export`, { responseType: "blob" }).then((response) => response.data as Blob),

  projects: (filters?: ProjectFilters) => client.get("/projects", { params: projectParams(filters) }).then(data<ProjectMetric[]>),
  /** 管理页的分页读法（与 environmentList 同一契约）：keyword 在 SQL 里过滤，total 是全量
      命中数。项目切换器仍走 `projects`（全量）——切换器里缺一个真实存在的项目比多列几个更糟。 */
  projectList: (filters?: { keyword?: string; page?: number; pageSize?: number }) =>
    client.get("/projects", { params: { keyword: filters?.keyword?.trim() || undefined, page: filters?.page, pageSize: filters?.pageSize } }).then(paged<ProjectMetric>),
  project: (id: string) => client.get(`/projects/${id}`).then(data<Project>),
  /** 项目身份 + 管理员线索（P14-1 边界 2）：登录即可读，无权限落地页据此渲染。404 = 项目不存在。 */
  projectIdentity: (id: string) => client.get(`/projects/${id}/identity`).then(data<ProjectIdentity>),
  createProject: (name: string, description: string) => client.post("/projects", { name, description }).then(data<Project>),
  updateProject: (id: string, input: Partial<Pick<Project, "name" | "description">>) => client.patch(`/projects/${id}`, input).then(data<Project>),
  deleteProject: (id: string) => client.delete(`/projects/${id}`).then(data<{ id: string; deleted: boolean }>),

  environments: (projectId: string) => client.get(`/projects/${projectId}/environments`).then(data<Environment[]>),
  /**
   * 管理页的分页读法：keyword 过滤在 SQL 里，total 是全量命中数。选择器仍走
   * `environments`（全量）——下拉里缺一个真实存在的环境比多列几个更糟。
   */
  environmentList: (projectId: string, filters?: { keyword?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/environments`, { params: { keyword: filters?.keyword?.trim() || undefined, page: filters?.page, pageSize: filters?.pageSize } }).then(paged<Environment>),
  projectSettings: (projectId: string) => client.get(`/projects/${projectId}/settings`).then(data<ProjectSettings>),
  /* storePlaintext / mcpEnabled / offloadLargeResponse 都可缺省：服务端 COALESCE 保留原值
      （9.1 防的就是「只改一个开关把另一个顺手清掉」）；defaultEnvironmentId 例外——缺省
      等于清空，必须随行当前值。 */
  updateProjectSettings: (projectId: string, input: { defaultEnvironmentId: string | null; storePlaintext?: boolean; mcpEnabled?: boolean; offloadLargeResponse?: boolean }) => client.put(`/projects/${projectId}/settings`, input).then(data<ProjectSettings>),
  createEnvironment: (projectId: string, input: EnvironmentInput) => client.post(`/projects/${projectId}/environments`, input).then(data<Environment>),
  updateEnvironment: (projectId: string, id: string, input: EnvironmentInput) => client.patch(`/projects/${projectId}/environments/${id}`, input).then(data<Environment>),
  /* Server-side duplicate: the client never holds secret plaintext, so a client-side copy would lose every secret. */
  duplicateEnvironment: (projectId: string, id: string, name?: string) => client.post(`/projects/${projectId}/environments/${id}/duplicate`, { name }).then(data<Environment>),
  environmentUsage: (projectId: string, id: string) => client.get(`/projects/${projectId}/environments/${id}/usage`).then(data<EnvironmentUsage>),
  /* force is only sent after the user has seen the references the scan found. */
  deleteEnvironment: (projectId: string, id: string, force = false) =>
    client.delete(`/projects/${projectId}/environments/${id}`, { params: force ? { force: "true" } : undefined }).then(data<{ id: string }>),

  dataSources: (projectId: string) => client.get(`/projects/${projectId}/data-sources`).then(data<DataSource[]>),
  /**
   * 数据源列表的服务端分页读法（管理页用）。`dataSources` 仍返回全量：流程节点
   * 选择器要的是完整清单，分页只属于列表页本身。
   */
  dataSourcesPaged: (projectId: string, filters?: { page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/data-sources`, { params: { page: filters?.page, pageSize: filters?.pageSize } }).then(paged<DataSource>),
  dataSource: (projectId: string, dataSourceId: string) => client.get(`/projects/${projectId}/data-sources/${dataSourceId}`).then(data<DataSource>),
  createDataSource: (projectId: string, input: DataSourceInput) => client.post(`/projects/${projectId}/data-sources`, input).then(data<DataSource>),
  updateDataSource: (projectId: string, dataSourceId: string, input: Partial<DataSourceInput>) => client.put(`/projects/${projectId}/data-sources/${dataSourceId}`, input).then(data<DataSource>),
  dataSourceUsage: (projectId: string, dataSourceId: string) => client.get(`/projects/${projectId}/data-sources/${dataSourceId}/usage`).then(data<DataSourceUsage>),
  deleteDataSource: (projectId: string, dataSourceId: string) => client.delete(`/projects/${projectId}/data-sources/${dataSourceId}`).then(data<{ id: string }>),
  testDataSource: (projectId: string, dataSourceId: string) => client.post(`/projects/${projectId}/data-sources/${dataSourceId}/test`).then(data<DataSourceTestResult>),
  queryDataSource: (projectId: string, dataSourceId: string, input: SqlExecutionInput) => client.post(`/projects/${projectId}/data-sources/${dataSourceId}/query`, input).then(data<SqlExecutionResult>),
  /** 本人在此数据源的 /query 执行历史（倒序分页）；服务端只返回调用者自己的记录。 */
  sqlHistory: (projectId: string, dataSourceId: string, filters?: { page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/data-sources/${dataSourceId}/sql-history`, { params: { page: filters?.page, pageSize: filters?.pageSize } }).then(paged<SqlExecutionHistory>),
  /** 清空本人在此数据源的执行历史。 */
  clearSqlHistory: (projectId: string, dataSourceId: string) => client.delete(`/projects/${projectId}/data-sources/${dataSourceId}/sql-history`).then(data<{ deleted: number }>),
  sqlDefinitions: (projectId: string, dataSourceId: string) => client.get(`/projects/${projectId}/data-sources/${dataSourceId}/sql-definitions`).then(data<SqlDefinition[]>),
  sqlDefinition: (projectId: string, sqlId: string) => client.get(`/projects/${projectId}/sql-definitions/${sqlId}`).then(data<SqlDefinition>),
  createSqlDefinition: (projectId: string, dataSourceId: string, input: SqlDefinitionInput) => client.post(`/projects/${projectId}/data-sources/${dataSourceId}/sql-definitions`, input).then(data<SqlDefinition>),
  updateSqlDefinition: (projectId: string, sqlId: string, input: Partial<SqlDefinitionInput>) => client.put(`/projects/${projectId}/sql-definitions/${sqlId}`, input).then(data<SqlDefinition>),
  deleteSqlDefinition: (projectId: string, sqlId: string) => client.delete(`/projects/${projectId}/sql-definitions/${sqlId}`).then(data<{ id: string }>),
  testSqlDefinition: (projectId: string, sqlId: string, values: Record<string, unknown>) => client.post(`/projects/${projectId}/sql-definitions/${sqlId}/test`, { values }).then(data<SqlExecutionResult>),

  mocks: (projectId: string) => client.get(`/projects/${projectId}/mocks`).then(data<Mock[]>),
  /** Mock 列表的服务端分页读法（管理页用）；全量读法留给未来需要完整清单的调用方。 */
  mocksPaged: (projectId: string, filters?: { page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/mocks`, { params: { page: filters?.page, pageSize: filters?.pageSize } }).then(paged<Mock>),
  createMock: (projectId: string, input: MockInput) => client.post(`/projects/${projectId}/mocks`, input).then(data<Mock>),
  updateMock: (projectId: string, mockId: string, input: Partial<MockInput>) => client.put(`/projects/${projectId}/mocks/${mockId}`, input).then(data<Mock>),
  deleteMock: (projectId: string, mockId: string) => client.delete(`/projects/${projectId}/mocks/${mockId}`).then(data<{ id: string }>),
  mockLogs: (projectId: string, mockId: string) => client.get(`/projects/${projectId}/mocks/${mockId}/logs`).then((response) => response.data.data as MockRequestLog[]),

  endpoints: (projectId: string, filters?: EndpointFilters) => client.get(`/projects/${projectId}/endpoints`, { params: { keyword: filters?.keyword?.trim() || undefined, method: filters?.method && filters.method !== "all" ? filters.method : undefined, environmentId: filters?.environmentId && filters.environmentId !== "all" ? filters.environmentId : undefined } }).then(data<Endpoint[]>),
  /**
   * 接口列表的服务端分页读法（管理页用）。`endpoints` 仍返回全量：项目 store、
   * 流程节点选择器、mock 快照来源都需要完整清单，分页只属于列表页本身。
   */
  endpointsPaged: (projectId: string, filters?: EndpointFilters & { page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/endpoints`, {
      params: {
        keyword: filters?.keyword?.trim() || undefined,
        method: filters?.method && filters.method !== "all" ? filters.method : undefined,
        environmentId: filters?.environmentId && filters.environmentId !== "all" ? filters.environmentId : undefined,
        coverage: filters?.coverage && filters.coverage !== "all" ? filters.coverage : undefined,
        page: filters?.page, pageSize: filters?.pageSize,
      },
    }).then(paged<Endpoint>),
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
  batchExecutions: (projectId: string, page = 1, pageSize = 20, filters?: { from?: string; to?: string }) =>
    client.get(`/projects/${projectId}/batch-executions`, { params: { page, pageSize, from: filters?.from, to: filters?.to } }).then(paged<BatchDebugSummary>),
  batchExecution: (projectId: string, batchId: string) => client.get(`/projects/${projectId}/batch-executions/${batchId}`).then(data<BatchDebugResult>),
  /** Single run, used to fetch the full result once the stream says it settled. */
  execution: (projectId: string, executionId: string) => client.get(`/projects/${projectId}/executions/${executionId}`).then(data<Execution>),
  /**
   * 完整响应体的下载直链（P10-1）：短活 5 分钟，浏览器随后直打对象存储 / fs 直链端点，
   * 平台不代理字节流。直链按需签，不随执行详情下发——详情被列表 / 分享 / MCP 复用。
   */
  executionResponseBodyUrl: (projectId: string, executionId: string) =>
    client.get(`/projects/${projectId}/executions/${executionId}/response-body`).then(data<{ downloadUrl: string; expiresIn: number }>),
  /** Stops a queued run before it starts, or aborts one already in flight. */
  cancelExecution: (projectId: string, executionId: string) => client.post(`/projects/${projectId}/executions/${executionId}/cancel`).then(data<Execution>),
  cancelBatch: (projectId: string, batchId: string) => client.post(`/projects/${projectId}/batch-executions/${batchId}/cancel`).then(data<BatchDebugSummary & { canceled: number }>),
  executions: (projectId: string, filters?: ExecutionFilters) => client.get(`/projects/${projectId}/executions`, { params: executionParams(filters) }).then(paged<Execution>),
  /** Project-wide parent executions, filtered by kind — flows are a category here (5.0.9). */
  executionIndex: (projectId: string, filters?: { kind?: ExecutionIndex["kind"] | "all"; status?: string; triggerSource?: TriggerSource | "all"; keyword?: string; caseFilter?: boolean; from?: string; to?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/execution-index`, {
      params: {
        kind: filters?.kind === "all" ? undefined : filters?.kind,
        status: filters?.status === "all" ? undefined : filters?.status,
        triggerSource: filters?.triggerSource === "all" || !filters?.triggerSource ? undefined : filters.triggerSource,
        keyword: filters?.keyword?.trim() || undefined,
        /* 「勾选来的那些」（§8.3）：服务端按 `pipeline_runs.case_filter IS NOT NULL` 判，
           不加第五个 trigger_source 值（边界 10）。只对 runner 行有意义。 */
        caseFilter: filters?.caseFilter ? "1" : undefined,
        from: filters?.from, to: filters?.to,
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
  /** 公共脚本列表的服务端分页读法（管理页用）；各处脚本选择器仍用全量 `scripts`。 */
  scriptsPaged: (projectId: string, filters?: { keyword?: string; page?: number; pageSize?: number }) =>
    client
      .get(`/projects/${projectId}/scripts`, { params: { keyword: filters?.keyword?.trim() || undefined, page: filters?.page, pageSize: filters?.pageSize } })
      .then(paged<Script>),
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
  /** 流程列表的服务端分页读法（列表页用）；成员选择器等仍用全量 `flows`。 */
  flowsPaged: (projectId: string, filters?: { keyword?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/flows`, { params: { keyword: filters?.keyword?.trim() || undefined, page: filters?.page, pageSize: filters?.pageSize } }).then(paged<FlowSummary>),
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
  /* 测试套件 (P2-4)。P3-7 起服务端分页（边界 14）：keyword/tag 命中全量而不止当前页。 */
  testSuites: (projectId: string, filters?: { keyword?: string; tag?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/test-suites`, { params: { keyword: filters?.keyword?.trim() || undefined, tag: filters?.tag || undefined, page: filters?.page, pageSize: filters?.pageSize } }).then(paged<SuiteSummary>),
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
  /**
   * `variables` 是触发时的变量覆盖（P3-2，6.5 泳道第二层）：冻进 run_spec、下发给每个
   * 成员、压过环境变量。键约束 ^[A-Za-z_][A-Za-z0-9_]*$，值只能是字符串；不要放密钥。
   */
  executeSuite: (projectId: string, suiteId: string, execution?: Partial<SuiteExecutionConfig>, variables?: Record<string, string>) =>
    client.post(`/projects/${projectId}/test-suites/${suiteId}/execute`, { execution, variables }).then(data<SuiteExecution>),
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

  /* ---------------- P3：调度 / Webhook 触发 / 告警 / 报告（计划 6.2） ---------------- */

  /**
   * 调度。`scheduler.overdue`（超宽限期未认领的启用调度数）是调度器活性提示——不建
   * 心跳表，用事实回答（P3-4）；>0 才在界面提示「调度器可能没在运行」。
   */
  schedules: (projectId: string, filters?: { keyword?: string; enabled?: boolean; targetType?: ScheduleTargetType; targetId?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/schedules`, { params: { keyword: filters?.keyword?.trim() || undefined, enabled: filters?.enabled === undefined ? undefined : filters.enabled, targetType: filters?.targetType || undefined, targetId: filters?.targetId || undefined, page: filters?.page, pageSize: filters?.pageSize } }).then((response) => {
      const result = paged<Schedule>(response);
      const scheduler = (response.data.meta as { scheduler?: { overdue?: number } } | undefined)?.scheduler;
      return { ...result, scheduler: { overdue: scheduler?.overdue ?? 0 } };
    }),
  schedule: (projectId: string, scheduleId: string) => client.get(`/projects/${projectId}/schedules/${scheduleId}`).then(data<Schedule>),
  createSchedule: (projectId: string, input: ScheduleInput) => client.post(`/projects/${projectId}/schedules`, input).then(data<Schedule>),
  updateSchedule: (projectId: string, scheduleId: string, input: ScheduleInput) => client.put(`/projects/${projectId}/schedules/${scheduleId}`, input).then(data<Schedule>),
  deleteSchedule: (projectId: string, scheduleId: string) => client.delete(`/projects/${projectId}/schedules/${scheduleId}`).then(data<{ id: string }>),
  /** cron 校验 + 下 5 次执行时间。与调度器认领同一个解析，预览说几点跑就几点跑。 */
  schedulePreview: (projectId: string, cron: string, timezone?: string) =>
    client.post(`/projects/${projectId}/schedules/preview`, { cron, timezone }).then(data<SchedulePreview>),
  /** 触发历史（含漏跑 skipped / 触发失败 failed——那两种没有执行，边界 15）。 */
  scheduleRuns: (projectId: string, scheduleId: string, filters?: { status?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/schedules/${scheduleId}/runs`, { params: { status: filters?.status && filters.status !== "all" ? filters.status : undefined, page: filters?.page, pageSize: filters?.pageSize } }).then(paged<ScheduleRun>),
  /**
   * 立即跑一次：用调度的配置现在触发，trigger_source=manual（不写 schedule_runs）。
   * 结果按 `targetType` 判别（P4.5-12）：套件回一行执行，CI 任务回一行 pipeline run。
   * `Idempotency-Key` 只在 CI 路径上有意义（服务端忽略套件路径的这个头）。
   */
  runScheduleNow: (projectId: string, scheduleId: string, options?: { idempotencyKey?: string }) =>
    client.post(`/projects/${projectId}/schedules/${scheduleId}/run`, undefined, {
      headers: options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined,
    }).then(data<ScheduleRunNowResult>),

  /** Webhook 触发器。创建/轮换的响应额外带一次性 `secret`（此处类型上收窄掉了）。 */
  webhookTriggers: (projectId: string) => client.get(`/projects/${projectId}/webhook-triggers`).then(data<WebhookTrigger[]>),
  createWebhookTrigger: (projectId: string, input: WebhookTriggerInput) =>
    client.post(`/projects/${projectId}/webhook-triggers`, input).then(data<WebhookTrigger & { secret: string }>),
  updateWebhookTrigger: (projectId: string, triggerId: string, input: WebhookTriggerInput) =>
    client.put(`/projects/${projectId}/webhook-triggers/${triggerId}`, input).then(data<WebhookTrigger>),
  deleteWebhookTrigger: (projectId: string, triggerId: string) =>
    client.delete(`/projects/${projectId}/webhook-triggers/${triggerId}`).then(data<{ id: string }>),
  rotateWebhookSecret: (projectId: string, triggerId: string) =>
    client.post(`/projects/${projectId}/webhook-triggers/${triggerId}/rotate-secret`).then(data<{ id: string; secret: string }>),
  webhookSecret: (projectId: string, triggerId: string) =>
    client.get(`/projects/${projectId}/webhook-triggers/${triggerId}/secret`).then(data<{ id: string; secret: string }>),

  notificationChannels: (projectId: string) => client.get(`/projects/${projectId}/notification-channels`).then(data<NotificationChannel[]>),
  createNotificationChannel: (projectId: string, input: NotificationChannelInput) =>
    client.post(`/projects/${projectId}/notification-channels`, input).then(data<NotificationChannel>),
  updateNotificationChannel: (projectId: string, channelId: string, input: NotificationChannelInput) =>
    client.put(`/projects/${projectId}/notification-channels/${channelId}`, input).then(data<NotificationChannel>),
  /**
   * 删除被规则引用的渠道返回 409，`data.rules` 是引用清单；force 后服务端顺带把规则
   * 里的悬空 id 摘掉。错误处理见 Environments 的同款 usage 流程。
   */
  deleteNotificationChannel: (projectId: string, channelId: string, force?: boolean) =>
    client.delete(`/projects/${projectId}/notification-channels/${channelId}`, { params: force ? { force: "true" } : undefined }).then(data<{ id: string }>),
  /** 测试投递：同步等结果，「测试」的意义就是现在告诉你通不通。 */
  testNotificationChannel: (projectId: string, channelId: string) =>
    client.post(`/projects/${projectId}/notification-channels/${channelId}/test`).then(data<{ sent: number; failed: number }>),

  alertRules: (projectId: string) => client.get(`/projects/${projectId}/alert-rules`).then(data<AlertRule[]>),
  createAlertRule: (projectId: string, input: AlertRuleInput) =>
    client.post(`/projects/${projectId}/alert-rules`, input).then(data<AlertRule>),
  updateAlertRule: (projectId: string, ruleId: string, input: AlertRuleInput) =>
    client.put(`/projects/${projectId}/alert-rules/${ruleId}`, input).then(data<AlertRule>),
  deleteAlertRule: (projectId: string, ruleId: string) =>
    client.delete(`/projects/${projectId}/alert-rules/${ruleId}`).then(data<{ id: string }>),

  notificationDeliveries: (projectId: string, filters?: { ruleId?: string; channelId?: string; executionIndexId?: string; status?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/notification-deliveries`, { params: { ruleId: filters?.ruleId, channelId: filters?.channelId, executionIndexId: filters?.executionIndexId, status: filters?.status && filters.status !== "all" ? filters.status : undefined, page: filters?.page, pageSize: filters?.pageSize } }).then(paged<NotificationDeliveryRow>),

  /** 报告列表（边界 14 分页 + 触发源/状态筛选）。 */
  suiteReports: (projectId: string, filters?: { keyword?: string; triggerSource?: string; status?: string; source?: string; attribution?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/suite-reports`, { params: { keyword: filters?.keyword?.trim() || undefined, triggerSource: filters?.triggerSource && filters.triggerSource !== "all" ? filters.triggerSource : undefined, status: filters?.status && filters.status !== "all" ? filters.status : undefined, source: filters?.source && filters.source !== "all" ? filters.source : undefined, attribution: filters?.attribution || undefined, page: filters?.page, pageSize: filters?.pageSize } }).then(paged<SuiteReportSummary>),
  /** 一份报告：标识 / 触发 / 结论 / 成员明细（不分页）。 */
  suiteReport: (projectId: string, executionId: string) =>
    client.get(`/projects/${projectId}/suite-reports/${executionId}`).then(data<SuiteReport>),
  /** 趋势（边界 11）：空桶由服务端补齐，分位数 percentile_cont 在 SQL 里算。
      `scope` 三态口径（`SampleScope`；`repo` 档 ingest 与 runner 一体不拆，
      P4.5 边界 2）。 */
  trendReport: (projectId: string, range: ReportRange, scope: SampleScope = "platform") =>
    client.get(`/projects/${projectId}/reports/trend`, { params: { range, scope } }).then(data<TrendReport>),
  /** 汇总：总量 + 失败分布（按接口 Top20 / 按错误类型；`repo` 口径下服务端跳过
      分布两段、回空集合——它们读平台叶子表，与仓库执行数据源错位）。 */
  reportSummary: (projectId: string, range: ReportRange, scope: SampleScope = "platform") =>
    client.get(`/projects/${projectId}/reports/summary`, { params: { range, scope } }).then(data<ReportSummary>),

  /* ── P8：全局统计（/stats/*）。项目层「数据统计」页带 projectIds 复用同一组
      接口——全局层不传 projectIds 即可见集全量；四条都是聚合读，30s 服务端缓存
      （边界 16），页面进入拉一次 + 手动刷新，不接 SSE。 */

  /** 全局读数：执行面四读数 + 触发源分布 + 资产面四读数 + 7 天 delta。 */
  statsOverview: (query: { days?: number; scope?: SampleScope; projectIds?: string[] }) =>
    client.get("/stats/overview", { params: statsParams(query) }).then(data<StatsOverview>),
  /** 趋势：execution_trend（量/通过率/分位，可按触发源过滤）；asset_trend（六类资产日增）。 */
  statsTrend: (query: { days?: number; metric?: "execution_trend" | "asset_trend"; scope?: SampleScope; projectIds?: string[]; triggerSource?: TriggerSource }) =>
    client.get("/stats/trend", { params: statsParams(query) }).then(data<StatsTrendReport>),
  /** 失败归因分布（含未归因）+ TopN 榜（六维，P8-7 扩参；case 维带 caseId、其余带
      refId 供下钻）。attributionSource 筛「人打的 / agent 打的」（边界 8）。 */
  statsFailures: (query: { days?: number; projectIds?: string[]; topN?: StatsTopNDim; attributionSource?: AttributionSourceFilter }) =>
    client.get("/stats/failures", { params: statsParams(query) }).then(data<StatsFailures>),
  /** Flaky 榜 + MTTR + 窗口内首跑通过率（同一批查询顺带出，阈值随行带出）。 */
  statsFlaky: (query: { days?: number; projectIds?: string[] }) =>
    client.get("/stats/flaky", { params: statsParams(query) }).then(data<StatsFlaky>),
  /** 项目对比：Top 10 反向榜（默认）或关键字命中的全量（边界 19 两形态）。 */
  statsProjects: (query: { days?: number; metric?: StatsProjectMetric; order?: "asc" | "desc"; limit?: number; keyword?: string; scope?: SampleScope; projectIds?: string[] }) =>
    client.get("/stats/projects", { params: statsParams(query) }).then(data<StatsProjects>),

  /* ── P4: 仓库模式 ─────────────────────────────────────────────────────────── */

  /** 单例视图：未绑定回 `null`（绑定由首次上报完成，前端没有「创建」这个动作）。 */
  repository: (projectId: string) => client.get(`/projects/${projectId}/repository`).then(data<Repository | null>),
  /** 只能改跟踪分支与托管方：`gitUrl` 是上报准入判据，改它等于绕过校验换个仓库进来。 */
  updateRepository: (projectId: string, input: { trackingBranch?: string; provider?: RepositoryProvider }) =>
    client.patch(`/projects/${projectId}/repository`, input).then(data<Repository>),
  /** 解绑：置 unbound，**保留**历史用例与上报记录。 */
  unbindRepository: (projectId: string) => client.delete(`/projects/${projectId}/repository`).then(data<Repository>),

  ingestTokens: (projectId: string) => client.get(`/projects/${projectId}/ingest-tokens`).then(data<IngestToken[]>),
  /** 创建：`token` 明文**只在这一次响应里**出现，丢了只能吊销重发。 */
  createIngestToken: (projectId: string, name: string) =>
    client.post(`/projects/${projectId}/ingest-tokens`, { name }).then(data<IngestToken & { token: string }>),
  revokeIngestToken: (projectId: string, tokenId: string) =>
    client.delete(`/projects/${projectId}/ingest-tokens/${tokenId}`).then(data<IngestToken>),
  /** 重新取回明文（2026-09-28 可重复复制）：可逆加密存储，丢了不必吊销重发。已吊销的取不到。 */
  ingestTokenSecret: (projectId: string, tokenId: string) =>
    client.get(`/projects/${projectId}/ingest-tokens/${tokenId}/secret`).then(data<{ id: string; token: string }>),

  /* ── P4.5-14: 项目级 Git 拉取凭据（取代仓库行上的 clone 凭据） ─────────────── */

  /** 列表带 `taskCount`：删除前要先说清「删了它会影响几个任务」。 */
  gitCredentials: (projectId: string) => client.get(`/projects/${projectId}/git-credentials`).then(data<GitCredential[]>),
  createGitCredential: (projectId: string, input: GitCredentialInput) =>
    client.post(`/projects/${projectId}/git-credentials`, input).then(data<GitCredential>),
  /** `credential` 缺省 = 只改名（凭据不动）；换方式必须同时给新明文。 */
  updateGitCredential: (projectId: string, credentialId: string, input: GitCredentialInput) =>
    client.put(`/projects/${projectId}/git-credentials/${credentialId}`, input).then(data<GitCredential>),
  /** 被任务引用时回 409，`data.tasks` 是引用它的任务清单（没有 force 强删）。 */
  deleteGitCredential: (projectId: string, credentialId: string) =>
    client.delete(`/projects/${projectId}/git-credentials/${credentialId}`).then(data<{ id: string }>),

  /** 用例树（按接口分组，分页在接口上）+ 覆盖统计。 */
  repoCases: (projectId: string, filters?: { keyword?: string; status?: string; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/repo-cases`, { params: { keyword: filters?.keyword?.trim() || undefined, status: filters?.status && filters.status !== "active" ? filters.status : undefined, page: filters?.page, pageSize: filters?.pageSize } })
      .then((response) => ({
        ...(response.data.data as RepoCaseTree),
        page: (response.data.meta as { page?: number } | undefined)?.page ?? 1,
        pageSize: (response.data.meta as { pageSize?: number } | undefined)?.pageSize ?? 20,
        total: (response.data.meta as { total?: number } | undefined)?.total ?? 0,
      })),
  /** 未归位用例（边界 21）：有用例、但在本项目一个接口都没打到。 */
  unplacedRepoCases: (projectId: string, page?: number, pageSize?: number) =>
    client.get(`/projects/${projectId}/repo-cases/unplaced`, { params: { page, pageSize } }).then(paged<RepoTestCase>),
  /** 单用例详情（抽屉用）：`params` 是 records 里 distinct 的参数化场景 id。
      records 仍在响应里（run 明细页的口径），抽屉不展示。 */
  repoCase: (projectId: string, caseId: string) =>
    client.get(`/projects/${projectId}/repo-cases/${caseId}`)
      .then(data<RepoCaseDetail>),

  /** 两个过滤都是布尔闸（后端 OR 语义）：changed = 新增或消失 > 0，unmatched = 有未匹配。 */
  ingestRuns: (projectId: string, page?: number, pageSize?: number, filters?: { changed?: boolean; unmatched?: boolean }) =>
    client.get(`/projects/${projectId}/ingest-runs`, { params: { page, pageSize, changed: filters?.changed ? "1" : undefined, unmatched: filters?.unmatched ? "1" : undefined } }).then(paged<IngestRun>),
  /** `changes` = 只看有变动的记录（未匹配 + 本轮新增的覆盖，后端定义）；`recordsTotal`
      是**当前过滤口径**下的总数（meta），截断提示以它为准而不是 run.requestCount。 */
  ingestRun: (projectId: string, runId: string, page?: number, pageSize?: number, filters?: { changes?: boolean }) =>
    client.get(`/projects/${projectId}/ingest-runs/${runId}`, { params: { page, pageSize, changes: filters?.changes ? "1" : undefined } })
      .then((response) => ({
        detail: response.data.data as IngestRunDetail,
        recordsTotal: (response.data.meta as { total?: number } | undefined)?.total ?? 0,
      })),

  /** 未匹配诊断视图。`silenced` 为真时回被前缀规则静默的那些行。 */
  ingestUnmatched: (projectId: string, filters?: { silenced?: boolean; page?: number; pageSize?: number }) =>
    client.get(`/projects/${projectId}/ingest-unmatched`, { params: { silenced: filters?.silenced ? "true" : undefined, page: filters?.page, pageSize: filters?.pageSize } }).then(paged<UnmatchedPath>),
  /** 关联到**已登记**接口。安全的那个动作：目标本来就在本项目、本来就在分母里。 */
  linkUnmatched: (projectId: string, input: { method: string; path: string; endpointId: string }) =>
    client.post(`/projects/${projectId}/ingest-unmatched/link`, input).then(data<{ linkedRecords: number; linkedCases: number }>),
  /** 一键登记：建最小 endpoint 并把历史未匹配记录按匹配语义归位（单行显式动作，无批量）。 */
  registerUnmatched: (projectId: string, input: { method: string; path: string; name?: string }) =>
    client.post(`/projects/${projectId}/ingest-unmatched/register`, input).then(data<{ endpoint: Endpoint; linkedRecords: number; linkedCases: number }>),
  ingestPathRules: (projectId: string) => client.get(`/projects/${projectId}/ingest-path-rules`).then(data<IngestPathRule[]>),
  createIngestPathRule: (projectId: string, input: { pathPrefix: string; note?: string }) =>
    client.post(`/projects/${projectId}/ingest-path-rules`, input).then(data<IngestPathRule>),
  deleteIngestPathRule: (projectId: string, ruleId: string) =>
    client.delete(`/projects/${projectId}/ingest-path-rules/${ruleId}`).then(data<{ id: string }>),

  /* ── P4.5: 自研 Runner 的 pipeline run（P4.5-11 读路由 + P4.5-13 报告视图） ──── */

  /**
   * CI 任务列表（P4.5-11 起是任务列表页的数据源；P4.5-9 的勾选弹窗也用它选触发目标）。
   *
   * `keyword` 由服务端 `ILIKE` 过滤（名称 / 描述 / Git 地址）：就地过滤只筛得到当前页，
   * 而「我那条任务在第几页」正是要搜索的原因。
   */
  ciTasks: (projectId: string, page?: number, pageSize?: number, keyword?: string) =>
    client.get(`/projects/${projectId}/ci-tasks`, { params: { page, pageSize, keyword: keyword || undefined } }).then(paged<CiTask>),
  ciTask: (projectId: string, taskId: string) =>
    client.get(`/projects/${projectId}/ci-tasks/${taskId}`).then(data<CiTask>),
  createCiTask: (projectId: string, input: CiTaskInput) =>
    client.post(`/projects/${projectId}/ci-tasks`, input).then(data<CiTask>),
  /** 部分覆盖：缺省字段保持原值。`gitCredentialId: null` 显式清成「公开仓库」。 */
  updateCiTask: (projectId: string, taskId: string, input: CiTaskInput) =>
    client.put(`/projects/${projectId}/ci-tasks/${taskId}`, input).then(data<CiTask>),
  /** 删除会级联掉这个任务的全部 pipeline run（服务端刻意如此）；要留历史就停用。 */
  /**
   * 删除。被调度 / Webhook 引用时回 409，`data.schedules` 与 `data.webhookTriggers` 是引用
   * 清单（P4.5-12）；`force` 只在用户看过那份清单之后才发，服务端连带删掉引用者。
   */
  deleteCiTask: (projectId: string, taskId: string, force = false) =>
    client.delete(`/projects/${projectId}/ci-tasks/${taskId}`, { params: force ? { force: "true" } : undefined }).then(data<{ id: string }>),
  /** 勾选执行的推荐任务（§8.3）。POST 是因为 key 集合最多 500 条，塞不进查询串。 */
  recommendCiTask: (projectId: string, caseKeys: string[]) =>
    client.post(`/projects/${projectId}/ci-tasks/recommend`, { caseKeys }).then(data<CiTaskRecommendation>),
  /**
   * 触发一次 CI 任务。`caseFilter` 省略 = 全量；带上 = 勾选执行（§8.3）。
   *
   * `Idempotency-Key` 由调用方传入并**在重试之间保持不变**（P4.5-8）：键在这里现生成
   * 就等于没防重——双击会生成两个键、产出两条 run。响应的 `idempotentReplay` 为真时
   * 表示这一次没有新触发，回的是首次那条。
   */
  triggerCiTask: (projectId: string, taskId: string, input?: { parameters?: Record<string, string>; caseKeys?: string[]; idempotencyKey?: string }) =>
    client.post(
      `/projects/${projectId}/ci-tasks/${taskId}/trigger`,
      {
        parameters: input?.parameters,
        caseFilter: input?.caseKeys?.length ? { caseKeys: input.caseKeys } : undefined,
      },
      input?.idempotencyKey ? { headers: { "Idempotency-Key": input.idempotencyKey } } : undefined,
    ).then(data<PipelineRun & { idempotentReplay?: boolean }>),

  /**
   * run 列表（P4.5-15，8.12 ②）：按 `ciTaskId` 过滤，任务列表行内展开执行历史的数据源。
   * `ciTaskId` 必填——跨任务的统一视角走执行记录页（execution_index），这里是任务视角。
   */
  pipelineRuns: (projectId: string, ciTaskId: string, page?: number, pageSize?: number) =>
    client.get(`/projects/${projectId}/pipeline-runs`, { params: { ciTaskId, page, pageSize } }).then(paged<PipelineRun>),
  /**
   * run 详情。`blockedBy` 是**读时算出的关系**（P4.5-12）：这条 run 排着队且被任务级串行
   * 挡在一条更早的 run 后面时，它是那一条的序号。没有它，「一直排队」与「分区没有 Runner」
   * 在界面上长得一样，而处置动作完全不同。
   */
  pipelineRun: (projectId: string, runId: string) =>
    client.get(`/projects/${projectId}/pipeline-runs/${runId}`).then((response) => ({
      ...(response.data.data as PipelineRun),
      blockedBy: (response.data.meta as { blockedBy?: number } | undefined)?.blockedBy,
    })),
  cancelPipelineRun: (projectId: string, runId: string) =>
    client.post(`/projects/${projectId}/pipeline-runs/${runId}/cancel`).then(data<PipelineRun>),
  /** 日志增量：`nextOffset` 是本次拉取的尾，`totalBytes` 是服务端当前总长（追上与否
      的判据）。前端循环拉到 nextOffset === totalBytes 为止。 */
  pipelineRunLogs: (projectId: string, runId: string, offset: number, bytes?: number) =>
    client.get(`/projects/${projectId}/pipeline-runs/${runId}/logs`, { params: { offset, bytes } })
      .then(data<{ text: string; nextOffset: number; totalBytes: number }>),
  /** cases 全量（时间轴与列表共用；几万行内不分页）。 */
  pipelineRunCases: (projectId: string, runId: string) =>
    client.get(`/projects/${projectId}/pipeline-runs/${runId}/cases`).then(data<PipelineRunCase[]>),
  /** 产物列表（带 5 分钟短活的下载直链）。 */
  pipelineRunArtifacts: (projectId: string, runId: string) =>
    client.get(`/projects/${projectId}/pipeline-runs/${runId}/artifacts`).then(data<(Artifact & { downloadUrl: string })[]>),
  /** 报告视图（P4.5-13）：没有报告包时回 null（junit 任务是正常态不是错误态）。 */
  pipelineRunReport: (projectId: string, runId: string) =>
    client.get(`/projects/${projectId}/pipeline-runs/${runId}/report`).then(data<AllureReportView | null>),
  /**
   * 报告附件（步骤日志 / 截图）。走 axios 拿 Blob 而不是裸 URL：附件路由要 Bearer 头，
   * `<img src>` 与 `fetch` 都带不上（dev 下 web 与 API 还是跨源），只有 axios 的请求
   * 拦截器能带上 token。`name` 传附件的**实体文件名**（allure 的 source）——路由按
   * 报告包内 basename 匹配，展示名（log/stdout）在包里没有同名实体。
   */
  pipelineRunAttachment: (projectId: string, runId: string, name: string) =>
    client.get(`/projects/${projectId}/pipeline-runs/${runId}/attachments`, { params: { name }, responseType: "blob" })
      .then((response) => response.data as Blob),

  /* ── 报告分享（2026-09-02）：项目内管理 + 免登录公开读 ─────────────────────── */

  /** 目标当前的有效分享；没有时回 null（已分享 / 未分享是一个布尔事实，不是错误）。 */
  reportShare: (projectId: string, targetType: ReportShareTarget, targetId: string) =>
    client.get(`/projects/${projectId}/report-shares`, { params: { targetType, targetId } }).then(data<ReportShare | null>),
  /**
   * 创建分享。幂等于服务端：一个目标同时只有一条有效分享（重复点拿到同一条链接，
   * token 不换——先贴出去的链接不会因为再点一次按钮而失效）。
   */
  createReportShare: (projectId: string, targetType: ReportShareTarget, targetId: string) =>
    client.post(`/projects/${projectId}/report-shares`, { targetType, targetId }).then(data<ReportShare>),
  /** 撤销分享：链接立刻失效。 */
  revokeReportShare: (projectId: string, shareId: string) =>
    client.delete(`/projects/${projectId}/report-shares/${shareId}`).then(data<{ id: string }>),
  /** 公开读（免登录）：token → 报告只读视图。附件走 `publicReportAttachment`（同为 Blob）。 */
  publicReportShare: (token: string) =>
    client.get(`/public/report-shares/${encodeURIComponent(token)}`).then(data<PublicReportShare>),
  /** 公开附件（免登录）：token 即凭据，仍走 axios 只为统一 Blob 形状。 */
  publicReportAttachment: (token: string, name: string) =>
    client.get(`/public/report-shares/${encodeURIComponent(token)}/attachments`, { params: { name }, responseType: "blob" })
      .then((response) => response.data as Blob),
  /* ── 公开成员证据（套件报告分享页的成员抽屉，2026-09-03）────────────────────
   * 与站内三件同款拼装，鉴权从「项目成员」换成「持有 token」；归属由服务端的证据
   * 闭包判定（token 换的是这份报告的证据，不是项目的执行历史）。 */
  /** 用例成员的执行快照。 */
  publicShareExecution: (token: string, executionId: string) =>
    client.get(`/public/report-shares/${encodeURIComponent(token)}/executions/${encodeURIComponent(executionId)}`).then(data<Execution>),
  /** 流程成员的整次流程执行（run + steps + executionSteps，服务端一次带齐）。 */
  publicShareFlowSteps: (token: string, indexId: string) =>
    client.get(`/public/report-shares/${encodeURIComponent(token)}/flow-steps/${encodeURIComponent(indexId)}`).then(data<FlowExecutionDetail>),
  /** 容器步骤的内层证据（loop / subflow / 并发请求）。 */
  publicShareStepChildren: (token: string, stepId: string) =>
    client.get(`/public/report-shares/${encodeURIComponent(token)}/step-children/${encodeURIComponent(stepId)}`)
      .then(data<{ steps: ExecutionStep[]; executions: Execution[] }>),

  /* ── P5 起家 / P12 改形：MCP —— Token 归人（/me），绑定归项目 ───────────────
   * 能力面在 P12 从项目侧整个上移到用户级：签发 / 吊销是「本人」的动作（写权限的
   * 控制点在绑定上），项目侧只留「谁把钥匙开到我这扇门上」+ 项目管理员踢绑定。 */

  /** 我签发的 Token（含绑定数组）；已吊销的不列。 */
  meMcpTokens: () => client.get("/me/mcp/tokens").then(data<McpToken[]>),
  /**
   * 签发本人 Token：**request 里没有 scope**（scope 在绑定上）。返回的明文 token
   * 只在这**一次**响应里出现，丢了只能吊销重发。
   */
  createMeMcpToken: (input: { name: string }) =>
    client.post("/me/mcp/tokens", input).then(data<McpToken & { token: string }>),
  /** 吊销（软删留行）但**即时生效**：鉴权候选集走部分索引，被吊销行下一次调用就不在。 */
  revokeMeMcpToken: (tokenId: string) =>
    client.delete(`/me/mcp/tokens/${encodeURIComponent(tokenId)}`).then(data<McpToken>),
  /** 重新取回明文（2026-09-28 可重复复制）：可逆加密存储，丢了不必吊销重发。已吊销的取不到。 */
  meMcpTokenSecret: (tokenId: string) =>
    client.get(`/me/mcp/tokens/${encodeURIComponent(tokenId)}/secret`).then(data<{ id: string; token: string }>),
  /** 绑定 / 改绑定（同 (token, project) 重复提交 = 改 scope；服务端要求 ≤ 实时角色上限）。 */
  bindMeMcpToken: (tokenId: string, input: { projectId: string; scope: McpScope[] }) =>
    client.post(`/me/mcp/tokens/${encodeURIComponent(tokenId)}/bindings`, input).then(data<McpBinding>),
  /** 本人解绑（只删绑定行，Token 与其他项目的门照旧）。 */
  unbindMeMcpToken: (tokenId: string, projectId: string) =>
    client.delete(`/me/mcp/tokens/${encodeURIComponent(tokenId)}/bindings/${encodeURIComponent(projectId)}`)
      .then(data<{ tokenId: string; projectId: string }>),

  /** 本项目的全部绑定（谁的 Token / scope / last_used_at）；viewer 也可读。 */
  mcpBindings: (projectId: string) =>
    client.get(`/projects/${projectId}/mcp/bindings`).then(data<McpProjectBinding[]>),
  /** 项目管理员踢绑定（边界 4）：签发权上移后，项目侧对「谁能开我这扇门」的最终控制不丢。 */
  unbindMcpBinding: (projectId: string, tokenId: string) =>
    client.delete(`/projects/${projectId}/mcp/bindings/${encodeURIComponent(tokenId)}`)
      .then(data<{ tokenId: string; projectId: string }>),
  /** 工具清单（展示用非协议面）：与 /mcp 的 tools/list 出自同一个 MCP_TOOLS 注册表。 */
  mcpTools: (projectId: string) => client.get(`/projects/${projectId}/mcp/tools`).then(data<McpToolSummary[]>),

  /* ── MCP 绑定许可申请（2026-09-21）：成员申请 → 通知 project_admin → 批准即授权 ── */

  /** 提交许可证申请（只收角色上限之外的 write / execute；已能绑的档位服务端回 409）。 */
  createMcpBindingRequest: (projectId: string, input: { scope: McpScope[]; note?: string }) =>
    client.post(`/projects/${projectId}/mcp/binding-requests`, input).then(data<McpBindingRequest>),
  /** 本项目的许可证申请（project_admin）。 */
  mcpBindingRequests: (projectId: string, status?: "pending" | "approved" | "rejected") =>
    client.get(`/projects/${projectId}/mcp/binding-requests`, { params: { status } }).then(data<McpBindingRequest[]>),
  /** 本人跨项目的许可证申请（个人中心显示审批中 / 已批准态）。 */
  myMcpBindingRequests: () => client.get("/me/mcp/binding-requests").then(data<McpBindingRequest[]>),
  approveMcpBindingRequest: (id: string) =>
    client.post(`/mcp/binding-requests/${id}/approve`).then(data<McpBindingRequest>),
  rejectMcpBindingRequest: (id: string, note?: string) =>
    client.post(`/mcp/binding-requests/${id}/reject`, note ? { note } : {}).then(data<McpBindingRequest>),

  /* ── P12：个人中心（全局层，无项目前缀）──────────────────────────────────── */

  /** 基本信息（`/auth/me` 的聚合别名；改密仍走既有 change-password）。 */
  meProfile: () => client.get("/me/profile").then(data<MeProfile>),
  /** 可绑定项目集 + 每项目 scope 上限（绑定弹窗据此禁用选项）。 */
  bindableProjects: () => client.get("/me/bindable-projects").then(data<{ projects: BindableProject[]; total: number }>),

  /* ── 用户级 API 密钥（个人中心）：一人一把 AES 密钥，调用平台开放 API 的凭据本身。 */
  /** 本人密钥元数据；未设置回 null。永不含明文。 */
  apiKey: () => client.get("/me/api-key").then(data<ApiKey | null>),
  /** 重新取回明文（2026-09-28 可重复复制）：密钥本就是可逆加密存的，丢了不必轮换。未设置回 404。 */
  apiKeySecret: () => client.get("/me/api-key/secret").then(data<{ keyId: string; key: string }>),
  /** 生成 / 轮换：返回一次性明文密钥（`key`）。轮换即让旧密钥加密的所有调用地址失效。 */
  issueApiKey: () => client.post("/me/api-key").then(data<ApiKeyIssued>),
  /** 吊销：删本人密钥，已发出的所有调用地址立即失效。 */
  revokeApiKey: () => client.delete("/me/api-key").then(data<{ revoked: boolean }>),
  /** 让服务端用本人 API 密钥把一条 SQL 定义编成调用令牌；前端据此拼请求头与可复制 cURL。 */
  buildSqlQuickCall: (projectId: string, sqlId: string) =>
    client.post(`/projects/${projectId}/sql-definitions/${sqlId}/quick-call`).then(data<SqlQuickCall>),

  /* ── P8-2：失败归因（REST 四条 + 字典管理）────────────────────────────────── */

  /** 打标可用的分类（只回 active；任何能归因的人都要读，登录即可）。 */
  failureCategories: (projectId: string) =>
    client.get(`/projects/${projectId}/failure-categories`).then(data<FailureCategory[]>),
  /** 单条打标/重打标（upsert 语义；目标必须是本项目的失败行）。 */
  setFailureAttribution: (projectId: string, input: { targetType: AttributionTargetType; targetId: string; category: string; note?: string; bugUrl?: string }) =>
    client.post(`/projects/${projectId}/failure-attribution`, input).then(data<FailureAttribution>),
  /** 批量：一批失败同一个分类与备注（一次 CI 挂一片同因失败，边界 4）。 */
  batchFailureAttribution: (projectId: string, input: { targets: { targetType: AttributionTargetType; targetId: string }[]; category: string; note?: string; bugUrl?: string }) =>
    client.post(`/projects/${projectId}/failure-attribution/batch`, input).then(data<{ updated: number; requested: number }>),
  /** 清除归因（回到未归因）。 */
  clearFailureAttribution: (projectId: string, targetType: AttributionTargetType, targetId: string) =>
    client.delete(`/projects/${projectId}/failure-attribution`, { params: { targetType, targetId } }).then(data<{ id: string; removed: boolean }>),

  /* ── P8-2：归因类型管理（系统设置 tab，系统管理员）──────────────────────────── */

  /** 字典全量（含停用行——管理面要能看到并重新启用）。 */
  systemFailureCategories: () => client.get("/system/failure-categories").then(data<FailureCategory[]>),
  /** 新增：code 不可改（统计与 MCP 的稳定标识），position 缺省排队尾。 */
  createSystemFailureCategory: (input: { code: string; name: string; position?: number; active?: boolean }) =>
    client.post("/system/failure-categories", input).then(data<FailureCategory>),
  /** 改名 / 调序 / 启停（partial：只发出现的键；code 恒不可改）。 */
  updateSystemFailureCategory: (code: string, input: { name?: string; position?: number; active?: boolean }) =>
    client.patch(`/system/failure-categories/${encodeURIComponent(code)}`, input).then(data<FailureCategory>),
  /**
   * 删除。被归因行引用时回 409（`data.attributions` 是计数）；`force` 只在用户看过
   * 计数之后才发——服务端连带删掉那些归因行（回未归因，覆盖率下降是诚实代价）。
   */
  deleteSystemFailureCategory: (code: string, force = false) =>
    client.delete(`/system/failure-categories/${encodeURIComponent(code)}`, { params: force ? { force: "true" } : undefined })
      .then(data<{ id: string; removed: boolean; removedAttributions: number }>),

  /* ── P9-1：站内通知（用户级，无项目前缀）──────────────────────────────────── */

  /** 我的通知（分页）；unread=1 只看未读。 */
  notifications: (filters?: { unread?: boolean; page?: number; pageSize?: number }) =>
    client.get("/notifications", { params: { unread: filters?.unread ? "1" : undefined, page: filters?.page, pageSize: filters?.pageSize } })
      .then(paged<UserNotification>),
  /** 未读数（60s 轮询端点 + 页面获焦即拉）。 */
  notificationsUnreadCount: () =>
    client.get("/notifications/unread-count").then(data<{ count: number }>),
  /** 标已读。 */
  markNotificationRead: (id: string) =>
    client.post(`/notifications/${id}/read`).then(data<{ id: string; readAt: string }>),
  /** 全部已读。 */
  markAllNotificationsRead: () =>
    client.post("/notifications/read-all").then(data<{ updated: number }>),

  /* ── P9-3/P9-4b：助手 provider 管理面（系统管理员，全局层）────────────────── */

  /** provider 列表（通用协议 + 用户参数模式；conversationCount 是删除确认的影响面读数）。 */
  assistantProviders: () =>
    client.get("/system/assistant/providers").then(data<AssistantProvider[]>),
  /** 创建：协议浅校验在服务端，深对错归测试连接。 */
  createAssistantProvider: (input: AssistantProviderInput) =>
    client.post("/system/assistant/providers", input).then(data<AssistantProvider>),
  updateAssistantProvider: (id: string, input: AssistantProviderPatch) =>
    client.patch(`/system/assistant/providers/${id}`, input).then(data<AssistantProvider>),
  /** 删除（会话映射与用户 agent 行级联；影响面读数随行返回）。 */
  deleteAssistantProvider: (id: string) =>
    client.delete(`/system/assistant/providers/${id}`).then(data<{ id: string; removedConversations: number; removedUserAgents: number }>),
  /** 设为默认（推荐位：用户第一次配置 agent 时的预选）。 */
  setDefaultAssistantProvider: (id: string) =>
    client.post(`/system/assistant/providers/${id}/set-default`).then(data<AssistantProvider>),
  /** JSON 导入：{name,protocol,userParams}——模板不含任何凭据。 */
  importAssistantProvider: (input: AssistantProviderImport) =>
    client.post("/system/assistant/providers/import", input).then(data<AssistantProvider>),
  /** JSON 导出（下载件）。 */
  exportAssistantProvider: (id: string) =>
    client.get(`/system/assistant/providers/${id}/export`, { responseType: "blob" }).then((response) => response.data as Blob),

  /* ── P9-4b：助手的用户级路由（抽屉「设置」卡消费）─────────────────────────── */

  /** 上游目录（用户视角）：启用的 provider + 各自的参数模式。 */
  assistantUserProviders: () =>
    client.get("/assistant/providers").then(data<AssistantUserProvider[]>),
  /** 我的 agent 列表（secret 只回键名）。 */
  myAssistantAgents: () =>
    client.get("/assistant/my-agents").then(data<AssistantUserAgent[]>),
  /** 保存我的 agent：params 整份替换，secrets 三态（null 清除 / 字符串设置 / 缺省不动）。 */
  putMyAssistantAgent: (providerId: string, input: { params?: Record<string, string>; secrets?: Record<string, string | null> }) =>
    client.put(`/assistant/my-agents/${providerId}`, input).then(data<AssistantUserAgent>),
  /** 设为我的默认 agent（收发与新建会话都跟它）。 */
  setMyDefaultAssistantAgent: (providerId: string) =>
    client.post(`/assistant/my-agents/${providerId}/set-default`).then(data<AssistantUserAgent>),
  /** 用已保存的参数走一遍真链路（建会话 + ping）；回 JSON 摘要。 */
  testMyAssistantAgent: (providerId: string) =>
    client.post(`/assistant/my-agents/${providerId}/test`).then(data<{ ok: boolean; detail: string }>),

  /* ── P9-4：助手会话（项目级，抽屉消费）────────────────────────────────────── */

  /** 我的会话列表（读映射表，不调上游；providerCapabilities 决定停止按钮与历史加载）。
      2026-09-16 用户级化：会话是「人」的，不挂项目。 */
  assistantConversations: () =>
    client.get("/assistant/conversations").then(data<AssistantConversation[]>),
  /** 创建会话（按我的默认 agent 转发上游建会话，登录即用）。 */
  createAssistantConversation: () =>
    client.post("/assistant/conversations").then(data<AssistantConversation>),
  /** 删除会话（删本地映射行，协议配了 delete 端点时顺带清上游）。 */
  deleteAssistantConversation: (conversationId: string) =>
    client.delete(`/assistant/conversations/${conversationId}`).then(data<{ id: string; upstreamDeleted: boolean }>),
  /** 停止生成（协议没定义 stop 端点时 400——按钮本就不该出现，这是兜底）。 */
  stopAssistantConversation: (conversationId: string) =>
    client.post(`/assistant/conversations/${conversationId}/stop`).then(data<{ stopped: boolean }>),
  /** 历史代理（transcript 在上游；index/limit 是上游的分页游标）。 */
  assistantHistory: (conversationId: string, options?: { index?: string; limit?: number }) =>
    client.get(`/assistant/conversations/${conversationId}/messages`, { params: { index: options?.index, limit: options?.limit } })
      .then(data<AssistantChatMessage[]>),
  /** 记录 MRTR 确认结果（2026-09-15）：确认动作走既有 REST，上游 transcript 不知道；
      结果落平台侧 elicit_log，历史回放时并回。失败静默——记录丢一条只是回放少一行。 */
  recordElicitOutcome: (conversationId: string, body: { tool: string; outcome: "confirmed" | "declined"; input?: Record<string, unknown> }) =>
    client.post(`/assistant/conversations/${conversationId}/elicit`, body).then(data<{ recorded: boolean }>),

  /* ── P17：接口来源（全系统级；读 / 搜全员可用，管理仅系统管理员）───────────── */

  /** 全部来源（全局可见）。`type` 缺省不过滤。 */
  specSources: (type?: string) =>
    client.get("/spec-sources", { params: { type } }).then(data<SpecSource[]>),
  /** 单一来源的 operation 快照（本地搜，离线可用）。 */
  specSourceOperations: (sourceId: string, keyword?: string) =>
    client.get(`/spec-sources/${sourceId}/operations`, { params: { keyword } }).then(data<SpecSourceOperation[]>),
  /** 多来源聚合搜：结果按 (method,url) 去重、标签列出来源。传 `signal` 可取消上一笔在途搜索。 */
  searchSpecSources: (keyword: string, sourceIds: string[], signal?: AbortSignal) =>
    client.get("/spec-sources/search", { params: { keyword, sourceIds: sourceIds.join(",") }, signal }).then(data<SpecSourceOperation[]>),
  createSpecSource: (input: SpecSourceInput) =>
    client.post("/spec-sources", input).then(data<SpecSource>),
  updateSpecSource: (id: string, input: SpecSourceInput) =>
    client.patch(`/spec-sources/${id}`, input).then(data<SpecSource>),
  deleteSpecSource: (id: string) =>
    client.delete(`/spec-sources/${id}`).then(data<{ id: string }>),
  /** 显式刷新快照；取不到回 502（code 2008）。 */
  refreshSpecSource: (id: string) =>
    client.post(`/spec-sources/${id}/refresh`).then(data<SpecSource>),
};

/** 分享目标两类：套件报告与仓库执行报告。 */
export type ReportShareTarget = "suite" | "runner";

/** 一条有效分享（token 就是 URL 凭据——对项目成员可见，他们本来就能创建）。 */
export type ReportShare = {
  id: string;
  projectId: string;
  targetType: ReportShareTarget;
  targetId: string;
  token: string;
  createdBy?: string;
  createdAt: string;
  revokedAt?: string;
};

/** 公开分享载荷：按 kind 分派两份只读视图（与项目内详情同一份服务端拼装）。 */
export type PublicReportShare = {
  kind: ReportShareTarget;
  projectName: string;
  sharedAt: string;
  report: SuiteReport | RunnerReportPayload;
};

/** 仓库执行报告的分享载荷：run 摘要 + cases + allure 视图（与 report tab 同一形状）。 */
export type RunnerReportPayload = {
  run: PipelineRun;
  taskName: string;
  cases: PipelineRunCase[];
  report: AllureReportView | null;
};

/* ── P9-1：站内通知 ────────────────────────────────────────────────────────── */

/**
 * 一条站内通知（P9-1，计划 13.1/13.2）。kind 五值 = 五个生产源（成员变更 / 计划指派 /
 * 告警 / 套件结果 / CI 结果）。`link` 是站内相对路径（空串 = 无深链），点击跳转由
 * 前端按当前 origin 拼——换部署域名不产生死链。
 */
export type UserNotification = {
  id: string;
  projectId: string | null;
  /** 项目删除后仍可读（那件事发生过）；null = 系统级或项目已删。 */
  projectName: string | null;
  kind: "member_change" | "plan_assign" | "alert" | "suite_result" | "ci_result" | "access_request" | "mcp_binding_request";
  title: string;
  body: string;
  link: string;
  readAt: string | null;
  createdAt: string;
};

/* ── P9-3/P9-4b：助手 provider（通用协议）+ 用户级 agent ───────────────────── */

/** 能力面（P9-4b 起按协议形状派生：定义了对应端点 = 有该能力）。 */
export type AssistantCapabilities = { stop: boolean; history: boolean; attachments: boolean };

/** 用户参数模式（管理员在 provider 上定义；抽屉「设置」卡按它渲染表单）。 */
export type AssistantUserParam = {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
};

/**
 * 通用协议配置（P9-4b，2026-09-14 修订）：4 个接口（建会话 / 发消息 SSE / 停止 /
 * 历史）+ SSE 事件映射 + 认证模板。换平台 = 管理员填一份这个，零开发。形状与服务端
 * `lib/assistant/types.ts` 同源；深校验归测试连接（真上游回答）。
 */
export type AssistantProtocol = {
  baseUrl: string;
  auth?: { header: string; value: string };
  successCode?: { field: string; value: string };
  createConversation: { method: string; path: string; body?: Record<string, unknown>; conversationId: string };
  chat: { method: string; path: string; body?: Record<string, unknown> };
  stop?: { method: string; path: string; body?: Record<string, unknown> };
  /** 删上游会话本体（可选；用户删除会话时顺带清上游，没有则只删本地映射行）。 */
  delete?: { method: string; path: string; body?: Record<string, unknown> };
  history?: { method: string; path: string; query?: Record<string, string>; messages: string; fields: Record<string, string> };
  attachments?: boolean;
  sse: {
    eventField: string;
    token?: { on: string; text: string };
    /** `input`（2026-09-15）：工具调用入参的点路径——elicit 事件靠它带出删除目标。 */
    tool?: { on: string; name: string; status: string; nameFallback?: string; input?: string };
    /** MRTR 确认表单的识别（2026-09-15）：与 token 同 kind，靠判别字段区分。 */
    elicit?: { on: string; type: string; typeValue: string; text: string; tool: string; schema: string };
    done?: { on: string; text: string; success?: string };
    error?: { on: string; message: string };
    ignore?: string[];
  };
};

/**
 * provider 管理行（系统管理面）。没有共享 Key——凭据是用户级的（AssistantUserAgent）；
 * `capabilities` 从协议形状派生（停止按钮显隐 / 历史加载，门槛 13）。
 */
export type AssistantProvider = {
  id: string;
  name: string;
  protocol: AssistantProtocol;
  userParams: AssistantUserParam[];
  capabilities: AssistantCapabilities;
  enabled: boolean;
  isDefault: boolean;
  conversationCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AssistantProviderInput = {
  name: string;
  protocol: AssistantProtocol;
  userParams?: AssistantUserParam[];
  enabled?: boolean;
};

export type AssistantProviderPatch = {
  name?: string;
  protocol?: AssistantProtocol;
  userParams?: AssistantUserParam[];
  enabled?: boolean;
};

/** 导入载荷：与服务端同形——凭据本来就是用户级的，模板里无从带密。 */
export type AssistantProviderImport = {
  name: string;
  protocol: AssistantProtocol;
  userParams?: AssistantUserParam[];
};

/**
 * 接口来源（P17）：一个「可以去取接口定义的地方」。全系统级、全局可见可选；只有系统
 * 管理员能建 / 改 / 删。`credentialConfigured` 只回「有没有凭据」，明文永不下发。
 * `operationCount` 是快照里的 operation 数（列表用，不把整份快照发给前端）。
 */
export type SpecSource = {
  id: string;
  name: string;
  type: string;
  url: string;
  credentialConfigured: boolean;
  config: Record<string, unknown>;
  isTemporary: boolean;
  status: "ok" | "error";
  operationCount: number;
  cacheFetchedAt?: string;
  createdByEmail?: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 建 / 改来源的载荷。凭据三态：null 清除 / 字符串设置 / 缺省不动（改时）。 */
export type SpecSourceInput = {
  name: string;
  type: string;
  url: string;
  credential?: string | null;
  config?: Record<string, unknown>;
  isTemporary?: boolean;
};

/** 搜索命中的 operation：EndpointInput 字段 + 来源标签，供创建表单预填（不落库）。 */
export type SpecSourceOperation = {
  method: string;
  url: string;
  path: string;
  name: string;
  description: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  pathParams: Record<string, string>;
  bodyType: BodyType;
  body?: unknown;
  tags: string[];
  sourceId: string;
  sourceName: string;
  sources: string[];
};

/**
 * 用户视角的上游目录（P9-4b）：启用的 provider + 各自的参数模式——「设置」卡按它
 * 渲染表单（选择这个上游要填什么）。
 */
export type AssistantUserProvider = {
  id: string;
  name: string;
  isDefault: boolean;
  userParams: AssistantUserParam[];
};

/**
 * 我的 agent（一个上游一份配置）。`params` 只含明文参数；`secretKeys` 是敏感项的
 * 键名清单（值加密落库、接口只回「已配置」——environments 的 secretKeys 同款纪律）。
 */
export type AssistantUserAgent = {
  providerId: string;
  providerName: string;
  providerEnabled: boolean;
  params: Record<string, string>;
  secretKeys: string[];
  isDefault: boolean;
  updatedAt: string;
};

/* ── P9-4：助手会话（项目级）───────────────────────────────────────────────── */

/**
 * 一行「平台 ↔ 上游会话」映射（P9-2 落结构、P9-4 起被抽屉消费）。对话正文不落库：
 * transcript 在 agent 平台侧。`providerCapabilities` 随行带出——停止按钮的显隐
 * （门槛 13）与历史加载都按它，抽屉不问系统管理面（那是仅系统管理员的）。
 */
export type AssistantConversation = {
  id: string;
  providerId: string;
  userId: string;
  upstreamConversationId: string;
  topic: string;
  providerCapabilities: AssistantCapabilities;
  createdAt: string;
  lastActiveAt: string;
};

/**
 * 历史消息的归一形态（adapter 翻译过：id/role/text/time，P9-4 的消息流只消费这四个）。
 * `system` 行（2026-09-15）是平台自己的记录（MRTR 确认结果并回，text 为空、结构化
 * 载荷在 elicit 里——前端按 i18n 渲染，不落服务端硬编码文案）。
 */
export type AssistantChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  time?: string;
  elicit?: { tool: string; outcome: "confirmed" | "declined"; input?: Record<string, unknown> };
};

/**
 * 归一事件（与 lib/assistant/types.ts 同形）：代理路由与前端唯一认知的事件形状。
 * `done` / `error` 是终态——测试连接的回显以二者之一收尾。
 * `elicit`（2026-09-15）是上游转述的 MRTR 确认表单：agent 的删除类工具被 /mcp
 * 闸门拦下后，上游把确认请求转成聊天事件；确认动作走本人 JWT 的既有 REST。
 * `error.code`（P9-8）是**平台自己**判定的失败类别——限流 / 上游静默 / 流无终态 /
 * 流中途断开四种，界面按码换本地化文案；上游自己报的错不带码，`message` 原样透出
 * （那是上游说的话，平台不该替它改写）。
 */
export type AssistantErrorCode = "rate_limited" | "upstream_silent" | "stream_incomplete" | "upstream_stream_failed";

export type AssistantEvent =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; status: string }
  | { type: "elicit"; text: string; tool: string; input?: Record<string, unknown>; schema?: unknown }
  | { type: "done"; fullText: string }
  | { type: "error"; message: string; code?: AssistantErrorCode };

/**
 * 测试连接的 SSE 消费（P9-3 起家、P9-4b 带临时参数）：单发单收，不重连——测试是诊断
 * 动作，失败重试由人决定。`params` 是一组**临时参数**（如 agentId / apiKey 的测试值，
 * 明文只在这一次请求里旅行，不落库——凭据是用户级的，系统行上没有可测的 Key）。
 * 与 subscribeExecutions 同一种手写解析（SSE 帧按空行切，长 JSON 可能被 chunk 拦腰
 * 截断，不能逐行喂 JSON.parse）；hijack 前的错误以 error 终态事件送出（服务端保证
 * 两段式），调用方只需认 done / error。
 */
export function streamAssistantProviderTest(providerId: string, params: Record<string, string>, onEvent: (event: AssistantEvent) => void): { done: Promise<boolean>; stop: () => void } {
  const controller = new AbortController();
  const done = (async () => {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/system/assistant/providers/${providerId}/test`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${localStorage.getItem("apitest.token") ?? ""}` },
        body: JSON.stringify({ params }),
        signal: controller.signal,
      });
    } catch {
      return false;
    }
    if (!response.ok || !response.body) {
      onEvent(await refusalEvent(response));
      return false;
    }
    return consumeAssistantSse(response, onEvent);
  })();
  return { done, stop: () => controller.abort() };
}

/**
 * 发消息的 SSE 消费（P9-4）：与测试连接同一条链路同一种两段式——hijack 前的失败
 * （503/2005 未配置、502/2006 上游不可达、400 校验）是干净 JSON，翻译成 error 终态
 * 事件送出；hijack 后只有终态帧。调用方只认 done / error，与测试回显同一契约。
 * `context`（P9-4c）是页面上下文：服务端归一后封围栏前缀拼进转发的 message——
 * 历史回放时会被剥掉，气泡里永远只有用户打的字。
 */
export function streamAssistantMessage(conversationId: string, messageText: string, onEvent: (event: AssistantEvent) => void, context?: AssistantPageContext): { done: Promise<boolean>; stop: () => void } {
  const controller = new AbortController();
  const done = (async () => {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/assistant/conversations/${conversationId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${localStorage.getItem("apitest.token") ?? ""}` },
        body: JSON.stringify({ message: messageText, ...(context ? { context } : {}) }),
        signal: controller.signal,
      });
    } catch {
      return false;
    }
    if (!response.ok || !response.body) {
      onEvent(await refusalEvent(response));
      return false;
    }
    return consumeAssistantSse(response, onEvent);
  })();
  return { done, stop: () => controller.abort() };
}

/**
 * hijack 前的干净 JSON 错误 → error 终态事件（服务端两段式保证）。429 打上游限流的
 * 码：界面要说的是「稍后重试」而不是把上游的英文错误原样贴出来（P9-8）。
 */
async function refusalEvent(response: Response): Promise<AssistantEvent> {
  let message = `HTTP ${response.status}`;
  try { message = String((await response.json() as { message?: unknown })?.message ?? message); } catch { /* keep status line */ }
  return response.status === 429 ? { type: "error", message, code: "rate_limited" } : { type: "error", message };
}

/**
 * 助手 SSE 体的公共消费腿（测试连接与发消息共用）：帧按空行切，`data:` 行才是载荷
 * （`event:` 行与 `: ping` 注释行丢弃——事件形状在 data JSON 的 type 里）；done 终态
 * 返回 true，error 终态或流中断返回 false。
 */
async function consumeAssistantSse(response: Response, onEvent: (event: AssistantEvent) => void): Promise<boolean> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let ok = false;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    buffer += value;
    let split = buffer.indexOf("\n\n");
    for (; split !== -1; split = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!data) continue;
      try {
        const event = JSON.parse(data.slice(5).trim()) as AssistantEvent;
        onEvent(event);
        if (event.type === "done") { ok = true; return ok; }
        if (event.type === "error") return false;
      } catch { /* ignore malformed frame */ }
    }
  }
  return ok;
}

/**
 * 助手可用性探测（P9-3 项目侧引导）：读助手路由组自己的闸门语义——
 * 200 = 就绪；503 + 2005 = 已开启但无启用的默认 provider（边界 15 的「未配置」信号）；
 * 404 = 未开启。其他错误（网络）返回 undefined，页面显示「—」而不是猜一个状态。
 */
/**
 * 助手可用性探测（2026-09-16 用户级化：不再需要项目参数）：读助手路由组自己的
 * 状态——200 = 就绪；503 + 2005 = 无启用的默认 provider/未配置 agent（「未配置」
 * 信号）。其他错误（网络）返回 undefined，页面显示「—」而不是猜一个状态。
 */
export async function probeAssistantAvailability(): Promise<"ready" | "unconfigured" | "disabled" | undefined> {
  try {
    await client.get("/assistant/conversations");
    return "ready";
  } catch (error) {
    return classifyAssistantError(error);
  }
}

/**
 * 把助手路由组的失败归到闸门语义（P9-4 抽屉复用）：unconfigured = 503+2005（找系统
 * 管理员配 provider）；disabled = 404（项目开关被别处关掉）；其余（网络/上游）undefined
 * ——按普通错误处理，不猜一个状态。
 */
export function classifyAssistantError(error: unknown): "unconfigured" | "disabled" | undefined {
  const response = (error as { response?: { status?: number; data?: { code?: number } } })?.response;
  if (response?.status === 503 && response.data?.code === 2005) return "unconfigured";
  if (response?.status === 404) return "disabled";
  return undefined;
}

/**
 * 429 = 上游限流（服务端错误码 2007，P9-8）。**不并入 classifyAssistantError**：那个
 * 函数回答的是「助手能不能用」（决定输入框显不显示），限流回答的是「这一次为什么
 * 失败」——混进同一个枚举会让限流把输入框藏起来。
 */
export function isRateLimited(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 429;
}
