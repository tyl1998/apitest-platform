import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type EnvironmentUsage } from "../api";

/**
 * MRTR 确认表单卡（2026-09-15，P9-5 增补）：agent 的 delete_* 类写工具被 /mcp 的
 * MRTR 闸门拦下（首轮回 input_required 表单），上游把确认请求转述进聊天流——
 * 引擎翻译成 elicit 事件后由这里渲染成**表单**：确认请求原文 + 后果摘要 +
 * 「确认 / 放弃」。这就是聊天里删除操作的「二次确认表单」。
 *
 * - **确认动作不走上游**：上游的第三方 resume 通道（agent-vendor
 *   /api/v1/chat/resume-elicitation）实测对 API-Key 会话稳定 5000（2026-09-15
 *   复现留档），而本平台的写路径教义本来就是「AI 起草、人确认、**本人 JWT** 落
 *   库」（P9-5 边界 3，proposal 卡同款）——确认后走既有 REST，审计 created_by
 *   是点击的人，比 MCP Token 签发人更准。
 * - 工具 → REST 的映射是**枚举，与既有 REST 一一对应**（v1 只 delete_environment；
 *   未知工具渲染只读卡引导页面操作，不当卡片误导）。
 * - 删除语义与环境页同款两步：先 GET usage（表单卡自带后果摘要，不依赖 MRTR
 *   原文），有独占依赖时列出清单，二次「仍要删除」才 force。
 * - 终态（confirmed/declined）由 AssistantDock 按回合+工具索引持有，重渲染不丢。
 */
export type ElicitSettled = "confirmed" | "declined";

export function AssistantElicitationCard({ projectId, block, settled, canWrite, onSettled }: {
  /** 删除目标是项目资产；对话用户级化（2026-09-16）后抽屉可能在全局页——不在
      项目里时表单降级为只读（不给确认按钮）。 */
  projectId: string | undefined;
  block: { text: string; tool: string; input?: Record<string, unknown>; schema?: unknown };
  settled?: ElicitSettled;
  /** viewer 只读：表单照样渲染（历史里看得到），不给确认按钮。 */
  canWrite: boolean;
  onSettled: (state: ElicitSettled) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** 2003 撞上独占依赖时的清单 + 「仍要删除」二段确认（环境页同款语义）。 */
  const [usage, setUsage] = useState<EnvironmentUsage>();

  const environmentId = typeof block.input?.environmentId === "string" ? block.input.environmentId : undefined;
  const inProject = Boolean(projectId);
  const supported = inProject && block.tool === "delete_environment" && Boolean(environmentId);

  /** 确认删除：非 force 先读 usage（卡内自带后果），有独占依赖则列清单等二段；
      force（「仍要删除」）直接带 force 删除。 */
  async function confirm(force = false) {
    if (!projectId || !environmentId) return;
    setBusy(true);
    setError(undefined);
    try {
      if (!force) {
        const current = await api.environmentUsage(projectId, environmentId);
        if (current.blocked) {
          setUsage(current);
          return;
        }
      }
      await api.deleteEnvironment(projectId, environmentId, force);
      onSettled("confirmed");
    } catch (cause) {
      const response = (cause as { response?: { data?: { message?: unknown } } })?.response;
      const message = response?.data?.message;
      setError(typeof message === "string" && message ? message : t("assistantElicit.applyFailed"));
    } finally {
      setBusy(false);
    }
  }

  /* 终态：一行回执收扁（对话里的历史痕迹，不再是待办）。 */
  if (settled) {
    return <div className="chat-proposal chat-proposal-settled">
      <span className="chat-proposal-kind">{t("assistantElicit.kindDelete")}</span>
      <span className="chat-proposal-summary">{t(settled === "confirmed" ? "assistantElicit.confirmed" : "assistantElicit.declined")}</span>
    </div>;
  }

  return <div className="chat-proposal chat-elicit">
    <div className="chat-proposal-head">
      <span className="chat-proposal-kind">{t("assistantElicit.kindDelete")}</span>
      <span className="chat-proposal-case mono">{block.tool}</span>
    </div>
    {/* 确认请求原文（MRTR 闸门生成的后果摘要——接口引用数 / 执行历史）。 */}
    {block.text && <p className="chat-proposal-summary">{block.text}</p>}
    {usage?.blocked && <div className="chat-elicit-blocked">
      <p className="chat-proposal-summary">{t("assistantElicit.blockedHint", { count: usage.endpoints.length })}</p>
      <ul className="chat-elicit-endpoints mono">
        {usage.endpoints.map((endpoint) => (
          <li key={endpoint.id}>{endpoint.method} {endpoint.name}（{endpoint.variables.map((name) => `{{${name}}}`).join(", ")}）</li>
        ))}
      </ul>
    </div>}
    {!supported
      ? <p className="chat-proposal-summary">{inProject ? t("assistantElicit.unsupported", { tool: block.tool }) : t("assistantElicit.outsideProject")}</p>
      : !canWrite
        ? <p className="chat-proposal-summary">{t("assistantElicit.readonly")}</p>
        : <div className="chat-proposal-actions">
          {usage?.blocked
            ? <button type="button" className="btn danger btn-small" disabled={busy} onClick={() => void confirm(true)}>
              {busy ? "…" : t("assistantElicit.deleteAnyway")}
            </button>
            : <button type="button" className="btn danger btn-small" disabled={busy} onClick={() => void confirm(false)}>
              {busy ? "…" : t("assistantElicit.confirm")}
            </button>}
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => onSettled("declined")}>
            {t("assistantElicit.decline")}
          </button>
        </div>}
    {error && <p className="form-error">{error}</p>}
  </div>;
}
