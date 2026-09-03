import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { encryptSecret } from "../lib/crypto.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapGitCredential } from "../models/types.js";

/**
 * 项目级 Git 拉取凭据（P4.5-14，计划 8.11 的 A 类；迁移 041）。
 *
 * 它取代了 `PUT /projects/:id/repository/credential`：那条路由把凭据写在**仓库行**上，
 * 而仓库行只能由第一次上报创建（迁移 034 的绑定模型），于是配置顺序被锁成「先跑一次
 * CI 上报 → 才能配 clone → 才能让平台跑 CI」。凭据搬到自己的表上之后，建任务不再需要
 * 任何已存在的上报。
 *
 * **只写不读**：明文加密进 `credential_encrypted`（`lib/crypto.ts` 的 AES-GCM，与数据源
 * 凭据、webhook secret 同一把钥匙），GET 只回名字、方式与更新时间。与上报 Token 的
 * 「明文只回一次」相比，这里连回一次都不需要——它是平台替用户保管、随 JobSpec 下发给
 * Runner 的东西（边界 11），浏览器从头到尾不该见到它。
 *
 * **没有 `none` 档**：「公开仓库不需要凭据」由任务不引用凭据表达（`git_credential_id`
 * 为空），一个空外键比一行「什么都没有的凭据」准确。
 */

const METHODS = ["https_token", "ssh_key"] as const;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

/** 外键 RESTRICT 触发时 pg 回 23503：拿它翻成一句说得清「谁在用」的 409。 */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23503";
}

/**
 * 明文的形状校验。
 *
 * `ssh_key` 必须是 PEM 私钥（含 `PRIVATE KEY` 那一行）：挡住「把 token 粘进 SSH 框」这个
 * 最常见的误操作——它会一路走到 Runner，然后以一条看不懂的 clone 失败收场。平台**无法**
 * 验证这把 key 是不是只读 deploy key，只能在表单文案里要求用户在 Git 平台侧勾掉写权限
 * （边界 11 的缓解①）。
 */
function validateCredential(method: (typeof METHODS)[number], credential: unknown): string | undefined {
  if (typeof credential !== "string" || !credential.trim()) return `credential is required when method is ${method}`;
  if (method === "ssh_key" && !credential.includes("PRIVATE KEY")) {
    return 'credential for ssh_key must be a PEM private key (a line containing "PRIVATE KEY"); an HTTPS token goes in the https_token method instead';
  }
  return undefined;
}

export async function gitCredentialRoutes(app: FastifyInstance) {
  /**
   * 列表。`task_count` 是分组子选而不是 join：join 到 `ci_tasks` 会让每把 key 按引用数
   * 重复成多行（`dashboard.ts` 的同一条纪律）。这个数字是删除确认框的前置信息——用户要
   * 先知道「删了它会影响 3 个任务」。
   */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/git-credentials", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const result = await pool.query(
      `SELECT c.id, c.project_id, c.name, c.method, c.credential_updated_at, c.created_by,
              c.created_at, c.updated_at,
              COALESCE(t.task_count, 0)::int AS task_count
         FROM git_credentials c
         LEFT JOIN (
           SELECT git_credential_id, COUNT(*)::int AS task_count
             FROM ci_tasks WHERE project_id = $1 GROUP BY git_credential_id
         ) t ON t.git_credential_id = c.id
        WHERE c.project_id = $1
        ORDER BY c.name`,
      [context.project.id],
    );
    return success(result.rows.map(mapGitCredential), { total: result.rowCount });
  });

  app.post<{ Params: { id: string }; Body: { name?: string; method?: string; credential?: string } }>(
    "/api/v1/projects/:id/git-credentials",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, true); if (!context) return;
      const name = request.body?.name?.trim();
      if (!name) return fail(reply, 400, 1001, "credential name is required");
      const method = request.body?.method?.trim() ?? "";
      if (!(METHODS as readonly string[]).includes(method)) {
        return fail(reply, 400, 1001, `method must be one of ${METHODS.join(", ")}`);
      }
      const invalid = validateCredential(method as (typeof METHODS)[number], request.body?.credential);
      if (invalid) return fail(reply, 400, 1001, invalid);

      try {
        const result = await pool.query(
          `INSERT INTO git_credentials (id, project_id, name, method, credential_encrypted, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, project_id, name, method, credential_updated_at, created_by, created_at, updated_at`,
          [randomUUID(), context.project.id, name, method, encryptSecret(request.body!.credential!), context.user.id],
        );
        return reply.code(201).send(success(mapGitCredential(result.rows[0])));
      } catch (error) {
        /* 名字是任务表单下拉里的唯一标识（迁移 041 的 UNIQUE），重名两条选不出来。 */
        if (isUniqueViolation(error)) return fail(reply, 409, 2003, "a credential with this name already exists in this project");
        throw error;
      }
    },
  );

  /**
   * 更新。`credential` 缺省 = 只改名（凭据不动）；给了 = 换凭据。
   *
   * 这不是 secret patch 那套（没有 `null` 删）：一条凭据的存在就是它的凭据，删掉明文等于
   * 删掉这条记录。`method` 可改，但改了就必须同时给新明文——`https_token` 的字符串放进
   * `ssh_key` 的槽位会一路走到 `GIT_SSH_COMMAND` 才炸。
   */
  app.put<{ Params: { id: string; credentialId: string }; Body: { name?: string; method?: string; credential?: string } }>(
    "/api/v1/projects/:id/git-credentials/:credentialId",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, true); if (!context) return;
      if (!isUuid(request.params.credentialId)) return fail(reply, 404, 2001, "git credential not found");
      const existing = await pool.query(
        "SELECT id, name, method FROM git_credentials WHERE id = $1 AND project_id = $2",
        [request.params.credentialId, context.project.id],
      );
      if (!existing.rowCount) return fail(reply, 404, 2001, "git credential not found");

      const name = request.body?.name?.trim() || String(existing.rows[0].name);
      const method = request.body?.method?.trim() || String(existing.rows[0].method);
      if (!(METHODS as readonly string[]).includes(method)) {
        return fail(reply, 400, 1001, `method must be one of ${METHODS.join(", ")}`);
      }
      const hasNewCredential = typeof request.body?.credential === "string" && request.body.credential.trim() !== "";
      if (method !== String(existing.rows[0].method) && !hasNewCredential) {
        return fail(reply, 400, 1001, "changing method requires the new credential value as well");
      }
      if (hasNewCredential) {
        const invalid = validateCredential(method as (typeof METHODS)[number], request.body!.credential);
        if (invalid) return fail(reply, 400, 1001, invalid);
      }

      try {
        const result = await pool.query(
          `UPDATE git_credentials SET
             name = $3, method = $4,
             credential_encrypted = COALESCE($5, credential_encrypted),
             credential_updated_at = CASE WHEN $5::bytea IS NULL THEN credential_updated_at ELSE now() END,
             updated_at = now()
           WHERE id = $1 AND project_id = $2
           RETURNING id, project_id, name, method, credential_updated_at, created_by, created_at, updated_at`,
          [
            request.params.credentialId, context.project.id, name, method,
            hasNewCredential ? encryptSecret(request.body!.credential!) : null,
          ],
        );
        return success(mapGitCredential(result.rows[0]));
      } catch (error) {
        if (isUniqueViolation(error)) return fail(reply, 409, 2003, "a credential with this name already exists in this project");
        throw error;
      }
    },
  );

  /**
   * 删除。被任务引用时**当场拒绝**并列出任务名（迁移 041 的 `ON DELETE RESTRICT`）。
   *
   * 不做 `?force=true`（对比 `environments.ts` 的删除语义）：强删的唯一可能后果是那几个
   * 任务静默退化成「按公开仓库 clone」，然后在下一次执行时以一条 clone 失败告诉用户。
   * 那不是一个用户会想要的选项，所以不提供——改任务的凭据引用是显式动作。
   */
  app.delete<{ Params: { id: string; credentialId: string } }>(
    "/api/v1/projects/:id/git-credentials/:credentialId",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, true); if (!context) return;
      if (!isUuid(request.params.credentialId)) return fail(reply, 404, 2001, "git credential not found");
      const users = await pool.query(
        "SELECT id, name FROM ci_tasks WHERE project_id = $1 AND git_credential_id = $2 ORDER BY name",
        [context.project.id, request.params.credentialId],
      );
      if (users.rowCount) {
        /* 依赖清单进 `data`，照 `environments.ts:156` 的形状：客户端要拿它渲染「谁在用」。 */
        return reply.code(409).send({
          code: 2003,
          message: `this credential is used by ${users.rowCount} CI task(s); point them at another credential first`,
          data: { tasks: users.rows.map((row) => ({ id: String(row.id), name: String(row.name) })) },
        });
      }
      try {
        const result = await pool.query(
          "DELETE FROM git_credentials WHERE id = $1 AND project_id = $2 RETURNING id",
          [request.params.credentialId, context.project.id],
        );
        if (!result.rowCount) return fail(reply, 404, 2001, "git credential not found");
        return success({ id: String(result.rows[0].id) });
      } catch (error) {
        /* 上面那次扫描与这次删除之间有人建了任务：RESTRICT 兜住，翻成同一句话。 */
        if (isForeignKeyViolation(error)) return fail(reply, 409, 2003, "this credential is now used by a CI task; point it at another credential first");
        throw error;
      }
    },
  );
}
