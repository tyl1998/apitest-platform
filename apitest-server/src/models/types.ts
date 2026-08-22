export type Role = "project_admin" | "developer" | "viewer";
export type User = { id: string; email: string; name: string; passwordHash: string; isSystemAdmin: boolean };
export type Project = { id: string; name: string; description: string; ownerId: string; createdAt: string };
/**
 * Secret values never leave the server (Spec 4.6 默认掩码). Only the key names
 * travel, so the UI can show "configured" without ever holding the plaintext.
 */
export type Environment = { id: string; projectId: string; name: string; variables: Record<string, string>; secretKeys: string[] };
export type BodyType = "none" | "json" | "form" | "text";
export type EndpointAuth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apiKey"; key: string; value: string; in: "header" | "query" };

export type Endpoint = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  pathParams: Record<string, string>;
  bodyType: BodyType;
  /** Parsed JSON body, used when bodyType is "json". */
  body?: unknown;
  /** Raw payload for form/text bodies, kept so switching type loses nothing. */
  bodyText?: string;
  auth: EndpointAuth;
  tags: string[];
  defaultEnvironmentId?: string;
  createdAt: string;
  updatedAt: string;
};
/**
 * The request definition a test case freezes (交互文档 3.1.3 完全快照隔离).
 *
 * It carries the same fields as an endpoint definition minus identity and
 * ownership, because a case must keep running the request it was saved with
 * even after the endpoint it came from is edited.
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

/**
 * Assertion kinds (交互文档 3.1.3, 计划 4.0.1):
 * `status` compares the HTTP status code, `header` a response header,
 * `jsonPath` a value inside the JSON body, `jsonSchema` validates the whole
 * body against a schema, `script` runs user JavaScript in a sandbox.
 *
 * The last two are not "another operator" — they have their own input shapes,
 * which is why `expected` carries the schema text and `script` carries a
 * reference instead.
 */
export type AssertionType = "status" | "header" | "jsonPath" | "jsonSchema" | "script";
export type AssertionOperator = "equals" | "notEquals" | "contains" | "exists" | "notExists" | "greaterThan" | "lessThan" | "matchesSchema" | "isTrue";

/**
 * How an assertion points at its script (计划 4.0.1 确认: follow / copy).
 *
 * On save the client sends one of three shapes, and the server does the whole
 * upsert in one transaction so no round trip can leave an orphan or a dangling
 * reference:
 *   - `{ scriptId, content }` — edited, so update that row
 *   - `{ scriptId }`          — untouched, leave it alone
 *   - `{ content }`           — new, insert and hand back the id
 *
 * Only edited scripts carry `content`, which is what keeps a 20-step save from
 * shipping every script body it did not change.
 */
export type ScriptRef = {
  /** Absent only for a script being created in this same request. */
  scriptId?: string;
  /** Present only when the body was edited (or is new). */
  content?: string;
  /**
   * Library scripts to prepend, by id (P1-2, migration 014).
   *
   * The write and read channel for `script_deps`. A shared SM4 implementation or
   * a company-wide signing helper lives in one `kind='library'` script and is
   * declared here, instead of being copy-pasted into every script that signs.
   */
  dependencies?: string[];
  /**
   * Library **sources**, inlined at enqueue time for the worker.
   *
   * Same reason `content` is inlined into `run_spec`: the worker must not read
   * the scripts table, so that editing a library after a run was queued cannot
   * change what that run executes.
   */
  libraries?: string[];
};

export type Assertion = {
  type: AssertionType;
  /**
   * Local display name, optional. Same role as `HookConfig.name`: a case with
   * several script assertions is unreadable when every row says "脚本", so the
   * editor lets the user label each one. Lives on the assertion (stored in the
   * jsonb) rather than the script — the same public script can be labelled
   * differently per case, exactly like a hook's name.
   */
  name?: string;
  /** Header name, or a JSONPath such as `$.data.token`. Unused by `status`. */
  target?: string;
  operator: AssertionOperator;
  /**
   * Comparison value; also the place a `jsonSchema` assertion stores its schema
   * document, inline as text (确认: schema 不是代码, 不走 scripts 表).
   * Absent for exists / notExists, which have nothing to compare against.
   */
  expected?: string;
  /** Set only on `script` assertions. */
  script?: ScriptRef;
};
/**
 * One `ctx.assert(...)` call a script made, and how it went.
 *
 * Per call rather than one boolean per script: a script may now make several
 * checks, and "脚本断言失败" is not actionable while "第 3 条 expected 200, got
 * 500" is. Passing checks are recorded too, because a green script that lists
 * nothing it verified is indistinguishable from a script that checked nothing.
 */
export type ScriptCheck = { label: string; passed: boolean; message?: string };

export type AssertionResult = Assertion & {
  passed: boolean;
  /**
   * Evidence, per type: the read value for status/header/jsonPath, the parsed
   * body for jsonSchema, and for `script` whatever the script returned —
   * recorded as context, never as the verdict (计划 4.0.2).
   */
  actual?: string;
  message?: string;
  /** `script` assertions only: every `ctx.assert` call, in order. */
  checks?: ScriptCheck[];
};

/**
 * A stored piece of user JavaScript (计划 4.0.1).
 *
 * Two modes, distinguished by `name`, enforced by a CHECK in migration 011:
 *   - **具名公共脚本** (`name` set, no owner): project-level and referenced from
 *     many places. Editing it changes every follower — which is the point, and
 *     why the UI must make following an explicit choice.
 *   - **匿名私有脚本** (no `name`, owned by a case): created inline, deleted with
 *     its host. A follower that chooses "copy" lands here, detached from the
 *     public script it came from.
 */
export type Script = {
  id: string;
  projectId: string;
  /** Absent for anonymous scripts. Unique per project when present. */
  name?: string;
  language: "javascript";
  /** Stored purpose. `response` is the P2-2.1 post-response script kind. */
  kind: "assertion" | "hook" | "response" | "library" | "node";
  content: string;
  ownerCaseId?: string;
  /** Library ids this script depends on, in declaration order. */
  dependencies: string[];
  createdAt: string;
  updatedAt: string;
};

export type TestCase = {
  id: string;
  projectId: string;
  endpointId: string;
  name: string;
  description: string;
  environmentId?: string;
  /** Snapshotted, so a case still says which environment it targets after a delete. */
  environmentName?: string;
  request: RequestSnapshot;
  assertions: Assertion[];
  preRequestHooks: HookConfig[];
  extracts: FlowExtract[];
  responseScripts: ResponseScriptConfig[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

/**
 * One value a节点 lifts out of its response into the flow variable bag (P1-2).
 *
 * This is the only channel between steps. Without it a DAG is just a list of
 * unrelated requests, because nothing a step returns can reach the next one.
 * The extracted name is used as a plain `{{name}}`, i.e. the same syntax as an
 * environment variable, so a node body written against an environment keeps
 * working unchanged once the value starts coming from an upstream step.
 */
export type FlowExtract = {
  name: string;
  /** `body` reads a JSONPath, `header` a header name, `status` the status code. */
  from: "body" | "header" | "status";
  /** JSONPath (`$.data.token`) or header name. Unused by `status`. */
  path?: string;
};

/**
 * What one extract actually produced (P1-2 收尾).
 *
 * Recorded per extract rather than collapsed into one "could not extract: a, b"
 * message, because the three ways it fails — the path is wrong, the body is not
 * JSON, the field really is null — have three different fixes, and a combined
 * message tells the user none of them.
 */
export type FlowExtractResult = FlowExtract & {
  ok: boolean;
  /** The captured text, present when `ok`. Masked before it is stored. */
  value?: string;
  /** Why it produced nothing, present when not `ok`. */
  reason?: string;
};

/**
 * A 前置钩子 attached to a request (P1-2, migration 014).
 *
 * Deliberately a *kind* plus a payload rather than a bare script reference. The
 * need this answers — "sign the final body and put the result in a header" — has
 * many house implementations, and the platform should not have to guess which
 * one a team uses. `script` is the first kind; a webhook that delegates to an
 * internal signing service, or a handful of built-in algorithms, are additional
 * keys in the provider table (`lib/hooks.ts`) and nothing else.
 */
export type HookConfig = {
  type: "script";
  /** Shown in results. Defaults to `hook N` when the user leaves it blank. */
  name?: string;
  /** Off keeps the configuration around while taking it out of the run. */
  enabled?: boolean;
  /** Set when `type` is `script`. */
  script?: ScriptRef;
};

/**
 * What one hook did, per hook (P1-2).
 *
 * `debug` is the part that matters in practice: a signature mismatch is
 * diagnosed by comparing the string that was signed, and the platform cannot
 * know which of a script's intermediate values that was — only the script can
 * say, via `ctx.debug("待签原串", raw)`.
 */
export type HookResult = {
  name: string;
  type: string;
  ok: boolean;
  error?: string;
  logs: string[];
  debug: { label: string; value: string }[];
  /** Every `ctx.assert(...)` the hook made, in order. Absent on pre-4.0.2 rows. */
  checks?: ScriptCheck[];
  /** Which parts of the request it rewrote: `headers`, `body`, `url`, … */
  changed: string[];
};

/** A response script attached to a request node (P2-2.1). */
export type ResponseScriptConfig = {
  type: "script";
  /** Shown in execution evidence. Defaults to `response script N`. */
  name?: string;
  /** Off keeps the configuration while excluding it from the run. */
  enabled?: boolean;
  script?: ScriptRef;
};

/** One response script's sanitized, reviewable execution evidence. */
export type ResponseScriptResult = {
  name: string;
  type: string;
  ok: boolean;
  error?: string;
  logs: string[];
  debug: { label: string; value: string }[];
  checks: ScriptCheck[];
  returned?: string;
  /** Proposed writes; committed only when the whole request node passes. */
  variables: Record<string, string>;
};

/**
 * A flow node (P1-2 首轮：只有 request).
 *
 * `request` is a copy, not a reference (交互文档 3.1.3 快照隔离), for the same
 * reason a test case copies it: editing the endpoint must not silently change
 * what an existing flow sends. `endpointId` therefore expresses origin and
 * ownership only — it names the run in history and keeps the接口维度 statistics
 * honest, it is not read at execution time.
 */
export type FlowNodeBase = {
  /** Client-generated and stable; edges and execution rows reference it. */
  id: string;
  name: string;
  /** Canvas layout. Also the tie-break for nodes the edges leave unordered. */
  position: { x: number; y: number };
  onFailure: "stop" | "continue";
};

/**
 * A 脚本节点 (P2-2): user JavaScript that reads and writes the variable bag.
 *
 * Unlike an assertion (which judges a response) or a hook (which rewrites the
 * request), a script node is a computation step: it sees `ctx.variables`, may
 * assert with `ctx.assert`, writes back with `ctx.setVariable`, and a returned
 * plain object is merged into the bag. Its verdict is the sandbox contract —
 * a thrown error or failed check fails the step, a clean run succeeds.
 */
export type ScriptFlowNode = FlowNodeBase & {
  type: "script";
  /** Same follow/copy shape as an assertion or hook script. */
  script: ScriptRef;
};

/** How a condition compares a bag value (P2-2). */
export type ConditionOperator = "equals" | "notEquals" | "contains" | "exists" | "notExists" | "greaterThan" | "lessThan";
export type ConditionRule = {
  /** A variable name, with or without `{{ }}` — both spell the same lookup. */
  variable: string;
  operator: ConditionOperator;
  /** Absent for exists / notExists. May itself reference `{{vars}}`. */
  value?: string;
};
export type ConditionGroup = {
  /** `all` = AND, `any` = OR. Flat group in P2-2; nested groups stay out of scope. */
  mode: "all" | "any";
  rules: ConditionRule[];
};

/**
 * A 条件节点 (P2-2): evaluates one rule against the variable bag and routes
 * edges. It never "fails" — a false evaluation is a valid decision — and its
 * outgoing edges must declare `on: "true" | "false"` to pick a branch.
 */
export type ConditionFlowNode = FlowNodeBase & {
  type: "condition";
  condition: ConditionGroup;
};

export type RequestFlowNode = FlowNodeBase & ConcurrentRequestNode & {
  type: "request";
  endpointId: string;
  /**
   * Provenance only. A node remains a complete request/assertion snapshot —
   * changing the source case must never alter a stored flow — but this tells
   * the editor which case to display after reopening it.
   */
  sourceCaseId?: string;
  sourceCaseName?: string;
  request: RequestSnapshot;
  assertions: Assertion[];
  extracts: FlowExtract[];
  responseScripts: ResponseScriptConfig[];
  /**
   * Runs after variables are resolved and before the request is sent (P1-2).
   *
   * Stored on the node rather than in a table of its own: a hook is part of what
   * this step *sends*, so it belongs to the same snapshot as the request it
   * rewrites. Keeping it in `flows.nodes` also means the flow document stays the
   * single thing to copy when a flow is duplicated.
   */
  preRequestHooks?: HookConfig[];
  /**
   * What a failure does to the rest of the flow. `stop` is the default because
   * a flow is a dependency chain: continuing after the login step failed would
   * produce a page of failures that all say the same thing.
   */
};

export type SqlStatementType = "query" | "command";
export type SqlParameterDefinition = {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "json";
  required?: boolean;
  defaultValue?: unknown;
};

/** MongoDB operations (P2-7.3). Filter/pipeline values may carry `{{name}}`
    tokens that are deep-resolved before driver binding. */
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

export type DatabaseFlowNode = FlowNodeBase & {
  type: "database";
  dataSourceId: string;
  sqlDefinitionId?: string;
  /** Inline SQL, mutually exclusive with `operation` and `sqlDefinitionId`. */
  sql?: string;
  /** Present only for mongo/redis data sources; inline operations for the
      mongo/redis drivers (P2-7.3). */
  operation?: DataSourceOperation;
  statementType?: SqlStatementType;
  /** Values at this call site. `{{flowVar}}` is resolved before driver binding. */
  parameters: Record<string, unknown>;
  assertions: Assertion[];
  extracts: FlowExtract[];
};

/**
 * A 等待节点 (P2-6): pauses the branch it sits on for a bounded time.
 *
 * First version is deliberately a **short** wait, not a suspend/resume model:
 * the node holds one of the flow's concurrency slots while it sleeps, so the
 * cap (`MAX_WAIT_MS`) is what keeps a wait from turning a worker slot into a
 * parking space. "Wait until a condition holds" is a different feature and
 * stays out of scope.
 */
/**
 * 请求步骤自身的并发次数（P2-6 修订）。
 *
 * 只有请求步骤有并发：它是「同一个接口发 N 个并发请求」的表达，这是并发的意义
 * 所在。数据库/SQL、脚本、等待、条件并发跑没有价值，所以不给它们这个字段——一个
 * 步骤能选并发，用户就会下意识地去选，而并发跑 SQL 除了撞锁没有别的产出。
 *
 * 设 N>1 时，该请求自己跑 N 次并发，提取的变量按迭代序收集成 JSON 数组（与循环
 * 出参同一套语义），证据是该步骤下挂了 N 个子行。
 */
export type ConcurrentRequestNode = { concurrency?: number };

export type WaitFlowNode = FlowNodeBase & {
  type: "wait";
  /** Milliseconds. Validated against `MAX_WAIT_MS`. */
  waitMs: number;
};

/**
 * How a 子流程 / 循环 node points at the flow it runs (P2-6).
 *
 * The inner flow is referenced, not copied: unlike a request node — where the
 * snapshot rule exists so editing an endpoint cannot change a stored flow — a
 * subflow's whole purpose is to be **one** definition several flows reuse, so a
 * fix to the login chain has to reach every caller. Reproducibility of a single
 * run is preserved a different way: the inner graph is frozen into `run_spec`
 * at enqueue time, exactly like a script body.
 */
export type FlowReference = {
  flowId: string;
  /** Snapshot for the canvas and for history after a rename or delete. */
  flowName?: string;
  /**
   * Values handed to the inner bag, highest priority. May reference the outer
   * bag as `{{name}}`, which is how a caller passes an argument.
   */
  inputs?: Record<string, string>;
  /**
   * Which inner variables are published back outward. Absent means all of them
   * — an allow-list exists so a reusable subflow can declare a narrow return
   * surface instead of leaking every intermediate value into the caller.
   */
  outputs?: string[];
};

/** A 子流程节点 (P2-6): runs another flow of this project once, inline. */
export type SubflowFlowNode = FlowNodeBase & { type: "subflow" } & FlowReference;

/** `count` repeats a fixed number of times, `list` iterates a JSON array. */
export type LoopMode = "count" | "list";

/**
 * 循环节点是**画布上的容器**（P2-6 修订）。
 *
 * 修订前循环引用另一条流程当循环体——用户明确否定了这个模型：循环该做的是「在画布上
 * 包住若干步骤」，而不是让人先造一条流程。现在 `body` 就是内联的子图：添加循环后可以
 * 直接往里加步骤，画布上它框住这些步骤；体内的步骤可以是任意节点类型，包括子流程
 * 节点（「循环内引用子流程」由此天然成立，不需要循环自己引用）。
 *
 * 迭代在**节点内部**：外层图始终是 DAG，既有的分层并行、边条件、跳过传播、取消语义
 * 不变。迭代**互相独立**——每次迭代从同一份外层变量快照起步，并发下让迭代互读必然
 * 产生调度相关的非确定结果。体内步骤直接读外层变量袋（内联容器与流程共享作用域，
 * 不需要子流程那套显式入参），另暴露 item / index 两个变量。
 */
export type LoopFlowNode = FlowNodeBase & {
  type: "loop";
  mode: LoopMode;
  /** `count` mode. Validated against `MAX_LOOP_ITERATIONS`. */
  count?: number;
  /** `list` mode: a variable holding a JSON array, with or without `{{ }}`. */
  listVariable?: string;
  /** `list` mode: the name the current element is exposed under in the body. */
  itemVariable?: string;
  /** Name the 0-based iteration index is exposed under inside the body. */
  indexVariable: string;
  /**
   * How many iterations may be in flight, default 1 (sequential).
   *
   * 循环自己的并发：N 次迭代同时跑。真实并发仍受整次执行的令牌池封顶，这是形状声明
   * 而非压测设施。**请求步骤的并发不在这里**——那在 RequestFlowNode.concurrency，
   * 两者正交：请求并发是「一个请求跑 N 次并发」，循环并发是「N 次迭代在飞」。
   */
  concurrency?: number;
  /**
   * Which inner variables are collected per iteration into JSON arrays, e.g.
   * declaring `orderId` makes the outer `{{orderId}}` a `["A","B"]` array ordered
   * by iteration. Absent means all of them.
   */
  outputs?: string[];
  /** 内联子图：画布容器，添加循环后往里加步骤。 */
  body: { nodes: FlowNode[]; edges: FlowEdge[] };
  /**
   * 画布上这个框的大小。
   *
   * 容器和普通节点不同：位置决定它在哪，尺寸决定它**能框住多少**。默认框只放得下
   * 一张卡时，想把两步并排就会因为第二张卡的中心落在框外而被移出循环——所以尺寸必须
   * 可调且要存下来，和 `position` 同理。运行时不读它。
   */
  size?: { width: number; height: number };
};

export type FlowNode = RequestFlowNode | DatabaseFlowNode | ScriptFlowNode | ConditionFlowNode | WaitFlowNode | SubflowFlowNode | LoopFlowNode;

/**
 * When an incoming edge activates (P2-2).
 *
 * Absent means the default: activate only after the source **succeeded**.
 * `failure` is the explicit failure branch — the only way a failed node's
 * successors run. `true` / `false` are the condition node's two exits; a
 * condition node never "fails", so its edges must declare one of these.
 */
export type FlowEdgeCondition = "success" | "failure" | "true" | "false";

export type FlowEdge = { id: string; source: string; target: string; on?: FlowEdgeCondition };

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

/** What the flow decided to run, kept after `run_spec` is cleared (see 012). */
export type FlowPlanStep = { nodeId: string; name: string; type: FlowNode["type"]; endpointId?: string };

/** Data source driver types. The schema CHECK already covers all six (migration
    024); the adapter registry (lib/adapters) is what actually implements a type,
    so a type in this union can still be "not implemented yet". */
export type DataSourceType = "postgresql" | "mysql" | "sqlserver" | "oracle" | "mongodb" | "redis";

export function defaultPort(type: DataSourceType | undefined): number {
  switch (type) {
    case "mysql": return 3306;
    case "sqlserver": return 1433;
    case "oracle": return 1521;
    case "mongodb": return 27017;
    case "redis": return 6379;
    default: return 5432;
  }
}

/** The one definition kind a data source of this type can hold: the four
    relational drivers store SQL, mongo/redis store an `operation` document
    (P2-7). Lets the route layer reject a kind/type mismatch at save time
    without loading a driver. */
export function definitionKind(type: DataSourceType | undefined): "sql" | "mongo" | "redis" {
  return type === "mongodb" ? "mongo" : type === "redis" ? "redis" : "sql";
}

export type DataSourceConfig = {
  host: string;
  port: number;
  database: string;
  username: string;
  ssl?: boolean;
  sslRejectUnauthorized?: boolean;
  /** MongoDB authentication database (mongodb driver only). */
  authSource?: string;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
  maxRows?: number;
  maxResultBytes?: number;
};

export function normalizeDataSourceConfig(value: unknown, type?: DataSourceType): DataSourceConfig {
  const config = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    host: String(config.host ?? ""),
    port: Number(config.port ?? defaultPort(type)),
    database: String(config.database ?? ""),
    username: String(config.username ?? ""),
    ssl: Boolean(config.ssl),
    sslRejectUnauthorized: config.sslRejectUnauthorized !== false,
    authSource: config.authSource ? String(config.authSource) : undefined,
    // The first P2 draft persisted these two fields under longer names.
    connectTimeoutMs: Number(config.connectTimeoutMs ?? config.connectionTimeoutMs ?? 5_000),
    queryTimeoutMs: Number(config.queryTimeoutMs ?? config.statementTimeoutMs ?? 30_000),
    maxRows: Number(config.maxRows ?? 1_000),
    maxResultBytes: Number(config.maxResultBytes ?? 1_048_576),
  };
}

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

export type SqlDefinition = {
  id: string;
  projectId: string;
  dataSourceId: string;
  name: string;
  description: string;
  /** 'sql' for the four relational drivers; mongo/redis use `operation` (P2-7). */
  kind: "sql" | "mongo" | "redis";
  statementType?: SqlStatementType;
  sql?: string;
  operation?: unknown;
  params: SqlParameterDefinition[];
  createdAt: string;
  updatedAt: string;
};

export type ExecutionIndex = {
  id: string;
  projectId: string;
  /* 'scenario' 仍在表的 CHECK 里但已无写入方（P2-3 场景已下线，见 021 迁移）；
     收窄 CHECK 需要重建约束且 P2-4 还要再改一次，所以留着不用。 */
  kind: "flow" | "suite" | "batch";
  targetId?: string;
  targetName: string;
  detailId: string;
  status: "queued" | "running" | "success" | "failed" | "canceled";
  total: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  canceledCount: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type ExecutionStep = {
  id: string;
  indexId: string;
  stepId: string;
  stepType: string;
  stepName: string;
  /** Steps may also be `skipped` — a condition branch that did not fire (P2-2). */
  status: ExecutionIndex["status"] | "skipped";
  stage: number;
  position: number;
  /**
   * Set when this step ran *inside* a loop or subflow node (P2-6). Parent counts
   * only aggregate top-level steps, so a 20-iteration loop is one step in
   * `total`, and its inner evidence hangs off this id.
   */
  parentStepId?: string;
  /** 0-based iteration a loop body step belongs to. Absent for a subflow. */
  iteration?: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error?: string;
  httpExecutionId?: string;
  durationMs: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type FlowExecution = {
  id: string;
  projectId: string;
  /** Absent once the flow itself was deleted; `flowName` still reads correctly. */
  flowId?: string;
  flowName: string;
  executionIndexId?: string;
  environmentId?: string;
  environmentName?: string;
  status: "queued" | "running" | "success" | "failed" | "canceled";
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

export type Execution = {
  id: string;
  projectId: string;
  endpointId: string;
  endpointName: string;
  environmentId?: string;
  /** Snapshotted at run time, so history survives a renamed or deleted environment. */
  environmentName?: string;
  batchId?: string;
  /** Debug runs and case runs share this table but must stay separable (see 007). */
  source: "endpoint_debug" | "test_case" | "flow_step";
  caseId?: string;
  caseName?: string;
  /** Set when this run was one step of a flow execution (P1-2). */
  flowExecutionId?: string;
  /** Node identity inside the flow document; snapshotted because nodes are not rows. */
  flowNodeId?: string;
  flowNodeName?: string;
  /** The flow this step belonged to; project-wide lists join it in (5.0.9). */
  flowName?: string;
  /**
   * Runs are queued and executed by a worker (P1-3), so a record exists before
   * it has an outcome. `queued` and `running` are not verdicts — anything that
   * measures pass rates must exclude them rather than count them as failures.
   */
  status: "queued" | "running" | "success" | "failed" | "canceled";
  statusCode?: number;
  durationMs: number;
  error?: string;
  request: { url: string; method: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown };
  responseHeaders: Record<string, string>;
  responseContentType?: string;
  responseSizeBytes: number;
  responseTruncated: boolean;
  responseBody?: string;
  /** Empty for a debug run; a case run records every assertion it evaluated. */
  assertionResults: AssertionResult[];
  /** Per-extract outcomes for a flow step or single-step debug (P1-2). */
  extractResults: FlowExtractResult[];
  /** What each 前置钩子 produced, in order (P1-2). */
  hookResults: HookResult[];
  /** Response scripts run during post-processing, before declarative checks. */
  responseScriptResults: ResponseScriptResult[];
  /** Enqueue time. `startedAt - createdAt` is queue wait, `durationMs` is the request. */
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

/** Terminal states. A run outside this set is still in the queue or in flight. */
export const SETTLED_STATUSES = ["success", "failed", "canceled"];

/**
 * One execution worker, as it last described itself (P1-3).
 *
 * `online` is derived from heartbeat freshness at read time, never stored — a
 * worker that is killed outright gets no chance to mark itself down.
 */
export type Worker = {
  id: string;
  hostname: string;
  pid: number;
  /**
   * Which class of work this worker consumes. Only `endpoint` exists today;
   * `repository` is reserved so the registry can tell them apart from the start.
   */
  mode: "endpoint" | "repository";
  /** Capacity this worker was given, i.e. its max simultaneous requests. */
  concurrency: number;
  /** Requests in flight at the last heartbeat. */
  inflight: number;
  version?: string;
  online: boolean;
  startedAt: string;
  lastSeenAt: string;
};

export type BatchExecution = {
  id: string;
  projectId: string;
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
};

export function mapUser(row: Record<string, unknown>): User {
  return { id: String(row.id), email: String(row.email), name: String(row.name), passwordHash: String(row.password_hash), isSystemAdmin: Boolean(row.is_system_admin) };
}

export function mapProject(row: Record<string, unknown>): Project {
  return { id: String(row.id), name: String(row.name), description: String(row.description ?? ""), ownerId: String(row.owner_id), createdAt: new Date(String(row.created_at)).toISOString() };
}

export function mapEnvironment(row: Record<string, unknown>): Environment {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    variables: (row.variables ?? {}) as Record<string, string>,
    /* Keys only: the values stay server-side. */
    secretKeys: Object.keys((row.secrets ?? {}) as Record<string, string>).sort(),
  };
}

export function mapEndpoint(row: Record<string, unknown>): Endpoint {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    method: String(row.method),
    url: String(row.url),
    headers: (row.headers ?? {}) as Record<string, string>,
    queryParams: (row.query_params ?? {}) as Record<string, string>,
    pathParams: (row.path_params ?? {}) as Record<string, string>,
    bodyType: (row.body_type ?? "none") as BodyType,
    body: row.body ?? undefined,
    bodyText: row.body_text === null || row.body_text === undefined ? undefined : String(row.body_text),
    auth: (row.auth ?? { type: "none" }) as EndpointAuth,
    tags: (row.tags as string[]) ?? [],
    defaultEnvironmentId: row.default_environment_id ? String(row.default_environment_id) : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

export function mapTestCase(row: Record<string, unknown>): TestCase {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    endpointId: String(row.endpoint_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    environmentId: row.environment_id ? String(row.environment_id) : undefined,
    environmentName: row.environment_name ? String(row.environment_name) : undefined,
    request: row.request_snapshot as RequestSnapshot,
    /* Script assertions were retired in P2-2.1. Existing JSON is intentionally
       ignored instead of being migrated into a different lifecycle phase. */
    assertions: ((row.assertions ?? []) as Assertion[]).filter((item) => item.type !== "script"),
    preRequestHooks: (row.pre_request_hooks ?? []) as HookConfig[],
    extracts: (row.extracts ?? []) as FlowExtract[],
    responseScripts: (row.response_scripts ?? []) as ResponseScriptConfig[],
    tags: (row.tags as string[]) ?? [],
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

export function mapScript(row: Record<string, unknown>): Script {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: row.name ? String(row.name) : undefined,
    language: String(row.language) as Script["language"],
    /* Rows written before migration 014 are assertion scripts by definition —
       that is the only kind that existed — so the column default is also the
       historically correct value. */
    kind: String(row.kind ?? "assertion") as Script["kind"],
    content: String(row.content),
    ownerCaseId: row.owner_case_id ? String(row.owner_case_id) : undefined,
    /* Aggregated by the query that selects the script; absent on queries that
       do not need it, which is why the fallback is an empty list rather than
       an error. */
    dependencies: (row.dependencies as string[] | null) ?? [],
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

export function mapFlow(row: Record<string, unknown>): Flow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    environmentId: row.environment_id ? String(row.environment_id) : undefined,
    environmentName: row.environment_name ? String(row.environment_name) : undefined,
    nodes: ((row.nodes ?? []) as FlowNode[]).map(normalizeFlowNode),
    edges: (row.edges ?? []) as FlowEdge[],
    variables: (row.variables ?? {}) as Record<string, string>,
    tags: (row.tags as string[]) ?? [],
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

function normalizeFlowNode(node: FlowNode): FlowNode {
  if (node.type === "request") {
    return {
      ...node,
      assertions: (node.assertions ?? []).filter((item) => item.type !== "script"),
      responseScripts: node.responseScripts ?? [],
    };
  }
  if (node.type === "database") return { ...node, assertions: (node.assertions ?? []).filter((item) => item.type !== "script") };
  if (node.type !== "condition") return node;
  const raw = node.condition as ConditionGroup & ConditionRule;
  if (Array.isArray(raw.rules)) return node;
  return { ...node, condition: { mode: "all", rules: [{ variable: raw.variable ?? "", operator: raw.operator ?? "equals", value: raw.value }] } };
}

export function mapFlowExecution(row: Record<string, unknown>): FlowExecution {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    flowId: row.flow_id ? String(row.flow_id) : undefined,
    flowName: String(row.flow_name),
    executionIndexId: row.execution_index_id ? String(row.execution_index_id) : undefined,
    environmentId: row.environment_id ? String(row.environment_id) : undefined,
    environmentName: row.environment_name ? String(row.environment_name) : undefined,
    status: String(row.status) as FlowExecution["status"],
    total: Number(row.total),
    successCount: Number(row.success_count), failedCount: Number(row.failed_count), skippedCount: Number(row.skipped_count ?? 0),
    error: row.error === null || row.error === undefined ? undefined : String(row.error),
    plan: (row.plan ?? []) as FlowPlanStep[],
    variables: (row.variables ?? {}) as Record<string, string>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : undefined,
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : undefined,
    /* run_spec is deliberately absent, for the same reason as on an execution:
       it carries auth material and exists only so a worker can pick the run up. */
  };
}

export function mapDataSource(row: Record<string, unknown>): DataSource {
  const type = String(row.type) as DataSourceType;
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name), type,
    config: normalizeDataSourceConfig(row.config, type), passwordConfigured: Boolean(row.credentials_encrypted),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function mapSqlDefinition(row: Record<string, unknown>): SqlDefinition {
  return {
    id: String(row.id), projectId: String(row.project_id), dataSourceId: String(row.data_source_id), name: String(row.name),
    description: String(row.description ?? ""), kind: String(row.kind ?? "sql") as SqlDefinition["kind"],
    statementType: row.statement_type ? String(row.statement_type) as SqlStatementType : undefined,
    sql: row.sql ? String(row.sql) : undefined, operation: row.operation ?? undefined, params: (row.params ?? []) as SqlParameterDefinition[],
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function mapExecutionIndex(row: Record<string, unknown>): ExecutionIndex {
  return {
    id: String(row.id), projectId: String(row.project_id), kind: String(row.kind) as ExecutionIndex["kind"],
    targetId: row.target_id ? String(row.target_id) : undefined, targetName: String(row.target_name), detailId: String(row.detail_id),
    status: String(row.status) as ExecutionIndex["status"], total: Number(row.total), successCount: Number(row.success_count),
    failedCount: Number(row.failed_count), skippedCount: Number(row.skipped_count), canceledCount: Number(row.canceled_count),
    createdAt: new Date(String(row.created_at)).toISOString(),
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : undefined,
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : undefined,
  };
}

export function mapExecutionStep(row: Record<string, unknown>): ExecutionStep {
  return {
    id: String(row.id), indexId: String(row.index_id), stepId: String(row.step_id), stepType: String(row.step_type), stepName: String(row.step_name),
    status: String(row.status) as ExecutionStep["status"], stage: Number(row.stage), position: Number(row.position),
    parentStepId: row.parent_step_id ? String(row.parent_step_id) : undefined,
    iteration: row.iteration === null || row.iteration === undefined ? undefined : Number(row.iteration),
    input: (row.input_snapshot ?? {}) as Record<string, unknown>, output: (row.output_snapshot ?? {}) as Record<string, unknown>,
    error: row.error === null || row.error === undefined ? undefined : String(row.error),
    httpExecutionId: row.http_execution_id ? String(row.http_execution_id) : undefined, durationMs: Number(row.duration_ms ?? 0),
    createdAt: new Date(String(row.created_at)).toISOString(),
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : undefined,
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : undefined,
  };
}

export function mapExecution(row: Record<string, unknown>): Execution {
  return {
    id: String(row.id), projectId: String(row.project_id), endpointId: String(row.endpoint_id), endpointName: String(row.endpoint_name),
    environmentId: row.environment_id ? String(row.environment_id) : undefined,
    environmentName: row.environment_name ? String(row.environment_name) : undefined,
    batchId: row.batch_id ? String(row.batch_id) : undefined,
    source: (row.source ?? "endpoint_debug") as Execution["source"],
    caseId: row.case_id ? String(row.case_id) : undefined,
    caseName: row.case_name ? String(row.case_name) : undefined,
    flowExecutionId: row.flow_execution_id ? String(row.flow_execution_id) : undefined,
    flowNodeId: row.flow_node_id ? String(row.flow_node_id) : undefined,
    flowNodeName: row.flow_node_name ? String(row.flow_node_name) : undefined,
    flowName: row.flow_name ? String(row.flow_name) : undefined,
    status: row.status as Execution["status"], statusCode: row.status_code === null ? undefined : Number(row.status_code), durationMs: Number(row.duration_ms),
    error: row.error === null ? undefined : String(row.error), request: row.request_snapshot as Execution["request"],
    responseHeaders: (row.response_headers ?? {}) as Record<string, string>, responseContentType: row.response_content_type ? String(row.response_content_type) : undefined,
    responseSizeBytes: Number(row.response_size_bytes ?? 0), responseTruncated: Boolean(row.response_truncated),
    responseBody: row.response_body === null ? undefined : String(row.response_body),
    assertionResults: (row.assertion_results ?? []) as AssertionResult[],
    extractResults: (row.extract_results ?? []) as FlowExtractResult[],
    hookResults: (row.hook_results ?? []) as HookResult[],
    responseScriptResults: (row.response_script_results ?? []) as ResponseScriptResult[],
    createdAt: new Date(String(row.created_at)).toISOString(),
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : undefined,
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : undefined,
    /* run_spec is deliberately absent: it carries auth material and exists only
       so a worker can pick the run up. */
  };
}

export function mapBatchExecution(row: Record<string, unknown>): BatchExecution {  return {
    id: String(row.id), projectId: String(row.project_id), type: String(row.type) as BatchExecution["type"],
    environmentStrategy: String(row.environment_strategy) as BatchExecution["environmentStrategy"],
    overrideEnvironmentId: row.override_environment_id ? String(row.override_environment_id) : undefined,
    total: Number(row.total), successCount: Number(row.success_count), failedCount: Number(row.failed_count),
    canceledCount: Number(row.canceled_count ?? 0),
    status: String(row.status) as BatchExecution["status"],
    createdAt: new Date(String(row.created_at)).toISOString(),
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : undefined,
  };
}

export function mapWorker(row: Record<string, unknown>): Worker {
  return {
    id: String(row.id), hostname: String(row.hostname), pid: Number(row.pid),
    mode: (row.mode ?? "endpoint") as Worker["mode"],
    concurrency: Number(row.concurrency), inflight: Number(row.inflight),
    version: row.version ? String(row.version) : undefined,
    /* Computed by the query from heartbeat freshness, never stored. */
    online: Boolean(row.online),
    startedAt: new Date(String(row.started_at)).toISOString(),
    lastSeenAt: new Date(String(row.last_seen_at)).toISOString(),
  };
}
