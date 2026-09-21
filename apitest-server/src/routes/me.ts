import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { currentUser } from "../lib/auth.js";
import { writeAuditLogAsync } from "../lib/audit.js";
import { issueMcpToken } from "../lib/mcpAuth.js";
import { MCP_SCOPES, effectiveMcpScopes, grantedMcpScopesByProject, mergeMcpScopes } from "../lib/mcpScopes.js";
import { myRoleInProject } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapMcpBinding, mapMcpToken, type McpScope, type MyRole } from "../models/types.js";

/**
 * 个人中心（P12，计划 18.3）的**用户级 REST 面**：全局层、无项目前缀。
 *
 * 三个落点在这里集齐：
 * - 基本信息（`/me/profile`，`/auth/me` 的聚合别名——改密仍走既有
 *   `POST /auth/change-password`，零改动，本文件不碰它）；
 * - 可绑定项目（`/me/bindable-projects`，canAccess 项目集 + 每项目的 scope 上限）；
 * - MCP Token 的用户级五条（列表 / 签发 / 吊销 / 绑定 / 解绑）——**能力面从项目侧整个
 *   搬来**：token 归人（18.0 边界 2），签发与吊销从「项目 write」改为「本人」，
 *   写权限的控制点移到绑定（边界 3/4，纪律等价）。
 *
 * **绑定不是授权，是过滤器**（边界 3）：绑定时要求实时角色匹配（read 绑定需该项目
 * read、write/execute 绑定需该项目 write），调用时刻还会每次重跑 `canAccess`——
 * 所以这里校验过不等于以后一直放行，它只保证「申请时你说得出理由」。
 *
 * **角色上限不是唯一来源（2026-09-21）**：绑定时校验的是 `lib/mcpScopes.ts` 的
 * **有效 scope**（角色上限 ∪ 本人在该项目已被批准的绑定许可申请，迁移 070）。
 * 项目管理员批准一条许可后，这一档就进得了绑定，`/mcp` 第 5 道闸门也认同一条批准
 * ——申请入口在项目 MCP 页（`routes/mcpBindingRequests.ts`）。
 *
 * 审计（边界 8）：`mcp_token.create` 改挂用户级（无 projectId）；`mcp_token.bind` /
 * `mcp_token.unbind` 记项目与 scope。明文 token 与哈希一律不进审计（既有纪律）。
 */

/**
 * 归一并校验绑定 scope 入参：去重、保序、不认识的值拒绝而不是静默丢弃。
 *
 * 从 `routes/mcpTokens.ts` 原样搬来（边界 2：归一搬到绑定侧）；`read` 恒在——write /
 * execute 里的工具都要先能读（`tools/list` 按 scope 裁剪的前提是看得见），「给 write
 * 不给 read」会让 Token 变成只能盲写的钥匙，直接补齐而不是回 400。
 */
function normalizeScopes(input: unknown): { scopes?: McpScope[]; error?: string } {
  if (input === undefined || input === null) return { scopes: ["read"] };
  if (!Array.isArray(input)) return { error: "scope must be an array of read / write / execute" };
  const scopes = [...new Set(input.map((each) => String(each ?? "").trim()).filter(Boolean))] as McpScope[];
  if (!scopes.length) return { scopes: ["read"] };
  for (const scope of scopes) {
    if (!(MCP_SCOPES as readonly string[]).includes(scope)) {
      return { error: `scope "${scope}" is not one of ${MCP_SCOPES.join(" / ")}` };
    }
  }
  if (!scopes.includes("read")) scopes.unshift("read");
  return { scopes };
}

export async function meRoutes(app: FastifyInstance) {
  /**
   * 基本信息：`/auth/me` 的聚合别名（同一投影 + `mustChangePassword`）。为什么两个端点
   * 都留着：`/auth/me` 是会话自检（PasswordGate 刷新时用），`/me/profile` 是个人中心的
   * 读模型——将来个人中心长出新字段时不必把会话自检撑大，两条读同一个投影而已。
   */
  app.get("/api/v1/me/profile", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    const flags = await pool.query("SELECT must_change_password FROM users WHERE id = $1", [user.id]);
    return success({
      id: user.id, email: user.email, name: user.name, isSystemAdmin: user.isSystemAdmin,
      mustChangePassword: Boolean(flags.rows[0]?.must_change_password),
    });
  });

  /**
   * 可绑定项目：本人有角色的项目集 + 每项目的 scope 上限（前端绑定弹窗据此禁用选项）。
   * 系统管理员对所有项目短路为 system_admin。**不返回任何项目指标**——这只是绑定选择器
   * 的选项源，不是项目目录。
   *
   * `maxScope` 是**有效**上限（2026-09-21）：角色上限 ∪ 本项目已批准的绑定许可申请。
   * 已批准但还没绑的档位在这里就要可见——否则用户批完仍看到灰勾选框，以为批准没生效。
   */
  app.get("/api/v1/me/bindable-projects", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    const result = user.isSystemAdmin
      ? await pool.query("SELECT id, name FROM projects ORDER BY name")
      : await pool.query(
          `SELECT p.id, p.name, r.role FROM projects p
             JOIN user_project_roles r ON r.project_id = p.id AND r.user_id = $1
            ORDER BY p.name`,
          [user.id],
        );
    /* 已批准申请一次全取，逐项目合（每个项目一条查询在这里是 N+1）。 */
    const grants = await grantedMcpScopesByProject(user.id);
    return success({
      projects: result.rows.map((row) => {
        const projectId = String(row.id);
        const role = (user.isSystemAdmin ? "system_admin" : String(row.role)) as MyRole;
        return {
          projectId,
          name: String(row.name),
          role,
          maxScope: mergeMcpScopes(role, grants.get(projectId) ?? []),
        };
      }),
      total: result.rowCount ?? 0,
    });
  });

  /**
   * 本人 token 列表（含绑定数组）。**已吊销的不列**：吊销即从管理视图消失，行留在表里
   * 供审计对账（与 ingest / runner token 列表同一口径）。token_hash 永不进投影。
   */
  app.get("/api/v1/me/mcp/tokens", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    const result = await pool.query(
      `SELECT t.id, t.name, t.token_prefix, t.created_by, t.last_used_at, t.revoked_at, t.created_at,
              COALESCE(b.bindings, '[]'::jsonb) AS bindings
         FROM mcp_tokens t
         LEFT JOIN (
           SELECT token_id,
                  jsonb_agg(jsonb_build_object('project_id', project_id, 'scope', scope, 'bound_at', bound_at) ORDER BY bound_at) AS bindings
             FROM mcp_token_projects GROUP BY token_id
         ) b ON b.token_id = t.id
        WHERE t.created_by = $1 AND t.revoked_at IS NULL
        ORDER BY t.created_at DESC`,
      [user.id],
    );
    return success(result.rows.map(mapMcpToken), { total: result.rowCount });
  });

  /**
   * 签发本人 token。**明文只在这一次响应里出现**（与 ingest / runner Token 同一条纪律），
   * 丢了只能吊销重发。request 里没有 scope：scope 在绑定上（边界 2），签发本身不产生任何
   * 项目级权限——新 token 一行绑定都没有，任何 tools/call 都会因未绑定被拒。
   */
  app.post<{ Body: { name?: string } }>("/api/v1/me/mcp/tokens", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    const name = request.body?.name?.trim();
    if (!name) return fail(reply, 400, 1001, "token name is required");
    const issued = issueMcpToken();
    const result = await pool.query(
      `INSERT INTO mcp_tokens (id, name, token_hash, token_prefix, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, token_prefix, created_by, last_used_at, revoked_at, created_at`,
      [randomUUID(), name, issued.hash, issued.prefix, user.id],
    );
    /* 审计（边界 8）：create 改挂用户级，`project_id` 为空——token 归人，不归项目；
       detail 只带 name（明文与哈希都不进）。 */
    writeAuditLogAsync({
      action: "mcp_token.create",
      targetType: "mcp_token",
      targetId: String(result.rows[0].id),
      projectId: null,
      userId: user.id,
      detail: { name },
      ip: request.ip,
    });
    return reply.code(201).send(success({ ...mapMcpToken(result.rows[0]), token: issued.plaintext }));
  });

  /**
   * 吊销本人 token（软删留审计）：吊销行要能回答「那次写入是谁放进来的」。部分索引排除
   * 吊销行，即时生效、无缓存窗口。绑定行不级联删除——闸门①已排除吊销 token，绑定不再
   * 产生行为；留行让「它曾经开过哪几扇门」可对账。
   */
  app.delete<{ Params: { tokenId: string } }>("/api/v1/me/mcp/tokens/:tokenId", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    if (!isUuid(request.params.tokenId)) return fail(reply, 404, 2001, "mcp token not found");
    const result = await pool.query(
      `UPDATE mcp_tokens SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1 AND created_by = $2
        RETURNING id, name, token_prefix, created_by, last_used_at, revoked_at, created_at`,
      [request.params.tokenId, user.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "mcp token not found");
    writeAuditLogAsync({
      action: "mcp_token.revoke",
      targetType: "mcp_token",
      targetId: request.params.tokenId,
      projectId: null,
      userId: user.id,
      detail: { name: String(result.rows[0].name) },
      ip: request.ip,
    });
    return success(mapMcpToken(result.rows[0]));
  });

  /**
   * 绑定 token 到项目（或改该绑定的 scope）。**绑定时刻要求实时角色匹配**（边界 3）：
   * 申请的每个 scope 都必须落在本人的**有效上限**内（角色上限 ∪ 本项目已批准的绑定
   * 许可申请，迁移 070）——viewer 默认只能绑 read，除非项目管理员批过更高档位。同
   * (token, project) 重复绑定 = 改 scope（upsert）。
   */
  app.post<{ Params: { tokenId: string }; Body: { projectId?: string; scope?: unknown } }>("/api/v1/me/mcp/tokens/:tokenId/bindings", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    if (!isUuid(request.params.tokenId)) return fail(reply, 404, 2001, "mcp token not found");
    const projectId = request.body?.projectId?.trim();
    if (!projectId || !isUuid(projectId)) return fail(reply, 400, 1001, "projectId must be a UUID");
    const declared = normalizeScopes(request.body?.scope);
    if (declared.error) return fail(reply, 400, 1001, declared.error);

    const owned = await pool.query("SELECT 1 FROM mcp_tokens WHERE id = $1 AND created_by = $2 AND revoked_at IS NULL", [request.params.tokenId, user.id]);
    if (!owned.rowCount) return fail(reply, 404, 2001, "mcp token not found");
    /* 项目存在性显式判（`myRoleInProject` 对系统管理员短路，不会替不存在的项目把关）。 */
    const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [projectId]);
    if (!project.rowCount) return fail(reply, 404, 2001, "project not found");

    /* 实时角色（边界 3）+ 已批准许可（2026-09-21）：非成员不能绑；超出**有效上限**
       （角色 ∪ 批准的绑定许可申请）的档位要先走项目 MCP 页的申请通道。 */
    const role = await myRoleInProject(user, projectId);
    if (!role) return fail(reply, 403, 1003, "forbidden: you are not a member of that project");
    const maxScope = await effectiveMcpScopes(role, user.id, projectId);
    for (const scope of declared.scopes!) {
      if (!maxScope.includes(scope)) return fail(reply, 403, 1003, `forbidden: scope "${scope}" exceeds your role in that project`);
    }

    const result = await pool.query(
      `INSERT INTO mcp_token_projects (token_id, project_id, scope) VALUES ($1, $2, $3)
       ON CONFLICT (token_id, project_id) DO UPDATE SET scope = EXCLUDED.scope, bound_at = now()
       RETURNING project_id, scope, bound_at`,
      [request.params.tokenId, projectId, declared.scopes],
    );
    /* 审计（边界 8）：detail 记项目与 scope——绑定的影响面就是「外部 agent 的读写执行
       通道给哪个项目开了哪几档门」。 */
    writeAuditLogAsync({
      action: "mcp_token.bind",
      targetType: "mcp_token",
      targetId: request.params.tokenId,
      projectId,
      userId: user.id,
      detail: { projectId, scope: declared.scopes },
      ip: request.ip,
    });
    return success(mapMcpBinding(result.rows[0]));
  });

  /**
   * 本人解绑（边界 4 的 owner 侧）。只删绑定行——token 本身留着，其他项目的门照旧。
   */
  app.delete<{ Params: { tokenId: string; projectId: string } }>("/api/v1/me/mcp/tokens/:tokenId/bindings/:projectId", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return;
    if (!isUuid(request.params.tokenId) || !isUuid(request.params.projectId)) return fail(reply, 404, 2001, "mcp binding not found");
    const owned = await pool.query("SELECT 1 FROM mcp_tokens WHERE id = $1 AND created_by = $2", [request.params.tokenId, user.id]);
    if (!owned.rowCount) return fail(reply, 404, 2001, "mcp token not found");
    const result = await pool.query(
      `DELETE FROM mcp_token_projects WHERE token_id = $1 AND project_id = $2 RETURNING scope`,
      [request.params.tokenId, request.params.projectId],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "mcp binding not found");
    writeAuditLogAsync({
      action: "mcp_token.unbind",
      targetType: "mcp_token",
      targetId: request.params.tokenId,
      projectId: request.params.projectId,
      userId: user.id,
      detail: { projectId: request.params.projectId, scope: (result.rows[0].scope as unknown[]).map(String), via: "owner" },
      ip: request.ip,
    });
    return success({ tokenId: request.params.tokenId, projectId: request.params.projectId });
  });
}