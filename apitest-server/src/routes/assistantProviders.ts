import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { writeAuditLogAsync } from "../lib/audit.js";
import { engineCreateConversation, engineStreamMessage, upstreamRateLimit } from "../lib/assistant/engine.js";
import { loadProviderById } from "../lib/assistant/providers.js";
import type { AssistantEvent, AssistantProtocol, AssistantUserParam } from "../lib/assistant/types.js";
import { requireSystemAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapAssistantProvider } from "../models/types.js";

/**
 * 助手 provider 管理面（P9-3 起家、P9-4b 通用化；全部 requireSystemAdmin——上游模板
 * 是平台级运维资产，MCP 工具面不暴露系统级表）。
 *
 * **通用模式**（2026-09-14 修订）：provider 不再是「类型 + adapter 代码」，而是一份
 * **协议配置**——4 个接口（建会话 / 发消息 SSE / 停止 / 历史）+ SSE 事件映射 + 认证
 * 模板，外加 `userParams`（用户选择这个上游时要填哪些参数，如上游的 agentId /
 * apiKey / mcpToken）。换平台 = 填一份配置，零开发。
 *
 * 写入侧只做浅校验（baseUrl / 必备端点 / 事件字段），深对错由测试连接用真上游回答
 * ——schema 校验说不了「配置能用」。测试连接要带一组**临时参数**（body 里给、不
 * 落库）：凭据是用户级的，系统行上没有可测的 Key。
 */

/** 15s 保活（与 routes/assistant.ts 同一口径）：测试流也不依赖上游心跳。 */
const HEARTBEAT_MS = 15_000;

const MAX_NAME_CHARS = 100;
const MAX_USER_PARAMS = 20;
const MAX_PARAM_KEY_CHARS = 40;
const MAX_PARAM_LABEL_CHARS = 60;

/** 测试连接发出的消息：一个字的成本换一次全链路（建会话 + 流式 + 终态）验证。 */
const TEST_PING_MESSAGE = "ping";

/* 2006 = 上游调用失败（routes/assistant.ts 的 CODE_UPSTREAM 同款——「配置错了」与
 * 「agent 平台挂了」共用这一个出口，处置动作一致：看回显里的上游错误）；
 * 2007 = 上游限流（P9-8，routes/assistant.ts 的 CODE_RATE_LIMIT 同款）：配置是对的，
 * 只是上游在限速——测试连接也要说清这一点，不然管理员会去改一份本来正确的配置。 */
const CODE_UPSTREAM = 2006;
const CODE_RATE_LIMIT = 2007;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 上游失败出口（P9-8）：限流与其它失败分开报（routes/assistant.ts 同口径）。 */
function failUpstream(reply: FastifyReply, error: unknown) {
  const limited = upstreamRateLimit(error);
  if (limited) {
    if (limited.retryAfter !== undefined) reply.header("Retry-After", String(limited.retryAfter));
    return fail(reply, 429, CODE_RATE_LIMIT, `assistant upstream rate limited this request: ${errorMessage(error)}`);
  }
  return fail(reply, 502, CODE_UPSTREAM, `assistant upstream error: ${errorMessage(error)}`);
}

type ProviderBody = {
  name?: unknown;
  protocol?: unknown;
  userParams?: unknown;
  enabled?: unknown;
};

/** 测试连接的临时参数（不落库）：明文只在这一趟请求里存在。 */
type TestBody = { params?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 协议浅校验（深对错归测试连接）：baseUrl 必须是 http(s)；建会话与发消息端点必须有
 * 方法 + 路径；SSE 映射必须有事件字段且至少配了 token 或 done（一条流连「完成」都
 * 认不出就没法收尾）。返回错误串或归一后的协议对象。
 *
 * 2026-10-22 通用化：新增的可选字段（`success` / `attachmentsField` / `streamEnd` /
 * `sse.*.success` / `elicit` 的判别字段与 `allowResume`）只做**形状**校验，形状不对
 * 就整份拒掉——半根配置（例如 `success.ok` 写成字符串）在运行期会静默失效，比直接
 * 拒收更难查。旧的 `successCode` 一律接受（它的形状本来就由这里的老规则管）。
 */
function readProtocol(input: unknown): AssistantProtocol | string {
  if (!isRecord(input)) return "protocol must be an object";
  const protocol = input as AssistantProtocol;
  const baseUrl = typeof protocol.baseUrl === "string" ? protocol.baseUrl.trim().replace(/\/+$/, "") : "";
  if (!/^https?:\/\//.test(baseUrl)) return "protocol.baseUrl must be an http(s) URL";
  for (const key of ["createConversation", "chat"] as const) {
    const endpoint = protocol[key];
    if (!isRecord(endpoint) || typeof endpoint.method !== "string" || !endpoint.method.trim() || typeof endpoint.path !== "string" || !endpoint.path.trim().startsWith("/")) {
      return `protocol.${key} must define a method and a path starting with "/"`;
    }
  }
  if (!isRecord(protocol.createConversation) || typeof (protocol.createConversation as { conversationId?: unknown }).conversationId !== "string" || !(protocol.createConversation as { conversationId?: unknown }).conversationId) {
    return "protocol.createConversation.conversationId must be a response field path";
  }
  for (const key of ["stop", "delete", "history"] as const) {
    const endpoint = protocol[key];
    if (endpoint === undefined) continue;
    if (!isRecord(endpoint) || typeof endpoint.method !== "string" || !endpoint.method.trim() || typeof endpoint.path !== "string" || !endpoint.path.trim().startsWith("/")) {
      return `protocol.${key} must define a method and a path starting with "/"`;
    }
  }
  const sse = protocol.sse;
  if (!isRecord(sse) || typeof sse.eventField !== "string" || !sse.eventField.trim()) {
    return "protocol.sse.eventField must be the upstream event-type field";
  }
  if (!isRecord(sse.token) && !isRecord(sse.done)) {
    return "protocol.sse must define at least a token or done mapping";
  }

  /* 可选字段的形状（2026-10-22）。 */
  const shapeError =
    checkSuccessRule(protocol.success, "protocol.success")
    ?? checkSuccessRule(isRecord(sse.token) ? sse.token.success : undefined, "protocol.sse.token.success")
    ?? checkSuccessRule(isRecord(sse.error) ? sse.error.success : undefined, "protocol.sse.error.success")
    ?? checkSuccessRule(isRecord(sse.done) ? (sse.done as Record<string, unknown>).successRule : undefined, "protocol.sse.done.successRule");
  if (shapeError) return shapeError;
  if (protocol.attachmentsField !== undefined && (typeof protocol.attachmentsField !== "string" || !protocol.attachmentsField.trim())) {
    return "protocol.attachmentsField must be a non-empty field name";
  }
  if (protocol.streamEnd !== undefined && protocol.streamEnd !== "close" && protocol.streamEnd !== "continue") {
    return 'protocol.streamEnd must be "close" or "continue"';
  }
  /* 思考增量（2026-10-22，可选）：`text` 必填，`newSegment` 可空。 */
  if (sse.thinking !== undefined) {
    const thinking = sse.thinking as Record<string, unknown>;
    if (typeof thinking.text !== "string" || !thinking.text.trim()) return "protocol.sse.thinking.text must be a non-empty path";
    if (thinking.newSegment !== undefined && (typeof thinking.newSegment !== "string" || !thinking.newSegment.trim())) {
      return "protocol.sse.thinking.newSegment must be a non-empty path";
    }
  }
  if (sse.tool !== undefined) {
    const tool = sse.tool as Record<string, unknown>;
    for (const key of ["status", "callId", "kind", "nameFallback", "input", "output"] as const) {
      if (tool[key] !== undefined && typeof tool[key] !== "string") return `protocol.sse.tool.${key} must be a string`;
    }
  }
  /* 会话级自动批准端点（2026-10-22，可选）：与 stop/delete 同款形状 + 可选响应路径。 */
  if (protocol.autoApprove !== undefined) {
    const endpoint = protocol.autoApprove as Record<string, unknown>;
    if (typeof endpoint.method !== "string" || !endpoint.method.trim() || typeof endpoint.path !== "string" || !endpoint.path.trim().startsWith("/")) {
      return 'protocol.autoApprove must define a method and a path starting with "/"';
    }
    if (endpoint.result !== undefined && (typeof endpoint.result !== "string" || !endpoint.result.trim())) {
      return "protocol.autoApprove.result must be a non-empty response path";
    }
  }
  if (sse.elicit !== undefined) {
    const elicit = sse.elicit as Record<string, unknown>;
    for (const key of ["on", "text", "tool"] as const) {
      if (typeof elicit[key] !== "string" || !(elicit[key] as string).trim()) return `protocol.sse.elicit.${key} must be a non-empty path`;
    }
    for (const key of ["type", "typeValue", "schema", "allowResume", "confirmId", "expiresAt", "source", "inputSummary", "duplicate"] as const) {
      if (elicit[key] !== undefined && typeof elicit[key] !== "string") return `protocol.sse.elicit.${key} must be a string`;
    }
    /* 判别字段与取值成对出现：只填一个等于永远命中/永远不命中，都是配置事故。 */
    if ((elicit.type === undefined) !== (elicit.typeValue === undefined)) {
      return "protocol.sse.elicit.type and typeValue must be defined together";
    }
  }
  /* 确认答复端点（2026-10-22，可选）：与 stop/delete/history 同款形状校验 + 两个响应路径。 */
  if (protocol.elicitRespond !== undefined) {
    const endpoint = protocol.elicitRespond as Record<string, unknown>;
    if (typeof endpoint.method !== "string" || !endpoint.method.trim() || typeof endpoint.path !== "string" || !endpoint.path.trim().startsWith("/")) {
      return 'protocol.elicitRespond must define a method and a path starting with "/"';
    }
    if (endpoint.body !== undefined && (!isRecord(endpoint.body) || Array.isArray(endpoint.body))) {
      return "protocol.elicitRespond.body must be an object";
    }
    for (const key of ["applied", "id"] as const) {
      if (endpoint[key] !== undefined && (typeof endpoint[key] !== "string" || !(endpoint[key] as string).trim())) {
        return `protocol.elicitRespond.${key} must be a non-empty response path`;
      }
    }
    if (endpoint.applied === undefined) {
      return "protocol.elicitRespond.applied is required (it tells whether the answer actually took effect)";
    }
  }
  /* 历史分页（2026-10-22）：`indexParam` 是「走分页」的开关，`limitParam` / `direction` /
     `totalPath` 只在开关打开时有意义——开关关着还配它们说明作者想的分页没生效。 */
  const history = protocol.history as Record<string, unknown> | undefined;
  if (history) {
    for (const key of ["indexParam", "limitParam", "pageSizeParam", "cursorParam", "totalPath"] as const) {
      if (history[key] !== undefined && (typeof history[key] !== "string" || !(history[key] as string).trim())) {
        return `protocol.history.${key} must be a non-empty parameter name`;
      }
    }
    if (history.cursorSource !== undefined && !["envelope", "rows"].includes(String(history.cursorSource))) {
      return 'protocol.history.cursorSource must be "envelope" or "rows"';
    }
    for (const key of ["limitValue", "pageSize", "maxPages"] as const) {
      const value = history[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
        return `protocol.history.${key} must be a positive integer`;
      }
    }
    if (history.direction !== undefined && !["cursor", "offset", "cursorFromEnd"].includes(String(history.direction))) {
      return 'protocol.history.direction must be "cursor", "offset" or "cursorFromEnd"';
    }
    if (history.indexParam === undefined && (history.limitParam !== undefined || history.pageSizeParam !== undefined || history.direction !== undefined)) {
      return "protocol.history.limitParam / pageSizeParam / direction require history.indexParam (otherwise history is read in one shot)";
    }
  }
  return { ...protocol, baseUrl };
}

/** 失败判定规则的形状校验：`{field, ok?: string[], not?: boolean}`（见 AssistantSuccessRule）。 */
function checkSuccessRule(rule: unknown, label: string): string | undefined {
  if (rule === undefined) return undefined;
  if (!isRecord(rule)) return `${label} must be an object`;
  if (typeof rule.field !== "string" || !rule.field.trim()) return `${label}.field must be a non-empty path`;
  if (rule.ok !== undefined) {
    if (!Array.isArray(rule.ok) || !rule.ok.length || rule.ok.some((item) => typeof item !== "string" && typeof item !== "number")) {
      return `${label}.ok must be a non-empty array of strings`;
    }
  }
  if (rule.not !== undefined && typeof rule.not !== "boolean") return `${label}.not must be a boolean`;
  if (rule.ok === undefined && rule.not === undefined) return `${label} must define ok or not`;
  return undefined;
}

/** 用户参数模式校验：键是模板占位符的词汇（字母开头 + 字母数字下划线）、唯一、≤20 个。 */
function readUserParams(input: unknown): AssistantUserParam[] | string {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return "userParams must be an array";
  if (input.length > MAX_USER_PARAMS) return `userParams is too long (max ${MAX_USER_PARAMS})`;
  const seen = new Set<string>();
  const result: AssistantUserParam[] = [];
  for (const raw of input) {
    if (!isRecord(raw)) return "each user param must be an object";
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || key.length > MAX_PARAM_KEY_CHARS) {
      return `user param key "${key || "?"}" must be letters/digits/underscore, starting with a letter`;
    }
    if (seen.has(key)) return `duplicate user param key "${key}"`;
    seen.add(key);
    const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : key;
    if (label.length > MAX_PARAM_LABEL_CHARS) return `user param label "${label}" is too long`;
    result.push({
      key,
      label,
      secret: raw.secret === true,
      required: raw.required === true,
      ...(typeof raw.placeholder === "string" && raw.placeholder ? { placeholder: raw.placeholder } : {}),
    });
  }
  return result;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

/** 重名预检（dataSources 同款：资源级 2003，不用已知漂移的 1002）。 */
async function nameTaken(name: string, excludeId?: string): Promise<boolean> {
  const result = excludeId
    ? await pool.query("SELECT 1 FROM assistant_providers WHERE lower(name) = lower($1) AND id <> $2", [name, excludeId])
    : await pool.query("SELECT 1 FROM assistant_providers WHERE lower(name) = lower($1)", [name]);
  return Boolean(result.rowCount);
}

/** 单行读取（404 的口径与全站一致：uuid 先拦，行不存在不泄露任何东西）。 */
async function loadProviderRow(id: string): Promise<Record<string, unknown> | undefined> {
  const result = await pool.query("SELECT * FROM assistant_providers WHERE id = $1", [id]);
  return result.rows[0];
}

/** 列表查询（标量子查询随行带会话计数——删除确认的影响面读数，不另开 usage 路由；
    同一聚合纪律：兄弟表不 JOIN 相乘，每个计数一个独立子查询挂在父行上）。 */
const PROVIDER_SELECT = `
  SELECT p.*, (
    SELECT COUNT(*)::int AS conversation_count FROM assistant_conversations c WHERE c.provider_id = p.id
  ) FROM assistant_providers p`;

function writeSseEvent(raw: ServerResponse, event: AssistantEvent): void {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function assistantProviderRoutes(app: FastifyInstance) {
  app.get("/api/v1/system/assistant/providers", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const result = await pool.query(`${PROVIDER_SELECT} ORDER BY p.is_default DESC, p.created_at`);
    return success(result.rows.map(mapAssistantProvider), { total: result.rowCount });
  });

  app.post<{ Body: ProviderBody }>("/api/v1/system/assistant/providers", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!name) return fail(reply, 400, 1001, "provider name is required");
    if (name.length > MAX_NAME_CHARS) return fail(reply, 400, 1001, `provider name is too long (max ${MAX_NAME_CHARS} characters)`);
    if (request.body?.enabled !== undefined && typeof request.body.enabled !== "boolean") return fail(reply, 400, 1001, "enabled must be a boolean");
    const protocol = readProtocol(request.body?.protocol);
    if (typeof protocol === "string") return fail(reply, 400, 1001, protocol);
    const userParams = readUserParams(request.body?.userParams);
    if (typeof userParams === "string") return fail(reply, 400, 1001, userParams);
    if (await nameTaken(name)) return fail(reply, 409, 2003, "an assistant provider with this name already exists");

    const result = await pool.query(
      `INSERT INTO assistant_providers (id, name, protocol, user_params, enabled)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5) RETURNING *`,
      [randomUUID(), name, JSON.stringify(protocol), JSON.stringify(userParams), request.body?.enabled ?? true],
    ).catch((error: unknown) => (isUniqueViolation(error) ? undefined : Promise.reject(error)));
    if (!result) return fail(reply, 409, 2003, "an assistant provider with this name already exists");
    writeAuditLogAsync({
      action: "assistant_provider.create",
      targetType: "assistant_provider",
      targetId: String(result.rows[0].id),
      userId: user.id,
      detail: { name, enabled: result.rows[0].enabled === true },
      ip: request.ip,
    });
    return reply.code(201).send(success(mapAssistantProvider(result.rows[0])));
  });

  app.patch<{ Params: { providerId: string }; Body: ProviderBody }>("/api/v1/system/assistant/providers/:providerId", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    if (!isUuid(request.params.providerId)) return fail(reply, 404, 2001, "assistant provider not found");
    const existing = await loadProviderRow(request.params.providerId);
    if (!existing) return fail(reply, 404, 2001, "assistant provider not found");
    if (request.body?.name !== undefined) {
      const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
      if (!name) return fail(reply, 400, 1001, "provider name is required");
      if (name.length > MAX_NAME_CHARS) return fail(reply, 400, 1001, `provider name is too long (max ${MAX_NAME_CHARS} characters)`);
      if (await nameTaken(name, request.params.providerId)) return fail(reply, 409, 2003, "an assistant provider with this name already exists");
    }
    if (request.body?.enabled !== undefined && typeof request.body.enabled !== "boolean") return fail(reply, 400, 1001, "enabled must be a boolean");
    const protocol = readProtocol(request.body?.protocol === undefined ? existing.protocol : request.body.protocol);
    if (typeof protocol === "string") return fail(reply, 400, 1001, protocol);
    const userParams = readUserParams(request.body?.userParams === undefined ? existing.user_params : request.body.userParams);
    if (typeof userParams === "string") return fail(reply, 400, 1001, userParams);

    const result = await pool.query(
      `UPDATE assistant_providers SET
         name = COALESCE($1, name), protocol = COALESCE($2::jsonb, protocol), user_params = COALESCE($3::jsonb, user_params),
         enabled = COALESCE($4, enabled), updated_at = now()
       WHERE id = $5 RETURNING *`,
      [
        typeof request.body?.name === "string" ? request.body.name.trim() : null,
        request.body?.protocol === undefined ? null : JSON.stringify(protocol),
        request.body?.userParams === undefined ? null : JSON.stringify(userParams),
        request.body?.enabled ?? null,
        request.params.providerId,
      ],
    );
    writeAuditLogAsync({
      action: "assistant_provider.update",
      targetType: "assistant_provider",
      targetId: request.params.providerId,
      userId: user.id,
      /* 变更摘要而不是 payload 转储。 */
      detail: {
        name: String(result.rows[0].name),
        ...(request.body?.name !== undefined ? { renamed: true } : {}),
        ...(request.body?.protocol !== undefined ? { protocolChanged: true } : {}),
        ...(request.body?.userParams !== undefined ? { userParamsChanged: true } : {}),
        ...(request.body?.enabled !== undefined ? { enabled: request.body.enabled === true } : {}),
      },
      ip: request.ip,
    });
    return success(mapAssistantProvider(result.rows[0]));
  });

  /**
   * 删除（会话级联，13.1——provider 没了，上游会话的可达性随之消失，留着映射行只会让
   * 抽屉里出现永远打不开的会话）。没有 409/force：与 environments 不同，这里没有「别人
   * 引用它」的第二种活法；影响面（N 个会话会消失）由列表随行的 conversationCount 在
   * 确认框里说清。用户的 agent 行同样级联删（迁移 059）。删默认行 = 平台回到「无默认
   * provider」姿态（边界 15），不是错误。
   */
  app.delete<{ Params: { providerId: string } }>("/api/v1/system/assistant/providers/:providerId", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    if (!isUuid(request.params.providerId)) return fail(reply, 404, 2001, "assistant provider not found");
    const existing = await loadProviderRow(request.params.providerId);
    if (!existing) return fail(reply, 404, 2001, "assistant provider not found");
    const conversations = await pool.query("SELECT COUNT(*)::int AS total FROM assistant_conversations WHERE provider_id = $1", [request.params.providerId]);
    const agents = await pool.query("SELECT COUNT(*)::int AS total FROM assistant_user_agents WHERE provider_id = $1", [request.params.providerId]);
    const deleted = await pool.query("DELETE FROM assistant_providers WHERE id = $1 RETURNING id", [request.params.providerId]);
    if (!deleted.rowCount) return fail(reply, 404, 2001, "assistant provider not found");
    writeAuditLogAsync({
      action: "assistant_provider.delete",
      targetType: "assistant_provider",
      targetId: request.params.providerId,
      userId: user.id,
      detail: { name: String(existing.name), wasDefault: existing.is_default === true, conversationCount: Number(conversations.rows[0].total), userAgentCount: Number(agents.rows[0].total) },
      ip: request.ip,
    });
    return success({ id: deleted.rows[0].id, removedConversations: Number(conversations.rows[0].total), removedUserAgents: Number(agents.rows[0].total) });
  });

  /**
   * 设为默认（事务里先摘别的行再戴这顶帽——「默认唯一」没有部分唯一索引，由这里保）。
   * 这里的默认是**推荐位**（用户第一次配置 agent 时的预选），不是收发归属——收发按
   * 用户自己的默认 agent（P9-4b）。停用的行也允许设默认：前端在按钮上提示先启用即可。
   */
  app.post<{ Params: { providerId: string } }>("/api/v1/system/assistant/providers/:providerId/set-default", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    if (!isUuid(request.params.providerId)) return fail(reply, 404, 2001, "assistant provider not found");
    const existing = await loadProviderRow(request.params.providerId);
    if (!existing) return fail(reply, 404, 2001, "assistant provider not found");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE assistant_providers SET is_default = false, updated_at = now() WHERE is_default AND id <> $1", [request.params.providerId]);
      const result = await client.query("UPDATE assistant_providers SET is_default = true, updated_at = now() WHERE id = $1 RETURNING *", [request.params.providerId]);
      await client.query("COMMIT");
      writeAuditLogAsync({
        action: "assistant_provider.set_default",
        targetType: "assistant_provider",
        targetId: request.params.providerId,
        userId: user.id,
        detail: { to: String(result.rows[0].name), from: existing.is_default === true ? undefined : String(existing.name) },
        ip: request.ip,
      });
      return success(mapAssistantProvider(result.rows[0]));
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally {
      client.release();
    }
  });

  /**
   * JSON 导入（{name,protocol,userParams}——**不含任何用户凭据**：凭据本来就是用户级
   * 的，模板里更不该有）。导入即创建，走与 POST 完全相同的校验。
   */
  app.post<{ Body: ProviderBody }>("/api/v1/system/assistant/providers/import", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!name) return fail(reply, 400, 1001, "provider name is required");
    const protocol = readProtocol(request.body?.protocol);
    if (typeof protocol === "string") return fail(reply, 400, 1001, protocol);
    const userParams = readUserParams(request.body?.userParams);
    if (typeof userParams === "string") return fail(reply, 400, 1001, userParams);
    if (await nameTaken(name)) return fail(reply, 409, 2003, "an assistant provider with this name already exists");

    const result = await pool.query(
      `INSERT INTO assistant_providers (id, name, protocol, user_params, enabled)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, true) RETURNING *`,
      [randomUUID(), name, JSON.stringify(protocol), JSON.stringify(userParams)],
    ).catch((error: unknown) => (isUniqueViolation(error) ? undefined : Promise.reject(error)));
    if (!result) return fail(reply, 409, 2003, "an assistant provider with this name already exists");
    writeAuditLogAsync({
      action: "assistant_provider.create",
      targetType: "assistant_provider",
      targetId: String(result.rows[0].id),
      userId: user.id,
      detail: { name, imported: true },
      ip: request.ip,
    });
    return reply.code(201).send(success(mapAssistantProvider(result.rows[0])));
  });

  /**
   * JSON 导出（下载件，非信封——specCases 导出同款）：{name,protocol,userParams}，
   * 不带 enabled/is_default（那是这台安装的运行态，不是可搬走的配置）。凭据本来就不
   * 在系统行上（用户级），无从泄露。
   */
  app.get<{ Params: { providerId: string } }>("/api/v1/system/assistant/providers/:providerId/export", async (request, reply) => {
    if (!(await requireSystemAdmin(request, reply))) return;
    if (!isUuid(request.params.providerId)) return fail(reply, 404, 2001, "assistant provider not found");
    const existing = await loadProviderRow(request.params.providerId);
    if (!existing) return fail(reply, 404, 2001, "assistant provider not found");
    const payload = JSON.stringify({
      name: String(existing.name),
      protocol: existing.protocol ?? {},
      userParams: existing.user_params ?? [],
    }, null, 2);
    /* 文件名收进 [A-Za-z0-9._-]：名字是自由文本，直接进 header 会是 header 注入。 */
    const safeName = String(existing.name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
    reply.header("content-type", "application/json");
    reply.header("content-disposition", `attachment; filename="assistant-provider-${safeName}.json"`);
    return reply.send(payload);
  });

  /**
   * 测试连接（门槛 11 的验证位）：body 带一组**临时参数**（明文只在这一趟请求里存在，
   * 不落库——凭据是用户级的，系统行上没有可测的 Key）。建会话 → 发 ping → 归一事件
   * SSE 回显，与发消息路由同一条引擎链路、同一种两段式；测试会话不落映射表。报错
   * （「必填参数缺了」「baseUrl 不通」）正是测试连接要回显的东西。
   */
  app.post<{ Params: { providerId: string }; Body: TestBody }>("/api/v1/system/assistant/providers/:providerId/test", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    if (!isUuid(request.params.providerId)) return fail(reply, 404, 2001, "assistant provider not found");
    const provider = await loadProviderById(request.params.providerId);
    if (!provider) return fail(reply, 404, 2001, "assistant provider not found");
    /* 临时参数：只收字符串；键不筛（模板缺值渲染成空串，上游会给出指向性报错）。 */
    const rawParams = isRecord(request.body?.params) ? request.body.params : {};
    const testParams: Record<string, string> = Object.fromEntries(
      Object.entries(rawParams).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, String(value)]),
    );
    const agent = { providerId: provider.id, params: testParams, isDefault: false };

    let upstreamConversationId: string;
    try {
      upstreamConversationId = await engineCreateConversation(provider, agent);
    } catch (error) {
      return failUpstream(reply, error);
    }

    let stream: AsyncIterable<AssistantEvent>;
    /* 客户端断开（关掉测试弹窗）砍掉上游 fetch 与读循环——测试会话没有监听者就没有
        继续烧上游 token 的理由。 */
    const abort = new AbortController();
    try {
      stream = await engineStreamMessage(provider, agent, upstreamConversationId, { message: TEST_PING_MESSAGE, signal: abort.signal });
    } catch (error) {
      return failUpstream(reply, error);
    }

    /* 客户端断开检测挂在 reply.raw 上（routes/assistant.ts 同款）：先挂监听再写
        第一帧——向已断 socket 的 write 只会 emit error，挂着 listener 才不会以未处理
        事件炸掉进程。 */
    let clientGone = false;
    const onClientClose = () => { clientGone = true; abort.abort(); };
    reply.raw.on("close", onClientClose);
    reply.raw.on("error", onClientClose);

    /* hijack 之后 CORS 头手动搬（routes/assistant.ts 同款注释照抄成立）。 */
    const inherited = Object.fromEntries(
      Object.entries(reply.getHeaders())
        .filter(([key]) => key.startsWith("access-control-") || key === "vary")
        .map(([key, value]) => [key, String(value)]),
    );
    reply.hijack();
    reply.raw.writeHead(200, {
      ...inherited,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    const heartbeat = setInterval(() => { if (!clientGone) reply.raw.write(": ping\n\n"); }, HEARTBEAT_MS);

    try {
      for await (const event of stream) {
        if (clientGone) break;
        writeSseEvent(reply.raw, event);
        if (event.type === "done" || event.type === "error") break;
      }
    } catch (error) {
      if (!clientGone) writeSseEvent(reply.raw, { type: "error", message: `assistant upstream error: ${errorMessage(error)}` });
    } finally {
      clearInterval(heartbeat);
      if (!clientGone) reply.raw.end();
      /* for-await 提前 break（终态后）时让上游读循环也停下来；正常收尾是 no-op。 */
      abort.abort();
    }
  });
}
