import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { executeOperation } from "../lib/operationExecutor.js";
import { canAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { loadSqlDefinition } from "../lib/dataSources.js";
import { executeSql } from "../lib/sqlExecutor.js";
import { loadApiSecretByKeyId } from "../lib/apiKeys.js";
import { MAX_TOKEN_CHARS, decodeToken, readCredential, type QuickCallTarget } from "../lib/sqlQuickCall.js";
import { mapUser } from "../models/types.js";

/**
 * SQL 快速调用公开端点（免登录，API 密钥即凭据）。
 *
 * `POST /api/v1/public/sql-quick-call`
 *   Header:  `Authorization: ApiKey <keyId>.<token>`（或 `X-Api-Key` + `X-Api-Token`）
 *   Body:    `{ "param": { "a": "xxx" } }`
 *
 * - `keyId` 是公开查找标识，用来定位是哪一把个人 API 密钥；
 * - `token` 是用那把密钥 AES-256-GCM 加密的 `{ projectId, sqlDefinitionId }`——既是凭据
 *   （解得开即视为持钥人签发），也指明跑哪条 SQL 定义（放进密文里，防止拿一个令牌点名
 *   别人的定义）；
 * - 入参在请求体 `param`（或 `values`）里动态传，所以同一个令牌可反复复用、每次不同参数。
 *
 * 三道闸门缺一不可（不走 JWT，与报告分享 / Webhook 公开路由同层）：
 * 1. keyId 定位到密钥（吊销 = 删行，立即失效）；
 * 2. token 用该密钥解得开（密钥即凭据）；
 * 3. 令牌里的持钥人**此刻**仍对该项目有 write 权限（`canAccess`，与 `/query`、`/test`
 *    同口径——viewer 不可跑；账号禁用即失效）。绑定/角色随时可变，调用时刻实时重判。
 */
export async function sqlQuickCallRoutes(app: FastifyInstance) {
  app.post<{ Body: { param?: Record<string, unknown>; values?: Record<string, unknown> } }>(
    "/api/v1/public/sql-quick-call",
    async (request, reply) => {
      const credential = readCredential(request.headers as Record<string, unknown>);
      /* 缺头 / 头格式不对，与「密钥不对」收敛成同一句 401，不给探测者区分信号。 */
      if (!credential || credential.keyId.length > 64 || !credential.token || credential.token.length > MAX_TOKEN_CHARS) {
        return fail(reply, 401, 1002, "invalid quick-call credentials");
      }

      const key = await loadApiSecretByKeyId(credential.keyId);
      if (!key) return fail(reply, 401, 1002, "invalid quick-call credentials");

      /* 解密即认证：任何解密 / 形状失败都收敛成同一句 401。 */
      let target: QuickCallTarget;
      try { target = decodeToken(key.secret, credential.token); }
      catch { return fail(reply, 401, 1002, "invalid quick-call credentials"); }

      /* 持钥人此刻仍须是活跃账号（禁用即失效，无需另设吊销表——与会话 pwdEpoch 同思路）。 */
      const userRow = await pool.query("SELECT id, email, name, password_hash, is_system_admin, status FROM users WHERE id = $1 AND status = 'active'", [key.userId]);
      if (!userRow.rowCount) return fail(reply, 401, 1002, "invalid quick-call credentials");
      const user = mapUser(userRow.rows[0]);

      /* 实时权限（第三道闸门）：跑 SQL 要 write，与项目内 `/query`、`/test` 一致。 */
      if (!await canAccess(user, target.projectId, true)) return fail(reply, 403, 1003, "forbidden");

      const definition = await loadSqlDefinition(target.projectId, target.sqlDefinitionId);
      if (!definition) return fail(reply, 404, 2001, "SQL definition not found");

      /* 入参：`param` 优先（用户口径），兼容 `values`。非对象一律当空对象，交给执行器按
         定义的参数名绑定（`{{a}}` → 命名参数）。 */
      const raw = request.body?.param ?? request.body?.values;
      const values = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      try {
        /* 执行器内部会 loadDataSource；数据源已删时抛 "data source not found" → 下面翻 404。 */
        const result = definition.kind === "sql"
          ? await executeSql({ projectId: target.projectId, dataSourceId: definition.dataSourceId, statementType: definition.statementType!, sql: definition.sql!, params: definition.params, values })
          : await executeOperation({ projectId: target.projectId, dataSourceId: definition.dataSourceId, kind: definition.kind, operation: definition.operation, params: definition.params, values });
        return success(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "SQL execution failed";
        return message === "data source not found" ? fail(reply, 404, 2001, message) : fail(reply, 400, 2002, message);
      }
    },
  );
}
