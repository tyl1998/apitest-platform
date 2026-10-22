import { AUDIT_ACTIONS, writeAuditLogAsync, type AuditAction } from "./audit.js";
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
 * P5-5 写/执行工具的共用件：审计。
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

/**
 * P11-9：MCP 写路径的**资源级**审计，与 `auditMcpAction` 并行落两行——
 * `mcp_tool.write` 回答「经哪把钥匙、哪个工具」，资源动作回答「哪个资产的变更历史」。
 * 资源动作与 REST 面同名（`endpoint.create` …），`userId` 同为 Token 签发人，
 * detail 只有字段名（`auditFields()` 的产物），绝不带 payload。
 */
export function auditMcpResource(
  action: AuditAction,
  targetType: string,
  identity: McpIdentity,
  targetId: string | null,
  detail: Record<string, unknown>,
): void {
  writeAuditLogAsync({
    action,
    targetType,
    targetId,
    projectId: identity.projectId,
    userId: identity.createdBy ?? null,
    detail,
  });
}
