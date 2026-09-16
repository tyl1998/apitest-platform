/**
 * provider 行 / 用户 agent 行 → 运行时形态（P9-4b）。路由从这里拿可调度的组合：
 * provider 带协议，user agent 带凭据（secret 项在这一层解密——明文只往 engine 传、
 * 不进日志、不回响应，验收门槛 2/12）。
 */
import { pool } from "../../db.js";
import { decryptSecret } from "../crypto.js";
import type { AssistantProtocol, AssistantProviderRuntime, AssistantUserAgentRuntime } from "./types.js";

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
