import { decryptWithKey, encryptWithKey } from "./crypto.js";

/**
 * SQL 快速调用的**调用令牌**加解密——把「调用哪条 SQL 定义」编码进一个可放进请求头的令牌。
 *
 * 令牌 = 用本人 API 密钥（`lib/apiKeys.ts`）AES-256-GCM 加密的 `{ projectId, sqlDefinitionId }`。
 * 它同时承担两件事：
 * - **凭据**：GCM 认证标签解得开就等于「持钥人签发」（密钥即凭据）；
 * - **定位**：解出来的 sqlDefinitionId 指明跑哪条定义——放进令牌而非明文，是为了防篡改
 *   （不能拿一个令牌去点名另一条别人的定义；调用时还会再按本人权限重判一次）。
 *
 * **入参不在令牌里**：入参在请求体 `{ "param": { ... } }` 动态传，所以同一个令牌可以反复
 * 复用、每次带不同参数——令牌是「我要调用这条 SQL」，body 才是「这次用什么参数」。
 */

/** 请求头里令牌的长度上限（base64url 字符数）：挡住畸形 / 超大输入，不进解密。 */
export const MAX_TOKEN_CHARS = 8192;

export type QuickCallTarget = { projectId: string; sqlDefinitionId: string };

/** 目标 → 令牌（base64url，可直接放进请求头）。 */
export function encodeToken(secret: Buffer, target: QuickCallTarget): string {
  return encryptWithKey(secret, JSON.stringify(target)).toString("base64url");
}

/** 令牌 → 目标。解密或形状不对都抛错，由调用方翻成 401。 */
export function decodeToken(secret: Buffer, encoded: string): QuickCallTarget {
  const plaintext = decryptWithKey(secret, Buffer.from(encoded, "base64url"));
  const parsed = JSON.parse(plaintext) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("invalid token");
  const { projectId, sqlDefinitionId } = parsed as Record<string, unknown>;
  if (typeof projectId !== "string" || typeof sqlDefinitionId !== "string") throw new Error("invalid token");
  return { projectId, sqlDefinitionId };
}

/**
 * 从请求头解出 `{ keyId, token }`。两种写法都认（copy 出来的 curl 用第一种）：
 * - `Authorization: ApiKey <keyId>.<token>`（keyId / token 都是 base64url，不含 `.`，按首个
 *   `.` 切分即可）；
 * - `X-Api-Key: <keyId>` + `X-Api-Token: <token>`（更直白，两个头分开）。
 */
export function readCredential(headers: Record<string, unknown>): { keyId: string; token: string } | undefined {
  const auth = String(headers["authorization"] ?? "").trim();
  const match = /^ApiKey\s+(.+)$/i.exec(auth);
  if (match) {
    const dot = match[1].indexOf(".");
    if (dot > 0 && dot < match[1].length - 1) {
      return { keyId: match[1].slice(0, dot), token: match[1].slice(dot + 1) };
    }
    return undefined;
  }
  const keyId = String(headers["x-api-key"] ?? "").trim();
  const token = String(headers["x-api-token"] ?? "").trim();
  if (keyId && token) return { keyId, token };
  return undefined;
}
