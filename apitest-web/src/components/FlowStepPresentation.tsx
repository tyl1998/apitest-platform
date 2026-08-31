import { Braces, Database, GitBranch, Globe2, Repeat, Timer, Workflow } from "lucide-react";
import type { FlowNode } from "../api";

/**
 * 步骤卡与列表行共享的展示件（5.0.13 列表模式）。
 *
 * 「这一步是干什么的」这句副标题、类型徽标与类型图标原先只活在画布卡片上；列表模式是
 * 同一份流程文档的第二个投影，同一个节点在两个视图里必须显示同一句描述——抽到这里
 * 共享，而不是在两个组件里各写一份、然后各自漂移。
 */

/** Two-letter badge per non-HTTP kind; a request node shows its method instead. */
export const KIND_BADGE: Record<Exclude<FlowNode["type"], "request">, string> = {
  database: "DB", script: "JS", condition: "IF", wait: "⏱", subflow: "SUB", loop: "LOOP",
};

/**
 * One line describing what this step does, per kind.
 *
 * Written as a function rather than a nested ternary chain: with seven kinds the
 * chain stopped being readable, and TypeScript could no longer narrow it because
 * `FlowNodeBase` carries an open index signature.
 */
export function stepSubtitle(node: FlowNode, t: (key: string, options?: Record<string, unknown>) => string, dataSourceName?: string, bodyName?: string): string {
  if (node.type === "request") return node.request.url || "—";
  if (node.type === "database") return `${dataSourceName ?? node.dataSourceId ?? "—"} · ${node.sqlDefinitionId ? t("flows.namedSql") : node.operation ? t("flows.operation") : node.statementType ?? "—"}`;
  if (node.type === "script") return t("flows.scriptNodeSub");
  if (node.type === "condition") return `${node.condition.mode === "any" ? "OR" : "AND"} · ${t("flows.conditionCount", { count: node.condition.rules.length })}`;
  if (node.type === "wait") return t("flows.waitNodeSub", { seconds: (node.waitMs / 1000).toFixed(node.waitMs % 1000 === 0 ? 0 : 1) });
  if (node.type === "subflow") return bodyName ?? node.flowName ?? t("flows.subflowUnset");
  /* 循环：副标题说「几次 × 并发布局」，体内步骤数帮助判断容器里有没有东西。 */
  const times = node.mode === "count" ? t("flows.loopCountSub", { count: node.count ?? 0 }) : `{{${node.listVariable ?? "?"}}}`;
  return `${t("flows.loopSub", { body: node.body.nodes.length })} · ${times}${(node.concurrency ?? 1) > 1 ? ` · ×${node.concurrency}` : ""}`;
}

/** Small per-kind icon for non-HTTP steps, on canvas cards and list rows alike. */
export function NodeKindIcon({ type, size }: { type: FlowNode["type"]; size: number }) {
  if (type === "database") return <Database size={size} />;
  if (type === "script") return <Braces size={size} />;
  if (type === "condition") return <GitBranch size={size} />;
  if (type === "wait") return <Timer size={size} />;
  if (type === "subflow") return <Workflow size={size} />;
  if (type === "loop") return <Repeat size={size} />;
  return <Globe2 size={size} />;
}
