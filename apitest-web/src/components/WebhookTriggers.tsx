import { useCallback, useEffect, useState } from "react";
import { Drawer, Modal, Select, message } from "antd";
import { useNavigate, useParams } from "react-router-dom";
import { Copy, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type CiTask, type Environment, type FlowSummary, type SuiteSummary, type WebhookTargetType, type WebhookTrigger, type WebhookTriggerInput, WEBHOOK_TARGET_TYPES } from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import { Empty, PageToolbar, type RunStatus } from "../ui";
import { RunStatusTag } from "./RunStatusTag";
import { CopyButton } from "./CopyButton";
import { IconButton } from "./IconButton";
import { OwnerCell } from "./OwnerCell";
import { apiMessage } from "./DataSourceList";

/** webhook 公开触发挂在 API 进程上（`/webhooks/:publicId`），公开地址的源必须跟 API 走
    而不是页面走：双域名部署下页面在 A、API 在 B，拿页面 origin 只会得出本地开发才成立的
    地址。与 Mock（`/mock/:publicId/*`）同一拼法，优先 VITE_API_BASE_URL 剥掉 `/api/v1`。 */
function webhookPublicOrigin(): string {
  const apiBase = import.meta.env.VITE_API_BASE_URL;
  if (apiBase) {
    const stripped = apiBase.replace(/\/api\/v1\/?$/, "").replace(/\/+$/, "");
    if (stripped) return stripped;
  }
  return `${window.location.origin.replace(/:\d+$/, ":3000")}`;
}

/** 公开触发地址（不含签名）。 */
function webhookUrl(publicId: string): string {
  return `${webhookPublicOrigin()}/webhooks/${publicId}`;
}

/**
 * 拼一条**可直接运行**的 bash + curl：HMAC 签名要在发送前算（原始请求体字节参与签名），
 * curl 自己算不了签名，所以用一个 `openssl dgst -sha256 -hmac` 的小段在调用前算好，再带
 * 三个签名头发出。密钥填进这段脚本（创建/轮换时已知），是一次性、可直接粘贴到 CI 里的。
 */
function webhookBashCurl(publicId: string, secret: string, body = "{}"): string {
  const url = webhookUrl(publicId);
  return [
    `SECRET="${secret}"`,
    `URL="${url}"`,
    `BODY='${body}'`,
    ``,
    `# --- 触发执行 ---`,
    `TS=$(date +%s)`,
    `NONCE=$(uuidgen | tr -d '-')`,
    `SIG=$(printf '%s.%s.%s' "$TS" "$NONCE" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')`,
    `curl -sS -X POST "$URL" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "X-Apitest-Timestamp: $TS" \\`,
    `  -H "X-Apitest-Nonce: $NONCE" \\`,
    `  -H "X-Apitest-Signature: $SIG" \\`,
    `  -d "$BODY"`,
    ``,
    `# --- 查询运行状态（GET 无 body，签名原文 = timestamp.nonce.）---`,
    `# RUN_ID="<从触发响应拿到的 id>"`,
    `# TS=$(date +%s)`,
    `# NONCE=$(uuidgen | tr -d '-')`,
    `# SIG=$(printf '%s.%s.' "$TS" "$NONCE" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')`,
    `# curl -sS "$URL/runs/$RUN_ID" \\`,
    `#   -H "X-Apitest-Timestamp: $TS" \\`,
    `#   -H "X-Apitest-Nonce: $NONCE" \\`,
    `#   -H "X-Apitest-Signature: $SIG"`,
  ].join("\n");
}

/** 服务端 run status → UI RunStatusTag 的六值。 */
function toRunStatus(raw: string): RunStatus {
  switch (raw) {
    case "success": return "pass";
    case "failed": case "error": case "aborted": return "fail";
    case "running": return "running";
    case "queued": return "queued";
    case "canceled": return "canceled";
    default: return "skip";
  }
}

/** 最近运行的跳转路径：按 targetType 分流到对应的运行详情页。 */
function runDetailPath(projectId: string, item: WebhookTrigger): string {
  if (!item.lastRunId) return `/projects/${projectId}`;
  if (item.targetType === "ci_task") return `/projects/${projectId}/repo/runs/${item.lastRunId}`;
  if (item.targetType === "suite") return `/projects/${projectId}/suite-reports/${item.lastRunId}`;
  return `/projects/${projectId}/reports/${item.lastRunId}`;
}

const TARGET_LABEL_KEY: Record<WebhookTargetType, string> = {
  flow: "webhooks.targetFlow",
  suite: "webhooks.targetSuite",
  ci_task: "webhooks.targetCiTask",
};

const initial: WebhookTriggerInput = { name: "", targetType: "suite", targetId: "", enabled: true, environmentId: null };

export function WebhookTriggers() {
  const { projectId } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const [items, setItems] = useState<WebhookTrigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<WebhookTrigger | "new">();
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try { setItems(await api.webhookTriggers(projectId)); setFailed(false); }
    catch { setFailed(true); }
    finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  function remove(item: WebhookTrigger) {
    if (!projectId) return;
    Modal.confirm({
      title: t("webhooks.deleteTitle", { name: item.name }),
      content: t("webhooks.deleteHint"),
      okText: t("action.delete"), cancelText: t("action.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        try { await api.deleteWebhookTrigger(projectId, item.id); message.success(t("webhooks.deleted")); await load(); }
        catch (error) { message.error(apiMessage(error) ?? t("webhooks.deleteFailed")); }
      },
    });
  }

  async function copy(item: WebhookTrigger) {
    if (!projectId) return;
    try {
      /* 拉一次密钥明文（项目内可写成员可读），拼出可直接运行的 bash+curl 复制给调用方。 */
      const { secret } = await api.webhookSecret(projectId, item.id);
      void navigator.clipboard.writeText(webhookBashCurl(item.publicId, secret, "{}"));
      message.success(t("webhooks.curlCopied"));
    } catch {
      message.error(t("webhooks.loadFailed"));
    }
  }

  return <main className="content content-split">
    <PageToolbar>
    <div className="page-head">
      <div><h1>{t("webhooks.title")}</h1><p>{t("webhooks.hint")}</p></div>
      {canWrite && <button className="btn btn-primary btn-with-icon" onClick={() => setEditing("new")}><Plus size={15} />{t("webhooks.createTitle")}</button>}
    </div>
    </PageToolbar>

    <div className="list-card">
    {items.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("webhooks.name")}</th>
        <th>{t("webhooks.target")}</th>
        <th>{t("webhooks.enabled")}</th>
        <th>{t("webhooks.publicId")}</th>
        <th>{t("webhooks.lastTriggered")}</th>
        <th>{t("webhooks.lastRun")}</th>
        <th className="col-owner">{t("common.createdBy")}</th>
        <th className="col-owner">{t("common.updatedBy")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {items.map((item) => <tr key={item.id} data-clickable onClick={() => setEditing(item)}>
          <td><strong className="truncate">{item.name}</strong><span className="resource-type mono">{item.enabled ? "enabled" : "disabled"}</span></td>
          <td><span className="chip mono">{t(TARGET_LABEL_KEY[item.targetType])}</span><span className="truncate">{item.targetName ?? "—"}</span></td>
          <td>{item.enabled ? t("common.yes") : t("common.no")}</td>
          <td className="mono truncate" title={`/webhooks/${item.publicId}`}>/webhooks/{item.publicId}</td>
          <td className="mono muted">{item.lastTriggeredAt ? new Date(item.lastTriggeredAt).toLocaleString() : t("webhooks.neverTriggered")}</td>
          <td onClick={(event) => event.stopPropagation()}>
            {item.lastRunId && item.lastRunStatus
              ? <button className="cell-link" onClick={() => navigate(runDetailPath(projectId!, item))}>
                  <RunStatusTag status={toRunStatus(item.lastRunStatus)} />
                </button>
              : <span className="muted">—</span>}
          </td>
          <td className="col-owner mono muted truncate"><OwnerCell kind="created" email={item.createdByEmail} /></td>
          <td className="col-owner mono muted truncate"><OwnerCell kind="updated" email={item.updatedByEmail} createdAt={item.createdAt} updatedAt={item.updatedAt} /></td>
          <td className="col-actions" onClick={(event) => event.stopPropagation()}>
            <div className="row-actions">
              <IconButton icon={<Copy size={14} />} label={t("webhooks.copyCurl")} onClick={() => copy(item)} />
              {canWrite && <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => setEditing(item)} />}
              {canWrite && <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => void remove(item)} />}
            </div>
          </td>
        </tr>)}
      </tbody>
    </table></div> : !loading && <Empty
      title={t("webhooks.emptyTitle")}
      hint={t("webhooks.emptyHint")}
      action={canWrite ? <button className="btn btn-primary" onClick={() => setEditing("new")}>{t("webhooks.createTitle")}</button> : undefined}
    />}
    {failed && <p className="form-error" style={{ padding: "var(--s4)" }}>{t("webhooks.loadFailed")}</p>}
    {projectId && <WebhookTriggerDrawer projectId={projectId} item={editing} onClose={() => setEditing(undefined)} onSaved={async () => { setEditing(undefined); await load(); }} />}
    </div>
  </main>;
}

function WebhookTriggerDrawer({ projectId, item, onClose, onSaved }: { projectId: string; item?: WebhookTrigger | "new"; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const canWrite = useCanWrite();
  const [input, setInput] = useState<WebhookTriggerInput>(initial);
  const [saving, setSaving] = useState(false);
  /* 创建 / 轮换后的一次性明文：显式关闭才清（与 MCP Token / API 密钥同款纪律）。 */
  const [secret, setSecret] = useState<string>();
  const [secretRotated, setSecretRotated] = useState(false);
  const [targets, setTargets] = useState<{ flows: FlowSummary[]; suites: SuiteSummary[]; tasks: CiTask[] }>({ flows: [], suites: [], tasks: [] });
  const [environments, setEnvironments] = useState<Environment[]>([]);
  /* 当前触发器 publicId：新建时创建响应才拿到，编辑时来自 item——复制 curl 需要它。 */
  const [publicId, setPublicId] = useState<string>();

  useEffect(() => {
    if (!item) return;
    if (item === "new") { setInput(initial); setPublicId(undefined); return; }
    setPublicId(item.publicId);
    setInput({
      name: item.name,
      targetType: item.targetType,
      targetId: item.targetId,
      environmentId: item.environmentId ?? null,
      enabled: item.enabled,
    });
  }, [item]);

  /* 目标选择器数据：三个类型各拉一次，选中类型才用对应的那份。失败静默（选择器变空，
     不挡新建入口——目标可以稍后补）。 */
  useEffect(() => {
    if (!item) return;
    void api.flows(projectId).then((flows) => setTargets((current) => ({ ...current, flows }))).catch(() => {});
    void api.testSuites(projectId, { pageSize: 200 }).then((page) => setTargets((current) => ({ ...current, suites: page.items }))).catch(() => {});
    void api.ciTasks(projectId, 1, 200).then((page) => setTargets((current) => ({ ...current, tasks: page.items }))).catch(() => {});
    void api.environments(projectId).then(setEnvironments).catch(() => {});
  }, [projectId, item]);

  function patch<K extends keyof WebhookTriggerInput>(key: K, value: WebhookTriggerInput[K]) {
    setInput((current) => ({ ...current, [key]: value }));
  }

  const targetOptions = input.targetType === "flow" ? targets.flows.map((flow) => ({ value: flow.id, label: flow.name }))
    : input.targetType === "suite" ? targets.suites.map((suite) => ({ value: suite.id, label: suite.name }))
    : targets.tasks.map((task) => ({ value: task.id, label: task.name }));

  async function save() {
    if (!input.name?.trim()) { message.error(t("webhooks.nameRequired")); return; }
    if (!input.targetId) { message.error(t("webhooks.targetRequired")); return; }
    setSaving(true);
    try {
      if (item === "new") {
        const created = await api.createWebhookTrigger(projectId, input);
        setPublicId(created.publicId);
        setSecret(created.secret); setSecretRotated(false);
      } else if (item) {
        await api.updateWebhookTrigger(projectId, item.id, input);
        message.success(t("webhooks.saved"));
        await onSaved();
      }
    } catch (error) { message.error(apiMessage(error) ?? t("webhooks.saveFailed")); }
    finally { setSaving(false); }
  }

  function rotate() {
    if (!item || item === "new") return;
    Modal.confirm({
      title: t("webhooks.rotateSecret"),
      content: t("webhooks.rotateConfirm"),
      okText: t("webhooks.rotateSecret"), cancelText: t("action.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const result = await api.rotateWebhookSecret(projectId, item.id);
          setSecret(result.secret); setSecretRotated(true);
          message.success(t("webhooks.rotated"));
        } catch (error) { message.error(apiMessage(error) ?? t("webhooks.saveFailed")); }
      },
    });
  }

  return <>
    <Drawer
      title={item === "new" ? t("webhooks.createTitle") : t("webhooks.editTitle")}
      open={Boolean(item)}
      onClose={onClose}
      width={520}
      footer={<div className="drawer-actions">
        <button className="btn" onClick={onClose}>{t("action.cancel")}</button>
        {canWrite && <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? `${t("common.loading")}…` : t("action.save")}</button>}
      </div>}
    >
      <div className="form-grid">
        <label className="field field-wide"><span>{t("webhooks.name")}</span>
          <input autoFocus className="input" value={input.name ?? ""} onChange={(event) => patch("name", event.target.value)} placeholder={t("webhooks.namePlaceholder")} />
        </label>
        <label className="field"><span>{t("webhooks.targetType")}</span>
          <Select value={input.targetType} onChange={(value) => patch("targetType", value as WebhookTargetType)} options={WEBHOOK_TARGET_TYPES.map((value) => ({ value, label: t(TARGET_LABEL_KEY[value]) }))} style={{ width: "100%" }} />
        </label>
        <label className="field"><span>{t("webhooks.target")}</span>
          <Select value={input.targetId || undefined} placeholder={t("webhooks.targetRequired")} onChange={(value) => patch("targetId", value as string)} options={targetOptions} showSearch optionFilterProp="label" style={{ width: "100%" }} />
        </label>
        {input.targetType !== "ci_task" && <label className="field field-wide"><span>{t("webhooks.envOverride")}</span>
          <Select value={input.environmentId ?? undefined} allowClear placeholder={t("webhooks.envNone")} onChange={(value) => patch("environmentId", value ?? null)} options={environments.map((env) => ({ value: env.id, label: env.name }))} style={{ width: "100%" }} />
        </label>}
        <label className="check-field field-wide"><input type="checkbox" checked={input.enabled ?? true} onChange={(event) => patch("enabled", event.target.checked)} />{t("webhooks.enabled")}</label>
      </div>
      <p className="form-note">{t("webhooks.callHint")}</p>
      {canWrite && item && item !== "new" && <button className="btn btn-with-icon" onClick={rotate}><RefreshCw size={14} />{t("webhooks.rotateSecret")}</button>}
    </Drawer>

    {/* 一次性明文：创建 / 轮换后展示一次（同 MCP Token / API 密钥纪律，不能顺手点掉）。 */}
    <Modal
      open={Boolean(secret)}
      title={secretRotated ? t("webhooks.rotated") : t("webhooks.secret")}
      closable={false}
      maskClosable={false}
      keyboard={false}
      cancelButtonProps={{ style: { display: "none" } }}
      onOk={() => { setSecret(undefined); void onSaved(); }}
      footer={<div className="drawer-actions">
        {publicId && secret && <button className="btn btn-with-icon" onClick={() => { void navigator.clipboard.writeText(webhookBashCurl(publicId, secret)); message.success(t("webhooks.curlCopied")); }}><Copy size={14} />{t("webhooks.copyCurl")}</button>}
        <button className="btn btn-primary" onClick={() => { setSecret(undefined); void onSaved(); }}>{t("webhooks.secretSaved")}</button>
      </div>}
    >
      <p className="form-note">{t("webhooks.secretHint")}</p>
      <div className="code-block" style={{ marginTop: "var(--s4)" }}>
        <div className="code-block-head">
          <span className="label">{t("webhooks.secret")}</span>
          {secret && <CopyButton value={() => secret} />}
        </div>
        <pre className="code">{secret}</pre>
      </div>
    </Modal>
  </>;
}