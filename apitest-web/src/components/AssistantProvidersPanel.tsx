import { useEffect, useRef, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Download, Pencil, Plus, Trash2 } from "lucide-react";
import { api, streamAssistantProviderTest, type AssistantCapabilities, type AssistantEvent, type AssistantProvider, type AssistantProtocol, type AssistantUserParam } from "../api";
import { useAuthStore } from "../stores/authStore";
import { Empty, Status } from "../ui";
import { IconButton } from "./IconButton";

/**
 * 助手 provider 管理面（P9-3 起家、P9-4b 通用化 + 页内引导式编辑器）。系统管理员
 * 在这里定义 agent 平台上游的**通用协议**。换平台 = 填一份配置，零开发。
 *
 * 编辑器是**页内分步**的（不做弹窗——这种量级的表单塞弹窗里既看不全也没法对照）：
 * 基础连接 → ① 建会话（前置）→ ② 发消息（核心，含 SSE 事件映射）→ ③ 停止（后置·
 * 可选）→ ④ 删除（后置·可选）→ ⑤ 历史（后置·可选）→ 用户参数。步骤顺序就是调用链
 * 顺序；每个字段带说明
 * 与示例，模板变量的来源（引擎内置 vs {{user.键名}}）在第一步讲清并在各步复述。
 *
 * 凭据不在系统行上（用户级）：测试连接带一组**临时参数**（不落库）——「配置对不对」
 * 由真上游回答，schema 校验说不了。
 */

type TestLine = { kind: AssistantEvent["type"] | "info"; text: string };

/** 编辑器草稿：协议对象摊平成表单字段；body/query/fields 模板用 JSON 文本域。 */
type Draft = {
  name: string;
  enabled: boolean;
  baseUrl: string;
  authHeader: string;
  authValue: string;
  successField: string;
  successValue: string;
  createMethod: string;
  createPath: string;
  createIdPath: string;
  createBodyText: string;
  chatMethod: string;
  chatPath: string;
  chatBodyText: string;
  attachments: boolean;
  hasStop: boolean;
  stopMethod: string;
  stopPath: string;
  hasDelete: boolean;
  deleteMethod: string;
  deletePath: string;
  hasHistory: boolean;
  historyMethod: string;
  historyPath: string;
  historyMessages: string;
  historyQueryText: string;
  historyFieldsText: string;
  sseEventField: string;
  tokenOn: string;
  tokenText: string;
  doneOn: string;
  doneText: string;
  doneSuccess: string;
  errorOn: string;
  errorMessagePath: string;
  toolOn: string;
  toolName: string;
  toolStatus: string;
  toolFallback: string;
  ignoreText: string;
  userParams: AssistantUserParam[];
};

function toDraft(provider?: AssistantProvider): Draft {
  const protocol = provider?.protocol;
  return {
    name: provider?.name ?? "",
    enabled: provider?.enabled ?? true,
    baseUrl: protocol?.baseUrl ?? "",
    authHeader: protocol?.auth?.header ?? "Authorization",
    authValue: protocol?.auth?.value ?? "Bearer {{user.apiKey}}",
    successField: protocol?.successCode?.field ?? "",
    successValue: protocol?.successCode?.value ?? "",
    createMethod: protocol?.createConversation.method ?? "POST",
    createPath: protocol?.createConversation.path ?? "",
    createIdPath: protocol?.createConversation.conversationId ?? "data",
    createBodyText: JSON.stringify(protocol?.createConversation.body ?? {}, null, 2),
    chatMethod: protocol?.chat.method ?? "POST",
    chatPath: protocol?.chat.path ?? "",
    chatBodyText: JSON.stringify(protocol?.chat.body ?? {}, null, 2),
    attachments: protocol?.attachments ?? false,
    hasStop: Boolean(protocol?.stop),
    stopMethod: protocol?.stop?.method ?? "POST",
    stopPath: protocol?.stop?.path ?? "",
    hasDelete: Boolean(protocol?.delete),
    deleteMethod: protocol?.delete?.method ?? "POST",
    deletePath: protocol?.delete?.path ?? "",
    hasHistory: Boolean(protocol?.history),
    historyMethod: protocol?.history?.method ?? "GET",
    historyPath: protocol?.history?.path ?? "",
    historyMessages: protocol?.history?.messages ?? "data",
    historyQueryText: JSON.stringify(protocol?.history?.query ?? {}, null, 2),
    historyFieldsText: JSON.stringify(protocol?.history?.fields ?? { id: "id", role: "role", text: "text", time: "time" }, null, 2),
    sseEventField: protocol?.sse.eventField ?? "eventType",
    tokenOn: protocol?.sse.token?.on ?? "",
    tokenText: protocol?.sse.token?.text ?? "data.text",
    doneOn: protocol?.sse.done?.on ?? "",
    doneText: protocol?.sse.done?.text ?? "data.outputText",
    doneSuccess: protocol?.sse.done?.success ?? "",
    errorOn: protocol?.sse.error?.on ?? "",
    errorMessagePath: protocol?.sse.error?.message ?? "data.error",
    toolOn: protocol?.sse.tool?.on ?? "",
    toolName: protocol?.sse.tool?.name ?? "data.name",
    toolStatus: protocol?.sse.tool?.status ?? "data.status",
    toolFallback: protocol?.sse.tool?.nameFallback ?? "",
    ignoreText: (protocol?.sse.ignore ?? []).join(", "),
    userParams: provider?.userParams ? provider.userParams.map((param) => ({ ...param })) : [],
  };
}

/** 草稿 → 提交载荷；JSON 文本域解析失败在这里给出指向性错误串。`base` 是被编辑
    provider 的原协议：**表单不管的键从这里保留**（2026-09-15 的 elicit 映射是
    被悄悄剥掉的第一例——管理员在表单里改个名字，保存不该丢掉 MRTR 确认映射与
    tool.input 这类表单尚未承载的协议键）。 */
function buildInput(draft: Draft, base?: AssistantProtocol): { name: string; protocol: AssistantProtocol; userParams: AssistantUserParam[]; enabled: boolean } | string {
  const parse = (text: string, what: string): Record<string, unknown> | string => {
    try {
      const parsed = JSON.parse(text || "{}") as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return `${what} 必须是 JSON 对象`;
      return parsed as Record<string, unknown>;
    } catch (error) {
      return `${what} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const createBody = parse(draft.createBodyText, "建会话请求体");
  if (typeof createBody === "string") return createBody;
  const chatBody = parse(draft.chatBodyText, "发消息请求体");
  if (typeof chatBody === "string") return chatBody;
  const historyQuery = parse(draft.historyQueryText, "历史 query 参数");
  if (typeof historyQuery === "string") return historyQuery;
  const historyFields = parse(draft.historyFieldsText, "历史字段映射");
  if (typeof historyFields === "string") return historyFields;

  const protocol: AssistantProtocol = {
    baseUrl: draft.baseUrl.trim(),
    ...(draft.authHeader.trim() && draft.authValue.trim() ? { auth: { header: draft.authHeader.trim(), value: draft.authValue.trim() } } : {}),
    ...(draft.successField.trim() && draft.successValue.trim() ? { successCode: { field: draft.successField.trim(), value: draft.successValue.trim() } } : {}),
    createConversation: {
      method: draft.createMethod.trim() || "POST",
      path: draft.createPath.trim(),
      ...(Object.keys(createBody).length ? { body: createBody } : {}),
      conversationId: draft.createIdPath.trim() || "data",
    },
    chat: {
      method: draft.chatMethod.trim() || "POST",
      path: draft.chatPath.trim(),
      ...(Object.keys(chatBody).length ? { body: chatBody } : {}),
    },
    ...(draft.hasStop && draft.stopPath.trim() ? { stop: { method: draft.stopMethod.trim() || "POST", path: draft.stopPath.trim() } } : {}),
    ...(draft.hasDelete && draft.deletePath.trim() ? { delete: { method: draft.deleteMethod.trim() || "POST", path: draft.deletePath.trim() } } : {}),
    ...(draft.hasHistory && draft.historyPath.trim() ? {
      history: {
        method: draft.historyMethod.trim() || "GET",
        path: draft.historyPath.trim(),
        ...(Object.keys(historyQuery).length ? { query: historyQuery as Record<string, string> } : {}),
        messages: draft.historyMessages.trim() || "data",
        fields: historyFields as Record<string, string>,
      },
    } : {}),
    ...(draft.attachments ? { attachments: true } : {}),
    sse: {
      eventField: draft.sseEventField.trim(),
      ...(draft.tokenOn.trim() ? { token: { on: draft.tokenOn.trim(), text: draft.tokenText.trim() } } : {}),
      ...(draft.doneOn.trim() ? { done: { on: draft.doneOn.trim(), text: draft.doneText.trim(), ...(draft.doneSuccess.trim() ? { success: draft.doneSuccess.trim() } : {}) } } : {}),
      ...(draft.errorOn.trim() ? { error: { on: draft.errorOn.trim(), message: draft.errorMessagePath.trim() } } : {}),
      /* tool：表单管理的四个字段覆盖，其余子键（input——elicit 卡拿删除目标的
         来源）从原映射保留；表单清空 toolOn 才是「删掉 tool 映射」的意图。 */
      ...(draft.toolOn.trim() ? { tool: {
        ...(base?.sse.tool ?? {}),
        on: draft.toolOn.trim(),
        name: draft.toolName.trim(),
        status: draft.toolStatus.trim(),
        ...(draft.toolFallback.trim() ? { nameFallback: draft.toolFallback.trim() } : {}),
      } } : {}),
      ...(draft.ignoreText.trim() ? { ignore: draft.ignoreText.split(/[,，]/).map((item) => item.trim()).filter(Boolean) } : {}),
      ...(base?.sse.elicit ? { elicit: base.sse.elicit } : {}),
    },
  };
  return {
    name: draft.name.trim(),
    protocol,
    userParams: draft.userParams
      .filter((param) => param.key.trim())
      .map((param) => ({ ...param, key: param.key.trim(), label: param.label.trim() || param.key.trim() })),
    enabled: draft.enabled,
  };
}

function toLine(event: AssistantEvent): TestLine {
  if (event.type === "token") return { kind: "token", text: event.text };
  if (event.type === "tool") return { kind: "tool", text: `⟐ ${event.name} · ${event.status}` };
  /* elicit（MRTR 确认表单）：测试连接的回显按工具行语汇显示——确认卡在抽屉里，
     这里只回显「哪个工具在等确认」。 */
  if (event.type === "elicit") return { kind: "tool", text: `⟐ ${event.tool} · elicitation` };
  if (event.type === "done") return { kind: "done", text: event.fullText };
  return { kind: "error", text: event.message };
}

function apiMessage(error: unknown): string | undefined {
  const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === "string" && message ? message : undefined;
}

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AssistantProvidersPanel() {
  const { t } = useTranslation();
  const isSystemAdmin = useAuthStore((state) => state.user?.isSystemAdmin) ?? false;
  const [providers, setProviders] = useState<AssistantProvider[]>();
  const [failed, setFailed] = useState(false);

  /** 页内视图：列表 / 分步编辑 / 测试（都不做弹窗）。 */
  const [view, setView] = useState<"list" | "edit" | "test">("list");
  const [step, setStep] = useState(0);
  const [editing, setEditing] = useState<AssistantProvider>();
  const [draft, setDraft] = useState<Draft>(toDraft());
  const [saving, setSaving] = useState(false);

  /** 测试视图：provider + 临时参数表单（值不落库）。 */
  const [testing, setTesting] = useState<AssistantProvider>();
  const [testParams, setTestParams] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<TestLine[]>([]);
  const [testRunning, setTestRunning] = useState(false);
  const stopTestRef = useRef<(() => void) | undefined>(undefined);

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);

  async function load() {
    setFailed(false);
    try {
      setProviders(await api.assistantProviders());
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    if (isSystemAdmin) void load();
  }, [isSystemAdmin]);

  if (!isSystemAdmin) return null;

  const patch = (part: Partial<Draft>) => setDraft((current) => ({ ...current, ...part }));
  const patchParam = (index: number, part: Partial<AssistantUserParam>) =>
    setDraft((current) => ({ ...current, userParams: current.userParams.map((item, at) => at === index ? { ...item, ...part } : item) }));

  /** 步骤定义：顺序 = 调用链顺序（前置 → 核心 → 后置 → 用户参数）。 */
  const steps = [
    { key: "basic", optional: false },
    { key: "create", optional: false },
    { key: "chat", optional: false },
    { key: "stop", optional: true },
    { key: "delete", optional: true },
    { key: "history", optional: true },
    { key: "userParams", optional: false },
  ] as const;

  function openCreate() {
    setEditing(undefined);
    setDraft(toDraft());
    setStep(0);
    setView("edit");
  }

  function openEdit(provider: AssistantProvider) {
    setEditing(provider);
    setDraft(toDraft(provider));
    setStep(0);
    setView("edit");
  }

  async function save() {
    const input = buildInput(draft, editing?.protocol);
    if (typeof input === "string") { message.error(input); return; }
    if (!input.name) { setStep(0); message.error(t("assistantProviders.nameRequired")); return; }
    /* 必备项缺失时跳到对应步骤，让人直接站在要改的表单前。 */
    if (!input.protocol.baseUrl) { setStep(0); message.error(t("assistantProviders.protocolRequired")); return; }
    if (!input.protocol.createConversation.path) { setStep(1); message.error(t("assistantProviders.protocolRequired")); return; }
    if (!input.protocol.chat.path || !input.protocol.sse.eventField) { setStep(2); message.error(t("assistantProviders.protocolRequired")); return; }
    setSaving(true);
    try {
      if (editing) {
        await api.updateAssistantProvider(editing.id, input);
        message.success(t("assistantProviders.updated"));
      } else {
        await api.createAssistantProvider(input);
        message.success(t("assistantProviders.created"));
      }
      setView("list");
      await load();
    } catch (error) {
      message.error(apiMessage(error) ?? t("assistantProviders.saveFailed"));
    } finally { setSaving(false); }
  }

  function remove(provider: AssistantProvider) {
    Modal.confirm({
      title: t("assistantProviders.deleteTitle", { name: provider.name }),
      content: t("assistantProviders.deleteHint", { count: provider.conversationCount }),
      okText: t("action.delete"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.deleteAssistantProvider(provider.id);
          message.success(t("assistantProviders.deleted"));
          await load();
        } catch (error) { message.error(apiMessage(error) ?? t("assistantProviders.deleteFailed")); }
      },
    });
  }

  async function setDefault(provider: AssistantProvider) {
    try {
      await api.setDefaultAssistantProvider(provider.id);
      message.success(t("assistantProviders.defaultSet", { name: provider.name }));
      await load();
    } catch (error) { message.error(apiMessage(error) ?? t("assistantProviders.updateFailed")); }
  }

  async function toggleEnabled(provider: AssistantProvider, next: boolean) {
    try {
      await api.updateAssistantProvider(provider.id, { enabled: next });
      await load();
    } catch (error) { message.error(apiMessage(error) ?? t("assistantProviders.updateFailed")); }
  }

  async function exportProvider(provider: AssistantProvider) {
    try {
      const blob = await api.exportAssistantProvider(provider.id);
      saveBlob(blob, `assistant-provider-${safeFileName(provider.name)}.json`);
    } catch { message.error(t("assistantProviders.exportFailed")); }
  }

  /** 打开测试视图：临时参数按模式预置空值（必填项标出来，值不落库）。 */
  function openTest(provider: AssistantProvider) {
    setTesting(provider);
    setTestParams(Object.fromEntries(provider.userParams.map((param) => [param.key, ""])));
    setLines([]);
    setTestRunning(false);
    setView("test");
  }

  /** 开始测试：带临时参数建流；每条归一事件落一行，done / error 收尾。 */
  function runTest() {
    if (!testing) return;
    setLines([]);
    setTestRunning(true);
    const { done, stop } = streamAssistantProviderTest(testing.id, testParams, (event) => setLines((current) => [...current, toLine(event)]));
    stopTestRef.current = stop;
    void done.then(() => {
      setTestRunning(false);
      /* 流意外中断且没有终态行（网络断 / 中途停止）：补一行说明，回显区不留悬念。 */
      setLines((current) => current.some((line) => line.kind === "done" || line.kind === "error")
        ? current
        : [...current, { kind: "error", text: t("assistantProviders.testAborted") }]);
    });
  }

  function closeTest() {
    stopTestRef.current?.();
    stopTestRef.current = undefined;
    setTesting(undefined);
    setLines([]);
    setTestRunning(false);
    setView("list");
  }

  async function doImport() {
    let parsed: { name?: unknown; protocol?: unknown; userParams?: unknown };
    try {
      parsed = JSON.parse(importText) as typeof parsed;
    } catch (error) {
      message.error(t("assistantProviders.importJsonInvalid", { message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (typeof parsed.name !== "string" || !parsed.name.trim() || typeof parsed.protocol !== "object" || parsed.protocol === null) {
      message.error(t("assistantProviders.importShapeInvalid"));
      return;
    }
    setImporting(true);
    try {
      const created = await api.importAssistantProvider({
        name: parsed.name.trim(),
        protocol: parsed.protocol as AssistantProtocol,
        ...(Array.isArray(parsed.userParams) ? { userParams: parsed.userParams as AssistantUserParam[] } : {}),
      });
      message.success(t("assistantProviders.imported", { name: created.name }));
      setImportOpen(false);
      setImportText("");
      await load();
    } catch (error) {
      message.error(apiMessage(error) ?? t("assistantProviders.importFailed"));
    } finally { setImporting(false); }
  }

  if (failed) return <Empty title={t("assistantProviders.loadFailedTitle")} hint={t("assistantProviders.loadFailedHint")} action={<button className="btn" onClick={() => void load()}>{t("action.retry")}</button>} />;
  if (providers === undefined) return <p className="muted">{t("common.loading")}</p>;

  /* ── 测试视图（页内）───────────────────────────────────────────────────────── */
  if (view === "test" && testing) return <div className="provider-editor">
    <div className="filter-bar">
      <button className="btn btn-with-icon" onClick={closeTest}><ArrowLeft size={14} />{t("providerStep.back")}</button>
      <span className="filter-spacer" />
      <span className="muted mono">{t("assistantProviders.testTitle", { name: testing.name })}</span>
    </div>
    <p className="form-note">{t("assistantProviders.testParamsHint")}</p>
    {testing.userParams.map((param) => <label key={param.key} className="field">
      <span>{param.label}{param.required ? " *" : ""}</span>
      <input
        className="input mono"
        type={param.secret ? "password" : "text"}
        value={testParams[param.key] ?? ""}
        onChange={(event) => setTestParams((current) => ({ ...current, [param.key]: event.target.value }))}
        placeholder={param.placeholder ?? ""}
      />
    </label>)}
    <div style={{ display: "flex", gap: "var(--s2)", marginTop: "var(--s3)" }}>
      {testRunning
        ? <button className="btn" onClick={() => stopTestRef.current?.()}>{t("assistantProviders.testStop")}</button>
        : <button className="btn btn-primary" onClick={runTest}>{t("assistantProviders.test")}</button>}
    </div>
    {lines.length > 0 && <pre className="test-output" style={{ marginTop: "var(--s3)" }}>
      {lines.map((line, index) => <div key={index} className={`test-line-${line.kind}`}>{line.text}</div>)}
    </pre>}
  </div>;

  /* ── 分步编辑视图（页内）───────────────────────────────────────────────────── */
  if (view === "edit") return <div className="provider-editor">
    <div className="filter-bar">
      <button className="btn btn-with-icon" onClick={() => setView("list")}><ArrowLeft size={14} />{t("providerStep.back")}</button>
      <span className="filter-spacer" />
      <span className="muted mono">{editing ? t("assistantProviders.editTitle", { name: editing.name }) : t("assistantProviders.create")}</span>
    </div>

    {/* 步骤条：顺序 = 调用链顺序；点击可跳转（改哪步直接去哪步）。 */}
    <div className="provider-steps">
      {steps.map((meta, index) => <button key={meta.key} type="button" className={`provider-step${index === step ? " is-active" : ""}`} onClick={() => setStep(index)}>
        <span className="provider-step-index">{index + 1}</span>
        {t(`providerStep.${meta.key}`)}
        {meta.optional && <span className="provider-step-optional">{t("providerStep.optional")}</span>}
      </button>)}
    </div>

    <h3>{t(`providerStep.${steps[step].key}`)}</h3>
    <p className="form-note">{t(`providerStep.${steps[step].key}Desc`)}</p>

    {step === 0 && <>
      {/* 模板变量总说明：第一次进编辑器就读到「哪些是引擎内置、哪些来自用户参数」。 */}
      <div className="provider-vars">
        <strong style={{ fontSize: 12 }}>{t("providerStep.varsTitle")}</strong>
        <p>{t("providerStep.varsBuiltin")}</p>
        <p>{t("providerStep.varsUser")}</p>
      </div>
      <Field label={t("assistantProviders.name")} hint={t("assistantProviders.namePlaceholder")}>
        <input className="input" value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder={t("assistantProviders.namePlaceholder")} />
      </Field>
      <Field label={t("assistantProviders.baseUrl")} hint={t("providerStep.hint.baseUrl")}>
        <input className="input mono" value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="http://stgstplatform.example:8089" />
      </Field>
      <div className="provider-grid-2">
        <Field label={t("assistantProviders.authHeader")} hint={t("providerStep.hint.authHeader")}>
          <input className="input mono" value={draft.authHeader} onChange={(event) => patch({ authHeader: event.target.value })} placeholder="Authorization" />
        </Field>
        <Field label={t("assistantProviders.authValue")} hint={t("providerStep.hint.authValue")}>
          <input className="input mono" value={draft.authValue} onChange={(event) => patch({ authValue: event.target.value })} placeholder="Bearer {{user.apiKey}}" />
        </Field>
      </div>
      <div className="provider-grid-2">
        <Field label={t("assistantProviders.successField")} hint={t("providerStep.hint.successCode")}>
          <input className="input mono" value={draft.successField} onChange={(event) => patch({ successField: event.target.value })} placeholder="code" />
        </Field>
        <Field label={t("assistantProviders.successValue")}>
          <input className="input mono" value={draft.successValue} onChange={(event) => patch({ successValue: event.target.value })} placeholder="0000" />
        </Field>
      </div>
      <label className="check-field" style={{ marginTop: "var(--s3)" }}>
        <input type="checkbox" checked={draft.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />
        {t("assistantProviders.enableProvider")}
      </label>
    </>}

    {step === 1 && <>
      <div className="provider-grid-2">
        <Field label={t("assistantProviders.method")}>
          <Select value={draft.createMethod} onChange={(next) => patch({ createMethod: next })} options={["POST", "GET", "PUT", "PATCH"].map((method) => ({ value: method, label: method }))} style={{ width: "100%" }} />
        </Field>
        <Field label={t("assistantProviders.path")} hint={t("providerStep.hint.createPath")}>
          <input className="input mono" value={draft.createPath} onChange={(event) => patch({ createPath: event.target.value })} placeholder="/api/v1/chat/conversation/add" />
        </Field>
      </div>
      <Field label={t("assistantProviders.conversationIdPath")} hint={t("providerStep.hint.conversationIdPath")}>
        <input className="input mono" value={draft.createIdPath} onChange={(event) => patch({ createIdPath: event.target.value })} placeholder="data" />
      </Field>
      <Field label={t("assistantProviders.bodyTemplate")} hint={t("providerStep.hint.createBody")}>
        <textarea className="input mono" rows={4} value={draft.createBodyText} onChange={(event) => patch({ createBodyText: event.target.value })} placeholder={'{"agentId": "{{user.agentId}}"}'} />
      </Field>
    </>}

    {step === 2 && <>
      <div className="provider-grid-2">
        <Field label={t("assistantProviders.method")}>
          <Select value={draft.chatMethod} onChange={(next) => patch({ chatMethod: next })} options={["POST", "GET", "PUT", "PATCH"].map((method) => ({ value: method, label: method }))} style={{ width: "100%" }} />
        </Field>
        <Field label={t("assistantProviders.path")} hint={t("providerStep.hint.path")}>
          <input className="input mono" value={draft.chatPath} onChange={(event) => patch({ chatPath: event.target.value })} placeholder="/api/v1/chat/{{conversationId}}" />
        </Field>
      </div>
      <Field label={t("assistantProviders.bodyTemplate")} hint={t("providerStep.hint.chatBody")}>
        <textarea className="input mono" rows={4} value={draft.chatBodyText} onChange={(event) => patch({ chatBodyText: event.target.value })} placeholder={'{"conversationId": "{{conversationId}}", "message": "{{message}}"}'} />
      </Field>
      <label className="check-field" style={{ margin: "var(--s3) 0" }}>
        <input type="checkbox" checked={draft.attachments} onChange={(event) => patch({ attachments: event.target.checked })} />
        {t("assistantProviders.attachments")}
        <span className="field-hint" style={{ marginLeft: "var(--s2)" }}>{t("providerStep.hint.attachments")}</span>
      </label>

      <p className="label" style={{ margin: "var(--s4) 0 var(--s2)" }}>{t("assistantProviders.sseSection")}</p>
      <Field label={t("assistantProviders.sseEventField")} hint={t("providerStep.hint.eventField")}>
        <input className="input mono" value={draft.sseEventField} onChange={(event) => patch({ sseEventField: event.target.value })} placeholder="eventType" />
      </Field>
      <div className="provider-grid-2">
        <Field label={t("assistantProviders.tokenOn")} hint={t("providerStep.hint.token")}>
          <input className="input mono" value={draft.tokenOn} onChange={(event) => patch({ tokenOn: event.target.value })} placeholder="MESSAGE" />
        </Field>
        <Field label={t("assistantProviders.tokenText")}>
          <input className="input mono" value={draft.tokenText} onChange={(event) => patch({ tokenText: event.target.value })} placeholder="data.text" />
        </Field>
      </div>
      <div className="provider-grid-2">
        <Field label={t("assistantProviders.doneOn")} hint={t("providerStep.hint.done")}>
          <input className="input mono" value={draft.doneOn} onChange={(event) => patch({ doneOn: event.target.value })} placeholder="FINAL_RESULT" />
        </Field>
        <Field label={t("assistantProviders.doneText")}>
          <input className="input mono" value={draft.doneText} onChange={(event) => patch({ doneText: event.target.value })} placeholder="data.outputText" />
        </Field>
        <Field label={t("assistantProviders.doneSuccess")}>
          <input className="input mono" value={draft.doneSuccess} onChange={(event) => patch({ doneSuccess: event.target.value })} placeholder="data.success" />
        </Field>
        <Field label={t("assistantProviders.ignoreList")} hint={t("providerStep.hint.ignore")}>
          <input className="input mono" value={draft.ignoreText} onChange={(event) => patch({ ignoreText: event.target.value })} placeholder="HEART_BEAT" />
        </Field>
      </div>
      <div className="provider-grid-2">
        <Field label={t("assistantProviders.errorOn")} hint={t("providerStep.hint.error")}>
          <input className="input mono" value={draft.errorOn} onChange={(event) => patch({ errorOn: event.target.value })} placeholder="ERROR" />
        </Field>
        <Field label={t("assistantProviders.errorMessagePath")}>
          <input className="input mono" value={draft.errorMessagePath} onChange={(event) => patch({ errorMessagePath: event.target.value })} placeholder="data.error" />
        </Field>
        <Field label={t("assistantProviders.toolOn")} hint={t("providerStep.hint.tool")}>
          <input className="input mono" value={draft.toolOn} onChange={(event) => patch({ toolOn: event.target.value })} placeholder="PROCESSING" />
        </Field>
        <Field label={t("assistantProviders.toolName")}>
          <input className="input mono" value={draft.toolName} onChange={(event) => patch({ toolName: event.target.value })} placeholder="data.name" />
        </Field>
        <Field label={t("assistantProviders.toolStatus")}>
          <input className="input mono" value={draft.toolStatus} onChange={(event) => patch({ toolStatus: event.target.value })} placeholder="data.status" />
        </Field>
        <Field label={t("assistantProviders.toolFallback")}>
          <input className="input mono" value={draft.toolFallback} onChange={(event) => patch({ toolFallback: event.target.value })} placeholder="data.type" />
        </Field>
      </div>
    </>}

    {step === 3 && <>
      <label className="check-field" style={{ margin: 0 }}>
        <input type="checkbox" checked={draft.hasStop} onChange={(event) => patch({ hasStop: event.target.checked })} />
        {t("assistantProviders.hasStop")}
        <span className="field-hint" style={{ marginLeft: "var(--s2)" }}>{t("providerStep.hint.stopPath")}</span>
      </label>
      {draft.hasStop && <div className="provider-grid-2" style={{ marginTop: "var(--s3)" }}>
        <Field label={t("assistantProviders.method")}>
          <Select value={draft.stopMethod} onChange={(next) => patch({ stopMethod: next })} options={["POST", "GET", "PUT", "PATCH"].map((method) => ({ value: method, label: method }))} style={{ width: "100%" }} />
        </Field>
        <Field label={t("assistantProviders.path")}>
          <input className="input mono" value={draft.stopPath} onChange={(event) => patch({ stopPath: event.target.value })} placeholder="/api/v1/chat/{{conversationId}}/stop" />
        </Field>
      </div>}
    </>}

    {step === 4 && <>
      <label className="check-field" style={{ margin: 0 }}>
        <input type="checkbox" checked={draft.hasDelete} onChange={(event) => patch({ hasDelete: event.target.checked })} />
        {t("assistantProviders.hasDelete")}
        <span className="field-hint" style={{ marginLeft: "var(--s2)" }}>{t("providerStep.hint.deletePath")}</span>
      </label>
      {draft.hasDelete && <div className="provider-grid-2" style={{ marginTop: "var(--s3)" }}>
        <Field label={t("assistantProviders.method")}>
          <Select value={draft.deleteMethod} onChange={(next) => patch({ deleteMethod: next })} options={["POST", "GET", "PUT", "PATCH", "DELETE"].map((method) => ({ value: method, label: method }))} style={{ width: "100%" }} />
        </Field>
        <Field label={t("assistantProviders.path")}>
          <input className="input mono" value={draft.deletePath} onChange={(event) => patch({ deletePath: event.target.value })} placeholder="/api/v1/chat/conversation/{{conversationId}}/delete" />
        </Field>
      </div>}
    </>}

    {step === 5 && <>
      <label className="check-field" style={{ margin: 0 }}>
        <input type="checkbox" checked={draft.hasHistory} onChange={(event) => patch({ hasHistory: event.target.checked })} />
        {t("assistantProviders.hasHistory")}
        <span className="field-hint" style={{ marginLeft: "var(--s2)" }}>{t("providerStep.hint.historyPath")}</span>
      </label>
      {draft.hasHistory && <div style={{ marginTop: "var(--s3)" }}>
        <div className="provider-grid-2">
          <Field label={t("assistantProviders.method")}>
            <Select value={draft.historyMethod} onChange={(next) => patch({ historyMethod: next })} options={["GET", "POST"].map((method) => ({ value: method, label: method }))} style={{ width: "100%" }} />
          </Field>
          <Field label={t("assistantProviders.path")}>
            <input className="input mono" value={draft.historyPath} onChange={(event) => patch({ historyPath: event.target.value })} placeholder="/api/v1/chat/{{conversationId}}/messages" />
          </Field>
        </div>
        <Field label={t("assistantProviders.messagesPath")} hint={t("providerStep.hint.messagesPath")}>
          <input className="input mono" value={draft.historyMessages} onChange={(event) => patch({ historyMessages: event.target.value })} placeholder="data" />
        </Field>
        <div className="provider-grid-2">
          <Field label={t("assistantProviders.queryTemplate")} hint={t("providerStep.hint.queryTemplate")}>
            <textarea className="input mono" rows={4} value={draft.historyQueryText} onChange={(event) => patch({ historyQueryText: event.target.value })} placeholder={'{"index": "{{index}}", "limit": "{{limit}}"}'} />
          </Field>
          <Field label={t("assistantProviders.fieldsMapping")} hint={t("providerStep.hint.fieldsMapping")}>
            <textarea className="input mono" rows={4} value={draft.historyFieldsText} onChange={(event) => patch({ historyFieldsText: event.target.value })} placeholder={'{"id": "id", "role": "role", "text": "text", "time": "time"}'} />
          </Field>
        </div>
      </div>}
    </>}

    {step === 6 && <>
      <p className="form-note">{t("assistantProviders.userParamsHint")}</p>
      {draft.userParams.map((param, index) => <div key={index} className="provider-param-row">
        <Field label={t("assistantProviders.paramKey")} hint={t("providerStep.hint.paramKey")}>
          <input className="input mono" value={param.key} onChange={(event) => patchParam(index, { key: event.target.value })} placeholder="agentId" />
        </Field>
        <Field label={t("assistantProviders.paramLabel")} hint={t("providerStep.hint.paramLabel")}>
          <input className="input" value={param.label} onChange={(event) => patchParam(index, { label: event.target.value })} placeholder={param.key || "API Key"} />
        </Field>
        <label className="check-field" title={t("providerStep.hint.paramSecret")}>
          <input type="checkbox" checked={param.secret} onChange={(event) => patchParam(index, { secret: event.target.checked })} />
          {t("assistantProviders.paramSecret")}
        </label>
        <label className="check-field" title={t("providerStep.hint.paramRequired")}>
          <input type="checkbox" checked={param.required} onChange={(event) => patchParam(index, { required: event.target.checked })} />
          {t("assistantProviders.paramRequired")}
        </label>
        <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => setDraft((current) => ({ ...current, userParams: current.userParams.filter((_, at) => at !== index) }))} />
      </div>)}
      <button className="btn btn-with-icon" onClick={() => setDraft((current) => ({ ...current, userParams: [...current.userParams, { key: "", label: "", secret: true, required: true }] }))}>
        <Plus size={14} />{t("assistantProviders.addParam")}
      </button>
    </>}

    <div className="provider-step-actions">
      <button className="btn" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>{t("providerStep.prev")}</button>
      {step < steps.length - 1
        ? <button className="btn btn-primary" onClick={() => setStep((current) => Math.min(steps.length - 1, current + 1))}>{t("providerStep.next")}</button>
        : <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "…" : t("action.save")}</button>}
    </div>
  </div>;

  /* ── 列表视图 ──────────────────────────────────────────────────────────────── */
  const hasEnabledDefault = providers.some((provider) => provider.isDefault && provider.enabled);

  return <>
    {/* 按钮在右、描述在按钮下面：先动作后解释。 */}
    <div className="filter-bar">
      <span className="muted mono">{t("assistantProviders.totalCount", { count: providers.length })}</span>
      <span className="filter-spacer" />
      <button className="btn btn-primary btn-with-icon" onClick={openCreate}>
        <Plus size={14} />{t("assistantProviders.create")}
      </button>
      <button className="btn" onClick={() => setImportOpen(true)}>{t("assistantProviders.importAction")}</button>
    </div>

    {/* 层级纪律：这里管平台的上游模板；每个用户在抽屉「设置」里自配凭据。 */}
    <p className="form-note">{t("assistantProviders.hint")}</p>

    {/* 无默认 provider 的引导（边界 15 的系统侧）：用户第一次配置时没有预选项。 */}
    {!hasEnabledDefault && providers.length > 0 && <p className="form-error">{t("assistantProviders.noDefaultWarning")}</p>}

    {providers.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("assistantProviders.name")}</th>
        <th className="mono">{t("assistantProviders.baseUrl")}</th>
        <th className="col-status">{t("assistantProviders.status")}</th>
        <th>{t("assistantProviders.capabilities")}</th>
        <th>{t("assistantProviders.userParams")}</th>
        <th className="col-num">{t("assistantProviders.conversations")}</th>
        <th>{t("assistantProviders.updatedAt")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {providers.map((provider) => <tr key={provider.id} data-removed={provider.enabled ? undefined : ""}>
          <td>
            <strong className="truncate">{provider.name}</strong>
            {provider.isDefault && <span className="chip" style={{ marginLeft: "var(--s2)" }}>{t("assistantProviders.defaultChip")}</span>}
          </td>
          <td className="mono muted">{provider.protocol.baseUrl || "—"}</td>
          <td className="col-status">
            <Status status={provider.enabled ? "pass" : "skip"} label={t(provider.enabled ? "assistantProviders.enabled" : "assistantProviders.disabled")} />
          </td>
          {/* 能力面从协议形状派生（定义了端点 = 有该能力）。 */}
          <td className="mono muted">
            {(Object.keys(provider.capabilities) as (keyof AssistantCapabilities)[])
              .filter((key) => provider.capabilities[key])
              .join(" · ") || "—"}
          </td>
          <td className="mono muted">{provider.userParams.map((param) => param.key).join(" · ") || "—"}</td>
          <td className="col-num mono">{provider.conversationCount}</td>
          <td className="mono muted">{new Date(provider.updatedAt).toLocaleString()}</td>
          <td className="col-actions">
            <div className="row-actions">
              {!provider.isDefault && <button className="btn" onClick={() => void setDefault(provider)}>{t("assistantProviders.setDefault")}</button>}
              <button className="btn" onClick={() => openTest(provider)}>{t("assistantProviders.test")}</button>
              <button className="btn" onClick={() => void toggleEnabled(provider, !provider.enabled)}>
                {t(provider.enabled ? "assistantProviders.disable" : "assistantProviders.enable")}
              </button>
              <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => openEdit(provider)} />
              <IconButton icon={<Download size={14} />} label={t("assistantProviders.exportAction")} onClick={() => void exportProvider(provider)} />
              <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => remove(provider)} />
            </div>
          </td>
        </tr>)}
      </tbody>
    </table></div> : <Empty title={t("assistantProviders.emptyTitle")} hint={t("assistantProviders.emptyHint")} action={<>
      <button className="btn btn-primary" onClick={openCreate}>{t("assistantProviders.create")}</button>
      <button className="btn" onClick={() => setImportOpen(true)}>{t("assistantProviders.importAction")}</button>
    </>} />}

    {/* JSON 导入是小动作（粘贴即确认），保留弹窗形态。 */}
    <Modal
      open={importOpen}
      title={t("assistantProviders.importTitle")}
      okText={t("action.import")}
      cancelText={t("action.cancel")}
      confirmLoading={importing}
      onOk={() => void doImport()}
      onCancel={() => setImportOpen(false)}
    >
      <p className="form-note">{t("assistantProviders.importHint")}</p>
      <textarea className="input mono" rows={10} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={t("assistantProviders.importPlaceholder")} />
    </Modal>
  </>;
}

/** 字段 + 一行说明：引导式编辑器的原子——让人知道「这个值从哪来、填错了会怎样」。 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div>
    <label className="field" style={{ margin: 0 }}>
      <span>{label}</span>
      {children}
    </label>
    {hint ? <p className="field-hint">{hint}</p> : null}
  </div>;
}
