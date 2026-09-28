import { randomBytes } from "node:crypto";
import { pool } from "../db.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

/**
 * 用户级 API 密钥（个人中心）的存取单点——调用平台开放 API 的凭据本身。
 *
 * 不是 SQL 专用密钥：它是「用户调用平台通用 API」的一把个人密钥，第一个消费方是 SQL
 * 快速调用（`lib/sqlQuickCall.ts` 的描述符加解密 + `routes/sqlQuickCall.ts` 的公开端点），
 * 以后新增的开放 API 复用同一把即可。密钥即凭据：解得开就等于「持钥人签发」，明文泄露 =
 * 以该用户身份、其实时权限调用这些 API 的能力泄露，处置手段是轮换（覆盖）或吊销（删行）。
 *
 * 三个使用方共用这一份，避免密钥格式/存法在多处漂移：
 * - 个人中心 `routes/me.ts`：生成 / 轮换 / 吊销（明文只在响应里出现一次）。
 * - 构造调用地址 `routes/dataSources.ts`：用本人密钥加密调用内容。
 * - 公开端点 `routes/sqlQuickCall.ts`：按 key_id 定位密钥、解密、按本人权限执行。
 */

/** 32 字节密钥。base64url 便于明文一次性展示与外部系统自行加密时粘贴。 */
const KEY_BYTES = 32;
/** 公开查找标识（进 URL 路径），不是秘密——只用来定位是哪一把密钥。 */
const KEY_ID_BYTES = 12;

function toKeyId(): string {
  return randomBytes(KEY_ID_BYTES).toString("base64url");
}

/**
 * 生成一把新密钥并（覆盖式）写入本人行——一人一把（PK 落在 user_id）。返回明文密钥，
 * **只在这一次**交给调用方展示，库里存的是主密钥再加密一层的密文（secret_encrypted）。
 */
export async function issueApiKey(userId: string): Promise<{ keyId: string; secretB64: string; createdAt: string; rotatedAt: string }> {
  const keyId = toKeyId();
  const secret = randomBytes(KEY_BYTES);
  const secretB64 = secret.toString("base64url");
  const result = await pool.query(
    `INSERT INTO api_access_keys (user_id, key_id, secret_encrypted)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET key_id = EXCLUDED.key_id, secret_encrypted = EXCLUDED.secret_encrypted, rotated_at = now()
     RETURNING key_id, created_at, rotated_at`,
    [userId, keyId, encryptSecret(secretB64)],
  );
  const row = result.rows[0];
  return { keyId: String(row.key_id), secretB64, createdAt: new Date(String(row.created_at)).toISOString(), rotatedAt: new Date(String(row.rotated_at)).toISOString() };
}

/** 本人当前密钥的元数据（无明文、无密文）：个人中心读它显示「已设置 / 未设置」。 */
export async function apiKeyMeta(userId: string): Promise<{ keyId: string; createdAt: string; rotatedAt: string } | null> {
  const result = await pool.query("SELECT key_id, created_at, rotated_at FROM api_access_keys WHERE user_id = $1", [userId]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return { keyId: String(row.key_id), createdAt: new Date(String(row.created_at)).toISOString(), rotatedAt: new Date(String(row.rotated_at)).toISOString() };
}

/** 吊销本人密钥（删行）：已发出的所有调用地址立即失效。幂等——没有行时返回 false。 */
export async function revokeApiKey(userId: string): Promise<boolean> {
  const result = await pool.query("DELETE FROM api_access_keys WHERE user_id = $1 RETURNING user_id", [userId]);
  return Boolean(result.rowCount);
}

/** 本人密钥的明文（用于构造调用地址时加密）。没设置返回 undefined，让调用方回可读的引导错误。 */
export async function loadApiSecretForUser(userId: string): Promise<{ keyId: string; secret: Buffer } | undefined> {
  const result = await pool.query("SELECT key_id, secret_encrypted FROM api_access_keys WHERE user_id = $1", [userId]);
  if (!result.rowCount) return undefined;
  const secret = Buffer.from(decryptSecret(result.rows[0].secret_encrypted as Buffer), "base64url");
  return { keyId: String(result.rows[0].key_id), secret };
}

/** 公开端点侧：按 key_id 定位密钥与持有人。key_id 非法 / 不存在都返回 undefined（→ 401）。 */
export async function loadApiSecretByKeyId(keyId: string): Promise<{ userId: string; secret: Buffer } | undefined> {
  const result = await pool.query("SELECT user_id, secret_encrypted FROM api_access_keys WHERE key_id = $1", [keyId]);
  if (!result.rowCount) return undefined;
  const secret = Buffer.from(decryptSecret(result.rows[0].secret_encrypted as Buffer), "base64url");
  return { userId: String(result.rows[0].user_id), secret };
}

/**
 * 本人密钥明文（重新复制用）：直接回库里存的那串明文，**与生成 / 轮换那一次响应里的 `key`
 * 逐字一致**。刻意不走 `loadApiSecretForUser` 的 base64url 解码→再编码往返——那条路是给
 * 加密调用内容用的（要的是 32 字节原始密钥），用在这里等于把展示串重新编码一遍，任何非
 * 规范化差异都会让「复制到的」和「生成时看到的」对不上。没设置返回 undefined。
 */
export async function loadApiKeyPlaintext(userId: string): Promise<{ keyId: string; key: string } | undefined> {
  const result = await pool.query("SELECT key_id, secret_encrypted FROM api_access_keys WHERE user_id = $1", [userId]);
  if (!result.rowCount) return undefined;
  return { keyId: String(result.rows[0].key_id), key: decryptSecret(result.rows[0].secret_encrypted as Buffer) };
}
