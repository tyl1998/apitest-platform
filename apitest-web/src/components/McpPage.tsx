import { useCallback, useEffect, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { api, type McpScope, type McpToken, type McpToolSummary } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { Empty } from "../ui";
import { apiMessage } from "./DataSourceList";
import { CopyButton } from "./CopyButton";
import { IconButton } from "./IconButton";

/**
 * MCP 管理页（P5-6，计划 9.6）。
 *
 * 前端只提供管理入口，不做对话式创建 UI（交互文档 3.10 的边界照旧）：启停开关、
 * 端点地址、Token 签发与吊销、工具清单只读表。消费方是内网里受控的智能体平台——
 * 它拿 Token 经 `/mcp` 调工具，页面上没有任何「替你调一次」的动作。
 */

/** MCP 端点挂在根上（与 `/ingest` 同层），不带 `/api/v1` 前缀——与 Runner 的根地址同一拼法。 */
function mcpEndpointUrl() {
  const base = import.meta.env.VITE_API_BASE_URL ?? `${window.location.origin.replace(/:\d+$/, ":3000")}/api/v1`;
  return `${String(base).replace(/\/api\/v1\/?$/, "")}/mcp`;
}

/** 工具表按 read → write → execute 排：scope 是这张表的主维度，名字只在档内排序。 */
const SCOPE_ORDER: Record<McpScope, number> = { read: 0, write: 1, execute: 2 };

export function McpPage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading, mcpEnabled, updateMcpEnabled } = useProjectStore();

  const [tokens, setTokens] = useState<McpToken[]>();
  const [tools, setTools] = useState<McpToolSummary[]>();
  const [failed, setFailed] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<"all" | McpScope>("all");

  /* ── 签发弹窗：两段式——表单段可取消，明文段必须显式「我已保存」才能关 ─────── */
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueName, setIssueName] = useState("");
  const [issueWrite, setIssueWrite] = useState(false);
  const [issueExecute, setIssueExecute] = useState(false);
  const [issuing, setIssuing] = useState(false);
  /** 刚签出的明文。只存在于弹窗这一段里，关闭即清——「只显示一次」是纪律不是建议。 */
  const [issued, setIssued] = useState<{ token: string; scope: McpScope[] }>();

  const load = useCallback(async () => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    try {
      const [tokenList, toolList] = await Promise.all([api.mcpTokens(projectId), api.mcpTools(projectId)]);
      setTokens(tokenList);
      setTools(toolList);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [projectId, loadedProjectId, projectLoading]);

  useEffect(() => { void load(); }, [load]);

  async function changeEnabled(checked: boolean) {
    setSavingToggle(true);
    try {
      await updateMcpEnabled(checked);
      message.success(t(checked ? "mcp.enableOn" : "mcp.enableOff"));
    } catch {
      message.error(t("mcp.enableUpdateFailed"));
    } finally { setSavingToggle(false); }
  }

  async function issue() {
    if (!projectId || !issueName.trim()) { message.error(t("mcp.tokenNameRequired")); return; }
    setIssuing(true);
    try {
      const scope: McpScope[] = ["read", ...(issueWrite ? ["write" as const] : []), ...(issueExecute ? ["execute" as const] : [])];
      const created = await api.createMcpToken(projectId, { name: issueName.trim(), scope });
      setIssued({ token: created.token, scope: created.scope });
    } catch (error) {
      message.error(apiMessage(error) ?? t("mcp.tokenCreateFailed"));
    } finally { setIssuing(false); }
  }

  /** 明文段唯一的出口：清状态（明文随之消失）并刷新列表——新 Token 立刻出现在表里。 */
  function closeIssue() {
    setIssueOpen(false);
    setIssued(undefined);
    setIssueName("");
    setIssueWrite(false);
    setIssueExecute(false);
    void load();
  }

  function revokeToken(token: McpToken) {
    if (!projectId) return;
    Modal.confirm({
      title: t("mcp.tokenRevokeTitle", { name: token.name }),
      /* 吊销即时生效（鉴权候选集走部分索引，被吊销行不在里面）：正在用它调用的
         agent 下一次请求就被拒——影响面要在点之前说清。 */
      content: t("mcp.tokenRevokeHint"),
      okText: t("mcp.tokenRevoke"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.revokeMcpToken(projectId, token.id); message.success(t("mcp.tokenRevoked")); await load(); }
        catch (error) { message.error(apiMessage(error) ?? t("mcp.tokenRevokeFailed")); }
      },
    });
  }

  const endpoint = mcpEndpointUrl();
  /* 过滤与排序在前端做：43 行的静态清单，服务端没有再开一个查询参数的理由。 */
  const visibleTools = (tools ?? [])
    .filter((tool) => scopeFilter === "all" || tool.scope === scopeFilter)
    .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.name.localeCompare(b.name));
  const scopeCounts = (["read", "write", "execute"] as const).map((scope) => ({
    scope,
    count: (tools ?? []).filter((tool) => tool.scope === scope).length,
  }));

  return <main className="content">
    <div className="page-head">
      <div>
        <h1>{t("mcp.title")}</h1>
        <p>{t("mcp.hint")}</p>
      </div>
      <div className="topbar-actions">
        {/* 与「环境管理」页头的明文开关同款位置：项目级设置出现在它语义所属的页上。 */}
        <label className="check-field" title={t("mcp.enableHint")}>
          <input
            type="checkbox"
            checked={mcpEnabled}
            disabled={savingToggle}
            onChange={(event) => void changeEnabled(event.target.checked)}
          />
          {t("mcp.enable")}
        </label>
      </div>
    </div>

    {failed ? <Empty
      title={t("mcp.loadFailed")}
      hint={t("mcp.loadFailedHint")}
      action={<button className="btn" onClick={() => void load()}>{t("action.retry")}</button>}
    /> : tokens === undefined || tools === undefined ? <p className="muted">{t("common.loading")}</p> : <>
      {/* ── 一、服务与端点 ──────────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head"><strong>{t("mcp.service")}</strong></div>
        <div className="panel-body">
          <p className="form-note">{t("mcp.serviceHint")}</p>
          <div className="code-block">
            <div className="code-block-head">
              <span className="label">{t("mcp.endpoint")}</span>
              <CopyButton value={() => endpoint} />
            </div>
            <pre className="code">{endpoint}</pre>
          </div>
          <p className="form-note">{t("mcp.endpointHint")}</p>
        </div>
      </section>

      {/* ── 二、Token ───────────────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <strong>{t("mcp.tokens")}</strong>
          <button className="btn btn-primary btn-with-icon" onClick={() => setIssueOpen(true)}>
            <Plus size={14} />{t("mcp.tokenCreate")}
          </button>
        </div>
        <div className="panel-body">
          <p className="form-note">{t("mcp.tokensHint")}</p>
          {tokens.length ? <table className="grid">
            <thead><tr>
              <th>{t("mcp.tokenName")}</th>
              <th className="mono">{t("mcp.tokenPrefix")}</th>
              <th>{t("mcp.tokenScope")}</th>
              <th>{t("mcp.tokenLastUsed")}</th>
              <th>{t("mcp.tokenCreatedAt")}</th>
              <th className="col-actions" />
            </tr></thead>
            <tbody>
              {tokens.map((token) => <tr key={token.id}>
                <td><strong className="truncate">{token.name}</strong></td>
                <td className="mono muted">{token.tokenPrefix}…</td>
                {/* scope 是协议词汇（Token 里存的、tools/list 裁剪用的那个值），原样展示。 */}
                <td><span className="tag-inline">{token.scope.map((scope) => <span key={scope} className="chip">{scope}</span>)}</span></td>
                <td className="mono muted">{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : t("mcp.tokenNeverUsed")}</td>
                <td className="mono muted">{new Date(token.createdAt).toLocaleString()}</td>
                <td className="col-actions">
                  <div className="row-actions">
                    <IconButton icon={<Trash2 size={14} />} label={t("mcp.tokenRevoke")} tone="danger" onClick={() => revokeToken(token)} />
                  </div>
                </td>
              </tr>)}
            </tbody>
          </table> : <Empty title={t("mcp.tokensEmpty")} hint={t("mcp.tokensEmptyHint")} />}
        </div>
      </section>

      {/* ── 三、工具清单 ────────────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <strong>{t("mcp.tools")}</strong>
          <div className="segmented" role="group" aria-label={t("mcp.toolsFilter")}>
            <button
              className={`segmented-item${scopeFilter === "all" ? " is-active" : ""}`}
              onClick={() => setScopeFilter("all")}
            >{t("mcp.toolsFilterAll")} · {tools.length}</button>
            {scopeCounts.map(({ scope, count }) => <button
              key={scope}
              className={`segmented-item${scopeFilter === scope ? " is-active" : ""}`}
              onClick={() => setScopeFilter(scope)}
            >{scope} · {count}</button>)}
          </div>
        </div>
        <div className="panel-body">
          <p className="form-note">{t("mcp.toolsHint")}</p>
          <div className="table-scroll"><table className="grid">
            <thead><tr>
              <th>{t("mcp.toolName")}</th>
              <th>{t("mcp.toolDescription")}</th>
              <th>{t("mcp.toolScope")}</th>
            </tr></thead>
            <tbody>
              {visibleTools.map((tool) => <tr key={tool.name}>
                <td className="mono">{tool.name}</td>
                {/* description 是给模型读的那份原文（含「不能做什么」的边界），不翻译。 */}
                <td className="muted">{tool.description}</td>
                <td><span className="chip">{tool.scope}</span></td>
              </tr>)}
            </tbody>
          </table></div>
        </div>
      </section>
    </>}

    {/* 签发弹窗：表单段可取消；明文段没有 X、没有遮罩关闭——一次性凭据不能被顺手点掉。 */}
    <Modal
      open={issueOpen}
      title={t("mcp.issueTitle")}
      okText={issued ? t("mcp.issueDone") : t("mcp.tokenCreate")}
      cancelText={t("action.cancel")}
      confirmLoading={issuing}
      okButtonProps={issued ? undefined : { disabled: !issueName.trim() }}
      cancelButtonProps={issued ? { style: { display: "none" } } : undefined}
      closable={!issued}
      maskClosable={!issued}
      keyboard={!issued}
      onOk={() => (issued ? closeIssue() : void issue())}
      onCancel={() => closeIssue()}
    >
      {issued ? <>
        {/* 签发结果回显 scope：把钥匙交出去前能核对「这把是只读的」。 */}
        <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center", marginTop: "var(--s4)" }}>
          <span className="label">{t("mcp.issueScope")}</span>
          <span className="tag-inline">{issued.scope.map((scope) => <span key={scope} className="chip">{scope}</span>)}</span>
        </div>
        <div className="code-block" style={{ marginTop: "var(--s4)" }}>
          <div className="code-block-head">
            <span className="label">{t("mcp.issuePlaintext")}</span>
            <CopyButton value={() => issued.token} />
          </div>
          <pre className="code">{issued.token}</pre>
        </div>
        <p className="form-note">{t("mcp.issuePlaintextOnce")}</p>
      </> : <>
        <label className="field" style={{ marginTop: "var(--s4)" }}>
          <span>{t("mcp.tokenName")}</span>
          <input
            className="input"
            value={issueName}
            onChange={(event) => setIssueName(event.target.value)}
            placeholder={t("mcp.tokenNamePlaceholder")}
          />
        </label>
        <div style={{ display: "grid", gap: "var(--s2)", marginTop: "var(--s4)" }}>
          <span className="label">{t("mcp.issueScope")}</span>
          {/* read 恒在（服务端也会补齐）：只读钥匙不存在，「给 write 不给 read」是盲写。 */}
          <label className="check-field" title={t("mcp.issueScopeReadHint")}>
            <input type="checkbox" checked disabled />
            {t("mcp.issueScopeRead")}
          </label>
          <label className="check-field">
            <input type="checkbox" checked={issueWrite} onChange={(event) => setIssueWrite(event.target.checked)} />
            {t("mcp.issueScopeWrite")}
          </label>
          <label className="check-field">
            <input type="checkbox" checked={issueExecute} onChange={(event) => setIssueExecute(event.target.checked)} />
            {t("mcp.issueScopeExecute")}
          </label>
        </div>
        {/* 边界 2 必须在勾上 write / execute 的那一刻说清，否则「Token 突然写不动了」
            会变成一个查不到原因的问题（9.6 的原话）。 */}
        {(issueWrite || issueExecute) && <p className="form-note">{t("mcp.issueWriteWarning")}</p>}
      </>}
    </Modal>
  </main>;
}
