import { useEffect, useState } from "react";
import { Drawer, Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { Cable, Pencil, Plus, Trash2 } from "lucide-react";
import { api, type DataSource, type DataSourceConfig, type DataSourceInput, type DataSourceType, type DataSourceUsage } from "../api";
import { Empty } from "../ui";
import { IconButton } from "./IconButton";

const DATA_SOURCE_TYPES: { value: DataSourceType; label: string; port: number; username: string }[] = [
  { value: "postgresql", label: "PostgreSQL", port: 5432, username: "postgres" },
  { value: "mysql", label: "MySQL", port: 3306, username: "root" },
];

const DEFAULT_CONFIGS: Record<DataSourceType, DataSourceConfig> = {
  postgresql: { host: "localhost", port: 5432, database: "", username: "postgres", ssl: false, connectTimeoutMs: 5000, queryTimeoutMs: 30000, maxRows: 1000, maxResultBytes: 1048576 },
  mysql: { host: "localhost", port: 3306, database: "", username: "root", ssl: false, connectTimeoutMs: 5000, queryTimeoutMs: 30000, maxRows: 1000, maxResultBytes: 1048576 },
};

export function DataSourceList() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [items, setItems] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DataSource | "new">();
  const [testing, setTesting] = useState<string>();

  async function load() {
    if (!projectId) return;
    setLoading(true);
    try { setItems(await api.dataSources(projectId)); }
    catch { message.error(t("dataSources.loadFailed")); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function test(item: DataSource) {
    if (!projectId) return;
    setTesting(item.id);
    try {
      const result = await api.testDataSource(projectId, item.id);
      message.success(t("dataSources.testPassed", { duration: result.durationMs.toFixed(1) }));
    } catch (error) { message.error(apiMessage(error) ?? t("dataSources.testFailed")); }
    finally { setTesting(undefined); }
  }

  async function remove(item: DataSource) {
    if (!projectId) return;
    let usage: DataSourceUsage;
    try { usage = await api.dataSourceUsage(projectId, item.id); }
    catch { message.error(t("dataSources.usageFailed")); return; }
    const references = [
      ...(usage.sqlDefinitions ?? []).map((sql) => t("dataSources.usageSql", { name: sql.name })),
      ...(usage.flowNodes ?? []).map((node) => t("dataSources.usageFlow", { flow: node.flowName, node: node.nodeName })),
      ...(usage.flows ?? []).map((flow) => t("dataSources.usageFlowName", { name: flow.name })),
    ];
    Modal.confirm({
      title: t("dataSources.deleteTitle", { name: item.name }),
      content: <div><p>{usage.blocked ? t("dataSources.deleteBlocked") : t("dataSources.deleteHint")}</p>{references.length > 0 && <ul className="usage-list">{references.map((line, index) => <li key={`${line}:${index}`}>{line}</li>)}</ul>}</div>,
      okText: t("action.delete"), cancelText: t("action.cancel"),
      okButtonProps: { danger: true, disabled: usage.blocked },
      onOk: async () => { await api.deleteDataSource(projectId, item.id); await load(); message.success(t("dataSources.deleted")); },
    });
  }

  return <main className="content">
    <div className="page-head">
      <div><h1>{t("dataSources.title")}</h1><p>{t("dataSources.hint")}</p></div>
      <button className="btn btn-primary btn-with-icon" onClick={() => setEditing("new")}><Plus size={14} />{t("dataSources.create")}</button>
    </div>
    {loading ? <p className="muted">{t("common.loading")}</p> : items.length ? <div className="table-scroll"><table className="grid data-source-grid">
      <thead><tr><th>{t("dataSources.name")}</th><th>{t("dataSources.host")}</th><th>{t("dataSources.database")}</th><th>{t("dataSources.user")}</th><th>{t("dataSources.ssl")}</th><th className="col-actions" /></tr></thead>
      <tbody>{items.map((item) => <tr key={item.id} data-clickable onClick={() => navigate(`/projects/${projectId}/data-sources/${item.id}`)}>
        <td><strong>{item.name}</strong><span className="resource-type mono">{item.type}</span></td>
        <td className="mono">{item.config.host}:{item.config.port}</td>
        <td className="mono">{item.config.database}</td>
        <td className="mono">{item.config.username}</td>
        <td>{item.config.ssl ? t("common.yes") : t("common.no")}</td>
        <td className="col-actions"><div className="row-actions" onClick={(event) => event.stopPropagation()}>
          <IconButton icon={<Cable size={14} />} label={t("dataSources.testConnection")} disabled={testing === item.id} onClick={() => void test(item)} />
          <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => setEditing(item)} />
          <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => void remove(item)} />
        </div></td>
      </tr>)}</tbody>
    </table></div> : <Empty title={t("dataSources.emptyTitle")} hint={t("dataSources.emptyHint")} action={<button className="btn btn-primary" onClick={() => setEditing("new")}>{t("dataSources.create")}</button>} />}
    <DataSourceDrawer projectId={projectId!} source={editing} onClose={() => setEditing(undefined)} onSaved={async (saved) => { setEditing(undefined); await load(); if (editing === "new") navigate(`/projects/${projectId}/data-sources/${saved.id}`); }} />
  </main>;
}

export function DataSourceDrawer({ projectId, source, onClose, onSaved }: { projectId: string; source?: DataSource | "new"; onClose: () => void; onSaved: (source: DataSource) => void | Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [type, setType] = useState<DataSourceType>("postgresql");
  const [config, setConfig] = useState<DataSourceConfig>(DEFAULT_CONFIGS.postgresql);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!source) return;
    setName(source === "new" ? "" : source.name);
    setType(source === "new" ? "postgresql" : source.type);
    setConfig(source === "new" ? DEFAULT_CONFIGS.postgresql : source.config);
    setPassword("");
    setClearPassword(false);
  }, [source]);

  function patch<K extends keyof DataSourceConfig>(key: K, value: DataSourceConfig[K]) { setConfig((current) => ({ ...current, [key]: value })); }

  function changeType(next: DataSourceType) {
    setType(next);
    /* A fresh source swaps to the type's full default form; an existing source
       keeps its values and only adopts the new type's port so a name-only edit
       cannot silently reset the saved connection. */
    if (!source || source === "new") setConfig(DEFAULT_CONFIGS[next]);
    else setConfig((current) => ({ ...current, port: DEFAULT_CONFIGS[next].port }));
  }

  async function save() {
    if (!source || !name.trim() || !config.host.trim() || !config.database.trim() || !config.username.trim()) { message.error(t("dataSources.required")); return; }
    const input: DataSourceInput = { name: name.trim(), type, config };
    if (clearPassword) input.password = null;
    else if (password) input.password = password;
    setSaving(true);
    try {
      const saved = source === "new" ? await api.createDataSource(projectId, input) : await api.updateDataSource(projectId, source.id, input);
      message.success(t(source === "new" ? "dataSources.created" : "dataSources.updated"));
      await onSaved(saved);
    } catch (error) { message.error(apiMessage(error) ?? t("dataSources.saveFailed")); }
    finally { setSaving(false); }
  }

  return <Drawer title={source === "new" ? t("dataSources.create") : t("dataSources.editTitle")} open={Boolean(source)} onClose={onClose} width={640} footer={<div className="drawer-actions"><button className="btn" onClick={onClose}>{t("action.cancel")}</button><button className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "…" : t("action.save")}</button></div>}>
    <div className="form-grid">
      <label className="field field-wide"><span>{t("dataSources.name")}</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
      <label className="field"><span>{t("dataSources.type")}</span><Select value={type} onChange={(value) => changeType(value as DataSourceType)} options={DATA_SOURCE_TYPES.map((item) => ({ value: item.value, label: item.label }))} style={{ width: "100%" }} /></label>
      <label className="field"><span>{t("dataSources.host")}</span><input className="input mono" value={config.host} onChange={(event) => patch("host", event.target.value)} /></label>
      <NumberField label={t("dataSources.port")} value={config.port} onChange={(value) => patch("port", value)} />
      <label className="field"><span>{t("dataSources.database")}</span><input className="input mono" value={config.database} onChange={(event) => patch("database", event.target.value)} /></label>
      <label className="field"><span>{t("dataSources.user")}</span><input className="input mono" value={config.username} onChange={(event) => patch("username", event.target.value)} /></label>
      <label className="field"><span>{t("dataSources.password")}</span><input className="input mono" type="password" value={password} disabled={clearPassword} onChange={(event) => setPassword(event.target.value)} placeholder={source !== "new" && source?.passwordConfigured ? t("dataSources.passwordKeep") : ""} autoComplete="new-password" /></label>
      {source !== "new" && source?.passwordConfigured && <label className="check-field field-wide"><input type="checkbox" checked={clearPassword} onChange={(event) => { setClearPassword(event.target.checked); if (event.target.checked) setPassword(""); }} />{t("dataSources.clearPassword")}</label>}
      <label className="check-field field-wide"><input type="checkbox" checked={config.ssl} onChange={(event) => patch("ssl", event.target.checked)} />{t("dataSources.useSsl")}</label>
      <NumberField label={t("dataSources.connectTimeout")} value={config.connectTimeoutMs} onChange={(value) => patch("connectTimeoutMs", value)} />
      <NumberField label={t("dataSources.queryTimeout")} value={config.queryTimeoutMs} onChange={(value) => patch("queryTimeoutMs", value)} />
      <NumberField label={t("dataSources.maxRows")} value={config.maxRows} onChange={(value) => patch("maxRows", value)} />
      <NumberField label={t("dataSources.maxBytes")} value={config.maxResultBytes} onChange={(value) => patch("maxResultBytes", value)} />
    </div>
    <p className="form-note">{t("dataSources.passwordNote")}</p>
  </Drawer>;
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="field"><span>{label}</span><input className="input mono" type="number" min={1} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

export function apiMessage(error: unknown) { return (error as { response?: { data?: { message?: string } } })?.response?.data?.message; }
