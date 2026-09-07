import { createMcpHandler, localhostAllowedHostnames, validateHostHeader, validateOriginHeader } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { FastifyInstance, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, writeAuditLogAsync } from "../lib/audit.js";
import { authenticateMcp, mcpBearerToken, type McpIdentity } from "../lib/mcpAuth.js";
import { buildMcpServer, findMcpTool, mcpAuthInfo, mcpIdentityFromAuthInfo } from "../lib/mcpServer.js";
import { canAccess } from "../lib/rbac.js";
import { mapUser } from "../models/types.js";

/**
 * `/mcp` 端点（P5-3，计划 9.2 / 9.3）。一条无状态 `POST /mcp`，`apimcp_` Token 鉴权——
 * 平台是 MCP Server（工具提供方），不是 Client。
 *
 * **端点路径不带 `/api/v1` 前缀**（边界 11）：那个前缀是给平台自己前端的版本化 REST
 * 面用的，MCP 的版本协商在协议层（`MCP-Protocol-Version` 头），再叠一层路径版本等于
 * 两套版本号指同一件事。与 `/ingest`、`/runner/*` 同款挂法。
 *
 * **错误不走 REST 信封**（9.4 刻意的例外，`success()`/`fail()` 在这条路径不适用）：
 * MCP 有自己的 JSON-RPC 错误形状；业务错误码（1002/1003/…）仍然出现在消息文本里，
 * 便于排查时与 REST 面对照。
 *
 * **挂载方式照计划 9.2 的三条细节**：不用 SDK 的 `createMcpFastifyApp`（它会另起一个
 * Fastify 实例，两个实例意味着两个端口或一层反代）；Fastify 已解析的 JSON body 必须
 * 作为第三个参数传给 node 适配层（否则它去重读一个已被消费的流）；工厂每请求执行一次，
 * 工具注册在工厂内部。
 */

/** 从可能成数组的头值里取第一个（node 把重复头并成数组）。 */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** in-band 协议错误按 SDK 口径回 HTTP 200（错误在 JSON-RPC 体里，不是 HTTP 失败）。 */
function jsonRpcError(reply: FastifyReply, status: number, id: unknown, code: number, message: string) {
  reply.code(status).send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** 第 1 道闸门不过（401）。RFC 6750：401 携带 WWW-Authenticate。 */
function failMcpUnauthorized(reply: FastifyReply) {
  reply.code(401).header("WWW-Authenticate", 'Bearer realm="apitest-mcp"')
    .send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "unauthorized: mcp token is invalid or revoked (1002)" } });
}

/** 第 4 道闸门不过（403）：签发人已无项目写权限（或已被删）。 */
function failMcpForbidden(reply: FastifyReply, id: unknown) {
  jsonRpcError(reply, 403, id, -32000, "forbidden: this token's issuer no longer has write access to the project (1003)");
}

/** Host / Origin 校验不过（403）。形状照 SDK 的 hostHeaderValidationResponse，客户端看不出差异。 */
function failMcpGuard(reply: FastifyReply, message: string) {
  jsonRpcError(reply, 403, undefined, -32000, message);
}

/** 一个 tools/call 的目标：请求 id（错误回显用）与工具名（可能缺失，交给 SDK 判参）。 */
type ToolsCallTarget = { id: unknown; name?: string };

/**
 * 从 JSON-RPC 体里取出全部 `tools/call` 的目标。**只看 body 不看 `Mcp-Method` /
 * `Mcp-Name` 头**：头是给网关路由用的提示，SDK 自己会做头体一致性校验（不一致
 * `-32020`），body 才是权威来源。批量体（2025 遗留）逐元素检查——批里任何一个元素
 * 调了不可见工具，整个请求都在这里被拒。
 */
function toolsCallTargets(body: unknown): ToolsCallTarget[] {
  const targets: ToolsCallTarget[] = [];
  for (const message of Array.isArray(body) ? body : [body]) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.method !== "tools/call") continue;
    const params = record.params as Record<string, unknown> | undefined;
    targets.push({ id: record.id, name: typeof params?.name === "string" ? params.name : undefined });
  }
  return targets;
}

/** 第 2 道闸门的读数。无行 = false（照 `lib/run.ts` 读 `store_plaintext` 的写法）。 */
async function mcpEnabled(projectId: string): Promise<boolean> {
  const result = await pool.query("SELECT mcp_enabled FROM project_settings WHERE project_id = $1", [projectId]);
  return Boolean(result.rows[0]?.mcp_enabled);
}

/**
 * 第 4 道闸门：写/执行工具按**签发人**重跑 `canAccess`（边界 2——Token 只是一把钥匙，
 * 不是一份权限快照；签发人被降成 viewer 或被移出项目，Token 立刻写不动）。签发人已被
 * 删（`created_by` 为 NULL）时一律拒绝：没有人为这次写入负责。
 */
async function tokenMayWrite(identity: McpIdentity): Promise<boolean> {
  if (!identity.createdBy) return false;
  /* 列集与 currentUser 同款——mapUser 需要 password_hash。 */
  const result = await pool.query(
    "SELECT id, email, name, password_hash, is_system_admin FROM users WHERE id = $1 AND status = 'active'",
    [identity.createdBy],
  );
  if (!result.rowCount) return false;
  return canAccess(mapUser(result.rows[0]), identity.projectId, true);
}

export async function mcpRoutes(app: FastifyInstance) {
  /* SDK handler 一个进程建一次；每请求一个 McpServer 实例由工厂出（9.2）。`legacy:
     'stateless'`（默认值，显式写出）让 2025 系流量（initialize 握手、Mcp-Session-Id、
     无 per-request _meta）由同一个工厂无状态服务——智能体平台按 STREAMABLE_HTTP
     （2025-06-18）注册就落在这条兼容腿上；老 GET/DELETE 由 SDK 答 405。 */
  const handler = createMcpHandler((ctx) => buildMcpServer(mcpIdentityFromAuthInfo(ctx.authInfo)), {
    legacy: "stateless",
    onerror: (error) => app.log.error(error, "mcp handler error"),
  });
  /* 两层 onerror 分属两层：上面那个报 SDK 入口内部失败，这个报 node 适配层自己答 500
     的失败（请求转换炸了 / handler.fetch 抛了）。 */
  const node = toNodeHandler(handler, { onerror: (error) => app.log.error(error, "mcp node adapter error") });

  /**
   * DNS rebinding 防护的 Host 白名单（9.2：不用 createMcpFastifyApp，就把它的防护单独
   * 立起来）。默认 localhost 三件套 + `PUBLIC_BASE_URL` 的主机名（智能体平台拿到的端点
   * 地址从它拼来，Host 自然落在它身上）；内网任意 hostname 部署用 `MCP_ALLOWED_HOSTS`
   * 追加，`*` 为彻底逃生门（默认不开）。
   */
  const extraHosts = process.env.MCP_ALLOWED_HOSTS?.trim();
  const allowAllHosts = extraHosts === "*";
  const hostnames = new Set(localhostAllowedHostnames());
  const baseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (baseUrl) {
    try { hostnames.add(new URL(baseUrl).hostname); }
    catch { app.log.warn(`PUBLIC_BASE_URL is not a valid URL, its hostname is not allowed on /mcp: ${baseUrl}`); }
  }
  if (extraHosts) for (const hostname of extraHosts.split(",")) {
    const host = hostname.trim();
    if (host && host !== "*") hostnames.add(host);
  }

  app.all("/mcp", async (request, reply) => {
    /* Host / Origin 校验（纯函数、零 SQL，最便宜先跑）。Origin 白名单刻意为空：/mcp 的
       调用方是服务端 agent（不带 Origin，直接放行），平台自己的前端走 REST 面——带
       Origin 的请求只有 DNS rebinding 一种来源，全部拒绝。 */
    if (!allowAllHosts) {
      const host = validateHostHeader(headerValue(request.headers.host), [...hostnames]);
      if (!host.ok) return failMcpGuard(reply, host.message);
    }
    const origin = validateOriginHeader(headerValue(request.headers.origin), []);
    if (!origin.ok) return failMcpGuard(reply, origin.message);

    /* ── 第 1 道：Token 有效（401）。候选按前缀收窄 + scrypt 比对 + 吊销即时生效。 ── */
    const identity = await authenticateMcp(request.headers.authorization);
    if (!identity) return failMcpUnauthorized(reply);

    /* ── 第 2 道：mcp_enabled（404）。关掉时端点对该项目**不存在**，回 Fastify 默认
       404 体——与未知路由逐字节同形，不泄露「这个项目有 MCP 但关了」（验收门槛 2）。 ── */
    if (!await mcpEnabled(identity.projectId)) return reply.callNotFound();

    /* ── 第 3/4 道：只作用于 tools/call。scope 可见集 → -32601（与「工具不存在」刻意
       不可区分，验收门槛 1：只读 Token 调写工具等于调一个不存在的方法）；写/执行工具
       再按签发人重跑 canAccess → 403。便宜的判据在前、最贵的（一次 SQL）在后。 ── */
    let writeChecked = false;
    for (const target of toolsCallTargets(request.body)) {
      const tool = target.name ? findMcpTool(target.name) : undefined;
      if (tool && !identity.scope.includes(tool.scope)) {
        /* 拒绝落审计（边界 13：只审计写入、执行与拒绝）。detail 带 gate 与 tokenId，
           userId 是签发人——「谁被拒了」要能落到人。 */
        writeAuditLogAsync({
          action: AUDIT_ACTIONS.mcpCallRejected,
          targetType: "mcp_tool",
          targetId: tool.name,
          projectId: identity.projectId,
          userId: identity.createdBy ?? null,
          detail: { gate: "scope", tokenId: identity.tokenId },
          ip: request.ip,
        });
        return jsonRpcError(reply, 200, target.id, -32601, "Method not found");
      }
      /* 工具名不在注册表里不审计也不预拒：那与调一个瞎编的 JSON-RPC 方法同形，是协议
         噪音；SDK 对未注册工具自然回 -32601（工厂按 scope 裁剪注册是第二道防线）。 */
      if (tool && tool.scope !== "read" && !writeChecked) {
        writeChecked = true;
        if (!await tokenMayWrite(identity)) {
          writeAuditLogAsync({
            action: AUDIT_ACTIONS.mcpCallRejected,
            targetType: "mcp_tool",
            targetId: tool.name,
            projectId: identity.projectId,
            userId: identity.createdBy ?? null,
            detail: { gate: "rbac", tokenId: identity.tokenId },
            ip: request.ip,
          });
          return failMcpForbidden(reply, target.id);
        }
      }
    }

    /* 委托给 SDK 的 node 适配层：身份挂在 raw request 上（SDK 读作 ctx.authInfo 传给
       工厂），Fastify 已解析的 body 必须作为第三个参数传（否则适配层去重读一个已被
       消费的流）。hijack 之后 Fastify 不再管这条响应。 */
    reply.hijack();
    const bearer = mcpBearerToken(request.headers.authorization) ?? "";
    return node(Object.assign(request.raw, { auth: mcpAuthInfo(identity, bearer) }), reply.raw, request.body);
  });
}
