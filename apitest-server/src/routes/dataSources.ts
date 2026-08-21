import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { getAdapter } from "../lib/adapters/index.js";
import { encryptSecret } from "../lib/crypto.js";
import { loadSqlDefinition } from "../lib/dataSources.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { executeSql, validateSqlDefinition, validateSqlParams } from "../lib/sqlExecutor.js";
import { isUuid } from "../lib/uuid.js";
import { defaultPort, mapDataSource, mapSqlDefinition, type DataSourceConfig, type DataSourceType, type SqlParameterDefinition, type SqlStatementType } from "../models/types.js";

type DataSourceBody = { name?: string; type?: DataSourceType; config?: Partial<DataSourceConfig>; password?: string | null };
type SqlBody = { name?: string; description?: string; statementType?: SqlStatementType; sql?: string; params?: SqlParameterDefinition[] };
type RunBody = {
  sqlDefinitionId?: string;
  statementType?: SqlStatementType;
  sql?: string;
  params?: SqlParameterDefinition[];
  values?: Record<string, unknown>;
  timeoutMs?: number;
  maxRows?: number;
  maxResultBytes?: number;
};

const STATEMENT_TYPES: SqlStatementType[] = ["query", "command"];

function validateConfig(config: Partial<DataSourceConfig> | undefined, partial = false): string | undefined {
  if (!config && partial) return undefined;
  if (!config?.host?.trim()) return "config.host is required";
  if (!config.database?.trim()) return "config.database is required";
  if (!config.username?.trim()) return "config.username is required";
  if (config.port !== undefined && (!Number.isInteger(Number(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535)) return "config.port must be between 1 and 65535";
  for (const key of ["connectTimeoutMs", "queryTimeoutMs", "maxRows", "maxResultBytes"] as const) {
    if (config[key] !== undefined && (!Number.isFinite(Number(config[key])) || Number(config[key]) <= 0)) return `config.${key} must be a positive number`;
  }
  return undefined;
}

function cleanConfig(config: Partial<DataSourceConfig>, stored?: DataSourceConfig, type?: DataSourceType): DataSourceConfig {
  const merged = { ...(stored ?? {}), ...config } as DataSourceConfig;
  return {
    host: merged.host.trim(), port: Number(merged.port ?? defaultPort(type)), database: merged.database.trim(), username: merged.username.trim(),
    ssl: Boolean(merged.ssl), sslRejectUnauthorized: merged.sslRejectUnauthorized !== false,
    connectTimeoutMs: Number(merged.connectTimeoutMs ?? 5_000),
    queryTimeoutMs: Number(merged.queryTimeoutMs ?? 30_000),
    maxRows: Number(merged.maxRows ?? 1_000),
    maxResultBytes: Number(merged.maxResultBytes ?? 1_048_576),
  };
}

function validateSqlBody(body: SqlBody, partial = false): string | undefined {
  if (!partial || body.name !== undefined) if (!body.name?.trim()) return "name is required";
  if (!partial || body.statementType !== undefined) if (!body.statementType || !STATEMENT_TYPES.includes(body.statementType)) return "statementType must be query or command";
  if (!partial || body.sql !== undefined) if (!body.sql?.trim()) return "sql is required";
  if (body.params !== undefined) return validateSqlParams(body.params);
  return undefined;
}

async function dataSourceUsage(projectId: string, dataSourceId: string) {
  const source = await pool.query("SELECT id, name FROM data_sources WHERE id = $1 AND project_id = $2", [dataSourceId, projectId]);
  if (!source.rowCount) return undefined;
  const definitions = await pool.query("SELECT id, name FROM sql_definitions WHERE data_source_id = $1 ORDER BY name", [dataSourceId]);
  const flows = await pool.query(
    "SELECT id, name FROM flows WHERE project_id = $1 AND nodes @> $2::jsonb ORDER BY name",
    [projectId, JSON.stringify([{ dataSourceId }])],
  );
  return {
    dataSourceId, sqlDefinitions: definitions.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
    flows: flows.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
    blocked: Boolean(definitions.rowCount || flows.rowCount),
  };
}

async function sqlUsage(projectId: string, sqlId: string) {
  const definition = await pool.query("SELECT id, name FROM sql_definitions WHERE id = $1 AND project_id = $2", [sqlId, projectId]);
  if (!definition.rowCount) return undefined;
  const flows = await pool.query(
    "SELECT id, name FROM flows WHERE project_id = $1 AND nodes @> $2::jsonb ORDER BY name",
    [projectId, JSON.stringify([{ sqlDefinitionId: sqlId }])],
  );
  return {
    sqlDefinitionId: sqlId,
    flows: flows.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
    blocked: Boolean(flows.rowCount),
  };
}

async function resolveRun(projectId: string, dataSourceId: string, body: RunBody) {
  if (body.values !== undefined && (typeof body.values !== "object" || body.values === null || Array.isArray(body.values))) throw new Error("values must be an object");
  if (body.sqlDefinitionId) {
    if (!isUuid(body.sqlDefinitionId)) throw new Error("SQL definition not found");
    const definition = await loadSqlDefinition(projectId, body.sqlDefinitionId);
    if (!definition || definition.dataSourceId !== dataSourceId) throw new Error("SQL definition not found");
    return { statementType: definition.statementType, sql: definition.sql, params: definition.params };
  }
  if (!body.statementType || !STATEMENT_TYPES.includes(body.statementType)) throw new Error("statementType must be query or command");
  if (!body.sql?.trim()) throw new Error("sql is required");
  const invalid = validateSqlDefinition(body.statementType, body.sql, body.params);
  if (invalid) throw new Error(invalid);
  return { statementType: body.statementType, sql: body.sql, params: body.params ?? [] };
}

function sendUsageConflict(reply: FastifyReply, message: string, usage: unknown) {
  return reply.code(409).send({ code: 2003, message, data: usage });
}

export async function dataSourceRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/data-sources", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const result = await pool.query("SELECT * FROM data_sources WHERE project_id = $1 ORDER BY name", [context.project.id]);
    return success(result.rows.map(mapDataSource));
  });

  app.post<{ Params: { id: string }; Body: DataSourceBody }>("/api/v1/projects/:id/data-sources", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const name = request.body.name?.trim();
    if (!name) return fail(reply, 400, 1001, "name is required");
    const type = request.body.type ?? "postgresql";
    /* The adapter registry, not the schema CHECK, is what makes a type real. */
    if (!getAdapter(type)) return fail(reply, 400, 1001, `data source type "${type}" is not supported`);
    const invalid = validateConfig(request.body.config);
    if (invalid) return fail(reply, 400, 1001, invalid);
    if (request.body.password !== undefined && request.body.password !== null && typeof request.body.password !== "string") return fail(reply, 400, 1001, "password must be a string or null");
    const duplicate = await pool.query("SELECT 1 FROM data_sources WHERE project_id = $1 AND lower(name) = lower($2)", [context.project.id, name]);
    if (duplicate.rowCount) return fail(reply, 409, 2003, "a data source with this name already exists");
    try {
      const encrypted = typeof request.body.password === "string" ? encryptSecret(request.body.password) : null;
      const result = await pool.query(
        "INSERT INTO data_sources (id, project_id, name, type, config, credentials_encrypted) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *",
        [randomUUID(), context.project.id, name, type, JSON.stringify(cleanConfig(request.body.config!, undefined, type)), encrypted],
      );
      return reply.code(201).send(success(mapDataSource(result.rows[0])));
    } catch (error) {
      return fail(reply, 500, 5001, error instanceof Error ? error.message : "data source could not be created");
    }
  });

  app.get<{ Params: { id: string; dataSourceId: string } }>("/api/v1/projects/:id/data-sources/:dataSourceId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.dataSourceId)) return fail(reply, 404, 2001, "data source not found");
    const result = await pool.query("SELECT * FROM data_sources WHERE id = $1 AND project_id = $2", [request.params.dataSourceId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "data source not found");
    return success(mapDataSource(result.rows[0]));
  });

  app.put<{ Params: { id: string; dataSourceId: string }; Body: DataSourceBody }>("/api/v1/projects/:id/data-sources/:dataSourceId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.dataSourceId)) return fail(reply, 404, 2001, "data source not found");
    const existing = await pool.query("SELECT * FROM data_sources WHERE id = $1 AND project_id = $2", [request.params.dataSourceId, context.project.id]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "data source not found");
    const name = request.body.name?.trim();
    if (request.body.name !== undefined && !name) return fail(reply, 400, 1001, "name is required");
    if (request.body.type !== undefined && !getAdapter(request.body.type)) return fail(reply, 400, 1001, `data source type "${request.body.type}" is not supported`);
    if (request.body.password !== undefined && request.body.password !== null && typeof request.body.password !== "string") return fail(reply, 400, 1001, "password must be a string or null");
    const nextType = String(existing.rows[0].type) as DataSourceType;
    const config = request.body.config ? cleanConfig(request.body.config, existing.rows[0].config as DataSourceConfig, nextType) : existing.rows[0].config as DataSourceConfig;
    const invalid = validateConfig(config);
    if (invalid) return fail(reply, 400, 1001, invalid);
    if (name) {
      const duplicate = await pool.query("SELECT 1 FROM data_sources WHERE project_id = $1 AND lower(name) = lower($2) AND id <> $3", [context.project.id, name, request.params.dataSourceId]);
      if (duplicate.rowCount) return fail(reply, 409, 2003, "a data source with this name already exists");
    }
    try {
      /* Password patch: absent keeps, string replaces, null clears. */
      const passwordGiven = Object.prototype.hasOwnProperty.call(request.body, "password");
      const encrypted = passwordGiven ? (request.body.password === null ? null : encryptSecret(String(request.body.password))) : existing.rows[0].credentials_encrypted;
      const result = await pool.query(
        "UPDATE data_sources SET name = COALESCE($1, name), config = $2::jsonb, credentials_encrypted = $3, updated_at = now() WHERE id = $4 AND project_id = $5 RETURNING *",
        [name ?? null, JSON.stringify(config), encrypted, request.params.dataSourceId, context.project.id],
      );
      return success(mapDataSource(result.rows[0]));
    } catch (error) {
      return fail(reply, 500, 5001, error instanceof Error ? error.message : "data source could not be updated");
    }
  });

  app.get<{ Params: { id: string; dataSourceId: string } }>("/api/v1/projects/:id/data-sources/:dataSourceId/usage", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.dataSourceId)) return fail(reply, 404, 2001, "data source not found");
    const usage = await dataSourceUsage(context.project.id, request.params.dataSourceId);
    if (!usage) return fail(reply, 404, 2001, "data source not found");
    return success(usage);
  });

  app.delete<{ Params: { id: string; dataSourceId: string }; Querystring: { force?: string } }>("/api/v1/projects/:id/data-sources/:dataSourceId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.dataSourceId)) return fail(reply, 404, 2001, "data source not found");
    const usage = await dataSourceUsage(context.project.id, request.params.dataSourceId);
    if (!usage) return fail(reply, 404, 2001, "data source not found");
    if (usage.blocked && request.query.force !== "true") return sendUsageConflict(reply, "data source is referenced", usage);
    const result = await pool.query("DELETE FROM data_sources WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.dataSourceId, context.project.id]);
    return success({ id: String(result.rows[0].id) });
  });

  app.post<{ Params: { id: string; dataSourceId: string } }>("/api/v1/projects/:id/data-sources/:dataSourceId/test", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.dataSourceId)) return fail(reply, 404, 2001, "data source not found");
    try {
      const result = await executeSql({ projectId: context.project.id, dataSourceId: request.params.dataSourceId, statementType: "query", sql: "SELECT 1 AS ok" });
      return success(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "connection test failed";
      return message === "data source not found" ? fail(reply, 404, 2001, message) : fail(reply, 400, 2002, message);
    }
  });

  app.post<{ Params: { id: string; dataSourceId: string }; Body: RunBody }>("/api/v1/projects/:id/data-sources/:dataSourceId/query", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.dataSourceId)) return fail(reply, 404, 2001, "data source not found");
    try {
      const definition = await resolveRun(context.project.id, request.params.dataSourceId, request.body ?? {});
      return success(await executeSql({ projectId: context.project.id, dataSourceId: request.params.dataSourceId, ...definition, values: request.body?.values, timeoutMs: request.body?.timeoutMs, maxRows: request.body?.maxRows, maxResultBytes: request.body?.maxResultBytes }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "SQL execution failed";
      return message === "data source not found" ? fail(reply, 404, 2001, message) : fail(reply, 400, 2002, message);
    }
  });

  app.get<{ Params: { id: string; dataSourceId: string } }>("/api/v1/projects/:id/data-sources/:dataSourceId/sql-definitions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.dataSourceId)) return fail(reply, 404, 2001, "data source not found");
    const source = await pool.query("SELECT 1 FROM data_sources WHERE id = $1 AND project_id = $2", [request.params.dataSourceId, context.project.id]);
    if (!source.rowCount) return fail(reply, 404, 2001, "data source not found");
    const result = await pool.query("SELECT * FROM sql_definitions WHERE data_source_id = $1 AND project_id = $2 ORDER BY name", [request.params.dataSourceId, context.project.id]);
    return success(result.rows.map(mapSqlDefinition));
  });

  app.post<{ Params: { id: string; dataSourceId: string }; Body: SqlBody }>("/api/v1/projects/:id/data-sources/:dataSourceId/sql-definitions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.dataSourceId)) return fail(reply, 404, 2001, "data source not found");
    const invalid = validateSqlBody(request.body) ?? validateSqlDefinition(request.body.statementType!, request.body.sql!, request.body.params);
    if (invalid) return fail(reply, 400, 1001, invalid);
    const source = await pool.query("SELECT 1 FROM data_sources WHERE id = $1 AND project_id = $2", [request.params.dataSourceId, context.project.id]);
    if (!source.rowCount) return fail(reply, 404, 2001, "data source not found");
    const duplicate = await pool.query("SELECT 1 FROM sql_definitions WHERE data_source_id = $1 AND lower(name) = lower($2)", [request.params.dataSourceId, request.body.name!.trim()]);
    if (duplicate.rowCount) return fail(reply, 409, 2003, "an SQL definition with this name already exists");
    const result = await pool.query(
      "INSERT INTO sql_definitions (id, project_id, data_source_id, name, description, statement_type, sql, params) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *",
      [randomUUID(), context.project.id, request.params.dataSourceId, request.body.name!.trim(), request.body.description?.trim() ?? "", request.body.statementType, request.body.sql!.trim(), JSON.stringify(request.body.params ?? [])],
    );
    return reply.code(201).send(success(mapSqlDefinition(result.rows[0])));
  });

  app.get<{ Params: { id: string; sqlId: string } }>("/api/v1/projects/:id/sql-definitions/:sqlId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.sqlId)) return fail(reply, 404, 2001, "SQL definition not found");
    const definition = await loadSqlDefinition(context.project.id, request.params.sqlId);
    if (!definition) return fail(reply, 404, 2001, "SQL definition not found");
    return success(definition);
  });

  app.put<{ Params: { id: string; sqlId: string }; Body: SqlBody }>("/api/v1/projects/:id/sql-definitions/:sqlId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.sqlId)) return fail(reply, 404, 2001, "SQL definition not found");
    const existing = await loadSqlDefinition(context.project.id, request.params.sqlId);
    if (!existing) return fail(reply, 404, 2001, "SQL definition not found");
    const invalid = validateSqlBody(request.body, true);
    if (invalid) return fail(reply, 400, 1001, invalid);
    const nextType = request.body.statementType ?? existing.statementType; const nextSql = request.body.sql?.trim() ?? existing.sql; const nextParams = request.body.params ?? existing.params;
    const statementInvalid = validateSqlDefinition(nextType, nextSql, nextParams);
    if (statementInvalid) return fail(reply, 400, 1001, statementInvalid);
    const name = request.body.name?.trim();
    if (name) {
      const duplicate = await pool.query("SELECT 1 FROM sql_definitions WHERE data_source_id = $1 AND lower(name) = lower($2) AND id <> $3", [existing.dataSourceId, name, existing.id]);
      if (duplicate.rowCount) return fail(reply, 409, 2003, "an SQL definition with this name already exists");
    }
    const result = await pool.query(
      "UPDATE sql_definitions SET name = COALESCE($1, name), description = COALESCE($2, description), statement_type = $3, sql = $4, params = $5::jsonb, updated_at = now() WHERE id = $6 AND project_id = $7 RETURNING *",
      [name ?? null, request.body.description?.trim() ?? null, nextType, nextSql, JSON.stringify(nextParams), existing.id, context.project.id],
    );
    return success(mapSqlDefinition(result.rows[0]));
  });

  app.delete<{ Params: { id: string; sqlId: string }; Querystring: { force?: string } }>("/api/v1/projects/:id/sql-definitions/:sqlId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.sqlId)) return fail(reply, 404, 2001, "SQL definition not found");
    const usage = await sqlUsage(context.project.id, request.params.sqlId);
    if (!usage) return fail(reply, 404, 2001, "SQL definition not found");
    if (usage.blocked && request.query.force !== "true") return sendUsageConflict(reply, "SQL definition is referenced", usage);
    const result = await pool.query("DELETE FROM sql_definitions WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.sqlId, context.project.id]);
    return success({ id: String(result.rows[0].id) });
  });

  app.post<{ Params: { id: string; sqlId: string }; Body: Omit<RunBody, "sqlDefinitionId" | "statementType" | "sql" | "params"> }>("/api/v1/projects/:id/sql-definitions/:sqlId/test", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.sqlId)) return fail(reply, 404, 2001, "SQL definition not found");
    const definition = await loadSqlDefinition(context.project.id, request.params.sqlId);
    if (!definition) return fail(reply, 404, 2001, "SQL definition not found");
    try {
      return success(await executeSql({ projectId: context.project.id, dataSourceId: definition.dataSourceId, statementType: definition.statementType, sql: definition.sql, params: definition.params, values: request.body?.values, timeoutMs: request.body?.timeoutMs, maxRows: request.body?.maxRows, maxResultBytes: request.body?.maxResultBytes }));
    } catch (error) { return fail(reply, 400, 2002, error instanceof Error ? error.message : "SQL execution failed"); }
  });
}
