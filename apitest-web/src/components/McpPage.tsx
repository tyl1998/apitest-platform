import { useCallback, useEffect, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { ShieldPlus, Unlink } from "lucide-react";
import { api, configuredApiBaseUrl, type McpBindingRequest, type McpProjectBinding, type McpScope, type McpToolSummary } from "../api";
import { useCanManageProject, useMyRole } from "../hooks/useMyRole";
import { useProjectStore } from "../stores/projectStore";
import { Empty, PageToolbar, Status } from "../ui";
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
 *
 * **2026-09-21 增补（用户反馈第三项）**：项目侧的「干看着」补一条出口——成员在自己角色
 * 拿不到的档位（viewer 只有 read）上，可以在这页提交**绑定许可申请**，project_admin 收
 * 站内通知并在同页审批；批准行本身就是授权（有效 scope 实时聚合），个人中心的绑定弹窗
 * 立刻能勾到那一档。这一页因此多两段：成员视角的申请面板 / 管理员视角的审批面板。
 */

/** MCP 端点挂在根上（与 `/ingest` 同层），不带 `/api/v1` 前缀——与 Runner 的根地址同一拼法。
 *  个人中心的 MCP tab 复用这一份（两处展示同一个地址，不引出第二份拼法）。 */
export function mcpEndpointUrl() {
  const base = configuredApiBaseUrl() ?? `${window.location.origin.replace(/:\d+$/, ":3000")}/api/v1`;
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
  /* 我在这个项目里的角色（成员视角的申请面板按它分叉：只有 viewer 会被角色上限挡住）。 */
  const myRole = useMyRole();

  const [bindings, setBindings] = useState<McpProjectBinding[]>();
  const [tools, setTools] = useState<McpToolSummary[]>();
  const [failed, setFailed] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<"all" | McpScope>("all");
  /** 管理员视角的本项目申请（含历史）；成员视角不拉（那一条走 /me 的本人集）。 */
  const [requests, setRequests] = useState<McpBindingRequest[]>();
  /** 本人跨项目的申请（判断本项目有没有待审 / 已批准，成员面板与管理弹窗共用）。 */
  const [myRequests, setMyRequests] = useState<McpBindingRequest[]>([]);
  /* ── 成员申请弹窗：勾选申请档位 + 说明 ─────────────────────────────────────── */
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyScopes, setApplyScopes] = useState<McpScope[]>([]);
  const [applyNote, setApplyNote] = useState("");
  const [applying, setApplying] = useState(false);
  /** 审批中的单据 id（按钮 loading，防连点）。 */
  const [handlingId, setHandlingId] = useState<string>();

  const load = useCallback(async () => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    try {
      const [bindingList, toolList, own] = await Promise.all([
        api.mcpBindings(projectId),
        api.mcpTools(projectId),
        api.myMcpBindingRequests(),
      ]);
      setBindings(bindingList);
      setTools(toolList);
      setMyRequests(own.filter((request) => request.projectId === projectId));
      /* 管理员的审批列表是管理面读（requireProjectAdmin）：非管理员不发这个请求。 */
      if (canManage) setRequests(await api.mcpBindingRequests(projectId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [projectId, loadedProjectId, projectLoading, canManage]);

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

  /* ── 绑定许可申请（2026-09-21）：成员提交、管理员审批 ───────────────────────── */

  /** 本项目里我的未决申请（单 pending——服务端也这么保证）。 */
  const pendingRequest = myRequests.find((request) => request.status === "pending");
  /** 已批准档位的并集：这些档位在个人中心的绑定弹窗里已经可勾，不再重复申请。 */
  const grantedScopes = [...new Set(myRequests.filter((request) => request.status === "approved").flatMap((request) => request.scope))];
  /** 最近一条是「被拒」时提示可再申请（更早的历史不追着展示——状态条不是账本）。 */
  const rejectedRequest = myRequests[0]?.status === "rejected" ? myRequests[0] : undefined;
  /* 申请只对 viewer 有意义：其余角色本来就能绑全档，任何申请都会撞服务端的 409。 */
  const requestable = (["write", "execute"] as McpScope[]).filter((scope) => !grantedScopes.includes(scope));

  function openApply() {
    setApplyScopes(requestable);
    setApplyNote("");
    setApplyOpen(true);
  }

  async function submitApply() {
    if (!projectId || !applyScopes.length) return;
    setApplying(true);
    try {
      await api.createMcpBindingRequest(projectId, { scope: applyScopes, ...(applyNote.trim() ? { note: applyNote.trim() } : {}) });
      message.success(t("mcp.permSubmitted"));
      setApplyOpen(false);
      await load();
    } catch (error) {
      /* 409（已经能绑 / 已有待审）不是「失败」而是状态过期：刷新一次让面板说实话。 */
      message.error(apiMessage(error) ?? t("mcp.permSubmitFailed"));
      await load();
    } finally { setApplying(false); }
  }

  async function approveRequest(request: McpBindingRequest) {
    setHandlingId(request.id);
    try {
      await api.approveMcpBindingRequest(request.id);
      message.success(t("mcp.permApproved", { email: request.applicantEmail ?? "" }));
      await load();
    } catch (error) {
      message.error(apiMessage(error) ?? t("mcp.permApproveFailed"));
      await load();
    } finally { setHandlingId(undefined); }
  }

  /** 拒绝带一条可选说明（随结果通知发给申请人，与权限申请的拒绝同形）。 */
  function rejectRequest(request: McpBindingRequest) {
    let note = "";
    Modal.confirm({
      title: t("access.reqRejectTitle", { email: request.applicantEmail ?? "" }),
      content: <label className="field" style={{ marginTop: "var(--s4)" }}>
        <span>{t("access.reqRejectNote")}</span>
        <input className="input" placeholder={t("access.reqRejectNotePlaceholder")} onChange={(event) => { note = event.target.value; }} />
      </label>,
      okText: t("access.reqReject"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.rejectMcpBindingRequest(request.id, note.trim() || undefined); message.success(t("access.reqRejected")); await load(); }
        catch (error) { message.error(apiMessage(error) ?? t("access.reqRejectFailed")); await load(); }
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

  return <>
  <main className="content content-split">
    <PageToolbar>
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
    </PageToolbar>

    <div className="list-card">
    {failed ? <Empty
      title={t("mcp.loadFailed")}
      hint={t("mcp.loadFailedHint")}
      action={<button className="btn" onClick={() => void load()}>{t("action.retry")}</button>}
    /> : bindings === undefined || tools === undefined ? <p className="muted">{t("common.loading")}</p> : <>
      <div className="list-scroll">
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

      {/* ── 三、绑定许可申请（2026-09-21 用户反馈）──────────────────────────────
          成员视角（viewer）：角色上限之外的那几档在这里申请，管理员审批通过后个人中心
          的绑定弹窗就能勾到；管理员视角：本项目的申请待办（项目 MCP 页是申请的处理
          落点，与成员页的权限申请 tab 各管一条通道）。 */}
      {canManage ? <section className="panel">
        <div className="panel-head"><strong>{t("mcp.permRequests")}</strong></div>
        <div className="panel-body">
          <p className="form-note">{t("mcp.permRequestsHint")}</p>
          {requests === undefined ? <p className="muted">{t("common.loading")}</p>
            : requests.length === 0 ? <Empty title={t("mcp.permRequestsEmpty")} hint={t("mcp.permRequestsEmptyHint")} />
              : <div className="table-scroll"><table className="grid">
                <thead><tr>
                  <th>{t("access.reqApplicant")}</th>
                  <th>{t("mcp.permScope")}</th>
                  <th className="col-status">{t("access.reqStatus")}</th>
                  <th className="mono">{t("access.reqWhen")}</th>
                  <th className="col-actions" />
                </tr></thead>
                <tbody>
                  {requests.map((request) => <tr key={request.id}>
                    <td className="truncate">
                      <strong>{request.applicantName ?? request.applicantEmail ?? t("mcp.bindingOwnerDeleted")}</strong>
                      {request.applicantName && request.applicantEmail && <div className="mono muted">{request.applicantEmail}</div>}
                      {request.note && <div className="muted">{request.note}</div>}
                    </td>
                    <td><span className="tag-inline">{request.scope.map((scope) => <span key={scope} className="chip">{scope}</span>)}</span></td>
                    <td className="col-status">
                      {request.status === "pending" ? <Status status="queued" label={t("access.statusPending")} />
                        : request.status === "approved" ? <Status status="pass" label={t("access.statusApproved")} />
                        : <Status status="fail" label={t("access.statusRejected")} />}
                    </td>
                    <td className="mono muted">{new Date(request.createdAt).toLocaleString()}</td>
                    <td className="col-actions">{request.status === "pending" && <div className="row-actions">
                      <button className="btn btn-primary" disabled={handlingId === request.id} onClick={() => void approveRequest(request)}>{t("access.reqApprove")}</button>
                      <button className="btn danger" disabled={handlingId === request.id} onClick={() => rejectRequest(request)}>{t("access.reqReject")}</button>
                    </div>}</td>
                  </tr>)}
                </tbody>
              </table></div>}
        </div>
      </section> : myRole === "viewer" ? <section className="panel">
        <div className="panel-head"><strong>{t("mcp.permTitle")}</strong></div>
        <div className="panel-body">
          <p className="form-note">{t("mcp.permHint")}</p>
          {grantedScopes.length > 0 && <p className="form-note">{t("mcp.permGranted", { scope: grantedScopes.join(" / ") })}</p>}
          {pendingRequest
            ? <p className="form-note">{t("mcp.permPending", { scope: pendingRequest.scope.join(" / ") })}</p>
            : <>
              {rejectedRequest && <p className="form-note">{rejectedRequest.note
                ? t("mcp.permRejectedNote", { note: rejectedRequest.note })
                : t("mcp.permRejected")}</p>}
              {requestable.length
                ? <button className="btn btn-primary btn-with-icon" onClick={openApply}>
                  <ShieldPlus size={14} />{t("mcp.permApply")}
                </button>
                : <p className="form-note">{t("mcp.permAllGranted")}</p>}
            </>}
        </div>
      </section> : null}

      {/* ── 四、工具清单 ────────────────────────────────────────────────────── */}
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
    </div>
    </>}
    </div>
  </main>

  {/* 申请弹窗（成员 · 仅 viewer 可达）：勾选要申请的档位 + 一条可选说明。已批准的档位
      置灰勾选（不能重复申请），可选的只剩角色上限之外、还没批下来的那几档。 */}
  <Modal
    open={applyOpen}
    title={t("mcp.permApplyTitle")}
    okText={t("access.applySubmit")}
    cancelText={t("action.cancel")}
    confirmLoading={applying}
    okButtonProps={{ disabled: !applyScopes.length }}
    onOk={() => void submitApply()}
    onCancel={() => setApplyOpen(false)}
  >
    <p className="form-note">{t("mcp.permApplyHint")}</p>
    <div style={{ display: "grid", gap: "var(--s2)", marginTop: "var(--s4)" }}>
      {(["write", "execute"] as McpScope[]).map((scope) => <label key={scope} className="check-field" title={requestable.includes(scope) ? undefined : t("mcp.permAlreadyGranted")}>
        <input
          type="checkbox"
          checked={applyScopes.includes(scope)}
          disabled={!requestable.includes(scope)}
          onChange={(event) => setApplyScopes((current) => event.target.checked
            ? [...current, scope]
            : current.filter((each) => each !== scope))}
        />
        {t(scope === "write" ? "mcp.issueScopeWrite" : "mcp.issueScopeExecute")}
      </label>)}
    </div>
    <label className="field" style={{ marginTop: "var(--s4)" }}>
      <span>{t("mcp.permNote")}</span>
      <input className="input" value={applyNote} onChange={(event) => setApplyNote(event.target.value)} placeholder={t("mcp.permNotePlaceholder")} />
    </label>
    <p className="form-note">{t("mcp.permApplyFoot")}</p>
  </Modal>
  </>;
}
