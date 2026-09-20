import { useCallback, useEffect, useState } from "react";
import { Drawer, Modal, Select, message } from "antd";
import Editor from "@monaco-editor/react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Cable, History, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, type DataSource, type DataSourceOperation, type DataSourceType, type SqlDefinition, type SqlDefinitionInput, type SqlExecutionResult, type SqlParameter, type SqlParameterType } from "../api";
import { defaultOperationText, formatOperation, operationLabelFromText, operationTemplates } from "../operationTemplates";
import { useThemeMode } from "../theme";
import { useCanWrite } from "../hooks/useMyRole";
import { Empty, PageToolbar } from "../ui";
import { DataSourceDrawer, apiMessage } from "./DataSourceList";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer";
import { DatabaseResult } from "./DatabaseResult";
import { IconButton } from "./IconButton";

const PARAM_TYPES: SqlParameterType[] = ["string", "number", "boolean", "date", "json"];

export function DataSourceDetail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projectId, dataSourceId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "sql" ? "sql" : "config";
  const editSql = searchParams.get("editSql") ?? undefined;
  /* viewer：测试/编辑/新建 SQL/删除入口全藏（P6-4）；连接配置与 SQL 清单照读。 */
  const canWrite = useCanWrite();
  const [source, setSource] = useState<DataSource>();
  const [definitions, setDefinitions] = useState<SqlDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSource, setEditingSource] = useState(false);
  const [testing, setTesting] = useState(false);
  /* 版本历史抽屉（P10-6）：数据源本体的连接配置快照（密文只记键名、绝不含值）。SQL
     定义有自己的入口（编辑抽屉的 extra），因为它是另一张表的另一行资源。 */
  const [changeHistoryOpen, setChangeHistoryOpen] = useState(false);

  async function load() {
    if (!projectId || !dataSourceId) return;
    setLoading(true);
    try {
      const [nextSource, nextDefinitions] = await Promise.all([api.dataSource(projectId, dataSourceId), api.sqlDefinitions(projectId, dataSourceId)]);
      setSource(nextSource);
      setDefinitions(nextDefinitions);
    } catch { message.error(t("dataSources.loadFailed")); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [projectId, dataSourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  function setUrl(next: { tab?: "config" | "sql"; editSql?: string }) {
    const params = new URLSearchParams(searchParams);
    if (next.tab) params.set("tab", next.tab);
    if (next.editSql) params.set("editSql", next.editSql); else params.delete("editSql");
    setSearchParams(params, { replace: true });
  }

  async function testConnection() {
    if (!projectId || !dataSourceId) return;
    setTesting(true);
    try {
      const result = await api.testDataSource(projectId, dataSourceId);
      message.success(t("dataSources.testPassed", { duration: result.durationMs.toFixed(1) }));
    } catch (error) { message.error(apiMessage(error) ?? t("dataSources.testFailed")); }
    finally { setTesting(false); }
  }

  async function removeDefinition(definition: SqlDefinition) {
    if (!projectId) return;
    Modal.confirm({
      title: t("dataSources.deleteSqlTitle", { name: definition.name }), content: t("dataSources.deleteSqlHint"),
      okText: t("action.delete"), cancelText: t("action.cancel"), okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteSqlDefinition(projectId, definition.id);
          await load();
          message.success(t("dataSources.sqlDeleted"));
        } catch (error) {
          /* A definition a flow node or场景步骤 references comes back 409 with the
             list; without this the dialog closed and nothing said why. */
          message.error(apiMessage(error) ?? t("dataSources.sqlDeleteFailed"));
          /* Rethrown so antd keeps the dialog open on a refusal. */
          throw error;
        }
      },
    });
  }

  if (loading) return <main className="content"><p className="muted">{t("common.loading")}</p></main>;
  if (!source) return <main className="content"><Empty title={t("dataSources.missingTitle")} hint={t("dataSources.missingHint")} action={<button className="btn btn-primary" onClick={() => navigate(`/projects/${projectId}/data-sources`)}>{t("dataSources.backToList")}</button>} /></main>;

  return <main className="content content-split">
    <PageToolbar>
    <div className="page-head">
      <div><div className="title-row"><h1>{source.name}</h1><span className="chip mono">{source.type}</span></div><p className="mono">{source.config.host}:{source.config.port}/{source.config.database}</p></div>
      <div className="topbar-actions">
        {canWrite && <button className="btn btn-with-icon" disabled={testing} onClick={() => void testConnection()}><Cable size={14} />{testing ? t("action.running") : t("dataSources.testConnection")}</button>}
        {canWrite && <button className="btn btn-with-icon" onClick={() => setEditingSource(true)}><Pencil size={14} />{t("action.edit")}</button>}
        {canWrite && <button className="btn btn-with-icon" onClick={() => setChangeHistoryOpen(true)}><History size={14} />{t("version.history")}</button>}
      </div>
    </div>
    <div className="tabs detail-tabs" role="tablist">
      <button role="tab" aria-selected={tab === "config"} className={`tab${tab === "config" ? " is-active" : ""}`} onClick={() => setUrl({ tab: "config" })}>{t("dataSources.connectionTab")}</button>
      <button role="tab" aria-selected={tab === "sql"} className={`tab${tab === "sql" ? " is-active" : ""}`} onClick={() => setUrl({ tab: "sql" })}>{t("dataSources.sqlTab")}<span className="tab-count mono">{definitions.length}</span></button>
    </div>
    </PageToolbar>

    <div className="list-card">
    <div className="list-scroll">
    {tab === "config" ? <section className="panel detail-panel"><div className="panel-head"><strong>{t("dataSources.connectionConfig")}</strong><span className="mono muted">{source.passwordConfigured ? t("dataSources.passwordConfigured") : t("dataSources.passwordMissing")}</span></div><div className="panel-body"><dl className="definition-grid data-source-definition">
      <Row label={t("dataSources.host")} value={`${source.config.host}:${source.config.port}`} mono />
      <Row label={t("dataSources.database")} value={source.config.database} mono />
      <Row label={t("dataSources.user")} value={source.config.username} mono />
      <Row label={t("dataSources.ssl")} value={source.config.ssl ? t("common.yes") : t("common.no")} />
      <Row label={t("dataSources.connectTimeout")} value={`${source.config.connectTimeoutMs} ms`} mono />
      <Row label={t("dataSources.queryTimeout")} value={`${source.config.queryTimeoutMs} ms`} mono />
      <Row label={t("dataSources.maxRows")} value={String(source.config.maxRows)} mono />
      <Row label={t("dataSources.maxBytes")} value={formatBytes(source.config.maxResultBytes)} mono />
    </dl></div></section> : <section className="sql-section">
      <div className="section-toolbar"><div><h2>{t("dataSources.namedSql")}</h2><p>{t("dataSources.namedSqlHint")}</p></div>{canWrite && <button className="btn btn-primary btn-with-icon" onClick={() => setUrl({ tab: "sql", editSql: "new" })}><Plus size={14} />{t("dataSources.createSql")}</button>}</div>
      {definitions.length ? <div className="table-scroll"><table className="grid sql-definition-grid"><thead><tr><th>{t("dataSources.sqlName")}</th><th>{t("dataSources.statementType")}</th><th>{t("dataSources.parameters")}</th><th>{t("common.updatedAt")}</th><th className="col-actions" /></tr></thead><tbody>
        {definitions.map((definition) => <tr key={definition.id} data-clickable onClick={() => setUrl({ tab: "sql", editSql: definition.id })}>
          <td><strong>{definition.name}</strong>{definition.description && <span className="cell-description truncate">{definition.description}</span>}</td>
          <td className="mono">{definition.kind !== "sql" ? definition.kind : definition.statementType}</td><td className="mono">{definition.params.length}</td><td className="mono muted">{new Date(definition.updatedAt).toLocaleString()}</td>
          <td className="col-actions">{canWrite && <div className="row-actions" onClick={(event) => event.stopPropagation()}><IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => setUrl({ tab: "sql", editSql: definition.id })} /><IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => void removeDefinition(definition)} /></div>}</td>
        </tr>)}
      </tbody></table></div> : <Empty title={t("dataSources.sqlEmptyTitle")} hint={t("dataSources.sqlEmptyHint")} action={canWrite ? <button className="btn btn-primary" onClick={() => setUrl({ tab: "sql", editSql: "new" })}>{t("dataSources.createSql")}</button> : undefined} />}
    </section>}
    </div>
    </div>

    <DataSourceDrawer projectId={projectId!} source={editingSource ? source : undefined} onClose={() => setEditingSource(false)} onSaved={(saved) => { setSource(saved); setEditingSource(false); }} />
    <SqlDefinitionDrawer projectId={projectId!} dataSourceId={dataSourceId!} sourceType={source.type} source={editSql === "new" ? "new" : definitions.find((item) => item.id === editSql)} open={Boolean(editSql)} onClose={() => setUrl({ tab: "sql" })} onSaved={async () => { setUrl({ tab: "sql" }); await load(); }} />
    {/* 版本历史（P10-6）：数据源连接配置快照，密文绝不含值；回滚不动密文列。回滚后重拉。 */}
    <VersionHistoryDrawer
      projectId={projectId!}
      assetType="data_source"
      assetId={dataSourceId!}
      name={source.name}
      open={changeHistoryOpen}
      onClose={() => setChangeHistoryOpen(false)}
      onRolledBack={() => void load()}
    />
  </main>;
}

function SqlDefinitionDrawer({ projectId, dataSourceId, sourceType, source, open, onClose, onSaved }: { projectId: string; dataSourceId: string; sourceType: DataSourceType; source?: SqlDefinition | "new"; open: boolean; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const mode = useThemeMode();
  const kind: "sql" | "mongo" | "redis" = sourceType === "mongodb" ? "mongo" : sourceType === "redis" ? "redis" : "sql";
  const [draft, setDraft] = useState<SqlDefinitionInput>({ name: "", description: "", statementType: "query", sql: "", params: [] });
  const [operationText, setOperationText] = useState(defaultOperationText(sourceType));
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SqlExecutionResult>();
  const [error, setError] = useState<string>();
  /* SQL 定义的版本历史入口（P10-6）：与数据源本体分开的另一个资产。 */
  const [sqlHistoryOpen, setSqlHistoryOpen] = useState(false);

  /* 把一条定义（或 "new"）灌进草稿。首次打开与「版本回滚后重拉这一条」（P10-6）复用它，
     好让回滚只刷新当前抽屉的表单、不连累外层数据源详情页。 */
  const resetFrom = useCallback((from: SqlDefinition | "new" | undefined) => {
    if (kind !== "sql") {
      const operation = from && from !== "new" ? from.operation : undefined;
      setDraft({ name: from && from !== "new" ? from.name : "", description: from && from !== "new" ? from.description : "", params: from && from !== "new" ? from.params : [] });
      setOperationText(operation ? formatOperation(operation) : defaultOperationText(sourceType));
      setValues(Object.fromEntries((from && from !== "new" ? from.params : []).map((param) => [param.name, param.defaultValue === undefined ? "" : stringifyValue(param.defaultValue)])));
      setResult(undefined); setError(undefined);
      return;
    }
    const next = from && from !== "new" ? { name: from.name, description: from.description, statementType: from.statementType ?? "query", sql: from.sql ?? "", params: from.params } : { name: "", description: "", statementType: "query" as const, sql: "", params: [] };
    setDraft(next);
    setValues(Object.fromEntries(next.params.map((param) => [param.name, param.defaultValue === undefined ? "" : stringifyValue(param.defaultValue)])));
    setResult(undefined); setError(undefined);
  }, [kind, sourceType]);

  useEffect(() => { if (open) resetFrom(source); }, [open, source, resetFrom]);

  /* 回滚后只重拉这一条定义并回灌表单，抽屉保持打开（不走 onSaved，那会关抽屉退回清单）。 */
  async function reloadDefinition() {
    if (!source || source === "new") return;
    try { resetFrom(await api.sqlDefinition(projectId, source.id)); }
    catch { message.error(t("dataSources.loadFailed")); }
  }

  function patchParam(index: number, patch: Partial<SqlParameter>) { setDraft((current) => ({ ...current, params: current.params.map((param, at) => at === index ? { ...param, ...patch } : param) })); }

  function parseOperation(): DataSourceOperation | undefined {
    try {
      const parsed = JSON.parse(operationText);
      if (!parsed || typeof parsed !== "object") { message.error(t("dataSources.opJsonInvalid")); return undefined; }
      return parsed;
    } catch { message.error(t("dataSources.opJsonInvalid")); return undefined; }
  }

  async function save() {
    if (!draft.name.trim()) { message.error(t("dataSources.sqlRequired")); return; }
    const names = draft.params.map((param) => param.name.trim());
    if (names.some((name) => !name) || new Set(names).size !== names.length) { message.error(t("dataSources.sqlParamsInvalid")); return; }
    if (kind !== "sql") {
      const operation = parseOperation();
      if (!operation) return;
      setSaving(true);
      try {
        const input: SqlDefinitionInput = { name: draft.name.trim(), description: draft.description.trim(), kind, operation, params: draft.params.map((param) => ({ ...param, defaultValue: parseDefaultValue(param) })) };
        if (source === "new") await api.createSqlDefinition(projectId, dataSourceId, input);
        else if (source) await api.updateSqlDefinition(projectId, source.id, input);
        message.success(t(source === "new" ? "dataSources.sqlCreated" : "dataSources.sqlUpdated"));
        await onSaved();
      } catch (nextError) { message.error(apiMessage(nextError) ?? t("dataSources.sqlSaveFailed")); }
      finally { setSaving(false); }
      return;
    }
    if (!draft.sql?.trim()) { message.error(t("dataSources.sqlRequired")); return; }
    setSaving(true);
    try {
      const input: SqlDefinitionInput = { name: draft.name.trim(), description: draft.description.trim(), statementType: draft.statementType ?? "query", sql: draft.sql.trim(), params: draft.params.map((param) => ({ ...param, defaultValue: parseDefaultValue(param) })) };
      if (source === "new") await api.createSqlDefinition(projectId, dataSourceId, input);
      else if (source) await api.updateSqlDefinition(projectId, source.id, input);
      message.success(t(source === "new" ? "dataSources.sqlCreated" : "dataSources.sqlUpdated"));
      await onSaved();
    } catch (nextError) { message.error(apiMessage(nextError) ?? t("dataSources.sqlSaveFailed")); }
    finally { setSaving(false); }
  }

  async function run() {
    if (kind === "sql" && !draft.sql?.trim()) return;
    const valuesInput = parameterValues(draft.params, values);
    setRunning(true); setResult(undefined); setError(undefined);
    try {
      if (kind !== "sql") {
        const operation = parseOperation();
        if (!operation) { setRunning(false); return; }
        setResult(await api.queryDataSource(projectId, dataSourceId, { kind, operation, params: draft.params, values: valuesInput }));
      } else {
        setResult(await api.queryDataSource(projectId, dataSourceId, { sql: draft.sql, statementType: draft.statementType ?? "query", params: draft.params, values: valuesInput }));
      }
    } catch (nextError) { setError(apiMessage(nextError) ?? t("dataSources.queryFailed")); }
    finally { setRunning(false); }
  }

  const templates = operationTemplates(sourceType);
  /* 受控下拉框：重新打开一条已保存的定义时要能看出它是哪种操作，而不是一个空占位符。
     跟着编辑器文本走，所以手改 JSON 也会同步。 */
  const currentOperation = operationLabelFromText(operationText);

  return <Drawer title={source === "new" ? t("dataSources.createSql") : t("dataSources.editSql")} open={open} onClose={() => { setSqlHistoryOpen(false); onClose(); }} width={820} extra={source && source !== "new" ? <button className="btn btn-small btn-with-icon" onClick={() => setSqlHistoryOpen(true)}><History size={14} />{t("version.history")}</button> : undefined} footer={<div className="drawer-actions"><button className="btn" onClick={onClose}>{t("action.cancel")}</button><button className="btn btn-primary" disabled={saving || !source} onClick={() => void save()}>{saving ? "…" : t("action.save")}</button></div>}>
    {!source && open ? <p className="muted">{t("common.loading")}</p> : <>
      <div className="form-grid">
        <label className="field"><span>{t("dataSources.sqlName")}</span><input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoFocus /></label>
        {kind === "sql" ? <label className="field"><span>{t("dataSources.statementType")}</span><Select value={draft.statementType ?? "query"} onChange={(statementType) => setDraft({ ...draft, statementType })} options={[{ value: "query", label: t("dataSources.query") }, { value: "command", label: t("dataSources.command") }]} style={{ width: "100%" }} /></label> : <label className="field"><span>{t("dataSources.opType")}</span><Select value={currentOperation} placeholder={t("dataSources.opTemplate")} onChange={(label) => { const picked = templates.find((tpl) => tpl.label === label); if (picked) setOperationText(formatOperation(picked.operation)); }} options={templates.map((tpl) => ({ value: tpl.label, label: tpl.label }))} style={{ width: "100%" }} /></label>}
        <label className="field field-wide"><span>{t("dataSources.description")}</span><input className="input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      </div>
      {kind === "sql" ? <>
        <h3 className="subhead">SQL</h3>
        <div className="script-code sql-editor"><Editor height="250px" language="sql" theme={mode === "dark" ? "vs-dark" : "light"} value={draft.sql ?? ""} onChange={(sql) => setDraft({ ...draft, sql: sql ?? "" })} options={{ minimap: { enabled: false }, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", scrollBeyondLastLine: false, automaticLayout: true }} /></div>
        <p className="form-note">{t("dataSources.sqlSafetyHint")}</p>
      </> : <>
        <h3 className="subhead">{t("dataSources.operation")}</h3>
        <div className="script-code sql-editor"><Editor height="250px" language="json" theme={mode === "dark" ? "vs-dark" : "light"} value={operationText} onChange={(text) => setOperationText(text ?? "")} options={{ minimap: { enabled: false }, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", scrollBeyondLastLine: false, automaticLayout: true }} /></div>
        <p className="form-note">{t("dataSources.opHint")}</p>
      </>}
      <div className="section-toolbar compact"><h3 className="subhead">{t("dataSources.parameterDefinitions")}</h3><button className="btn btn-small" onClick={() => setDraft({ ...draft, params: [...draft.params, { name: "", type: "string", required: false }] })}>{t("dataSources.addParameter")}</button></div>
      <div className="sql-params">
        {draft.params.map((param, index) => <div className="sql-param-row" key={index}>
          <input className="input mono" value={param.name} onChange={(event) => patchParam(index, { name: event.target.value })} placeholder="userId" />
          <Select value={param.type} onChange={(type) => patchParam(index, { type })} options={PARAM_TYPES.map((value) => ({ value }))} />
          <label className="check-field"><input type="checkbox" checked={param.required} onChange={(event) => patchParam(index, { required: event.target.checked })} />{t("dataSources.requiredParameter")}</label>
          <input className="input mono" value={param.defaultValue === undefined ? "" : stringifyValue(param.defaultValue)} onChange={(event) => patchParam(index, { defaultValue: event.target.value || undefined })} placeholder={t("dataSources.defaultValue")} />
          <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => setDraft({ ...draft, params: draft.params.filter((_, at) => at !== index) })} />
        </div>)}
      </div>
      <section className="panel sql-run-panel"><div className="panel-head"><strong>{t("dataSources.tryRun")}</strong><button className="btn btn-with-icon" disabled={running || (kind === "sql" && !draft.sql?.trim())} onClick={() => void run()}><Play size={14} />{running ? t("action.running") : t("action.run")}</button></div><div className="panel-body">
        {draft.params.length > 0 && <div className="sql-run-values">{draft.params.map((param, index) => <label className="field" key={`${param.name}:${index}`}><span className="mono">{param.name || "—"}</span><input className="input mono" value={values[param.name] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [param.name]: event.target.value }))} placeholder={param.defaultValue === undefined ? "" : stringifyValue(param.defaultValue)} /></label>)}</div>}
        {!result && !error && <p className="form-note">{t("dataSources.tryRunHint")}</p>}
        <DatabaseResult result={result} error={error} />
      </div></section>
    </>}
    {/* SQL 定义的版本历史（P10-6）：已保存的定义才有 assetId。回滚后关闭编辑抽屉并重拉清单。 */}
    {source && source !== "new" && <VersionHistoryDrawer
      projectId={projectId}
      assetType="sql_definition"
      assetId={source.id}
      name={source.name}
      open={sqlHistoryOpen}
      onClose={() => setSqlHistoryOpen(false)}
      onRolledBack={() => void reloadDefinition()}
    />}
  </Drawer>;
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) { return <div className="definition-row"><dt>{label}</dt><dd className={mono ? "mono" : undefined}>{value}</dd></div>; }
function formatBytes(value: number) { return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`; }
function stringifyValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }
function parseDefaultValue(param: SqlParameter) {
  if (param.defaultValue === undefined || typeof param.defaultValue !== "string") return param.defaultValue;
  return parseValue(param.defaultValue, { ...param, defaultValue: undefined });
}
function parameterValues(params: SqlParameter[], values: Record<string, string>) {
  return Object.fromEntries(params.filter((param) => param.name.trim()).map((param) => [param.name, parseValue(values[param.name] ?? "", param)]));
}
function parseValue(value: string, param: SqlParameter): unknown {
  if (!value && param.defaultValue !== undefined) return param.defaultValue;
  if (param.type === "number") return Number(value);
  if (param.type === "boolean") return value === "true";
  if (param.type === "json") { try { return JSON.parse(value); } catch { return value; } }
  return value;
}
