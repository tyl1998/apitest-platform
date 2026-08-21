import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { collectReferences } from "../lib/resolve.js";
import { isUuid } from "../lib/uuid.js";
import { mapEndpoint, mapEnvironment } from "../models/types.js";

type VariableInput = Record<string, string>;

/**
 * Secrets are written as a patch, not a replacement: the client never holds the
 * plaintext (Spec 4.6), so it cannot send back the full map. `null` means
 * "remove this key", a string means "set it", and an absent key means
 * "leave whatever is stored".
 */
type SecretPatch = Record<string, string | null>;

type EnvironmentBody = { name?: string; variables?: VariableInput; secrets?: SecretPatch };

function cleanVariables(input: VariableInput | undefined): VariableInput | undefined {
  if (!input) return undefined;
  return Object.fromEntries(Object.entries(input).filter(([key]) => key.trim()).map(([key, value]) => [key.trim(), String(value ?? "")]));
}

function applySecretPatch(stored: Record<string, string>, patch: SecretPatch | undefined) {
  if (!patch) return stored;
  const next = { ...stored };
  for (const [rawKey, value] of Object.entries(patch)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (value === null) delete next[key];
    else next[key] = String(value);
  }
  return next;
}

/**
 * Everything that would break if this environment disappeared.
 *
 * An environment has no foreign key pointing at it from endpoints; the coupling
 * is by variable name, so the scan reads every `{{name}}` an endpoint
 * references and reports the ones only this environment supplies. Execution
 * history is listed but never blocks, because runs keep their own
 * `environment_name` snapshot (migration 004).
 */
async function scanUsage(projectId: string, environmentId: string) {
  const environmentResult = await pool.query("SELECT * FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  if (!environmentResult.rowCount) return undefined;
  const row = environmentResult.rows[0];
  const provided = new Set([
    ...Object.keys((row.variables ?? {}) as Record<string, string>),
    ...Object.keys((row.secrets ?? {}) as Record<string, string>),
  ]);

  /* A name also defined by a sibling environment is not an exclusive
     dependency: those endpoints keep working after this one is gone. */
  const siblings = await pool.query("SELECT variables, secrets FROM environments WHERE project_id = $1 AND id <> $2", [projectId, environmentId]);
  const elsewhere = new Set<string>();
  for (const sibling of siblings.rows) {
    for (const key of Object.keys((sibling.variables ?? {}) as Record<string, string>)) elsewhere.add(key);
    for (const key of Object.keys((sibling.secrets ?? {}) as Record<string, string>)) elsewhere.add(key);
  }
  const exclusive = new Set([...provided].filter((name) => !elsewhere.has(name)));

  const endpointResult = await pool.query("SELECT * FROM endpoints WHERE project_id = $1", [projectId]);
  const endpoints = endpointResult.rows.map(mapEndpoint).map((endpoint) => {
    const referenced = collectReferences([
      endpoint.url, endpoint.headers, endpoint.queryParams, endpoint.pathParams,
      endpoint.body, endpoint.bodyText, endpoint.auth,
    ]);
    const variables = [...referenced].filter((name) => exclusive.has(name)).sort();
    return { id: endpoint.id, name: endpoint.name, method: endpoint.method, url: endpoint.url, variables };
  }).filter((endpoint) => endpoint.variables.length > 0);

  const executions = await pool.query("SELECT COUNT(*)::int AS total FROM executions WHERE environment_id = $1", [environmentId]);

  return {
    environmentId,
    endpoints,
    executionCount: Number(executions.rows[0].total),
    /* Only an exclusive variable reference makes a delete destructive. */
    blocked: endpoints.length > 0,
  };
}

export async function environmentRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/environments", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    if (!context) return;
    const result = await pool.query("SELECT * FROM environments WHERE project_id = $1 ORDER BY name", [context.project.id]);
    return success(result.rows.map(mapEnvironment));
  });

  app.post<{ Params: { id: string }; Body: EnvironmentBody }>("/api/v1/projects/:id/environments", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    const name = request.body.name?.trim();
    if (!name) return fail(reply, 400, 1001, "environment name is required");
    const duplicate = await pool.query("SELECT 1 FROM environments WHERE project_id = $1 AND lower(name) = lower($2)", [context.project.id, name]);
    if (duplicate.rowCount) return fail(reply, 409, 1002, "an environment with this name already exists");
    const result = await pool.query(
      "INSERT INTO environments (id, project_id, name, variables, secrets) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING *",
      [randomUUID(), context.project.id, name, JSON.stringify(cleanVariables(request.body.variables) ?? {}), JSON.stringify(applySecretPatch({}, request.body.secrets))],
    );
    return reply.code(201).send(success(mapEnvironment(result.rows[0])));
  });

  app.patch<{ Params: { id: string; environmentId: string }; Body: EnvironmentBody }>("/api/v1/projects/:id/environments/:environmentId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.environmentId)) return fail(reply, 404, 2001, "environment not found");

    const existing = await pool.query("SELECT * FROM environments WHERE id = $1 AND project_id = $2", [request.params.environmentId, context.project.id]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "environment not found");

    const name = request.body.name?.trim();
    if (request.body.name !== undefined && !name) return fail(reply, 400, 1001, "environment name is required");
    if (name) {
      const duplicate = await pool.query("SELECT 1 FROM environments WHERE project_id = $1 AND lower(name) = lower($2) AND id <> $3", [context.project.id, name, request.params.environmentId]);
      if (duplicate.rowCount) return fail(reply, 409, 1002, "an environment with this name already exists");
    }

    /* Secrets are merged server-side so an update never has to echo plaintext. */
    const secrets = applySecretPatch((existing.rows[0].secrets ?? {}) as Record<string, string>, request.body.secrets);
    const variables = cleanVariables(request.body.variables);

    const result = await pool.query(
      "UPDATE environments SET name = COALESCE($1, name), variables = COALESCE($2::jsonb, variables), secrets = $3::jsonb WHERE id = $4 AND project_id = $5 RETURNING *",
      [name || null, variables ? JSON.stringify(variables) : null, JSON.stringify(secrets), request.params.environmentId, context.project.id],
    );
    return success(mapEnvironment(result.rows[0]));
  });

  /* Dependency scan, read before the confirm dialog so the user sees what breaks. */
  app.get<{ Params: { id: string; environmentId: string } }>("/api/v1/projects/:id/environments/:environmentId/usage", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    if (!context) return;
    if (!isUuid(request.params.environmentId)) return fail(reply, 404, 2001, "environment not found");
    const usage = await scanUsage(context.project.id, request.params.environmentId);
    if (!usage) return fail(reply, 404, 2001, "environment not found");
    return success(usage);
  });

  app.delete<{ Params: { id: string; environmentId: string }; Querystring: { force?: string } }>("/api/v1/projects/:id/environments/:environmentId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.environmentId)) return fail(reply, 404, 2001, "environment not found");

    const usage = await scanUsage(context.project.id, request.params.environmentId);
    if (!usage) return fail(reply, 404, 2001, "environment not found");
    /* Spec 4.4: a referenced resource is not hard-deletable by default. The
       client must re-submit with force once the user has seen the references. */
    if (usage.blocked && request.query.force !== "true") {
      return reply.code(409).send({ code: 2003, message: "environment is referenced by endpoints", data: usage });
    }

    /* Keep the name on historical runs before the FK nulls the id out. */
    await pool.query("UPDATE executions SET environment_name = COALESCE(environment_name, (SELECT name FROM environments WHERE id = $1)) WHERE environment_id = $1", [request.params.environmentId]);
    const result = await pool.query("DELETE FROM environments WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.environmentId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "environment not found");
    return success({ id: result.rows[0].id });
  });
}
