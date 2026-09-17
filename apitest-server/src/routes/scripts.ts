import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, auditFields, writeAuditLogAsync } from "../lib/audit.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { runResponseScript, runScriptAssertion, runScriptHook, type ScriptCheck, type SecretResolver } from "../lib/sandbox.js";
import { loadEnvironment } from "../lib/run.js";
import { sanitizeValue } from "../lib/sanitize.js";
import { inspectLibrarySource, SCRIPT_CTX_SCHEMAS } from "../lib/scriptContract.js";
import { scriptUsage } from "../lib/scripts.js";
import { isUuid } from "../lib/uuid.js";
import { mapScript } from "../models/types.js";
/* P5-6 边界 8：公共脚本校验提取到 lib/validateScript.ts（MCP 写工具同款判据）。 */
import { CREATABLE_SCRIPT_KINDS, MAX_SCRIPT_LENGTH, SCRIPT_KINDS, validateScript, type ScriptInput } from "../lib/validateScript.js";

/**
 * 具名公共脚本 CRUD (计划 4.0.1 确认: follow / copy).
 *
 * This route only ever handles **public** scripts. Anonymous ones are written by
 * the case save path (`lib/scripts.ts`) and have no independent lifecycle, so
 * exposing them here would offer an edit that the owning case would overwrite on
 * its next save.
 *
 * Editing a public script is deliberately a separate, explicit action rather
 * than something a case save can carry: it changes every follower at once, and
 * that blast radius needs its own confirmation — which is exactly what
 * `GET .../usage` and the `force` delete exist to support.
 */

/**
 * Rewrites which libraries a public script pulls in.
 *
 * Enforced here rather than by a constraint because "must point at a `library`"
 * and "a library may not itself depend on one" are statements a foreign key
 * cannot make. The second rule is what keeps composition one level deep, so the
 * concatenation order is predictable and a cycle is impossible by construction.
 */
async function replaceDependencies(
  db: Pick<PoolClient, "query">,
  projectId: string,
  scriptId: string,
  kind: string,
  dependencies: string[],
): Promise<string | undefined> {
  const ids = [...new Set(dependencies.filter(Boolean))];
  if (kind === "library" && ids.length) return "a library cannot depend on another library; keep composition one level deep";

  if (ids.length) {
    const libraries = await db.query(
      "SELECT id, kind FROM scripts WHERE id = ANY($1::uuid[]) AND project_id = $2",
      [ids, projectId],
    );
    if (libraries.rowCount !== ids.length) return "a referenced library does not exist in this project";
    if (libraries.rows.some((row) => String(row.kind) !== "library")) return "only library scripts can be referenced as dependencies";
  }

  await db.query("DELETE FROM script_deps WHERE script_id = $1", [scriptId]);
  for (const [position, id] of ids.entries()) {
    await db.query(
      "INSERT INTO script_deps (script_id, depends_on_id, position) VALUES ($1, $2, $3)",
      [scriptId, id, position],
    );
  }
  return undefined;
}

/** Library ids a script declares, in the order they will be concatenated. */
async function dependencyIds(scriptId: string, db: Pick<PoolClient, "query"> = pool): Promise<string[]> {
  const result = await db.query(
    "SELECT depends_on_id FROM script_deps WHERE script_id = $1 ORDER BY position",
    [scriptId],
  );
  return result.rows.map((row) => String(row.depends_on_id));
}

export async function scriptRoutes(app: FastifyInstance) {
  /** Single source of truth for Monaco's built-in ctx completions. */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/scripts/contract", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    return success({ ctx: SCRIPT_CTX_SCHEMAS });
  });

  app.get<{ Params: { id: string }; Querystring: { keyword?: string; kind?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/scripts", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const params: unknown[] = [context.project.id];
    /* name IS NOT NULL: anonymous scripts are an implementation detail of a case. */
    const clauses = ["s.project_id = $1", "s.name IS NOT NULL"];
    const keyword = request.query.keyword?.trim();
    if (keyword) { params.push(`%${keyword}%`); clauses.push(`s.name ILIKE $${params.length}`); }
    /* The kind filter is how the hook picker avoids offering assertion scripts,
       whose `return` value means "assertion passed" and would silently discard
       any request rewrite. */
    const kind = request.query.kind?.trim();
    if (kind) {
      if (!SCRIPT_KINDS.includes(kind)) return fail(reply, 400, 1001, `kind must be one of ${SCRIPT_KINDS.join(", ")}`);
      params.push(kind); clauses.push(`s.kind = $${params.length}`);
    }
    const where = clauses.join(" AND ");
    /* Shared by both reads: the list renders the dependency order and the editor
       preselects from it. P11 归属列（边界 7/9）也挂在这里：`LEFT JOIN users`
       带出 email 快照，WHERE 里的列本来就带 `s.` 前缀，加 join 不会撞名。 */
    const body = `
      FROM scripts s
      LEFT JOIN (
        SELECT script_id, array_agg(depends_on_id ORDER BY position) AS ids
          FROM script_deps GROUP BY script_id
      ) d ON d.script_id = s.id
      LEFT JOIN users creator ON creator.id = s.created_by
      LEFT JOIN users updater ON updater.id = s.updated_by
      WHERE ${where}
      ORDER BY s.kind, s.name`;
    /* Libraries carry a parsed symbol list for the picker; other kinds do not. */
    const mapRows = (rows: Record<string, unknown>[]) => rows.map((row) => {
      const mapped = mapScript(row);
      return mapped.kind === "library" ? { ...mapped, symbols: inspectLibrarySource(mapped.content).symbols } : mapped;
    });
    /**
     * 同一个数据源，两种读法（与 environments / flows 同款）：不带 `page` 的调用
     * （脚本选择器、依赖库下拉）拿全量列表；管理页带 `page`/`pageSize` 走服务端
     * 分页——分页后只过滤当前页会让人以为某个脚本不存在。
     */
    if (request.query.page !== undefined || request.query.pageSize !== undefined) {
      const page = Math.max(1, Number(request.query.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM scripts s WHERE ${where}`, params);
      params.push(pageSize, (page - 1) * pageSize);
      const result = await pool.query(`SELECT s.*, COALESCE(d.ids, '{}') AS dependencies, creator.email AS created_by_email, updater.email AS updated_by_email${body} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      return success(mapRows(result.rows), { page, pageSize, total: Number(count.rows[0].total) });
    }
    const result = await pool.query(`SELECT s.*, COALESCE(d.ids, '{}') AS dependencies, creator.email AS created_by_email, updater.email AS updated_by_email${body}`, params);
    const data = mapRows(result.rows);
    return success(data, { total: data.length });
  });

  app.get<{ Params: { id: string; scriptId: string } }>("/api/v1/projects/:id/scripts/:scriptId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.scriptId)) return fail(reply, 404, 2001, "script not found");
    const result = await pool.query("SELECT * FROM scripts WHERE id = $1 AND project_id = $2", [request.params.scriptId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "script not found");
    return success(mapScript({ ...result.rows[0], dependencies: await dependencyIds(request.params.scriptId) }));
  });

  /**
   * Who follows this script, so the UI can state the consequence before an edit
   * or a delete rather than after (交互文档 delete semantics, cf. environments).
   */
  app.get<{ Params: { id: string; scriptId: string } }>("/api/v1/projects/:id/scripts/:scriptId/usage", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.scriptId)) return fail(reply, 404, 2001, "script not found");
    const users = await scriptUsage(context.project.id, request.params.scriptId);
    /* `cases` stays for the existing renderer; `users` is the full set, which
       since P1-2 also contains flows. */
    return success({ users, cases: users.filter((item) => item.kind === "case"), total: users.length });
  });

  app.post<{ Params: { id: string }; Body: ScriptInput }>("/api/v1/projects/:id/scripts", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const invalid = validateScript(request.body);
    if (invalid) return fail(reply, 400, 1001, invalid);

    const duplicate = await pool.query(
      "SELECT id FROM scripts WHERE project_id = $1 AND name = $2",
      [context.project.id, request.body.name!.trim()],
    );
    if (duplicate.rowCount) return fail(reply, 409, 2003, "a script with this name already exists");

    const kind = request.body.kind ?? "response";
    if (!CREATABLE_SCRIPT_KINDS.includes(kind)) return fail(reply, 400, 1001, `kind must be one of ${CREATABLE_SCRIPT_KINDS.join(", ")}`);
    if (kind === "library") {
      const inspected = inspectLibrarySource(request.body.content!);
      if (inspected.error) return fail(reply, 400, 1001, inspected.error);
    }
    /* One transaction: a script row standing without the library list it was
       created with would claim libraries it does not have. */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO scripts (id, project_id, name, language, kind, content, owner_case_id, created_by)
         VALUES ($1, $2, $3, 'javascript', $4, $5, NULL, $6) RETURNING *`,
        [randomUUID(), context.project.id, request.body.name!.trim(), kind, request.body.content!, context.user.id],
      );
      const created = String(result.rows[0].id);
      const dependencyError = await replaceDependencies(client, context.project.id, created, kind, request.body.dependencies ?? []);
      if (dependencyError) {
        await client.query("ROLLBACK");
        return fail(reply, 400, 1001, dependencyError);
      }
      const dependencies = await dependencyIds(created, client);
      await client.query("COMMIT");
      /* P11-9 审计（边界 5/6）：detail 只有字段名，脚本正文绝不进。 */
      writeAuditLogAsync({
        action: AUDIT_ACTIONS.scriptCreate, targetType: "script", targetId: created,
        projectId: context.project.id, userId: context.user.id,
        detail: { fields: auditFields(request.body) }, ip: request.ip,
      });
      return reply.code(201).send(success(mapScript({ ...result.rows[0], dependencies })));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * Edits a public script, changing behaviour for every follower.
   *
   * The response carries the follower list so the UI can report what just moved;
   * the client is expected to have shown it via `GET .../usage` beforehand.
   */
  app.patch<{ Params: { id: string; scriptId: string }; Body: ScriptInput }>("/api/v1/projects/:id/scripts/:scriptId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.scriptId)) return fail(reply, 404, 2001, "script not found");
    const invalid = validateScript(request.body, true);
    if (invalid) return fail(reply, 400, 1001, invalid);

    if (request.body.name !== undefined) {
      const duplicate = await pool.query(
        "SELECT id FROM scripts WHERE project_id = $1 AND name = $2 AND id <> $3",
        [context.project.id, request.body.name.trim(), request.params.scriptId],
      );
      if (duplicate.rowCount) return fail(reply, 409, 2003, "a script with this name already exists");
    }

    if (request.body.content !== undefined) {
      const existingKind = await pool.query("SELECT kind FROM scripts WHERE id = $1 AND project_id = $2 AND name IS NOT NULL", [request.params.scriptId, context.project.id]);
      if (!existingKind.rowCount) return fail(reply, 404, 2001, "script not found");
      if (String(existingKind.rows[0].kind) === "library") {
        const inspected = inspectLibrarySource(request.body.content);
        if (inspected.error) return fail(reply, 400, 1001, inspected.error);
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE scripts SET
           name = COALESCE($1, name),
           content = COALESCE($2, content),
           updated_by = $5,
           updated_at = now()
         /* name IS NOT NULL keeps this route off anonymous scripts. */
         WHERE id = $3 AND project_id = $4 AND name IS NOT NULL RETURNING *`,
        [request.body.name?.trim() ?? null, request.body.content ?? null, request.params.scriptId, context.project.id, context.user.id],
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return fail(reply, 404, 2001, "script not found");
      }

      /* `kind` is deliberately not editable: flipping an assertion script to a
         hook would change the meaning of its `return` for every follower at
         once, silently. Re-create it instead. */
      if (request.body.dependencies !== undefined) {
        const dependencyError = await replaceDependencies(
          client, context.project.id, request.params.scriptId,
          String(result.rows[0].kind ?? "assertion"), request.body.dependencies,
        );
        if (dependencyError) {
          await client.query("ROLLBACK");
          return fail(reply, 400, 1001, dependencyError);
        }
      }
      const dependencies = await dependencyIds(request.params.scriptId, client);
      await client.query("COMMIT");

      writeAuditLogAsync({
        action: AUDIT_ACTIONS.scriptUpdate, targetType: "script", targetId: request.params.scriptId,
        projectId: context.project.id, userId: context.user.id,
        detail: { fields: auditFields(request.body) }, ip: request.ip,
      });
      const followers = await scriptUsage(context.project.id, request.params.scriptId);
      return success({ ...mapScript({ ...result.rows[0], dependencies }), followers, followerCount: followers.length });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * Deletes a public script, refusing while anything follows it.
   *
   * Same shape as the environment delete (`environments.ts:156`): a 409 whose
   * `data` is the dependency list, and `?force=true` only after the user has
   * seen it. A followed script deleted silently would leave those cases failing
   * with "script content is missing" at their next run, with nothing on screen
   * explaining why.
   */
  app.delete<{ Params: { id: string; scriptId: string }; Querystring: { force?: string } }>("/api/v1/projects/:id/scripts/:scriptId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.scriptId)) return fail(reply, 404, 2001, "script not found");

    const users = await scriptUsage(context.project.id, request.params.scriptId);
    if (users.length && request.query.force !== "true") {
      /* Non-zero code with a payload, matching the one deliberate envelope
         variance the contract allows, because the client needs the list.
         `cases` is kept alongside `users` so an older client still renders the
         list it knows how to render (P1-2 added flows to the same scan). */
      return reply.code(409).send({
        code: 2003, message: "script is referenced and cannot be deleted",
        data: { users, cases: users.filter((item) => item.kind === "case"), total: users.length },
      });
    }

    const result = await pool.query(
      "DELETE FROM scripts WHERE id = $1 AND project_id = $2 AND name IS NOT NULL RETURNING id",
      [request.params.scriptId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "script not found");
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.scriptDelete, targetType: "script", targetId: String(result.rows[0].id),
      projectId: context.project.id, userId: context.user.id, ip: request.ip,
    });
    return success({ id: String(result.rows[0].id), affectedCases: users.length });
  });

  /**
   * Try-runs a script against a response the user pastes or already has.
   *
   * Separate from `POST /assertions/validate` because the script editor needs to
   * see `console.log` output and the thrown message, which an assertion result
   * flattens into a single pass/fail line.
   */
  app.post<{
    Params: { id: string };
    Body: {
      content?: string; kind?: string; dependencies?: string[];
      statusCode?: number; headers?: Record<string, string>; body?: string;
      request?: { method?: string; url?: string; headers?: Record<string, string>; body?: string };
      variables?: Record<string, string>;
      /**
       * Loads the environment into a try-run so `ctx.variables` and
       * `{ secret: "NAME" }` behave like a real execution. Without it a signing
       * script fails here for "no such secret" and looks broken when the real
       * run would find the key. Applies to assertion scripts too, which now read
       * and write the same variable bag.
       */
      environmentId?: string;
    };
  }>("/api/v1/projects/:id/scripts/try", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const content = request.body?.content;
    if (!content?.trim()) return fail(reply, 400, 1001, "content is required");
    if (content.length > MAX_SCRIPT_LENGTH) return fail(reply, 400, 1001, `content must be at most ${MAX_SCRIPT_LENGTH} characters`);
    const kind = request.body?.kind ?? "response";
    if (!SCRIPT_KINDS.includes(kind)) return fail(reply, 400, 1001, `kind must be one of ${SCRIPT_KINDS.join(", ")}`);

    /* Libraries are passed to the sandbox the same way the worker passes them —
       as separate sources, not concatenated here — so a script that try-runs
       green cannot fail at execution on a missing helper. */
    let libraries: string[] = [];
    if (request.body?.dependencies?.length) {
      if (request.body.dependencies.some((id) => !isUuid(id))) return fail(reply, 400, 1001, "dependencies must be script ids");
      const rows = await pool.query(
        `SELECT content FROM scripts
          WHERE id = ANY($1::uuid[]) AND project_id = $2 AND kind = 'library'
          ORDER BY array_position($1::uuid[], id)`,
        [request.body.dependencies, context.project.id],
      );
      libraries = rows.rows.map((row) => String(row.content));
    }

    /* A try-run mirrors the real execution context when an environment is given:
       variables come from the environment (secrets merged in) layered under
       whatever the editor passes, and `{ secret }` resolves against the same bag.
       Explicit input still wins — the editor is the newest truth.

       Loaded before the kind branch because assertion scripts now read
       `ctx.variables` too; keeping it inside the hook branch would make a
       variable-reading assertion fail here and pass in a real run. */
    let variables: Record<string, unknown> = request.body?.variables ?? {};
    let resolveSecret: SecretResolver = () => undefined;
    let secretValues: string[] = [];
    if (request.body?.environmentId) {
      if (!isUuid(request.body.environmentId)) return fail(reply, 400, 1001, "environmentId must be a uuid");
      try {
        const environment = await loadEnvironment(context.project.id, request.body.environmentId);
        variables = { ...environment.variables, ...(request.body.variables ?? {}) };
        resolveSecret = (name) => environment.variables[name];
        secretValues = environment.secretValues;
      } catch (error) {
        return fail(reply, 400, 1001, error instanceof Error ? error.message : "environment could not be loaded");
      }
    }
    /* Masked on the way out for the same reason execution history is: a try-run
       is shown on screen and `ctx.variables` now hands a script resolved
       secrets. */
    const mask = (text: string) => String(sanitizeValue(text, secretValues));
    const maskLogs = (entries: string[]) => entries.map(mask);
    const maskDebug = (entries: { label: string; value: string }[]) => entries.map((entry) => ({ label: entry.label, value: mask(entry.value) }));
    const maskChecks = (entries: ScriptCheck[]) => entries.map((check) => ({
      label: mask(check.label), passed: check.passed,
      message: check.message === undefined ? undefined : mask(check.message),
    }));

    if (kind === "hook") {
      const before: import("../lib/sandbox.js").HookRequest = {
        method: request.body?.request?.method ?? "GET",
        url: request.body?.request?.url ?? "https://example.com/",
        headers: request.body?.request?.headers ?? {},
        query: {},
        body: request.body?.request?.body,
        bodyText: request.body?.request?.body,
      };
      const outcome = runScriptHook(content, before, { variables, libraries, resolveSecret });
      /* `/scripts/try` is shared with assertion scripts, but the hook editor
         needs the same shape execution history uses. Returning the sandbox's
         raw result (no `name/type/changed`) made a valid try-run look like an
         assertion payload to the UI and crashed HookOutcome. */
      const changed = outcome.ok && outcome.request
        ? [
            before.method !== outcome.request.method ? "method" : undefined,
            before.url !== outcome.request.url ? "url" : undefined,
            JSON.stringify(before.headers) !== JSON.stringify(outcome.request.headers) ? "headers" : undefined,
            JSON.stringify(before.query) !== JSON.stringify(outcome.request.query) ? "query" : undefined,
            before.body !== outcome.request.body || before.bodyText !== outcome.request.bodyText ? "body" : undefined,
          ].filter((item): item is string => Boolean(item))
        : [];
      return success({
        name: "try hook", type: "script", ok: outcome.ok,
        error: outcome.error === undefined ? undefined : mask(outcome.error),
        logs: maskLogs(outcome.logs), debug: maskDebug(outcome.debug),
        checks: maskChecks(outcome.checks), changed,
      });
    }

    let parsed: unknown;
    let parseError: string | undefined;
    try { parsed = request.body?.body === undefined ? undefined : JSON.parse(request.body.body); }
    catch { parseError = "response body is not JSON"; }

    const scriptContext = {
      response: {
        status: request.body?.statusCode,
        /* Same folding as the assertion evaluator, so a try-run and a real run
           see identical headers. */
        headers: Object.fromEntries(Object.entries(request.body?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
        body: parseError ? undefined : parsed,
        text: request.body?.body,
      },
      variables,
    };
    const outcome = kind === "response"
      ? runResponseScript(content, scriptContext, libraries, resolveSecret)
      : runScriptAssertion(content, scriptContext, libraries, resolveSecret);
    const returnedVariables = "passed" in outcome ? outcome.variables : (outcome.ok ? outcome.variables : {});
    return success({
      passed: "passed" in outcome ? outcome.passed : outcome.ok,
      error: outcome.error === undefined ? undefined : mask(outcome.error),
      logs: maskLogs(outcome.logs),
      debug: maskDebug(outcome.debug),
      checks: maskChecks(outcome.checks),
      /* Shown as evidence, labelled as such by the UI: the value no longer
         decides the verdict, and a user who still thinks it does needs to see
         that a `return false` try-run reports passed. */
      returned: outcome.returned === undefined ? undefined : mask(outcome.returned),
      variables: returnedVariables,
      bodyParseError: parseError,
    });
  });
}
