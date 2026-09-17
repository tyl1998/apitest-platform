/**
 * provider 行 / 用户 agent 行 → 运行时形态（P9-4b）。路由从这里拿可调度的组合：
 * provider 带协议，user agent 带凭据（secret 项在这一层解密——明文只往 engine 传、
 * 不进日志、不回响应，验收门槛 2/12）。
 */
import { randomUUID } from "node:crypto";
import { pool } from "../../db.js";
import { decryptSecret } from "../crypto.js";
import type { AssistantProtocol, AssistantProviderRuntime, AssistantUserAgentRuntime, AssistantUserParam } from "./types.js";

type ProviderRow = Record<string, unknown>;

function readProtocol(value: unknown): AssistantProtocol {
  return (value && typeof value === "object" ? value : {}) as AssistantProtocol;
}

export function toRuntimeProvider(row: ProviderRow): AssistantProviderRuntime {
  return {
    id: String(row.id),
    name: String(row.name),
    protocol: readProtocol(row.protocol),
    enabled: row.enabled === true,
    isDefault: row.is_default === true,
  };
}

/** secrets 列（JSONB {key: base64 密文}）→ 解密并进 params。解不出来是部署级事故
    （DATA_SOURCE_ENCRYPTION_KEY 换了），按 agent 不可用抛清楚——静默降级成无凭据
    调上游，只会得到一个更难排查的上游 401。导出给用户级路由的测试连接复用。 */
export function toRuntimeAgent(row: ProviderRow): AssistantUserAgentRuntime {
  const params = (row.params && typeof row.params === "object" ? row.params : {}) as Record<string, unknown>;
  const secrets = (row.secrets && typeof row.secrets === "object" ? row.secrets : {}) as Record<string, unknown>;
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) merged[key] = String(value ?? "");
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value === "string" && value) merged[key] = decryptSecret(Buffer.from(value, "base64"));
  }
  return {
    providerId: String(row.provider_id),
    params: merged,
    isDefault: row.is_default === true,
  };
}

export async function loadProviderById(id: string): Promise<AssistantProviderRuntime | undefined> {
  const result = await pool.query("SELECT * FROM assistant_providers WHERE id = $1", [id]);
  return result.rows[0] ? toRuntimeProvider(result.rows[0]) : undefined;
}

/** 用户的默认 agent + 其 provider（provider 停用即视为无默认——与 P9-2「默认行被
    停用即视为无默认」同款姿态）。同 provider 的行排前面：系统默认 provider 是
    用户未主动选择时的推荐位。 */
export async function loadEnabledDefaultUserAgent(userId: string): Promise<{ provider: AssistantProviderRuntime; agent: AssistantUserAgentRuntime } | undefined> {
  const result = await pool.query(
    `SELECT a.*, p.id AS provider_row_id FROM assistant_user_agents a
     JOIN assistant_providers p ON p.id = a.provider_id
     WHERE a.user_id = $1 AND a.is_default AND p.enabled
     ORDER BY p.is_default DESC, p.created_at
     LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const provider = await loadProviderById(String(row.provider_id));
  if (!provider) return undefined;
  return { provider, agent: toRuntimeAgent(row) };
}

/** 用户在某个 provider 上的 agent（会话路由用——会话按 provider_id 找归属，
    门槛 13 的通用化：换默认后旧会话照常收发）。 */
export async function loadUserAgentForProvider(userId: string, providerId: string): Promise<AssistantUserAgentRuntime | undefined> {
  const result = await pool.query(
    "SELECT * FROM assistant_user_agents WHERE user_id = $1 AND provider_id = $2",
    [userId, providerId],
  );
  return result.rows[0] ? toRuntimeAgent(result.rows[0]) : undefined;
}

/** 空库开箱用的默认上游名（固定，管理面按名字找人）。 */
export const DEFAULT_ASSISTANT_PROVIDER_NAME = "agent-vendor-agent";

/**
 * 默认 provider 的 agent-vendor 协议（与迁移 059 的存量翻译、e2e 种子的形状逐字一致，
 * 含迁移 060 补的 MRTR 确认映射）。baseUrl 是唯一随部署变的值，由调用方注入。
 */
function defaultagent-vendorProtocol(baseUrl: string): AssistantProtocol {
  return {
    baseUrl,
    auth: { header: "Authorization", value: "Bearer {{user.apiKey}}" },
    successCode: { field: "code", value: "0000" },
    createConversation: {
      method: "POST",
      path: "/api/v1/chat/conversation/add",
      body: { agentId: "{{user.agentId}}" },
      conversationId: "data",
    },
    chat: {
      method: "POST",
      path: "/api/v1/chat/{{conversationId}}",
      body: { conversationId: "{{conversationId}}", message: "{{message}}" },
    },
    stop: { method: "POST", path: "/api/v1/chat/{{conversationId}}/stop" },
    delete: { method: "POST", path: "/api/v1/chat/conversation/{{conversationId}}/delete" },
    history: {
      method: "GET",
      path: "/api/v1/chat/{{conversationId}}/messages",
      query: { index: "{{index}}", limit: "{{limit}}" },
      messages: "data",
      fields: { id: "id", role: "role", text: "text", time: "time" },
    },
    attachments: true,
    sse: {
      eventField: "eventType",
      token: { on: "MESSAGE", text: "data.text" },
      tool: { on: "PROCESSING", name: "data.name", status: "data.status", nameFallback: "data.type", input: "data.result.input" },
      elicit: { on: "MESSAGE", type: "data.type", typeValue: "ELICITATION", text: "data.text", tool: "data.toolCallId", schema: "data.elicitationSchema" },
      done: { on: "FINAL_RESULT", text: "data.outputText", success: "data.success" },
      error: { on: "ERROR", message: "data.error" },
      ignore: ["HEART_BEAT"],
    },
  };
}

/** 默认 provider 的用户参数模式：agentId 明文，apiKey / mcpToken 加密（同 e2e 种子）。 */
const DEFAULT_USER_PARAMS: AssistantUserParam[] = [
  { key: "agentId", label: "agentId", secret: false, required: true },
  { key: "apiKey", label: "API Key", secret: true, required: true },
  { key: "mcpToken", label: "MCP Token", secret: true, required: false },
];

/**
 * 空库的默认上游种子（2026-09-17，照 `seedAdmin()` 的先例在启动时跑一次）。
 *
 * 背景：迁移 059 起 provider 全靠管理员在系统管理里手配，空库首次进助手只有
 * 「找系统管理员」——新环境开箱没有可配的 agent 落点。这里给一份名字固定为
 * `agent-vendor-agent` 的默认 agent-vendor 协议行，管理员后续照常改协议或换默认。
 *
 * 边界：
 * - **按名字幂等**：`agent-vendor-agent` 已存在或与已有行同名时什么都不做（`ON CONFLICT
 *   DO NOTHING`，绝不覆盖管理员的协议/凭据模式）；只有**一张 provider 都没有**时才
 *   把它设为默认——已有的库默认位仍归管理员，种子不跟它抢。
 * - baseUrl 从 `agent-vendor_BASE_URL` 读（内网地址不是仓库资产）。未配置就整体跳过——凭空
 *   造一个解析不了的主机只会把失败推迟到第一次聊天。
 * - 只插 provider 协议（共享信息）；agentId / apiKey 是**用户级**凭据，仍由各人自配。
 */
export async function seedAssistantProvider(): Promise<void> {
  const baseUrl = process.env.agent-vendor_BASE_URL?.trim();
  if (!baseUrl) return;
  await pool.query(
    `INSERT INTO assistant_providers (id, name, protocol, user_params, enabled, is_default)
     SELECT $1::uuid, $2, $3::jsonb, $4::jsonb, true,
            NOT EXISTS (SELECT 1 FROM assistant_providers)
     ON CONFLICT (name) DO NOTHING`,
    [
      randomUUID(),
      DEFAULT_ASSISTANT_PROVIDER_NAME,
      JSON.stringify(defaultagent-vendorProtocol(baseUrl)),
      JSON.stringify(DEFAULT_USER_PARAMS),
    ],
  );
}
