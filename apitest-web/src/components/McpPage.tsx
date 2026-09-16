import { useCallback, useEffect, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Unlink } from "lucide-react";
import { api, type McpProjectBinding, type McpScope, type McpToolSummary } from "../api";
import { useCanManageProject } from "../hooks/useMyRole";
import { useProjectStore } from "../stores/projectStore";
import { Empty } from "../ui";
import { apiMessage } from "./DataSourceList";
import { CopyButton } from "./CopyButton";

/**
 * MCP 管理页（P5-6 建，P12-2 降级；计划 18.4）。
 *
 * **能力面已上移用户级**：签发 / 吊销是「本人」的动作（`/me/mcp`，个人中心），scope 挂在
 * 绑定上而不是 Token 上（P12 边界 2）。本页因此只剩三件事：
 *
 * 1. **服务与端点 + 启停开关**（项目总闸，边界 4；`mcp_enabled` 语义不变，仍 404）；
 * 2. **绑定表**：谁把钥匙开到了我这扇门上（绑定人 / scope / last_used_at）——签发权上移
 *    之后，项目管理员对「谁能开我这扇门」的最终控制不能丢，所以保留踢绑定；
 * 3. **工具清单**（只读展示，非协议面）。
 *
 * 前端只提供管理入口，不做对话式创建 UI（交互文档 3.10 的边界照旧）：消费方是内网里
 * 受控的智能体平台——它拿 Token 经 `/mcp` 调工具，页面上没有任何「替你调一次」的动作。
 */

/** MCP 端点挂在根上（与 `/ingest` 同层），不带 `/api/v1` 前缀——与 Runner 的根地址同一拼法。
 *  个人中心的 MCP tab 复用这一份（两处展示同一个地址，不引出第二份拼法）。 */
export function mcpEndpointUrl() {
  const base = import.meta.env.VITE_API_BASE_URL ?? `${window.location.origin.replace(/:\d+$/, ":3000")}/api/v1`;
  return `${String(base).replace(/\/api\/v1\/?$/, "")}/mcp`;
}

/** 工具表按 read → write → execute 排：scope 是这张表的主维度，名字只在档内排序。 */
const SCOPE_ORDER: Record<McpScope, number> = { read: 0, write: 1, execute: 2 };

export function McpPage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading, mcpEnabled, updateMcpEnabled } = useProjectStore();
  /* 开关与踢绑定都是项目级管理动作（requireProjectAdmin）——developer 不渲染；绑定表
     本身是项目读，全员可见（「谁的钥匙开着」不是秘密，收钥匙才是管理动作）。 */
  const canManage = useCanManageProject();

  const [bindings, setBindings] = useState<McpProjectBinding[]>();
  const [tools, setTools] = useState<McpToolSummary[]>();
  const [failed, setFailed] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<"all" | McpScope>("all");

  const load = useCallback(async () => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    try {
      const [bindingList, toolList] = await Promise.all([api.mcpBindings(projectId), api.mcpTools(projectId)]);
      setBindings(bindingList);
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

  /**
   * 踢绑定（边界 4）：只删绑定行、不吊销 Token——owner 可能还拿这把钥匙开着别的项目
   * 的门，项目收的是「我这扇门」。即时生效：下一次 tools/call 就按新的绑定集判。
   */
  function unbind(binding: McpProjectBinding) {
    if (!projectId) return;
    Modal.confirm({
      title: t("mcp.bindingUnbindTitle", { name: binding.ownerName ?? binding.ownerEmail ?? binding.tokenName }),
      content: t("mcp.bindingUnbindHint"),
      okText: t("mcp.bindingUnbind"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.unbindMcpBinding(projectId, binding.tokenId); message.success(t("mcp.bindingUnbound")); await load(); }
        catch (error) { message.error(apiMessage(error) ?? t("mcp.bindingUnbindFailed")); }
      },
    });
  }

  const endpoint = mcpEndpointUrl();
  /* 过滤与排序在前端做：几十行的静态清单，服务端没有再开一个查询参数的理由。 */
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
        {canManage && <label className="check-field" title={t("mcp.enableHint")}>
          <input
            type="checkbox"
            checked={mcpEnabled}
            disabled={savingToggle}
            onChange={(event) => void changeEnabled(event.target.checked)}
          />
          {t("mcp.enable")}
        </label>}
      </div>
    </div>

    {failed ? <Empty
      title={t("mcp.loadFailed")}
      hint={t("mcp.loadFailedHint")}
      action={<button className="btn" onClick={() => void load()}>{t("action.retry")}</button>}
    /> : bindings === undefined || tools === undefined ? <p className="muted">{t("common.loading")}</p> : <>
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

      {/* ── 二、绑定（只读视图 + 踢绑定）────────────────────────────────────────
          P12-2 起这不再是「Token 管理」：Token 归人、签发在本人侧，项目侧只回答
          「谁的钥匙开着我的门」。 */}
      <section className="panel">
        <div className="panel-head"><strong>{t("mcp.bindings")}</strong></div>
        <div className="panel-body">
          <p className="form-note">{t("mcp.bindingsHint")}</p>
          {bindings.length ? <div className="table-scroll"><table className="grid">
            <thead><tr>
              <th>{t("mcp.bindingOwner")}</th>
              <th>{t("mcp.tokenName")}</th>
              <th className="mono">{t("mcp.tokenPrefix")}</th>
              <th>{t("mcp.tokenScope")}</th>
              <th>{t("mcp.tokenLastUsed")}</th>
              <th className="mono">{t("mcp.bindingBoundAt")}</th>
              {canManage && <th className="col-actions" />}
            </tr></thead>
            <tbody>
              {bindings.map((binding) => <tr key={binding.tokenId}>
                <td className="truncate">
                  <strong>{binding.ownerName ?? t("mcp.bindingOwnerDeleted")}</strong>
                  {binding.ownerEmail && <div className="mono muted">{binding.ownerEmail}</div>}
                </td>
                <td className="truncate">{binding.tokenName}</td>
                <td className="mono muted">{binding.tokenPrefix}…</td>
                <td><span className="tag-inline">{binding.scope.map((scope) => <span key={scope} className="chip">{scope}</span>)}</span></td>
                <td className="mono muted">{binding.lastUsedAt ? new Date(binding.lastUsedAt).toLocaleString() : t("mcp.tokenNeverUsed")}</td>
                <td className="mono muted">{new Date(binding.boundAt).toLocaleString()}</td>
                {canManage && <td className="col-actions"><div className="row-actions">
                  <button className="btn danger btn-with-icon" onClick={() => unbind(binding)}>
                    <Unlink size={14} />{t("mcp.bindingUnbind")}
                  </button>
                </div></td>}
              </tr>)}
            </tbody>
          </table></div> : <Empty title={t("mcp.bindingsEmpty")} hint={t("mcp.bindingsEmptyHint")} />}
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
  </main>;
}
