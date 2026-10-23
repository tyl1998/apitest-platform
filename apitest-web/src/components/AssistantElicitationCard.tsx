import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type EnvironmentUsage } from "../api";

/**
 * 确认表单卡（2026-09-15 起家；2026-10-22 增「回传上游」）。
 *
 * 上游把「要不要执行这个工具」做成聊天流里的一张卡，引擎翻译成 `elicit` 事件，这里
 * 渲染成**表单**：原文 + 后果摘要 + 「确认 / 放弃」。
 *
 * 两条路径，由**卡片拿到的信息**决定，与具体上游无关：
 * 1. **回传上游**（`block.confirmId` 有值 + provider 配了答复端点）：点确认/放弃 ⇒
 *    `recordElicitOutcome` 带上 `confirmId`，服务端转给上游、上游继续跑同一条流。
 *    `applied:false`（没人在等这个 id：超时/已被处理/迟到点击）是**正常终局**，
 *    显示成「已失效」而不是错误。
 * 2. **本地 REST**（旧路径，没有 confirmId 或协议没配端点）：确认动作走本人 JWT 的
 *    既有 REST（当前唯一的枚举是 `delete_environment`；未知工具只读卡）。审计
 *    `created_by` 是点击的人，比 MCP Token 签发人更准。
 *
 * 另外两条纪律（上游协议约定）：
 * - **倒计时只读 `expiresAt`**：上游超时**不再发事件**，到点必须自己置灰，否则用户
 *   会点一个必然 `applied:false` 的按钮；
 * - `inputSummary` 是**已抹敏、可能被截断**的 JSON 字符串：parse 成功才当结构化入参，
 *   失败就只显示原文（定位不到对象不报错）。
 *
 * 终态（confirmed/declined）由 AssistantDock 按回合+工具索引持有，重渲染不丢。
 */
export type ElicitSettled = "confirmed" | "declined";

/** 卡片上的「已失效」（超时 / 上游说没人在等）——与 confirmed/declined 区分展示。 */
export type ElicitCardState = ElicitSettled | "expired";

/** 解析上游的入参摘要：能 parse 成对象就用对象，否则 undefined（调用方退回原文）。 */
function parseInputSummary(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* 截断/非对象：交给调用方显示原文。 */
  }
  return undefined;
}

/** 距 `expiresAt` 剩余秒数（无值/非法 ⇒ null = 不做倒计时）。 */
function remainingSeconds(expiresAt: string | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function AssistantElicitationCard({ projectId, block, settled, canWrite, upstreamReply, autoApprove, autoApproveMode, onReplyUpstream, onSettled }: {
  /** 删除目标是项目资产；对话用户级化（2026-09-16）后抽屉可能在全局页——不在
      项目里时「本地 REST」路径降级为只读（回传上游路径不受此限）。 */
  projectId: string | undefined;
  block: {
    /** 上游事件可能缺字段（历史记录/半截事件），渲染侧按可选处理。 */
    text?: string;
    tool?: string;
    input?: Record<string, unknown>;
    schema?: unknown;
    /** 上游给的确认 id：有它 + 下方 `upstreamReply` 才能回传上游。 */
    confirmId?: string;
    expiresAt?: string;
    source?: string;
    /** 上游的入参摘要原文（可能截断、已抹敏）；`input` 缺失时尝试解析它。 */
    inputSummary?: string;
    /** 「同轮重复执行」：卡片提示这次会再跑一次。 */
    duplicate?: boolean;
  };
  settled?: ElicitCardState;
  /** viewer 只读：本地 REST 路径不给确认按钮（回传上游是只读观察不了的写动作，同样要写权限）。 */
  canWrite: boolean;
  /** provider 是否配了「确认答复」端点（由 AssistantDock 按当前 provider 传入）。 */
  upstreamReply: boolean;
  /** 自动批准（2026-10-22）：**会话级**状态，由抽屉的会话选择器行持有并展示；卡片只
      读它决定要不要代点。开着的会话里上游**不再发确认**；没有上游端点时退回本地代点
      （见 `autoApproveMode`）。 */
  autoApprove: boolean;
  /** `upstream` = 开关下发到上游（停发 confirm）；`local` = 本地代点确认（旧做法）。 */
  autoApproveMode: "upstream" | "local";

  /** 上游答复的回调：返回结果给卡片决定「已确认 / 已失效」。 */
  onReplyUpstream: (state: ElicitSettled, by?: "auto") => Promise<{ applied?: boolean }>;
  /** 持久化确认记录的入参（结构化 `input` 或上游原文 `inputSummary`）。 */
  recordInput?: Record<string, unknown>;
  onSettled: (state: ElicitCardState) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** 2003 撞上独占依赖时的清单 + 「仍要删除」二段确认（环境页同款语义）。 */
  const [usage, setUsage] = useState<EnvironmentUsage>();
  /* 倒计时的心跳：只在有 expiresAt 且未落定时跑（每秒一次，落定即停）。 */
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = block.expiresAt;
  useEffect(() => {
    if (!expiresAt || settled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt, settled]);

  const remaining = remainingSeconds(expiresAt, now);
  const timedOut = remaining !== null && remaining <= 0;
  const effective = settled ?? (timedOut ? "expired" : undefined);

  /** 结构化入参：优先事件自带的 `input`（引擎从工具帧记的），否则解析 `inputSummary`。 */
  const input = useMemo(() => block.input ?? parseInputSummary(block.inputSummary), [block.input, block.inputSummary]);
  const upstream = Boolean(block.confirmId) && upstreamReply;
  /* 有 confirmId 就是上游卡；`source` 只用来补判历史记录里缺 id 的卡。 */
  const upstreamKind = Boolean(block.confirmId) || block.source === "SERVER";

  const tool = block.tool ?? "";
  const environmentId = typeof input?.environmentId === "string" ? input.environmentId : undefined;
  const inProject = Boolean(projectId);
  const localSupported = inProject && tool === "delete_environment" && Boolean(environmentId);
  /* 「能不能做」：回传上游只要有 confirmId；本地 REST 走枚举。 */
  const actionable = upstream || localSupported;

  /* 自动批准（2026-10-22）：
     - `upstream` 模式（协议配了 autoApprove 端点）：开关已下发上游，它压根不发 confirm
       ——能走到这张卡说明是开关之前就生成的，照常手点，不代点；
     - `local` 模式（旧上游没有端点）：我们**替用户**点确认，并写明是自动批准。
     `autoFired` 是这张卡的闸门：只代点一次，失败后等人点重试（不自动重试）。 */
  const [autoFired, setAutoFired] = useState(false);
  useEffect(() => {
    /* 只读视角不代点：观众没有写权限，代点等于绕过 RBAC。 */
    if (autoApproveMode !== "local" || !autoApprove || !upstream || !canWrite || autoFired) return;
    setAutoFired(true);
    void replyUpstream("confirmed", "auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoApproveMode, autoApprove, upstream, canWrite, autoFired]);

  /** 确认删除（本地 REST）：非 force 先读 usage（卡内自带后果），有独占依赖则列清单等
      二段；force（「仍要删除」）直接带 force 删除。 */
  async function confirmLocal(force = false) {
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

  /** 回传上游：上游 200 + `applied:false` ⇒ 这张卡已经没人在等了（正常终局）。
      `by: "auto"`（2026-10-22）是自动批准代的确认——回执文案要说清楚是谁点的，
      否则历史里会读成「我点过确认」。 */
  async function replyUpstream(state: ElicitSettled, by?: "auto") {
    setBusy(true);
    setError(undefined);
    try {
      const result = await onReplyUpstream(state, by);
      onSettled(result.applied === false ? "expired" : state);
    } catch (cause) {
      const response = (cause as { response?: { data?: { message?: unknown } } })?.response;
      const message = response?.data?.message;
      setError(typeof message === "string" && message ? message : t("assistantElicit.replyFailed"));
    } finally {
      setBusy(false);
    }
  }

  /* 终态：一行回执收扁（对话里的历史痕迹，不再是待办）。 */
  if (effective) {
    const kindKey = effective === "expired" ? "assistantElicit.kindExpired" : upstreamKind ? "assistantElicit.kindUpstream" : "assistantElicit.kindDelete";
    const summaryKey = effective === "confirmed"
      ? (autoFired ? "assistantElicit.confirmedAuto" : upstreamKind ? "assistantElicit.confirmedUpstream" : "assistantElicit.confirmed")
      : effective === "declined" ? "assistantElicit.declined" : "assistantElicit.expired";
    return <div className="chat-proposal chat-proposal-settled">
      <span className="chat-proposal-kind">{t(kindKey)}</span>
      <span className="chat-proposal-summary">{t(summaryKey)}</span>
    </div>;
  }

  return <div className="chat-proposal chat-elicit">
    <div className="chat-proposal-head">
      {/* source 只影响标题文案：PLATFORM = 平台危险判定，SERVER = 上游 MCP 二次确认。 */}
      <span className="chat-proposal-kind">
        {upstreamKind ? t("assistantElicit.kindUpstream") : t("assistantElicit.kindDelete")}
      </span>
      <span className="chat-proposal-case mono">{tool}</span>
      {remaining !== null && <span className="chat-proposal-case mono">{t("assistantElicit.expiresIn", { seconds: remaining })}</span>}
    </div>
    {/* 确认请求原文（上游生成的后果摘要）。 */}
    {block.text && <p className="chat-proposal-summary">{block.text}</p>}
    {/* 同轮重复执行（2026-10-22）：上游说这个工具这一轮已经跑过一遍，再点是再跑一次。 */}
    {block.duplicate && <p className="chat-proposal-summary chat-elicit-duplicate">{t("assistantElicit.duplicate")}</p>}
    {/* 入参摘要：parse 成功才列出键值（已抹敏），parse 失败就退化成原文。 */}
    {!block.input && block.inputSummary && !input && (
      <p className="chat-proposal-summary mono">{block.inputSummary}</p>
    )}
    {input && Object.keys(input).length > 0 && (
      <ul className="chat-elicit-endpoints mono">
        {Object.entries(input).slice(0, 6).map(([key, value]) => (
          <li key={key}>{key}: {typeof value === "string" ? value : JSON.stringify(value)}</li>
        ))}
      </ul>
    )}
    {usage?.blocked && <div className="chat-elicit-blocked">
      <p className="chat-proposal-summary">{t("assistantElicit.blockedHint", { count: usage.endpoints.length })}</p>
      <ul className="chat-elicit-endpoints mono">
        {usage.endpoints.map((endpoint) => (
          <li key={endpoint.id}>{endpoint.method} {endpoint.name}（{endpoint.variables.map((name) => `{{${name}}}`).join(", ")}）</li>
        ))}
      </ul>
    </div>}
    {!actionable
      ? <p className="chat-proposal-summary">{inProject ? t("assistantElicit.unsupported", { tool }) : t("assistantElicit.outsideProject")}</p>
      : !canWrite
        ? <p className="chat-proposal-summary">{t("assistantElicit.readonly")}</p>
        : <div className="chat-proposal-actions">
          {upstream ? <>
            <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={() => void replyUpstream("confirmed")}>
              {busy ? "…" : t("assistantElicit.confirmUpstream")}
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void replyUpstream("declined")}>
              {t("assistantElicit.decline")}
            </button>
          </> : usage?.blocked
            ? <button type="button" className="btn danger btn-small" disabled={busy} onClick={() => void confirmLocal(true)}>
              {busy ? "…" : t("assistantElicit.deleteAnyway")}
            </button>
            : <>
              <button type="button" className="btn danger btn-small" disabled={busy} onClick={() => void confirmLocal(false)}>
                {busy ? "…" : t("assistantElicit.confirm")}
              </button>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => onSettled("declined")}>
                {t("assistantElicit.decline")}
              </button>
            </>}
        </div>}
    {error && <p className="form-error">{error}</p>}
  </div>;
}
