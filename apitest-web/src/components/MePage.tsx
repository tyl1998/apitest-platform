import { useCallback, useEffect, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Link2, Plus, Trash2 } from "lucide-react";
import { api, type AccessRequest, type ApiKey, type BindableProject, type McpBindingRequest, type McpScope, type McpToken, type MeProfile } from "../api";
import { Empty, Status } from "../ui";
import { apiMessage } from "./DataSourceList";
import { CopyButton } from "./CopyButton";
import { IconButton } from "./IconButton";
import { mcpEndpointUrl } from "./McpPage";

/**
 * 个人中心分区（P13-1：并入站内助手抽屉；2026-09-21 用户反馈去掉「通知」分区）：
 * 原独立 `/me` 页收口进助手卡片。
 *
 * 「我的」这个维度原先散在三处——改密只有助手抽屉里的账号指令、通知查看全部是
 * 一个孤立全局路由、MCP Token 挂在项目侧（P12 起 Token 归人，见 18.0）。P12 把它们
 * 收进 `/me` 独立页；P13-1 再把这一页整体搬进助手抽屉（`AssistantDock` 的 `me`
 * 视图），删除 `/me` 路由——个人中心与助手抽屉不再是两套并存的账号面。
 *
 * 本组件是那四个分区的**受控** tab 面板（tab 状态由抽屉持有，无 URL）：
 *
 * - **基本信息**：`GET /me/profile` 只读账号块。改密表单已删除（P13-1 边界 2）——
 *   改密入口仍在抽屉的 password 视图与「改密码」chip，不再重复出现在基本信息里。
 * - **我的申请**：本人跨项目权限申请与状态（P14）。
 * - **MCP Token**：签发 / 吊销（本人）+ 绑定管理（项目 × scope）。Token 本体没有
 *   scope——`read` / `write` / `execute` 是绑定的属性（边界 2），写权限的爆炸半径
 *   不随绑定数增长。平铺成两张表（Token / 绑定明细），不做逐 Token 卡片。
 * - **agent 凭据**：P9-4b 的落点，本阶段只留占位（真正编辑在抽屉 settings）。
 *
 * **通知**分区已删除（2026-09-21 用户反馈「个人信息内删除通知跳转」）：通知只有
 * 抽屉头的铃铛视图（`.assistant-notifications`，「近 10 条」速览）一个落点，个人
 * 中心不再有第二个入口——同一种东西两个入口只会让人怀疑看到的是两份数据。
 */
export type MeTab = "profile" | "requests" | "mcp" | "credentials";

/** 抽屉内的个人中心面板：tab 受控（抽屉头的「个人中心」钮切它）。tab 条与正文分离
 *  ——tab 条不随正文滚动（`.me-panel` 才是滚动体），长内容（MCP Token）滚到头也
 *  不会把「基本信息 / 我的申请」这两枚切换钮带走（2026-09-21 用户反馈）。 */
export function MeCenter({ tab, onTab }: { tab: MeTab; onTab: (tab: MeTab) => void }) {
  const { t } = useTranslation();
  const tabs: [MeTab, string][] = [
    ["profile", t("me.tabProfile")],
    ["requests", t("me.tabRequests")],
    ["mcp", t("me.tabMcp")],
    ["credentials", t("me.tabCredentials")],
  ];

  return <>
    <div className="tabs" role="tablist">
      {tabs.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={tab === key} className={`tab${tab === key ? " is-active" : ""}`} onClick={() => onTab(key)}>{label}</button>
      ))}
    </div>

    <div className="me-panel">
      {tab === "profile" && <ProfileTab />}
      {tab === "requests" && <MyAccessRequestsTab />}
      {tab === "mcp" && <McpTokensTab />}
      {tab === "credentials" && <CredentialsTab />}
    </div>
  </>;
}

/**
 * 基本信息：只读的账号字段。
 *
 * 只读项走 `definition-grid`（dt/dd，与执行详情同款只读呈现）——禁用态的 input 看着
 * 像「只是暂时不能改」，而 email / 姓名在个人中心**本就不提供**自助修改（边界 10：
 * 自助改名 / 改邮箱不做，管理面已有）。改密表单已随 P13-1 删除（改密入口仍在抽屉的
 * password 视图与「改密码」chip）。
 */
function ProfileTab() {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<MeProfile>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.meProfile()
      .then((value) => { if (alive) setProfile(value); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  return <section className="panel">
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
  </section>;
}

/**
 * 我的申请（P14-2）：本人跨项目提交过的权限申请与当前状态。只读——申请入口在项目的
 * 无权限落地页（那里才是「进不去、想进」的语境）；这里是「我申请过哪些、批了没」的
 * 汇总，行点击深链回对应项目（批准后进得去，未批仍是落地页）。
 */
function MyAccessRequestsTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rows, setRows] = useState<AccessRequest[]>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api.myAccessRequests()
      .then((list) => { if (alive) setRows(list); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (failed) return <section className="panel"><div className="panel-body"><Empty title={t("access.myLoadFailed")} hint={t("access.myLoadFailedHint")} /></div></section>;
  if (rows === undefined) return <section className="panel"><div className="panel-body"><p className="muted">{t("common.loading")}</p></div></section>;
  if (!rows.length) return <section className="panel"><div className="panel-body"><Empty title={t("access.myEmptyTitle")} hint={t("access.myEmptyHint")} /></div></section>;

  return <section className="panel">
    <div className="panel-head"><strong>{t("me.tabRequests")}</strong></div>
    <div className="panel-body">
      <div className="table-scroll"><table className="grid">
        <thead><tr>
          <th>{t("access.myProject")}</th>
          <th>{t("access.reqSuggestedRole")}</th>
          <th className="col-status">{t("access.reqStatus")}</th>
          <th>{t("access.reqWhen")}</th>
        </tr></thead>
        <tbody>
          {rows.map((request) => <tr key={request.id} data-clickable onClick={() => navigate(`/projects/${request.projectId}/trends`)}>
            <td><strong className="truncate">{request.projectName ?? request.projectId.slice(0, 8)}</strong></td>
            <td className="mono">{request.suggestedRole ?? "—"}</td>
            <td className="col-status">
              {request.status === "pending" ? <Status status="queued" label={t("access.statusPending")} />
                : request.status === "approved" ? <Status status="pass" label={t("access.statusApproved")} />
                : <Status status="fail" label={t("access.statusRejected")} />}
            </td>
            <td className="mono muted">{new Date(request.createdAt).toLocaleDateString()}</td>
          </tr>)}
        </tbody>
      </table></div>
    </div>
  </section>;
}

/** agent 凭据：P9-4b 的落点（边界 9）+ 用户级 API 密钥（本人级凭据的自然归属）。 */
function CredentialsTab() {
  const { t } = useTranslation();
  return <>
    <ApiKeyPanel />
    <section className="panel">
      <div className="panel-head"><strong>{t("me.tabCredentials")}</strong></div>
      <div className="panel-body"><Empty title={t("me.credentialsEmptyTitle")} hint={t("me.credentialsEmptyHint")} /></div>
    </section>
  </>;
}

/**
 * 用户级 API 密钥（个人中心设置）：一人一把 AES 密钥，是**调用平台开放 API 的凭据本身**。
 *
 * 第一个消费方是 SQL 快速调用（把 SQL 定义变成免登录、可 curl 的调用地址：地址里的调用
 * 内容用它加密，公开端点用它解密，解得开即视为本人签发）；以后新增的开放 API 复用同一把。
 *
 * 明文只在生成 / 轮换的那一次弹窗里出现一次（与 MCP Token 同款一次性纪律）：这里只展示
 * key_id（公开标识）与时间戳。安全含义要在文案里说清——密钥泄露 = 以本人身份调用这些
 * API 的能力泄露，轮换会让旧密钥加密的所有调用地址立即失效，吊销则让全部地址失效。
 */
function ApiKeyPanel() {
  const { t } = useTranslation();
  const [key, setKey] = useState<ApiKey | null>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 生成 / 轮换后的一次性明文（弹窗展示，显式关闭后清空）。 */
  const [issued, setIssued] = useState<string>();
  const [issuedRotated, setIssuedRotated] = useState(false);

  const load = useCallback(async () => {
    try { setKey(await api.apiKey()); setFailed(false); }
    catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function issue() {
    setBusy(true);
    try {
      const result = await api.issueApiKey();
      setIssued(result.key);
      setIssuedRotated(result.rotated);
    } catch (error) {
      message.error(apiMessage(error) ?? t("apiKey.issueFailed"));
    } finally { setBusy(false); }
  }

  function closeIssued() {
    setIssued(undefined);
    void load();
  }

  function rotate() {
    Modal.confirm({
      title: t("apiKey.rotateTitle"),
      content: t("apiKey.rotateHint"),
      okText: t("apiKey.rotate"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: () => issue(),
    });
  }

  function revoke() {
    Modal.confirm({
      title: t("apiKey.revokeTitle"),
      content: t("apiKey.revokeHint"),
      okText: t("apiKey.revoke"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.revokeApiKey(); message.success(t("apiKey.revoked")); await load(); }
        catch (error) { message.error(apiMessage(error) ?? t("apiKey.revokeFailed")); }
      },
    });
  }

  return <>
    <section className="panel">
      <div className="panel-head">
        <strong>{t("apiKey.title")}</strong>
        {key === null && <button className="btn btn-primary" disabled={busy} onClick={() => void issue()}>{t("apiKey.generate")}</button>}
      </div>
      <div className="panel-body">
        <p className="form-note">{t("apiKey.hint")}</p>
        {failed ? <p className="form-error">{t("me.loadFailed")}</p>
          : key === undefined ? <p className="muted">{t("common.loading")}</p>
            : key === null ? <Empty title={t("apiKey.emptyTitle")} hint={t("apiKey.emptyHint")} />
              : <>
                <dl className="definition-grid">
                  <div><dt>{t("apiKey.keyId")}</dt><dd className="mono">{key.keyId}</dd></div>
                  <div><dt>{t("apiKey.createdAt")}</dt><dd className="mono muted">{new Date(key.createdAt).toLocaleString()}</dd></div>
                  <div><dt>{t("apiKey.rotatedAt")}</dt><dd className="mono muted">{new Date(key.rotatedAt).toLocaleString()}</dd></div>
                </dl>
                <div className="row-actions" style={{ marginTop: "var(--s3)" }}>
                  <button className="btn" disabled={busy} onClick={rotate}>{t("apiKey.rotate")}</button>
                  <button className="btn danger" disabled={busy} onClick={revoke}>{t("apiKey.revoke")}</button>
                </div>
              </>}
      </div>
    </section>

    {/* 一次性明文：显式「我已保存」才能关（同 MCP Token 的两段式，凭据不能被顺手点掉）。 */}
    <Modal
      open={Boolean(issued)}
      title={issuedRotated ? t("apiKey.rotatedTitle") : t("apiKey.generatedTitle")}
      okText={t("apiKey.savedIt")}
      closable={false}
      maskClosable={false}
      keyboard={false}
      cancelButtonProps={{ style: { display: "none" } }}
      onOk={closeIssued}
    >
      <div className="code-block" style={{ marginTop: "var(--s4)" }}>
        <div className="code-block-head">
          <span className="label">{t("apiKey.plaintext")}</span>
          {issued && <CopyButton value={() => issued} />}
        </div>
        <pre className="code">{issued}</pre>
      </div>
      <p className="form-note">{t("apiKey.plaintextOnce")}</p>
    </Modal>
  </>;
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
  /** 本人跨项目的 MCP 绑定许可申请：绑定弹窗按选中项目显示「审批中」态。 */
  const [permRequests, setPermRequests] = useState<McpBindingRequest[]>([]);
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
      const [tokenList, bindable, requests] = await Promise.all([api.meMcpTokens(), api.bindableProjects(), api.myMcpBindingRequests()]);
      setTokens(tokenList);
      setProjects(bindable.projects);
      setPermRequests(requests);
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
  /* 选中项目上我的最近一条许可申请：审批中时在弹窗里说清「不是勾错了，是还没批」。 */
  const bindPermRequest = permRequests.find((request) => request.projectId === bindProjectId);
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
  /* 绑定明细是 Token 的下钻：每行带上是哪把 Token（名字 + 前缀），否则多把 Token
     绑同一个项目时分不清是谁的门。 */
  const bindingRows = (tokens ?? []).flatMap((token) => token.bindings.map((binding) => ({ token, binding })));

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
        {/* 平铺：Token 一张表、绑定一张表（2026-09-21 用户反馈——逐 Token 的卡片外壳
            会在助手抽屉里堆出一层套一层的边框，扫读时先看见框再看见数据）。 */}
        {tokens === undefined ? <p className="muted">{t("common.loading")}</p>
          : tokens.length === 0 ? <Empty title={t("mcp.tokensEmpty")} hint={t("mcp.tokensEmptyHint")} />
            : <div className="table-scroll"><table className="grid">
              <thead><tr>
                <th>{t("mcp.tokens")}</th>
                <th>{t("me.tokenBindings")}</th>
                <th className="mono">{t("mcp.tokenLastUsed")}</th>
                <th className="mono">{t("mcp.tokenCreatedAt")}</th>
                <th className="col-actions" />
              </tr></thead>
              <tbody>{tokens.map((token) => <tr key={token.id}>
                <td className="truncate">
                  <strong>{token.name}</strong>
                  <div className="mono muted">{token.tokenPrefix}…</div>
                </td>
                <td>{token.bindings.length
                  ? <span className="tag-inline">{token.bindings.map((binding) => <span key={binding.projectId} className="chip">{projectName(binding.projectId)}</span>)}</span>
                  : <span className="muted">{t("me.bindingsNone")}</span>}</td>
                <td className="mono muted">{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : t("mcp.tokenNeverUsed")}</td>
                <td className="mono muted">{new Date(token.createdAt).toLocaleString()}</td>
                <td className="col-actions"><div className="row-actions">
                  <button className="btn btn-with-icon" onClick={() => openBind(token)}>
                    <Link2 size={14} />{t("me.bindProject")}
                  </button>
                  <IconButton icon={<Trash2 size={14} />} label={t("mcp.tokenRevoke")} tone="danger" onClick={() => revoke(token)} />
                </div></td>
              </tr>)}</tbody>
            </table></div>}

        {bindingRows.length ? <>
          <h2 className="subhead">{t("me.bindingsTitle")}</h2>
          <div className="table-scroll"><table className="grid">
            <thead><tr>
              <th>{t("mcp.tokenName")}</th>
              <th>{t("me.project")}</th>
              <th>{t("mcp.tokenScope")}</th>
              <th className="mono">{t("me.boundAt")}</th>
              <th className="col-actions" />
            </tr></thead>
            <tbody>{bindingRows.map(({ token, binding }) => <tr key={`${token.id}:${binding.projectId}`}>
              <td className="truncate">
                <strong>{token.name}</strong>
                <div className="mono muted">{token.tokenPrefix}…</div>
              </td>
              <td className="truncate">{projectName(binding.projectId)}</td>
              <td><span className="tag-inline">{binding.scope.map((scope) => <span key={scope} className="chip">{scope}</span>)}</span></td>
              <td className="mono muted">{binding.boundAt ? new Date(binding.boundAt).toLocaleString() : "—"}</td>
              <td className="col-actions"><div className="row-actions">
                <button className="btn" onClick={() => openBind(token, binding.projectId, binding.scope)}>{t("me.scopeEdit")}</button>
                <button className="btn danger" onClick={() => unbind(token, binding.projectId, projectName(binding.projectId))}>{t("me.unbind")}</button>
              </div></td>
            </tr>)}</tbody>
          </table></div>
        </> : tokens !== undefined && tokens.length > 0 && <p className="form-note">{t("me.notBound")}</p>}
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
      {/* 角色上限之外的档位不是死路（2026-09-21）：项目 MCP 页可以申请，管理员批完这里
          就能勾——只说「拿不到」会把唯一的出口藏起来。 */}
      {bindProject && !scopeAllowed("execute") && <p className="form-note">{t("me.scopeBeyondRoleApply")}</p>}
      {bindPermRequest?.status === "pending" && <p className="form-note">{t("mcp.permPending", { scope: bindPermRequest.scope.join(" / ") })}</p>}
      {bindOverwrite && <p className="form-note">{t("me.bindingOverwriteHint")}</p>}
    </Modal>
  </>;
}
