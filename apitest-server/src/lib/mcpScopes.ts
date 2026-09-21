import { pool } from "../db.js";
import { mcpScopes, type McpScope, type MyRole } from "../models/types.js";

/**
 * MCP scope 的角色上限与「有效 scope」（2026-09-21 用户反馈：项目内 MCP 绑定许可申请）。
 *
 * 两条来源合起来才是「这个人现在能把 Token 绑到哪几档」：
 *
 * 1. **实时角色**（`ROLE_MAX_SCOPE`）——从 P12 起的既有口径：viewer 只有 read，
 *    其余角色全档；
 * 2. **已批准的绑定许可申请**（迁移 070 `mcp_binding_requests`）——项目管理员为
 *    「这个人在这个项目」额外批下来的档位。
 *
 * 绑定校验与 `/mcp` 的第 5 道闸门都读这一份并集：批准的是**绑定许可**，不是角色
 * （用户 2026-09-21 选定口径）——所以它必须同时放宽「能不能绑」与「绑了能不能调」，
 * 只放宽前者会让批准变成一张空头支票（`tools/call` 仍被角色闸门拦下）。
 *
 * 这一层独立成 lib 而不是塞进 `rbac.ts`：rbac 回答「角色是什么」，这里回答「MCP 通道
 * 给到哪几档」，两者的缓存与失效条件不同（角色改了就要重判，批准是另一条时间线）。
 */

/** scope 三值（计划 9.0 边界 1；P12 移到绑定上）。顺序即展示顺序。 */
export const MCP_SCOPES: readonly McpScope[] = ["read", "write", "execute"];

/** 角色 → 该角色直接能拿到的 scope 上限（绑定时校验）。viewer 只有 read；三种写角色全档。 */
export const ROLE_MAX_SCOPE: Record<MyRole, McpScope[]> = {
  system_admin: ["read", "write", "execute"],
  project_admin: ["read", "write", "execute"],
  developer: ["read", "write", "execute"],
  viewer: ["read"],
};

/** 按固定顺序合并去重（read → write → execute），出参稳定、前端勾选顺序不抖动。 */
function unionScopes(...groups: McpScope[][]): McpScope[] {
  const set = new Set(groups.flat());
  return MCP_SCOPES.filter((scope) => set.has(scope));
}

/** 本人已批准申请带来的额外档位（单个项目）。 */
export async function grantedMcpScopes(userId: string, projectId: string): Promise<McpScope[]> {
  const result = await pool.query(
    "SELECT scope FROM mcp_binding_requests WHERE user_id = $1 AND project_id = $2 AND status = 'approved'",
    [userId, projectId],
  );
  return unionScopes(...result.rows.map((row) => mcpScopes(row.scope)));
}

/**
 * 批量读（可绑定项目选择器用，避免每个项目一次查询）：一次取出本人全部已批准申请，
 * 按项目聚合成 `projectId → 额外档位`。
 */
export async function grantedMcpScopesByProject(userId: string): Promise<Map<string, McpScope[]>> {
  const result = await pool.query(
    "SELECT project_id, scope FROM mcp_binding_requests WHERE user_id = $1 AND status = 'approved'",
    [userId],
  );
  const byProject = new Map<string, McpScope[][]>();
  for (const row of result.rows) {
    const projectId = String(row.project_id);
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), mcpScopes(row.scope)]);
  }
  return new Map([...byProject].map(([projectId, groups]) => [projectId, unionScopes(...groups)] as const));
}

/** 某个项目里本人的有效 scope 集 = 角色上限 ∪ 已批准申请（单项目版）。 */
export async function effectiveMcpScopes(role: MyRole, userId: string, projectId: string): Promise<McpScope[]> {
  return mergeMcpScopes(role, await grantedMcpScopes(userId, projectId));
}

/** 纯函数版并集（角色上限 ∪ 额外档位）：批量场景拿一次批准集后逐项目合，不再逐项目查库。 */
export function mergeMcpScopes(role: MyRole, granted: McpScope[]): McpScope[] {
  return unionScopes(ROLE_MAX_SCOPE[role] ?? ["read"], granted);
}

/**
 * `/mcp` 第 5 道闸门用：这一档是否被批准过。read 档角色本身就够（viewer 也放行），
 * 只有 write / execute 会走到这里——**单档判**，批了 write 不等于能 execute。
 */
export async function hasMcpScopeGrant(userId: string, projectId: string, scope: McpScope): Promise<boolean> {
  if (scope === "read") return false;
  const result = await pool.query(
    "SELECT 1 FROM mcp_binding_requests WHERE user_id = $1 AND project_id = $2 AND status = 'approved' AND $3 = ANY(scope) LIMIT 1",
    [userId, projectId, scope],
  );
  return result.rowCount === 1;
}
