import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { isSupportedDataSourceType } from "../lib/adapters/index.js";
import { validateOperation } from "../lib/adapters/operations.js";
import { encryptSecret } from "../lib/crypto.js";
import { loadDataSource, loadSqlDefinition } from "../lib/dataSources.js";
import { flowsReferencing } from "../lib/flowRefs.js";
import { executeOperation } from "../lib/operationExecutor.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { executeSql, validateSqlDefinition, validateSqlParams } from "../lib/sqlExecutor.js";
import { isUuid } from "../lib/uuid.js";
import { defaultPort, definitionKind, mapDataSource, mapSqlDefinition, type DataSourceConfig, type DataSourceType, type DataSourceOperation, type SqlParameterDefinition, type SqlStatementType } from "../models/types.js";

type DataSourceBody = { name?: string; type?: DataSourceType; config?: Partial<DataSourceConfig>; password?: string | null };
type SqlBody = { name?: string; description?: string; kind?: "sql" | "mongo" | "redis"; statementType?: SqlStatementType; sql?: string; operation?: unknown; params?: SqlParameterDefinition[] };
type RunBody = {
  sqlDefinitionId?: string;
  kind?: "sql" | "mongo" | "redis";
  statementType?: SqlStatementType;
  sql?: string;
  operation?: unknown;
  params?: SqlParameterDefinition[];
  values?: Record<string, unknown>;
  timeoutMs?: number;
  maxRows?: number;
  maxResultBytes?: number;
};

const STATEMENT_TYPES: SqlStatementType[] = ["query", "command"];

/**
 * Which connection fields a type actually needs.
 *
 * Redis has no username at all before the 6.0 ACLs and is routinely deployed
 * with no auth, and its `database` is a numbered index that defaults to 0 —
 * requiring either made an unauthenticated Redis impossible to save. MongoDB is
 * commonly unauthenticated in a dev cluster but still needs a database name to
 * address a collection.
 */
function requiredConfigFields(type: DataSourceType | undefined): { database: boolean; username: boolean } {
  if (type === "redis") return { database: false, username: false };
  if (type === "mongodb") return { database: true, username: false };
  return { database: true, username: true };
}

function validateConfig(config: Partial<DataSourceConfig> | undefined, type?: DataSourceType, partial = false): string | undefined {
  if (!config && partial) return undefined;
  if (!config?.host?.trim()) return "config.host is required";
  const required = requiredConfigFields(type);
  if (required.database && !config.database?.trim()) return "config.database is required";
  if (required.username && !config.username?.trim()) return "config.username is required";
  /* Redis addresses a numbered db, not a named one: the driver coerces with
     `Number(database) || 0`, so a typo would silently land on db 0. */
  if (type === "redis" && config.database?.trim() && !/^\d+$/.test(config.database.trim())) return "config.database must be a Redis database index";
  if (config.port !== undefined && (!Number.isInteger(Number(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535)) return "config.port must be between 1 and 65535";
  for (const key of ["connectTimeoutMs", "queryTimeoutMs", "maxRows", "maxResultBytes"] as const) {
    if (config[key] !== undefined && (!Number.isFinite(Number(config[key])) || Number(config[key]) <= 0)) return `config.${key} must be a positive number`;
  }
  return undefined;
}

function cleanConfig(config: Partial<DataSourceConfig>, stored?: DataSourceConfig, type?: DataSourceType): DataSourceConfig {
  const merged = { ...(stored ?? {}), ...config } as DataSourceConfig;
  return {
    /* `?? ""` on database/username: they are optional for redis/mongodb, so the
       body may legitimately omit them and `.trim()` would throw. */
    host: merged.host.trim(), port: Number(merged.port ?? defaultPort(type)), database: (merged.database ?? "").trim(), username: (merged.username ?? "").trim(),
    ssl: Boolean(merged.ssl), sslRejectUnauthorized: merged.sslRejectUnauthorized !== false,
    connectTimeoutMs: Number(merged.connectTimeoutMs ?? 5_000),
    queryTimeoutMs: Number(merged.queryTimeoutMs ?? 30_000),
    maxRows: Number(merged.maxRows ?? 1_000),
    maxResultBytes: Number(merged.maxResultBytes ?? 1_048_576),
  };
}

function validateSqlBody(body: SqlBody, partial = false): string | undefined {
  if (!partial || body.name !== undefined) if (!body.name?.trim()) return "name is required";
  const kind = body.kind ?? "sql";
  if (kind !== "sql") {
    if (!partial || body.operation !== undefined) {
      const invalid = validateOperation(body.operation);
      if (invalid) return invalid;
    }
  } else {
    if (!partial || body.statementType !== undefined) if (!body.statementType || !STATEMENT_TYPES.includes(body.statementType)) return "statementType must be query or command";
    if (!partial || body.sql !== undefined) if (!body.sql?.trim()) return "sql is required";
  }
  if (body.params !== undefined) return validateSqlParams(body.params);
  return undefined;
}

async function dataSourceUsage(projectId: string, dataSourceId: string) {
  const source = await pool.query("SELECT id, name FROM data_sources WHERE id = $1 AND project_id = $2", [dataSourceId, projectId]);
  if (!source.rowCount) return undefined;
  const definitions = await pool.query("SELECT id, name FROM sql_definitions WHERE data_source_id = $1 ORDER BY name", [dataSourceId]);
  /* 递归扫描：循环体是内联子图，数据库节点完全可以躺在循环里。原先的
     `nodes @> '[{"dataSourceId": …}]'` 只看顶层数组元素，会把这种引用漏成「没人用」。 */
  const flows = await flowsReferencing(projectId, "dataSourceId", dataSourceId);
  return {
    dataSourceId, sqlDefinitions: definitions.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
    flows,
    blocked: Boolean(definitions.rowCount || flows.length),
  };
}

async function sqlUsage(projectId: string, sqlId: string) {
  const definition = await pool.query("SELECT id, name FROM sql_definitions WHERE id = $1 AND project_id = $2", [sqlId, projectId]);
  if (!definition.rowCount) return undefined;
  /* 同上：命名定义也会被循环体内的数据库节点引用。 */
  const flows = await flowsReferencing(projectId, "sqlDefinitionId", sqlId);
  return {
    sqlDefinitionId: sqlId,
    flows,
    blocked: Boolean(flows.length),
  };
}

/** The definition kind the data source can hold, or undefined when it does not
    exist in this project. A type-only lookup: no config, no decrypted password,
    so it is cheap enough to run on every definition write. */
async function definitionKindFor(projectId: string, dataSourceId: string): Promise<"sql" | "mongo" | "redis" | undefined> {
  const found = await pool.query("SELECT type FROM data_sources WHERE id = $1 AND project_id = $2", [dataSourceId, projectId]);
  if (!found.rowCount) return undefined;
  return definitionKind(String(found.rows[0].type) as DataSourceType);
}

/** A try-run payload, discriminated so the caller picks executeSql vs
    executeOperation without non-null assertions on the other kind's fields. */
type ResolvedRun =
  | { kind: "sql"; statementType: SqlStatementType; sql: string; params: SqlParameterDefinition[] }
  | { kind: "mongo" | "redis"; operation: unknown; params: SqlParameterDefinition[] };

async function resolveRun(projectId: string, dataSourceId: string, body: RunBody): Promise<ResolvedRun> {
  if (body.values !== undefined && (typeof body.values !== "object" || body.values === null || Array.isArray(body.values))) throw new Error("values must be an object");
  if (body.sqlDefinitionId) {
    if (!isUuid(body.sqlDefinitionId)) throw new Error("SQL definition not found");
    const definition = await loadSqlDefinition(projectId, body.sqlDefinitionId);
    if (!definition || definition.dataSourceId !== dataSourceId) throw new Error("SQL definition not found");
    if (definition.kind === "sql") {
      /* Migration 025 makes the shape a DB constraint, so a sql row always has
         both; the check keeps the type honest and turns any drift into a clear
         message instead of a driver-level surprise. */
      if (!definition.statementType || !definition.sql) throw new Error("SQL definition is missing its statement");
      return { kind: "sql", statementType: definition.statementType, sql: definition.sql, params: definition.params };
    }
    if (definition.operation === undefined) throw new Error("operation definition is missing its operation");
    return { kind: definition.kind, operation: definition.operation, params: definition.params };
  }
  const kind = body.kind ?? "sql";
  /* An inline try-run states its own kind, so it has to be checked against the
     data source before dispatch — otherwise a mongo body against a relational
     source only fails deep inside a driver, with a message about the wrong thing. */
  const sourceKind = await definitionKindFor(projectId, dataSourceId);
  if (!sourceKind) throw new Error("data source not found");
  if (kind !== sourceKind) throw new Error(`a ${sourceKind === "sql" ? "relational" : sourceKind} data source runs ${sourceKind} payloads, not ${kind}`);
  if (kind !== "sql") {
    const invalid = validateOperation(body.operation);
    if (invalid) throw new Error(invalid);
    return { kind, operation: body.operation, params: body.params ?? [] };
  }
  if (!body.statementType || !STATEMENT_TYPES.includes(body.statementType)) throw new Error("statementType must be query or command");
  if (!body.sql?.trim()) throw new Error("sql is required");
  const invalid = validateSqlDefinition(body.statementType, body.sql, body.params);
  if (invalid) throw new Error(invalid);
  return { kind: "sql", statementType: body.statementType, sql: body.sql, params: body.params ?? [] };
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
    if (!isSupportedDataSourceType(type)) return fail(reply, 400, 1001, `data source type "${type}" is not supported`);
    const invalid = validateConfig(request.body.config, type);
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
    if (request.body.type !== undefined && !isSupportedDataSourceType(request.body.type)) return fail(reply, 400, 1001, `data source type "${request.body.type}" is not supported`);
    if (request.body.password !== undefined && request.body.password !== null && typeof request.body.password !== "string") return fail(reply, 400, 1001, "password must be a string or null");
    const nextType = String(existing.rows[0].type) as DataSourceType;
    const config = request.body.config ? cleanConfig(request.body.config, existing.rows[0].config as DataSourceConfig, nextType) : existing.rows[0].config as DataSourceConfig;
    const invalid = validateConfig(config, nextType);
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
      /* Connection probe is per driver: SELECT 1 (dual for Oracle), a mongo
         count on a throwaway collection, or a redis PING. */
      const source = await loadDataSource(context.project.id, request.params.dataSourceId);
      const result = source.type === "mongodb"
        ? await executeOperation({ projectId: context.project.id, dataSourceId: request.params.dataSourceId, kind: "mongo", operation: { op: "count", collection: "apitest_ping" } })
        : source.type === "redis"
          ? await executeOperation({ projectId: context.project.id, dataSourceId: request.params.dataSourceId, kind: "redis", operation: { op: "command", command: "PING", args: [] } })
          : await executeSql({ projectId: context.project.id, dataSourceId: request.params.dataSourceId, statementType: "query", sql: source.type === "oracle" ? "SELECT 1 FROM dual" : "SELECT 1 AS ok" });
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
      const limits = { timeoutMs: request.body?.timeoutMs, maxRows: request.body?.maxRows, maxResultBytes: request.body?.maxResultBytes };
      const result = definition.kind === "sql"
        ? await executeSql({ projectId: context.project.id, dataSourceId: request.params.dataSourceId, statementType: definition.statementType, sql: definition.sql, params: definition.params, values: request.body?.values, ...limits })
        : await executeOperation({ projectId: context.project.id, dataSourceId: request.params.dataSourceId, kind: definition.kind, operation: definition.operation, params: definition.params, values: request.body?.values, ...limits });
      return success(result);
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
    const kind = request.body.kind ?? "sql";
    const invalid = validateSqlBody(request.body) ?? (kind === "sql" ? validateSqlDefinition(request.body.statementType!, request.body.sql!, request.body.params) : undefined);
    if (invalid) return fail(reply, 400, 1001, invalid);
    const source = await definitionKindFor(context.project.id, request.params.dataSourceId);
    if (!source) return fail(reply, 404, 2001, "data source not found");
    if (kind !== source) return fail(reply, 400, 1001, `a ${source === "sql" ? "relational" : source} data source holds ${source} definitions, not ${kind}`);
    const duplicate = await pool.query("SELECT 1 FROM sql_definitions WHERE data_source_id = $1 AND lower(name) = lower($2)", [request.params.dataSourceId, request.body.name!.trim()]);
    if (duplicate.rowCount) return fail(reply, 409, 2003, "an SQL definition with this name already exists");
    const result = await pool.query(
      `INSERT INTO sql_definitions (id, project_id, data_source_id, name, description, kind, statement_type, sql, operation, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb) RETURNING *`,
      [randomUUID(), context.project.id, request.params.dataSourceId, request.body.name!.trim(), request.body.description?.trim() ?? "", kind,
       kind === "sql" ? request.body.statementType : null, kind === "sql" ? request.body.sql!.trim() : null, kind === "sql" ? null : request.body.operation ?? null, JSON.stringify(request.body.params ?? [])],
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
    const nextKind = request.body.kind ?? existing.kind;
    const nextParams = request.body.params ?? existing.params;
    /* The data source's type decides the kind; a PUT may not move a definition
       to a kind its driver cannot run. */
    const sourceKind = await definitionKindFor(context.project.id, existing.dataSourceId);
    if (sourceKind && nextKind !== sourceKind) return fail(reply, 400, 1001, `a ${sourceKind === "sql" ? "relational" : sourceKind} data source holds ${sourceKind} definitions, not ${nextKind}`);
    if (nextKind === "sql") {
      /* Changing kind must carry the new kind's payload: a mongo/redis row has no
         sql to fall back on, and reaching `validateSqlDefinition` with undefined
         would throw instead of answering 400 (migration 025 enforces the same
         shape, so the DB would otherwise reject the UPDATE as a 500). */
      const nextType = request.body.statementType ?? existing.statementType; const nextSql = request.body.sql?.trim() ?? existing.sql;
      if (!nextType || !nextSql) return fail(reply, 400, 1001, "changing kind to sql requires statementType and sql");
      const statementInvalid = validateSqlDefinition(nextType, nextSql, nextParams);
      if (statementInvalid) return fail(reply, 400, 1001, statementInvalid);
    } else {
      if (request.body.operation === undefined && existing.operation === undefined) return fail(reply, 400, 1001, `changing kind to ${nextKind} requires an operation`);
      if (request.body.operation !== undefined) {
        const operationInvalid = validateOperation(request.body.operation);
        if (operationInvalid) return fail(reply, 400, 1001, operationInvalid);
      }
    }
    const name = request.body.name?.trim();
    if (name) {
      const duplicate = await pool.query("SELECT 1 FROM sql_definitions WHERE data_source_id = $1 AND lower(name) = lower($2) AND id <> $3", [existing.dataSourceId, name, existing.id]);
      if (duplicate.rowCount) return fail(reply, 409, 2003, "an SQL definition with this name already exists");
    }
    const result = await pool.query(
      `UPDATE sql_definitions SET name = COALESCE($1, name), description = COALESCE($2, description), kind = $3,
        statement_type = CASE WHEN $3 = 'sql' THEN COALESCE($4, statement_type) ELSE NULL END,
        sql = CASE WHEN $3 = 'sql' THEN COALESCE($5, sql) ELSE NULL END,
        operation = CASE WHEN $3 = 'sql' THEN NULL ELSE COALESCE($6::jsonb, operation) END,
        params = $7::jsonb, updated_at = now() WHERE id = $8 AND project_id = $9 RETURNING *`,
      [name ?? null, request.body.description?.trim() ?? null, nextKind, request.body.statementType ?? null, request.body.sql?.trim() ?? null,
       request.body.operation !== undefined ? JSON.stringify(request.body.operation) : null, JSON.stringify(nextParams), existing.id, context.project.id],
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
      const limits = { timeoutMs: request.body?.timeoutMs, maxRows: request.body?.maxRows, maxResultBytes: request.body?.maxResultBytes };
      const result = definition.kind === "sql"
        ? await executeSql({ projectId: context.project.id, dataSourceId: definition.dataSourceId, statementType: definition.statementType!, sql: definition.sql!, params: definition.params, values: request.body?.values, ...limits })
        : await executeOperation({ projectId: context.project.id, dataSourceId: definition.dataSourceId, kind: definition.kind, operation: definition.operation, params: definition.params, values: request.body?.values, ...limits });
      return success(result);
    } catch (error) { return fail(reply, 400, 2002, error instanceof Error ? error.message : "SQL execution failed"); }
  });
}
