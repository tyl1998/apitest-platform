import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { pool } from "../db.js";

/**
 * 邀请码的签发与校验（P6-3，计划 10.0 边界 3）。
 *
 * 第五次照抄 Token 形状（users.password_hash / ingest_tokens / runner_tokens /
 * mcp_tokens）：scrypt `salt:digest`、明文前 8 位收窄候选集、部分索引排除已用/已吊销
 * 码。**照旧不抽公共层**——吊销/过期/单次使用的差异会在抽象层漏出来，五份 40 行的
 * 具体实现仍然好过一层参数化抽象。
 *
 * 差异点（相对 ingest Token）：默认 7 天过期、单次使用（`consumed_at` +
 * `consumed_user_id`，消费在注册事务里做带条件的 UPDATE，并发双消费只有一个能赢）。
 */

/** 明文形状：`apiinv_<random>`（计划 10.0 边界 1 的①）。 */
const INVITE_PREFIX = "apiinv_";
/** 24 字节 base64url ≈ 32 字符，与 ingest / runner Token 同一档的猜测空间。 */
const TOKEN_BYTES = 24;
/**
 * 库里存的辨认前缀长度。与 `ingestAuth` 同一条推理：字面取「明文前 8 位」只会得到
 * 常量 `apiinv_`，辨认不了任何东西；存的是前缀加随机段的前 8 位，注册时按它取候选
 * 行而不是全表 scrypt。8 位 base64url 反推不了剩余 24 位，也从不参与校验本身。
 */
const IDENTIFIER_LENGTH = 8;

export type IssuedInvitation = { plaintext: string; hash: string; prefix: string };

export function issueInvitation(): IssuedInvitation {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const plaintext = `${INVITE_PREFIX}${secret}`;
  const salt = randomUUID();
  return {
    plaintext,
    hash: `${salt}:${scryptSync(plaintext, salt, 64).toString("hex")}`,
    prefix: `${INVITE_PREFIX}${secret.slice(0, IDENTIFIER_LENGTH)}`,
  };
}

/**
 * 从提交的明文码算候选前缀。形状不对（不是 `apiinv_` 开头）返回 undefined——
 * 注册路由据此回「码无效」而不是拿着任意字符串去撞索引。
 */
export function invitationPrefix(token: string): string | undefined {
  return token.startsWith(INVITE_PREFIX) ? token.slice(0, INVITE_PREFIX.length + IDENTIFIER_LENGTH) : undefined;
}

/** 与 `verifyPassword` 同款比对；坏行（无 salt/digest）直接判不匹配。 */
export function matchesInvitation(plaintext: string, stored: string): boolean {
  const [salt, digest] = stored.split(":");
  if (!salt || !digest) return false;
  const actual = scryptSync(plaintext, salt, 64);
  const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * 校验一个邀请码，返回未消费、未吊销且哈希匹配的行（含 `project_id` / `role` /
 * `expires_at`）。**不判定过期**——过期是明确报错（验收 5），由调用方给出带原因的
 * 消息而不是把过期码混进「无效」里。
 */
export async function findLiveInvitation(token: string): Promise<Record<string, unknown> | undefined> {
  const prefix = invitationPrefix(token);
  if (!prefix) return undefined;
  const candidates = await pool.query(
    "SELECT id, token_hash, project_id, role, created_by, expires_at FROM invitations WHERE token_prefix = $1 AND consumed_at IS NULL AND revoked_at IS NULL",
    [prefix],
  );
  for (const row of candidates.rows) {
    if (matchesInvitation(token, String(row.token_hash))) return row;
  }
  return undefined;
}
