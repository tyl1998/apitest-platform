import { useEffect, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { api, type GitCredential, type IngestToken, type Repository } from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import { useProjectStore } from "../stores/projectStore";
import { Empty, PageToolbar } from "../ui";
import { CopyButton } from "./CopyButton";
import { GitCredentialModal } from "./GitCredentialModal";
import { IconButton } from "./IconButton";
import { RepoPageHead, RepoTabs } from "./RepoShell";
import { apiMessage } from "./DataSourceList";

/**
 * 凭据（P4.5-14，取代原「接入指引」页；计划 8.11 的 A 类）。
 *
 * 这一页有**两块凭据，服务对象不同**，标题上必须写清，否则会被读成重复功能：
 * - **上报 Token** 给 SDK：跑在用户的 CI 或本地，把结果 POST 到 `/ingest`。三步接入说明
 *   （装包 / 两个环境变量 / 原样跑 pytest）就在这一块里——它本来就是在讲那个 token 怎么用。
 * - **Git 凭据** 给平台自己的 Runner：clone 用户仓库。项目级命名池，多个任务共用一把 key。
 *
 * 「零改动接入」是硬指标（边界 4），所以三步说明的形状本身就是那个承诺：如果它需要写
 * 第四步，说明 SDK 那边做错了。
 *
 * 仓库连通状态也在这一页：它是「上报到底通了没有」的答案，与上报 Token 同一件事。
 */

/** SDK 的 base URL：平台 API 的 `/api/v1` 前缀不属于上报入口（`POST /ingest` 在根上）。 */
function ingestBaseUrl() {
  const base = import.meta.env.VITE_API_BASE_URL ?? `${window.location.origin.replace(/:\d+$/, ":3000")}/api/v1`;
  return String(base).replace(/\/api\/v1\/?$/, "");
}

export function RepoCredentials() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  /* viewer：Token 签发/吊销、凭据增删全藏（P6-4）；接入三步说明与状态照读。 */
  const canWrite = useCanWrite();

  const [repository, setRepository] = useState<Repository | null>();
  const [tokens, setTokens] = useState<IngestToken[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [creating, setCreating] = useState(false);
  /**
   * 刚创建出来的明文。**只在这一次响应里存在**（边界 17），所以它留在内存里直到用户离开
   * 这一页——刷新之后就再也拿不到了，这一点必须在界面上说清，否则丢了会被当成 bug。
   */
  const [issued, setIssued] = useState<{ id: string; token: string }>();
  const [branch, setBranch] = useState("");

  const [credentials, setCredentials] = useState<GitCredential[]>([]);
  /* 弹窗目标（共享组件 `GitCredentialModal`，表单状态在那边）：`"new"` 或待编辑的凭据行。 */
  const [credentialEditing, setCredentialEditing] = useState<GitCredential | "new">();

  async function load() {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    try {
      const [repo, tokenList, credentialList] = await Promise.all([
        api.repository(projectId),
        api.ingestTokens(projectId),
        api.gitCredentials(projectId),
      ]);
      setRepository(repo);
      setBranch(repo?.trackingBranch ?? "main");
      setTokens(tokenList);
      setCredentials(credentialList);
    } catch { message.error(t("repoCases.loadFailed")); }
  }

  useEffect(() => { void load(); }, [projectId, loadedProjectId, projectLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  async function createToken() {
    if (!projectId || !tokenName.trim()) { message.error(t("repoCases.tokenNameRequired")); return; }
    setCreating(true);
    try {
      const created = await api.createIngestToken(projectId, tokenName.trim());
      setIssued({ id: created.id, token: created.token });
      setTokenName("");
      await load();
    } catch { message.error(t("repoCases.tokenCreateFailed")); }
    finally { setCreating(false); }
  }

  function revokeToken(token: IngestToken) {
    if (!projectId) return;
    Modal.confirm({
      title: t("repoCases.tokenRevokeTitle", { name: token.name }),
      content: t("repoCases.tokenRevokeHint"),
      okText: t("repoCases.tokenRevoke"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.revokeIngestToken(projectId, token.id); await load(); }
        catch { message.error(t("repoCases.tokenRevokeFailed")); }
      },
    });
  }

  async function saveBranch() {
    if (!projectId || !branch.trim()) return;
    try {
      const updated = await api.updateRepository(projectId, { trackingBranch: branch.trim() });
      setRepository({ ...updated, activeCaseCount: repository?.activeCaseCount ?? 0, ingestRunCount: repository?.ingestRunCount ?? 0 });
      message.success(t("repoCases.branchSaved"));
    } catch { message.error(t("repoCases.branchSaveFailed")); }
  }

  function unbind() {
    if (!projectId) return;
    Modal.confirm({
      title: t("repoCases.unbindTitle"),
      /* 说清「保留历史」：解绑之后用例与上报记录还在（边界 18），不写明会让人以为这是
         一次删除而不敢点。CI 任务也不受影响——它自带 Git 地址（P4.5-14）。 */
      content: t("repoCases.unbindHint"),
      okText: t("repoCases.unbind"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.unbindRepository(projectId); await load(); message.success(t("repoCases.unbound")); }
        catch { message.error(t("repoCases.unbindFailed")); }
      },
    });
  }

  function removeCredential(credential: GitCredential) {
    if (!projectId) return;
    Modal.confirm({
      title: t("repoCases.credentialDeleteTitle", { name: credential.name }),
      /* 被任务引用时服务端回 409 并附任务清单（没有强删）：这里先把 taskCount 说出来，
         让「点了会被拒」这件事在点之前就可见。 */
      content: credential.taskCount
        ? t("repoCases.credentialInUse", { count: credential.taskCount })
        : t("repoCases.credentialDeleteHint"),
      okText: t("action.delete"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.deleteGitCredential(projectId, credential.id); await load(); message.success(t("repoCases.credentialDeleted")); }
        catch (error) { message.error(apiMessage(error) ?? t("repoCases.credentialDeleteFailed")); }
      },
    });
  }

  const url = ingestBaseUrl();
  const steps: { code: string; note?: string }[] = [
    { code: "pip install apitrack-sdk" },
    { code: `APITRACK_URL=${url}\nAPITRACK_TOKEN=${issued?.token ?? "<在下面创建>"}`, note: t("repoCases.stepEnvNote") },
    { code: "pytest", note: t("repoCases.stepRunNote") },
  ];

  return <main className="content content-split">
    <PageToolbar>
    <RepoPageHead title={t("repoCases.credentialsTitle")} hint={t("repoCases.credentialsHint")} />
    <RepoTabs active="credentials" />
    </PageToolbar>

    <div className="list-card">
    <div className="list-scroll">
    {/* ── 一、Git 拉取凭据（给平台的 Runner） ─────────────────────────────── */}
    <section className="panel">
      <div className="panel-head">
        <strong>{t("repoCases.gitCredentials")}</strong>
        {canWrite && <button className="btn btn-with-icon" onClick={() => setCredentialEditing("new")}>
          <Plus size={14} />{t("repoCases.credentialCreate")}
        </button>}
      </div>
      <div className="panel-body">
        <p className="form-note">{t("repoCases.gitCredentialsHint")}</p>
        {credentials.length ? <table className="grid">
          <thead><tr>
            <th>{t("repoCases.credentialName")}</th>
            <th>{t("repoCases.credentialMethod")}</th>
            <th className="col-num">{t("repoCases.credentialTasks")}</th>
            <th>{t("repoCases.credentialUpdatedAt")}</th>
            <th className="col-actions" />
          </tr></thead>
          <tbody>
            {credentials.map((credential) => <tr key={credential.id} data-clickable="" onClick={() => setCredentialEditing(credential)}>
              <td><strong className="truncate">{credential.name}</strong></td>
              <td>{t(`repoCases.credentialMethodValue.${credential.method}`)}</td>
              <td className="col-num mono">{credential.taskCount ?? 0}</td>
              <td className="mono muted">{new Date(credential.credentialUpdatedAt).toLocaleString()}</td>
              <td className="col-actions" onClick={(event) => event.stopPropagation()}>
                {canWrite && <div className="row-actions">
                  <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => removeCredential(credential)} />
                </div>}
              </td>
            </tr>)}
          </tbody>
        </table> : <Empty title={t("repoCases.credentialsEmpty")} hint={t("repoCases.credentialsEmptyHint")} />}
      </div>
    </section>

    {/* ── 二、上报 Token（给 SDK）+ 三步接入 ──────────────────────────────── */}
    <section className="panel">
      <div className="panel-head"><strong>{t("repoCases.tokens")}</strong></div>
      <div className="panel-body">
        <p className="form-note">{t("repoCases.tokensPurpose")}</p>
        {/* 同 commit 折行口径（迁移 045）：接入方最常见的疑问是「正式/调试两个任务
            一起报会怎样」——答案在这一组里，凭据页是它该在的地方（Token 的语义页）。
            第三条里的入口名与 CiTaskEditor 的高级设置区块保持一致（勾选控件在
            ciTasks.sdkIngest，位于「高级设置」折叠区内）。 */}
        <ul className="usage-list">
          <li>{t("repoCases.tokensDedup")}</li>
          <li>{t("repoCases.tokensShared")}</li>
          <li>{t("repoCases.tokensToggle")}</li>
        </ul>
        {canWrite && <div className="filter-bar">
          <input
            className="input"
            value={tokenName}
            onChange={(event) => setTokenName(event.target.value)}
            placeholder={t("repoCases.tokenNamePlaceholder")}
            style={{ width: 240 }}
          />
          <button className="btn btn-primary btn-with-icon" disabled={creating} onClick={() => void createToken()}>
            <Plus size={14} />{t("repoCases.createToken")}
          </button>
        </div>}

        {issued && <div className="code-block" style={{ marginBottom: "var(--s4)" }}>
          <div className="code-block-head">
            <span className="label">{t("repoCases.tokenPlaintext")}</span>
            <CopyButton value={() => issued.token} />
          </div>
          <pre className="code">{issued.token}</pre>
          <small className="form-note">{t("repoCases.tokenPlaintextOnce")}</small>
        </div>}

        {tokens.length ? <table className="grid">
          <thead><tr>
            <th>{t("repoCases.tokenName")}</th>
            <th className="mono">{t("repoCases.tokenPrefix")}</th>
            <th>{t("repoCases.tokenLastUsed")}</th>
            <th className="col-status">{t("repoCases.status")}</th>
            <th className="col-actions" />
          </tr></thead>
          <tbody>
            {tokens.map((token) => <tr key={token.id} data-removed={token.revokedAt ? "" : undefined}>
              <td><strong className="truncate">{token.name}</strong></td>
              <td className="mono muted">{token.tokenPrefix}…</td>
              <td className="mono muted">{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : t("repoCases.tokenNeverUsed")}</td>
              <td className="col-status">
                {token.revokedAt
                  ? <span className="chip chip-warn">{t("repoCases.tokenRevoked")}</span>
                  : <span className="status" data-status="pass"><span className="status-mark" />{t("repoCases.statusActive")}</span>}
              </td>
              <td className="col-actions" onClick={(event) => event.stopPropagation()}>
                {!token.revokedAt && canWrite && <div className="row-actions">
                  <IconButton icon={<Trash2 size={14} />} label={t("repoCases.tokenRevoke")} tone="danger" onClick={() => revokeToken(token)} />
                </div>}
              </td>
            </tr>)}
          </tbody>
        </table> : <Empty title={t("repoCases.tokensEmpty")} hint={t("repoCases.tokensEmptyHint")} />}

        <h3 className="subhead">{t("repoCases.threeSteps")}</h3>
        {steps.map((step, index) => <div key={index} className="code-block" style={{ marginBottom: "var(--s4)" }}>
          <div className="code-block-head">
            <span className="label">{t("repoCases.step", { index: index + 1 })}</span>
            <CopyButton value={() => step.code} />
          </div>
          <pre className="code">{step.code}</pre>
          {step.note && <small className="form-note">{step.note}</small>}
        </div>)}
        <p className="form-note">{t("repoCases.zeroChangeNote")}</p>
        {/* dry-run 是「先看一眼再开」的那个前提：让人敢装一个拦截全部 HTTP 流量的包。 */}
        <div className="code-block">
          <div className="code-block-head">
            <span className="label">{t("repoCases.dryRunLabel")}</span>
            <CopyButton value={() => "pytest --apitrack-dry-run"} />
          </div>
          <pre className="code">pytest --apitrack-dry-run</pre>
          <small className="form-note">{t("repoCases.dryRunNote")}</small>
        </div>
      </div>
    </section>

    {/* ── 三、上报连通状态 ─────────────────────────────────────────────────── */}
    <section className="panel">
      <div className="panel-head"><strong>{t("repoCases.connectionState")}</strong></div>
      <div className="panel-body">
        {repository === undefined ? <p className="muted">{t("common.loading")}</p>
          : repository === null ? <Empty title={t("repoCases.notBoundTitle")} hint={t("repoCases.notBoundHint")} />
          : <>
            <dl className="definition-grid">
              <div><dt>{t("repoCases.gitUrl")}</dt><dd className="mono truncate" title={repository.gitUrl}>{repository.gitUrl}</dd></div>
              <div><dt>{t("repoCases.status")}</dt><dd>{repository.status === "active" ? t("repoCases.statusActive") : t("repoCases.statusUnbound")}</dd></div>
              <div><dt>{t("repoCases.lastIngestAt")}</dt><dd className="mono">{repository.lastIngestAt ? new Date(repository.lastIngestAt).toLocaleString() : "—"}</dd></div>
              <div><dt>{t("repoCases.activeCases")}</dt><dd className="mono">{repository.activeCaseCount}</dd></div>
              <div><dt>{t("repoCases.runTotal")}</dt><dd className="mono">{repository.ingestRunCount}</dd></div>
              <div><dt>{t("repoCases.firstSeenCommit")}</dt><dd className="mono truncate">{repository.firstSeenCommit ?? "—"}</dd></div>
            </dl>
            <div className="form-grid" style={{ marginTop: "var(--s4)" }}>
              <label className="field">
                <span>{t("repoCases.trackingBranch")}</span>
                <input className="input mono" value={branch} onChange={(event) => setBranch(event.target.value)} onBlur={() => void saveBranch()} />
              </label>
            </div>
            {/* 这一句是全页最重要的一句：跟踪分支是删除对账的第二道闸门（边界 11）。 */}
            <p className="form-note">{t("repoCases.trackingBranchHint")}</p>
            <div className="drawer-actions" style={{ marginTop: "var(--s4)" }}>
              <button className="btn danger" onClick={unbind}>{t("repoCases.unbind")}</button>
            </div>
          </>}
      </div>
    </section>
    </div>

    {/* 凭据弹窗：共享组件（任务编辑页空池时就地创建用的就是同一个）。 */}
    {projectId && <GitCredentialModal
      projectId={projectId}
      editing={credentialEditing}
      onClose={() => setCredentialEditing(undefined)}
      onSaved={() => load()}
    />}
    </div>
  </main>;
}
