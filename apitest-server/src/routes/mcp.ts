import { createMcpHandler, localhostAllowedHostnames, validateHostHeader, validateOriginHeader } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { FastifyInstance, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, writeAuditLogAsync } from "../lib/audit.js";
import { authenticateMcp, mcpBearerToken, resolveBinding, type McpPrincipal } from "../lib/mcpAuth.js";
import { hasMcpScopeGrant } from "../lib/mcpScopes.js";
import { buildMcpServer, findMcpTool, mcpAuthInfo, mcpPrincipalFromAuthInfo, toolNeedsProject } from "../lib/mcpServer.js";
import { canAccess } from "../lib/rbac.js";
import { mapUser, type McpScope, type User } from "../models/types.js";

/**
 * `/mcp` 端点（P5-3，计划 9.2 / 9.3；P12-1 改为用户级 Token + 目标项目参数）。一条
 * 无状态 `POST /mcp`，`apimcp_` Token 鉴权——平台是 MCP Server（工具提供方），不是 Client。
 *
 * **端点路径不带 `/api/v1` 前缀**（边界 11）：那个前缀是给平台自己前端的版本化 REST
 * 面用的，MCP 的版本协商在协议层（`MCP-Protocol-Version` 头），再叠一层路径版本等于
 * 两套版本号指同一件事。与 `/ingest`、`/runner/*` 同款挂法。
 *
 * **错误不走 REST 信封**（9.4 刻意的例外，`success()`/`fail()` 在这条路径不适用）：
 * MCP 有自己的 JSON-RPC 错误形状；业务错误码（1002/1003/…）仍然出现在消息文本里，
 * 便于排查时与 REST 面对照。
 *
 * **P12 闸门重排为五道**（边界 6，目标项目来自 `tools/call` 的参数）：
 * ① token 有效 → 401（owner 被删的行在 `authenticateMcp` 里就被排除）；
 * ② 目标项目未绑定 → -32601（**不看 mcp_enabled**——绑定关系与开关状态都不泄露）；
 * ③ `mcp_enabled(目标项目)` → 404（每调用判）；
 * ④ 该绑定的 scope 不含工具所需 → -32601（与「工具不存在」刻意同形）；
 * ②④ 的 `-32601` 带一条**逐字相同**的 `error.data.hint`（「项目级工具要传已绑定的
 *    projectId，先调 list_my_projects」）：给模型一条自救路径，不透露被拒的项目或
 *    绑定是否存在（2026-09-16 增补，见 failMcpMethodNotFound 注释）；
 * ⑤ 按 owner 重跑 `canAccess(owner, 目标项目, write = 工具 scope ≠ read)` → 403
 *    （**read 也查**，边界 3：owner 被移出项目后 read token 立刻读不动）。2026-09-21
 *    起角色判不过时再看这一档是否被项目管理员批准过绑定许可（迁移 070），但**先要求
 *    仍是成员**——许可补档位不补身份（见 tokenMayAccess）。
 * 无项目数据的工具（`get_script_contract` / `list_my_projects`）只受①约束。
 * ⑤ 的 owner 行与 canAccess 结果都是**惰性加载 + 请求内缓存**：纯粹的 initialize /
 * tools/list 请求不触发任何额外的用户查询与角色查询（闸门②③④都是廉价判据，先跑）。
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

/** in-band 协议错误按 SDK 口径回 HTTP 200（错误在 JSON-RPC 体里，不是 HTTP 失败）。
 *  `data` 是可选的机器可读补充（JSON-RPC 2.0 的 `error.data`）——目前只有闸门②④的
 *  「下一步怎么走」提示用它；协议错误本体（code / message）形状不变。 */
function jsonRpcError(reply: FastifyReply, status: number, id: unknown, code: number, message: string, data?: unknown) {
  reply.code(status).send({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

/** 第 1 道闸门不过（401）。RFC 6750：401 携带 WWW-Authenticate。 */
function failMcpUnauthorized(reply: FastifyReply) {
  reply.code(401).header("WWW-Authenticate", 'Bearer realm="apitest-mcp"')
    .send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "unauthorized: mcp token is invalid, revoked, or its issuer was deleted (1002)" } });
}

/** 第 5 道闸门不过（403）：owner 对目标项目已无所需权限（被降权或移出项目）。 */
function failMcpForbidden(reply: FastifyReply, id: unknown) {
  jsonRpcError(reply, 403, id, -32000, "forbidden: this token's issuer no longer has access to the target project (1003)");
}

/** Host / Origin 校验不过（403）。形状照 SDK 的 hostHeaderValidationResponse，客户端看不出差异。 */
function failMcpGuard(reply: FastifyReply, message: string) {
  jsonRpcError(reply, 403, undefined, -32000, message);
}

/**
 * 一个 tools/call 的目标：请求 id（错误回显用）、工具名（可能缺失，交给 SDK 判参）与
 * **目标项目 id**（来自 `params.arguments.projectId`，P12 边界 5）。
 */
type ToolsCallTarget = { id: unknown; name?: string; projectId?: string };

/**
 * 从 JSON-RPC 体里取出全部 `tools/call` 的目标。**只看 body 不看 `Mcp-Method` /
 * `Mcp-Name` 头**：头是给网关路由用的提示，SDK 自己会做头体一致性校验（不一致
 * `-32020`），body 才是权威来源。批量体（2025 遗留）逐元素检查——批里任何一个元素
 * 调了不可达工具，整个请求都在这里被拒。
 */
function toolsCallTargets(body: unknown): ToolsCallTarget[] {
  const targets: ToolsCallTarget[] = [];
  for (const message of Array.isArray(body) ? body : [body]) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.method !== "tools/call") continue;
    const params = record.params as Record<string, unknown> | undefined;
    const args = params?.arguments as Record<string, unknown> | undefined;
    targets.push({
      id: record.id,
      name: typeof params?.name === "string" ? params.name : undefined,
      projectId: typeof args?.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : undefined,
    });
  }
  return targets;
}

/** 第 3 道闸门的读数。无行 = false（照 `lib/run.ts` 读 `store_plaintext` 的写法）。 */
async function mcpEnabled(projectId: string): Promise<boolean> {
  const result = await pool.query("SELECT mcp_enabled FROM project_settings WHERE project_id = $1", [projectId]);
  return Boolean(result.rows[0]?.mcp_enabled);
}

/**
 * 第 5 道闸门的读数：按 **owner** 对目标项目重跑 `canAccess`（边界 3——Token 只是一把
 * 钥匙，不是一份权限快照；owner 被降权或被移出项目，Token 立刻不好使）。read 工具走
 * `write = false`。
 *
 * **2026-09-21 起再加一条**：角色判不过时，看这一档是否被项目管理员批准过绑定许可
 * （迁移 070 的 `mcp_binding_requests`，按**单档**判——批了 write 不等于能 execute）。
 * 只放宽后者不放宽这里，会让「批准」变成空头支票：绑定绑得上，调用仍被这一道拦下。
 * **许可补的是档位、不是成员身份**：先要求仍是成员（read 判过），被移出项目后读都
 * 过不了，更不该靠一条历史批准把写放行。
 *
 * owner 必定存在（`authenticateMcp` 已排除 `created_by IS NULL` 与已删行）；查不到
 * active 行（例如刚被禁用）一律判否——「谁被拒了」要能落到人，落不到人就不放行。
 */
async function tokenMayAccess(owner: User | undefined, projectId: string, scope: McpScope): Promise<boolean> {
  if (!owner) return false;
  const write = scope !== "read";
  if (await canAccess(owner, projectId, write)) return true;
  /* 许可只在「仍然是成员」的前提下生效（成员身份由 read 判——viewer 即可）。 */
  if (!await canAccess(owner, projectId, false)) return false;
  return hasMcpScopeGrant(owner.id, projectId, scope);
}

/** 第 2/4/5 道闸门的拒绝审计（边界 13：只审计写入、执行与拒绝；P12 边界 8 补目标项目）。 */
function auditRejected(principal: McpPrincipal, tool: string, gate: "binding" | "scope" | "rbac", projectId: string | undefined, ip: string): void {
  writeAuditLogAsync({
    action: AUDIT_ACTIONS.mcpCallRejected,
    targetType: "mcp_tool",
    targetId: tool,
    projectId: projectId ?? null,
    userId: principal.createdBy,
    detail: { gate, tokenId: principal.tokenId, projectId: projectId ?? null },
    ip,
  });
}

/**
 * 第 2 道（缺 projectId / 未绑定）与第 4 道（该绑定的 scope 不含）共用同一个「工具不
 * 存在」形状（验收门槛 1）。**两个原因连附加提示都逐字相同**——只要 hint 的存在与否
 * 有差异，「有没有 hint」本身就成了一条侧信道，与「不泄露那个项目有 MCP 通道」同罪。
 *
 * `error.data.hint` 的来由（2026-09-16 用户反馈）：P12 起 `projectId` 是必填参数，而
 * 模型收到裸的 `"Method not found"` 读不出下一步，只会反复「不带参数再试一次」，永远
 * 走不到自救那一步。这段文本只说「下一步调 `list_my_projects` 取 projectId」，既不讲
 * 被拒的项目是否真实存在，也不讲是缺参数还是 scope 不够。
 */
function failMcpMethodNotFound(reply: FastifyReply, id: unknown) {
  jsonRpcError(reply, 200, id, -32601, "Method not found", {
    hint: "If you meant a project-scoped tool, pass projectId in arguments; it must be a project this token is bound to, with a binding scope covering the tool. Call list_my_projects (no arguments) to see them, then retry.",
  });
}

export async function mcpRoutes(app: FastifyInstance) {
  /* SDK handler 一个进程建一次；每请求一个 McpServer 实例由工厂出（9.2）。`legacy:
     'stateless'`（默认值，显式写出）让 2025 系流量（initialize 握手、Mcp-Session-Id、
     无 per-request _meta）由同一个工厂无状态服务——智能体平台按 STREAMABLE_HTTP
     （2025-06-18）注册就落在这条兼容腿上；老 GET/DELETE 由 SDK 答 405。 */
  const handler = createMcpHandler((ctx) => buildMcpServer(mcpPrincipalFromAuthInfo(ctx.authInfo)), {
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
    /* 临时调试钩子（2026-09-17）：打印每一条 /mcp 请求体（JSON-RPC），看智能体平台
       实际发来什么。可能含业务数据——只进本地 .dev-logs/api.log（gitignore），不入库。 */
    console.log("[mcp-request]", request.method, JSON.stringify(request.body ?? {}));
    /* Host / Origin 校验（纯函数、零 SQL，最便宜先跑）。Origin 白名单刻意为空：/mcp 的
       调用方是服务端 agent（不带 Origin，直接放行），平台自己的前端走 REST 面——带
       Origin 的请求只有 DNS rebinding 一种来源，全部拒绝。 */
    if (!allowAllHosts) {
      const host = validateHostHeader(headerValue(request.headers.host), [...hostnames]);
      if (!host.ok) return failMcpGuard(reply, host.message);
    }
    const origin = validateOriginHeader(headerValue(request.headers.origin), []);
    if (!origin.ok) return failMcpGuard(reply, origin.message);

    /* ── 第 1 道：Token 有效（401）。候选按前缀收窄 + scrypt 比对 + 吊销/owner 删除
       即时生效；返回主体（谁）与绑定集（能开哪几扇门）。 ─ */
    const principal = await authenticateMcp(request.headers.authorization);
    if (!principal) return failMcpUnauthorized(reply);

    /* ── 第 2–5 道：只作用于 tools/call，逐目标按「未绑定 → 开关 → scope → 活体权限」
       判（边界 6）。owner 用户行与 canAccess 结果**惰性加载 + 请求内缓存**——批量体里
       同一项目被调多次不做重复 SQL，tools/list 之类的请求一道用户查询都不发。 ── */
    let ownerLoaded = false;
    let owner: User | undefined;
    const loadOwner = async (): Promise<User | undefined> => {
      if (ownerLoaded) return owner;
      const result = await pool.query(
        "SELECT id, email, name, password_hash, is_system_admin, status FROM users WHERE id = $1 AND status = 'active'",
        [principal.createdBy],
      );
      owner = result.rowCount ? mapUser(result.rows[0]) : undefined;
      ownerLoaded = true;
      return owner;
    };
    const accessCache = new Map<string, boolean>();

    for (const target of toolsCallTargets(request.body)) {
      const tool = target.name ? findMcpTool(target.name) : undefined;
      /* 工具名不在注册表里不审计也不预拒：那与调一个瞎编的 JSON-RPC 方法同形，是协议
         噪音；SDK 对未注册工具自然回 -32601。无项目数据的工具（静态契约 / 绑定自查）
         只受①约束，跳过②–⑤。 */
      if (!tool || !toolNeedsProject(tool)) continue;

      const binding = target.projectId ? resolveBinding(principal.bindings, target.projectId) : undefined;
      if (!binding) {
        auditRejected(principal, tool.name, "binding", target.projectId, request.ip);
        return failMcpMethodNotFound(reply, target.id);
      }
      /* 关掉时端点对该项目**不存在**，回 Fastify 默认 404 体——与未知路由逐字节同形，
         不泄露「这个项目有 MCP 但关了」（验收门槛 2）。 */
      if (!await mcpEnabled(binding.projectId)) return reply.callNotFound();
      if (!binding.scope.includes(tool.scope)) {
        auditRejected(principal, tool.name, "scope", binding.projectId, request.ip);
        return failMcpMethodNotFound(reply, target.id);
      }
      /* 缓存键按**单档**而不是 read/write 两分（2026-09-21：批准许可按档判）——同一个
         批量体里 write 与 execute 可能一个批了、一个没批，两分键会把结论串档。 */
      const cacheKey = `${binding.projectId}:${tool.scope}`;
      let allowed = accessCache.get(cacheKey);
      if (allowed === undefined) {
        allowed = await tokenMayAccess(await loadOwner(), binding.projectId, tool.scope);
        accessCache.set(cacheKey, allowed);
      }
      if (!allowed) {
        auditRejected(principal, tool.name, "rbac", binding.projectId, request.ip);
        return failMcpForbidden(reply, target.id);
      }
    }

    /* 委托给 SDK 的 node 适配层：主体挂在 raw request 上（SDK 读作 ctx.authInfo 传给
       工厂），Fastify 已解析的 body 必须作为第三个参数传（否则适配层去重读一个已被
       消费的流）。hijack 之后 Fastify 不再管这条响应。 */
    reply.hijack();
    const bearer = mcpBearerToken(request.headers.authorization) ?? "";
    return node(Object.assign(request.raw, { auth: mcpAuthInfo(principal, bearer) }), reply.raw, request.body);
  });
}