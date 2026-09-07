import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { writeAuditLogAsync } from "../lib/audit.js";
import { issueMcpToken } from "../lib/mcpAuth.js";
import { MCP_TOOLS } from "../lib/mcpServer.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapMcpToken, type McpScope } from "../models/types.js";

/**
 * MCP Token 的签发、列表与吊销（P5-1，计划 9.3）。
 *
 * 项目级、`requireProjectAccess(write=true)`——签发与吊销都是项目管理动作。`/mcp`
 * 端点本身在 P5-3 落地；本文件先回答「钥匙怎么发、怎么收」。审计（9.3）：签发与
 * 吊销写 `audit_logs`（`mcp_token.create` / `mcp_token.revoke`，detail 记 name 与
 * scope——名字与 scope 不是凭据，明文与哈希都不进）。
 *
 * `GET …/mcp/tools`（工具清单展示用，非 MCP 协议面）随 P5-4 的工具面一起落。
 */

/** scope 三值（计划 9.0 边界 1）。签发默认只给 `read`；`write` 与 `execute` 必须显式勾选。 */
const MCP_SCOPES = ["read", "write", "execute"] as const;

/** 归一并校验 scope 入参：去重、保序、不认识的值拒绝而不是静默丢弃。 */
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
  /* read 恒在：write / execute 里的工具都要先能读（`tools/list` 按 scope 裁剪的前提
     是看得见）。单独勾 read 之外的组合没有任何场景，但「给 write 不给 read」会让
     Token 变成只能盲写的钥匙——直接补齐而不是回 400。 */
  if (!scopes.includes("read")) scopes.unshift("read");
  return { scopes };
}

export async function mcpTokenRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/mcp/tokens", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    /* 列名写全而**不是** `SELECT *`：`token_hash` 被 `SELECT *` 带进来后，映射漏一个
       字段就是一次凭据泄露（与 ingest-token / runner-token 列表同款纪律）。
       已吊销的不列：吊销即从管理视图消失，行留在表里供审计对账。 */
    const result = await pool.query(
      `SELECT id, project_id, name, token_prefix, scope, created_by, last_used_at, revoked_at, created_at
         FROM mcp_tokens WHERE project_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [context.project.id],
    );
    return success(result.rows.map(mapMcpToken), { total: result.rowCount });
  });

  /**
   * 签发：明文**只在这一次响应里出现**（与 ingest / runner Token 同一条纪律），丢了
   * 只能吊销重发。签发 `write` scope 的审计尤其重要（9.3）——它是「这个项目从哪一刻
   * 起允许外部写入」的唯一凭证。
   */
  app.post<{ Params: { id: string }; Body: { name?: string; scope?: unknown } }>("/api/v1/projects/:id/mcp/tokens", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const name = request.body?.name?.trim();
    if (!name) return fail(reply, 400, 1001, "token name is required");
    const declared = normalizeScopes(request.body?.scope);
    if (declared.error) return fail(reply, 400, 1001, declared.error);
    const issued = issueMcpToken();
    const result = await pool.query(
      `INSERT INTO mcp_tokens (id, project_id, name, token_hash, token_prefix, scope, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, project_id, name, token_prefix, scope, created_by, last_used_at, revoked_at, created_at`,
      [randomUUID(), context.project.id, name, issued.hash, issued.prefix, declared.scopes!, context.user.id],
    );
    /* 审计（9.3）：detail 只有名字与 scope——明文 token 连日志都不进（明文只在响应里
       出现一次的纪律），token_hash 也不是审计要回答的问题。 */
    writeAuditLogAsync({
      action: "mcp_token.create",
      targetType: "mcp_token",
      targetId: String(result.rows[0].id),
      projectId: context.project.id,
      userId: context.user.id,
      detail: { name, scope: declared.scopes },
      ip: request.ip,
    });
    return reply.code(201).send(success({ ...mapMcpToken(result.rows[0]), token: issued.plaintext }));
  });

  /** 吊销是软删（留 `revoked_at`）：吊销的行要能回答「那次写入是谁放进来的」。部分索引排除吊销行，即时生效。 */
  app.delete<{ Params: { id: string; tokenId: string } }>("/api/v1/projects/:id/mcp/tokens/:tokenId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.tokenId)) return fail(reply, 404, 2001, "mcp token not found");
    const result = await pool.query(
      `UPDATE mcp_tokens SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1 AND project_id = $2
        RETURNING id, project_id, name, token_prefix, scope, created_by, last_used_at, revoked_at, created_at`,
      [request.params.tokenId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "mcp token not found");
    /* 审计（9.3）：吊销是安全敏感动作，谁在什么时候吊了哪把必须可追溯。detail 带
       name 与 scope——吊销的影响面是「外部 agent 的读写执行通道各断了哪些」。 */
    writeAuditLogAsync({
      action: "mcp_token.revoke",
      targetType: "mcp_token",
      targetId: request.params.tokenId,
      projectId: context.project.id,
      userId: context.user.id,
      detail: { name: String(result.rows[0].name), scope: (result.rows[0].scope as unknown[]).map(String) },
      ip: request.ip,
    });
    return success(mapMcpToken(result.rows[0]));
  });

  /**
   * 工具清单（前端展示用，非 MCP 协议面，计划 9.3）：名字 / 说明 / 需要的 scope——
   * P5-6 的 MCP 管理页只读表与签发弹窗都读它。**注册表是单一事实**：`/mcp` 的
   * `tools/list` 与这张表出自同一个 `MCP_TOOLS`，不存在第二份要手工同步的清单。
   * 读权限即可：它回答「这个平台有哪些工具」，不泄露任何项目数据。
   */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/mcp/tools", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    return success(
      MCP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, scope: tool.scope })),
      { total: MCP_TOOLS.length },
    );
  });
}
