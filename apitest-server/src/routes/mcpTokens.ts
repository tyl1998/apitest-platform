import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { writeAuditLogAsync } from "../lib/audit.js";
import { MCP_TOOLS } from "../lib/mcpServer.js";
import { requireProjectAccess, requireProjectAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapMcpProjectBinding } from "../models/types.js";

/**
 * 项目侧的 MCP 绑定视图（P12-1，计划 18.3）。**能力面上移到用户级**：
 * `/projects/:id/mcp/tokens` 的签发 / 列出 / 吊销三条已删除——签发是「本人」的动作
 * （`/api/v1/me/mcp/tokens`，`routes/me.ts`），scope 在绑定上不在 token 上。
 *
 * 本项目保留两条：
 * - `GET /projects/:id/mcp/bindings`：谁把钥匙开到了我这扇门上（绑定人 / scope /
 *   last_used_at）。
 * - `DELETE /projects/:id/mcp/bindings/:tokenId`：项目管理员踢绑定（边界 4——签发权上移
 *   后，项目侧对「谁的开门钥匙能开我这扇门」的最终控制不丢）。**用
 *   `requireProjectAdmin` 而不是 `requireProjectAccess(write)`**：18.3 的注记写的是
 *   `(write)`，但边界 4 的定语是「项目管理员」——让 developer 能踢别人的 key 是权限上移，
 *   不是等价搬移。owner 自助解绑走 `/me` 那条。
 *
 * `GET /projects/:id/mcp/tools`（工具清单展示用，非 MCP 协议面）保留：它回答「这个平台
 * 有哪些工具」，不泄露任何项目数据，读权限即可。
 */

export async function mcpTokenRoutes(app: FastifyInstance) {
  /* 列名写全而**不是** `SELECT *`：`secret_encrypted` 被 `SELECT *` 带进来后，映射漏一个
     字段就是一次凭据泄露（与 ingest-token / runner-token 列表同款纪律）。明文与哈希
     都不出现在这里——项目管理员只需要知道「谁的哪把钥匙」。已吊销的 token 不列：
     闸门①已排除它，列表再展示只会制造「是不是还能用」的疑问。 */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/mcp/bindings", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const result = await pool.query(
      `SELECT b.token_id, t.name AS token_name, t.token_prefix,
              t.created_by AS owner_id, u.email AS owner_email, u.name AS owner_name,
              b.scope, t.last_used_at, b.bound_at
         FROM mcp_token_projects b
         JOIN mcp_tokens t ON t.id = b.token_id
         LEFT JOIN users u ON u.id = t.created_by
        WHERE b.project_id = $1 AND t.revoked_at IS NULL
        ORDER BY b.bound_at DESC`,
      [context.project.id],
    );
    return success(result.rows.map(mapMcpProjectBinding), { total: result.rowCount });
  });

  /**
   * 踢绑定（边界 4）。只删绑定行，不吊销 token：owner 可能还拿这把 token 开着别的项目
   * 的门，项目管理员收的是「我这扇门」，不是别人的钥匙。
   */
  app.delete<{ Params: { id: string; tokenId: string } }>("/api/v1/projects/:id/mcp/bindings/:tokenId", async (request, reply) => {
    const context = await requireProjectAdmin(request, reply); if (!context) return;
    if (!isUuid(request.params.tokenId)) return fail(reply, 404, 2001, "mcp binding not found");
    const result = await pool.query(
      `DELETE FROM mcp_token_projects WHERE token_id = $1 AND project_id = $2 RETURNING scope`,
      [request.params.tokenId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "mcp binding not found");
    /* 审计（边界 8）：detail 记项目与 scope——解绑的影响面是「外部 agent 对这个项目的
       读写执行通道断在哪几档」。明文与哈希仍不进。 */
    writeAuditLogAsync({
      action: "mcp_token.unbind",
      targetType: "mcp_token",
      targetId: request.params.tokenId,
      projectId: context.project.id,
      userId: context.user.id,
      detail: { projectId: context.project.id, scope: (result.rows[0].scope as unknown[]).map(String), via: "project_admin" },
      ip: request.ip,
    });
    return success({ tokenId: request.params.tokenId, projectId: context.project.id });
  });

  /**
   * 工具清单（前端展示用，非 MCP 协议面，计划 9.3）：名字 / 说明 / 需要的 scope——
   * MCP 管理页的只读表读它。**注册表是单一事实**：`/mcp` 的 `tools/list` 与这张表出自
   * 同一个 `MCP_TOOLS`，不存在第二份要手工同步的清单。
   */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/mcp/tools", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    return success(
      MCP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, scope: tool.scope })),
      { total: MCP_TOOLS.length },
    );
  });
}