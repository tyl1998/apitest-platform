import { useEffect, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { api, type IngestToken, type Repository } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { Empty } from "../ui";
import { CopyButton } from "./CopyButton";
import { IconButton } from "./IconButton";
import { RepoPageHead, RepoTabs } from "./RepoShell";

/**
 * 接入指引（P4-8，交互 3.11.2）。
 *
 * **三步，不是四步**（边界 4，已显式撤销原交互文档的那四步）：装包 + 两个环境变量 +
 * 原样跑 `pytest`。原文档第 ② 步的「把请求封装进 http_req.py」等于让用户重写全部请求
 * 代码；第 ④ 步的「跑 apitest-run」在 pytest 场景下是多余的——插件靠 `pytest11` entry
 * point 自动加载，CI 命令一个字都不改。
 *
 * 「零改动接入」是硬指标，所以这一页的形状本身就是那个承诺：如果它需要写第四步，说明
 * SDK 那边做错了。
 */

/** SDK 的 base URL：平台 API 的 `/api/v1` 前缀不属于上报入口（`POST /ingest` 在根上）。 */
function ingestBaseUrl() {
  const base = import.meta.env.VITE_API_BASE_URL ?? `${window.location.origin.replace(/:\d+$/, ":3000")}/api/v1`;
  return String(base).replace(/\/api\/v1\/?$/, "");
}

export function RepoOnboarding() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();

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

  async function load() {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    try {
      const [repo, tokenList] = await Promise.all([api.repository(projectId), api.ingestTokens(projectId)]);
      setRepository(repo);
      setBranch(repo?.trackingBranch ?? "main");
      setTokens(tokenList);
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
         一次删除而不敢点。 */
      content: t("repoCases.unbindHint"),
      okText: t("repoCases.unbind"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.unbindRepository(projectId); await load(); message.success(t("repoCases.unbound")); }
        catch { message.error(t("repoCases.unbindFailed")); }
      },
    });
  }

  const url = ingestBaseUrl();
  const steps: { code: string; note?: string }[] = [
    { code: "pip install apitrack-sdk" },
    { code: `APITRACK_URL=${url}\nAPITRACK_TOKEN=${issued?.token ?? "<在下面创建>"}`, note: t("repoCases.stepEnvNote") },
    { code: "pytest", note: t("repoCases.stepRunNote") },
  ];

  return <main className="content">
    <RepoPageHead title={t("repoCases.onboardingTitle")} hint={t("repoCases.onboardingHint")} />
    <RepoTabs active="onboarding" />

    <section className="panel">
      <div className="panel-head"><strong>{t("repoCases.threeSteps")}</strong></div>
      <div className="panel-body">
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

    <section className="panel">
      <div className="panel-head"><strong>{t("repoCases.tokens")}</strong></div>
      <div className="panel-body">
        <div className="filter-bar">
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
        </div>

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
                {!token.revokedAt && <div className="row-actions">
                  <IconButton icon={<Trash2 size={14} />} label={t("repoCases.tokenRevoke")} tone="danger" onClick={() => revokeToken(token)} />
                </div>}
              </td>
            </tr>)}
          </tbody>
        </table> : <Empty title={t("repoCases.tokensEmpty")} hint={t("repoCases.tokensEmptyHint")} />}
      </div>
    </section>
  </main>;
}
