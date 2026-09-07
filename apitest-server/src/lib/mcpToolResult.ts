import { acceptedContent, inputRequired } from "@modelcontextprotocol/server";
import { AUDIT_ACTIONS, writeAuditLogAsync } from "./audit.js";
import type { McpIdentity } from "./mcpAuth.js";
import type { McpToolResult } from "./mcpServer.js";
import { isUuid } from "./uuid.js";

/**
 * MCP 工具回值与入参解析的共用件（P5-4）。
 *
 * **不走 REST 信封**（9.4 刻意的例外）：MCP 有自己的结果与错误形状，`success()`/`fail()`
 * 在 `/mcp` 路径不适用；业务错误码（1001 / 2001 / …）仍然出现在错误消息文本里，便于
 * 排查时与 REST 面对照。
 */

/**
 * 普通结果：`structuredContent` 是机器可读通道（协议 2026-07-28），`content` 里同一段
 * JSON 是给只读文本块的旧客户端的兼容腿——MCP 规范的推荐做法（"a tool that returns
 * structuredContent SHOULD also return the serialized JSON in a TextContent block"）。
 */
export function toolResult(payload: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** 工具错误（in-band，`isError: true`）：消息文本带业务错误码。 */
export function toolError(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** 分页入参：与 REST 面同一套钳制（page ≥ 1，pageSize 1–100，缺省 20）。 */
export function pageArgs(args: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Math.trunc(Number(args.page ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(args.pageSize ?? 20)) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** 非空字符串入参（trim 后为空读作没给）。 */
export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 必填 uuid 入参：形状不对给干净的工具错误而不是让坏值进 SQL（一个坏 uuid 会让整条
 * 查询在 cast 上炸掉，契约第 5 条）。
 */
export function requiredUuidArg(args: Record<string, unknown>, key: string, label: string): { value: string } | { error: string } {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) return { error: `${key} is required (1001)` };
  if (!isUuid(value.trim())) return { error: `${key} must be a UUID — ${label} not found (2001)` };
  return { value: value.trim() };
}

/* ────────────────────────────────────────────────────────────────────────────
 * P5-5 写/执行工具的共用件：审计 + MRTR 删除确认。
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 写/执行工具的审计（边界 13：只审计写入、执行与拒绝）。detail 只带目标与动作证据，
 * 不带 payload——payload 是业务数据，审计回答的是「谁改了什么」。
 */
export function auditMcpAction(
  action: "mcp_tool.write" | "mcp_tool.execute",
  tool: string,
  identity: McpIdentity,
  targetId: string,
  detail: Record<string, unknown>,
): void {
  writeAuditLogAsync({
    action: action === "mcp_tool.write" ? AUDIT_ACTIONS.mcpToolWrite : AUDIT_ACTIONS.mcpToolExecute,
    targetType: "mcp_tool",
    targetId: tool,
    projectId: identity.projectId,
    userId: identity.createdBy ?? null,
    detail: { tokenId: identity.tokenId, targetId, ...detail },
  });
}

/** 工具 handler 的第三参：MRTR 重试回合里客户端带回来的 `inputResponses`（SDK 从
 *  per-request envelope 里挑出、已去掉 `{method,result}` 包装的裸结果）。 */
export type MrtrContext = { inputResponses?: Record<string, unknown> } | undefined;

/** 一次 delete_* 的 MRTR 闸门读数。 */
export type MrtrGate =
  /** 首次调用：还没有任何回应，该发确认回合。 */
  | { phase: "first" }
  /** 人拒绝/取消了确认（或回应形状不对）：降级为错误，不是再问一遍。 */
  | { phase: "refused" }
  /** 人确认了：执行删除。 */
  | { phase: "confirmed" };

/**
 * delete_* 的确认闸门（9.4.1）：`force` 不是工具入参——agent 无法单方面替人答。
 *
 * 三态判定：
 * - 没有任何 `inputResponses` → 首次调用，调用方接着返回 `mrtrRequired(...)`；
 * - 有回应且 `confirm === true`（accept 的 elicitation）→ 确认，执行；
 * - 有回应但不是确认（decline / cancel / 形状不对）→ 拒绝。降级而不是开洞：人说不删
 *   就不删，重问一遍等于把「取消」当成「没听见」。
 */
export function mrtrGate(mcpReq: MrtrContext, key = "confirm"): MrtrGate {
  const responses = mcpReq?.inputResponses;
  if (!responses || Object.keys(responses).length === 0) return { phase: "first" };
  const content = acceptedContent<{ confirm?: unknown }>(responses, key);
  if (content && content.confirm === true) return { phase: "confirmed" };
  return { phase: "refused" };
}

/** 「删除未确认」的错误文案：指向 UI 而不是 force（后者根本不是入参）。 */
export const MRTR_REFUSED_MESSAGE =
  "deletion was not confirmed by the human (declined or cancelled); if it is really intended, delete via the platform UI where the consequences are shown (1003)";

/**
 * MRTR 确认回合（9.4.1 第一段）：`resultType: "input_required"` + 一个表单式 elicitation，
 * 客户端（agent 平台）把 message 转述给人——这就是聊天里的「确认删除吗」。SDK 的
 * `legacy: 'stateless'` 兼容腿会在 2025 系连接上用 elicitation 桥接同一份代码。
 */
export function mrtrRequired(message: string): McpToolResult {
  return inputRequired({
    inputRequests: {
      confirm: inputRequired.elicit({
        message,
        requestedSchema: {
          type: "object",
          properties: { confirm: { type: "boolean", description: "set to true to delete; anything else cancels" } },
          required: ["confirm"],
        },
      }),
    },
  });
}
