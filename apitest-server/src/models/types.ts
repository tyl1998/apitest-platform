/* 唯一的 import：`mapCiTask` 要把 `allureDir` 现算出来（P4.5-14，报告目录的单一出处是
   命令行本身）。`lib/allureDir.ts` 是纯函数、不碰 db，不会把这份类型文件拖进依赖环。 */
import { parseAllureDir } from "../lib/allureDir.js";

export type Role = "project_admin" | "developer" | "viewer";
/**
 * 「我在这个项目里是谁」（P6 边界 5）：项目三级角色原样透出，系统管理员短路成
 * `system_admin`——前端按它隐藏入口（useMyRole），成员 CRUD 的 role 词汇与 DB CHECK
 * 保持同一套，不再做一层 admin ↔ project_admin 的映射。
 */
export type MyRole = Role | "system_admin";
/**
 * 内部用户行（`currentUser` / 登录校验用）：`passwordHash` 只在这条路径上活着，
 * **任何 `/system/users*` 响应都不用它**——管理面用 `mapManagedUser` 的形状。
 */
export type User = { id: string; email: string; name: string; passwordHash: string; isSystemAdmin: boolean; status: "active" | "disabled" };
/**
 * 用户管理行的 API 形状（P6-2，计划 10.2）：`status` 供禁用/启用的就地展示，
 * `mustChangePassword` 让管理员看到「谁的初始密码还没改」，`lastLoginAt` 供排序。
 * 哈希永远不出现在这里（规则 7 的用户面版本）。
 */
export type ManagedUser = {
  id: string; email: string; name: string; isSystemAdmin: boolean;
  status: "active" | "disabled"; mustChangePassword: boolean;
  lastLoginAt: string | null; createdAt: string; updatedAt: string;
};
/**
 * 项目成员行（P6-4，计划 10.2 的 `GET /projects/:id/members`）：email/name 是读时
 * JOIN 快照（用户改名后成员表跟着新名走——成员不是历史，是当下的事实）；`grantedBy`
 * 为空表示 P6 之前的存量行或建项目时自动写入，没有签发人可指。
 */
export type ProjectMember = {
  userId: string; email: string; name: string;
  status: "active" | "disabled"; role: Role;
  grantedBy: string | null; grantedByEmail: string | null; grantedAt: string;
};
/**
 * 添加成员的候选行（P6-4，`GET /projects/:id/members/candidates`）：三列最小投影，
 * 不带管理面字段——project_admin 搜人加人，不需要也不该看到 must_change_password。
 */
export type MemberCandidate = { id: string; email: string; name: string };
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
 *
 * `userId`（P9-1 收件口径变更）：manual / ci 的**人**落点——站内通知的收件人
 * （alert / suite_result / ci_result 谁触发发给谁）。调度 / Webhook 不带（非人
 * 触发不发站内，见 057b）。
 */
export type TriggerContext = {
  source: TriggerSource;
  refId?: string;
  refName?: string;
  /** 触发人（手动 / MCP execute / CI 手动触发）；非人触发缺省。 */
  userId?: string;
};

export type ExecutionIndex = {
  id: string;
  projectId: string;
  /* 'scenario' 已由 026 从 CHECK 中移除（P2-3 场景下线，行由 021 删净）。
     'batch' 仍在 CHECK 里但暂无写入方：批量调试有自己的 batch_executions。
     'ingest' 是仓库模式的一次上报（P4 边界 1，迁移 035 放宽 CHECK）：它是「别人已经
     跑完的历史」，所以取消/重跑/回收三条路径都要显式拒绝它。
     'runner' 是一次自研 Runner 的 pipeline run（P4.5-4 写入，迁移 038 放宽 CHECK）：
     详情跳 pipeline-runs/:id，取消走 pipeline-runs 的 cancel（只经心跳下发）。 */
  kind: "flow" | "suite" | "batch" | "ingest" | "runner";
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
  /**
   * 该失败行当前的人工归因（P8-3，报告成员行随行 LEFT JOIN；失败成员有 httpExecutionId
   * 时归因挂在 executions 行、否则挂在本步骤行——推导与读侧同一句 SQL）。只有失败行
   * 可能有值；undefined = 未归因。其余使用方（流程步骤树等）不 SELECT 归因列，恒 undefined。
   */
  attribution?: FailureAttributionLite;
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
 * 可被定时调度的目标类型（P4.5-12，迁移 042 放宽了 CHECK）。
 *
 * 流程**不在**里面（P3 边界 1）：要按时跑一条流程，把它放进一个只含它的套件——那样才有
 * 报告与统计口径。CI 任务加进来是因为它自己就是一次完整执行，没有「放进套件」这个形状。
 */
export const SCHEDULE_TARGET_TYPES = ["suite", "ci_task"] as const;
export type ScheduleTargetType = (typeof SCHEDULE_TARGET_TYPES)[number];

/**
 * 一条定时调度（P3 边界 1 + P4.5-12）：目标是测试套件或 CI 任务。
 *
 * 迁移 030 留整列而只写一个 CHECK 值，正是为了这一刻不必回填历史行（与迁移 010 的
 * workers.mode 同一条理由）；迁移 042 只放宽 CHECK，表的形状一处没动。
 */
export type Schedule = {
  id: string;
  projectId: string;
  name: string;
  targetType: ScheduleTargetType;
  targetId: string;
  /** 列表查询 join 出的目标名，编辑器要能显示「这条调度跑的是哪个套件 / 任务」。 */
  targetName?: string;
  /**
   * 为空 = 套件自己的环境配置；有值 = 触发时覆盖（P3 边界 4，复用既有 override 链）。
   * **CI 任务目标上这一列无意义**：仓库里的脚本自己决定打哪个环境，平台不注入环境
   * （P4.5-12）。前端在 CI 目标下不显示这个选择器，服务端也不拿它做任何事。
   */
  environmentId?: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  /**
   * 每次触发都带的变量覆盖（6.5 泳道第二层），以最高优先级压过环境变量。
   * **CI 任务目标下它就是 `parameters`**（P4.5-12）：两者的键形约束是同一条
   * （`VARIABLE_NAME_PATTERN`）、语义也是同一句「这次触发带什么」，为它加第二列只会让
   * 「我该填哪个框」变成一个新问题。
   */
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
  /**
   * 套件目标触发成功后指向产生的父执行；skipped / failed 没有。
   * **CI 目标在触发时拿不到它**——`pipeline_runs` 的 index 行只在终态才写，所以那条路径
   * 记的是下面的 `pipelineRunId`（P4.5-12，迁移 042）。
   */
  executionIndexId?: string;
  /** CI 目标触发成功后指向那条 pipeline run（任务被删时置空，调度证据仍在）。 */
  pipelineRunId?: string;
  /**
   * 那次执行自己的状态（读时 JOIN，不落 schedule_runs）：`triggered` 只回答「拉起
   * 成功」，执行结果在这——CI 目标是 `pipeline_runs.status`（queued/running/…终态），
   * 套件目标是 `execution_index.status`（ExecutionStatus 五值）。skipped / failed 与
   * 引用悬空（目标被删）时为 undefined。
   */
  executionStatus?: string;
  /** 触发失败的原因（哪个分区没有执行器 / 没有在线 Runner、解析成零成员等）。 */
  error?: string;
  createdAt: string;
};

/**
 * 可被 Webhook 触发的目标类型（P4.5-12，迁移 042 放宽了 CHECK）。
 *
 * 流程留着（P3 边界 1 末段）：外部业务事件天然是单链路且要带入参。CI 任务加进来回答的是
 * 另一件事——发布流水线跑完，让平台在自己的 Runner 上跑一遍仓库里的用例。
 */
export const WEBHOOK_TARGET_TYPES = ["flow", "suite", "ci_task"] as const;
export type WebhookTargetType = (typeof WEBHOOK_TARGET_TYPES)[number];

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
  targetType: WebhookTargetType;
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

/**
 * 邀请码行（P6-3，计划 10.1 的 `invitations`）。`tokenHash` 刻意不在映射里——
 * 它没有任何客户端用途，映射里留一行就迟早有一行被顺手透出（`mapIngestToken` 的
 * 同款推理）。`createdByEmail` / `consumedByEmail` 是读时 LEFT JOIN 的快照，回答
 * 「谁签的、被谁用了」。
 */
export type Invitation = {
  id: string;
  note: string;
  projectId: string | null;
  role: Role | null;
  tokenPrefix: string;
  createdBy: string | null;
  createdByEmail: string | null;
  expiresAt: string;
  consumedAt: string | null;
  consumedBy: string | null;
  consumedByEmail: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export function mapInvitation(row: Record<string, unknown>): Invitation {
  return {
    id: String(row.id),
    note: String(row.note ?? ""),
    projectId: row.project_id ? String(row.project_id) : null,
    role: (row.role as Role | null) ?? null,
    tokenPrefix: String(row.token_prefix),
    createdBy: row.created_by ? String(row.created_by) : null,
    createdByEmail: row.created_by_email ? String(row.created_by_email) : null,
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    consumedAt: row.consumed_at ? new Date(String(row.consumed_at)).toISOString() : null,
    consumedBy: row.consumed_user_id ? String(row.consumed_user_id) : null,
    consumedByEmail: row.consumed_by_email ? String(row.consumed_by_email) : null,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function mapUser(row: Record<string, unknown>): User {
  return { id: String(row.id), email: String(row.email), name: String(row.name), passwordHash: String(row.password_hash), isSystemAdmin: Boolean(row.is_system_admin), status: row.status === "disabled" ? "disabled" : "active" };
}

/** 管理面行映射（P6-2）：列清单由路由写死，这里只做 snake → camel。哈希列不在其中。 */
export function mapManagedUser(row: Record<string, unknown>): ManagedUser {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    isSystemAdmin: Boolean(row.is_system_admin),
    status: row.status === "disabled" ? "disabled" : "active",
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: row.last_login_at ? new Date(String(row.last_login_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

/**
 * 一条文本用例 → 自动化资产的绑定（P7-6，计划 11.0 边界 8/9/10）。
 *
 * `targetType` 四类：endpoint（接口，表达「该测什么」，**不算自动化**）/
 * case（接口用例）/ flow（流程）/ repo_case（仓库用例）。repo_case 的身份是
 * `(project, case_key)` 而不是行 id——行会被对账标 removed，`targetId` 存的当前行
 * id 只供读时关联，`targetKey` 是 key 快照。
 *
 * 读时关联的三样：`targetName`（目标名字快照，目标删了读「目标已删除」）、
 * `targetStatus`（repo_case 行的 active/removed）、`lastResult`（最近自动化结果——
 * case/flow 查 executions 最新一条终态、repo_case 读 last_result + 最近任务报告，
 * endpoint 无执行语义恒空）。**绝不回写**（迁移 047 同一条纪律）。
 */
export type SpecLinkTargetType = "endpoint" | "case" | "flow" | "repo_case";

export type SpecLinkLastResult = {
  /** 终态判定：success / failed / canceled / queued / running（executions 口径）
      或 repo_case 的 passed / failed / unknown / not_run。无执行记录时缺席。 */
  status: string;
  /** 那次执行的完成时刻（executions.finished_at / 报告 runAt）。 */
  at?: string;
  /** 深链目标：executions 行 id 或 pipeline run id——前端跳详情页用。 */
  runId?: string;
};

export type SpecCaseLink = {
  id: string;
  specCaseId: string;
  targetType: SpecLinkTargetType;
  targetId: string;
  /** 仅 repo_case：case_key 快照（绑定后 key 不变，行 id 会换）。 */
  targetKey?: string;
  /** 目标名字（读时 JOIN；目标已删时缺席，前端显示「目标已删除」）。 */
  targetName?: string;
  /** 仅 repo_case：行状态（removed = 对账判消失，「目标已失效」）。 */
  targetStatus?: string;
  /** 仅 case：宿主接口 id（读时 JOIN；前端拼 `endpoints/:id?case=` 深链用）。 */
  targetEndpointId?: string;
  /** 最近自动化结果（读时关联；endpoint 目标恒空）。 */
  lastResult?: SpecLinkLastResult;
  createdAt: string;
};

export function mapSpecCaseLink(row: Record<string, unknown>): SpecCaseLink {
  const hasResult = row.last_status !== undefined && row.last_status !== null;
  return {
    id: String(row.id),
    specCaseId: String(row.spec_case_id),
    targetType: String(row.target_type) as SpecCaseLink["targetType"],
    targetId: String(row.target_id),
    targetKey: row.target_key === undefined || row.target_key === null ? undefined : String(row.target_key),
    targetName: row.target_name === undefined || row.target_name === null ? undefined : String(row.target_name),
    targetStatus: row.target_status === undefined || row.target_status === null ? undefined : String(row.target_status),
    targetEndpointId: row.target_endpoint_id === undefined || row.target_endpoint_id === null ? undefined : String(row.target_endpoint_id),
    /* last_status 是 JOIN 列而不是绑定行自己的列：缺席（NULL）= 目标没有执行记录，
       与「查询没带 last_* 列」是同一个读法，所以判断列存在与否就足够。 */
    lastResult: hasResult
      ? {
        status: String(row.last_status),
        at: row.last_at ? new Date(String(row.last_at)).toISOString() : undefined,
        runId: row.last_run_id ? String(row.last_run_id) : undefined,
      }
      : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/**
 * 一个测试计划（P7-7，计划 11.0 边界 12）：一批文本用例的一次手工执行记录。
 * `summary` 五计数由列表/详情查询的分组子查询带出（服务端算好，通过率/进度的
 * 口径只在这一个地方产）：total = 项数，passed/failed/blocked/skipped 是已标记
 * 计数，未执行 = total - 四者之和。通过率 = passed/total（2026-09-09 改口径：
 * 分母是全部计划项——执行中的计划没标完就是没通过完，与平台执行类
 * passRate 的终态分母不是一个语义），进度 = 已标记/total。
 */
export type TestPlan = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: "open" | "closed";
  owner?: string;
  /** owner 名（读时 JOIN 快照；用户被删时缺席）。 */
  ownerName?: string;
  startedOn?: string;
  dueOn?: string;
  summary: { total: number; passed: number; failed: number; blocked: number; skipped: number };
  createdAt: string;
  updatedAt: string;
};

/** DATE 列（started_on/due_on）→ "YYYY-MM-DD"：pg 把 DATE 解析成**本地时区午夜**
 *  的 Date 对象（2026-09-23 00:00 +08:00），`String(date)` 是 "Wed Sep 23 2026 …"——
 *  既不是 API 该有的形状，塞进 `<input type="date">` 还是非法 value（回填被清空，
 *  2026-09-09 反馈「编辑后看不到截止时间」的根因）。取**本地**分量三件套：
 *  「本地午夜」里的本地年月日恰好就是入库的日期字符串（UTC 分量会差一天，
 *  东八区取 UTC 是 09-22T16:00——实测踩过方向才敢写这句）。 */
function mapDateOnly(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value);
}

export function mapTestPlan(row: Record<string, unknown>): TestPlan {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    status: row.status === "closed" ? "closed" : "open",
    owner: row.owner === undefined || row.owner === null ? undefined : String(row.owner),
    ownerName: row.owner_name === undefined || row.owner_name === null || row.owner_name === ""
      ? undefined : String(row.owner_name),
    startedOn: mapDateOnly(row.started_on),
    dueOn: mapDateOnly(row.due_on),
    /* 计数五元组来自路由层拼串拆解（splitSummary）后铺平的键。 */
    summary: {
      total: Number(row.total ?? 0),
      passed: Number(row.passed ?? 0),
      failed: Number(row.failed ?? 0),
      blocked: Number(row.blocked ?? 0),
      skipped: Number(row.skipped ?? 0),
    },
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

/**
 * 一个计划项：`titleSnapshot` / `modulePathSnapshot` 是入计划时的冻结快照（计划
 * 是历史——用例后来改名/移动，旧计划仍读得通）；`result` NULL = 未执行（五态的
 * 第五个）。`specCaseKey` / `specCaseStatus` 是活数据（非快照）：用例被删后两者
 * 缺席、快照仍在，前端读「用例已删除」。表没有 created_at 列（迁移 052 只定义了
 * executed_at），所以这里没有 createdAt——入计划时间不是一个被存储的事实，不臆造它。
 * （自动化参考列 2026-09-09 第二轮反馈整列删除——读时关联的 LATERAL 连同字段
 * 一并移除，用户不需要这一读数。）
 */
export type TestPlanItem = {
  id: string;
  planId: string;
  specCaseId?: string;
  titleSnapshot: string;
  modulePathSnapshot: string;
  assignee?: string;
  assigneeName?: string;
  result?: "passed" | "failed" | "blocked" | "skipped";
  note: string;
  defectUrl?: string;
  executedAt?: string;
  specCaseKey?: string;
  specCaseStatus?: string;
};

export function mapTestPlanItem(row: Record<string, unknown>): TestPlanItem {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    specCaseId: row.spec_case_id === undefined || row.spec_case_id === null ? undefined : String(row.spec_case_id),
    titleSnapshot: String(row.title_snapshot ?? ""),
    modulePathSnapshot: String(row.module_path_snapshot ?? ""),
    assignee: row.assignee === undefined || row.assignee === null ? undefined : String(row.assignee),
    assigneeName: row.assignee_name === undefined || row.assignee_name === null || row.assignee_name === ""
      ? undefined : String(row.assignee_name),
    result: row.result === undefined || row.result === null ? undefined : String(row.result) as TestPlanItem["result"],
    note: String(row.note ?? ""),
    defectUrl: row.defect_url === undefined || row.defect_url === null ? undefined : String(row.defect_url),
    executedAt: row.executed_at === undefined || row.executed_at === null ? undefined : new Date(String(row.executed_at)).toISOString(),
    specCaseKey: row.item_key === undefined || row.item_key === null ? undefined : String(row.item_key),
    specCaseStatus: row.spec_case_status === undefined || row.spec_case_status === null ? undefined : String(row.spec_case_status),
  };
}

/** 成员行映射（P6-4）：granted_by 的 email 单独一列 JOIN 出来，成员表不用第二次查用户。 */
export function mapProjectMember(row: Record<string, unknown>): ProjectMember {
  return {
    userId: String(row.user_id),
    email: String(row.email),
    name: String(row.name),
    status: row.status === "disabled" ? "disabled" : "active",
    role: String(row.role) as Role,
    grantedBy: row.granted_by ? String(row.granted_by) : null,
    grantedByEmail: row.granted_by_email ? String(row.granted_by_email) : null,
    grantedAt: new Date(String(row.granted_at)).toISOString(),
  };
}

/** 候选行映射（P6-4）：三列同名的最小投影，单独一个映射保持「行不过映射不出文件」的纪律。 */
export function mapMemberCandidate(row: Record<string, unknown>): MemberCandidate {
  return { id: String(row.id), email: String(row.email), name: String(row.name) };
}

/**
 * 审计日志行（P6-2，边界 11「从只写到可读」）。`userEmail` / `projectName` 是读时
 * LEFT JOIN 出来的快照——用户被禁用/改名后审计仍要读得出「当时是谁」；系统级动作
 * （Runner Token 签发等）两者皆 null。`detail` 原样透传：写入侧的 4KB 护栏
 * （`lib/audit.ts`）已经保证它是决策证据而不是 payload 转储。
 */
export type AuditLog = {
  id: number;
  projectId: string | null;
  projectName: string | null;
  userId: string | null;
  userEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown>;
  ip: string;
  createdAt: string;
};

export function mapAuditLog(row: Record<string, unknown>): AuditLog {
  return {
    id: Number(row.id),
    projectId: row.project_id ? String(row.project_id) : null,
    projectName: row.project_name ? String(row.project_name) : null,
    userId: row.user_id ? String(row.user_id) : null,
    userEmail: row.user_email ? String(row.user_email) : null,
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: row.target_id ? String(row.target_id) : null,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    ip: String(row.ip ?? ""),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
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
    attribution: attributionOf(row),
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
    /* CHECK 在迁移 042 放宽成 ('suite','ci_task')；cast 而不是硬编码字面量，所以这一行
       在那次放宽时一个字都没改（030 留整列的收益就在这里）。 */
    targetType: String(row.target_type) as Schedule["targetType"],
    targetId: String(row.target_id),
    /* 列表查询按 target_type 分别 join test_suites / ci_tasks 的名字；未 join 时缺省。 */
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
    pipelineRunId: row.pipeline_run_id ? String(row.pipeline_run_id) : undefined,
    /* runs 列表路由 JOIN 出的两列；别处（无 JOIN）调用本 mapper 时保持 undefined。 */
    executionStatus: row.run_status !== null && row.run_status !== undefined
      ? String(row.run_status)
      : row.exec_status !== null && row.exec_status !== undefined ? String(row.exec_status) : undefined,
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
 * 项目级命名 Git 凭据（P4.5-14，迁移 041）。
 *
 * 它取代了原先挂在 `repositories` 上的 `clone_method` / `credential_encrypted`
 * （计划 8.11 的 A 类）：那三列要求「先有一次上报才能配 clone」，而用户来这里正是因为
 * 还没有 CI。凭据搬到自己的表上并获得一个名字后，多个任务共用一把 key，换 token 只改
 * 一处。
 *
 * **没有 `none` 档**：「公开仓库不需要凭据」由任务不引用任何凭据表达
 * （`CiTask.gitCredentialId` 为空），不需要一行「什么都没有的凭据」来代表它。
 *
 * 明文永不回（边界 11 的缓解②）：只回 `method` 与 `credentialUpdatedAt`——与
 * `Environment.secretKeys`、`WebhookTrigger.hasSecret` 同一条纪律。凭据明文只在 claim
 * 的响应体里出现一次。
 */
export type GitCredential = {
  id: string;
  projectId: string;
  name: string;
  method: "https_token" | "ssh_key";
  credentialUpdatedAt: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  /** 引用它的 CI 任务数，由列表查询的分组子选填入（删除前置提示用）。 */
  taskCount?: number;
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
  /** 本地跑没有 CI id，协议里存空串而不是 null（NULL 在 UNIQUE 里不去重）。
   * 2026-09-03（迁移 045）起语义变为「最近一次上报的 CI 来源」，同一 commit 的
   * 上报折同一行、不随执行新增行。 */
  ciRunId: string;
  ciRunUrl?: string;
  /** 这个 commit 在 CI 上执行过的次数（迁移 045；SDK 直跑不计入）。 */
  ciExecutionCount: number;
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

/** 凭据密文刻意不进映射：留一行就迟早会被某个 `SELECT *` 带到响应里去。 */
export function mapGitCredential(row: Record<string, unknown>): GitCredential {
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name),
    method: String(row.method) as GitCredential["method"],
    credentialUpdatedAt: new Date(String(row.credential_updated_at)).toISOString(),
    createdBy: row.created_by ? String(row.created_by) : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
    taskCount: row.task_count === undefined || row.task_count === null ? undefined : Number(row.task_count),
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
    ciExecutionCount: Number(row.ci_execution_count ?? 1),
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

/* ── P4.5: 自研 Runner。范围与边界见 DEVELOPMENT_PLAN.md 8.0 ──────────────────── */

/** Runner 支持的沙箱档（边界 15）。容器档是任务级默认，进程档是一个信任声明。 */
export const SANDBOX_MODES = ["process", "container"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/**
 * 平台当前实现的 Runner 协议版本，与 **N / N-1 双支持** 的受理集合（8.2 约定 7）。
 *
 * 自托管 Runner 的升级不由平台控制，所以受理集合必须是显式的一份常量而不是散落的 `if`：
 * 注册时按它拒绝，JobSpec 组装时按它分派。首版只有 `1.0`，但机制现在就要在——补协议
 * 字段比补版本机制便宜得多（P4 边界 19 是同一个教训）。
 */
export const RUNNER_PROTOCOL_VERSION = "1.0";
export const SUPPORTED_RUNNER_PROTOCOL_VERSIONS = [RUNNER_PROTOCOL_VERSION] as const;

/**
 * Runner 多久没心跳算离线。
 *
 * 90 秒 = 三个心跳间隔（Spec 2.10.2），与租约时长同一个数——`pipeline_runs.lease_expires_at`
 * 由每次心跳续到 `now() + 90s`。**刻意与 `WORKER_OFFLINE_AFTER_SECONDS`（30 秒）不同**：
 * BullMQ worker 直写 Postgres 心跳、掉线只影响调度；Runner 的心跳要跨公网走 HTTP，掉线要
 * 判 `aborted` 并回收租约——把一次网络抖动读成「机器没了」的代价高得多。
 *
 * 单一来源：Runner 池面板与触发前的「这个标签下有在线 Runner 吗」必须用同一个阈值，
 * 两个数会让「面板显示在线、触发却说没有 Runner」成立（P2-8 边界 4 的同一个坑）。
 */
export const RUNNER_OFFLINE_AFTER_SECONDS = 90;

/**
 * 心跳间隔（由 `register` 的响应下发给 Runner，客户端不自己定）。
 *
 * **5 秒（2026-09-03 从 30 秒调小）**：取消只经心跳下发（约定 6），间隔就是取消信号的最坏
 * 到达延迟——30 秒下，一个 35 秒的任务点完取消几乎注定「看着它跑完」（验收实测：信号在
 * 容器启动后整 30 秒到达，脚本离自然结束只剩 0.75 秒，杀梯子无事可做）。降到 5 秒后取消
 * 最坏 5 秒内到达；代价是每个在途 job 每 5 秒一拍 HTTP（本地/内网部署无感），租约与掉线
 * 判据不受影响（都钉在 90 秒，不随间隔缩放）。Spec 2.10.2 原文的「90 秒 = 三个心跳间隔」
 * 的推导由此失效，以本注释为准。
 */
export const RUNNER_HEARTBEAT_INTERVAL_SECONDS = 5;
/** 25 秒：与 SSE 心跳同款，避开常见的 30 秒代理超时（8.2 约定 2）。 */
export const RUNNER_POLL_TIMEOUT_SECONDS = 25;

/**
 * Runner 注册 Token（迁移 036）。系统级，明文只在创建时回一次。
 *
 * `labels` 是**这张 token 允许声明的分区**：注册时校验 `runner.labels ⊆ token.labels`，
 * 否则任何拿到 token 的机器都能自称在生产网段并开始领那边的任务。
 */
export type RunnerToken = {
  id: string;
  name: string;
  /** 明文前 8 位（`apirunner_` 之后那段），供列表辨认，不足以反推 Token。 */
  tokenPrefix: string;
  labels: string[];
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  createdAt: string;
  /** 这张 token 下已注册的 Runner 台数（列表查询 join 出来）。 */
  runnerCount?: number;
};

/**
 * 一台已注册的 Runner（迁移 036）。
 *
 * 与 `Worker` 是**两张表两个概念**，界面上要挨着放并写明区别（8.6）：
 * 「执行器（平台内部 BullMQ worker）」vs「Runner（自托管，跑仓库代码）」。不写明会被
 * 当成重复功能报上来。
 */
export type Runner = {
  id: string;
  runnerTokenId: string;
  /** 签发时人给 token 起的名字（列表查询 join 出来），用于「这台是拿哪张 token 注册的」。 */
  runnerTokenName?: string;
  /** Runner 自报的 hostname，仅显示。 */
  name: string;
  labels: string[];
  capacity: number;
  /** 这台机器实际支持哪几档沙箱，由 Runner 探测本机 docker 后自报。 */
  sandboxModes: SandboxMode[];
  /** 容器档通道（迁移 046）：`cli`（docker run 命令）/ `api`（Engine API over socket）。
      空串 = 没自报（进程档 only 或旧版 Runner），读侧显示「—」。 */
  dockerTransport?: string;
  version: string;
  protocolVersion: string;
  /** `draining` 是唯一一个人可以改的值：不再参与 claim，在跑的任务跑完。 */
  status: "online" | "draining" | "offline";
  /**
   * 由查询按心跳新鲜度算出，从不存储。
   *
   * 它只回答「这台机器在不在线」，**不**回答「这个任务还活着吗」——后者是
   * `pipeline_runs.lease_expires_at`（边界 5）。
   */
  online: boolean;
  lastSeenAt: string;
  registeredAt: string;
};

/** 一条 CI 任务（迁移 037）。CRUD 是 P4.5-2，mapper 先行落位。 */
export type CiTask = {
  id: string;
  projectId: string;
  /**
   * 任务自带的拉取地址与凭据引用（P4.5-14，迁移 041）。
   *
   * 与 `Repository.gitUrl` 刻意同名不同角色：后者是上报身份（`/ingest` 的准入判据），
   * 这里只回答「Runner 去哪 clone」。搬过来的理由是配置顺序——仓库行只能由第一次上报
   * 创建，而用户建任务时通常还没有任何上报（计划 8.11 的 A 类）。
   *
   * `gitCredentialId` 为空 = 公开仓库，不需要凭据。原先那个 `clone_method='none'` 档
   * 由「不引用凭据」表达，拉取方式随凭据走，任务表单里不再出现这个词。
   */
  gitUrl: string;
  gitCredentialId?: string;
  /** 列表页要显示引用的是哪一把 key，由 join 填入（凭据被删时为空）。 */
  gitCredentialName?: string;
  gitCredentialMethod?: GitCredential["method"];
  name: string;
  description: string;
  gitRef: string;
  runnerLabel: string;
  sandboxMode: SandboxMode;
  /** 留位（边界 15）：`isolated` 本阶段不做，CHECK 里只有 `shared`。 */
  isolationMode: "shared";
  image: string;
  /** 一整段 shell 原文，不是数组——它们共享一个进程与工作目录（迁移 037 的注释）。 */
  steps: string;
  env: Record<string, string>;
  cachePaths: string[];
  cacheKeyFiles: string[];
  /**
   * 从 `steps` 里解析出的 allure 结果目录（`lib/allureDir.ts`），**只读派生值、不是列**。
   *
   * 报告格式的下拉与路径输入框在 P4.5-14 一起删了：目录已经写在命令里
   * （`--alluredir=…`），再要一个输入框就是让同一个事实有两个能互相矛盾的出处。
   * 解析不到为 `null`，界面据此提示「跑完不会有报告」——提示而不是拒绝保存，因为它可能
   * 写在用户仓库的 `pytest.ini` 里，平台看不见那份文件。
   */
  allureDir: string | null;
  sdkIngestEnabled: boolean;
  /**
   * 终态结果通知（P4.5-12，迁移 042）。**与套件复用同一个类型与归一函数**
   * （`SuiteNotifyConfig` / `normalizeSuiteNotify`）：形状逐字相同不是巧合——「这个东西跑
   * 完了，告诉我结果」在两种目标上是同一个问题的同一个答案。占位符词表不同（CI 语境的
   * `taskName` / `runNumber` / `gitRef` …，见 `lib/alerts.ts` 的默认模版）。
   */
  notify: SuiteNotifyConfig;
  /**
   * 任务级串行（P4.5-12，迁移 042）。**默认 true**：同一份仓库用例并发跑两遍互不干扰，
   * 是需要被证明的性质而不是默认成立的性质（用户的原始理由：共享测试数据导致 case 不稳定）。
   *
   * 语义是**排队而不是拒绝**：触发照常受理、run 照常入 `queued`，串行由 claim 侧守卫
   * （`routes/runners.ts`）保证——序号更小的在途 run 存在时，后面那条领不走。
   */
  singleConcurrency: boolean;
  timeoutSeconds: number;
  enabled: boolean;
  /**
   * 任务当前在途（queued/claimed/running/cancelling）的最新一条 run：列表页的
   * 「执行中/排队中」行内提示，点击直达 run 详情。只有列表查询填充，其余调用方为
   * `undefined`（读作「未知」，不与「没有在途」混同——后者是 `activeRunCount` 为 0）。
   */
  activeRun?: { id: string; runNumber: number; status: PipelineRun["status"] };
  /** 在途条数：串行任务恒 ≤1；关掉串行后一个任务可并行多条，用条数说全。仅列表查询填充。 */
  activeRunCount?: number;
  /**
   * 最近一条执行（任何状态，按 `run_number` 倒序取一条）与历史总条数。仅列表查询填充。
   *
   * `activeRun` 只在有在途 run 时存在，所以一条「跑完就没了」的任务在收起状态下既没有
   * 状态也没有规模——「这个任务上次是过还是挂，一共跑过几次」得点开才知道。这两个字段
   * 让列表行自己回答那两个问题；展开的历史表仍是完整证据（时间/触发源/计数）。
   */
  lastRun?: { id: string; runNumber: number; status: PipelineRun["status"] };
  /** 历史执行总条数（含终态与在途）。`0` 是「从没跑过」，`undefined` 是「没查」。 */
  runTotal?: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export function mapRunnerToken(row: Record<string, unknown>): RunnerToken {
  return {
    id: String(row.id), name: String(row.name),
    /* token_hash 刻意不出现在这个映射里，理由同 `mapIngestToken`：映射里留一行就迟早
       会被某个 `SELECT *` 带到响应里去。 */
    tokenPrefix: String(row.token_prefix),
    labels: Array.isArray(row.labels) && row.labels.length ? (row.labels as unknown[]).map(String) : ["default"],
    createdBy: row.created_by ? String(row.created_by) : undefined,
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : undefined,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    runnerCount: row.runner_count === null || row.runner_count === undefined ? undefined : Number(row.runner_count),
  };
}

export function mapRunner(row: Record<string, unknown>): Runner {
  return {
    id: String(row.id), runnerTokenId: String(row.runner_token_id),
    runnerTokenName: row.runner_token_name ? String(row.runner_token_name) : undefined,
    name: String(row.name),
    labels: Array.isArray(row.labels) && row.labels.length ? (row.labels as unknown[]).map(String) : ["default"],
    capacity: Number(row.capacity),
    /* 空数组读成「只支持进程档」以匹配迁移 036 的列默认值（`mapWorker` 对 labels 同款）。 */
    sandboxModes: Array.isArray(row.sandbox_modes) && row.sandbox_modes.length
      ? (row.sandbox_modes as unknown[]).map(String) as SandboxMode[]
      : ["process"],
    dockerTransport: row.docker_transport ? String(row.docker_transport) : undefined,
    version: String(row.version ?? ""),
    protocolVersion: String(row.protocol_version ?? RUNNER_PROTOCOL_VERSION),
    status: String(row.status) as Runner["status"],
    /* 由查询按 last_seen_at 新鲜度算出；`draining` 的机器仍可能 online=true——它是
       「还在跑完手上的活」而不是「已经走了」。 */
    online: Boolean(row.online),
    lastSeenAt: new Date(String(row.last_seen_at)).toISOString(),
    registeredAt: new Date(String(row.registered_at)).toISOString(),
  };
}

/**
 * `allureDir` 是从 `steps` 现算的派生值（`lib/allureDir.ts`），不是列——报告目录的单一
 * 出处是命令行本身（P4.5-14）。放在 mapper 里而不是各路由自己算，是为了「同一段命令在
 * 列表、详情、claim 三处解析出同一个答案」这件事只由一处代码保证。
 */
export function mapCiTask(row: Record<string, unknown>): CiTask {
  return {
    id: String(row.id), projectId: String(row.project_id),
    gitUrl: String(row.git_url ?? ""),
    gitCredentialId: row.git_credential_id ? String(row.git_credential_id) : undefined,
    /* join 来的两列：不在 `ci_tasks` 上，缺席就是「这个任务不用凭据」或「查询没 join」。 */
    gitCredentialName: row.git_credential_name ? String(row.git_credential_name) : undefined,
    gitCredentialMethod: row.git_credential_method ? String(row.git_credential_method) as GitCredential["method"] : undefined,
    name: String(row.name), description: String(row.description ?? ""),
    gitRef: String(row.git_ref), runnerLabel: String(row.runner_label),
    sandboxMode: String(row.sandbox_mode) as SandboxMode,
    isolationMode: String(row.isolation_mode) as CiTask["isolationMode"],
    image: String(row.image ?? ""), steps: String(row.steps ?? ""),
    env: (row.env ?? {}) as Record<string, string>,
    cachePaths: Array.isArray(row.cache_paths) ? (row.cache_paths as unknown[]).map(String) : [],
    cacheKeyFiles: Array.isArray(row.cache_key_files) ? (row.cache_key_files as unknown[]).map(String) : [],
    allureDir: parseAllureDir(String(row.steps ?? "")),
    sdkIngestEnabled: Boolean(row.sdk_ingest_enabled),
    notify: normalizeSuiteNotify(row.notify_config),
    /* 缺省读 true 而不是 false：列的 DB 默认是 true，缺列的查询（理论上不存在）读成
       「不串行」会静默改变行为。 */
    singleConcurrency: row.single_concurrency === undefined || row.single_concurrency === null ? true : Boolean(row.single_concurrency),
    timeoutSeconds: Number(row.timeout_seconds),
    enabled: Boolean(row.enabled),
    /* 列表页的行内「执行中/排队中」提示：任务当前未终态的最新一条 run + 在途条数。
       只有列表查询（routes/ciTasks.ts 的 LATERAL join）填充；其它调用方缺列 →
       undefined，读作「未知」而不是「没有」。 */
    activeRun: row.active_run_id
      ? {
          id: String(row.active_run_id),
          runNumber: Number(row.active_run_number),
          status: String(row.active_run_status) as PipelineRun["status"],
        }
      : undefined,
    activeRunCount: row.active_run_count === undefined || row.active_run_count === null
      ? undefined
      : Number(row.active_run_count),
    /* 最近一条执行 + 历史总条数（同一条 LATERAL join 带出）：收起的任务行要能读到
       「上次是什么结果、一共跑过几次」。`last_run_id` 为空 = 从没跑过（此时
       run_total 为 0，不是 undefined——那是「查询没带这一段」）。 */
    lastRun: row.last_run_id
      ? {
          id: String(row.last_run_id),
          runNumber: Number(row.last_run_number),
          status: String(row.last_run_status) as PipelineRun["status"],
        }
      : undefined,
    runTotal: row.run_total === undefined || row.run_total === null ? undefined : Number(row.run_total),
    createdBy: row.created_by ? String(row.created_by) : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

/**
 * 一次 CI 任务的执行（迁移 038）。
 *
 * 状态机与协议接口（claim / heartbeat / logs / complete）是 P4.5-3 / P4.5-4；本类型先落
 * 触发侧（P4.5-2）返回排队行所需的完整形状，后续批次不再改它。
 */
export type PipelineRun = {
  id: string;
  projectId: string;
  ciTaskId: string;
  /** 详情路由 JOIN ci_tasks 带出的任务名（P8-6：详情面包屑显示「任务名 #序号」，
      与执行记录行的身份同一个词）；列表路由不带。 */
  taskName?: string;
  /** 归一进统一执行记录的那一行（kind='runner'，P4.5-4 写入）；触发时还没有。 */
  executionIndexId?: string;
  /** 任务内自增，界面上的 #128。 */
  runNumber: number;
  status: "queued" | "claimed" | "running" | "cancelling" | "success" | "failed" | "canceled" | "aborted" | "timed_out";
  /** 固定四段（clone / cache / script / report）+ pending，阶段进度条的数据源。 */
  stage: "pending" | "clone" | "cache" | "script" | "report" | "done";
  /**
   * 触发时冻结的分区标签（照 P2-8 边界 1）与沙箱档快照：任务改配置后，历史 run 仍说得清
   * 「当时从哪个网段、用哪一档沙箱跑的」。
   */
  runnerLabel: string;
  sandboxMode: SandboxMode;
  runnerId?: string;
  /** 「这个任务还活着吗」的唯一判据（边界 5），不等于「Runner 在不在线」。 */
  leaseExpiresAt?: string;
  triggerSource: TriggerSource;
  triggerRefId?: string;
  triggerRefName?: string;
  triggeredBy?: string;
  gitRef: string;
  /** clone 完了由 Runner 回填。 */
  commitSha: string;
  /** NULL = 全量；`{ caseKeys }` = 勾选执行（§8.3，P4.5-9 贯通）。 */
  caseFilter?: { caseKeys: string[] };
  parameters: Record<string, unknown>;
  exitCode?: number;
  error?: string;
  /** 已收日志的总字节数 = 下一个期望 offset（边界 7）。BIGINT 经 pg 读回是字符串。 */
  logBytes: number;
  caseTotal: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  /** SDK 路径回填（A 路径，`APITRACK_CI_RUN_ID = job_id` 缝起来）。 */
  ingestRunId?: string;
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  finishedAt?: string;
};

export function mapPipelineRun(row: Record<string, unknown>): PipelineRun {
  const filter = row.case_filter as { case_keys?: unknown[] } | null | undefined;
  return {
    id: String(row.id), projectId: String(row.project_id), ciTaskId: String(row.ci_task_id),
    /* 详情路由 JOIN 带出的任务名（列表路由没有——行身份在 execution_index 的
       target_name 里，不需要重复一份）。 */
    taskName: row.task_name ? String(row.task_name) : undefined,
    executionIndexId: row.execution_index_id ? String(row.execution_index_id) : undefined,
    runNumber: Number(row.run_number),
    status: String(row.status) as PipelineRun["status"],
    stage: String(row.stage) as PipelineRun["stage"],
    runnerLabel: String(row.runner_label),
    sandboxMode: String(row.sandbox_mode) as SandboxMode,
    runnerId: row.runner_id ? String(row.runner_id) : undefined,
    leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)).toISOString() : undefined,
    triggerSource: String(row.trigger_source ?? "manual") as TriggerSource,
    triggerRefId: row.trigger_ref_id ? String(row.trigger_ref_id) : undefined,
    triggerRefName: row.trigger_ref_name ? String(row.trigger_ref_name) : undefined,
    triggeredBy: row.triggered_by ? String(row.triggered_by) : undefined,
    gitRef: String(row.git_ref), commitSha: String(row.commit_sha ?? ""),
    caseFilter: filter
      ? { caseKeys: Array.isArray(filter.case_keys) ? filter.case_keys.map(String) : [] }
      : undefined,
    parameters: (row.parameters ?? {}) as Record<string, unknown>,
    exitCode: row.exit_code === null || row.exit_code === undefined ? undefined : Number(row.exit_code),
    error: row.error === null || row.error === undefined ? undefined : String(row.error),
    logBytes: Number(row.log_bytes ?? 0),
    caseTotal: Number(row.case_total ?? 0),
    passedCount: Number(row.passed_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    skippedCount: Number(row.skipped_count ?? 0),
    ingestRunId: row.ingest_run_id ? String(row.ingest_run_id) : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    claimedAt: row.claimed_at ? new Date(String(row.claimed_at)).toISOString() : undefined,
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : undefined,
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : undefined,
  };
}

/**
 * 一份已登记的产物（迁移 039，P4.5-7）。写入方是 Runner 的 artifacts 申请路由，
 * 列表路由与下载直链（presignGet）在 P4.5-11 接上——类型与 mapper 先落位，届时
 * `SELECT *` 的返回不需要再改这一层。
 */
export type Artifact = {
  id: string;
  projectId: string;
  /** 首版只有 'pipeline_run'（多态留位，见迁移 039 的注释）。 */
  ownerType: "pipeline_run";
  ownerId: string;
  kind: "log" | "report" | "file";
  name: string;
  storageDriver: "fs" | "s3";
  /** 驱动内寻址键；不回传给前端以外的任何消费者当路径用。 */
  storageKey: string;
  sizeBytes: number;
  contentType: string;
  /** sha256 hex（fs 驱动在落盘时算；s3 侧信任申请时 Runner 报的值）。 */
  checksum: string;
  /** undefined = 申请了但没传成（Runner 中途死掉是事实，不是垃圾）。 */
  uploadedAt?: string;
  createdAt: string;
};

export function mapArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: String(row.id), projectId: String(row.project_id),
    ownerType: String(row.owner_type) as Artifact["ownerType"],
    ownerId: String(row.owner_id),
    kind: String(row.kind) as Artifact["kind"],
    name: String(row.name),
    storageDriver: String(row.storage_driver) as Artifact["storageDriver"],
    storageKey: String(row.storage_key),
    sizeBytes: Number(row.size_bytes ?? 0),
    contentType: String(row.content_type ?? "application/octet-stream"),
    checksum: String(row.checksum ?? ""),
    uploadedAt: row.uploaded_at ? new Date(String(row.uploaded_at)).toISOString() : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/**
 * 报告解析出的 case 级结果（迁移 038 + 040 + 044，P4.5-6/13）。时间戳是 allure 的 epoch
 * 毫秒原样（BIGINT 经 pg 读回是字符串，mapper 统一转 number）；junit 路径四个新列
 * 恒 NULL——渲染侧按「有 startedAtMs 才进时间轴」降级。`externalId` 是 allure 结果
 * 文件的 uuid——同名参数化用例的两次执行靠它分成两行（迁移 044）。
 */
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
  externalId?: string;
  startedAtMs?: number;
  finishedAtMs?: number;
  host?: string;
  thread?: string;
  /** 该失败行当前的人工归因（P8-3；failed/error 行才可能有值，undefined = 未归因）。 */
  attribution?: FailureAttributionLite;
};

export function mapPipelineRunCase(row: Record<string, unknown>): PipelineRunCase {
  return {
    id: String(row.id),
    pipelineRunId: String(row.pipeline_run_id),
    source: String(row.source) as PipelineRunCase["source"],
    suiteName: String(row.suite_name ?? ""),
    caseName: String(row.case_name),
    guessedCaseKey: row.guessed_case_key ? String(row.guessed_case_key) : undefined,
    status: String(row.status) as PipelineRunCase["status"],
    durationMs: Number(row.duration_ms ?? 0),
    message: row.message === null || row.message === undefined ? undefined : String(row.message),
    externalId: row.external_id ? String(row.external_id) : undefined,
    startedAtMs: row.started_at_ms === null || row.started_at_ms === undefined ? undefined : Number(row.started_at_ms),
    finishedAtMs: row.finished_at_ms === null || row.finished_at_ms === undefined ? undefined : Number(row.finished_at_ms),
    host: row.host === null || row.host === undefined ? undefined : String(row.host),
    thread: row.thread === null || row.thread === undefined ? undefined : String(row.thread),
    attribution: attributionOf(row),
  };
}

/**
 * 一条报告分享（迁移 043）。`token` 是 URL 里的公开凭据——把它回给项目成员是安全的
 * （他们本来就能创建分享），公开路由只认 token 不认人。
 */
export type ReportShare = {
  id: string;
  projectId: string;
  /** 'suite' = suite_executions.id；'runner' = pipeline_runs.id。 */
  targetType: "suite" | "runner";
  targetId: string;
  token: string;
  createdBy?: string;
  createdAt: string;
  revokedAt?: string;
};

export function mapReportShare(row: Record<string, unknown>): ReportShare {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    targetType: String(row.target_type) as ReportShare["targetType"],
    targetId: String(row.target_id),
    token: String(row.token),
    createdBy: row.created_by ? String(row.created_by) : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : undefined,
  };
}

/**
 * MCP Token 的 scope 三值（计划 9.0 边界 1，迁移 050；P12 移到绑定上）。
 *
 * `read` 看、`write` 改、`execute` 跑。绑定上是 scope 数组而不是三个 boolean——
 * 第四种 scope（将来的）加进来不改类型形状。
 */
export type McpScope = "read" | "write" | "execute";

/**
 * 一条「token × 项目 × scope」绑定（P12，迁移 063）。**scope 在绑定上不在 token 上**
 * （18.0 边界 2）：一把 token 绑 N 个项目时「A 可写、B 只读」必须可表达。
 *
 * 绑定是**过滤器，不是授权**（边界 3）：绑定时刻实时角色匹配，调用时刻每次重跑
 * `canAccess(owner, 目标项目)`。`read` 恒在（归一在绑定入口）。
 */
export type McpBinding = {
  projectId: string;
  scope: McpScope[];
  /** 绑定时刻（列表展示用；鉴权不读它）。 */
  boundAt?: string;
};

/** TEXT[] 经 pg 读回即 string[]；异常值读成空数组（校验在写入侧，库里不该有第三种值）。 */
export function mcpScopes(value: unknown): McpScope[] {
  return Array.isArray(value) ? (value as unknown[]).map(String) as McpScope[] : [];
}

export function mapMcpBinding(row: Record<string, unknown>): McpBinding {
  return {
    projectId: String(row.project_id),
    scope: mcpScopes(row.scope),
    boundAt: row.bound_at ? new Date(String(row.bound_at)).toISOString() : undefined,
  };
}

/**
 * 一张 MCP Token（迁移 050；P12 改为用户级 + 绑定数组）。明文**只在签发时回一次**
 * （与 `IngestToken` / `RunnerToken` 同一条纪律），此后接口只回 `tokenPrefix`。
 *
 * token 本体**没有 `projectId` 也没有 `scope`**——两者都在绑定上（边界 2）。`bindings`
 * 决定 `tools/list` 的能力面（并集）与 `tools/call` 放不放行（逐调用按目标项目判）。
 * 写与执行权限**不**存在任何地方：每次调用都按 `createdBy` 重跑 `canAccess`
 * （边界 2/3），Token 只是一把钥匙、不是一份权限快照。
 */
export type McpToken = {
  id: string;
  name: string;
  /** 明文前 8 位（`apimcp_` 之后那段），供列表辨认，不足以反推 Token。 */
  tokenPrefix: string;
  bindings: McpBinding[];
  /** 签发人；为空 = 已被删（整把 token 失效，鉴权侧 401）。 */
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  createdAt: string;
};

export function mapMcpToken(row: Record<string, unknown>): McpToken {
  return {
    id: String(row.id), name: String(row.name),
    /* token_hash 刻意不出现在这个映射里，理由同 `mapIngestToken`：它没有任何客户端
       用途，映射里留一行就迟早会被某个 `SELECT *` 带到响应里去。 */
    tokenPrefix: String(row.token_prefix),
    /* 绑定由调用方 SQL 以 `json_agg`（或二次查询）带回：`row.bindings` 是 jsonb 数组。
       单行读（签发响应）没有绑定，读成空数组。 */
    bindings: Array.isArray(row.bindings)
      ? (row.bindings as Record<string, unknown>[]).map(mapMcpBinding)
      : [],
    createdBy: row.created_by ? String(row.created_by) : undefined,
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : undefined,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/**
 * 项目侧看到的绑定行（`GET /projects/:id/mcp/bindings`，P12 边界 4）：回答「谁的钥匙
 * 开了我这扇门」。owner 三列是读时 JOIN 快照——项目管理员要能指着具体的人说「这把
 * 钥匙收回来」，只给 token 前缀说不出这句话。**token_hash / 明文永不出现在这里。**
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

export function mapMcpProjectBinding(row: Record<string, unknown>): McpProjectBinding {
  return {
    tokenId: String(row.token_id),
    tokenName: String(row.token_name),
    tokenPrefix: String(row.token_prefix),
    ownerId: row.owner_id ? String(row.owner_id) : null,
    ownerEmail: row.owner_email ? String(row.owner_email) : null,
    ownerName: row.owner_name ? String(row.owner_name) : null,
    scope: mcpScopes(row.scope),
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : undefined,
    boundAt: new Date(String(row.bound_at)).toISOString(),
  };
}

/**
 * 一个文本用例模块（P7，迁移 052）。`path` 物化（'/模块A/子模块/'），是身份
 * （UNIQUE (project_id, path)）；`parentId` 为空即顶层模块。`caseCount` 只在
 * 树查询里由分组子查询带出（该模块**直属**的用例数，含全部状态——导航计数
 * 不是覆盖口径，deprecated 也该在树上可见）。`activeCount` / `automatedCount`
 * 是覆盖口径（P7-6，边界 11）：前者数直属已评审（迁移 053 前 active）用例，
 * 后者数其中有 ≥1 条非 endpoint 绑定的——分母与分子都只数直属，子树求和
 * 归前端（与 caseCount 同一纪律）。
 */
export type SpecModule = {
  id: string;
  projectId: string;
  parentId?: string;
  name: string;
  path: string;
  position: number;
  caseCount?: number;
  /** 直属已评审（active）用例数——自动化覆盖率分母，子树求和归前端。 */
  activeCount?: number;
  /** 直属「已自动化」（有 ≥1 条非 endpoint 绑定）用例数——分子，子树求和归前端。 */
  automatedCount?: number;
  createdAt: string;
  updatedAt: string;
};

export function mapSpecModule(row: Record<string, unknown>): SpecModule {
  return {
    id: String(row.id), projectId: String(row.project_id),
    parentId: row.parent_id ? String(row.parent_id) : undefined,
    name: String(row.name), path: String(row.path),
    position: Number(row.position ?? 0),
    caseCount: row.case_count === undefined || row.case_count === null ? undefined : Number(row.case_count),
    activeCount: row.active_count === undefined || row.active_count === null ? undefined : Number(row.active_count),
    automatedCount: row.automated_count === undefined || row.automated_count === null ? undefined : Number(row.automated_count),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

/**
 * 文本用例的一个步骤（P7，迁移 052）：步骤 + 预期成对出现（`[{ step, expected }]`）。
 * 行内两列的形态是 QA 在 XMind/Excel 里已经写惯的形状，JSONB 原样存。
 */
export type SpecCaseStep = { step: string; expected: string };

/**
 * 一个文本用例（P7，计划 11.0）：第三类用例资产——只有设计内容（标题/前置/步骤/
 * 预期），不含请求定义、平台不执行它。`modulePath` 由列表/详情查询 JOIN spec_modules
 * 带出（用例行本身只存 module_id，模块改名/移动不用回写用例）；`linkCount` 只在
 * 列表查询里由子查询带出——绑定能创造它，但读它不依赖绑定接口存在（P7-3 接 UI）。
 */
export type SpecCase = {
  id: string;
  projectId: string;
  moduleId: string;
  modulePath?: string;
  /** 用例编号（如 TC-001）；导入判重键优先用它，无编号回落 (path, title)。 */
  itemKey?: string;
  title: string;
  preconditions: string;
  steps: SpecCaseStep[];
  priority: "P0" | "P1" | "P2" | "P3";
  tags: string[];
  /** 生命周期（㉘）：unreviewed 未评审 → reviewed 已评审 → deprecated 废弃。 */
  status: "unreviewed" | "reviewed" | "deprecated";
  /** 来源：manual / xmind / excel；建了就不再改（PATCH 不接受它）。 */
  source?: string;
  linkCount?: number;
  /** 已自动化（P7-6 列表行）：有 ≥1 条非 endpoint 绑定（与筛选、覆盖口径同一表达式）。 */
  automated?: boolean;
  createdAt: string;
  updatedAt: string;
};

export function mapSpecCase(row: Record<string, unknown>): SpecCase {
  /* steps 是 jsonb：逐行 String() 重建而不是信任形状——导入与手工写都过这里，
     异常行读成空串而不是炸掉映射（校验在写入侧）。 */
  const steps: SpecCaseStep[] = Array.isArray(row.steps)
    ? (row.steps as unknown[]).map((item) => ({
      step: String((item as { step?: unknown })?.step ?? ""),
      expected: String((item as { expected?: unknown })?.expected ?? ""),
    }))
    : [];
  return {
    id: String(row.id), projectId: String(row.project_id),
    moduleId: String(row.module_id),
    modulePath: row.module_path === undefined || row.module_path === null ? undefined : String(row.module_path),
    itemKey: row.item_key === undefined || row.item_key === null ? undefined : String(row.item_key),
    title: String(row.title),
    preconditions: String(row.preconditions ?? ""),
    steps,
    priority: String(row.priority ?? "P2") as SpecCase["priority"],
    /* TEXT[] 经 pg 读回即 string[]；异常值读成空数组（同 mapMcpToken 的 scope）。 */
    tags: Array.isArray(row.tags) ? (row.tags as unknown[]).map(String) : [],
    status: String(row.status ?? "unreviewed") as SpecCase["status"],
    source: row.source === undefined || row.source === null ? undefined : String(row.source),
    linkCount: row.link_count === undefined || row.link_count === null ? undefined : Number(row.link_count),
    automated: row.automated === undefined || row.automated === null ? undefined : Boolean(row.automated),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

/* ── P8: 失败归因（计划十二章 12.1，迁移 054）。──────────────────────────────── */

/** 归因目标三类（边界 4：只在叶子失败上归因，不在父级 run/suite execution 上打标）。 */
export type AttributionTargetType = "execution" | "pipeline_run_case" | "execution_step";

/**
 * 归因分类字典行。平台级一份（边界 5：项目不可改口径，跨项目可比才有意义）。
 * `position` 是管理面排序；`active=false` 停用后归因抽屉不再出现该选项，但历史行与
 * 统计仍按名称聚合（不删行——删语义走 409 引用扫描，见管理路由）。
 */
export type FailureCategory = {
  code: string;
  name: string;
  position: number;
  active: boolean;
};

export function mapFailureCategory(row: Record<string, unknown>): FailureCategory {
  return {
    code: String(row.code),
    name: String(row.name),
    position: Number(row.position),
    active: Boolean(row.active),
  };
}

/**
 * 行内嵌的归因读数（P8-3）：报告成员行 / CI 用例行 / 报告列表聚合随行 LEFT JOIN 带出
 * 的**展示形状**。`categoryName` 一并冗余——读侧（列表、chip、分享页）不该为了显示一个
 * 名字再发一次字典请求，更不该在公开分享页上发任何请求。完整行（id/createdBy/时间戳
 * 全套）只在归因 REST（`mapFailureAttribution`）里出现。
 */
export type FailureAttributionLite = {
  category: string;
  categoryName: string;
  note: string;
  /** 绑定的 bug 链接（P8-3 验收反馈；空串 = 未绑定）。 */
  bugUrl: string;
  source: "human" | "mcp";
  updatedAt: string;
};

/**
 * JOIN 侧的列名约定：`attribution_category` / `attribution_category_name` /
 * `attribution_note` / `attribution_bug_url` / `attribution_source` /
 * `attribution_updated_at`。没有归因时这些列全 NULL → undefined（没有行 = 未归因，
 * 边界 7）。
 */
export function attributionOf(row: Record<string, unknown>): FailureAttributionLite | undefined {
  if (row.attribution_category === null || row.attribution_category === undefined) return undefined;
  return {
    category: String(row.attribution_category),
    categoryName: String(row.attribution_category_name ?? row.attribution_category),
    note: String(row.attribution_note ?? ""),
    bugUrl: String(row.attribution_bug_url ?? ""),
    source: String(row.attribution_source ?? "human") as FailureAttributionLite["source"],
    updatedAt: new Date(String(row.attribution_updated_at)).toISOString(),
  };
}

/**
 * 一条失败的归因（边界 6：一条失败只有一个，UNIQUE (target_type, target_id)）。
 * `source` 区分人打的还是 agent 打的（边界 8：统计页可按来源筛）。`createdBy` 为空
 * 即 agent 通道（MCP Token 场景写 token 签发人——P8-7 落地，REST 路径恒有真人）。
 */
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

export function mapFailureAttribution(row: Record<string, unknown>): FailureAttribution {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    targetType: String(row.target_type) as AttributionTargetType,
    targetId: String(row.target_id),
    category: String(row.category),
    note: String(row.note ?? ""),
    bugUrl: String(row.bug_url ?? ""),
    source: String(row.source ?? "human") as FailureAttribution["source"],
    createdBy: row.created_by === null || row.created_by === undefined ? undefined : String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

/* ── P9-1：站内通知 ────────────────────────────────────────────────────────── */

/**
 * 一条站内通知（P9-1，计划 13.1/13.2）。kind 五值对应五个生产源（13.0 边界 9）：
 * member_change / plan_assign 是 P9 回补 P6/P7 的两个新源，alert / suite_result /
 * ci_result 挂在既有三个终态订阅点上。`projectName` 是读时 LEFT JOIN 快照（项目删除
 * 后通知仍可读——那件事确实发生过，与审计的 projectName 同一条纪律）。
 */
export type UserNotification = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  kind: "member_change" | "plan_assign" | "alert" | "suite_result" | "ci_result";
  title: string;
  body: string;
  /** 站内相对路径（空串 = 无深链）；绝对地址由前端按当前 origin 拼。 */
  link: string;
  readAt: string | null;
  createdAt: string;
};

export function mapUserNotification(row: Record<string, unknown>): UserNotification {
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    projectName: row.project_name === null || row.project_name === undefined || row.project_name === "" ? null : String(row.project_name),
    kind: String(row.kind) as UserNotification["kind"],
    title: String(row.title),
    body: String(row.body ?? ""),
    link: String(row.link ?? ""),
    readAt: row.read_at === null || row.read_at === undefined ? null : new Date(String(row.read_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/* ── P9-2：站内助手会话 ────────────────────────────────────────────────────── */

/**
 * 一行「平台 ↔ 上游会话」映射（P9-2，计划 13.1/13.2）。对话正文不落库（边界 2）：
 * transcript 在 agent 平台侧，这里只存「哪个人在哪个 provider 开了哪个会话」
 * （2026-09-16 用户级化：会话是「人」的，不挂项目——迁移 062 删了 project_id）。
 * `upstreamConversationId` 是上游的会话 id（agent-vendor 为 Long 文本）。
 */
export type AssistantConversation = {
  id: string;
  providerId: string;
  userId: string;
  upstreamConversationId: string;
  topic: string;
  /**
   * 会话所属 provider 的能力面（P9-4 起随行带出、P9-4b 起按协议形状派生）：抽屉按它
   * 决定停止按钮是否出现（门槛 13——协议没定义 stop 端点的 provider 停止按钮不出现）
   * 与历史是否加载。查询用 `p.protocol AS provider_protocol` 随行带出；创建路由在
   * 调用点显式补上。
   */
  providerCapabilities: { stop: boolean; history: boolean; attachments: boolean };
  createdAt: string;
  lastActiveAt: string;
};

/** 能力面从协议形状派生：定义了对应端点 = 有该能力（P9-4b，取代 type 预设收窄）。 */
function capabilitiesFromProtocol(value: unknown): { stop: boolean; history: boolean; attachments: boolean } {
  const protocol = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    stop: Boolean(protocol.stop),
    history: Boolean(protocol.history),
    attachments: protocol.attachments === true,
  };
}

export function mapAssistantConversation(row: Record<string, unknown>): AssistantConversation {
  /* 协议缺席（未 JOIN、未补）时能力面一律 false——隐藏按钮、跳过历史，宁可少显示
     不可错显示（providers.ts 同款纪律）。 */
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    userId: String(row.user_id),
    upstreamConversationId: String(row.upstream_conversation_id),
    topic: String(row.topic ?? ""),
    providerCapabilities: capabilitiesFromProtocol(row.provider_protocol),
    createdAt: new Date(String(row.created_at)).toISOString(),
    lastActiveAt: new Date(String(row.last_active_at)).toISOString(),
  };
}

/* ── P9-4b：用户级 agent + 通用协议 provider ────────────────────────────────── */

/**
 * 一个用户在一个上游上的 agent 配置（迁移 059）。`params` 只含明文参数；
 * `secretKeys` 是敏感项的键名清单（值加密落库、接口只回「已配置」——environments
 * 的 secretKeys 同款纪律）。
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

export function mapAssistantUserAgent(row: Record<string, unknown>): AssistantUserAgent {
  const params = (row.params && typeof row.params === "object" ? row.params : {}) as Record<string, unknown>;
  const secrets = (row.secrets && typeof row.secrets === "object" ? row.secrets : {}) as Record<string, unknown>;
  return {
    providerId: String(row.provider_id),
    providerName: String(row.provider_name ?? ""),
    providerEnabled: row.provider_enabled !== false,
    params: Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value ?? "")])),
    secretKeys: Object.keys(secrets),
    isDefault: row.is_default === true,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

/* ── P9-3/P9-4b：助手 provider（系统级，通用协议） ──────────────────────────── */

/**
 * provider 管理面的行形态（P9-3 起家、P9-4b 通用化）。`protocol` 是 4 接口 + SSE
 * 映射 + 认证模板的通用协议配置（形状见 lib/assistant/types.ts）；`userParams` 是
 * 用户配置自己的 agent 时要填的参数模式（抽屉「设置」卡按它渲染表单）。没有共享
 * Key——凭据全在用户行（AssistantUserAgent）。`conversationCount` 是删除确认的
 * 影响面读数（映射行随 provider 级联删，13.1）。
 */
export type AssistantProvider = {
  id: string;
  name: string;
  protocol: Record<string, unknown>;
  userParams: unknown[];
  /** 从协议形状派生：定义了 stop/history 端点 = 有该能力（前端按钮显隐，门槛 13）。 */
  capabilities: { stop: boolean; history: boolean; attachments: boolean };
  enabled: boolean;
  isDefault: boolean;
  conversationCount: number;
  createdAt: string;
  updatedAt: string;
};

export function mapAssistantProvider(row: Record<string, unknown>): AssistantProvider {
  const protocol = (row.protocol && typeof row.protocol === "object" ? row.protocol : {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    name: String(row.name),
    protocol,
    userParams: Array.isArray(row.user_params) ? row.user_params : [],
    capabilities: {
      stop: Boolean(protocol.stop),
      history: Boolean(protocol.history),
      attachments: protocol.attachments === true,
    },
    enabled: row.enabled === true,
    isDefault: row.is_default === true,
    /* LATERAL 随行计数（列表查询带出）；无该列的调用点传 0。 */
    conversationCount: Number(row.conversation_count ?? 0),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}
