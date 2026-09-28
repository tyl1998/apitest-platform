import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pool } from "../db.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { mapRepository, type Repository } from "../models/types.js";

/**
 * 上报 Token 的签发与校验（P4-2，计划 7.0 边界 17）。
 *
 * **AES-GCM 可逆加密而不是哈希**（2026-09-28 起）：产品要求「凭据能重新复制」——丢了
 * 不必吊销重发，管理页按前缀取回明文即可。这要求明文能被服务端解回来，所以从 scrypt
 * 哈希改成 AES-256-GCM（与 Webhook 密钥、`api_access_keys` 同款 `secret_encrypted`）。
 * 代价说清：库被读走时，加密的凭据能被主密钥解开——用可重复复制换掉了「库泄露也拿不到
 * 明文」这条属性。校验因此变成「解出库里明文、常量时间比对」而不再是 scrypt 比对；
 * 前缀部分索引仍在，热路径仍只在候选行上做一次廉价解密。
 */

/** 明文形状：`apitrack_<random>`。前缀与包名/环境变量一致（计划 7.4）。 */
const TOKEN_PREFIX = "apitrack_";
/** 24 字节 base64url ≈ 32 字符，猜测空间远超任何在线爆破。 */
const TOKEN_BYTES = 24;
/**
 * 库里存的辨认前缀长度。
 *
 * 计划 7.4 写的是「明文的前 8 位」，但字面执行会得到常量 `apitrack`——它辨认不了任何
 * 东西，也无法把鉴权时的候选集收窄。所以存的是 `apitrack_` 加随机段的前 8 位：既能在
 * 列表里认出「这条是哪个」，又能让 `/ingest` 按前缀取候选行而不是全表 scrypt。
 * 8 位 base64url 不足以反推剩余 24 位，也从不参与校验本身。
 */
const IDENTIFIER_LENGTH = 8;

export type IssuedToken = { plaintext: string; secretEncrypted: Buffer; prefix: string };

export function issueIngestToken(): IssuedToken {
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

/** `Authorization: Bearer apitrack_…`。头缺失/形状不对一律读作「没有凭据」。 */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  return token?.startsWith(TOKEN_PREFIX) ? token : undefined;
}

export type IngestIdentity = { tokenId: string; projectId: string };

/**
 * 校验一个上报 Token，返回它所属项目。
 *
 * 候选行按前缀取（迁移 034 的部分索引），而不是全表逐行解密——加密比对虽比 scrypt 便宜，
 * 全表解密仍会让上报接口的耗时随 Token 总数线性增长，而上报是 CI 每次跑完都要打的热路径。
 * 吊销行被索引条件排除，所以吊销即时生效（验收 7）。
 */
export async function authenticateIngest(header: string | undefined): Promise<IngestIdentity | undefined> {
  const token = bearerToken(header);
  if (!token) return undefined;
  const prefix = token.slice(0, TOKEN_PREFIX.length + IDENTIFIER_LENGTH);
  const candidates = await pool.query(
    "SELECT id, project_id, secret_encrypted FROM ingest_tokens WHERE token_prefix = $1 AND revoked_at IS NULL",
    [prefix],
  );
  for (const row of candidates.rows) {
    if (!matches(token, row.secret_encrypted as Buffer)) continue;
    /* 「这个 Token 还活着吗」在接入排查里是第一个要看的事实，所以每次上报都记一笔。
       不进上报事务：它是审计而不是数据，上报回滚了也不该让「用过」这件事消失。 */
    void pool.query("UPDATE ingest_tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => {});
    return { tokenId: String(row.id), projectId: String(row.project_id) };
  }
  return undefined;
}

export class RepositoryConflictError extends Error {
  constructor(public readonly boundGitUrl: string) {
    super(`this project is bound to ${boundGitUrl}`);
    this.name = "RepositoryConflictError";
  }
}

/** git URL 的比较形状：大小写、结尾 `.git`、结尾斜杠都不该算成两个仓库。 */
export function normalizeGitUrl(url: string) {
  return url.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

const PROVIDERS = ["github", "gitlab", "gitee", "bitbucket", "other"] as const;

/** 从 git URL 猜托管方，仅用于展示；猜不出就是 `other`，不为此拒绝上报。 */
export function detectProvider(url: string): (typeof PROVIDERS)[number] {
  const lower = url.toLowerCase();
  for (const provider of PROVIDERS) if (provider !== "other" && lower.includes(provider)) return provider;
  return "other";
}

/**
 * 首次上报登记仓库，此后每次校验 `git_url`（边界 18）。
 *
 * 不一致直接抛 `RepositoryConflictError`（路由回 409）——否则持有 Token 的任意 CI 都能
 * 往这棵树里灌用例。解绑过的行（`status='unbound'`）换个 git_url 会被重新激活：解绑
 * 的语义就是「这个项目要换仓库了」，而历史用例与上报记录**保留不动**。
 *
 * 登记走 `ON CONFLICT (project_id)` 而不是「先 SELECT 再 INSERT」：两条 CI 流水线同时
 * 首报时，后者会拿到 `project_id` 唯一约束的报错而不是第二行仓库。
 */
export async function bindRepository(
  client: { query: typeof pool.query },
  projectId: string,
  gitUrl: string,
  commitSha: string,
): Promise<Repository> {
  const existing = await client.query("SELECT * FROM repositories WHERE project_id = $1", [projectId]);
  if (existing.rowCount) {
    const current = mapRepository(existing.rows[0]);
    if (current.status === "active" && normalizeGitUrl(current.gitUrl) !== normalizeGitUrl(gitUrl)) {
      throw new RepositoryConflictError(current.gitUrl);
    }
    const updated = await client.query(
      `UPDATE repositories
          SET git_url = $2, provider = $3, status = 'active',
              first_seen_commit = COALESCE(first_seen_commit, $4),
              last_ingest_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [current.id, gitUrl.trim(), detectProvider(gitUrl), commitSha || null],
    );
    return mapRepository(updated.rows[0]);
  }
  const inserted = await client.query(
    `INSERT INTO repositories (id, project_id, git_url, provider, first_seen_commit, last_ingest_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (project_id) DO UPDATE SET last_ingest_at = now(), updated_at = now()
     RETURNING *`,
    [randomUUID(), projectId, gitUrl.trim(), detectProvider(gitUrl), commitSha || null],
  );
  const repository = mapRepository(inserted.rows[0]);
  /* 走到 DO UPDATE 分支说明另一条流水线在 SELECT 与 INSERT 之间抢先登记了。它登记的
     可能是另一个仓库，而 DO UPDATE 不改 git_url——所以这里要再判一次，否则并发首报能
     绕过整条 git_url 校验。 */
  if (repository.status === "active" && normalizeGitUrl(repository.gitUrl) !== normalizeGitUrl(gitUrl)) {
    throw new RepositoryConflictError(repository.gitUrl);
  }
  return repository;
}
