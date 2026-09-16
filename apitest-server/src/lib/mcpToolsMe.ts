import { pool } from "../db.js";
import type { McpToolDefinition } from "./mcpServer.js";
import { toolResult } from "./mcpToolResult.js";

/**
 * 用户级工具（P12-1，计划 18.0 边界 5）：`list_my_projects`。
 *
 * **为什么单独一个工具**：`tools/list` 回不了「这把 token 能触达哪些项目」——它是能力面
 * 清单，不是绑定清单。没有它，agent 拿到一次 `projectId is not bound` 只能靠人转述该填
 * 什么；有了它，agent 一轮自查就知道该往哪个 `projectId` 上发。
 *
 * **它是 PROJECT_FREE_TOOL**（`lib/mcpServer.ts`）：不携带 `projectId`、不受闸门②③，
 * 且**零绑定时也注册**——「我没有可触达的项目」必须是一句问得出来的话，否则 agent
 * 面对的是一个空 `tools/list` 和一个说不清原因的失败。
 *
 * 输出对每条绑定给出：项目身份（id / 名称）、该绑定的 scope、项目 MCP 开关、owner
 * 当下的实时角色与 `reachable`。**`reachable` 是 live 的**（读时 JOIN 角色与开关）：
 * 绑定是过滤器不是授权（边界 3），owner 被移出项目或项目关了 MCP 之后，这里要能看出
 * 「门还在、钥匙不对了」，而不是继续报可触达。
 */

/** 三值里 read 恒在，故只读绑定也永远能调用本工具本身。 */
const ROLE_MAX_SCOPE: Record<string, string[]> = {
  system_admin: ["read", "write", "execute"],
  project_admin: ["read", "write", "execute"],
  developer: ["read", "write", "execute"],
  viewer: ["read"],
};

export const ME_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "list_my_projects",
    description: "List the projects THIS token is bound to, with the scope granted on each binding, the project's MCP channel state, and the issuer's live role. Call this first when a projectId is missing or rejected — every other tool takes a required projectId that must appear here. `reachable: false` means the binding exists but calls to that project will be refused (channel off, or the issuer lost the role). This tool takes no projectId and cannot list projects the token is not bound to (such projects exist but are invisible here), cannot create bindings (bind/unbind is a platform UI action), and returns no project metrics.",
    scope: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, identity) => {
      /* 一条 SQL 拿到全部读数：绑定 ∩ 项目 ∩ 开关 ∩ owner 的实时角色。
         `user_project_roles` 的 join 带 user_id，故「角色被撤」表现为 role = null。 */
      const owner = await pool.query("SELECT is_system_admin, status FROM users WHERE id = $1", [identity.createdBy ?? ""]);
      const isSystemAdmin = Boolean(owner.rows[0]?.is_system_admin) && owner.rows[0]?.status === "active";
      const result = await pool.query(
        `SELECT p.id, p.name, p.description, b.scope, COALESCE(s.mcp_enabled, false) AS mcp_enabled,
                r.role, b.bound_at
           FROM mcp_token_projects b
           JOIN projects p ON p.id = b.project_id
           LEFT JOIN project_settings s ON s.project_id = p.id
           LEFT JOIN user_project_roles r ON r.project_id = p.id AND r.user_id = $2
          WHERE b.token_id = $1
          ORDER BY p.name`,
        [identity.tokenId, identity.createdBy ?? null],
      );
      return toolResult({
        projects: result.rows.map((row) => {
          const scope = Array.isArray(row.scope) ? (row.scope as unknown[]).map(String) : [];
          const role = isSystemAdmin ? "system_admin" : (row.role ? String(row.role) : null);
          const maxScope = role ? (ROLE_MAX_SCOPE[role] ?? []) : [];
          /* scope 只在角色允许的范围内才生效（绑定时已校验，撤权后这里会掉下来）。 */
          const effective = scope.filter((each) => maxScope.includes(each));
          const mcpEnabled = Boolean(row.mcp_enabled);
          return {
            projectId: String(row.id),
            name: String(row.name),
            description: String(row.description ?? ""),
            scope,
            effectiveScope: effective,
            mcpEnabled,
            role,
            reachable: mcpEnabled && effective.includes("read"),
            boundAt: new Date(String(row.bound_at)).toISOString(),
          };
        }),
        total: result.rowCount ?? 0,
      });
    },
  },
];
