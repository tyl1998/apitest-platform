import {
  fromJsonSchema,
  McpServer,
  type AuthInfo,
  type CallToolResult,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { McpBinding, McpScope } from "../models/types.js";
import {
  bindingScopeUnion, resolveBinding, type McpIdentity, type McpPrincipal,
} from "./mcpAuth.js";
import { toolError } from "./mcpToolResult.js";
import { READ_CORE_TOOLS } from "./mcpToolsReadCore.js";
import { READ_TASKS_TOOLS } from "./mcpToolsReadTasks.js";
import { READ_SPEC_TOOLS, WRITE_SPEC_TOOLS } from "./mcpToolsSpec.js";
import { ATTRIBUTION_TOOLS } from "./mcpToolsAttribution.js";
import { WRITE_CORE_TOOLS } from "./mcpToolsWriteCore.js";
import { WRITE_CRUD_TOOLS } from "./mcpToolsWriteCrud.js";
import { WRITE_EXTRA_TOOLS } from "./mcpToolsWriteExtra.js";
import { EXECUTE_TOOLS } from "./mcpToolsExecute.js";
import { ME_TOOLS } from "./mcpToolsMe.js";

/**
 * MCP 工具注册表与 server 工厂（P5-3，计划 9.4 / 9.2；P12-1 改为用户级身份与
 * 目标项目参数）。
 *
 * **`tools/list` 按绑定 scope 并集裁剪发生在注册时，不是「列出来再拒」**（边界 1）：
 * 工厂只把绑定集覆盖到的工具注册进实例，只读 Token 的 `tools/list` 里根本没有
 * `create_endpoint`——模型看不见的工具不会去调，也就不会把一轮对话浪费在一次注定
 * 403 的尝试上。注册裁剪同时是第 4 道闸门（`-32601`）的第二道防线。
 *
 * **目标项目是每次调用的参数**（P12 边界 5，2026-09-16 实施修订）：57 个工具的
 * schema 与 handler 不逐个改，而是由注册包装统一做两件事——① 把必填 `projectId`
 * 注入 schema（模型看到的就是它）；② 从 `args.projectId` 解出主体绑定集里的目标
 * 绑定，把该绑定的 `projectId` 与 `scope` 注入 `identity` 后再调 handler。于是
 * handler 体内的 `identity.projectId` 逐字不变，语义从「token 的项目」变成
 * 「本次调用的目标项目」；绑定校验只有一处，不可能被某个工具漏掉。
 *
 * 两个例外（无项目数据的工具）：`get_script_contract`（静态契约）与
 * `list_my_projects`（自查绑定集）不注入也不解析。`list_my_projects` **零绑定时也
 * 注册**——否则 agent 连「我没有可触达的项目」都问不出来。
 *
 * **工具入参是裸 JSON Schema**（边界 7）：SDK 的 `fromJsonSchema` 自带 vendored ajv
 * 校验器，声明写 JSON Schema、校验零新依赖，业务级校验仍走 P5-2 提取的
 * `lib/validate.ts`。`description` 必须写清「不能做什么」（9.4 的硬要求）——模型读
 * description 决定调不调，写清边界比写清能力更能减少无效调用。
 */

/** 工具回值：普通结果，或工具错误（`isError: true`）。 */
export type McpToolResult = CallToolResult;

/**
 * 一条工具定义。`scope` 是它落入哪一档（read / write / execute，边界 1 的三值）；
 * `handler` 收到的第二个参数是**本次调用的上下文**——写与执行工具靠它重跑
 * `canAccess`（边界 2/3），读工具靠它限定 SQL 的项目范围。
 */
export type McpToolDefinition = {
  name: string;
  description: string;
  scope: McpScope;
  /** 裸 JSON Schema（对象形态；无参工具写 `{"type":"object","properties":{}}`）。 */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, identity: McpIdentity) => Promise<McpToolResult>;
};

/**
 * 工具登记处。P5-4 落了全部 21 个只读工具；P5-5 落全部写与执行工具（核心写 5 + 全量
 * CRUD 12 + 执行 5）。2026-09-06 上限 43 → **44**（用户决策）：`upsert_environment`
 * 进来——普通变量可经工具管理，secret 仍无通路（UI-only，契约第 7 条）。
 * 2026-09-09 上限 44 → **55**（用户决策）：文本用例 CRUD + 模块读写 7、公共脚本
 * CRUD 3、环境删除 1 进来——文本用例与公共脚本补齐增删改查，环境补删除；
 * secret / 绑定 / 导入导出仍无通路。
 * 2026-09-10 上限 55 → **57**（P8-7，计划 12.2）：归因两工具
 * `list_unattributed_failures`（read）/ `set_failure_attribution`（write）进来——
 * agent 归因闭环（边界 8：平台不写一行 LLM 代码，外部 agent 读证据自行判断写回）。
 * P12-1 上限 57 → **59**（计划 18.0 边界 5）：`list_my_projects`（read，绑定集自查）
 * 与 `copy_endpoint`（write，跨项目复制）进来——`projectId` 参数由注册包装统一注入，
 * 不在此逐条声明。
 */
export const MCP_TOOLS: readonly McpToolDefinition[] = [
  ...READ_CORE_TOOLS, ...READ_TASKS_TOOLS, ...READ_SPEC_TOOLS,
  ...ATTRIBUTION_TOOLS,
  ...WRITE_CORE_TOOLS, ...WRITE_CRUD_TOOLS, ...WRITE_SPEC_TOOLS, ...WRITE_EXTRA_TOOLS, ...EXECUTE_TOOLS,
  ...ME_TOOLS,
];

/**
 * 不携带项目参数的工具（边界 5 修订）：静态契约与绑定集自查。它们不受闸门②③（目标
 * 项目 / 开关），`tools/call` 里也不该要求 `projectId`——那会让「我没有绑定任何项目」
 * 变成一句问不出来的话。
 */
const PROJECT_FREE_TOOLS = new Set(["get_script_contract", "list_my_projects"]);

/** 按名字找工具（路由层第 4 道闸门用它判可见集）。 */
export function findMcpTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

/** 一组 scope 能看见的工具（工厂注册时用）。 */
export function toolsVisibleTo(scope: McpScope[]): McpToolDefinition[] {
  return MCP_TOOLS.filter((tool) => scope.includes(tool.scope));
}

/** 一条工具是否需要在注册包装里解析目标项目。 */
export function toolNeedsProject(tool: McpToolDefinition): boolean {
  return !PROJECT_FREE_TOOLS.has(tool.name);
}

/**
 * 工具的 `annotations`（MCP 规范 ToolAnnotations）——上游客户端「调用前要不要弹窗
 * 向人确认」就按它判定：缺 annotations / `readOnlyHint !== true` / `destructiveHint
 * === true` 一律视为危险。声明依据是工具的 `scope`（边界 1 的三档能力），不逐条手写
 * 免得漏标：`read` 档只跑 SELECT，声明 `readOnlyHint`；`write` 档里只有 `delete_*`
 * 会销毁数据，声明 `destructiveHint`；`execute` 档会真的打到被测系统，声明
 * `openWorldHint`。
 */
function toolAnnotations(tool: McpToolDefinition): ToolAnnotations {
  if (tool.scope === "read") return { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  if (tool.scope === "execute") return { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  return { readOnlyHint: false, destructiveHint: tool.name.startsWith("delete_"), openWorldHint: false };
}

/**
 * 注册时把必填 `projectId` 注入工具 schema（边界 5 修订的①）。工具自己声明过
 * `projectId` 的话不覆盖（目前没有，`copy_endpoint` 额外声明的是 `fromProjectId`）。
 * 位置放最前：`required` 与 `properties` 都是数组/对象的合并，顺序影响模型可读性。
 */
function injectProjectArg(tool: McpToolDefinition): Record<string, unknown> {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const properties = {
    projectId: {
      type: "string",
      description: "target project id; must be one of the projects this token is bound to (see list_my_projects)",
    },
    ...(schema.properties ?? {}),
  };
  const required = ["projectId", ...(schema.required ?? []).filter((key) => key !== "projectId")];
  return { ...schema, properties, required };
}

/**
 * 一次调用的目标项目解析（边界 5 修订的②）。返回值二选一：解析出的调用上下文，或
 * 一条可直接回给模型的可读错误。
 *
 * **未绑定与「项目 id 形状不对」都回同一种错误**——路由层第 2 道闸门已经把它们都拒成
 * `-32601` 了，这里只是第二道防线（SDK 内部路径 / 批量体里靠后的元素）；错误文本不
 * 提「那个项目存在 MCP 通道」，与闸门 1 的纪律一致。
 */
function resolveCall(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  principal: McpPrincipal,
): { identity: McpIdentity } | { error: string } {
  const base: McpIdentity = {
    tokenId: principal.tokenId,
    createdBy: principal.createdBy,
    bindings: principal.bindings,
    projectId: "",
    scope: bindingScopeUnion(principal.bindings),
  };
  if (!toolNeedsProject(tool)) return { identity: base };

  const projectId = typeof args.projectId === "string" ? args.projectId.trim() : "";
  if (!projectId) return { error: "projectId is required (1001): call list_my_projects to see the projects this token is bound to" };
  const binding = resolveBinding(principal.bindings, projectId);
  if (!binding) {
    return { error: "projectId is not bound to this token (2001): call list_my_projects to see the projects this token is bound to" };
  }
  return { identity: { ...base, projectId, scope: binding.scope } };
}

/**
 * `McpPrincipal` → SDK 的 `AuthInfo`。计划 9.2 的挂载方式规定鉴权在 Fastify 侧做完、
 * 身份挂在 raw request 上传给工具（SDK 读作 `ctx.authInfo`）——本函数就是那个
 * 「挂」：`scopes` 放绑定 scope 并集（正好是 `tools/list` 裁剪要用的能力面），
 * 绑定集与签发人放 `extra`（SDK 不解释它，工厂侧再取回）。
 */
export function mcpAuthInfo(principal: McpPrincipal, bearer: string): AuthInfo {
  return {
    token: bearer,
    clientId: principal.tokenId,
    scopes: bindingScopeUnion(principal.bindings),
    extra: { createdBy: principal.createdBy, bindings: principal.bindings },
  };
}

/** `AuthInfo` → `McpPrincipal`（工厂侧的取回）。形状对不上返回 undefined——见 buildMcpServer。 */
export function mcpPrincipalFromAuthInfo(authInfo: AuthInfo | undefined): McpPrincipal | undefined {
  const extra = authInfo?.extra as Record<string, unknown> | undefined;
  const createdBy = typeof extra?.createdBy === "string" ? extra.createdBy : undefined;
  if (!authInfo || !createdBy) return undefined;
  const rawBindings: unknown[] = Array.isArray(extra?.bindings) ? extra?.bindings as unknown[] : [];
  const bindings = rawBindings.flatMap((raw): McpBinding[] => {
    const row = raw as Record<string, unknown>;
    const projectId = typeof row.projectId === "string" ? row.projectId : undefined;
    if (!projectId) return [];
    const scope = Array.isArray(row.scope)
      ? (row.scope as unknown[]).map(String).filter((each): each is McpScope => each === "read" || each === "write" || each === "execute")
      : [];
    return [{ projectId, scope }];
  });
  return { tokenId: authInfo.clientId, createdBy, bindings };
}

/** initialize 握手里自报的家门。版本与 package.json 同步改——只有展示用途。 */
const SERVER_INFO = { name: "apitest", version: "0.1.0" };

/**
 * 每请求一个 server 实例的工厂（无状态模型的要求，9.2「工厂每请求执行一次」）。
 * 身份缺席时注册零个工具而不是全部工具：这条路径正常到不了（路由层闸门 1 先拒了
 * 无凭据请求），能到就说明 transport 侧出了岔子——失败要朝安全那边倒。
 */
export function buildMcpServer(principal: McpPrincipal | undefined): McpServer {
  const server = new McpServer(SERVER_INFO);
  if (!principal) return server;
  const registered = new Map<string, McpToolDefinition>();
  for (const tool of toolsVisibleTo(bindingScopeUnion(principal.bindings))) registered.set(tool.name, tool);
  /* `list_my_projects` 恒注册（零绑定也要能问出「我没有项目」）；它在 PROJECT_FREE_TOOLS
     里，不注入 projectId、不需要目标项目。 */
  for (const tool of MCP_TOOLS) if (tool.name === "list_my_projects") registered.set(tool.name, tool);

  for (const tool of registered.values()) {
    const schema = toolNeedsProject(tool) ? injectProjectArg(tool) : tool.inputSchema;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: fromJsonSchema(schema), annotations: toolAnnotations(tool) },
      /* 第二个参数是 SDK 的 ServerContext：本期工具用不到它的任何面（删除确认已改为
         客户端调用前确认，不再走协议回合）。 */
      async (args, ctx) => {
        const call = resolveCall(tool, (args ?? {}) as Record<string, unknown>, principal);
        if ("error" in call) return toolError(call.error);
        /* 临时调试钩子（2026-09-17）：把每次 MCP 工具调用连同入参打到 api 日志，定位
           update_endpoint 这类写工具实际收到什么形状的入参（如 body 变成字符串）。
           入参可能含业务数据——只进本地 .dev-logs/api.log（gitignore），不入库。 */
        console.log(`[mcp-call] ${tool.name} projectId=${call.identity.projectId || "-"}`, JSON.stringify(args ?? {}));
        return tool.handler((args ?? {}) as Record<string, unknown>, call.identity);
      },
    );
  }
  return server;
}
