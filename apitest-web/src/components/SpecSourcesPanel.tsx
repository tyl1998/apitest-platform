import { useCallback, useEffect, useState } from "react";
import { Checkbox, Form, Input, Modal, Select, Switch, message } from "antd";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, type SpecSource } from "../api";
import { Empty, Status } from "../ui";
import { IconButton } from "./IconButton";

/**
 * 接口来源管理（P17，系统设置「接口来源」tab；仅系统管理员）。
 *
 * 全系统级：来源存同一张表、全局可见可选，不设项目级、不开项目侧导航项。`is_temporary`
 * 只是状态标记——正式（团队统一平台）与临时（临时贴的 URL）分段列出，权限与可见性一样，
 * 分段是为了让管理员认得出哪些该清理。
 *
 * 「刷新」是显式动作（不做后台轮询）：拉一次快照落 cache，创建时本地搜、离线可用。
 *
 * 建 / 改是**页内编辑器**（与助手 provider 同形，不做弹窗）：字段带说明，编辑器占整块
 * 页面区域，「返回」回列表——这种量级的表单塞弹窗里既看不全也没法对照。
 */

/** 快照型来源（有全量快照、可刷新、可本地搜）：静态文档与 Apifox 分享。 */
function isSnapshotType(type: string): boolean {
  return type === "openapi" || type === "apifox";
}

export function SpecSourcesPanel() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<SpecSource[]>();
  const [failed, setFailed] = useState(false);
  /** 页内视图：列表 / 编辑（都不做弹窗）。 */
  const [view, setView] = useState<"list" | "edit">("list");
  const [editing, setEditing] = useState<SpecSource>();
  const [refreshing, setRefreshing] = useState<string>();

  const load = useCallback(async () => {
    try {
      setSources(await api.specSources());
      setFailed(false);
    } catch { setFailed(true); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openCreate() {
    setEditing(undefined);
    setView("edit");
  }

  function openEdit(source: SpecSource) {
    setEditing(source);
    setView("edit");
  }

  async function refresh(source: SpecSource) {
    setRefreshing(source.id);
    try {
      const updated = await api.refreshSpecSource(source.id);
      message.success(t("specSources.refreshed", { count: updated.operationCount }));
      await load();
    } catch (error) {
      /* 502 / code 2008：地址取不到或文档不合法，具体原因在 message 里。 */
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      message.error(detail ? `${t("specSources.refreshFailed")} ${detail}` : t("specSources.refreshFailed"));
    } finally { setRefreshing(undefined); }
  }

  function remove(source: SpecSource) {
    Modal.confirm({
      title: t("specSources.deleteTitle", { name: source.name }),
      content: t("specSources.deleteHint"),
      okText: t("action.delete"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.deleteSpecSource(source.id);
          await load();
          message.success(t("specSources.deleted"));
        } catch { message.error(t("specSources.deleteFailed")); }
      },
    });
  }

  function renderRow(source: SpecSource) {
    const snapshot = isSnapshotType(source.type);
    return <tr key={source.id}>
      <td>
        <div className="cell-name">
          <strong className="truncate">{source.name}</strong>
          {source.isTemporary && <span className="chip">{t("specSources.temporary")}</span>}
        </div>
      </td>
      <td className="mono muted">{source.type === "adapter" ? t("specSources.typeAdapter") : source.type}</td>
      <td className="col-path mono truncate">{source.url}</td>
      <td className="col-num mono">{snapshot ? source.operationCount : "—"}</td>
      <td className="col-status">
        {!snapshot
          ? <span className="muted">—</span>
          : source.status === "ok"
            ? <Status status="pass" label={t("specSources.statusOk")} />
            : <Status status="fail" label={t("specSources.statusError")} />}
      </td>
      <td className="col-status">
        {source.credentialConfigured ? <Status status="skip" label={t("specSources.credentialSet")} /> : <span className="muted">—</span>}
      </td>
      <td className="col-actions">
        <div className="row-actions">
          {/* 刷新只对快照型来源（openapi / apifox）有意义；检索型（adapter）是实时透传，没有快照可刷。 */}
          {snapshot && <IconButton icon={<RefreshCw size={14} />} label={t("specSources.refresh")} disabled={refreshing === source.id} onClick={() => void refresh(source)} />}
          <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => openEdit(source)} />
          <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => remove(source)} />
        </div>
      </td>
    </tr>;
  }

  function renderSection(list: SpecSource[]) {
    if (!list.length) return null;
    return <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("specSources.name")}</th>
        <th>{t("specSources.type")}</th>
        <th className="col-path">{t("specSources.url")}</th>
        <th className="col-num">{t("specSources.operations")}</th>
        <th className="col-status">{t("specSources.status")}</th>
        <th className="col-status">{t("specSources.credential")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>{list.map(renderRow)}</tbody>
    </table></div>;
  }

  if (failed) return <Empty title={t("specSources.loadFailedTitle")} hint={t("specSources.loadFailedHint")} />;
  if (!sources) return <p className="muted">{t("common.loading")}</p>;

  /* ── 页内编辑器（新增 / 编辑共用，不做弹窗）────────────────────────────────── */
  if (view === "edit") return <SpecSourceEditor
    source={editing}
    onCancel={() => setView("list")}
    onSaved={() => { setView("list"); void load(); }}
  />;

  /* ── 列表视图 ──────────────────────────────────────────────────────────────── */
  const formal = sources.filter((source) => !source.isTemporary);
  const temporary = sources.filter((source) => source.isTemporary);

  return <>
    {/* 按钮在右、描述在按钮下面。 */}
    <div className="filter-bar">
      <span className="filter-spacer" />
      <button className="btn btn-primary btn-with-icon" onClick={openCreate}>
        <Plus size={14} />{t("specSources.create")}
      </button>
    </div>

    <p className="form-note">{t("specSources.hint")}</p>

    {sources.length ? <>
      {formal.length > 0 && <><p className="form-note">{t("specSources.formalSection")}</p>{renderSection(formal)}</>}
      {temporary.length > 0 && <><p className="form-note">{t("specSources.temporarySection")}</p>{renderSection(temporary)}</>}
    </> : <Empty title={t("specSources.emptyTitle")} hint={t("specSources.emptyHint")} />}
  </>;
}

/**
 * 来源编辑器（页内）：`source` 为空是新增，否则是编辑。表单值在挂载后一次性铺进
 * （避免未挂载时操作 form 的告警），`type` 决定显示哪些字段（adapter 才有检索配置）。
 */
function SpecSourceEditor({ source, onCancel, onSaved }: {
  source?: SpecSource;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const sourceType = (Form.useWatch("type", form) as string | undefined) ?? "openapi";
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!source) {
      form.setFieldsValue({ type: "openapi", isTemporary: false, searchMethod: "GET" });
      return;
    }
    const config = source.config as Record<string, unknown>;
    const fieldMap = (config.fieldMap ?? {}) as Record<string, unknown>;
    form.setFieldsValue({
      name: source.name,
      type: source.type,
      url: source.url,
      headerName: typeof config.headerName === "string" ? config.headerName : "",
      searchPath: typeof config.searchPath === "string" ? config.searchPath : "",
      searchMethod: typeof config.searchMethod === "string" ? config.searchMethod : "GET",
      keywordParam: typeof config.keywordParam === "string" ? config.keywordParam : "",
      resultPath: typeof config.resultPath === "string" ? config.resultPath : "",
      methodField: typeof fieldMap.method === "string" ? fieldMap.method : "",
      pathField: typeof fieldMap.path === "string" ? fieldMap.path : "",
      summaryField: typeof fieldMap.summary === "string" ? fieldMap.summary : "",
      isTemporary: source.isTemporary,
      clearCredential: false,
    });
  }, [source, form]);

  async function save() {
    const values = await form.validateFields();
    const config: Record<string, unknown> = {};
    if (values.type !== "apifox" && values.headerName?.trim()) config.headerName = values.headerName.trim();
    if (values.type === "adapter") {
      config.searchPath = values.searchPath?.trim();
      config.searchMethod = values.searchMethod ?? "GET";
      if (values.keywordParam?.trim()) config.keywordParam = values.keywordParam.trim();
      if (values.resultPath?.trim()) config.resultPath = values.resultPath.trim();
      const fieldMap: Record<string, string> = {};
      if (values.methodField?.trim()) fieldMap.method = values.methodField.trim();
      if (values.pathField?.trim()) fieldMap.path = values.pathField.trim();
      if (values.summaryField?.trim()) fieldMap.summary = values.summaryField.trim();
      if (Object.keys(fieldMap).length) config.fieldMap = fieldMap;
    }
    setSaving(true);
    try {
      if (!source) {
        await api.createSpecSource({
          name: values.name.trim(), type: values.type, url: values.url.trim(),
          config, isTemporary: values.isTemporary === true,
          ...(values.credential?.trim() ? { credential: values.credential } : {}),
        });
        message.success(t("specSources.created"));
      } else {
        await api.updateSpecSource(source.id, {
          name: values.name.trim(), type: values.type, url: values.url.trim(),
          config, isTemporary: values.isTemporary === true,
          ...(values.clearCredential ? { credential: null } : values.credential?.trim() ? { credential: values.credential } : {}),
        });
        message.success(t("specSources.updated"));
      }
      onSaved();
    } catch (error) {
      const code = (error as { response?: { data?: { code?: number } } })?.response?.data?.code;
      if (code === 2003) message.error(t("specSources.nameExists"));
      else message.error(t("specSources.saveFailed"));
    } finally { setSaving(false); }
  }

  return <div className="provider-editor">
    <div className="filter-bar" style={{ marginBottom: 0 }}>
      <button className="btn btn-with-icon" onClick={onCancel}><ArrowLeft size={14} />{t("action.back")}</button>
      <span className="filter-spacer" />
      <span className="muted mono">{source ? t("specSources.editTitle") : t("specSources.createTitle")}</span>
    </div>
    <Form form={form} layout="vertical" onFinish={() => void save()}>
      <Form.Item name="name" label={t("specSources.name")} rules={[{ required: true, message: t("specSources.nameRequired") }]}>
        <Input maxLength={100} />
      </Form.Item>
      <Form.Item name="type" label={t("specSources.type")} rules={[{ required: true }]}>
        <Select options={[
          { value: "openapi", label: t("specSources.typeOpenapi") },
          { value: "apifox", label: t("specSources.typeApifox") },
          { value: "adapter", label: t("specSources.typeAdapter") },
        ]} />
      </Form.Item>
      <Form.Item
        name="url"
        label={sourceType === "adapter" ? t("specSources.baseUrl") : sourceType === "apifox" ? t("specSources.apifoxUrl") : t("specSources.url")}
        rules={[{
          required: true,
          message: sourceType === "adapter" ? t("specSources.baseUrlRequired") : sourceType === "apifox" ? t("specSources.apifoxUrlRequired") : t("specSources.urlRequired"),
        }]}
        extra={sourceType === "adapter" ? t("specSources.baseUrlHint") : sourceType === "apifox" ? t("specSources.apifoxUrlHint") : t("specSources.urlHint")}
      >
        <Input className="mono" placeholder={sourceType === "adapter" ? "https://remote.example.com" : sourceType === "apifox" ? "https://s.apifox.cn/<shareId>" : "https://example.com/openapi.json"} />
      </Form.Item>
      {sourceType === "adapter" && <>
        <Form.Item name="searchPath" label={t("specSources.searchPath")} rules={[{ required: true, message: t("specSources.searchPathRequired") }]} extra={t("specSources.searchPathHint")}>
          <Input className="mono" placeholder="/api/operations/search" />
        </Form.Item>
        <Form.Item name="searchMethod" label={t("specSources.searchMethod")}>
          <Select options={[{ value: "GET", label: "GET" }, { value: "POST", label: "POST" }]} />
        </Form.Item>
        <Form.Item name="keywordParam" label={t("specSources.keywordParam")} extra={t("specSources.keywordParamHint")}>
          <Input className="mono" placeholder="keyword" />
        </Form.Item>
        <Form.Item name="resultPath" label={t("specSources.resultPath")} extra={t("specSources.resultPathHint")}>
          <Input className="mono" placeholder="data.items" />
        </Form.Item>
        <Form.Item name="methodField" label={t("specSources.methodField")} extra={t("specSources.fieldMapHint")}>
          <Input className="mono" placeholder="method" />
        </Form.Item>
        <Form.Item name="pathField" label={t("specSources.pathField")}>
          <Input className="mono" placeholder="path" />
        </Form.Item>
        <Form.Item name="summaryField" label={t("specSources.summaryField")}>
          <Input className="mono" placeholder="summary" />
        </Form.Item>
      </>}
      {/* Apifox 分享是公开文档，不需凭据：类型为 apifox 时不显示凭据项。 */}
      {sourceType !== "apifox" && <>
        <Form.Item name="credential" label={t("specSources.credential")} extra={!source ? t("specSources.credentialCreateHint") : t("specSources.credentialEditHint")}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        {source?.credentialConfigured && (
          <Form.Item name="clearCredential" valuePropName="checked" style={{ marginBottom: 0 }}>
            <Checkbox>{t("specSources.clearCredential")}</Checkbox>
          </Form.Item>
        )}
        <Form.Item name="headerName" label={t("specSources.headerName")} extra={t("specSources.headerNameHint")}>
          <Input className="mono" placeholder="Authorization" />
        </Form.Item>
      </>}
      <Form.Item name="isTemporary" label={t("specSources.temporary")} valuePropName="checked" extra={t("specSources.temporaryHint")}>
        <Switch />
      </Form.Item>
    </Form>
    <div className="provider-step-actions">
      <button className="btn" onClick={onCancel}>{t("action.cancel")}</button>
      <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "…" : t("action.save")}</button>
    </div>
  </div>;
}