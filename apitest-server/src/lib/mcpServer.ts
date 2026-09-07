import {
  fromJsonSchema,
  McpServer,
  type AuthInfo,
  type CallToolResult,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import type { McpScope } from "../models/types.js";
import type { McpIdentity } from "./mcpAuth.js";
import type { MrtrContext } from "./mcpToolResult.js";
import { READ_CORE_TOOLS } from "./mcpToolsReadCore.js";
import { READ_TASKS_TOOLS } from "./mcpToolsReadTasks.js";
import { WRITE_CORE_TOOLS } from "./mcpToolsWriteCore.js";
import { WRITE_CRUD_TOOLS } from "./mcpToolsWriteCrud.js";
import { EXECUTE_TOOLS } from "./mcpToolsExecute.js";

/**
 * MCP 工具注册表与 server 工厂（P5-3，计划 9.4 / 9.2）。
 *
 * **`tools/list` 按 scope 裁剪发生在注册时，不是「列出来再拒」**（边界 1）：工厂只把
 * Token scope 覆盖到的工具注册进实例，只读 Token 的 `tools/list` 里根本没有
 * `create_endpoint`——模型看不见的工具不会去调，也就不会把一轮对话浪费在一次注定
 * 403 的尝试上。注册裁剪同时是第 3 道闸门（`-32601`）的第二道防线：即使某条路绕过
 * 了路由层的预检（批量体里靠后的元素），未注册的工具名也会被 SDK 按 method not
 * found 拒掉。
 *
 * **工具入参是裸 JSON Schema**（边界 7）：SDK 的 `fromJsonSchema` 自带 vendored ajv
 * 校验器，声明写 JSON Schema、校验零新依赖，业务级校验仍走 P5-2 提取的
 * `lib/validate.ts`。`description` 必须写清「不能做什么」（9.4 的硬要求）——模型读
 * description 决定调不调，写清边界比写清能力更能减少无效调用。
 */

/** 工具回值：普通结果，或 delete_* 的 MRTR `input_required` 确认回合（9.4.1，P5-5b）。 */
export type McpToolResult = CallToolResult | InputRequiredResult;

/**
 * 一条工具定义。`scope` 是它落入哪一档 Token 可见集（read / write / execute，边界 1
 * 的三值）；`handler` 收到的第二个参数是**本次调用者的身份**——写与执行工具靠它重跑
 * `canAccess`（边界 2），读工具靠它限定 SQL 的 project 范围。第三个参数只对 delete_*
 * 有意义：MRTR 重试回合里客户端带回的 `inputResponses`（9.4.1 的确认判据）。
 */
export type McpToolDefinition = {
  name: string;
  description: string;
  scope: McpScope;
  /** 裸 JSON Schema（对象形态；无参工具写 `{"type":"object","properties":{}}`）。 */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, identity: McpIdentity, mcpReq?: MrtrContext) => Promise<McpToolResult>;
};

/**
 * 工具登记处。P5-4 落了全部 21 个只读工具；P5-5 落全部写与执行工具（核心写 5 + 全量
 * CRUD 12 + 执行 5）。2026-09-06 上限 43 → **44**（用户决策）：`upsert_environment`
 * 进来——普通变量可经工具管理，secret 仍无通路（UI-only，契约第 7 条）。
 */
export const MCP_TOOLS: readonly McpToolDefinition[] = [
  ...READ_CORE_TOOLS, ...READ_TASKS_TOOLS,
  ...WRITE_CORE_TOOLS, ...WRITE_CRUD_TOOLS, ...EXECUTE_TOOLS,
];

/** 按名字找工具（路由层第 3 道闸门用它判可见集）。 */
export function findMcpTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

/** 一组 scope 能看见的工具（工厂注册时用）。 */
export function toolsVisibleTo(scope: McpScope[]): McpToolDefinition[] {
  return MCP_TOOLS.filter((tool) => scope.includes(tool.scope));
}

/**
 * `McpIdentity` → SDK 的 `AuthInfo`。计划 9.2 的挂载方式规定鉴权在 Fastify 侧做完、
 * 身份挂在 raw request 上传给工具（SDK 读作 `ctx.authInfo`）——本函数就是那个
 * 「挂」：`scopes` 直接放 Token 的三值 scope（语义正好），项目与签发人放 `extra`
 * （SDK 不解释它，工厂侧再取回）。
 */
export function mcpAuthInfo(identity: McpIdentity, bearer: string): AuthInfo {
  return {
    token: bearer,
    clientId: identity.tokenId,
    scopes: identity.scope,
    extra: { projectId: identity.projectId, createdBy: identity.createdBy ?? null },
  };
}

/** `AuthInfo` → `McpIdentity`（工厂侧的取回）。形状对不上返回 undefined——见 buildMcpServer。 */
export function mcpIdentityFromAuthInfo(authInfo: AuthInfo | undefined): McpIdentity | undefined {
  const extra = authInfo?.extra as Record<string, unknown> | undefined;
  const projectId = typeof extra?.projectId === "string" ? extra.projectId : undefined;
  if (!authInfo || !projectId) return undefined;
  return {
    tokenId: authInfo.clientId,
    projectId,
    scope: authInfo.scopes.filter((scope): scope is McpScope => scope === "read" || scope === "write" || scope === "execute"),
    createdBy: typeof extra?.createdBy === "string" ? extra.createdBy : undefined,
  };
}

/** initialize 握手里自报的家门。版本与 package.json 同步改——只有展示用途。 */
const SERVER_INFO = { name: "apitest", version: "0.1.0" };

/**
 * 每请求一个 server 实例的工厂（无状态模型的要求，9.2「工厂每请求执行一次」）。
 * 身份缺席时注册零个工具而不是全部工具：这条路径正常到不了（路由层闸门 1 先拒了
 * 无凭据请求），能到就说明 transport 侧出了岔子——失败要朝安全那边倒。
 */
export function buildMcpServer(identity: McpIdentity | undefined): McpServer {
  const server = new McpServer(SERVER_INFO);
  if (!identity) return server;
  for (const tool of toolsVisibleTo(identity.scope)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema) },
      /* 第二个参数是 SDK 的 ServerContext：MRTR 的 inputResponses 从 `ctx.mcpReq` 挑出
         传给工具（delete_* 的确认判据，9.4.1）。其余 context 面本期工具用不到。 */
      (args, ctx) => tool.handler((args ?? {}) as Record<string, unknown>, identity, ctx?.mcpReq),
    );
  }
  return server;
}

