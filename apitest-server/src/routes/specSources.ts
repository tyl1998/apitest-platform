import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, auditFields, writeAuditLogAsync } from "../lib/audit.js";
import { currentUser } from "../lib/auth.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { requireSystemAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { getSpecSourceDriver, isSupportedSpecSourceType } from "../lib/specDrivers/index.js";
import { readAdapterConfig } from "../lib/specDrivers/adapterConfig.js";
import type { SourceOperation, SpecSourceContext } from "../lib/specDrivers/types.js";
import { isHttpUrl } from "../lib/specFetch.js";
import { isUuid } from "../lib/uuid.js";
import { mapSpecSource, type SpecSource } from "../models/types.js";

/**
 * 接口来源（P17）。全系统级一张表（不设项目级来源）。
 *
 * 读 / 搜**全员可用**（登录即可）——来源是「接口定义在哪」的公开信息；管理面
 * （建 / 改 / 删 / 刷新）`requireSystemAdmin`。预填**不落库**：搜索命中的 operation
 * 转成 EndpointInput 形状回给前端填表单，用户确认后走既有 `POST /endpoints`。
 *
 * 取数快照优先：快照型来源（openapi / apifox）的一次全量归一结果落**派生索引表**
 * `spec_source_operations`（迁移 078），创建时本地搜；只有创建与显式 refresh 才回源取数
 * （不做后台轮询）。搜索只读 `search_text` 命中行再取 payload，读写量与命中数相关，不再
 * 读整份快照。检索型来源（adapter 的 `search()`）无快照、实时透传。
 */

/* 2008 = 来源取数失败（502）。与助手上游失败（2006/2007）分开：处置动作不同——
   那是「agent 平台挂了」，这是「这条来源 URL 取不到或返回不合法」。 */
const CODE_SOURCE_FETCH = 2008;

const MAX_NAME_CHARS = 100;
const MAX_KEYWORD_CHARS = 200;
/** 单次搜索返回上限：来源 spec 可能上千个 operation，关键词为空时不能整份回传。 */
const MAX_RESULTS = 200;

type SourceBody = {
  name?: unknown;
  type?: unknown;
  url?: unknown;
  credential?: unknown;
  config?: unknown;
  isTemporary?: unknown;
};

const SELECT_SOURCE = `SELECT s.id, s.name, s.type, s.url, s.credential_cipher, s.config,
    s.is_temporary, s.status, s.cache_fetched_at, s.created_by, s.created_at, s.updated_at,
    creator.email AS created_by_email,
    (SELECT count(*) FROM spec_source_operations o WHERE o.source_id = s.id) AS operation_count
  FROM spec_sources s LEFT JOIN users creator ON creator.id = s.created_by`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 配置校验（驱动私有选项）：允许标量与一层对象（adapter 的 `fieldMap` / `extraHeaders`
 * 是对象）。不做深校验，深对错由类型专属校验（`validateSourceConfig`）与取数回答。
 */
function readConfig(input: unknown): Record<string, unknown> | string {
  if (input === undefined || input === null) return {};
  if (!isRecord(input)) return "config must be an object";
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const name = key.trim();
    if (!name) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && !isRecord(value)) {
      return `config value "${name}" must be a string, number, boolean or object`;
    }
    config[name] = value;
  }
  return config;
}

/** 类型相关的配置校验（建 / 改共用）：adapter 的检索描述必须齐全。 */
function validateSourceConfig(type: string, config: Record<string, unknown>): string | undefined {
  if (type === "adapter") {
    const parsed = readAdapterConfig(config);
    if ("error" in parsed) return parsed.error;
  }
  return undefined;
}

async function nameTaken(name: string, excludeId?: string): Promise<boolean> {
  const result = excludeId
    ? await pool.query("SELECT 1 FROM spec_sources WHERE lower(name) = lower($1) AND id <> $2", [name, excludeId])
    : await pool.query("SELECT 1 FROM spec_sources WHERE lower(name) = lower($1)", [name]);
  return Boolean(result.rowCount);
}

async function loadSourceRow(id: string): Promise<Record<string, unknown> | undefined> {
  const result = await pool.query(`${SELECT_SOURCE} WHERE s.id = $1`, [id]);
  return result.rows[0];
}

/** 驱动取数上下文：凭据密文解密成明文只在内存里存在这一趟（读回永不下发）。 */
function sourceContext(row: Record<string, unknown>): SpecSourceContext {
  let credential: string | undefined;
  if (row.credential_cipher) credential = decryptSecret(row.credential_cipher as Buffer);
  return { url: String(row.url), credential, config: (row.config ?? {}) as Record<string, unknown> };
}

/** 搜索用的小写干草堆（与迁移 078 的回填口径一致）：命中判断只读这一列，不读整份 payload。 */
function searchTextOf(operation: SourceOperation): string {
  return [operation.method, operation.path, operation.summary, operation.description, ...(operation.tags ?? [])]
    .map((value) => String(value ?? "")).join(" ").toLowerCase();
}

/** 把一次快照整来源重写进派生索引表（事务内先删后插），并把状态打回 ok。 */
async function writeSnapshot(sourceId: string, operations: SourceOperation[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM spec_source_operations WHERE source_id = $1", [sourceId]);
    if (operations.length) {
      await client.query(
        `INSERT INTO spec_source_operations (source_id, method, path, summary, search_text, payload)
         SELECT $1::uuid, u.method, u.path, u.summary, u.search_text, u.payload::jsonb
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
           AS u(method, path, summary, search_text, payload)
         ON CONFLICT (source_id, method, path) DO UPDATE
           SET summary = EXCLUDED.summary, search_text = EXCLUDED.search_text, payload = EXCLUDED.payload`,
        [
          sourceId,
          operations.map((operation) => operation.method),
          operations.map((operation) => operation.path),
          operations.map((operation) => operation.summary ?? ""),
          operations.map(searchTextOf),
          operations.map((operation) => JSON.stringify(operation)),
        ],
      );
    }
    /* cache 不再写（派生表是事实来源）；显式置空避免两份大 JSON 并存。 */
    await client.query(
      "UPDATE spec_sources SET status = 'ok', cache_fetched_at = now(), cache = NULL, updated_at = now() WHERE id = $1",
      [sourceId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 回源取一次快照并写回派生索引。成功写 status='ok'；失败清掉旧快照、status='error' 并回错误串。 */
async function refreshSource(row: Record<string, unknown>): Promise<{ ok: true; operations: SourceOperation[]; etag?: string } | { ok: false; error: string }> {
  const type = String(row.type);
  const driver = await getSpecSourceDriver(type);
  const list = driver?.list;
  if (!list) return { ok: false, error: `spec source type "${type}" cannot be refreshed (no snapshot support)` };
  try {
    const operations = await list(sourceContext(row));
    await writeSnapshot(String(row.id), operations);
    return { ok: true, operations };
  } catch (error) {
    await pool.query("DELETE FROM spec_source_operations WHERE source_id = $1", [row.id]);
    await pool.query("UPDATE spec_sources SET cache_fetched_at = NULL, status = 'error', updated_at = now() WHERE id = $1", [row.id]);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 快照型来源的本地搜（边界 4）：只读小列 `search_text` 找命中行，再取命中行的 payload。
 * `strpos` 是字面子串匹配（无需给 LIKE 转义通配符）。读写量与「命中数」相关，而非快照总量。
 */
async function searchSnapshot(sourceId: string, keyword: string): Promise<SourceOperation[]> {
  const needle = keyword.trim().toLowerCase();
  const params: unknown[] = [sourceId];
  let where = "source_id = $1";
  if (needle) { params.push(needle); where += ` AND strpos(search_text, $${params.length}) > 0`; }
  params.push(MAX_RESULTS);
  const result = await pool.query(
    `SELECT payload FROM spec_source_operations WHERE ${where} ORDER BY path LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => row.payload as SourceOperation);
}

/**
 * 搜一个来源（边界 1/4）：有 `list()` 的（openapi / apifox）走派生索引本地搜；只有
 * `search()` 的（adapter）实时透传给远端。远端失败回空——聚合搜不该被一个坏来源整体拖垮。
 */
async function searchSource(row: Record<string, unknown>, keyword: string): Promise<SourceOperation[]> {
  const driver = await getSpecSourceDriver(String(row.type));
  if (!driver) return [];
  if (!driver.list && driver.search) {
    try { return await driver.search(sourceContext(row), keyword); }
    catch { return []; }
  }
  return searchSnapshot(String(row.id), keyword);
}

/** 归一 operation → 预填形状：url 补 `{{baseUrl}}` 前缀（与路径清单导入同形，边界 6）。 */
function operationView(source: Record<string, unknown>, operation: SourceOperation) {
  return {
    method: operation.method,
    url: `{{baseUrl}}${operation.path}`,
    path: operation.path,
    name: operation.summary || `${operation.method} ${operation.path}`,
    description: operation.description,
    headers: operation.headers ?? {},
    queryParams: operation.queryParams ?? {},
    pathParams: operation.pathParams ?? {},
    bodyType: operation.bodyType,
    body: operation.body,
    tags: operation.tags ?? [],
    sourceId: String(source.id),
    sourceName: String(source.name),
    sources: [String(source.name)] as string[],
  };
}

function readSourceIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(raw.map((item) => String(item).trim()).filter(isUuid))];
}

export async function specSourceRoutes(app: FastifyInstance) {
  /* ── 读 / 搜：全员可用（登录即可）─────────────────────────────────────────── */

  app.get<{ Querystring: { type?: string } }>("/api/v1/spec-sources", async (request, reply) => {
    if (!(await currentUser(request, reply))) return;
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (request.query.type?.trim()) { params.push(request.query.type.trim()); clauses.push(`s.type = $${params.length}`); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(`${SELECT_SOURCE}${where} ORDER BY s.is_temporary, s.name`, params);
    return success(result.rows.map(mapSpecSource), { total: result.rowCount });
  });

  app.get<{ Params: { sourceId: string }; Querystring: { keyword?: string } }>("/api/v1/spec-sources/:sourceId/operations", async (request, reply) => {
    if (!(await currentUser(request, reply))) return;
    if (!isUuid(request.params.sourceId)) return fail(reply, 404, 2001, "spec source not found");
    const row = await loadSourceRow(request.params.sourceId);
    if (!row) return fail(reply, 404, 2001, "spec source not found");
    const keyword = (request.query.keyword ?? "").slice(0, MAX_KEYWORD_CHARS);
    const operations = (await searchSource(row, keyword)).slice(0, MAX_RESULTS);
    return success(operations.map((operation) => operationView(row, operation)), { total: operations.length });
  });

  app.get<{ Querystring: { keyword?: string; sourceIds?: string } }>("/api/v1/spec-sources/search", async (request, reply) => {
    if (!(await currentUser(request, reply))) return;
    /* 不勾来源不允许搜索（前端本就禁用了搜索框，这里是服务端兜底）。 */
    const sourceIds = readSourceIds(request.query.sourceIds);
    if (!sourceIds.length) return fail(reply, 400, 1001, "at least one spec sourceId is required");
    const keyword = (request.query.keyword ?? "").slice(0, MAX_KEYWORD_CHARS);

    const sources = await pool.query(`${SELECT_SOURCE} WHERE s.id = ANY($1::uuid[])`, [sourceIds]);
    /* 各来源并发搜：远端适配器是逐来源网络往返，串行会叠加延迟（2026-10-10 性能）。 */
    const perSource = await Promise.all(sources.rows.map(async (source) => ({ source, operations: await searchSource(source, keyword) })));
    const merged = new Map<string, ReturnType<typeof operationView>>();
    for (const { source, operations } of perSource) {
      for (const operation of operations) {
        const view = operationView(source, operation);
        const key = `${view.method} ${view.url}`;
        const existing = merged.get(key);
        if (existing) {
          /* (method, url) 多来源命中去重保留一条，标签列出来源（边界 9）。 */
          if (!existing.sources.includes(view.sourceName)) existing.sources.push(view.sourceName);
        } else if (merged.size < MAX_RESULTS) {
          merged.set(key, view);
        }
      }
    }
    const items = [...merged.values()];
    return success(items, { total: items.length, truncated: merged.size >= MAX_RESULTS });
  });

  /* ── 管理：仅系统管理员 ──────────────────────────────────────────────────── */

  app.post<{ Body: SourceBody }>("/api/v1/spec-sources", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!name) return fail(reply, 400, 1001, "spec source name is required");
    if (name.length > MAX_NAME_CHARS) return fail(reply, 400, 1001, `spec source name is too long (max ${MAX_NAME_CHARS} characters)`);
    const type = typeof request.body?.type === "string" ? request.body.type.trim() : "";
    if (!type) return fail(reply, 400, 1001, "spec source type is required");
    if (!isSupportedSpecSourceType(type)) return fail(reply, 400, 1001, `unsupported spec source type "${type}"`);
    const url = typeof request.body?.url === "string" ? request.body.url.trim() : "";
    if (!isHttpUrl(url)) return fail(reply, 400, 1001, "spec source url must be an http(s) URL");
    if (request.body?.isTemporary !== undefined && typeof request.body.isTemporary !== "boolean") return fail(reply, 400, 1001, "isTemporary must be a boolean");
    const config = readConfig(request.body?.config);
    if (typeof config === "string") return fail(reply, 400, 1001, config);
    const configError = validateSourceConfig(type, config);
    if (configError) return fail(reply, 400, 1001, configError);
    let credential: Buffer | null = null;
    if (request.body?.credential !== undefined && request.body?.credential !== null) {
      if (typeof request.body.credential !== "string") return fail(reply, 400, 1001, "credential must be a string or null");
      credential = encryptSecret(request.body.credential);
    }
    if (await nameTaken(name)) return fail(reply, 409, 2003, "a spec source with this name already exists");

    const inserted = await pool.query(
      `INSERT INTO spec_sources (id, name, type, url, credential_cipher, config, is_temporary, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING id`,
      [randomUUID(), name, type, url, credential, JSON.stringify(config), request.body?.isTemporary === true, user.id],
    ).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") return undefined;
      throw error;
    });
    if (!inserted) return fail(reply, 409, 2003, "a spec source with this name already exists");

    /* 建来源顺手取一次快照（不是后台轮询）：管理员立刻看到能不能取到；取不到也照样存，
       改好 URL 再显式刷新即可。 */
    const created = await loadSourceRow(String(inserted.rows[0].id));
    if (created) await refreshSource(created);

    writeAuditLogAsync({
      action: AUDIT_ACTIONS.specSourceCreate, targetType: "spec_source", targetId: String(inserted.rows[0].id),
      userId: user.id, detail: { fields: auditFields(request.body), type, isTemporary: request.body?.isTemporary === true }, ip: request.ip,
    });
    const row = await loadSourceRow(String(inserted.rows[0].id));
    return reply.code(201).send(success(mapSpecSource(row!)));
  });

  app.patch<{ Params: { sourceId: string }; Body: SourceBody }>("/api/v1/spec-sources/:sourceId", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    if (!isUuid(request.params.sourceId)) return fail(reply, 404, 2001, "spec source not found");
    const existing = await loadSourceRow(request.params.sourceId);
    if (!existing) return fail(reply, 404, 2001, "spec source not found");

    const sets: string[] = []; const params: unknown[] = [request.params.sourceId];
    if (request.body?.name !== undefined) {
      const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
      if (!name) return fail(reply, 400, 1001, "spec source name is required");
      if (name.length > MAX_NAME_CHARS) return fail(reply, 400, 1001, `spec source name is too long (max ${MAX_NAME_CHARS} characters)`);
      if (await nameTaken(name, request.params.sourceId)) return fail(reply, 409, 2003, "a spec source with this name already exists");
      params.push(name); sets.push(`name = $${params.length}`);
    }
    let retarget = false;
    if (request.body?.type !== undefined) {
      const type = typeof request.body.type === "string" ? request.body.type.trim() : "";
      if (!isSupportedSpecSourceType(type)) return fail(reply, 400, 1001, `unsupported spec source type "${type}"`);
      if (type !== String(existing.type)) retarget = true;
      params.push(type); sets.push(`type = $${params.length}`);
    }
    if (request.body?.url !== undefined) {
      const url = typeof request.body.url === "string" ? request.body.url.trim() : "";
      if (!isHttpUrl(url)) return fail(reply, 400, 1001, "spec source url must be an http(s) URL");
      if (url !== String(existing.url)) retarget = true;
      params.push(url); sets.push(`url = $${params.length}`);
    }
    let normalizedConfig: Record<string, unknown> | undefined;
    if (request.body?.config !== undefined) {
      const config = readConfig(request.body.config);
      if (typeof config === "string") return fail(reply, 400, 1001, config);
      normalizedConfig = config;
      params.push(JSON.stringify(config)); sets.push(`config = $${params.length}::jsonb`);
    }
    if (request.body?.isTemporary !== undefined) {
      if (typeof request.body.isTemporary !== "boolean") return fail(reply, 400, 1001, "isTemporary must be a boolean");
      params.push(request.body.isTemporary); sets.push(`is_temporary = $${params.length}`);
    }
    /* 凭据三态（照 environments 的 secret patch）：null 清除 / 字符串设置 / 缺省不动。 */
    if (request.body?.credential !== undefined) {
      if (request.body.credential !== null && typeof request.body.credential !== "string") return fail(reply, 400, 1001, "credential must be a string or null");
      params.push(request.body.credential === null ? null : encryptSecret(request.body.credential)); sets.push(`credential_cipher = $${params.length}`);
      retarget = true;
    }
    if (!sets.length) return fail(reply, 400, 1001, "nothing to update");

    /* 类型或配置变了才需要重校：用「本次生效的类型 + 生效的配置」判，改类型时旧配置可能不再成立。 */
    const effectiveType = typeof request.body?.type === "string" ? request.body.type.trim() : String(existing.type);
    const effectiveConfig = normalizedConfig ?? ((existing.config ?? {}) as Record<string, unknown>);
    const configError = validateSourceConfig(effectiveType, effectiveConfig);
    if (configError) return fail(reply, 400, 1001, configError);

    sets.push("updated_at = now()");
    await pool.query(`UPDATE spec_sources SET ${sets.join(", ")} WHERE id = $1`, params);
    const row = await loadSourceRow(request.params.sourceId);

    /* 地址 / 类型 / 凭据变了：旧快照是对旧目标的，重取一次整来源重写（失败留 status='error'）。 */
    if (retarget && row) await refreshSource(row);

    writeAuditLogAsync({
      action: AUDIT_ACTIONS.specSourceUpdate, targetType: "spec_source", targetId: request.params.sourceId,
      userId: user.id, detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return success(mapSpecSource((await loadSourceRow(request.params.sourceId))!));
  });

  app.delete<{ Params: { sourceId: string } }>("/api/v1/spec-sources/:sourceId", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    if (!isUuid(request.params.sourceId)) return fail(reply, 404, 2001, "spec source not found");
    const existing = await loadSourceRow(request.params.sourceId);
    if (!existing) return fail(reply, 404, 2001, "spec source not found");
    const deleted = await pool.query("DELETE FROM spec_sources WHERE id = $1 RETURNING id", [request.params.sourceId]);
    if (!deleted.rowCount) return fail(reply, 404, 2001, "spec source not found");
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.specSourceDelete, targetType: "spec_source", targetId: request.params.sourceId,
      userId: user.id, detail: { name: String(existing.name), type: String(existing.type) }, ip: request.ip,
    });
    return success({ id: deleted.rows[0].id });
  });

  app.post<{ Params: { sourceId: string } }>("/api/v1/spec-sources/:sourceId/refresh", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    if (!isUuid(request.params.sourceId)) return fail(reply, 404, 2001, "spec source not found");
    const row = await loadSourceRow(request.params.sourceId);
    if (!row) return fail(reply, 404, 2001, "spec source not found");
    /* 只有快照型来源（openapi 的 list()）能刷新；检索型（adapter 的 search()）是实时透传，
       没有快照可刷——400 而不是 502：不是取数失败，是这个类型本就没有这个动作。 */
    const driver = await getSpecSourceDriver(String(row.type));
    if (!driver?.list) return fail(reply, 400, 1001, "this spec source searches the remote live and has no snapshot to refresh");
    const outcome = await refreshSource(row);
    if (!outcome.ok) return fail(reply, 502, CODE_SOURCE_FETCH, outcome.error);
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.specSourceRefresh, targetType: "spec_source", targetId: request.params.sourceId,
      userId: user.id, detail: { operationCount: outcome.operations.length }, ip: request.ip,
    });
    return success(mapSpecSource((await loadSourceRow(request.params.sourceId))!));
  });
}
