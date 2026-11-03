import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ResponseScript } from "../api";

/**
 * Proposal 预览卡（P9-5，计划 13.0 边界 3 / 13.6 对接契约）：agent 在回复正文里用
 * ` ```apitest-proposal ` 围栏产出**草稿**，前端扫描围栏渲染成本卡；「确认应用」用
 * **本人 JWT** 调既有 REST 落库——零新增写库路径，canAccess 与审计全程落在真人
 * （门槛 4）。聊天 MCP token 只 read scope（proposal-first），写不经过 agent。
 *
 * - 第一版只一种 kind：`response_script`，枚举与既有 REST 一一对应（13.6），后续按
 *   需扩；未知 kind 的围栏原样按代码块渲染（markdown 兜底），不当卡片误导用户；
 * - 应用语义 = **追加**一枚启用的新响应脚本（非破坏：既有脚本原样保留，用户在
 *   接口工作台还能删）——AI 起草、人确认，确认的是「多出来一枚」而不是「替换掉
 *   什么」，最不容易发生误伤；
 * - 应用前重读用例拿最新 responseScripts 再整份 PATCH（服务端 PATCH 对 lifecycle
 *   是整段替换，不重读会把别处刚保存的脚本冲掉）；
 * - 卡片状态（applied/dismissed）归 AssistantDock 按 proposal 内容键持有——同一段
 *   草稿在流式重渲染间不丢终态，历史回放换桶后自然复位（草稿重新出现重新确认）。
 */

/** 围栏里的草稿载荷（13.6 契约的解析侧）。 */
export type AssistantProposal = {
  kind: "response_script";
  caseId: string;
  script: string;
  name?: string;
};

export type ProposalSettled = "applied" | "dismissed";

/** 解析围栏内容：形状不对（缺 kind/caseId/script、JSON 坏、kind 未知）返回
 *  undefined，调用方把围栏留给 markdown 按代码块渲染。 */
export function parseProposal(raw: string): AssistantProposal | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Record<string, unknown>;
    if (candidate.kind !== "response_script") return undefined;
    if (typeof candidate.caseId !== "string" || !candidate.caseId) return undefined;
    if (typeof candidate.script !== "string" || !candidate.script) return undefined;
    return {
      kind: "response_script",
      caseId: candidate.caseId,
      script: candidate.script,
      name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : undefined,
    };
  } catch {
    return undefined;
  }
}

/** 草稿的内容键（caseId + script 的短哈希）：终态记录按它索引，同一草稿重渲染
 *  不换键。带长度位降低碰撞面。 */
export function proposalKey(proposal: AssistantProposal): string {
  const source = `${proposal.caseId}\u0000${proposal.script}`;
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  return `${source.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/** 文本块按完整 proposal 围栏切段：围栏外仍是 markdown，围栏内成卡。未闭合围栏
 *  （流式进行到一半）留在文本里按代码块渲染，token 到齐自然收敛成卡。 */
export type ProposalSegment =
  | { type: "text"; text: string }
  | { type: "proposal"; key: string; proposal: AssistantProposal };

const PROPOSAL_FENCE = /```apitest-proposal[^\n]*\n([\s\S]*?)```/g;

export function splitProposalSegments(text: string): ProposalSegment[] {
  const segments: ProposalSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PROPOSAL_FENCE)) {
    const proposal = parseProposal(match[1]);
    /* 解析失败（坏 JSON / 未知 kind）：围栏留在文本里按代码块渲染，不吞内容。 */
    if (!proposal) continue;
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ type: "text", text: text.slice(cursor, start) });
    segments.push({ type: "proposal", key: proposalKey(proposal), proposal });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
  return segments;
}

export function AssistantProposalCard({ projectId, proposal, settled, canWrite, onSettled }: {
  /** 草稿目标是项目资产；对话用户级化（2026-09-16）后抽屉可能在全局页——不在
      项目里时卡片降级为只读预览（不拉用例、不给应用）。 */
  projectId: string | undefined;
  proposal: AssistantProposal;
  settled?: ProposalSettled;
  /** viewer 只读：卡片照样渲染（历史里的草稿可看），不给应用按钮。 */
  canWrite: boolean;
  onSettled: (state: ProposalSettled) => void;
}) {
  const { t } = useTranslation();
  const inProject = Boolean(projectId);
  const [caseState, setCaseState] = useState<"loading" | "ready" | "missing">("loading");
  const [caseName, setCaseName] = useState("");
  const [existing, setExisting] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  /* 读目标用例：名字进卡片头（比裸 UUID 可读），已有脚本数进差异摘要。 */
  useEffect(() => {
    let alive = true;
    if (!projectId) { setCaseState("missing"); return; }
    setCaseState("loading");
    void api.case(projectId, proposal.caseId).then((testCase) => {
      if (!alive) return;
      setCaseState("ready");
      setCaseName(testCase.name);
      setExisting(testCase.responseScripts.length);
    }).catch(() => {
      if (alive) setCaseState("missing");
    });
    return () => { alive = false; };
  }, [inProject, projectId, proposal.caseId]);

  /** 确认应用（本人 JWT）：重读用例 → 追加草稿 → 整份 PATCH。审计里 created_by
   *  是本人（门槛 4 的落点）。 */
  async function apply() {
    if (!projectId) return;
    setBusy(true);
    setError(undefined);
    try {
      const testCase = await api.case(projectId, proposal.caseId);
      const next: ResponseScript[] = [...testCase.responseScripts, {
        type: "script",
        enabled: true,
        name: proposal.name ?? "assistant-draft",
        script: { content: proposal.script },
      }];
      await api.updateCase(projectId, proposal.caseId, { responseScripts: next });
      setExisting(next.length);
      onSettled("applied");
    } catch (cause) {
      const server = (cause as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
      setError(typeof server === "string" && server ? server : t("assistantProposal.applyFailed"));
    } finally {
      setBusy(false);
    }
  }

  /* 终态：一行回执，卡片收扁（对话里的历史痕迹，不再是待办）。 */
  if (settled) {
    return <div className="chat-proposal chat-proposal-settled">
      <span className="chat-proposal-kind">{t("assistantProposal.kindResponseScript")}</span>
      <span className="chat-proposal-summary">{t(settled === "applied" ? "assistantProposal.applied" : "assistantProposal.dismissed")}</span>
    </div>;
  }

  return <div className="chat-proposal">
    <div className="chat-proposal-head">
      <span className="chat-proposal-kind">{t("assistantProposal.kindResponseScript")}</span>
      <span className="chat-proposal-case mono">{inProject && caseState === "ready" ? caseName : proposal.caseId}</span>
    </div>
    <pre className="chat-proposal-code mono">{proposal.script}</pre>
    <p className="chat-proposal-summary">
      {!inProject ? t("assistantProposal.outsideProject")
        : caseState === "missing" ? t("assistantProposal.caseMissing")
          : caseState === "loading" ? t("assistantProposal.loadingCase")
            : existing === 0 ? t("assistantProposal.summaryFirst")
              : t("assistantProposal.summaryAppend", { count: existing, index: existing + 1 })}
    </p>
    {!canWrite
      ? inProject && <p className="chat-proposal-summary">{t("assistantProposal.readonly")}</p>
      : <div className="chat-proposal-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={busy || caseState !== "ready"} onClick={() => void apply()}>
          {busy ? "…" : t("assistantProposal.apply")}
        </button>
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => onSettled("dismissed")}>
          {t("assistantProposal.dismiss")}
        </button>
      </div>}
    {error && <p className="form-error">{error}</p>}
  </div>;
}
