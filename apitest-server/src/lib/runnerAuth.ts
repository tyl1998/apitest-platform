import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { pool } from "../db.js";
import { RUNNER_PROTOCOL_VERSION, SUPPORTED_RUNNER_PROTOCOL_VERSIONS } from "../models/types.js";

/**
 * Runner 注册 Token 的签发与校验（P4.5-1，计划 8.0 边界与 8.2）。
 *
 * **形状照抄 `ingestAuth.ts`**：scrypt `salt:digest` + 前缀部分索引。不是复制粘贴的偷懒，
 * 而是刻意的——两者的需求完全一致（只需比对、不需解密、鉴权在热路径上），而第二种哈希
 * 格式意味着「凭据是怎么存的」在这个代码库里有两个答案。
 *
 * **与 `ingestAuth` 的两处必然不同**：
 * ① Token 是**系统级**的，校验返回的是 token 身份与它允许的分区，而不是一个 `projectId`
 *    ——Runner 的项目是从 job 来的（8.2：路径前缀 `/runner` 不在 `/api/v1/projects/:id` 下）。
 * ② 多了一层**协议版本受理**：自托管 Runner 的升级不由平台控制（8.2 约定 7）。
 */

/** 明文形状：`apirunner_<random>`。前缀与 `apitrack_` 刻意不同——两种凭据不该长得一样。 */
const TOKEN_PREFIX = "apirunner_";
/** 24 字节 base64url ≈ 32 字符，与上报 Token 同款。 */
const TOKEN_BYTES = 24;
/**
 * 库里存的辨认前缀长度：`apirunner_` 加随机段的前 8 位。
 *
 * 与 `ingestAuth.ts` 同一个取舍：8 位 base64url 不足以反推剩余 24 位、从不参与校验，但
 * 足以在列表里认出「这条是哪个」，并让鉴权按前缀取候选行而不是全表 scrypt。
 * scrypt 是刻意昂贵的，而心跳是每 30 秒一次、按 Runner 台数放大的热路径。
 */
const IDENTIFIER_LENGTH = 8;

export type IssuedRunnerToken = { plaintext: string; hash: string; prefix: string };

export function issueRunnerToken(): IssuedRunnerToken {
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

/** `Authorization: Bearer apirunner_…`。头缺失/形状不对一律读作「没有凭据」。 */
export function runnerBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  return token?.startsWith(TOKEN_PREFIX) ? token : undefined;
}

/**
 * 一次通过校验的 Runner 凭据。
 *
 * 带上 `allowedLabels` 是刻意的：注册时的子集校验需要它，而让路由自己再查一次 token 行
 * 就等于把「token 允许哪些分区」这个判据放在两个地方读。
 */
export type RunnerIdentity = { tokenId: string; tokenName: string; allowedLabels: string[] };

/**
 * 校验一个 Runner Token。
 *
 * 候选行按前缀取（迁移 036 的部分索引），吊销行被索引条件排除——所以吊销即时生效，
 * 已在跑的 Runner 下一次心跳就会被拒。
 */
export async function authenticateRunner(header: string | undefined): Promise<RunnerIdentity | undefined> {
  const token = runnerBearerToken(header);
  if (!token) return undefined;
  const prefix = token.slice(0, TOKEN_PREFIX.length + IDENTIFIER_LENGTH);
  const candidates = await pool.query(
    "SELECT id, name, labels, token_hash FROM runner_tokens WHERE token_prefix = $1 AND revoked_at IS NULL",
    [prefix],
  );
  for (const row of candidates.rows) {
    if (!matches(token, String(row.token_hash))) continue;
    /* 「这张 Token 还活着吗」在接入排查里是第一个要看的事实，所以每次调用都记一笔。
       不进调用方的事务、失败不抛：它是审计而不是数据，一次心跳回滚了也不该让「用过」
       这件事消失（与 `ingestAuth.ts` 同款）。 */
    void pool.query("UPDATE runner_tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => {});
    return {
      tokenId: String(row.id),
      tokenName: String(row.name),
      allowedLabels: Array.isArray(row.labels) && row.labels.length ? (row.labels as unknown[]).map(String) : ["default"],
    };
  }
  return undefined;
}

/**
 * 协议版本受理点（8.2 约定 7）。
 *
 * 集中在一处而不是散落在各个路由里的 `if`：N / N-1 双支持意味着**将来**会有多个受理版本，
 * 而那时需要的是「在一个地方读出受理集合、按版本分派」，不是四个接口各判一次。
 *
 * 拒绝要发生在 **register**，不是 claim 之后（验收门槛 16）：一个 `0.9` 的 Runner 若能注册
 * 成功，它会一直长轮询、领到 JobSpec、然后在解析某个新字段时炸掉——用户看到的是一条
 * `failed` 的 run 和一段看不懂的日志。
 */
export function isSupportedProtocolVersion(version: string): boolean {
  return (SUPPORTED_RUNNER_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

export function protocolVersionRejection(version: string): string {
  return `protocol_version ${version || "(empty)"} is not supported; this platform accepts ${SUPPORTED_RUNNER_PROTOCOL_VERSIONS.join(", ")} (current ${RUNNER_PROTOCOL_VERSION})`;
}
