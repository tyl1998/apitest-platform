import { randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "../db.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { mapMcpBinding, type McpBinding, type McpScope } from "../models/types.js";

/**
 * MCP Token 的签发与校验（P5-1，计划 9.3；P12-1 改为用户级 + 项目绑定）。
 *
 * **AES-GCM 可逆加密而不是哈希**（2026-09-28 起）：产品要求「凭据能重新复制」——个人中心
 * 按前缀取回明文即可，丢了不必吊销重发。格式与 `ingest_tokens` / `runner_tokens` /
 * Webhook 密钥同款 `secret_encrypted`。代价说清：库被读走时加密的凭据能被主密钥解开——
 * 用可重复复制换掉了「库泄露也拿不到明文」这条属性。校验因此是「解出库里明文、常量时间
 * 比对」；前缀部分索引仍在，热路径仍只在候选行上做一次廉价解密。
 * P12 之后唯一的形状差异是「校验结果是一组绑定而不是一个项目」。
 *
 * **用户级（P12 边界 2）**：token 行上没有 `project_id` 也没有 `scope`——两者都在
 * `mcp_token_projects` 绑定表上。校验返回 `McpPrincipal`（tokenId + owner + 绑定集），
 * 目标项目由每次 tools/call 的参数选定（`lib/mcpServer.ts` 的注册包装解析），
 * 调用时刻**每次**重跑 `canAccess(owner, 目标项目)`（边界 3，read 也查）。
 *
 * **`project_settings.mcp_enabled` 不在这里查**（边界 6 的五道闸门：token 有效 → 401、
 * 目标未绑定 → -32601、开关 → 404、绑定 scope → -32601、canAccess → 403）。开关是
 * 第 3 道、在路由层按目标项目判；本文件只回答「这把钥匙是谁的、能开哪几扇门」。
 *
 * **owner 被删 = 整把 token 失效**（边界 3）：`created_by` 是 `ON DELETE SET NULL`，
 * set 之后候选查询就把该行排除——回 401，不留「无主 read token」。
 */

/** 明文形状：`apimcp_<random>`。前缀与 `apitrack_` / `apirunner_` 刻意不同——三种凭据不该长得一样。 */
const TOKEN_PREFIX = "apimcp_";
/** 24 字节 base64url ≈ 32 字符，与上报 / Runner Token 同款。 */
const TOKEN_BYTES = 24;
/**
 * 库里存的辨认前缀长度：`apimcp_` 加随机段的前 8 位。
 *
 * 与 `ingestAuth.ts` 同一个取舍：8 位 base64url 不足以反推剩余 24 位、从不参与校验，
 * 但足以在列表里认出「这条是哪个」，并让 `/mcp` 鉴权按前缀取候选行而不是全表
 * 解密——MCP 调用是 agent 一轮对话十几次的热路径，候选集收窄到个位数很关键。
 */
const IDENTIFIER_LENGTH = 8;

export type IssuedMcpToken = { plaintext: string; secretEncrypted: Buffer; prefix: string };

export function issueMcpToken(): IssuedMcpToken {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const plaintext = `${TOKEN_PREFIX}${secret}`;
  return {
    plaintext,
    secretEncrypted: encryptSecret(plaintext),
    prefix: `${TOKEN_PREFIX}${secret.slice(0, IDENTIFIER_LENGTH)}`,
  };
}

/** 库里存的是主密钥加密的明文；比对 = 解回明文再常量时间比。解不开一律当作凭据不成立。 */
function matches(plaintext: string, stored: Buffer): boolean {
  let decrypted: string;
  try { decrypted = decryptSecret(stored); } catch { return false; }
  const actual = Buffer.from(plaintext);
  const expected = Buffer.from(decrypted);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** `Authorization: Bearer apimcp_…`。头缺失/形状不对一律读作「没有凭据」。 */
export function mcpBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  return token?.startsWith(TOKEN_PREFIX) ? token : undefined;
}

/**
 * 一次通过校验的 MCP 主体：这把钥匙是谁的（tokenId / createdBy）、能开哪几扇门
 * （bindings）。**不是调用上下文**——目标项目由每个 tools/call 的参数决定。
 *
 * `createdBy` 必填：owner 被删的行在候选查询里就被排除（401），这里拿不到人也不该
 * 造一个假的出来。
 */
export type McpPrincipal = {
  tokenId: string;
  createdBy: string;
  bindings: McpBinding[];
};

/**
 * 一次 tools/call 的调用上下文：主体 + **已解析的目标项目**与该绑定的 scope。
 *
 * 由 `lib/mcpServer.ts` 的注册包装从 `args.projectId` 与主体绑定集解出后注入——
 * **handler 体内的 `identity.projectId` 因此逐字不变**（边界 5 修订：参数注入与绑定
 * 解析集中在注册包装，不逐个改 57 个工具声明），只是语义从「token 的项目」变成
 * 「本次调用的目标项目」。
 *
 * 无项目数据的工具（`get_script_contract` / `list_my_projects`）`projectId` 为空串、
 * `scope` 为全部绑定 scope 的并集；它们的 handler 不读 `projectId`。
 */
export type McpIdentity = {
  tokenId: string;
  projectId: string;
  scope: McpScope[];
  createdBy?: string;
  bindings: McpBinding[];
};

/** 绑定集的 scope 并集（能力面展示用：`tools/list` 注册裁剪、AuthInfo.scopes）。 */
export function bindingScopeUnion(bindings: McpBinding[]): McpScope[] {
  const union = new Set<McpScope>();
  for (const binding of bindings) for (const scope of binding.scope) union.add(scope);
  return [...union];
}

/** 在绑定集里找目标项目（未绑定返回 undefined——闸门 2 与注册包装共用这一判据）。 */
export function resolveBinding(bindings: McpBinding[], projectId: string): McpBinding | undefined {
  return bindings.find((binding) => binding.projectId === projectId);
}

/**
 * 校验一个 MCP Token，返回它的主体、绑定集与签发人（owner 缺席 = 401）。
 *
 * 候选行按前缀取（迁移 050 的部分索引），吊销行与 owner 被删的行被查询条件排除——
 * 所以吊销与 owner 删除都即时生效，下一次调用就被拒（无缓存窗口）。
 *
 * 绑定集按命中行二次带回（一条 token 的绑定数是个位数，不做 join 聚合的额外形状）；
 * 前缀索引把候选集压到个位数，解密只对候选行跑。
 */
export async function authenticateMcp(header: string | undefined): Promise<McpPrincipal | undefined> {
  const token = mcpBearerToken(header);
  if (!token) return undefined;
  const prefix = token.slice(0, TOKEN_PREFIX.length + IDENTIFIER_LENGTH);
  const candidates = await pool.query(
    "SELECT id, created_by, secret_encrypted FROM mcp_tokens WHERE token_prefix = $1 AND revoked_at IS NULL AND created_by IS NOT NULL",
    [prefix],
  );
  for (const row of candidates.rows) {
    if (!matches(token, row.secret_encrypted as Buffer)) continue;
    /* 「这把 Token 还有人在用吗」由 `last_used_at` 回答（照 `ingestAuth.ts` 的取舍）：
       不进业务事务、失败不抛——业务回滚了不该让「用过」这件事消失，它是审计而不是数据。 */
    void pool.query("UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => {});
    const bindings = await pool.query(
      "SELECT project_id, scope, bound_at FROM mcp_token_projects WHERE token_id = $1 ORDER BY bound_at",
      [row.id],
    );
    return {
      tokenId: String(row.id),
      createdBy: String(row.created_by),
      bindings: bindings.rows.map(mapMcpBinding),
    };
  }
  return undefined;
}
