import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, auditFields, writeAuditLogAsync } from "../lib/audit.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapMock, mapMockRequestLog, type Mock, type MockMode, type MockProxyConfig, type MockResponse } from "../models/types.js";

type MockBody = { endpointId?: string | null; executionId?: string | null; name?: string; mode?: MockMode; enabled?: boolean; priority?: number; requestMatch?: Record<string, unknown>; response?: MockResponse; proxyConfig?: MockProxyConfig; delayMs?: number };
type TestBody = { method?: string; path?: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown };
const MODES: MockMode[] = ["auto", "fixed", "template", "proxy"];

/**
 * 列表用的投影（P11 归属列，边界 7/9）：`LEFT JOIN users` 带出 email 快照。
 * 基表显式 `m.*`——裸 `*` 会在两表同名的 id / name / created_at 上取到 users 的值，
 * 把整行映射悄悄换成人表的字段。
 */
const SELECT_MOCK = `SELECT m.*, creator.email AS created_by_email, updater.email AS updated_by_email FROM mocks m
  LEFT JOIN users creator ON creator.id = m.created_by
  LEFT JOIN users updater ON updater.id = m.updated_by`;

function validate(body: MockBody, partial = false): string | undefined {
  if (!partial || body.name !== undefined) if (!body.name?.trim()) return "name is required";
  if (!partial || body.mode !== undefined) if (!body.mode || !MODES.includes(body.mode)) return "mode must be auto, fixed, template, or proxy";
  if (body.endpointId !== undefined && body.endpointId !== null && !isUuid(body.endpointId)) return "endpointId must be a uuid";
  if (body.priority !== undefined && !Number.isInteger(body.priority)) return "priority must be an integer";
  if (body.delayMs !== undefined && (!Number.isInteger(body.delayMs) || body.delayMs < 0 || body.delayMs > 30_000)) return "delayMs must be between 0 and 30000";
  if (body.response !== undefined && (!Number.isInteger(body.response.statusCode) || body.response.statusCode < 100 || body.response.statusCode > 599)) return "response.statusCode must be a valid HTTP status";
  if (body.proxyConfig !== undefined) {
    let target: URL; try { target = new URL(body.proxyConfig.targetUrl); } catch { return "proxyConfig.targetUrl must be an http URL"; }
    if (!/^https?:$/.test(target.protocol)) return "proxyConfig.targetUrl must be an http URL";
    if (!Array.isArray(body.proxyConfig.allowedHosts) || !body.proxyConfig.allowedHosts.length || !body.proxyConfig.allowedHosts.every((host) => typeof host === "string" && host.trim())) return "proxyConfig.allowedHosts must list permitted target hosts";
    if (!Number.isInteger(body.proxyConfig.timeoutMs) || body.proxyConfig.timeoutMs < 100 || body.proxyConfig.timeoutMs > 30_000) return "proxyConfig.timeoutMs must be between 100 and 30000";
    if (!Number.isInteger(body.proxyConfig.maxResponseBytes) || body.proxyConfig.maxResponseBytes < 1 || body.proxyConfig.maxResponseBytes > 5_242_880) return "proxyConfig.maxResponseBytes must be between 1 and 5242880";
    if (body.proxyConfig.pathMode !== undefined && !["append", "fixed", "replace"].includes(body.proxyConfig.pathMode)) return "proxyConfig.pathMode must be append, fixed, or replace";
    if (body.proxyConfig.queryMode !== undefined && !["forward", "drop", "append"].includes(body.proxyConfig.queryMode)) return "proxyConfig.queryMode must be forward, drop, or append";
    if (body.proxyConfig.fixedQuery !== undefined && (typeof body.proxyConfig.fixedQuery !== "object" || body.proxyConfig.fixedQuery === null || Array.isArray(body.proxyConfig.fixedQuery) || Object.values(body.proxyConfig.fixedQuery).some((value) => typeof value !== "string"))) return "proxyConfig.fixedQuery must map string keys to string values";
  }
  return undefined;
}

function responseBytes(response: MockResponse) { return Buffer.byteLength(typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? "")); }

/** Trim free-text proxy fields so a trailing space typed into the form cannot
    become a dirty target URL that builds a wrong path. */
function cleanProxyConfig(config: MockProxyConfig | undefined): MockProxyConfig | undefined {
  if (!config) return undefined;
  return { ...config, targetUrl: config.targetUrl.trim(), allowedHosts: config.allowedHosts.map((host) => host.trim()) };
}

function readPathValue(path: string, query: Record<string, unknown>, body: unknown, key: string): string {
  if (key === "path") return path;
  /* `{{body}}` is useful when the mock simply echoes the complete request body. */
  if (key === "body") return typeof body === "string" ? body : JSON.stringify(body ?? "");
  const source = key.startsWith("query.") ? query : key.startsWith("body.") && body && typeof body === "object" ? body as Record<string, unknown> : {};
  const value = key.replace(/^(query|body)\./, "").split(".").reduce<unknown>((current, segment) => current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined, source);
  return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
}

function render(value: unknown, path: string, query: Record<string, unknown>, body: unknown): unknown {
  if (typeof value === "string") {
    /* A whole-body token replaces the response body structurally; nested tokens remain text interpolation. */
    if (value.trim() === "{{body}}") return body;
    return value.replace(/{{\s*([^{}]+?)\s*}}/g, (_, key: string) => readPathValue(path, query, body, key));
  }
  if (Array.isArray(value)) return value.map((item) => render(item, path, query, body));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, path, query, body)]));
  return value;
}

function matches(rule: Record<string, unknown>, method: string, path: string) {
  return (!rule.method || String(rule.method).toUpperCase() === method) && (!rule.path || String(rule.path) === path);
}

async function recordLog(mockId: string | undefined, method: string, path: string, matched: boolean, statusCode: number, started: number, requestSnapshot: Record<string, unknown>, size: number) {
  await pool.query("INSERT INTO mock_request_logs (id, mock_id, method, path, matched, status_code, duration_ms, request_snapshot, response_size_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)", [randomUUID(), mockId ?? null, method, path, matched, statusCode, Date.now() - started, JSON.stringify(requestSnapshot), size]);
}

function buildProxyTarget(config: MockProxyConfig, path: string, query: Record<string, unknown>): string {
  const base = new URL(config.targetUrl);
  const requestPath = path.replace(/^\//, "");
  /* pathMode: append keeps the target's own path and appends the mock path,
     fixed ignores the mock path, replace uses the mock path verbatim. */
  if (config.pathMode === "fixed") {
    // keep base.pathname unchanged
  } else if (config.pathMode === "replace") {
    base.pathname = `/${requestPath}`;
  } else {
    const basePath = base.pathname.replace(/\/$/, "");
    base.pathname = `${basePath}/${requestPath}`;
  }
  /* queryMode: forward passes the mock request query, drop strips it, append
     forwards and then adds fixedQuery on top. */
  if (config.queryMode === "drop") {
    base.search = "";
  } else {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) params.append(key, String(value));
    if (config.queryMode === "append") for (const [key, value] of Object.entries(config.fixedQuery ?? {})) params.append(key, value);
    base.search = params.toString();
  }
  return base.toString();
}

async function proxy(mock: Mock, path: string, query: Record<string, unknown>, method: string, headers: Record<string, string>, body: unknown) {
  const config = mock.proxyConfig!;
  const target = buildProxyTarget(config, path, query);
  if (!config.allowedHosts.includes(new URL(target).hostname)) return { statusCode: 502, headers: { "content-type": "application/json" }, body: { message: "proxy target is not allowlisted" } };
  const safeHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => !["authorization", "cookie", "host", "connection", "content-length"].includes(key.toLowerCase())));
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    /* Forward the body as-is when it is already a string or raw bytes, so text,
       form and multipart payloads reach the target unchanged. Parsed JSON
       objects are the only case that needs re-serialising. */
    const forwardBody = body === undefined || body === null || method === "GET" || method === "HEAD"
      ? undefined
      : (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body));
    const response = await fetch(target, { method, headers: safeHeaders, body: forwardBody as BodyInit | undefined, signal: controller.signal });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > config.maxResponseBytes) return { statusCode: 502, headers: { "content-type": "application/json" }, body: { message: "proxy response exceeds configured limit" } };
    return { statusCode: response.status, headers: Object.fromEntries([...response.headers].filter(([key]) => !["connection", "transfer-encoding"].includes(key.toLowerCase()))), body: Buffer.from(bytes).toString("utf8") };
  } catch { return { statusCode: 504, headers: { "content-type": "application/json" }, body: { message: "proxy timeout" } }; }
  finally { clearTimeout(timer); }
}

async function getMock(projectId: string, mockId: string) {
  const result = await pool.query("SELECT * FROM mocks WHERE id = $1 AND project_id = $2", [mockId, projectId]);
  return result.rowCount ? result.rows[0] : undefined;
}

async function autoResponse(projectId: string, endpointId: string | null | undefined, executionId: string | null | undefined): Promise<MockResponse | undefined> {
  if (!endpointId || !executionId) return undefined;
  const result = await pool.query("SELECT status_code, response_headers, response_body FROM executions WHERE id = $1 AND project_id = $2 AND endpoint_id = $3 AND status = 'success'", [executionId, projectId, endpointId]);
  if (!result.rowCount) return undefined;
  const row = result.rows[0];
  return { statusCode: Number(row.status_code ?? 200), headers: (row.response_headers ?? { "content-type": "application/json" }) as Record<string, string>, body: row.response_body ?? "" };
}

export async function mockRoutes(app: FastifyInstance) {
  /* The public runtime must forward non-JSON bodies (text, form, multipart)
     byte-for-byte. Fastify only parses application/json by default, so any
     other content type is captured here as a raw buffer and passed through.
     application/json still resolves to the built-in parser because Fastify
     prefers an exact content-type match over this '*' fallback. */
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.all<{ Params: { publicId: string; "*": string } }>("/mock/:publicId/*", async (request, reply) => {
    const started = Date.now(); const path = `/${request.params["*"] ?? ""}`; const method = request.method.toUpperCase();
    const query = request.query as Record<string, unknown>; const body = request.body;
    /* Buffers serialise into {"type":"Buffer","data":[...]} if left to JSON, so
       the snapshot stores a readable string instead. `Buffer.isBuffer` rather
       than `instanceof Uint8Array`: the '*' parser hands back a Node Buffer,
       whose toString(encoding) signature the DOM lib's Uint8Array lacks. */
    const snapshot = { query, headers: request.headers, body: Buffer.isBuffer(body) ? body.toString("utf8") : body };
    const candidates = await pool.query("SELECT * FROM mocks WHERE public_id = $1 AND enabled = true ORDER BY priority DESC, created_at DESC", [request.params.publicId]);
    const row = candidates.rows.find((candidate) => matches((candidate.request_match ?? {}) as Record<string, unknown>, method, path));
    if (!row) { await recordLog(undefined, method, path, false, 404, started, snapshot, 0); return reply.code(404).send({ message: "mock rule not found" }); }
    const mock = mapMock(row);
    if (mock.delayMs) await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
    const response = mock.mode === "proxy" ? await proxy(mock, path, query, method, request.headers as Record<string, string>, body) : mock.mode === "template" ? render(mock.response, path, query, body) as MockResponse : mock.response;
    const size = responseBytes(response); await recordLog(mock.id, method, path, true, response.statusCode, started, snapshot, size);
    return reply.code(response.statusCode).headers(response.headers).send(response.body);
  });
  app.get<{ Params: { id: string }; Querystring: { page?: string; pageSize?: string } }>("/api/v1/projects/:id/mocks", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    /* Pagination is opt-in: no other caller needs the whole list today, but the
       unpaged shape stays so the contract remains "give me everything" unless
       the client explicitly asks for a page. */
    if (request.query.pageSize === undefined) {
      const result = await pool.query(`${SELECT_MOCK} WHERE m.project_id = $1 ORDER BY m.priority DESC, m.created_at DESC`, [context.project.id]);
      return success(result.rows.map(mapMock));
    }
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const count = await pool.query("SELECT COUNT(*)::int AS total FROM mocks WHERE project_id = $1", [context.project.id]);
    const result = await pool.query(`${SELECT_MOCK} WHERE m.project_id = $1 ORDER BY m.priority DESC, m.created_at DESC LIMIT $2 OFFSET $3`, [context.project.id, pageSize, (page - 1) * pageSize]);
    return success(result.rows.map(mapMock), { page, pageSize, total: Number(count.rows[0].total) });
  });

  app.post<{ Params: { id: string }; Body: MockBody }>("/api/v1/projects/:id/mocks", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const body = request.body ?? {}; const invalid = validate(body); if (invalid) return fail(reply, 400, 1001, invalid);
    if (body.endpointId) {
      const endpoint = await pool.query("SELECT 1 FROM endpoints WHERE id = $1 AND project_id = $2", [body.endpointId, context.project.id]);
      if (!endpoint.rowCount) return fail(reply, 404, 2001, "endpoint not found");
    }
    const snapshot = body.mode === "auto" ? await autoResponse(context.project.id, body.endpointId, body.executionId) : undefined;
    if (body.mode === "auto" && !snapshot) return fail(reply, 400, 1001, "auto mode needs a selected successful execution");
    const response: MockResponse = snapshot ?? body.response ?? { statusCode: 200, headers: { "content-type": "application/json" }, body: "{}" };
    const result = await pool.query(
      "INSERT INTO mocks (id, project_id, endpoint_id, snapshot_execution_id, name, public_id, mode, enabled, priority, request_match, response, proxy_config, delay_ms, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14) RETURNING *",
      [randomUUID(), context.project.id, body.endpointId ?? null, body.mode === "auto" ? body.executionId ?? null : null, body.name!.trim(), randomBytes(18).toString("base64url"), body.mode!, body.enabled ?? true, body.priority ?? 0, JSON.stringify(body.requestMatch ?? {}), JSON.stringify(response), cleanProxyConfig(body.proxyConfig) ? JSON.stringify(cleanProxyConfig(body.proxyConfig)) : null, body.delayMs ?? 0, context.user.id],
    );
    /* P11-9 审计（边界 5/6）：detail 只有字段名，响应体（可能含业务数据）绝不进。 */
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.mockCreate, targetType: "mock", targetId: String(result.rows[0].id),
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(body) }, ip: request.ip,
    });
    return reply.code(201).send(success(mapMock(result.rows[0])));
  });

  app.get<{ Params: { id: string; mockId: string } }>("/api/v1/projects/:id/mocks/:mockId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.mockId)) return fail(reply, 404, 2001, "mock not found");
    const mock = await getMock(context.project.id, request.params.mockId); if (!mock) return fail(reply, 404, 2001, "mock not found");
    return success(mapMock(mock));
  });

  app.put<{ Params: { id: string; mockId: string }; Body: MockBody }>("/api/v1/projects/:id/mocks/:mockId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.mockId)) return fail(reply, 404, 2001, "mock not found");
    const current = await getMock(context.project.id, request.params.mockId); if (!current) return fail(reply, 404, 2001, "mock not found");
    const body = request.body ?? {}; const invalid = validate(body, true); if (invalid) return fail(reply, 400, 1001, invalid);
    if (body.endpointId) {
      const endpoint = await pool.query("SELECT 1 FROM endpoints WHERE id = $1 AND project_id = $2", [body.endpointId, context.project.id]);
      if (!endpoint.rowCount) return fail(reply, 404, 2001, "endpoint not found");
    }
    /* Updating an auto mock must re-freeze the selected execution. Keeping only
       the pointer would make the UI show a new snapshot while Runtime still
       served the old response JSON. */
    const nextMode = body.mode ?? String(current.mode) as MockMode;
    const snapshot = nextMode === "auto"
      ? await autoResponse(context.project.id, body.endpointId ?? (current.endpoint_id ? String(current.endpoint_id) : undefined), body.executionId)
      : undefined;
    if (nextMode === "auto" && !snapshot) return fail(reply, 400, 1001, "auto mode needs a selected successful execution");
    const nextResponse = snapshot ?? (nextMode === "auto" ? undefined : body.response);
    const result = await pool.query(
      "UPDATE mocks SET endpoint_id = COALESCE($1, endpoint_id), snapshot_execution_id = CASE WHEN $2 = 'auto' THEN $3::uuid WHEN $2 IS NOT NULL THEN NULL ELSE snapshot_execution_id END, name = COALESCE($4, name), mode = COALESCE($2, mode), enabled = COALESCE($5, enabled), priority = COALESCE($6, priority), request_match = COALESCE($7::jsonb, request_match), response = COALESCE($8::jsonb, response), proxy_config = COALESCE($9::jsonb, proxy_config), delay_ms = COALESCE($10, delay_ms), updated_by = $13, updated_at = now() WHERE id = $11 AND project_id = $12 RETURNING *",
      [body.endpointId ?? null, body.mode ?? null, nextMode === "auto" ? body.executionId ?? null : null, body.name?.trim() ?? null, body.enabled ?? null, body.priority ?? null, body.requestMatch === undefined ? null : JSON.stringify(body.requestMatch), nextResponse === undefined ? null : JSON.stringify(nextResponse), body.proxyConfig === undefined ? null : JSON.stringify(cleanProxyConfig(body.proxyConfig)), body.delayMs ?? null, request.params.mockId, context.project.id, context.user.id],
    );
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.mockUpdate, targetType: "mock", targetId: request.params.mockId,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(body) }, ip: request.ip,
    });
    return success(mapMock(result.rows[0]));
  });

  app.delete<{ Params: { id: string; mockId: string } }>("/api/v1/projects/:id/mocks/:mockId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.mockId)) return fail(reply, 404, 2001, "mock not found");
    const result = await pool.query("DELETE FROM mocks WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.mockId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "mock not found");
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.mockDelete, targetType: "mock", targetId: String(result.rows[0].id),
      projectId: context.project.id, userId: context.user.id, ip: request.ip,
    });
    return success({ id: String(result.rows[0].id) });
  });

  app.get<{ Params: { id: string; mockId: string }; Querystring: { page?: string; pageSize?: string } }>("/api/v1/projects/:id/mocks/:mockId/logs", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.mockId) || !await getMock(context.project.id, request.params.mockId)) return fail(reply, 404, 2001, "mock not found");
    const page = Math.max(1, Number(request.query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const [rows, count] = await Promise.all([pool.query("SELECT * FROM mock_request_logs WHERE mock_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3", [request.params.mockId, pageSize, (page - 1) * pageSize]), pool.query("SELECT COUNT(*)::int AS total FROM mock_request_logs WHERE mock_id = $1", [request.params.mockId])]);
    return success(rows.rows.map(mapMockRequestLog), { page, pageSize, total: Number(count.rows[0].total) });
  });

  app.post<{ Params: { id: string; mockId: string }; Body: TestBody }>("/api/v1/projects/:id/mocks/:mockId/test", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.mockId)) return fail(reply, 404, 2001, "mock not found");
    const mock = await getMock(context.project.id, request.params.mockId); if (!mock) return fail(reply, 404, 2001, "mock not found");
    return success({ matched: true, statusCode: (mock.response as MockResponse).statusCode, response: mock.response });
  });
}
