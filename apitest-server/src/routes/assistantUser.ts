import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { encryptSecret } from "../lib/crypto.js";
import { engineCreateConversation, engineStreamMessage, upstreamRateLimit } from "../lib/assistant/engine.js";
import { loadProviderById, toRuntimeAgent } from "../lib/assistant/providers.js";
import { currentUser } from "../lib/auth.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapAssistantUserAgent } from "../models/types.js";

/**
 * 助手的用户级路由（P9-4b，2026-09-14 修订；`currentUser` 即守卫——凭据是自己的，
 * 没有项目维度）。抽屉「设置」卡的全部后端：
 *
 * - `GET /assistant/providers`：可选上游目录（启用的 provider + 各自的 user_params
 *   模式——用户按它渲染表单）；
 * - `GET /assistant/my-agents`：我配过的 agent（明文参数 + secret 键名，值永不回）；
 * - `PUT /assistant/my-agents/:providerId`：按模式落我的参数。params 整份替换，
 *   secrets 三态补丁（null 清除 / 字符串设置 / 缺省不动——environments 同款）；
 *   必填项在「params ∪ 既有 secrets」上验。第一个配置的 agent 自动成为默认——
 *   「配置完还要再点一次设默认」是不必要的仪式；
 *   **两条通道不通用**（P9-8 修）：标了 `secret` 的键只认 secrets 通道，走 params
 *   会被 400 拒——否则明文 Key 会直接落进 params 列并随 GET 回显（门槛 2/12）；
 * - `POST …/set-default`：换默认（收发与新建会话都跟它）；
 * - `POST …/test`：用已保存的参数走一遍真链路（建会话 + ping），回 JSON 摘要——
 *   抽屉卡片要的是「通/不通 + 为什么」，逐事件回显留给系统管理的测试弹窗。
 *
 * 不做审计：这是个人偏好级配置（environments 同款取舍），不是平台资产变更。
 */

const MAX_PARAM_VALUE_CHARS = 2000;

/** 测试消息：一个字的成本换一次全链路验证。 */
const TEST_PING_MESSAGE = "ping";

/** 测试读流的兜底预算：终态事件（done/error）应该在远小于这个时间内到达。 */
const TEST_STREAM_TIMEOUT_MS = 60_000;

/** 凭据读不出（解密失败）：处置动作是「去设置卡重填」，与「未配置」同路（P9-8）。 */
const CREDENTIAL_UNREADABLE = "assistant credentials could not be read: re-enter your agent settings";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 上游失败出口（P9-8）：429 与其它失败分开报（与 routes/assistant.ts 同口径）。 */
function failUpstream(reply: FastifyReply, error: unknown) {
  const limited = upstreamRateLimit(error);
  if (limited) {
    if (limited.retryAfter !== undefined) reply.header("Retry-After", String(limited.retryAfter));
    return fail(reply, 429, 2007, `assistant upstream rate limited this request: ${errorMessage(error)}`);
  }
  return fail(reply, 502, 2006, `assistant upstream error: ${errorMessage(error)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AgentBody = {
  params?: unknown;
  secrets?: unknown;
};

/** 读取 provider 的 user_params 模式（管理面写入时已校验形状，这里防御性再读一遍）。 */
type UserParamSchema = { key: string; secret: boolean; required: boolean };

async function loadUserParamSchema(providerId: string): Promise<UserParamSchema[] | undefined> {
  const result = await pool.query("SELECT user_params FROM assistant_providers WHERE id = $1", [providerId]);
  const row = result.rows[0];
  if (!row) return undefined;
  const raw: unknown[] = Array.isArray(row.user_params) ? row.user_params : [];
  return raw
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.key === "string")
    .map((item: Record<string, unknown>) => ({ key: String(item.key), secret: item.secret === true, required: item.required === true }));
}

export async function assistantUserRoutes(app: FastifyInstance) {
  /** 上游目录（用户视角）：启用的 provider + 参数模式。secret 的「值」不在这里——模式本身不是机密。 */
  app.get("/api/v1/assistant/providers", async (request, reply) => {
    if (!(await currentUser(request, reply))) return;
    const result = await pool.query(
      "SELECT id, name, is_default, user_params FROM assistant_providers WHERE enabled ORDER BY is_default DESC, created_at",
    );
    return success(result.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      isDefault: row.is_default === true,
      userParams: Array.isArray(row.user_params) ? row.user_params : [],
    })), { total: result.rowCount });
  });

  app.get("/api/v1/assistant/my-agents", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    const result = await pool.query(
      `SELECT a.*, p.name AS provider_name, p.enabled AS provider_enabled
       FROM assistant_user_agents a JOIN assistant_providers p ON p.id = a.provider_id
       WHERE a.user_id = $1
       ORDER BY a.is_default DESC, a.updated_at DESC`,
      [user.id],
    );
    return success(result.rows.map(mapAssistantUserAgent), { total: result.rowCount });
  });

  app.put<{ Params: { providerId: string }; Body: AgentBody }>("/api/v1/assistant/my-agents/:providerId", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (!isUuid(request.params.providerId)) return fail(reply, 404, 2001, "assistant provider not found");
    if (!await loadProviderById(request.params.providerId)) return fail(reply, 404, 2001, "assistant provider not found");
    const schema = await loadUserParamSchema(request.params.providerId);
    if (!schema) return fail(reply, 404, 2001, "assistant provider not found");
    const schemaKeys = new Set(schema.map((param) => param.key));
    const secretKeys = new Set(schema.filter((param) => param.secret).map((param) => param.key));

    /* params（明文）：整份替换；键必须来自模式，值限长。 */
    if (request.body?.params !== undefined && !isRecord(request.body.params)) {
      return fail(reply, 400, 1001, "params must be an object");
    }
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries((request.body?.params ?? {}) as Record<string, unknown>)) {
      if (!schemaKeys.has(key)) return fail(reply, 400, 1001, `param "${key}" is not defined by this provider`);
      /* secret 项只认 secrets 通道（P9-8 修）：放进 params 就绕过了加密落库，而
         params 是明文列、GET 会原样回显——「密文落库 + 只回已配置」从这里破。 */
      if (secretKeys.has(key)) return fail(reply, 400, 1001, `param "${key}" is a secret field: send it in "secrets"`);
      if (typeof value !== "string") return fail(reply, 400, 1001, `param "${key}" must be a string`);
      if (value.length > MAX_PARAM_VALUE_CHARS) return fail(reply, 400, 1001, `param "${key}" is too long (max ${MAX_PARAM_VALUE_CHARS} characters)`);
      if (value) params[key] = value;
    }

    /* secrets：三态补丁（null 清除 / 字符串设置 / 缺省不动；空串视同 null——清空
       输入框就是清除）；键必须是模式里的 secret 项。 */
    if (request.body?.secrets !== undefined && !isRecord(request.body.secrets)) {
      return fail(reply, 400, 1001, "secrets must be an object");
    }
    const secretPatch: Record<string, string | null> = {};
    for (const [key, value] of Object.entries((request.body?.secrets ?? {}) as Record<string, unknown>)) {
      const defined = schema.find((param) => param.key === key);
      if (!defined) return fail(reply, 400, 1001, `param "${key}" is not defined by this provider`);
      if (!defined.secret) return fail(reply, 400, 1001, `param "${key}" is not a secret field`);
      if (value === null || value === "") { secretPatch[key] = null; continue; }
      if (typeof value !== "string") return fail(reply, 400, 1001, `secret "${key}" must be a string or null`);
      if (value.length > MAX_PARAM_VALUE_CHARS) return fail(reply, 400, 1001, `secret "${key}" is too long (max ${MAX_PARAM_VALUE_CHARS} characters)`);
      secretPatch[key] = value;
    }

    /* 必填校验基准 = 新 params ∪（保留的 secrets：补丁没动的按现状算）。 */
    const existing = await pool.query(
      "SELECT params, secrets FROM assistant_user_agents WHERE user_id = $1 AND provider_id = $2",
      [user.id, request.params.providerId],
    );
    const existingRow = existing.rows[0];
    const keptSecrets = (existingRow && isRecord(existingRow.secrets) ? existingRow.secrets : {}) as Record<string, unknown>;
    const effective = new Set(Object.keys(params));
    for (const key of Object.keys(keptSecrets)) {
      if (secretPatch[key] === undefined) effective.add(key);
    }
    for (const [key, value] of Object.entries(secretPatch)) {
      if (value !== null) effective.add(key);
    }
    for (const param of schema) {
      if (param.required && !effective.has(param.key)) {
        return fail(reply, 400, 1001, `param "${param.key}" is required`);
      }
    }

    /* secrets 落库：现状 ∪ 补丁（null 删、值设），逐值 AES-GCM 加密成 base64 文本。 */
    const mergedSecrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(keptSecrets)) {
      if (typeof value === "string" && value) mergedSecrets[key] = value;
    }
    for (const [key, value] of Object.entries(secretPatch)) {
      if (value === null) delete mergedSecrets[key];
      else mergedSecrets[key] = encryptSecret(value).toString("base64");
    }

    /* 第一个 agent 自动戴默认帽：配置完就能聊，不需要再找「设为默认」按钮。 */
    let makeDefault = false;
    if (!existing.rowCount) {
      const anyDefault = await pool.query("SELECT 1 FROM assistant_user_agents WHERE user_id = $1 AND is_default", [user.id]);
      makeDefault = anyDefault.rowCount === 0;
    }

    const result = await pool.query(
      `INSERT INTO assistant_user_agents (id, user_id, provider_id, params, secrets, is_default)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       ON CONFLICT (user_id, provider_id) DO UPDATE SET
         params = EXCLUDED.params, secrets = EXCLUDED.secrets, updated_at = now()
       RETURNING *`,
      [randomUUID(), user.id, request.params.providerId, JSON.stringify(params), JSON.stringify(mergedSecrets), makeDefault],
    );
    const row = result.rows[0];
    const provider = await pool.query("SELECT name, enabled FROM assistant_providers WHERE id = $1", [request.params.providerId]);
    return success(mapAssistantUserAgent({ ...row, provider_name: provider.rows[0]?.name, provider_enabled: provider.rows[0]?.enabled }));
  });

  app.post<{ Params: { providerId: string } }>("/api/v1/assistant/my-agents/:providerId/set-default", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (!isUuid(request.params.providerId)) return fail(reply, 404, 2001, "assistant provider not found");
    const existing = await pool.query(
      "SELECT 1 FROM assistant_user_agents WHERE user_id = $1 AND provider_id = $2",
      [user.id, request.params.providerId],
    );
    if (!existing.rowCount) return fail(reply, 404, 2001, "assistant agent not found");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE assistant_user_agents SET is_default = false, updated_at = now() WHERE user_id = $1 AND is_default", [user.id]);
      await client.query("UPDATE assistant_user_agents SET is_default = true, updated_at = now() WHERE user_id = $1 AND provider_id = $2", [user.id, request.params.providerId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally {
      client.release();
    }
    const result = await pool.query(
      `SELECT a.*, p.name AS provider_name, p.enabled AS provider_enabled
       FROM assistant_user_agents a JOIN assistant_providers p ON p.id = a.provider_id
       WHERE a.user_id = $1 AND a.provider_id = $2`,
      [user.id, request.params.providerId],
    );
    return success(mapAssistantUserAgent(result.rows[0]));
  });

  /**
   * 测试我的 agent：用已保存的参数走真链路（建会话 → ping → 读到终态）。回 JSON 摘要
   * 而不是 SSE——抽屉卡片要的是「通/不通 + 为什么」，逐事件回显是系统管理测试弹窗的
   * 形态。终态事件本身（done 的全文 / error 的消息）就是摘要。
   */
  app.post<{ Params: { providerId: string } }>("/api/v1/assistant/my-agents/:providerId/test", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (!isUuid(request.params.providerId)) return fail(reply, 404, 2001, "assistant provider not found");
    const provider = await loadProviderById(request.params.providerId);
    if (!provider) return fail(reply, 404, 2001, "assistant provider not found");
    const existing = await pool.query(
      "SELECT * FROM assistant_user_agents WHERE user_id = $1 AND provider_id = $2",
      [user.id, request.params.providerId],
    );
    if (!existing.rowCount) return fail(reply, 404, 2001, "assistant agent not found");
    let agent;
    try {
      agent = toRuntimeAgent(existing.rows[0]);
    } catch (error) {
      /* 凭据解密失败（P9-8）：不给 500 也不静默用空凭据去打上游——那样只会收到
         一个更难解释的 401。与「未配置」同一句指引：回去重填。 */
      request.log.warn({ err: errorMessage(error) }, "assistant credentials could not be decrypted");
      return fail(reply, 503, 2005, CREDENTIAL_UNREADABLE);
    }

    let upstreamConversationId: string;
    try {
      upstreamConversationId = await engineCreateConversation(provider, agent);
    } catch (error) {
      return failUpstream(reply, error);
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TEST_STREAM_TIMEOUT_MS);
    try {
      const stream = await engineStreamMessage(provider, agent, upstreamConversationId, { message: TEST_PING_MESSAGE, signal: abort.signal });
      for await (const event of stream) {
        if (event.type === "done") return success({ ok: true, detail: event.fullText.slice(0, 300) });
        if (event.type === "error") return success({ ok: false, detail: event.message.slice(0, 300) });
      }
      /* 引擎契约保证终态；真走到这里按失败报，不给「通过」的假象。 */
      return success({ ok: false, detail: "assistant upstream stream ended without a result" });
    } catch (error) {
      return failUpstream(reply, error);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  });
}
