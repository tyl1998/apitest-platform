import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { environmentSnapshot, recordAssetVersion } from "../lib/assetVersions.js";
import { AUDIT_ACTIONS, auditFields, writeAuditLogAsync } from "../lib/audit.js";
import { DEFAULT_RUNNER_LABEL, RUNNER_LABEL_PATTERN } from "../lib/queue.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { collectReferences } from "../lib/resolve.js";
import { isUuid } from "../lib/uuid.js";
import { mapEndpoint, mapEnvironment } from "../models/types.js";

type VariableInput = Record<string, string>;

/**
 * 列表投影（P11 归属列，边界 7/9）：`LEFT JOIN users` 带出 email 快照，基表显式
 * `ev.*`。注：`environments` 表没有 created_at / updated_at（001 起就没有），所以
 * 「系统改的」那条时间判据在这张表上不成立——`updated_by_email` 为 null 只表示
 * 「建后没改过」，前端显示「—」而不是「系统」。
 */
const SELECT_ENVIRONMENT = `SELECT ev.*, creator.email AS created_by_email, updater.email AS updated_by_email FROM environments ev
  LEFT JOIN users creator ON creator.id = ev.created_by
  LEFT JOIN users updater ON updater.id = ev.updated_by`;

/**
 * Secrets are written as a patch, not a replacement: the client never holds the
 * plaintext (Spec 4.6), so it cannot send back the full map. `null` means
 * "remove this key", a string means "set it", and an absent key means
 * "leave whatever is stored".
 */
type SecretPatch = Record<string, string | null>;

type EnvironmentBody = { name?: string; variables?: VariableInput; secrets?: SecretPatch; runnerLabel?: string; defaultHeaders?: Record<string, string> };

/**
 * P10-4：把一次环境写（`... RETURNING *`）与它的版本快照包进一个事务。无行回滚并回
 * `undefined`（调用方回 404）；命中则映射、落一版快照、提交、回映射后的 Environment。
 * 快照里的 secret **只有键名**（environmentSnapshot 取 mapEnvironment.secretKeys），不含值。
 */
async function writeEnvironmentWithVersion(
  context: { project: { id: string }; user: { id: string } },
  changeSummary: string,
  write: (client: PoolClient) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
): Promise<ReturnType<typeof mapEnvironment> | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await write(client);
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return undefined;
    }
    const environment = mapEnvironment(result.rows[0]);
    await recordAssetVersion(client, {
      projectId: context.project.id, assetType: "environment", assetId: environment.id,
      snapshot: environmentSnapshot(environment), changeSummary, createdBy: context.user.id,
    });
    await client.query("COMMIT");
    return environment;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 执行分区标签的校验（P2-8）。
 *
 * 校验放在这里而不是 CHECK 约束：标签会进 Redis key（`executions-<label>`），必须约束，
 * 但格式说明要能作为错误信息回给用户。返回 `undefined` 表示「本次没改这一列」。
 */
function normalizeRunnerLabel(input: string | undefined): { label?: string; error?: string } {
  if (input === undefined) return {};
  const label = input.trim() || DEFAULT_RUNNER_LABEL;
  if (!RUNNER_LABEL_PATTERN.test(label)) {
    return { error: "runnerLabel must be 1–32 characters of lowercase letters, digits or hyphens, starting with a letter or digit" };
  }
  return { label };
}

function cleanVariables(input: VariableInput | undefined): VariableInput | undefined {
  if (!input) return undefined;
  return Object.fromEntries(Object.entries(input).filter(([key]) => key.trim()).map(([key, value]) => [key.trim(), String(value ?? "")]));
}

/**
 * 环境默认头的校验与归一（P3-2，计划 6.5 泳道第一层）。
 *
 * 与 `normalizeRunnerLabel` 同一个 `{ value?, error? }` 形状：空名字段丢弃（与
 * `cleanVariables` 一致），非字符串值**拒绝而不是静默强转**——这是新字段，没有历史
 * 包袱，一个 400 比猜出来的值诚实。值可引用 `{{变量}}`（如
 * `{"X-Env-Tag": "{{lane}}"}`），在 `buildRequest` 里解析。大小写异体的同名键不在
 * 这里拒绝：合并发生在 `buildRequest`（大小写不敏感、后者胜），这里重复一套规则
 * 只会和它分叉。
 */
function normalizeDefaultHeaders(input: Record<string, string> | undefined): { headers?: Record<string, string>; error?: string } {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return { error: "defaultHeaders must be an object of string values" };
  const headers: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof value !== "string") return { error: `default header "${key}" must be a string` };
    headers[key] = value;
  }
  return { headers };
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
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/environments", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    if (!context) return;
    /**
     * 同一个数据源，两种读法：不带 `page` 的调用（各处环境选择器、projectStore）拿
     * 全量列表——选择器要的是「全部可选环境」，按关键字截断会让下拉里缺一个真实
     * 存在的环境；管理页带 `page`/`pageSize` 走服务端分页 + `keyword` 过滤（与
     * test-suites 同款：过滤在 SQL 里，命中覆盖全量而不是当前页）。
     */
    if (request.query.page !== undefined || request.query.pageSize !== undefined) {
      const page = Math.max(1, Number(request.query.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
      const params: unknown[] = [context.project.id]; const clauses = ["ev.project_id = $1"];
      if (request.query.keyword?.trim()) { params.push(`%${request.query.keyword.trim()}%`); clauses.push(`ev.name ILIKE $${params.length}`); }
      const where = clauses.join(" AND ");
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM environments ev WHERE ${where}`, params);
      params.push(pageSize, (page - 1) * pageSize);
      const result = await pool.query(`${SELECT_ENVIRONMENT} WHERE ${where} ORDER BY ev.name LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      return success(result.rows.map(mapEnvironment), { page, pageSize, total: Number(count.rows[0].total) });
    }
    const result = await pool.query(`${SELECT_ENVIRONMENT} WHERE ev.project_id = $1 ORDER BY ev.name`, [context.project.id]);
    return success(result.rows.map(mapEnvironment));
  });

  app.post<{ Params: { id: string }; Body: EnvironmentBody }>("/api/v1/projects/:id/environments", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    const name = request.body.name?.trim();
    if (!name) return fail(reply, 400, 1001, "environment name is required");
    const duplicate = await pool.query("SELECT 1 FROM environments WHERE project_id = $1 AND lower(name) = lower($2)", [context.project.id, name]);
    if (duplicate.rowCount) return fail(reply, 409, 1002, "an environment with this name already exists");
    const runner = normalizeRunnerLabel(request.body.runnerLabel);
    if (runner.error) return fail(reply, 400, 1001, runner.error);
    const defaults = normalizeDefaultHeaders(request.body.defaultHeaders);
    if (defaults.error) return fail(reply, 400, 1001, defaults.error);
    /* P10-4：行与首版快照同事务落（快照 secret 只含键名，绝不含值）。 */
    const environment = await writeEnvironmentWithVersion(context, "创建", (client) => client.query(
      "INSERT INTO environments (id, project_id, name, variables, secrets, runner_label, default_headers, created_by) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8) RETURNING *",
      [randomUUID(), context.project.id, name, JSON.stringify(cleanVariables(request.body.variables) ?? {}), JSON.stringify(applySecretPatch({}, request.body.secrets)), runner.label ?? DEFAULT_RUNNER_LABEL, JSON.stringify(defaults.headers ?? {}), context.user.id],
    ));
    if (!environment) return fail(reply, 404, 2001, "environment not found");
    /* P11-9 审计（边界 5/6）：detail 只有字段名，**secret 的键名也不进**——只报 body 的键。 */
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.environmentCreate, targetType: "environment", targetId: environment.id,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return reply.code(201).send(success(environment));
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
    const runner = normalizeRunnerLabel(request.body.runnerLabel);
    if (runner.error) return fail(reply, 400, 1001, runner.error);
    const defaults = normalizeDefaultHeaders(request.body.defaultHeaders);
    if (defaults.error) return fail(reply, 400, 1001, defaults.error);

    /* 分区标签改了不影响已经排队/在跑的执行：那些行上有自己的快照（迁移 027），
       它们的 job 也已经在原来那条队列里。这正是快照存在的理由。默认头同理——
       它在每次请求组装时读取（loadEnvironment），改了只影响之后的执行。

       `updated_by` 在这里是唯一的时间无关归属：`environments` 表没有 created_at /
       updated_at 列（001 起就没有，P11-1 只补了 created_by/updated_by），所以这条
       UPDATE 没有 `updated_at = now()` 可依附，也不能靠「时间新于」判「系统改的」。
       环境只由 REST 人工路径写，NULL 就是「建后未改过」。 */
    const environment = await writeEnvironmentWithVersion(context, "更新", (client) => client.query(
      "UPDATE environments SET name = COALESCE($1, name), variables = COALESCE($2::jsonb, variables), secrets = $3::jsonb, runner_label = COALESCE($6, runner_label), default_headers = COALESCE($7::jsonb, default_headers), updated_by = $8 WHERE id = $4 AND project_id = $5 RETURNING *",
      [name || null, variables ? JSON.stringify(variables) : null, JSON.stringify(secrets), request.params.environmentId, context.project.id, runner.label ?? null, defaults.headers ? JSON.stringify(defaults.headers) : null, context.user.id],
    ));
    if (!environment) return fail(reply, 404, 2001, "environment not found");
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.environmentUpdate, targetType: "environment", targetId: request.params.environmentId,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return success(environment);
  });

  /**
   * Copies an environment inside its project.
   *
   * 服务端 `INSERT … SELECT`（与接口复制同一条决策），且这里别无选择：secret 明文只在
   * 服务端存在（Spec 4.6），客户端读到的只有 `secretKeys`，read-then-create 会产出一个
   * secret 全空的副本。分区标签与默认头一起带走——「这个环境指向的系统从哪个网段
   * 访问」「这套环境的请求都带什么头」与变量是同一份拷贝语义，拆开只会让副本指向
   * 错误的网段或悄悄丢掉泳道头（P3-2）。
   */
  app.post<{ Params: { id: string; environmentId: string }; Body: { name?: string } }>("/api/v1/projects/:id/environments/:environmentId/duplicate", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.environmentId)) return fail(reply, 404, 2001, "environment not found");

    const source = await pool.query("SELECT name FROM environments WHERE id = $1 AND project_id = $2", [request.params.environmentId, context.project.id]);
    if (!source.rowCount) return fail(reply, 404, 2001, "environment not found");

    /* 环境名有 UNIQUE(project_id, name)，路由层还按 lower(name) 判重，所以找空位的循环
       必须同样大小写不敏感——否则 INSERT 会撞唯一索引（500）而不是走到 409。 */
    const requested = request.body?.name?.trim() || `${String(source.rows[0].name)} copy`;
    const taken = await pool.query("SELECT name FROM environments WHERE project_id = $1 AND lower(name) LIKE lower($2)", [context.project.id, `${requested}%`]);
    const names = new Set(taken.rows.map((row) => String(row.name).toLowerCase()));
    let name = requested;
    for (let index = 2; names.has(name.toLowerCase()); index += 1) name = `${requested} ${index}`;

    /* 复制也是创建：副本落一版首快照（changeSummary 记"复制"）。 */
    const environment = await writeEnvironmentWithVersion(context, "复制", (client) => client.query(
      `INSERT INTO environments (id, project_id, name, variables, secrets, runner_label, default_headers, created_by)
       SELECT $1, project_id, $2, variables, secrets, runner_label, default_headers, $5
       FROM environments WHERE id = $3 AND project_id = $4 RETURNING *`,
      [randomUUID(), name, request.params.environmentId, context.project.id, context.user.id],
    ));
    if (!environment) return fail(reply, 404, 2001, "environment not found");
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.environmentCreate, targetType: "environment", targetId: environment.id,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body), duplicatedFrom: request.params.environmentId }, ip: request.ip,
    });
    return reply.code(201).send(success(environment));
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
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.environmentDelete, targetType: "environment", targetId: String(result.rows[0].id),
      projectId: context.project.id, userId: context.user.id, ip: request.ip,
    });
    return success({ id: result.rows[0].id });
  });
}
