import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(): Buffer {
  /* trim 后为空视同未配置：空串曾把回退密钥悄悄变成 sha256("")，与历史加密数据
     错位（lib/index.ts 的 JWT 注册是同一类问题，两处语义保持一致）。 */
  const raw = process.env.DATA_SOURCE_ENCRYPTION_KEY?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") throw new Error("DATA_SOURCE_ENCRYPTION_KEY is required");
    // Local scripts historically run without dotenv; keep a stable dev key while production remains fail-closed.
    return createHash("sha256").update(process.env.JWT_SECRET?.trim() || "apitest-local-data-source-key").digest();
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("DATA_SOURCE_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

/** The nonce and auth tag travel with the ciphertext; the key never does. */
export function encryptSecret(value: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}

export function decryptSecret(value: Buffer): string {
  if (value.length < NONCE_BYTES + TAG_BYTES) throw new Error("data source credentials are invalid");
  const nonce = value.subarray(0, NONCE_BYTES);
  const tag = value.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const encrypted = value.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("data source credentials could not be decrypted");
  }
}
