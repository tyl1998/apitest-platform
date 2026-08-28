import { pool } from "../db.js";
import { evaluateAssertions } from "./assert.js";
import { publishEvent } from "./events.js";
import { applyExtracts } from "./flow.js";
import { applyPreRequestHooks } from "./hooks.js";
import { applyResponseScripts } from "./responseScripts.js";
import type { HookRequest } from "./sandbox.js";
import { resolveDeep, resolveVariables } from "./resolve.js";
import { sanitizeHeaders, sanitizeValue } from "./sanitize.js";
import type { Assertion, AssertionResult, FlowExtract, FlowExtractResult, HookConfig, HookResult, RequestSnapshot, ResponseScriptConfig, ResponseScriptResult } from "../models/types.js";

/* Re-exported so existing importers keep working; defined in http.ts to keep
   run.ts ⇄ flow.ts from forming a cycle. */
export { BODY_TYPES, METHODS } from "./http.js";

const REQUEST_TIMEOUT_MS = 30_000;
/** Responses are kept for reading, not archiving, so the tail is dropped. */
const RESPONSE_LIMIT = 10_000;

/**
 * 写一个头，同名（大小写不敏感）只留一份。
 *
 * 已存在异体大小写的同名键时删旧建新：胜出者的拼写就是出现在快照里的拼写。
 */
function setHeader(headers: Record<string, string>, name: string, value: string) {
  const previous = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (previous !== undefined && previous !== name) delete headers[previous];
  headers[name] = value;
}

/** 头名不区分大小写地查一次（Content-Type 默认值的注入用它判断）。 */
function hasHeader(headers: Record<string, string>, name: string) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

/**
 * Applies path params, query params and auth on top of the stored URL.
 *
 * `defaultHeaders`（P3-2，计划 6.5 流量泳道第一层）是环境默认头，垫在**最低优先级**：
 * 接口/用例自己写了同名头就以接口为准（大小写不敏感比对——两份 content-type 同时
 * 出现在快照里比被覆盖更糟），auth 注入在其上，前置钩子仍在最后改写。值可引用
 * `{{变量}}`（如 `{"X-Env-Tag": "{{lane}}"}`），泳道值由触发时的变量覆盖决定。
 */
export function buildRequest(request: RequestSnapshot, variables: Record<string, string>, defaultHeaders?: Record<string, string>) {
  let rawUrl = resolveVariables(request.url, variables);

  /* :name and {name} placeholders both appear in imported definitions. */
  for (const [key, value] of Object.entries(request.pathParams)) {
    const resolved = resolveVariables(value, variables);
    rawUrl = rawUrl.replaceAll(`:${key}`, encodeURIComponent(resolved)).replaceAll(`{${key}}`, encodeURIComponent(resolved));
  }

  const url = new URL(rawUrl);
  for (const [key, value] of Object.entries(request.queryParams)) {
    url.searchParams.set(key, resolveVariables(value, variables));
  }

  const headers: Record<string, string> = {};
  /* 默认头先垫底（值走同一套变量解析，覆盖层在这里生效），再用接口定义的头盖上去。 */
  for (const [key, value] of Object.entries(defaultHeaders ?? {})) {
    if (!key.trim()) continue;
    setHeader(headers, key, resolveVariables(value, variables));
  }
  for (const [key, value] of Object.entries(request.headers)) {
    setHeader(headers, key, resolveVariables(value, variables));
  }

  const auth = request.auth;
  if (auth.type === "bearer") setHeader(headers, "Authorization", `Bearer ${resolveVariables(auth.token, variables)}`);
  else if (auth.type === "basic") setHeader(headers, "Authorization", `Basic ${Buffer.from(`${resolveVariables(auth.username, variables)}:${resolveVariables(auth.password, variables)}`).toString("base64")}`);
  else if (auth.type === "apiKey") {
    const value = resolveVariables(auth.value, variables);
    if (auth.in === "header") setHeader(headers, auth.key, value);
    else url.searchParams.set(auth.key, value);
  }

  let body: BodyInit | undefined;
  let bodySnapshot: unknown;
  if (!["GET", "HEAD"].includes(request.method)) {
    if (request.bodyType === "json" && request.body !== undefined) {
      bodySnapshot = resolveDeep(request.body, variables);
      body = JSON.stringify(bodySnapshot);
      if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
    } else if (request.bodyType === "form" && request.bodyText) {
      bodySnapshot = resolveVariables(request.bodyText, variables);
      body = bodySnapshot as string;
      if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (request.bodyType === "text" && request.bodyText) {
      bodySnapshot = resolveVariables(request.bodyText, variables);
      body = bodySnapshot as string;
      if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "text/plain";
    }
  }

  return { url: url.toString(), query: Object.fromEntries(url.searchParams.entries()), headers, body, bodySnapshot };
}

export type LoadedEnvironment = {
  id?: string;
  name?: string;
  /** Variables and secrets merged; secrets win, so a secret cannot be shadowed. */
  variables: Record<string, string>;
  /**
   * 环境默认头（P3-2，计划 6.5）：buildRequest 里以最低优先级合并。没有环境时为空
   * ——默认头是环境的属性，「不用环境」的执行自然一头不带。
   */
  defaultHeaders: Record<string, string>;
  /** Plaintext secret values, used only to mask them out of the snapshot. */
  secretValues: string[];
  /** Project opt-in: store execution evidence unmasked (Spec 4.6 放宽). */
  storePlaintext: boolean;
};

export async function loadEnvironment(projectId: string, environmentId: string | undefined): Promise<LoadedEnvironment> {
  if (!environmentId) {
    /* The plaintext flag is project-scoped, so a run without an environment must
       still read it — otherwise the toggle silently stays masked for such runs. */
    const setting = await pool.query("SELECT store_plaintext FROM project_settings WHERE project_id = $1", [projectId]);
    return { variables: {}, defaultHeaders: {}, secretValues: [], storePlaintext: Boolean(setting.rows[0]?.store_plaintext) };
  }
  const result = await pool.query(
    `SELECT e.*, ps.store_plaintext FROM environments e
     LEFT JOIN project_settings ps ON ps.project_id = e.project_id
     WHERE e.id = $1 AND e.project_id = $2`,
    [environmentId, projectId],
  );
  if (!result.rowCount) throw new Error("environment must belong to the project");
  const row = result.rows[0];
  return {
    id: environmentId,
    name: String(row.name),
    variables: { ...((row.variables ?? {}) as Record<string, string>), ...((row.secrets ?? {}) as Record<string, string>) },
    defaultHeaders: (row.default_headers ?? {}) as Record<string, string>,
    secretValues: Object.values((row.secrets ?? {}) as Record<string, string>),
    storePlaintext: Boolean(row.store_plaintext),
  };
}

/**
 * What a queued execution still needs in order to run (P1-3).
 *
 * Stored on the row rather than in the job payload so the queue carries no
 * request bodies or credentials, and so an edited-but-unsaved case run — which
 * exists nowhere else — survives until a worker picks it up.
 */
export type RunSpec = {
  request: RequestSnapshot;
  environmentId?: string;
  assertions: Assertion[];
  /** Layered over the environment, highest priority. Set by a flow单步调试. */
  variables?: Record<string, string>;
  /**
   * Flow extracts, evaluated so a单步调试 reports whether each value would be
   * captured. A step that "passes" while silently extracting nothing is exactly
   * the failure single-step debugging exists to catch.
   */
  extracts?: FlowExtract[];
  /**
   * 前置钩子, with library sources already inlined at enqueue time (same reason
   * assertion scripts are inlined: whoever edits a shared script after this run
   * was queued must not change what this run executes).
   */
  hooks?: HookConfig[];
  /** Post-response scripts, with bodies and libraries already inlined. */
  responseScripts?: ResponseScriptConfig[];
};

/** Everything one request produced, before anyone decides where to store it. */
export type RunOutcome = {
  status: "success" | "failed";
  statusCode?: number;
  durationMs: number;
  error?: string;
  request: unknown;
  responseHeaders: Record<string, string>;
  responseContentType?: string;
  responseSizeBytes: number;
  responseTruncated: boolean;
  /** Masked, i.e. what gets stored and shown. */
  responseBody?: string;
  /**
   * Unmasked, truncated body. Never stored — it exists so a flow can extract a
   * chained value out of it. Masking would replace a token that happens to equal
   * an environment secret, and the next step would then send the mask.
   */
  rawBody?: string;
  assertionResults: AssertionResult[];
  /** Per-extract outcomes, empty when the node declares none. */
  extractResults: FlowExtractResult[];
  /** Per-hook outcomes, in order. Empty when the request has no hooks. */
  hookResults: HookResult[];
  responseScriptResults: ResponseScriptResult[];
  /** Raw node-local writes for evidence and same-node processing. */
  temporaryVariables: Record<string, string>;
  /** Empty on failure; the only variable channel a Flow may merge downstream. */
  committedVariables: Record<string, string>;
};

/**
 * Sends one request and judges it.
 *
 * Extracted so接口调试、用例执行 and 流程节点 cannot drift: transport, timeout,
 * truncation, masking and the assertion verdict are decided in exactly one
 * place, and a caller only chooses what to record and where.
 */
export async function executeRequest(options: {
  request: RequestSnapshot;
  assertions: Assertion[];
  /** Evaluated after the assertions, against the unmasked body. */
  extracts?: FlowExtract[];
  /** Applied after the request is built, before it is sent. */
  hooks?: HookConfig[];
  /** Runs after simple extracts and before declarative assertions. */
  responseScripts?: ResponseScriptConfig[];
  /**
   * Resolved inside the timer, and inside the try, so an environment that no
   * longer belongs to the project is recorded as a failed run rather than
   * thrown at whoever called this.
   */
  environment: () => Promise<LoadedEnvironment>;
  signal: AbortSignal;
  /** Shown if the request could not be built at all. */
  snapshot: unknown;
}): Promise<RunOutcome> {
  const outcome: RunOutcome = {
    status: "failed", durationMs: 0, request: options.snapshot,
    responseHeaders: {}, responseSizeBytes: 0, responseTruncated: false,
    assertionResults: [], extractResults: [], hookResults: [], responseScriptResults: [], temporaryVariables: {}, committedVariables: {},
  };

  const startedAt = performance.now();
  let responseOk = false;
  try {
    const environment = await options.environment();
    const prepared = buildRequest(options.request, environment.variables, environment.defaultHeaders);

    /**
     * A project that opted into plaintext records skips masking entirely, so
     * internal debugging can read the exact credentials that went out. The
     * header-name and secret-value masking above is the default, and the only
     * thing that keeps environment secrets out of execution records.
     */
    const maskHeaders = (headers: Record<string, string>) =>
      environment.storePlaintext ? headers : sanitizeHeaders(headers, environment.secretValues);
    const maskValue = (value: unknown) =>
      environment.storePlaintext ? value : sanitizeValue(value, environment.secretValues);

    /**
     * 前置钩子 run here: variables are resolved and auth is injected, but nothing
     * has been sent. A signature computed before this point signs a template;
     * after it, there is no longer a header to put the signature in.
     */
    let sent: HookRequest = {
      method: options.request.method,
      url: prepared.url,
      headers: prepared.headers,
      query: prepared.query,
      body: options.request.bodyType === "json" ? prepared.bodySnapshot : undefined,
      bodyText: typeof prepared.body === "string" ? prepared.body : undefined,
    };
    if (options.hooks?.length) {
      const applied = await applyPreRequestHooks(options.hooks, sent, {
        variables: environment.variables,
        /* Key material stays host-side: the sandbox receives a name, never the
           secret, so a script cannot read a key it was not handed. */
        resolveSecret: (name) => environment.variables[name],
      });
      outcome.hookResults = applied.results;
      Object.assign(outcome.temporaryVariables, applied.variables);
      if (applied.failed) {
        /* Aborting rather than sending unsigned: a 401 from the target would send
           the user debugging the wrong system. */
        outcome.error = `pre-request hook "${applied.failed.name}" failed: ${applied.failed.error ?? "unknown error"}`;
        outcome.request = {
          method: sent.method, url: sent.url, query: sent.query,
          headers: maskHeaders(sent.headers),
          body: maskValue(prepared.bodySnapshot),
        };
        outcome.durationMs = Math.round(performance.now() - startedAt);
        return outcome;
      }
      sent = applied.request;
    }

    /* Snapshotted after the hooks so the record shows what actually went out,
       signature header included. Debugging a signature against a snapshot that
       predates it is the whole problem this feature exists to solve. */
    outcome.request = {
      method: sent.method,
      url: sent.url,
      query: sent.query,
      headers: maskHeaders(sent.headers),
      body: maskValue(sent.body ?? sent.bodyText ?? prepared.bodySnapshot),
    };

    /**
     * Two ways to stop: the 30s cap and a user cancel. `AbortSignal.any` keeps
     * both on one signal so the transport does not need to know which fired.
     */
    const response = await fetch(sent.url, {
      method: sent.method,
      headers: sent.headers,
      body: sent.bodyText ?? prepared.body,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    responseOk = response.ok;
    outcome.statusCode = response.status;
    const rawResponseHeaders = Object.fromEntries(response.headers.entries());
    outcome.responseHeaders = maskHeaders(rawResponseHeaders);
    outcome.responseContentType = response.headers.get("content-type") ?? undefined;
    const responseText = await response.text();
    outcome.responseSizeBytes = Buffer.byteLength(responseText);
    outcome.responseTruncated = responseText.length > RESPONSE_LIMIT;
    outcome.rawBody = responseText.slice(0, RESPONSE_LIMIT);
    outcome.responseBody = maskValue(outcome.rawBody) as string;

    if (options.extracts?.length) {
      /**
       * Extracts read the **unmasked** body, unlike assertions.
       *
       * Masking exists for storage and display; if a token happens to equal an
       * environment secret, extracting the masked copy would chain a row of
       * asterisks into the next step.
       */
      const extracted = applyExtracts(options.extracts, {
        statusCode: outcome.statusCode,
        headers: rawResponseHeaders,
        body: outcome.rawBody,
      });
      Object.assign(outcome.temporaryVariables, extracted.values);
      /* Values are masked on the way into the record even though extraction read
         the raw body — the next step gets the real value, the stored evidence
         does not. */
      outcome.extractResults = extracted.results.map((result) => (result.value === undefined
        ? result
        : { ...result, value: String(maskValue(result.value)) }));
      if (outcome.extractResults.some((result) => !result.ok)) outcome.error = "one or more extracts failed";
    }

    if (options.responseScripts?.length && !outcome.error) {
      const applied = applyResponseScripts(options.responseScripts, {
        statusCode: outcome.statusCode,
        headers: rawResponseHeaders,
        body: outcome.rawBody,
      }, {
        variables: { ...environment.variables, ...outcome.temporaryVariables },
        resolveSecret: (name) => environment.variables[name],
        /* An empty list disables masking when the project stores plaintext. */
        secretValues: environment.storePlaintext ? [] : environment.secretValues,
      });
      outcome.responseScriptResults = applied.results;
      Object.assign(outcome.temporaryVariables, applied.variables);
      if (applied.failed) outcome.error = `response script "${applied.failed.name}" failed: ${applied.failed.error ?? "one or more checks failed"}`;
    }

    if (!outcome.error && options.assertions.length) {
      /* Declarative checks intentionally run last. They see the same response
         evidence the user sees, and no custom script lives in this phase. */
      const evaluated = evaluateAssertions(options.assertions, {
        statusCode: outcome.statusCode,
        headers: outcome.responseHeaders,
        body: outcome.responseBody,
      });
      outcome.assertionResults = evaluated.results;
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : "request failed";
  }
  outcome.durationMs = Math.round(performance.now() - startedAt);

  /**
   * A case asserting `$.status = 404` must pass on a 404, so once assertions
   * exist they alone decide the verdict. Without them the run falls back to the
   * transport result, which is what a debug send means.
   *
   * A failed extract fails the step regardless: the request may have been fine,
   * but the value the rest of the flow depends on is not there, and the honest
   * place to report that is the step that was supposed to produce it.
   */
  const extractsFailed = outcome.extractResults.some((result) => !result.ok);
  outcome.status = outcome.error || extractsFailed
    ? "failed"
    : outcome.assertionResults.length
      ? outcome.assertionResults.every((each) => each.passed) ? "success" : "failed"
      : responseOk ? "success" : "failed";

  /* The request node is the transaction boundary. No pre/post-processing write
     leaves it unless transport, post-processing, and declarative checks pass. */
  if (outcome.status === "success") outcome.committedVariables = { ...outcome.temporaryVariables };

  return outcome;
}

/**
 * Runs one queued execution to a terminal state.
 *
 * Shared by接口调试 and 用例执行 so the two cannot drift: a case must run
 * through the same transport, masking and history rules as a debug send, and
 * only differ in which definition it carries and whether assertions apply.
 *
 * Returns `false` when the row was not claimable, which is the normal outcome
 * for a run canceled while it sat in the queue.
 *
 * `labels` 是调用方服务的执行分区（P2-8）。worker 传自己的那一组；套件成员就地执行时
 * 传持有它的那台 worker 的同一组。不传等于不设防，只有单步/内联调用才该这样。
 */
export async function performRun(executionId: string, signal: AbortSignal, workerId?: string, labels?: string[]): Promise<boolean> {
  /**
   * Claim and start in one statement. `status = 'queued'` in the WHERE clause
   * is what makes a cancel that landed first stick: it turns the row to
   * 'canceled', this UPDATE then matches nothing and the request is never sent.
   *
   * It is also the second guarantee against a duplicate send. BullMQ hands a
   * job to exactly one worker, but it can re-deliver one it believes stalled;
   * a re-delivered job finds the row already 'running' and stops here, before
   * `fetch`. At-most-once is the right trade for a tool that fires POSTs and
   * DELETEs at real services — a run that vanished is recoverable, one that
   * silently fired twice is not.
   *
   * `runner_label = ANY($3)` 是 P2-8 加的第三道守卫，也是这个切片唯一的安全性增量：
   * 万一有 job 被投进了错的队列，worker 在 `fetch` **之前**退出，而不是从错误的网段
   * 对着生产发出一个真实请求。跨网段的场合「少跑一次」永远比「跑错地方」便宜。
   */
  const claimed = await pool.query(
    `UPDATE executions SET status = 'running', started_at = now(), worker_id = $2
      WHERE id = $1 AND status = 'queued' AND ($3::text[] IS NULL OR runner_label = ANY($3))
      RETURNING *`,
    [executionId, workerId ?? null, labels ?? null],
  );
  if (!claimed.rowCount) return false;

  const row = claimed.rows[0];
  const projectId = String(row.project_id);
  const spec = row.run_spec as RunSpec;
  await publishEvent({
    kind: "execution", projectId, executionId, status: "running",
    endpointId: String(row.endpoint_id),
    batchId: row.batch_id ? String(row.batch_id) : undefined,
    caseId: row.case_id ? String(row.case_id) : undefined,
  });

  const result = await executeRequest({
    request: spec.request,
    assertions: spec.assertions ?? [],
    /* A flow单步调试 carries its node's extracts, so the debug reports whether
       the chained value would actually be captured. */
    extracts: spec.extracts,
    hooks: spec.hooks,
    responseScripts: spec.responseScripts,
    environment: async () => {
      const environment = await loadEnvironment(projectId, spec.environmentId);
      /* Caller-supplied variables win over the environment: a单步调试 passes the
         values an upstream step would have produced, and those must override the
         stale静态 value the environment holds under the same name. */
      return spec.variables ? { ...environment, variables: { ...environment.variables, ...spec.variables } } : environment;
    },
    signal,
    snapshot: row.request_snapshot,
  });

  /**
   * `status = 'running'` guards the write.
   *
   * A cancel that arrived while the request was in flight already set
   * 'canceled'; without this clause the aborted attempt would overwrite it and
   * report as a plain failure. It also settles the opposite race — a response
   * that lands in the same instant a cancel is issued keeps its real result,
   * because whichever statement runs second matches nothing.
   */
  const settled = await settleExecution(executionId, result);

  await publishEvent({
    kind: "execution", projectId, executionId,
    status: settled ? result.status : "canceled",
    endpointId: String(row.endpoint_id),
    batchId: row.batch_id ? String(row.batch_id) : undefined,
    caseId: row.case_id ? String(row.case_id) : undefined,
  });
  if (row.batch_id) await settleBatch(String(row.batch_id), projectId);
  return true;
}

/**
 * Writes the terminal state of one execution row. Returns false when the row
 * was no longer `running`, which means a cancel got there first.
 */
export async function settleExecution(executionId: string, result: RunOutcome): Promise<boolean> {
  const settled = await pool.query(
    `UPDATE executions SET
       status = $2, status_code = $3, duration_ms = $4, error = $5,
       request_snapshot = $6::jsonb, response_headers = $7::jsonb, response_content_type = $8,
       response_size_bytes = $9, response_truncated = $10, response_body = $11,
       assertion_results = $12::jsonb, extract_results = $13::jsonb, hook_results = $14::jsonb,
       response_script_results = $15::jsonb, finished_at = now(),
       /* Cleared once terminal: it holds auth material and has no reader left. */
       run_spec = NULL
     WHERE id = $1 AND status = 'running' RETURNING status`,
    [
      executionId, result.status, result.statusCode ?? null, result.durationMs, result.error ?? null,
      JSON.stringify(result.request), JSON.stringify(result.responseHeaders), result.responseContentType ?? null,
      result.responseSizeBytes, result.responseTruncated, result.responseBody ?? null,
       JSON.stringify(result.assertionResults), JSON.stringify(result.extractResults), JSON.stringify(result.hookResults),
       JSON.stringify(result.responseScriptResults),
    ],
  );
  return Boolean(settled.rowCount);
}

/**
 * Recomputes a batch from its executions.
 *
 * Derived rather than incremented: counters bumped per finished item race
 * between concurrent workers, while a re-aggregate is idempotent and stays
 * correct no matter how many times it runs or in what order.
 */
export async function settleBatch(batchId: string, projectId: string) {
  const result = await pool.query(
    `UPDATE batch_executions b SET
       success_count = agg.succeeded, failed_count = agg.failed, canceled_count = agg.canceled,
       /* 'canceled' only when nothing actually ran: a batch the user stopped
          halfway still has real results to show, so it reads as completed. */
       status = CASE
         WHEN agg.settled < b.total THEN 'running'
         WHEN agg.canceled = b.total THEN 'canceled'
         ELSE 'completed' END,
       finished_at = CASE WHEN agg.settled >= b.total THEN now() ELSE NULL END
     FROM (
       SELECT
         COUNT(*) FILTER (WHERE status = 'success')::int  AS succeeded,
         COUNT(*) FILTER (WHERE status = 'failed')::int   AS failed,
         COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled,
         COUNT(*) FILTER (WHERE status IN ('success', 'failed', 'canceled'))::int AS settled
       FROM executions WHERE batch_id = $1
     ) agg
     WHERE b.id = $1 RETURNING b.*`,
    [batchId],
  );
  if (!result.rowCount) return;
  const row = result.rows[0];
  await publishEvent({
    kind: "batch", projectId, batchId, status: String(row.status), total: Number(row.total),
    successCount: Number(row.success_count), failedCount: Number(row.failed_count), canceledCount: Number(row.canceled_count),
  });
}
