export type Role = "project_admin" | "developer" | "viewer";
export type User = { id: string; email: string; name: string; passwordHash: string; isSystemAdmin: boolean };
export type Project = { id: string; name: string; description: string; ownerId: string; createdAt: string };
/**
 * Secret values never leave the server (Spec 4.6 默认掩码). Only the key names
 * travel, so the UI can show "configured" without ever holding the plaintext.
 */
export type Environment = {
  id: string; projectId: string; name: string;
  variables: Record<string, string>; secretKeys: string[]; runnerLabel: string;
  /**
   * 环境默认头（P3，计划 6.5 流量泳道第一层）：buildRequest 里以**最低优先级**
   * 合并进每一个 HTTP 请求——接口自己写了同名头就以接口为准。值可引用 `{{变量}}`
   * （如 `{"X-Env-Tag": "{{lane}}"}`），由触发时的变量覆盖决定这一次走哪条泳道。
   */
  defaultHeaders: Record<string, string>;
};
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
 * 列表用的用例摘要：跨接口用例选择器与套件成员（P2-4）看的就是这个。
 *
 * 刻意**不含** request / assertions / preRequestHooks / extracts / responseScripts。
 * 一个几百条用例的项目，把每条的请求正文和整套校验配置都发给一个选择器，传输量比
 * 编辑器本身还大——与 flows 列表返回 `nodeCount` 而不是 `nodes` 是同一条理由。
 * 需要完整定义的地方走 `GET /projects/:id/cases/:caseId`。
 */
export type TestCaseSummary = {
  id: string;
  projectId: string;
  endpointId: string;
  /** Joined，供选择器按接口分组。 */
  endpointName: string;
  name: string;
  description: string;
  environmentId?: string;
  environmentName?: string;
  /** 声明式校验条数：让选择器显示「3 条校验」而不必带上校验内容。 */
  assertionCount: number;
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

/** P2-5 external integration stub. The public id is a random capability, not a project id. */
export type MockMode = "auto" | "fixed" | "template" | "proxy";
export type MockResponse = { statusCode: number; headers: Record<string, string>; body?: unknown };
export type MockProxyPathMode = "append" | "fixed" | "replace";
export type MockProxyQueryMode = "forward" | "drop" | "append";
export type MockProxyConfig = {
  targetUrl: string;
  allowedHosts: string[];
  timeoutMs: number;
  maxResponseBytes: number;
  /** append keeps the target's own path and appends the mock path; fixed ignores
      the mock path; replace uses the mock path verbatim. Default append. */
  pathMode?: MockProxyPathMode;
  /** forward passes the mock request query, drop strips it, append forwards and
      adds fixedQuery. Default forward. */
  queryMode?: MockProxyQueryMode;
  /** Added on top of the request query when queryMode is 'append'. */
  fixedQuery?: Record<string, string>;
};
export type Mock = {
  id: string; projectId: string; endpointId?: string; snapshotExecutionId?: string; name: string; publicId: string; mode: MockMode; enabled: boolean; priority: number;
  requestMatch: Record<string, unknown>; response: MockResponse; proxyConfig?: MockProxyConfig; delayMs: number; createdAt: string; updatedAt: string;
};
export type MockRequestLog = {
  id: string; mockId?: string; method: string; path: string; matched: boolean; statusCode: number; durationMs: number;
  requestSnapshot: Record<string, unknown>; responseSizeBytes: number; createdAt: string;
};

/** 一次父执行是谁触发的（P3，计划 6.0）。`ci` 在 CHECK 里先行占位，P4.5 才产出它。 */
export type TriggerSource = "manual" | "scheduled" | "webhook" | "ci";

/**
 * 一次触发的身份（P3-3）：写进 `execution_index` 的三列。
 *
 * manual 只有 source；调度 / Webhook 带 refId + 名字快照（边界 13：触发器被删后，
 * 报告仍要说得出「谁让它跑的」）。手动路径不传 trigger，入队侧缺省 manual。
 */
export type TriggerContext = {
  source: TriggerSource;
  refId?: string;
  refName?: string;
};

export type ExecutionIndex = {
  id: string;
  projectId: string;
  /* 'scenario' 已由 026 从 CHECK 中移除（P2-3 场景下线，行由 021 删净）。
     'batch' 仍在 CHECK 里但暂无写入方：批量调试有自己的 batch_executions。
     'ingest' 是仓库模式的一次上报（P4 边界 1，迁移 035 放宽 CHECK）：它是「别人已经
     跑完的历史」，所以取消/重跑/回收三条路径都要显式拒绝它。 */
  kind: "flow" | "suite" | "batch" | "ingest";
  targetId?: string;
  targetName: string;
  detailId: string;
  /**
   * 触发源（P3）：归属父索引而不是三张执行表——可被调度/Webhook 触发的只有流程
   * 与套件，两者都有 index 行；叶子的触发源由父级回答，单接口调试永远是 manual。
   */
  triggerSource: TriggerSource;
  /** 调度 / Webhook 的 id。无 FK：历史要活过触发器的删除。 */
  triggerRefId?: string;
  /** 触发者名字的快照（边界 13）：调度被删后，报告仍要说得出「谁让它跑的」。 */
  triggerRefName?: string;
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
  /**
   * Set when this step *delegates to a whole parent execution* — a suite member
   * that is a flow (P2-4). `httpExecutionId` covers the one-request case; a flow
   * member has its own index, detail row and step tree, so the evidence lives
   * behind this id instead of being copied up.
   */
  childIndexId?: string;
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
  /**
   * 执行分区标签，即这个 worker 服务哪些网段（P2-8）。
   *
   * 与 `mode` 是两个正交轴：只有 `labels` 参与队列路由。一个只服务 `prod-dmz` 的
   * worker 领不到 `default` 的任务，反之亦然。
   */
  labels: string[];
  /** Capacity this worker was given, i.e. its max simultaneous requests. */
  concurrency: number;
  /** Requests in flight at the last heartbeat. */
  inflight: number;
  version?: string;
  online: boolean;
  startedAt: string;
  lastSeenAt: string;
};

/**
 * How long a worker may go unheard from before it reads as offline.
 *
 * Three heartbeats, so one dropped beat or a brief GC pause does not make a
 * healthy worker flicker between states in the UI.
 *
 * 单一来源：执行器面板（`routes/system.ts`）与入队前的分区在线检查
 * （`lib/enqueue.ts`，P2-8 边界 4）必须用同一个阈值——两个数会让「面板显示在线、
 * 入队却说没有执行器」成立。
 */
export const WORKER_OFFLINE_AFTER_SECONDS = 30;

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

/**
 * 一个套件成员：一次**独立执行**的目标（P2-4）。
 *
 * 成员之间不传变量——需要传值的链路本来就该建成一条流程（5.0.6）。所以成员只有
 * 「是谁」，没有入参映射、没有前后置。
 */
export type SuiteMemberRef = {
  type: "case" | "flow";
  id: string;
};

/** 入队时冻结的成员，名称快照让报告在成员被删/改名后仍读得通。 */
export type SuiteMemberSnapshot = SuiteMemberRef & {
  name: string;
  /** 用例成员所属接口，供报告分组显示。流程成员为空。 */
  endpointId?: string;
  endpointName?: string;
  /** 成员自身的环境（environmentStrategy='member_default' 时实际生效的那个）。 */
  environmentId?: string;
  environmentName?: string;
};

/**
 * 成员选择方式。
 *
 * `manual` 是显式引用，因此**只有它**参与「删用例/流程前的 usage 扫描」；
 * `tag` / `all` 是动态选择，在入队那一刻才解析成快照，不构成引用。
 */
export type SuiteSelection =
  | { type: "manual"; members: SuiteMemberRef[] }
  | { type: "tag"; tags: string[]; match: "any" | "all"; includeCases: boolean; includeFlows: boolean }
  | { type: "all"; includeCases: boolean; includeFlows: boolean };

/**
 * 一次套件执行怎么跑。
 *
 * `concurrency` 是「几个成员同时开跑」，**不是**「几个请求同时在飞」——后者由平台级
 * 令牌池 `SUITE_LEAF_BUDGET` 封顶，声明再高也不会突破（见 DEVELOPMENT_PLAN 5.0.11）。
 * `failFast` 为真时不再启动新成员，在途成员跑完，未启动的成员留 skipped 证据行。
 */
export type SuiteExecutionConfig = {
  concurrency: number;
  failFast: boolean;
  /** 'member_default' 用成员自己保存的环境；'override' 全部改用 environmentId。 */
  environmentStrategy: "member_default" | "override";
  environmentId?: string;
};

/**
 * 成员并发的默认与上限，以及一次套件的成员上限。
 *
 * 上限存在的意义是「超限直接拒绝，不静默降级」（与循环迭代 ≤100 同一原则）。
 * 真实在飞的请求数另由平台级令牌池封顶，成员并发只决定几个成员同时开跑。
 */
export const SUITE_DEFAULT_CONCURRENCY = 4;
export const SUITE_MAX_CONCURRENCY = 10;
export const SUITE_MAX_MEMBERS = 200;

/**
 * 套件级通知设置（P3-11，6.8）：终态按开关投递到所选渠道。
 * 两个开关默认关；template 覆盖默认模版（title / body 可只覆盖其一）。
 */
export type SuiteNotifyConfig = {
  onSuccess: boolean;
  onFailure: boolean;
  channelIds: string[];
  template?: { title?: string; body?: string };
};

export type TestSuite = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  selection: SuiteSelection;
  execution: SuiteExecutionConfig;
  notify: SuiteNotifyConfig;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type SuiteExecution = {
  id: string;
  projectId: string;
  /** Absent once the suite itself was deleted; `suiteName` still reads correctly. */
  suiteId?: string;
  suiteName: string;
  executionIndexId?: string;
  /** Only set for environmentStrategy='override'. */
  environmentId?: string;
  environmentName?: string;
  status: "queued" | "running" | "success" | "failed" | "canceled";
  total: number;
  successCount: number;
  failedCount: number;
  /** Members fail-fast or a cancel never got to start. */
  skippedCount: number;
  error?: string;
  /** Frozen at enqueue so a tag/all selection stays reproducible. */
  members: SuiteMemberSnapshot[];
  /**
   * 报告名 `套件名_YYYYMMDD[_n]`（边界 13）：入队事务里一次定终身，不在读取端算。
   * 同一天同一套件跑多次靠序号区分；删除某次运行不会让别人的名字位移。历史行为空
   * ——报告是 P3 起的派生物。耗时不存列，由 finished_at - started_at 算出。
   */
  reportName?: string;
  /**
   * 触发时下发的变量覆盖（P3-2/6.5 泳道第二层，迁移 032）：与 run_spec 同一事务
   * 冻结，但 run_spec 落终态即置 NULL，这一列让报告标识段在执行结束后仍读得到
   * 「这次是按哪套泳道跑的」。
   */
  variableOverrides: Record<string, string>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

/* ---------------------------------------------------------------------------
 * P3: 调度、Webhook 触发、告警（计划第六节，迁移 030 / 031）。
 * 本批次只落表结构与类型映射；触发路径、调度器进程、路由在 P3-3 ~ P3-6 接入。
 * ------------------------------------------------------------------------- */

/**
 * 一条定时调度（边界 1）：目标只有测试套件——要按时跑一条流程，把它放进一个
 * 只含它的套件。`targetType` 目前单值，留列是为了 P4.5 的 CI 目标不必回填历史行
 * （与迁移 010 的 workers.mode 同一条理由）。
 */
export type Schedule = {
  id: string;
  projectId: string;
  name: string;
  targetType: "suite";
  targetId: string;
  /** 列表查询 join 出的目标名，编辑器要能显示「这条调度跑的是哪个套件」。 */
  targetName?: string;
  /** 为空 = 套件自己的环境配置；有值 = 触发时覆盖（边界 4，复用既有 override 链）。 */
  environmentId?: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  /** 每次触发都带的变量覆盖（6.5 泳道第二层），以最高优先级压过环境变量。 */
  variables: Record<string, string>;
  /** 禁用时置空；同时也是调度器行级认领去重的锚点（6.0）。 */
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * 一个到期时刻及其结果（边界 2 / 3）。
 *
 * `skipped` 是漏跑的证据：不留痕的话「昨晚没跑」与「昨晚跑了但没失败」在界面上
 * 无法区分。触发失败（2004 无执行器、零成员等）记 `failed` 且**不**自动禁用调度。
 */
export type ScheduleRun = {
  id: string;
  projectId: string;
  scheduleId: string;
  plannedAt: string;
  triggeredAt?: string;
  status: "triggered" | "skipped" | "failed";
  /** 触发成功才指向产生的父执行；skipped / failed 没有。 */
  executionIndexId?: string;
  /** 触发失败的原因（哪个分区没有执行器、解析成几个成员等）。 */
  error?: string;
  createdAt: string;
};

/**
 * 外部可调用的触发器，凭 HMAC 准入（边界 6，形状照 P2-5 的 Mock 运行时）。
 *
 * 密钥 AES-GCM 加密存库（验签需要明文，所以不能只存哈希）；明文只在创建 / 轮换时
 * 返回一次，之后接口只回 `hasSecret`。
 */
export type WebhookTrigger = {
  id: string;
  projectId: string;
  name: string;
  /** 流程仍可被 Webhook 触发（边界 1 末段）：业务事件天然是单链路且要带入参。 */
  targetType: "flow" | "suite";
  targetId: string;
  /** 列表查询 join 出的目标名。 */
  targetName?: string;
  environmentId?: string;
  publicId: string;
  hasSecret: boolean;
  enabled: boolean;
  lastTriggeredAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** 四种「POST 一段 JSON 到一个 URL」渠道（边界 8：Email 不做）。 */
export type NotificationChannelType = "webhook" | "wecom" | "dingtalk" | "slack";

export type NotificationChannel = {
  id: string;
  projectId: string;
  name: string;
  type: NotificationChannelType;
  url: string;
  /** 加签密钥是否已配置（wecom / dingtalk 常用）；明文不回显。 */
  secretConfigured: boolean;
  /** 可选的自定义前缀文案——不是模板语言（明确不做）。 */
  templatePrefix?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * 告警指标（边界 9）：`execution_failed` 是事件型（失败事件一到就评估，无窗口），
 * 其余三个是窗口型（在同一条事件上跑一次聚合查询）。
 *
 * threshold 的单位按指标定：success_rate 为百分比 0–100，avg_duration 为毫秒，
 * consecutive_failures 为次数。
 */
export type AlertMetric = "execution_failed" | "consecutive_failures" | "success_rate" | "avg_duration";
export type AlertComparator = "gt" | "gte" | "lt" | "lte";

export type AlertRule = {
  id: string;
  projectId: string;
  name: string;
  metric: AlertMetric;
  comparator: AlertComparator;
  threshold: number;
  /** 事件型指标为空；窗口型必填（路由校验）。 */
  windowMinutes?: number;
  /** 压制窗口：没有冷却，一次雪崩会把渠道刷爆。 */
  cooldownSeconds: number;
  /** 目标渠道。UUID[] 无法携带真外键，归属由路由校验。 */
  channelIds: string[];
  enabled: boolean;
  /** 冷却起点，兼作多实例派发时 compare-and-set 的锚点。 */
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** 一次通知投递的证据（边界 10）：「没收到告警」的三种原因靠它区分。 */
export type NotificationDelivery = {
  id: string;
  projectId: string;
  /** 渠道 / 规则被删后置空，证据行仍可读。 */
  channelId?: string;
  ruleId?: string;
  executionIndexId?: string;
  status: "sent" | "failed";
  statusCode?: number;
  error?: string;
  /** 实际 POST 出去的那份 JSON——复现「对方到底收到了什么」只能靠它。 */
  payload: Record<string, unknown>;
  createdAt: string;
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
    /* 执行分区（P2-8）：这个环境指向的系统该从哪个网段发请求。 */
    runnerLabel: String(row.runner_label ?? "default"),
    /* 环境默认头（P3/6.5）：列 DEFAULT '{}'，旧行与未接线前读成空对象即「无默认头」。 */
    defaultHeaders: (row.default_headers ?? {}) as Record<string, string>,
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

/** `assertion_count` 与 `endpoint_name` 由查询算出，不在 test_cases 表里。 */
export function mapTestCaseSummary(row: Record<string, unknown>): TestCaseSummary {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    endpointId: String(row.endpoint_id),
    endpointName: String(row.endpoint_name),
    name: String(row.name),
    description: String(row.description ?? ""),
    environmentId: row.environment_id ? String(row.environment_id) : undefined,
    environmentName: row.environment_name ? String(row.environment_name) : undefined,
    assertionCount: Number(row.assertion_count ?? 0),
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

/**
 * `selection_type` + `selection_config` → 判别联合。
 *
 * 单独导出而不是只写在 mapper 里：预览「还没保存的那份配置」时要用同一套归一，
 * 两份实现必然在默认值上分叉（比如 include 开关缺省是 true 还是 false）。
 */
export function normalizeSuiteSelection(type: unknown, config: unknown): SuiteSelection {
  const raw = (config ?? {}) as Record<string, unknown>;
  const kind = String(type) as SuiteSelection["type"];
  const includeCases = raw.includeCases === undefined ? true : Boolean(raw.includeCases);
  const includeFlows = raw.includeFlows === undefined ? true : Boolean(raw.includeFlows);
  if (kind === "manual") return { type: "manual", members: (raw.members ?? []) as SuiteMemberRef[] };
  if (kind === "tag") return { type: "tag", tags: (raw.tags ?? []) as string[], match: raw.match === "all" ? "all" : "any", includeCases, includeFlows };
  return { type: "all", includeCases, includeFlows };
}

/**
 * notify_config 的归一：缺省 = 两开关全关、无渠道。channelIds 不在此去重——
 * 渠道被删时路由会把悬空 id 摘掉（与 alert_rules 同款），这里只负责形状。
 */
export function normalizeSuiteNotify(config: unknown): SuiteNotifyConfig {
  const raw = (config ?? {}) as Record<string, unknown>;
  return {
    onSuccess: Boolean(raw.onSuccess),
    onFailure: Boolean(raw.onFailure),
    channelIds: Array.isArray(raw.channelIds) ? raw.channelIds.map(String) : [],
    template: raw.template && typeof raw.template === "object"
      ? {
          title: typeof (raw.template as Record<string, unknown>).title === "string" ? String((raw.template as Record<string, unknown>).title) : undefined,
          body: typeof (raw.template as Record<string, unknown>).body === "string" ? String((raw.template as Record<string, unknown>).body) : undefined,
        }
      : undefined,
  };
}

/**
 * execution_config 的默认值放在 mapper 而不是 DB DEFAULT：并发上限这类保护性数值会随
 * 平台调整，写进建表默认值以后既有行不会跟着变，反而留下两套真相。notify_config 同理。
 */
export function mapTestSuite(row: Record<string, unknown>): TestSuite {
  const execution = (row.execution_config ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name), description: String(row.description ?? ""),
    selection: normalizeSuiteSelection(row.selection_type, row.selection_config),
    execution: {
      concurrency: Number(execution.concurrency ?? SUITE_DEFAULT_CONCURRENCY),
      failFast: Boolean(execution.failFast ?? false),
      environmentStrategy: execution.environmentStrategy === "override" ? "override" : "member_default",
      environmentId: execution.environmentId ? String(execution.environmentId) : undefined,
    },
    notify: normalizeSuiteNotify(row.notify_config),
    tags: (row.tags ?? []) as string[],
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function mapSuiteExecution(row: Record<string, unknown>): SuiteExecution {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    suiteId: row.suite_id ? String(row.suite_id) : undefined,
    suiteName: String(row.suite_name),
    executionIndexId: row.execution_index_id ? String(row.execution_index_id) : undefined,
    environmentId: row.environment_id ? String(row.environment_id) : undefined,
    environmentName: row.environment_name ? String(row.environment_name) : undefined,
    status: String(row.status) as SuiteExecution["status"],
    total: Number(row.total),
    successCount: Number(row.success_count), failedCount: Number(row.failed_count), skippedCount: Number(row.skipped_count ?? 0),
    error: row.error === null || row.error === undefined ? undefined : String(row.error),
    members: (row.member_snapshot ?? []) as SuiteMemberSnapshot[],
    reportName: row.report_name ? String(row.report_name) : undefined,
    variableOverrides: (row.variable_overrides ?? {}) as Record<string, string>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : undefined,
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : undefined,
    /* run_spec 同样不映射：它只为 worker 认领而存在。 */
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

export function mapMock(row: Record<string, unknown>): Mock {
  return {
    id: String(row.id), projectId: String(row.project_id), endpointId: row.endpoint_id ? String(row.endpoint_id) : undefined, snapshotExecutionId: row.snapshot_execution_id ? String(row.snapshot_execution_id) : undefined,
    name: String(row.name), publicId: String(row.public_id), mode: String(row.mode) as MockMode, enabled: Boolean(row.enabled), priority: Number(row.priority),
    requestMatch: (row.request_match ?? {}) as Record<string, unknown>, response: row.response as MockResponse,
    proxyConfig: row.proxy_config ? row.proxy_config as MockProxyConfig : undefined, delayMs: Number(row.delay_ms),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function mapMockRequestLog(row: Record<string, unknown>): MockRequestLog {
  return {
    id: String(row.id), mockId: row.mock_id ? String(row.mock_id) : undefined, method: String(row.method), path: String(row.path),
    matched: Boolean(row.matched), statusCode: Number(row.status_code), durationMs: Number(row.duration_ms),
    requestSnapshot: (row.request_snapshot ?? {}) as Record<string, unknown>, responseSizeBytes: Number(row.response_size_bytes),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function mapExecutionIndex(row: Record<string, unknown>): ExecutionIndex {
  return {
    id: String(row.id), projectId: String(row.project_id), kind: String(row.kind) as ExecutionIndex["kind"],
    targetId: row.target_id ? String(row.target_id) : undefined, targetName: String(row.target_name), detailId: String(row.detail_id),
    /* 迁移 030 之前的行与尚未接线的手动路径都读作 manual（列 DEFAULT 同款兜底）。 */
    triggerSource: (row.trigger_source ?? "manual") as TriggerSource,
    triggerRefId: row.trigger_ref_id ? String(row.trigger_ref_id) : undefined,
    triggerRefName: row.trigger_ref_name ? String(row.trigger_ref_name) : undefined,
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
    httpExecutionId: row.http_execution_id ? String(row.http_execution_id) : undefined,
    childIndexId: row.child_index_id ? String(row.child_index_id) : undefined, durationMs: Number(row.duration_ms ?? 0),
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
    /* TEXT[] 已经是数组，`pg` 直接给回 string[]；空数组读成「只服务 default」以匹配
       迁移 027 的列默认值。 */
    labels: Array.isArray(row.labels) && row.labels.length ? (row.labels as unknown[]).map(String) : ["default"],
    concurrency: Number(row.concurrency), inflight: Number(row.inflight),
    version: row.version ? String(row.version) : undefined,
    /* Computed by the query from heartbeat freshness, never stored. */
    online: Boolean(row.online),
    startedAt: new Date(String(row.started_at)).toISOString(),
    lastSeenAt: new Date(String(row.last_seen_at)).toISOString(),
  };
}

/* ---------------------------------------------------------------------------
 * P3 mappers（计划第六节，迁移 030 / 031）。路由在 P3-6 才暴露这些资源，
 * 但 mapper 先行落位：列名 → camelCase 的边界只允许存在 types.ts 一份。
 * ------------------------------------------------------------------------- */

export function mapSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name),
    /* CHECK 当前只有 'suite'；cast 而不是硬编码字面量，P4.5 放宽 CHECK 时这里不用改。 */
    targetType: String(row.target_type) as Schedule["targetType"],
    targetId: String(row.target_id),
    /* 列表查询 join test_suites 的名字；未 join 时缺省。 */
    targetName: row.target_name ? String(row.target_name) : undefined,
    environmentId: row.environment_id ? String(row.environment_id) : undefined,
    cron: String(row.cron),
    timezone: String(row.timezone ?? "Asia/Shanghai"),
    enabled: Boolean(row.enabled),
    variables: (row.variables ?? {}) as Record<string, string>,
    nextRunAt: row.next_run_at ? new Date(String(row.next_run_at)).toISOString() : undefined,
    lastRunAt: row.last_run_at ? new Date(String(row.last_run_at)).toISOString() : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

export function mapScheduleRun(row: Record<string, unknown>): ScheduleRun {
  return {
    id: String(row.id), projectId: String(row.project_id), scheduleId: String(row.schedule_id),
    plannedAt: new Date(String(row.planned_at)).toISOString(),
    triggeredAt: row.triggered_at ? new Date(String(row.triggered_at)).toISOString() : undefined,
    status: String(row.status) as ScheduleRun["status"],
    executionIndexId: row.execution_index_id ? String(row.execution_index_id) : undefined,
    error: row.error === null || row.error === undefined ? undefined : String(row.error),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function mapWebhookTrigger(row: Record<string, unknown>): WebhookTrigger {
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name),
    targetType: String(row.target_type) as WebhookTrigger["targetType"],
    targetId: String(row.target_id),
    targetName: row.target_name ? String(row.target_name) : undefined,
    environmentId: row.environment_id ? String(row.environment_id) : undefined,
    publicId: String(row.public_id),
    /* 列 NOT NULL 时恒为 true；保留这个字段让客户端契约与 data_sources 的
       passwordConfigured 同形，也不给明文留任何出口。 */
    hasSecret: Boolean(row.secret_encrypted),
    enabled: Boolean(row.enabled),
    lastTriggeredAt: row.last_triggered_at ? new Date(String(row.last_triggered_at)).toISOString() : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

export function mapNotificationChannel(row: Record<string, unknown>): NotificationChannel {
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name),
    type: String(row.type) as NotificationChannelType,
    url: String(row.url),
    secretConfigured: Boolean(row.secret_encrypted),
    templatePrefix: row.template_prefix ? String(row.template_prefix) : undefined,
    enabled: Boolean(row.enabled),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

export function mapAlertRule(row: Record<string, unknown>): AlertRule {
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name),
    metric: String(row.metric) as AlertMetric,
    comparator: String(row.comparator) as AlertComparator,
    threshold: Number(row.threshold),
    windowMinutes: row.window_minutes === null || row.window_minutes === undefined ? undefined : Number(row.window_minutes),
    cooldownSeconds: Number(row.cooldown_seconds),
    /* UUID[] 经 pg 读回即 string[]；空数组如实保留（创建时是否至少一个渠道由路由管）。 */
    channelIds: Array.isArray(row.channel_ids) ? (row.channel_ids as unknown[]).map(String) : [],
    enabled: Boolean(row.enabled),
    lastFiredAt: row.last_fired_at ? new Date(String(row.last_fired_at)).toISOString() : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

export function mapNotificationDelivery(row: Record<string, unknown>): NotificationDelivery {
  return {
    id: String(row.id), projectId: String(row.project_id),
    channelId: row.channel_id ? String(row.channel_id) : undefined,
    ruleId: row.rule_id ? String(row.rule_id) : undefined,
    executionIndexId: row.execution_index_id ? String(row.execution_index_id) : undefined,
    status: String(row.status) as NotificationDelivery["status"],
    statusCode: row.status_code === null || row.status_code === undefined ? undefined : Number(row.status_code),
    error: row.error === null || row.error === undefined ? undefined : String(row.error),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/* ── P4: 仓库模式（上报式用例）。范围与边界见 DEVELOPMENT_PLAN.md 7.0 ────────── */

export type RepositoryProvider = "github" | "gitlab" | "gitee" | "bitbucket" | "other";

/**
 * 项目绑定的唯一仓库（Spec 2.10 基数约束，边界 18）。
 *
 * 平台不拥有代码、不执行代码：这一行记的只是「哪个仓库有权往这棵树里报」与
 * 「对账允许发生在哪个分支上」。
 */
export type Repository = {
  id: string;
  projectId: string;
  gitUrl: string;
  provider: RepositoryProvider;
  /** 删除对账的第二道闸门（边界 11）：只有跟踪分支上的全量上报才允许软删用例。 */
  trackingBranch: string;
  status: "active" | "unbound";
  firstSeenCommit?: string;
  lastIngestAt?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * 上报 Token。明文**只在创建时回一次**（边界 17），此后接口只回 `tokenPrefix`。
 *
 * 与 `WebhookTrigger.hasSecret` 的区别正是那条边界：Webhook 要拿明文验签所以加密存，
 * 上报 Token 只需比对所以哈希存——能哈希的地方就不该加密。
 */
export type IngestToken = {
  id: string;
  projectId: string;
  name: string;
  /** 明文前 8 位，供列表辨认「这条是哪个」，不足以反推 Token。 */
  tokenPrefix: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  createdAt: string;
};

/** 一次上报（一个 commit 快照）。幂等键是 `(repository, commitSha, ciRunId)`。 */
export type IngestRun = {
  id: string;
  projectId: string;
  repositoryId: string;
  executionIndexId?: string;
  protocolVersion: string;
  commitSha: string;
  branch: string;
  /** 本地跑没有 CI id，协议里存空串而不是 null（NULL 在 UNIQUE 里不去重）。 */
  ciRunId: string;
  ciRunUrl?: string;
  /** 本次跑的范围，相对仓库根（边界 11/19）。空数组 = 全仓。 */
  scope: string[];
  /** 「这个范围内没有过滤」，不是「跑了整个仓库」。 */
  isFullInventory: boolean;
  /** 实际有没有对账（双闸门都成立才为 true），不是「该不该」。 */
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

/**
 * 仓库用例。`caseKey` 是身份，`name` 是显示（边界 7）。
 *
 * `endpoints` 只在树/详情查询里 join 出来：一个用例挂它实际打过的每一个接口
 * （边界 9），空数组 = 未归位用例（边界 21）。
 */
export type RepoTestCase = {
  id: string;
  projectId: string;
  repositoryId: string;
  caseKey: string;
  name: string;
  description: string;
  /** 仓库根的相对路径。是对账的裁剪依据，但不参与 removed 的身份判定（边界 8）。 */
  filePath: string;
  tags: string[];
  status: "active" | "removed";
  /** `not_run` 留给 P4.5 的勾选执行（枚举本阶段就写进 CHECK）。 */
  lastResult: "passed" | "failed" | "unknown" | "not_run";
  lastSeenCommit?: string;
  lastIngestRunId?: string;
  lastRunAt?: string;
  removedAt?: string;
  createdAt: string;
  updatedAt: string;
  /** 关系表 join 出的接口清单，仅查询侧填充。 */
  endpoints?: { endpointId: string; endpointName: string; method: string; url: string; requestCount: number }[];
};

/** 不可变的上报请求记录。`endpointId` 为空 = 未匹配（边界 16/20）。 */
export type IngestRecord = {
  id: string;
  ingestRunId: string;
  projectId: string;
  repoCaseId?: string;
  endpointId?: string;
  /** 只有 `call` 阶段的请求建立用例关系（边界 10）。 */
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
};

/** 人工标注的外部依赖前缀（边界 20）：只影响诊断列表的显示，不影响任何统计。 */
export type IngestPathRule = {
  id: string;
  projectId: string;
  pathPrefix: string;
  note: string;
  createdBy?: string;
  createdAt: string;
};

export function mapRepository(row: Record<string, unknown>): Repository {
  return {
    id: String(row.id), projectId: String(row.project_id), gitUrl: String(row.git_url),
    provider: String(row.provider) as RepositoryProvider,
    trackingBranch: String(row.tracking_branch), status: String(row.status) as Repository["status"],
    firstSeenCommit: row.first_seen_commit ? String(row.first_seen_commit) : undefined,
    lastIngestAt: row.last_ingest_at ? new Date(String(row.last_ingest_at)).toISOString() : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

export function mapIngestToken(row: Record<string, unknown>): IngestToken {
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name),
    /* token_hash 刻意不出现在这个映射里：它没有任何客户端用途，映射里留一行就迟早
       会被某个 `SELECT *` 带到响应里去。 */
    tokenPrefix: String(row.token_prefix),
    createdBy: row.created_by ? String(row.created_by) : undefined,
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : undefined,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function mapIngestRun(row: Record<string, unknown>): IngestRun {
  return {
    id: String(row.id), projectId: String(row.project_id), repositoryId: String(row.repository_id),
    executionIndexId: row.execution_index_id ? String(row.execution_index_id) : undefined,
    protocolVersion: String(row.protocol_version), commitSha: String(row.commit_sha),
    branch: String(row.branch ?? ""), ciRunId: String(row.ci_run_id ?? ""),
    ciRunUrl: row.ci_run_url ? String(row.ci_run_url) : undefined,
    /* TEXT[] 经 pg 读回即 string[]。 */
    scope: Array.isArray(row.scope) ? (row.scope as unknown[]).map(String) : [],
    isFullInventory: Boolean(row.is_full_inventory), reconciled: Boolean(row.reconciled),
    caseTotal: Number(row.case_total), passedCount: Number(row.passed_count), failedCount: Number(row.failed_count),
    requestCount: Number(row.request_count),
    addedCount: Number(row.added_count), removedCount: Number(row.removed_count), updatedCount: Number(row.updated_count),
    unmatchedCount: Number(row.unmatched_count), unplacedCount: Number(row.unplaced_count),
    sdkName: String(row.sdk_name ?? ""), sdkVersion: String(row.sdk_version ?? ""),
    warnings: Array.isArray(row.warnings) ? (row.warnings as unknown[]).map(String) : [],
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : undefined,
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function mapRepoTestCase(row: Record<string, unknown>): RepoTestCase {
  return {
    id: String(row.id), projectId: String(row.project_id), repositoryId: String(row.repository_id),
    caseKey: String(row.case_key), name: String(row.name), description: String(row.description ?? ""),
    filePath: String(row.file_path ?? ""),
    tags: Array.isArray(row.tags) ? (row.tags as unknown[]).map(String) : [],
    status: String(row.status) as RepoTestCase["status"],
    lastResult: String(row.last_result) as RepoTestCase["lastResult"],
    lastSeenCommit: row.last_seen_commit ? String(row.last_seen_commit) : undefined,
    lastIngestRunId: row.last_ingest_run_id ? String(row.last_ingest_run_id) : undefined,
    lastRunAt: row.last_run_at ? new Date(String(row.last_run_at)).toISOString() : undefined,
    removedAt: row.removed_at ? new Date(String(row.removed_at)).toISOString() : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
    /* json_agg 的空结果是 NULL 而不是 []，所以未归位用例在这里读作 undefined；
       查询侧按需把它显示成「未归位」。 */
    endpoints: Array.isArray(row.endpoints)
      ? (row.endpoints as Record<string, unknown>[]).map((entry) => ({
          endpointId: String(entry.endpointId ?? entry.endpoint_id),
          endpointName: String(entry.endpointName ?? entry.endpoint_name),
          method: String(entry.method), url: String(entry.url),
          requestCount: Number(entry.requestCount ?? entry.request_count ?? 0),
        }))
      : undefined,
  };
}

export function mapIngestRecord(row: Record<string, unknown>): IngestRecord {
  return {
    id: String(row.id), ingestRunId: String(row.ingest_run_id), projectId: String(row.project_id),
    repoCaseId: row.repo_case_id ? String(row.repo_case_id) : undefined,
    endpointId: row.endpoint_id ? String(row.endpoint_id) : undefined,
    phase: String(row.phase) as IngestRecord["phase"],
    paramId: row.param_id ? String(row.param_id) : undefined,
    seq: Number(row.seq), method: String(row.method), pathRaw: String(row.path_raw),
    pathNormalized: row.path_normalized ? String(row.path_normalized) : undefined,
    statusCode: row.status_code === null || row.status_code === undefined ? undefined : Number(row.status_code),
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? undefined : Number(row.latency_ms),
    passed: row.passed === null || row.passed === undefined ? undefined : Boolean(row.passed),
    error: row.error === null || row.error === undefined ? undefined : String(row.error),
    requestSummary: (row.request_summary ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function mapIngestPathRule(row: Record<string, unknown>): IngestPathRule {
  return {
    id: String(row.id), projectId: String(row.project_id), pathPrefix: String(row.path_prefix),
    note: String(row.note ?? ""),
    createdBy: row.created_by ? String(row.created_by) : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}
