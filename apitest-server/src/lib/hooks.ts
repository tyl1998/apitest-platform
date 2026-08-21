import { runScriptHook, type HookRequest, type ScriptCheck, type ScriptDebugEntry, type SecretResolver } from "./sandbox.js";
import type { HookConfig, HookResult } from "../models/types.js";

/**
 * 前置钩子 (P1-2)：在变量已展开、请求还没发出的那一刻改写请求。
 *
 * ## 为什么必须是这个时刻
 *
 * 请求签名要签**最终字节**。早一步签的是还带 `{{token}}` 的模板，晚一步签名已经
 * 没有位置放进 header。所以钩子的输入是 `buildRequest` 的产物（变量已解析、auth
 * 已注入、URL 已拼好），输出是即将交给 `fetch` 的同一个结构。
 *
 * ## 为什么是一层接口而不是直接调沙箱
 *
 * 签名算法千奇百怪，但「在发出前改写请求」这件事只有一种形状：
 * `(request, variables) => patch`。把它定成接口，脚本只是第一个实现；将来接
 * 「调用公司签名服务」的 webhook provider、或内置几个常见签名算法，都只是往
 * `PROVIDERS` 里加一个键，`run.ts` 一行不用改。
 *
 * 反过来，如果让 `run.ts` 直接调 `runScriptHook`，第二种签名方式来的时候就得在
 * 执行主链路上加分支——那条链路是取消、认领、快照、断言判定共用的，改动风险最高。
 *
 * ## 失败不静默放行
 *
 * 钩子失败（脚本报错、超时、返回了不能用的东西）时**不发请求**，整条执行判失败。
 * 放行一个没签名的请求只会从被测服务拿回一个 401，而真正的错误在脚本里——用户
 * 会先去查服务端，查半天才回到脚本。
 */

/**
 * What a provider needs beyond the request.
 *
 * `libraries` is filled in per hook by `applyPreRequestHooks` from that hook's
 * own inlined sources, so callers do not supply it — a single list at the call
 * site would be wrong the moment two hooks followed different libraries.
 */
export type HookContext = {
  variables: Record<string, unknown>;
  /** Resolves `{ secret: "NAME" }` key material host-side. */
  resolveSecret: SecretResolver;
  /** Library sources, already inlined into the config at enqueue time. */
  libraries: string[];
};

/** What the caller provides; the per-hook parts are added while iterating. */
export type HookInput = Omit<HookContext, "libraries">;

/** What a provider gives back. `ok: false` aborts the request. */
export type ProviderOutcome = {
  ok: boolean;
  error?: string;
  logs: string[];
  debug: ScriptDebugEntry[];
  /** `ctx.assert(...)` calls the hook made, in order. */
  checks: ScriptCheck[];
  request?: HookRequest;
  variables: Record<string, string>;
};

/**
 * The seam. One function per hook kind.
 *
 * Async even though the script provider is synchronous: a webhook provider is
 * the obvious second implementation, and making callers `await` from the start
 * means adding it never touches the execution path.
 */
export type HookProvider = (config: HookConfig, request: HookRequest, context: HookContext) => Promise<ProviderOutcome>;

const scriptProvider: HookProvider = async (config, request, context) => {
  const source = config.script?.content;
  /* A missing body means the script row was deleted after this run was queued.
     Reported rather than skipped: skipping would send an unsigned request. */
  if (!source) {
    return { ok: false, error: "hook script content is missing", logs: [], debug: [], checks: [], variables: {} };
  }
  const outcome = runScriptHook(source, request, {
    variables: context.variables,
    libraries: context.libraries,
    resolveSecret: context.resolveSecret,
  });
  return {
    ok: outcome.ok, error: outcome.error, logs: outcome.logs,
    debug: outcome.debug, checks: outcome.checks, request: outcome.request, variables: outcome.variables,
  };
};

const PROVIDERS: Record<HookConfig["type"], HookProvider> = {
  script: scriptProvider,
};

/** Which parts of the request a hook actually rewrote, for the snapshot. */
function changedParts(before: HookRequest, after: HookRequest): string[] {
  const changed: string[] = [];
  if (before.method !== after.method) changed.push("method");
  if (before.url !== after.url) changed.push("url");
  if (JSON.stringify(before.headers) !== JSON.stringify(after.headers)) changed.push("headers");
  if (JSON.stringify(before.query) !== JSON.stringify(after.query)) changed.push("query");
  if (before.bodyText !== after.bodyText || JSON.stringify(before.body) !== JSON.stringify(after.body)) changed.push("body");
  return changed;
}

/**
 * Reconciles the two ways a hook can express a body change.
 *
 * `bodyText` is what actually goes on the wire; `body` is the parsed convenience
 * view. Mutating the view is the natural idiom (`ctx.request.body.amount = 1`),
 * so it has to take effect — but a hook that deliberately hand-builds the exact
 * string it signed must win over re-serialization, because `JSON.stringify` of
 * an equivalent object can differ byte-for-byte from what was signed, and then
 * the signature is right about a body that was never sent.
 */
function reconcileBody(original: HookRequest, next: HookRequest): HookRequest {
  const textChanged = next.bodyText !== original.bodyText;
  if (textChanged) return next;
  const bodyChanged = JSON.stringify(next.body) !== JSON.stringify(original.body);
  if (bodyChanged) return { ...next, bodyText: next.body === undefined ? undefined : JSON.stringify(next.body) };
  return next;
}

/**
 * Runs every enabled hook in order, threading the request through.
 *
 * Sequential by design: hook two may sign what hook one assembled, and a
 * parallel apply would make the outcome depend on the order two patches happened
 * to merge in.
 */
export async function applyPreRequestHooks(
  hooks: HookConfig[] | undefined,
  request: HookRequest,
  context: HookInput,
): Promise<{ request: HookRequest; results: HookResult[]; variables: Record<string, string>; failed?: HookResult }> {
  const results: HookResult[] = [];
  const written: Record<string, string> = {};
  let current = request;

  for (const [index, config] of (hooks ?? []).entries()) {
    if (config.enabled === false) continue;
    const name = config.name?.trim() || `hook ${index + 1}`;
    const provider = PROVIDERS[config.type];
    if (!provider) {
      const result: HookResult = { name, type: String(config.type), ok: false, error: `unknown hook type "${config.type}"`, logs: [], debug: [], changed: [] };
      results.push(result);
      return { request: current, results, variables: written, failed: result };
    }

    const before = current;
    const outcome = await provider(config, { ...before, headers: { ...before.headers }, query: { ...before.query } }, {
      ...context,
      /* Each hook sees what the previous one produced, plus what they wrote. */
      variables: { ...context.variables, ...written },
      libraries: config.script?.libraries ?? [],
    });

    Object.assign(written, outcome.variables);
    const next = outcome.ok && outcome.request ? reconcileBody(before, outcome.request) : before;
    const result: HookResult = {
      name, type: config.type, ok: outcome.ok, error: outcome.error,
      logs: outcome.logs, debug: outcome.debug,
      changed: outcome.ok ? changedParts(before, next) : [],
    };
    results.push(result);
    if (!outcome.ok) return { request: before, results, variables: written, failed: result };
    current = next;
  }

  return { request: current, results, variables: written };
}
