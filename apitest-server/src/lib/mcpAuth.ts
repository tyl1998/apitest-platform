import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { pool } from "../db.js";
import type { McpScope } from "../models/types.js";

/**
 * MCP Token 的签发与校验（P5-1，计划 9.3）。
 *
 * **形状逐字照抄 `lib/ingestAuth.ts`**，只改前缀（`apimcp_`）与表名——计划明说这是
 * 第三次照抄、不抽公共层（边界 14）：三份 40 行的具体实现比一层参数化抽象更好读。
 * 需求确实一致（只需比对、不需解密、鉴权在热路径上），而第二种哈希格式意味着
 * 「凭据是怎么存的」在这个代码库里有两个答案。
 *
 * **与 `ingestAuth` 的两处必然不同**：
 * ① 校验返回 `scope`（边界 1 的三值）——`/mcp` 一条端点按 scope 决定 `tools/list`
 *    回哪些工具、`tools/call` 放不放行，而不是给写/执行单开第二条路径。
 * ② 返回 `createdBy`（边界 2 的活体判据入口）：写与执行工具每次调用都要用它重跑
 *    `canAccess`，不信 Token 自带的权限——签发者被降成 viewer 或被移出项目后，他的
 *    Token 立刻写不动。`created_by` 为 NULL（签发者已被删）时写调用一律拒绝。
 *
 * **`project_settings.mcp_enabled` 不在这里查**（9.3 的四道闸门顺序：Token 有效 →
 * 401、开关 → 404、scope 可见集 → -32601、canAccess → 403）。开关是第 2 道、在
 * 路由层判；本文件只回答「这把钥匙是谁的、能开哪几类门」。
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
 * scrypt——scrypt 是刻意昂贵的，而 MCP 调用是 agent 一轮对话十几次的热路径。
 */
const IDENTIFIER_LENGTH = 8;

export type IssuedMcpToken = { plaintext: string; hash: string; prefix: string };

export function issueMcpToken(): IssuedMcpToken {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const plaintext = `${TOKEN_PREFIX}${secret}`;
  const salt = randomUUID();
  return {
    plaintext,
    hash: `${salt}:${scryptSync(plaintext, salt, 64).toString("hex")}`,
    prefix: `${TOKEN_PREFIX}${secret.slice(0, IDENTIFIER_LENGTH)}`,
  };
}

function matches(plaintext: string, stored: string) {
  const [salt, digest] = stored.split(":");
  if (!salt || !digest) return false;
  const actual = scryptSync(plaintext, salt, 64);
  const expected = Buffer.from(digest, "hex");
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
 * 一次通过校验的 MCP 身份。
 *
 * `scope` 原样透传（三值数组），路由层据此裁剪 `tools/list` 与放行 `tools/call`；
 * `createdBy` 缺席 = 签发者已被删，写与执行闸门（第 4 道）据此直接拒绝。
 */
export type McpIdentity = {
  tokenId: string;
  projectId: string;
  scope: McpScope[];
  createdBy?: string;   // 边界 2 的活体判据入口
};

/**
 * 校验一个 MCP Token，返回它所属项目、scope 与签发人。
 *
 * 候选行按前缀取（迁移 050 的部分索引），吊销行被索引条件排除——所以吊销即时生效，
 * 下一次调用就被拒（验收门槛 4，无缓存窗口）。
 */
export async function authenticateMcp(header: string | undefined): Promise<McpIdentity | undefined> {
  const token = mcpBearerToken(header);
  if (!token) return undefined;
  const prefix = token.slice(0, TOKEN_PREFIX.length + IDENTIFIER_LENGTH);
  const candidates = await pool.query(
    "SELECT id, project_id, scope, created_by, token_hash FROM mcp_tokens WHERE token_prefix = $1 AND revoked_at IS NULL",
    [prefix],
  );
  for (const row of candidates.rows) {
    if (!matches(token, String(row.token_hash))) continue;
    /* 「这把 Token 还有人在用吗」由 `last_used_at` 回答（照 `ingestAuth.ts` 的取舍）：
      不进业务事务、失败不抛——业务回滚了不该让「用过」这件事消失，它是审计而不是数据。 */
    void pool.query("UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => {});
    return {
      tokenId: String(row.id),
      projectId: String(row.project_id),
      scope: Array.isArray(row.scope) ? (row.scope as unknown[]).map(String) as McpScope[] : [],
      createdBy: row.created_by ? String(row.created_by) : undefined,
    };
  }
  return undefined;
}
