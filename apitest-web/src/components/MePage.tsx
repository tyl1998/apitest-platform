import { useCallback, useEffect, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { Link2, Plus, Trash2 } from "lucide-react";
import { api, type BindableProject, type McpScope, type McpToken, type MeProfile } from "../api";
import { useAuthStore } from "../stores/authStore";
import { Empty } from "../ui";
import { apiMessage } from "./DataSourceList";
import { CopyButton } from "./CopyButton";
import { IconButton } from "./IconButton";
import { NotificationsPage } from "./NotificationsPage";
import { mcpEndpointUrl } from "./McpPage";

/**
 * 个人中心（P12-2，计划 18.4）：全局层 `/me`，四个 tab。
 *
 * 「我的」这个维度原先散在三处——改密只有助手抽屉里的账号指令、通知查看全部是
 * 一个孤立全局路由、MCP Token 挂在项目侧（P12 起 Token 归人，见 18.0）。本页把它们
 * 收进一个落点：
 *
 * - **基本信息**：`GET /me/profile` 只读 + 改密表单。改密复用既有
 *   `POST /auth/change-password`，零服务端改动；改密使全部旧 Token 失效（P6-5 的
 *   pwdEpoch），响应里换发的新 token 必须落地（`renewSession`），否则当前会话下一个
 *   请求就 401。
 * - **通知**：`NotificationsPage` 整组件迁入（组件与逻辑一字不动，只换挂载点）。
 * - **MCP Token**：签发 / 吊销（本人）+ 绑定管理（项目 × scope）。Token 本体没有
 *   scope——`read` / `write` / `execute` 是绑定的属性（边界 2），写权限的爆炸半径
 *   不随绑定数增长。
 * - **agent 凭据**：P9-4b 的落点，本阶段只留占位（边界 9）。
 *
 * tab 由地址栏驱动（`/me`、`/me/notifications`、`/me/mcp`、`/me/credentials`）：
 * URL 是唯一事实源——通知 tab 要能被助手抽屉的「查看全部」直接指过来，也要能被贴给
 * 别人（与项目层各页同款纪律）。未知段回落基本信息，不 404。
 */
type MeTab = "profile" | "notifications" | "mcp" | "credentials";

export function MePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { tab: routeTab } = useParams<{ tab: string }>();
  const tab: MeTab = routeTab === "notifications" || routeTab === "mcp" || routeTab === "credentials" ? routeTab : "profile";
  /* 未知段（`/me/xyz`）把地址收回 `/me`：显示基本信息但地址栏留着拼错的段，等于让
     「URL 是唯一事实源」这条纪律在此失效。 */
  useEffect(() => {
    if (routeTab && routeTab !== "notifications" && routeTab !== "mcp" && routeTab !== "credentials") navigate("/me", { replace: true });
  }, [routeTab, navigate]);
  const tabs: [MeTab, string, string][] = [
    ["profile", t("me.tabProfile"), "/me"],
    ["notifications", t("me.tabNotifications"), "/me/notifications"],
    ["mcp", t("me.tabMcp"), "/me/mcp"],
    ["credentials", t("me.tabCredentials"), "/me/credentials"],
  ];

  return <>
    <div className="page-head"><div><h1>{t("me.title")}</h1><p>{t("me.hint")}</p></div></div>
    <div className="tabs" role="tablist">
      {tabs.map(([key, label, path]) => (
        <button key={key} role="tab" aria-selected={tab === key} className={`tab${tab === key ? " is-active" : ""}`} onClick={() => navigate(path)}>{label}</button>
      ))}
    </div>
    {tab === "profile" && <ProfileTab />}
    {tab === "notifications" && <NotificationsPage />}
    {tab === "mcp" && <McpTokensTab />}
    {tab === "credentials" && <CredentialsTab />}
  </>;
}

/**
 * 基本信息：只读的账号字段 + 改密表单。
 *
 * 只读项走 `definition-grid`（dt/dd，与执行详情同款只读呈现）——禁用态的 input 看着
 * 像「只是暂时不能改」，而 email / 姓名在个人中心**本就不提供**自助修改（边界 10：
 * 自助改名 / 改邮箱不做，管理面已有）。
 */
function ProfileTab() {
  const { t } = useTranslation();
  const renewSession = useAuthStore((state) => state.renewSession);
  const [profile, setProfile] = useState<MeProfile>();
  const [failed, setFailed] = useState(false);
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    void api.meProfile()
      .then((value) => { if (alive) setProfile(value); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    if (newPassword !== confirm) { setError(t("changePassword.mismatch")); setBusy(false); return; }
    try {
      const result = await api.changePassword(currentPassword, newPassword);
      /* 换发的新 token 必须落地：旧 epoch 的 token 已经全废。 */
      renewSession(result);
      setCurrent(""); setNext(""); setConfirm("");
      message.success(t("me.passwordChanged"));
    } catch (cause) {
      const body = (cause as { response?: { data?: { message?: string } } })?.response?.data;
      setError(body?.message || t("changePassword.error"));
    } finally { setBusy(false); }
  }

  return <>
    <section className="panel">
      <div className="panel-head"><strong>{t("me.account")}</strong></div>
      <div className="panel-body">
        {failed ? <p className="form-error">{t("me.loadFailed")}</p>
          : profile === undefined ? <p className="muted">{t("common.loading")}</p>
            : <dl className="definition-grid">
              <div><dt>{t("me.email")}</dt><dd className="mono">{profile.email}</dd></div>
              <div><dt>{t("me.name")}</dt><dd>{profile.name}</dd></div>
              <div><dt>{t("me.role")}</dt><dd>{profile.isSystemAdmin ? t("me.systemAdmin") : t("me.member")}</dd></div>
            </dl>}
      </div>
    </section>

    <section className="panel">
      <div className="panel-head"><strong>{t("changePassword.title")}</strong></div>
      <div className="panel-body">
        {/* 旧密码必验：挡的是「初始密码还躺在别人聊天记录里」，不是「会话被盗」
            （后者由 pwdEpoch 收口）。文案与强制改密页同源。 */}
        <p className="form-note">{t("changePassword.subtitle")}</p>
        <form className="me-password-form" onSubmit={submit}>
          <label className="field"><span>{t("changePassword.current")}</span>
            <input className="input" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrent(event.target.value)} />
          </label>
          <label className="field"><span>{t("changePassword.next")}</span>
            <input className="input" type="password" autoComplete="new-password" required minLength={8} value={newPassword} onChange={(event) => setNext(event.target.value)} />
          </label>
          <label className="field"><span>{t("changePassword.confirm")}</span>
            <input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "…" : t("changePassword.submit")}</button>
          <p className="form-note">{t("changePassword.note")}</p>
        </form>
      </div>
    </section>
  </>;
}

/** agent 凭据：P9-4b 的落点（边界 9）。本阶段占位——一个空 tab 也不该是空白页。 */
function CredentialsTab() {
  const { t } = useTranslation();
  return <section className="panel">
    <div className="panel-head"><strong>{t("me.tabCredentials")}</strong></div>
    <div className="panel-body"><Empty title={t("me.credentialsEmptyTitle")} hint={t("me.credentialsEmptyHint")} /></div>
  </section>;
}

/**
 * MCP Token tab（能力面自项目侧 McpPage 上移，边界 7）：签发 / 吊销归「本人」，scope
 * 归绑定。
 *
 * 与项目侧的分工：这里回答「我有哪些钥匙、分别开了哪几扇门」；项目侧
 * （`/projects/:id/mcp`）回答「谁的钥匙开到了我这扇门上」。同一个 Token 在两个视角里
 * 各出现一次，任一视角的动作都即时生效。
 *
 * 绑定的三条纪律（边界 2/3/4）在文案里要说清，否则「绑了却读不动」会变成一个查不到
 * 原因的问题：绑定不是授权、是过滤器——调用时还要按 owner 重跑一次项目权限。
 */
function McpTokensTab() {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<McpToken[]>();
  const [projects, setProjects] = useState<BindableProject[]>([]);
  const [failed, setFailed] = useState(false);

  /* ── 签发弹窗：表单段可取消，明文段必须显式「我已保存」才能关（一次性凭据不能被
     顺手点掉——同旧项目侧 McpPage 的两段式）。 */
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueName, setIssueName] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<string>();

  /* ── 绑定弹窗：token × 项目 × scope。选已绑定的项目 = 改 scope（服务端 upsert）。 */
  const [bindToken, setBindToken] = useState<McpToken>();
  const [bindProjectId, setBindProjectId] = useState<string>();
  const [bindWrite, setBindWrite] = useState(false);
  const [bindExecute, setBindExecute] = useState(false);
  const [binding, setBinding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [tokenList, bindable] = await Promise.all([api.meMcpTokens(), api.bindableProjects()]);
      setTokens(tokenList);
      setProjects(bindable.projects);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const bindProject = projects.find((each) => each.projectId === bindProjectId);
  /* 选中的项目已经在绑定集里 = 这次提交改的是那条绑定的 scope（服务端 upsert），
     不是新增一条——按钮文案与提示都跟着换。 */
  const bindOverwrite = Boolean(bindProjectId && bindToken?.bindings.some((binding) => binding.projectId === bindProjectId));
  /* 角色上限决定勾选框能不能点亮：viewer 只到 read（边界 3）。服务端仍会重判——
     这里禁用只是别让用户点了才知道不行。 */
  const scopeAllowed = (scope: McpScope) => (bindProject?.maxScope ?? ["read"]).includes(scope);

  async function issue() {
    if (!issueName.trim()) { message.error(t("mcp.tokenNameRequired")); return; }
    setIssuing(true);
    try {
      const created = await api.createMeMcpToken({ name: issueName.trim() });
      setIssued(created.token);
    } catch (error) {
      message.error(apiMessage(error) ?? t("mcp.tokenCreateFailed"));
    } finally { setIssuing(false); }
  }

  /** 明文段唯一的出口：清状态（明文随之消失）并刷新列表。 */
  function closeIssue() {
    setIssueOpen(false);
    setIssued(undefined);
    setIssueName("");
    void load();
  }

  function openBind(token: McpToken, projectId?: string, scope?: McpScope[]) {
    setBindToken(token);
    setBindProjectId(projectId);
    setBindWrite(Boolean(scope?.includes("write")));
    setBindExecute(Boolean(scope?.includes("execute")));
  }

  async function submitBind() {
    if (!bindToken || !bindProjectId) return;
    setBinding(true);
    try {
      const scope: McpScope[] = ["read", ...(bindWrite ? ["write" as const] : []), ...(bindExecute ? ["execute" as const] : [])];
      await api.bindMeMcpToken(bindToken.id, { projectId: bindProjectId, scope });
      message.success(t("me.bound"));
      setBindToken(undefined);
      await load();
    } catch (error) {
      message.error(apiMessage(error) ?? t("me.bindFailed"));
    } finally { setBinding(false); }
  }

  function unbind(token: McpToken, projectId: string, projectName: string) {
    Modal.confirm({
      title: t("me.unbindTitle", { project: projectName }),
      /* 解绑同样即时生效：下一次 tools/call 就按新的绑定集判。 */
      content: t("me.unbindHint"),
      okText: t("me.unbind"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.unbindMeMcpToken(token.id, projectId); message.success(t("me.unbound")); await load(); }
        catch (error) { message.error(apiMessage(error) ?? t("me.unbindFailed")); }
      },
    });
  }

  function revoke(token: McpToken) {
    Modal.confirm({
      title: t("mcp.tokenRevokeTitle", { name: token.name }),
      content: t("mcp.tokenRevokeHint"),
      okText: t("mcp.tokenRevoke"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.revokeMeMcpToken(token.id); message.success(t("mcp.tokenRevoked")); await load(); }
        catch (error) { message.error(apiMessage(error) ?? t("mcp.tokenRevokeFailed")); }
      },
    });
  }

  const endpoint = mcpEndpointUrl();
  /* 绑定的项目名走本人可见项目集；绑定到自己已不在的项目（被移出后残留的绑定）
     解析不出名字——显示短 id 而不是空白，那行本身就是「该清理了」的信号。 */
  const projectName = (projectId: string) => projects.find((each) => each.projectId === projectId)?.name ?? projectId.slice(0, 8);

  if (failed) return <section className="panel"><div className="panel-body"><Empty
    title={t("mcp.loadFailed")}
    hint={t("mcp.loadFailedHint")}
    action={<button className="btn" onClick={() => void load()}>{t("action.retry")}</button>}
  /></div></section>;

  return <>
    <section className="panel">
      <div className="panel-head"><strong>{t("mcp.service")}</strong></div>
      <div className="panel-body">
        <p className="form-note">{t("me.mcpEndpointHint")}</p>
        <div className="code-block">
          <div className="code-block-head">
            <span className="label">{t("mcp.endpoint")}</span>
            <CopyButton value={() => endpoint} />
          </div>
          <pre className="code">{endpoint}</pre>
        </div>
      </div>
    </section>

    <section className="panel">
      <div className="panel-head">
        <strong>{t("mcp.tokens")}</strong>
        <button className="btn btn-primary btn-with-icon" onClick={() => setIssueOpen(true)}>
          <Plus size={14} />{t("mcp.tokenCreate")}
        </button>
      </div>
      <div className="panel-body">
        <p className="form-note">{t("mcp.tokensHint")}</p>
        {tokens === undefined ? <p className="muted">{t("common.loading")}</p>
          : tokens.length === 0 ? <Empty title={t("mcp.tokensEmpty")} hint={t("mcp.tokensEmptyHint")} />
            : <div className="me-token-list">{tokens.map((token) => <article className="me-token" key={token.id}>
              <div className="me-token-head">
                <div className="me-token-identity">
                  <strong className="truncate">{token.name}</strong>
                  <span className="mono muted">{token.tokenPrefix}…</span>
                </div>
                <span className="mono muted">{token.lastUsedAt ? t("me.lastUsedAt", { time: new Date(token.lastUsedAt).toLocaleString() }) : t("mcp.tokenNeverUsed")}</span>
                <span className="mono muted">{t("me.createdAt", { time: new Date(token.createdAt).toLocaleString() })}</span>
                <div className="row-actions">
                  <button className="btn btn-with-icon" onClick={() => openBind(token)}>
                    <Link2 size={14} />{t("me.bindProject")}
                  </button>
                  <IconButton icon={<Trash2 size={14} />} label={t("mcp.tokenRevoke")} tone="danger" onClick={() => revoke(token)} />
                </div>
              </div>
              {token.bindings.length ? <div className="me-binding-table"><table className="grid">
                <thead><tr>
                  <th>{t("me.project")}</th>
                  <th>{t("mcp.tokenScope")}</th>
                  <th className="mono">{t("me.boundAt")}</th>
                  <th className="col-actions" />
                </tr></thead>
                <tbody>{token.bindings.map((binding) => <tr key={binding.projectId}>
                  <td className="truncate"><strong>{projectName(binding.projectId)}</strong></td>
                  <td><span className="tag-inline">{binding.scope.map((scope) => <span key={scope} className="chip">{scope}</span>)}</span></td>
                  <td className="mono muted">{binding.boundAt ? new Date(binding.boundAt).toLocaleString() : "—"}</td>
                  <td className="col-actions"><div className="row-actions">
                    <button className="btn" onClick={() => openBind(token, binding.projectId, binding.scope)}>{t("me.scopeEdit")}</button>
                    <button className="btn danger" onClick={() => unbind(token, binding.projectId, projectName(binding.projectId))}>{t("me.unbind")}</button>
                  </div></td>
                </tr>)}</tbody>
              </table></div> : <p className="form-note">{t("me.notBound")}</p>}
            </article>)}</div>}
      </div>
    </section>

    {/* 签发弹窗：request 里没有 scope——签发本身不产生任何项目级权限，新 Token 一行
        绑定都没有，任何 tools/call 都会因未绑定被拒。 */}
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
        <div className="code-block" style={{ marginTop: "var(--s4)" }}>
          <div className="code-block-head">
            <span className="label">{t("mcp.issuePlaintext")}</span>
            <CopyButton value={() => issued} />
          </div>
          <pre className="code">{issued}</pre>
        </div>
        <p className="form-note">{t("mcp.issuePlaintextOnce")}</p>
        {/* 签发完的下一步是绑定：把下一动作指出来，否则新 Token 看起来「什么都没法做」。 */}
        <p className="form-note">{t("me.issueNextBind")}</p>
      </> : <>
        <label className="field" style={{ marginTop: "var(--s4)" }}>
          <span>{t("mcp.tokenName")}</span>
          <input className="input" value={issueName} onChange={(event) => setIssueName(event.target.value)} placeholder={t("mcp.tokenNamePlaceholder")} />
        </label>
        <p className="form-note">{t("me.issueHint")}</p>
      </>}
    </Modal>

    {/* 绑定弹窗：项目选择器 + scope 勾选（read 恒在；write / execute 受本人在该项目
        的角色上限约束）。 */}
    <Modal
      open={Boolean(bindToken)}
      title={bindToken ? t("me.bindTitle", { name: bindToken.name }) : ""}
      okText={bindOverwrite ? t("me.scopeEdit") : t("me.bind")}
      cancelText={t("action.cancel")}
      confirmLoading={binding}
      okButtonProps={{ disabled: !bindProjectId }}
      onOk={() => void submitBind()}
      onCancel={() => setBindToken(undefined)}
    >
      <label className="field" style={{ marginTop: "var(--s4)" }}>
        <span>{t("me.project")}</span>
        <Select
          showSearch
          optionFilterProp="label"
          value={bindProjectId}
          onChange={(value) => {
            setBindProjectId(value);
            /* 选中的项目**已经绑过**就把它的当前 scope 带出来（提交即改权限，服务端
               upsert）。不带出来会有两个问题：「这把 Token 本来有 write / execute」
               在弹窗里看不见（用户看到的就是「读起来有权限、点绑定啥也没有」），
               而且提交时会把已有的写权限静默降级成只读。 */
            const existing = bindToken?.bindings.find((binding) => binding.projectId === value);
            const next = projects.find((project) => project.projectId === value);
            const allowed = (scope: McpScope) => Boolean(next?.maxScope.includes(scope));
            setBindWrite(Boolean(existing?.scope.includes("write")) && allowed("write"));
            setBindExecute(Boolean(existing?.scope.includes("execute")) && allowed("execute"));
          }}
          placeholder={t("me.selectProject")}
          options={projects.map((project) => ({ value: project.projectId, label: project.name }))}
          style={{ width: "100%" }}
        />
      </label>
      {/* 当前绑定集放在弹窗里：绑定是「给这把钥匙多开一扇门」的动作，做之前得看得见
          它现在开着哪几扇、各到什么程度。 */}
      <p className="form-note">{bindToken?.bindings.length
        ? t("me.currentBindings", { list: bindToken.bindings.map((binding) => `${projectName(binding.projectId)}（${binding.scope.join("/")}）`).join(" · ") })
        : t("me.currentBindingsNone")}</p>
      <div style={{ display: "grid", gap: "var(--s2)", marginTop: "var(--s4)" }}>
        <span className="label">{t("mcp.issueScope")}</span>
        <label className="check-field" title={t("mcp.issueScopeReadHint")}>
          <input type="checkbox" checked disabled />
          {t("mcp.issueScopeRead")}
        </label>
        <label className="check-field" title={bindProject && !scopeAllowed("write") ? t("me.scopeBeyondRole", { role: bindProject.role }) : undefined}>
          <input type="checkbox" checked={bindWrite} disabled={!bindProject || !scopeAllowed("write")} onChange={(event) => setBindWrite(event.target.checked)} />
          {t("mcp.issueScopeWrite")}
        </label>
        <label className="check-field" title={bindProject && !scopeAllowed("execute") ? t("me.scopeBeyondRole", { role: bindProject.role }) : undefined}>
          <input type="checkbox" checked={bindExecute} disabled={!bindProject || !scopeAllowed("execute")} onChange={(event) => setBindExecute(event.target.checked)} />
          {t("mcp.issueScopeExecute")}
        </label>
      </div>
      {/* 边界 3 必须在绑定前说清：绑定是过滤器不是授权，调用时还会按本人权限重判。 */}
      <p className="form-note">{t("me.bindHint")}</p>
      {/* 未选项目时写 / 执行是灰的：说清原因，否则会被读成「这把 Token 没有那两档权限」
          （它只是此刻还没告诉你在哪个项目、以什么角色去开）。 */}
      {bindProject
        ? <p className="form-note">{t("me.scopeRoleHint", { role: bindProject.role })}</p>
        : <p className="form-note">{t("me.scopePickProject")}</p>}
      {bindOverwrite && <p className="form-note">{t("me.bindingOverwriteHint")}</p>}
    </Modal>
  </>;
}
