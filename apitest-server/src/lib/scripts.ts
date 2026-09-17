import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import type { Assertion, FlowNode, HookConfig, ResponseScriptConfig, ScriptRef } from "../models/types.js";

/**
 * Script persistence for assertions (计划 4.0.1).
 *
 * The whole point of this module is that **the client never orchestrates two
 * writes**. A naive design would have the browser POST each script, collect the
 * ids, then PATCH the case: a 20-step save becomes 21 round trips, and a failure
 * halfway leaves either an orphan script or an assertion pointing at nothing.
 * Instead one request carries everything, and the upsert runs inside the same
 * transaction as the case write, ordered here rather than on the wire.
 *
 * Only *edited* scripts carry `content`. That is what keeps the payload
 * proportional to what changed rather than to how many scripts exist, which is
 * the actual answer to "one save with a script on every step is enormous".
 */

/** Long enough for real assertions, short enough to stay reviewable in a diff. */
const MAX_SCRIPT_LENGTH = 20_000;

function scriptAssertions(assertions: Assertion[]) {
  return assertions.filter((assertion) => assertion.type === "script");
}

/**
 * Writes the scripts a case save carries and returns assertions holding ids only.
 *
 * Must run inside the caller's transaction — the case row and its scripts have
 * to land together or not at all.
 *
 * Rejects, rather than silently accepting, a `content` edit aimed at a 具名公共
 * 脚本. Saving one case must not rewrite a script twenty other cases follow; that
 * edit belongs to `PATCH /projects/:id/scripts/:scriptId`, which is the only
 * place the "this affects N references" confirmation can honestly live.
 *
 * Throws with a user-facing message, which the route turns into a 400.
 */
export async function persistCaseScripts(
  client: PoolClient,
  projectId: string,
  caseId: string,
  assertions: Assertion[],
  actorId: string | null = null,
): Promise<Assertion[]> {
  return persistOwnedScripts(client, projectId, { column: "owner_case_id", id: caseId, label: "case" }, assertions, actorId);
}

/** All request-lifecycle scripts owned by one test case, persisted atomically. */
export async function persistCaseLifecycleScripts(
  client: PoolClient,
  projectId: string,
  caseId: string,
  input: { hooks: HookConfig[]; responseScripts: ResponseScriptConfig[] },
  actorId: string | null = null,
): Promise<{ hooks: HookConfig[]; responseScripts: ResponseScriptConfig[] }> {
  const owner = { column: "owner_case_id", id: caseId, label: "case" } as const;
  const seen: string[] = [];
  const hooks = await persistHookRefs(client, projectId, owner, input.hooks, seen, actorId);
  const responseScripts = await persistResponseScriptRefs(client, projectId, owner, input.responseScripts, seen, actorId);
  await collectGarbage(client, owner, seen);
  return { hooks, responseScripts };
}

/**
 * The same upsert for a flow's node assertions **and** its 前置钩子 (P1-2).
 *
 * Takes every node at once rather than one per call: the garbage collection at
 * the end deletes anonymous scripts the owner no longer references, so running
 * it per node would delete the scripts belonging to every *other* node in the
 * same flow.
 */
/**
 * 一棵节点树里出现过的**所有**脚本 id。
 *
 * 清理不能只信遍历时累加的 `seen`：漏掉任何一个槽位（断言 / 钩子 / 后置脚本 / 脚本
 * 节点 / 循环体）就会把仍被引用的脚本当垃圾删掉——P2-6 就这样删过一次用户数据。
 * 从**最终要存进库的节点树**反推，清理清单便不可能与存下来的内容不一致。
 */
function scriptIdsIn(nodes: FlowNode[], into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    for (const assertion of (node.type === "request" || node.type === "database" ? node.assertions ?? [] : [])) {
      if (assertion.script?.scriptId) into.add(assertion.script.scriptId);
    }
    if (node.type === "request") {
      for (const hook of node.preRequestHooks ?? []) if (hook.script?.scriptId) into.add(hook.script.scriptId);
      for (const post of node.responseScripts ?? []) if (post.script?.scriptId) into.add(post.script.scriptId);
    }
    if (node.type === "script" && node.script?.scriptId) into.add(node.script.scriptId);
    if (node.type === "loop") scriptIdsIn(node.body?.nodes ?? [], into);
  }
  return into;
}

export async function persistFlowScripts(
  client: PoolClient,
  projectId: string,
  flowId: string,
  nodes: FlowNode[],
  actorId: string | null = null,
): Promise<FlowNode[]> {
  const owner = { column: "owner_flow_id", id: flowId, label: "flow" } as const;
  /**
   * 一次保存只有**一份** `seen`，也只清理一次。
   *
   * 循环体是内联子图，体内的脚本同样归这个流程所有，所以必须并入同一份 `seen`——
   * 早先的版本让这个函数对循环体递归调用自己，而它末尾会 `collectGarbage`：那次
   * 清理拿着只含体内脚本 id 的 `seen`，把顶层节点引用的脚本全当垃圾删掉了。
   * 因此遍历与清理必须分开：`walk` 只负责持久化并累加 `seen`，清理留到最外层。
   */
  const seen: string[] = [];

  const walk = async (list: FlowNode[]): Promise<FlowNode[]> => {
    const normalized: FlowNode[] = [];
    for (const node of list) {
      /* Script and condition nodes have no response to judge, so they carry no
         assertions or extracts — only request/database nodes do. */
      const assertions = await persistOwnedScripts(client, projectId, owner, node.type === "request" || node.type === "database" ? node.assertions ?? [] : [], actorId, seen, false);
      /* Hooks live in the same table under the same ownership, so they must be
         collected into the same `seen` list — sweeping with only the assertion ids
         would delete every anonymous hook script in the flow. */
      const preRequestHooks = await persistHookRefs(client, projectId, owner, node.type === "request" ? node.preRequestHooks ?? [] : [], seen, actorId);
      const responseScripts = await persistResponseScriptRefs(client, projectId, owner, node.type === "request" ? node.responseScripts ?? [] : [], seen, actorId);
      if (node.type === "script") {
        /* A script node's body is a third kind (计划 5.0.3): it is not judging a
           response nor rewriting a request, so it cannot ride on the assertion or
           hook kind. Same ownership, same follow/copy rules. */
        const script = await persistScriptRef(client, projectId, owner, node.script, "node", seen, actorId);
        normalized.push({ ...node, script });
      } else if (node.type === "request") {
        normalized.push({ ...node, assertions, preRequestHooks, responseScripts });
      } else if (node.type === "database") {
        normalized.push({ ...node, assertions });
      } else if (node.type === "loop") {
        normalized.push({ ...node, body: { edges: node.body?.edges ?? [], nodes: await walk(node.body?.nodes ?? []) } });
      } else {
        normalized.push(node);
      }
    }
    return normalized;
  };

  const normalized = await walk(nodes);
  /* 清理清单 = 遍历累加的 ∪ 最终节点树里实际引用的。取并集而不是只取其一：前者含
     刚创建的匿名脚本，后者是「存下来的东西到底引用了谁」的权威答案，并集只会少删、
     不会多删。 */
  await collectGarbage(client, owner, [...new Set([...seen, ...scriptIdsIn(normalized)])]);
  return normalized;
}

type ScriptOwner = { column: "owner_case_id" | "owner_flow_id"; id: string; label: string };

/**
 * Writes one script reference and returns it holding an id only.
 *
 * Shared by assertions and hooks because the three shapes on the wire
 * (`{content}` new, `{scriptId}` untouched, `{scriptId, content}` edited) and the
 * public-script protection have to behave identically for both — a hook that
 * could rewrite a followed public script while saving a flow would reintroduce
 * exactly the "one save silently changed twenty other things" problem that
 * `PATCH /scripts/:id` exists to prevent.
 */
async function persistScriptRef(
  client: PoolClient,
  projectId: string,
  owner: ScriptOwner,
  ref: ScriptRef,
  kind: "assertion" | "hook" | "response" | "node",
  referenced: string[],
  actorId: string | null,
): Promise<ScriptRef> {
  if (ref.content !== undefined && ref.content.length > MAX_SCRIPT_LENGTH) {
    throw new Error(`a script must be at most ${MAX_SCRIPT_LENGTH} characters`);
  }

  /* New script: anonymous, owned by this host, dies with it. */
  if (!ref.scriptId) {
    if (!ref.content?.trim()) throw new Error("a new script cannot be empty");
    const id = randomUUID();
    await client.query(
      `INSERT INTO scripts (id, project_id, name, language, kind, content, ${owner.column}, created_by)
       VALUES ($1, $2, NULL, 'javascript', $3, $4, $5, $6)`,
      [id, projectId, kind, ref.content, owner.id, actorId],
    );
    await replaceScriptDeps(client, projectId, id, ref.dependencies);
    referenced.push(id);
    return { scriptId: id };
  }

  const existing = await client.query(
    `SELECT id, name, kind, content, ${owner.column} AS owner_id FROM scripts WHERE id = $1 AND project_id = $2`,
    [ref.scriptId, projectId],
  );
  if (!existing.rowCount) throw new Error("referenced script does not exist in this project");
  const row = existing.rows[0];
  const isPublic = row.name !== null;
  const ownedByThisHost = row.owner_id !== null && String(row.owner_id) === owner.id;

  /**
   * A script written for the other slot cannot be used here.
   *
   * An assertion returns a verdict; a hook rewrites the request and its return
   * value is a patch. Swapping them does not throw — the hook would simply never
   * sign anything — so the mismatch is refused where it is still explainable.
   */
  const actualKind = String(row.kind ?? "assertion");
  if (actualKind !== kind) {
    throw new Error(`that script is a ${actualKind} script and cannot be used as a ${kind}`);
  }

  /**
   * 匿名脚本属于**别的**宿主：复制成自己的一份，而不是跟随。
   *
   * 跟随会把两个宿主绑在一条随时消失的行上（它随原宿主一起删），所以这里走
   * 计划 4.0.1 的 copy 支：拿它当前的正文与依赖新建一份归本宿主所有的匿名脚本。
   *
   * 从抛错改成复制，是因为「用例导入成流程节点」必然产生这种引用——用户没做错任何事，
   * 却在保存时被告知「请先存成公共脚本」。导入端（routes/flows.ts 的 node-source）
   * 已经会提前接手，这里是兜底：让导入更早的、已经带着别人 id 的旧节点也能存下去。
   */
  if (!isPublic && !ownedByThisHost) {
    const inherited = await client.query(
      "SELECT depends_on_id FROM script_deps WHERE script_id = $1 ORDER BY position",
      [ref.scriptId],
    );
    const id = randomUUID();
    await client.query(
      `INSERT INTO scripts (id, project_id, name, language, kind, content, ${owner.column}, created_by)
       VALUES ($1, $2, NULL, 'javascript', $3, $4, $5, $6)`,
      [id, projectId, kind, ref.content ?? String(row.content ?? ""), owner.id, actorId],
    );
    await replaceScriptDeps(client, projectId, id, ref.dependencies ?? inherited.rows.map((dep) => String(dep.depends_on_id)));
    referenced.push(id);
    return { scriptId: id };
  }

  if (ref.content !== undefined) {
    if (isPublic) {
      throw new Error("a public script cannot be edited while saving; edit it through the scripts API or detach a copy");
    }
    if (!ref.content.trim()) throw new Error("a script cannot be empty");
    await client.query(
      "UPDATE scripts SET content = $1, updated_by = $4, updated_at = now() WHERE id = $2 AND project_id = $3",
      [ref.content, ref.scriptId, projectId, actorId],
    );
  }
  /* Library declarations are part of the script, so an anonymous script's list
     is rewritten alongside its body. A public script's stays put — same reason
     its content does. */
  if (!isPublic && ref.dependencies !== undefined) {
    await replaceScriptDeps(client, projectId, String(row.id), ref.dependencies);
  }

  referenced.push(String(row.id));
  return { scriptId: String(row.id) };
}

async function persistHookRefs(client: PoolClient, projectId: string, owner: ScriptOwner, hooks: HookConfig[], seen: string[], actorId: string | null): Promise<HookConfig[]> {
  return Promise.all(hooks.map(async (hook) => ({
    ...hook,
    script: hook.script ? await persistScriptRef(client, projectId, owner, hook.script, "hook", seen, actorId) : undefined,
  })));
}

async function persistResponseScriptRefs(client: PoolClient, projectId: string, owner: ScriptOwner, scripts: ResponseScriptConfig[], seen: string[], actorId: string | null): Promise<ResponseScriptConfig[]> {
  return Promise.all(scripts.map(async (config) => ({
    ...config,
    script: config.script ? await persistScriptRef(client, projectId, owner, config.script, "response", seen, actorId) : undefined,
  })));
}

/**
 * Rewrites which libraries a script depends on.
 *
 * Validated here rather than by a constraint because "may only point at a
 * `library`" and "a library may not itself depend on one" are both statements a
 * foreign key cannot make. The second is what keeps composition one level deep,
 * and therefore acyclic without a graph walk.
 */
async function replaceScriptDeps(client: PoolClient, projectId: string, scriptId: string, dependencies: string[] | undefined) {
  if (dependencies === undefined) return;
  const ids = [...new Set(dependencies.filter(Boolean))];
  await client.query("DELETE FROM script_deps WHERE script_id = $1", [scriptId]);
  if (!ids.length) return;

  const libraries = await client.query(
    "SELECT id, kind FROM scripts WHERE id = ANY($1::uuid[]) AND project_id = $2",
    [ids, projectId],
  );
  if (libraries.rowCount !== ids.length) throw new Error("a referenced library does not exist in this project");
  for (const row of libraries.rows) {
    if (String(row.kind) !== "library") throw new Error("only library scripts can be referenced as dependencies");
  }

  const self = await client.query("SELECT kind FROM scripts WHERE id = $1", [scriptId]);
  if (self.rowCount && String(self.rows[0].kind) === "library") {
    throw new Error("a library cannot depend on another library; keep composition one level deep");
  }

  for (const [position, id] of ids.entries()) {
    await client.query(
      "INSERT INTO script_deps (script_id, depends_on_id, position) VALUES ($1, $2, $3)",
      [scriptId, id, position],
    );
  }
}

async function persistOwnedScripts(
  client: PoolClient,
  projectId: string,
  owner: ScriptOwner,
  assertions: Assertion[],
  actorId: string | null,
  collect: string[] = [],
  sweep = true,
): Promise<Assertion[]> {
  const referenced = collect;

  const normalized = await Promise.all(
    assertions.map(async (assertion): Promise<Assertion> => {
      if (assertion.type !== "script") return assertion;
      const ref = assertion.script;
      if (!ref) throw new Error("script assertions require a script reference");
      return { ...assertion, script: await persistScriptRef(client, projectId, owner, ref, "assertion", referenced, actorId) };
    }),
  );

  if (sweep) await collectGarbage(client, owner, referenced);
  return normalized;
}

/**
 * Anonymous scripts this host no longer references are garbage the moment the
 * assertion list is rewritten — nothing else can reach them, since sharing an
 * anonymous script is rejected above. Public scripts are untouched: they belong
 * to the project, not to whoever stopped referencing them.
 */
async function collectGarbage(client: PoolClient, owner: ScriptOwner, referenced: string[]) {
  await client.query(
    `DELETE FROM scripts
      WHERE ${owner.column} = $1 AND name IS NULL AND NOT (id = ANY($2::uuid[]))`,
    [owner.id, referenced],
  );
}

/**
 * Loads script bodies plus the sources of every library they declare.
 *
 * Two queries rather than a recursive CTE: dependencies are one level deep by
 * design (a library may not itself declare libraries — see `validateScriptDeps`),
 * so the closure is exactly "the scripts" and "their libraries". Keeping it flat
 * is what makes composition order predictable, and a cycle impossible.
 */
async function loadScriptSources(projectId: string, ids: string[]) {
  const bodies = new Map<string, string>();
  const libraries = new Map<string, string[]>();
  if (!ids.length) return { bodies, libraries };

  const scripts = await pool.query(
    "SELECT id, content FROM scripts WHERE id = ANY($1::uuid[]) AND project_id = $2",
    [ids, projectId],
  );
  for (const row of scripts.rows) bodies.set(String(row.id), String(row.content));

  /* Ordered by `position` so multiple libraries concatenate the same way every
     run; an unstable order shows up as "sometimes undefined" at call time. */
  const deps = await pool.query(
    `SELECT d.script_id, s.content
       FROM script_deps d
       JOIN scripts s ON s.id = d.depends_on_id
      WHERE d.script_id = ANY($1::uuid[]) AND s.project_id = $2
      ORDER BY d.script_id, d.position`,
    [ids, projectId],
  );
  for (const row of deps.rows) {
    const key = String(row.script_id);
    libraries.set(key, [...(libraries.get(key) ?? []), String(row.content)]);
  }
  return { bodies, libraries };
}

/**
 * 把一个脚本引用「接手」到另一个宿主（计划 4.0.1 的 follow / copy）。
 *
 * 用例导入成流程节点时，节点带过来的引用属于**那个用例**。两种处理，取决于脚本是不是
 * 公共的：
 *
 * - **公共脚本（有名字）跟随**：保留 `scriptId`。一份定义多处引用正是它存在的意义，
 *   改一处所有引用都该跟着变。
 * - **匿名脚本复制正文**：它属于原宿主、随原宿主一起被删。跨宿主跟随会把两者绑在一条
 *   随时消失的行上，所以这里丢掉 `scriptId`、只带 `content` 和依赖——新宿主保存时会
 *   建自己的那一份（`persistScriptRef` 见到没有 id 的引用就新建）。
 *
 * 不这么做的后果就是保存时报「referenced script belongs to another case」：导入看着
 * 成功了，保存却过不去，而用户并没有做错任何事。
 */
export async function adoptScriptRef(projectId: string, ref: ScriptRef | undefined): Promise<ScriptRef | undefined> {
  if (!ref?.scriptId) return ref;
  const found = await pool.query(
    "SELECT name, content FROM scripts WHERE id = $1 AND project_id = $2",
    [ref.scriptId, projectId],
  );
  /* 引用已经悬空：原样返回，让保存时给出「脚本不存在」这个更准确的错误。 */
  if (!found.rowCount) return ref;
  if (found.rows[0].name !== null) return ref;

  /* 依赖存在 script_deps 里而不在引用上，复制时要一起带走，否则副本少了它的脚本库。 */
  const deps = await pool.query(
    "SELECT depends_on_id FROM script_deps WHERE script_id = $1 ORDER BY position",
    [ref.scriptId],
  );
  return {
    content: String(found.rows[0].content ?? ""),
    dependencies: deps.rows.map((row) => String(row.depends_on_id)),
  };
}

/** 一组引用的接手，保持顺序。 */
export async function adoptScriptRefs<T extends { script?: ScriptRef }>(projectId: string, items: T[] | undefined): Promise<T[]> {
  return Promise.all((items ?? []).map(async (item) => (item.script ? { ...item, script: await adoptScriptRef(projectId, item.script) } : item)));
}

/** Loads an override dependency list from the request being enqueued. */
async function loadLibraryBodies(projectId: string, ids: string[] | undefined): Promise<string[] | undefined> {
  if (ids === undefined) return undefined;
  if (!ids.length) return [];
  const unique = [...new Set(ids)];
  const result = await pool.query(
    `SELECT id, content FROM scripts
      WHERE id = ANY($1::uuid[]) AND project_id = $2 AND kind = 'library'
      ORDER BY array_position($1::uuid[], id)`,
    [unique, projectId],
  );
  if (result.rowCount !== unique.length) throw new Error("a referenced library does not exist in this project");
  return result.rows.map((row) => String(row.content));
}

/**
 * Replaces every `scriptId` with its content, for the run definition.
 *
 * `run_spec` is a self-contained snapshot: a worker reads one row and never
 * touches the scripts table. Resolving here rather than at execution time is
 * what makes a run reproducible — a followed public script edited between
 * enqueue and execution must not change what already went into the queue, and
 * the recorded result must describe the code that actually ran.
 *
 * `run_spec` is set to NULL on the terminal write, so the inlined body does not
 * linger.
 */
export async function inlineScriptContent(projectId: string, assertions: Assertion[]): Promise<Assertion[]> {
  const ids = scriptAssertions(assertions)
    .map((assertion) => assertion.script?.scriptId)
    .filter((id): id is string => Boolean(id));

  const { bodies, libraries } = await loadScriptSources(projectId, ids);

  return Promise.all(assertions.map(async (assertion) => {
    if (assertion.type !== "script") return assertion;
    if (!assertion.script) return assertion;
    const scriptId = assertion.script?.scriptId;
    /* An unsaved try-run supplies content directly and has no id to resolve. */
    if (!scriptId) return { ...assertion, script: { ...assertion.script, libraries: await loadLibraryBodies(projectId, assertion.script.dependencies) } };
    /**
     * If the caller already provided content alongside the id, keep it rather
     * than overwriting it with the database copy. This is what makes an execute
     * override with an edited-but-unsaved script body run the edited version
     * instead of the persisted one (交互文档 3.1.3 edited-but-unsaved semantics).
     */
    const content = assertion.script?.content ?? bodies.get(scriptId);
    /* A deleted script leaves content absent on purpose: the evaluator reports
       "script content is missing" instead of quietly passing. */
    return { ...assertion, script: { scriptId, content, libraries: await loadLibraryBodies(projectId, assertion.script?.dependencies) ?? libraries.get(scriptId) ?? [] } };
  }));
}

/**
 * The same inlining for 前置钩子 (P1-2).
 *
 * A hook carries the identical risk an assertion does: if the worker resolved
 * the script at execution time, editing a shared signing script would silently
 * change what an already-queued run signs with, and the recorded result would
 * describe code that never ran.
 */
export async function inlineHookContent(projectId: string, hooks: HookConfig[] | undefined): Promise<HookConfig[]> {
  if (!hooks?.length) return [];
  const ids = hooks
    .map((hook) => hook.script?.scriptId)
    .filter((id): id is string => Boolean(id));

  const { bodies, libraries } = await loadScriptSources(projectId, ids);

  return Promise.all(hooks.map(async (hook) => {
    const scriptId = hook.script?.scriptId;
    if (!scriptId) return { ...hook, script: hook.script ? { ...hook.script, libraries: await loadLibraryBodies(projectId, hook.script.dependencies) } : undefined };
    const content = hook.script?.content ?? bodies.get(scriptId);
    return { ...hook, script: { scriptId, content, libraries: await loadLibraryBodies(projectId, hook.script?.dependencies) ?? libraries.get(scriptId) ?? [] } };
  }));
}

/** Response-script bodies are frozen into run_spec at enqueue time. */
export async function inlineResponseScriptContent(projectId: string, scripts: ResponseScriptConfig[] | undefined): Promise<ResponseScriptConfig[]> {
  if (!scripts?.length) return [];
  const ids = scripts.map((config) => config.script?.scriptId).filter((id): id is string => Boolean(id));
  const { bodies, libraries } = await loadScriptSources(projectId, ids);
  return Promise.all(scripts.map(async (config) => {
    const scriptId = config.script?.scriptId;
    if (!scriptId) return { ...config, script: config.script ? { ...config.script, libraries: await loadLibraryBodies(projectId, config.script.dependencies) } : undefined };
    return {
      ...config,
      script: {
        scriptId,
        content: config.script?.content ?? bodies.get(scriptId),
        libraries: await loadLibraryBodies(projectId, config.script?.dependencies) ?? libraries.get(scriptId) ?? [],
      },
    };
  }));
}

/**
 * The same inlining for a 脚本节点's body (P2-2).
 *
 * The script node runs a computation over the variable bag; it carries the same
 * reproducibility requirement as an assertion or a hook — an edited shared
 * script must not change an already-queued run — so the worker receives the
 * body inlined into `run_spec`, never a read of the scripts table.
 */
export async function inlineScriptNode(projectId: string, script: ScriptRef | undefined): Promise<ScriptRef | undefined> {
  if (!script?.scriptId) return script ? { ...script, libraries: await loadLibraryBodies(projectId, script.dependencies) } : script;
  const { bodies, libraries } = await loadScriptSources(projectId, [script.scriptId]);
  return { scriptId: script.scriptId, content: script.content ?? bodies.get(script.scriptId), libraries: await loadLibraryBodies(projectId, script.dependencies) ?? libraries.get(script.scriptId) ?? [] };
}

/**
 * Every script a list of flow nodes carries, inlined in one pass.
 *
 * Extracted from `enqueueFlowRun` when 子流程 / 循环 arrived (P2-6): a referenced
 * inner flow has to be frozen with its scripts already resolved, exactly like the
 * outer one. Two copies of "which slots on which node kind hold a script" would
 * eventually disagree, and the symptom would be a subflow whose signing hook
 * silently ran the wrong version.
 */
export async function inlineFlowNodeScripts(projectId: string, nodes: FlowNode[]): Promise<FlowNode[]> {
  return Promise.all(nodes.map(async (node): Promise<FlowNode> => {
    if (node.type === "request") return {
      ...node,
      assertions: await inlineScriptContent(projectId, node.assertions ?? []),
      preRequestHooks: await inlineHookContent(projectId, node.preRequestHooks),
      responseScripts: await inlineResponseScriptContent(projectId, node.responseScripts),
    };
    if (node.type === "script") return { ...node, script: (await inlineScriptNode(projectId, node.script))! };
    if (node.type === "database") return { ...node, assertions: await inlineScriptContent(projectId, node.assertions ?? []) };
    /* 循环体是内联子图：体内的请求/SQL/脚本同样要内联。子流程的内层图由
       lib/flowRefs.ts 加载时处理。 */
    if (node.type === "loop") return { ...node, body: { ...node.body, nodes: await inlineFlowNodeScripts(projectId, node.body?.nodes ?? []) } };
    return node;
  }));
}

/**
 * Everything that follows a public script.
 *
 * Uses jsonb containment against the assertions array, which the GIN indexes in
 * migrations 011 and 012 serve. Public scripts are the only shareable kind, so
 * these scans are the complete reference set for one — and all of them must be
 * here, because a删除确认 that only counted cases would under-report the blast
 * radius and let a delete break a flow silently.
 *
 * Since P1-2 that includes 前置钩子 and library references: deleting a signing
 * library that three flows depend on has to say so before it happens, not after
 * three flows stop signing.
 */
export async function scriptUsage(projectId: string, scriptId: string) {
  const reference = JSON.stringify([{ script: { scriptId } }]);
  const [cases, hookCases, responseCases, flows, responseFlows, hookFlows, nodeFlows, dependents] = await Promise.all([
    pool.query(
      `SELECT id, name FROM test_cases
        WHERE project_id = $1 AND assertions @> $2::jsonb
        ORDER BY name`,
      [projectId, reference],
    ),
    /* 节点断言嵌在 nodes[].assertions 里，所以 containment 的形状要包一层节点。 */
    pool.query(
      `SELECT id, name FROM test_cases
        WHERE project_id = $1 AND pre_request_hooks @> $2::jsonb
        ORDER BY name`,
      [projectId, reference],
    ),
    pool.query(
      `SELECT id, name FROM test_cases
        WHERE project_id = $1 AND response_scripts @> $2::jsonb
        ORDER BY name`,
      [projectId, reference],
    ),
    pool.query(
      `SELECT id, name FROM flows
        WHERE project_id = $1 AND nodes @> $2::jsonb
        ORDER BY name`,
      [projectId, JSON.stringify([{ assertions: [{ script: { scriptId } }] }])],
    ),
    pool.query(
      `SELECT id, name FROM flows
        WHERE project_id = $1 AND nodes @> $2::jsonb
        ORDER BY name`,
      [projectId, JSON.stringify([{ responseScripts: [{ script: { scriptId } }] }])],
    ),
    pool.query(
      `SELECT id, name FROM flows
        WHERE project_id = $1 AND nodes @> $2::jsonb
        ORDER BY name`,
      [projectId, JSON.stringify([{ preRequestHooks: [{ script: { scriptId } }] }])],
    ),
    /* 脚本节点的引用在 nodes[].script 上，形状与断言/钩子都不一样（P2-2）。 */
    pool.query(
      `SELECT id, name FROM flows
        WHERE project_id = $1 AND nodes @> $2::jsonb
        ORDER BY name`,
      [projectId, JSON.stringify([{ type: "script", script: { scriptId } }])],
    ),
    /* Library references are a real table, so this one is a plain join. */
    pool.query(
      `SELECT s.id, s.name FROM script_deps d
         JOIN scripts s ON s.id = d.script_id
        WHERE d.depends_on_id = $1 AND s.project_id = $2 AND s.name IS NOT NULL
        ORDER BY s.name`,
      [scriptId, projectId],
    ),
  ]);

  /* A flow can reference the same script from an assertion, a hook and a script
     node; it is one thing to warn about, not three. */
  const flowRows = new Map<string, string>();
  for (const row of [...flows.rows, ...hookFlows.rows, ...responseFlows.rows, ...nodeFlows.rows]) flowRows.set(String(row.id), String(row.name));
  const caseRows = new Map<string, string>();
  for (const row of [...cases.rows, ...hookCases.rows, ...responseCases.rows]) caseRows.set(String(row.id), String(row.name));

  return [
    ...[...caseRows].map(([id, name]) => ({ id, name, kind: "case" as const })),
    ...[...flowRows].map(([id, name]) => ({ id, name, kind: "flow" as const })),
    ...dependents.rows.map((row) => ({ id: String(row.id), name: String(row.name), kind: "script" as const })),
  ];
}
