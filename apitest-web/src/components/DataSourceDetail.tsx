import { useCallback, useEffect, useState } from "react";
import { Drawer, Modal, Select, message } from "antd";
import Editor from "@monaco-editor/react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Cable, Clock, History, Link2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, sqlQuickCallBaseUrl, sqlQuickCallCurl, type DataSource, type DataSourceOperation, type DataSourceType, type SqlDefinition, type SqlDefinitionInput, type SqlExecutionHistory, type SqlExecutionResult, type SqlParameter, type SqlParameterType } from "../api";
import { defaultOperationText, formatOperation, operationLabelFromText, operationTemplates } from "../operationTemplates";
import { useThemeMode } from "../theme";
import { useCanWrite } from "../hooks/useMyRole";
import { Empty, PageToolbar, RESULT_DRAWER_WIDTH } from "../ui";
import { DataSourceDrawer, apiMessage } from "./DataSourceList";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer";
import { DatabaseResult } from "./DatabaseResult";
import { IconButton } from "./IconButton";

const PARAM_TYPES: SqlParameterType[] = ["string", "number", "boolean", "date", "json"];
const SQL_TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

/* 与后端 lib/adapters/skeleton.ts 同一份词法规则：把字符串字面量、引号标识符与各类注释
   抹成空格，返回「可执行 SQL」骨架。注释/字符串里的 {{name}} 是数据不是绑定点——提取
   参数定义时绝不能把它们当命名参数捡起来。 */
function sqlSkeleton(sql: string): string {
  let out = ""; let i = 0;
  const isQuote = (char: string) => char === "'" || char === '"' || char === "`";
  const blank = (length: number) => { out += " ".repeat(length); };
  while (i < sql.length) {
    const char = sql[i]; const next = sql[i + 1];
    if (isQuote(char)) {
      const quote = char; blank(1); i += 1;
      while (i < sql.length) {
        blank(1);
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { blank(1); i += 2; continue; }
          i += 1; break;
        }
        i += 1;
      }
      continue;
    }
    if (char === "[") {
      blank(1); i += 1;
      while (i < sql.length) {
        blank(1);
        if (sql[i] === "]") {
          if (sql[i + 1] === "]") { blank(1); i += 2; continue; }
          i += 1; break;
        }
        i += 1;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      blank(2); i += 2;
      while (i < sql.length && sql[i] !== "\n") { blank(1); i += 1; }
      continue;
    }
    if (char === "#") {
      while (i < sql.length && sql[i] !== "\n") { blank(1); i += 1; }
      continue;
    }
    if (char === "/" && next === "*") {
      blank(2); i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) { out += sql[i] === "\n" ? "\n" : " "; i += 1; }
      if (i < sql.length) { blank(2); i += 2; }
      continue;
    }
    if (char === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        const tag = match[0]; blank(tag.length); i += tag.length;
        const end = sql.indexOf(tag, i);
        const length = end < 0 ? sql.length - i : end + tag.length - i;
        blank(length); i += length; continue;
      }
    }
    out += char; i += 1;
  }
  return out;
}

/* 从 SQL 里提取命名参数：先抹掉字符串/标识符/注释，再在可执行部分找 {{name}}，
   按出现顺序去重返回。表名/列名等被注释掉的 {{xx}} 一律不捡。 */
function detectNamedParams(sql: string): string[] {
  const skeleton = sqlSkeleton(sql);
  const names: string[] = [];
  let match: RegExpExecArray | null;
  SQL_TOKEN.lastIndex = 0;
  while ((match = SQL_TOKEN.exec(skeleton)) !== null) {
    const token = skeleton.slice(match.index, SQL_TOKEN.lastIndex);
    if (!token.includes("{")) continue;
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/* 把 SQL 里检测到的命名与手动定义合并，目标是让「参数定义」跟着 {{name}} 走：
   - 仍被引用的（含名字在 SQL 里）：保留,带上既有类型/必填/默认值；
   - 曾经定义过、还没来得及配置（保持默认 string / 非必填 / 无默认值）但现在 SQL 已
     不引用的：清掉——它只是一次误判残留，留着会误导试跑区；
   - 已手动配置过（改了类型 / 勾了必填 / 填了默认值）但 SQL 不再引用的：保留——用户
     可能在收尾前临时移走再贴回，不能因打字中间态丢配置；
   - SQL 新出现的名字：以默认 string 定义追加,不重复。 */
function syncParams(current: SqlParameter[], names: string[]): SqlParameter[] {
  const referenced = new Set(names);
  const kept = current.filter((param) => {
    const name = param.name.trim();
    /* 空名字的行是用户刚点「添加参数」还没填——不自动删。 */
    if (!name) return true;
    /* 仍在 SQL 里引用的保留（配置原样带上）。 */
    if (referenced.has(name)) return true;
    /* 已手动配置过的保留——用户可能在收尾前临时移走再贴回，不能因打字中间态丢配置。 */
    return param.type !== "string" || param.required || param.defaultValue !== undefined;
  });
  const existing = new Set(kept.map((param) => param.name.trim()).filter(Boolean));
  for (const name of names) {
    if (existing.has(name)) continue;
    kept.push({ name, type: "string", required: false });
    existing.add(name);
  }
  return kept;
}

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
  const [copyingCurl, setCopyingCurl] = useState(false);
  const [result, setResult] = useState<SqlExecutionResult>();
  const [error, setError] = useState<string>();
  /* SQL 定义的版本历史入口（P10-6）：与数据源本体分开的另一个资产。 */
  const [sqlHistoryOpen, setSqlHistoryOpen] = useState(false);
  /* 交互式查询面板的执行历史（P2-1 增量）：按 (本人, 数据源) 归属，与上面的「版本历史」
     是两码事——版本历史是这条定义内容的序列，执行历史是这个数据源上跑过的 ad-hoc 查询。 */
  const [execHistoryOpen, setExecHistoryOpen] = useState(false);

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

  /* 从执行历史回填一条到编辑器（P2-1 增量）：SQL、语句类型、参数定义一并带回，试跑值
     按名回灌（历史里存的是当时传入的字面量）。只对关系型数据源可用——mongo/redis 不落历史。 */
  function applyHistory(item: SqlExecutionHistory) {
    setDraft((current) => ({ ...current, statementType: item.statementType, sql: item.sql, params: item.params }));
    setValues(Object.fromEntries(Object.entries(item.values ?? {}).map(([name, value]) => [name, stringifyValue(value)])));
    setResult(undefined); setError(undefined);
    setExecHistoryOpen(false);
    message.success(t("dataSources.execHistoryReused"));
  }

  /**
   * 复制一条可直接运行的 cURL：服务端用本人 API 密钥把这条定义编成调用令牌（`{projectId,
   * sqlId}` 加密），前端拼成 `curl -X POST '<url>' -H 'Authorization: ApiKey <keyId>.<token>'
   * -d '{"param":{...}}'`。凭据在请求头、入参在请求体（用当前试跑值做模板，可动态改），
   * 根地址随 curl 一起透出（取自 `VITE_API_BASE_URL`，未配置时回退当前来源 3000 端口）。
   * 未设密钥时服务端回 2002，翻成「去个人中心生成」的引导。只对已保存的定义可用。
   */
  async function copyQuickCallCurl() {
    if (!source || source === "new") return;
    setCopyingCurl(true);
    try {
      const built = await api.buildSqlQuickCall(projectId, source.id);
      /* body 模板：定义的每个参数名一列（带上当前试跑值），用户复制后按需改。 */
      const param = parameterValues(draft.params, values);
      await writeClipboard(sqlQuickCallCurl(built, param));
      message.success(t("sqlQuickCall.curlCopied", { base: sqlQuickCallBaseUrl() }));
    } catch (nextError) {
      message.error(apiMessage(nextError) ?? t("sqlQuickCall.urlFailed"));
    } finally { setCopyingCurl(false); }
  }

  const templates = operationTemplates(sourceType);
  /* 受控下拉框：重新打开一条已保存的定义时要能看出它是哪种操作，而不是一个空占位符。
     跟着编辑器文本走，所以手改 JSON 也会同步。 */
  const currentOperation = operationLabelFromText(operationText);

  return <Drawer title={source === "new" ? t("dataSources.createSql") : t("dataSources.editSql")} open={open} onClose={() => { setSqlHistoryOpen(false); setExecHistoryOpen(false); onClose(); }} width={RESULT_DRAWER_WIDTH} extra={source && source !== "new" ? <button className="btn btn-small btn-with-icon" onClick={() => setSqlHistoryOpen(true)}><History size={14} />{t("version.history")}</button> : undefined} footer={<div className="drawer-actions"><button className="btn" onClick={onClose}>{t("action.cancel")}</button><button className="btn btn-primary" disabled={saving || !source} onClick={() => void save()}>{saving ? "…" : t("action.save")}</button></div>}>
    {!source && open ? <p className="muted">{t("common.loading")}</p> : <>
      <div className="form-grid">
        <label className="field"><span>{t("dataSources.sqlName")}</span><input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoFocus /></label>
        {kind === "sql" ? <label className="field"><span>{t("dataSources.statementType")}</span><Select value={draft.statementType ?? "query"} onChange={(statementType) => setDraft({ ...draft, statementType })} options={[{ value: "query", label: t("dataSources.query") }, { value: "command", label: t("dataSources.command") }]} style={{ width: "100%" }} /></label> : <label className="field"><span>{t("dataSources.opType")}</span><Select value={currentOperation} placeholder={t("dataSources.opTemplate")} onChange={(label) => { const picked = templates.find((tpl) => tpl.label === label); if (picked) setOperationText(formatOperation(picked.operation)); }} options={templates.map((tpl) => ({ value: tpl.label, label: tpl.label }))} style={{ width: "100%" }} /></label>}
        <label className="field field-wide"><span>{t("dataSources.description")}</span><input className="input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      </div>
      {kind === "sql" ? <>
        <h3 className="subhead">SQL</h3>
        <div className="script-code sql-editor"><Editor height="250px" language="sql" theme={mode === "dark" ? "vs-dark" : "light"} value={draft.sql ?? ""} onChange={(sql) => setDraft({ ...draft, sql: sql ?? "", params: syncParams(draft.params, detectNamedParams(sql ?? "")) })} options={{ minimap: { enabled: false }, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", scrollBeyondLastLine: false, automaticLayout: true }} /></div>
        <p className="form-note">{t("dataSources.sqlSafetyHint")}</p>
        <p className="form-note">{t("dataSources.sqlParamHint")}</p>
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
      <section className="panel sql-run-panel"><div className="panel-head"><strong>{t("dataSources.tryRun")}</strong><div className="row-actions">
        {/* 执行历史（P2-1 增量）：只对关系型数据源开——mongo/redis 的 operation 不落这张表。 */}
        {kind === "sql" && <button className="btn btn-with-icon" onClick={() => setExecHistoryOpen(true)}><Clock size={14} />{t("dataSources.execHistory")}</button>}
        {/* 已保存的定义才有 sqlId：把当前入参值烘焙进免登录调用 cURL（AES 加密，密钥在个人中心）。 */}
        <button className="btn btn-with-icon" disabled={copyingCurl || !source || source === "new"} title={!source || source === "new" ? t("sqlQuickCall.urlNeedsSave") : undefined} onClick={() => void copyQuickCallCurl()}><Link2 size={14} />{copyingCurl ? t("action.running") : t("sqlQuickCall.copyCurl")}</button>
        <button className="btn btn-with-icon" disabled={running || (kind === "sql" && !draft.sql?.trim())} onClick={() => void run()}><Play size={14} />{running ? t("action.running") : t("action.run")}</button>
      </div></div><div className="panel-body">
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
    {/* 交互式查询面板的执行历史（P2-1 增量）：只对关系型数据源开，点一条回填 SQL 到编辑器。 */}
    {kind === "sql" && <SqlHistoryDrawer projectId={projectId} dataSourceId={dataSourceId} open={execHistoryOpen} onClose={() => setExecHistoryOpen(false)} onPick={applyHistory} />}
  </Drawer>;
}

/**
 * 执行历史抽屉（P2-1 增量）：本人在此数据源跑过的 /query，倒序分页。点一条把 SQL 回填到
 * 编辑器（onPick）；`historyTruncated` 徽标标注预览这一层被截过。清空只清本人本数据源的历史。
 */
function SqlHistoryDrawer({ projectId, dataSourceId, open, onClose, onPick }: { projectId: string; dataSourceId: string; open: boolean; onClose: () => void; onPick: (item: SqlExecutionHistory) => void }) {
  const { t } = useTranslation();
  const canWrite = useCanWrite();
  const [items, setItems] = useState<SqlExecutionHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState<string>();

  const load = useCallback(async (nextPage: number) => {
    setLoading(true);
    try {
      const result = await api.sqlHistory(projectId, dataSourceId, { page: nextPage, pageSize: 20 });
      /* 翻页累加（「加载更多」而非分页器）：ad-hoc 历史多是往下翻着找上次那条，接续更顺手。 */
      setItems((current) => nextPage === 1 ? result.items : [...current, ...result.items]);
      setPage(result.page);
      setTotal(result.total);
    } catch { message.error(t("dataSources.execHistoryLoadFailed")); }
    finally { setLoading(false); }
  }, [projectId, dataSourceId, t]);

  useEffect(() => { if (open) { setExpanded(undefined); void load(1); } }, [open, load]);

  function clearHistory() {
    Modal.confirm({
      title: t("dataSources.execHistoryClearTitle"), content: t("dataSources.execHistoryClearHint"),
      okText: t("dataSources.execHistoryClear"), cancelText: t("action.cancel"), okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.clearSqlHistory(projectId, dataSourceId);
          setItems([]); setTotal(0); setPage(1);
          message.success(t("dataSources.execHistoryCleared"));
        } catch (error) { message.error(apiMessage(error) ?? t("dataSources.execHistoryClearFailed")); throw error; }
      },
    });
  }

  return <Drawer
    title={t("dataSources.execHistory")}
    open={open}
    onClose={onClose}
    width={RESULT_DRAWER_WIDTH}
    extra={canWrite && items.length ? <button className="btn btn-small btn-with-icon" onClick={clearHistory}><Trash2 size={14} />{t("dataSources.execHistoryClear")}</button> : undefined}
  >
    <p className="form-note">{t("dataSources.execHistoryHint")}</p>
    {items.length ? <>
      <div className="version-list">
        {items.map((item) => {
          const isOpen = expanded === item.id;
          return <div key={item.id} className="sql-history-row" data-clickable onClick={() => onPick(item)}>
            <div className="sql-history-head">
              {/* 语义色只用在状态上（Quiet Console 规则 2）：成功=通过绿，失败=失败红。 */}
              <span className="status mono" data-status={item.status === "success" ? "pass" : "fail"}>{item.status === "success" ? t("dataSources.execHistoryStatusSuccess") : t("dataSources.execHistoryStatusError")}</span>
              <span className="chip mono">{item.statementType}</span>
              {item.status === "success" && <span className="mono muted">{t("dataSources.rowCount", { count: item.rowCount ?? 0 })} · {(item.durationMs ?? 0).toFixed(1)} ms</span>}
              {item.truncated && <span className="chip-warn mono">{t("dataSources.truncated")}</span>}
              {item.historyTruncated && <span className="chip-warn mono">{t("dataSources.execHistoryPreviewTruncated")}</span>}
              <span className="sql-history-time mono muted">{new Date(item.createdAt).toLocaleString()}</span>
            </div>
            <code className="sql-history-sql mono">{item.sql}</code>
            {item.status === "error" && item.error && <pre className="sql-error mono">{item.error}</pre>}
            <div className="row-actions" onClick={(event) => event.stopPropagation()}>
              <button className="btn btn-small" onClick={() => onPick(item)}>{t("dataSources.execHistoryReuse")}</button>
              {/* 预览：复用 DatabaseResult 渲染截断后的小预览（成功且有预览时才给）。 */}
              {item.status === "success" && item.resultPreview && item.resultPreview.length > 0 && <button className="btn btn-small" onClick={() => setExpanded(isOpen ? undefined : item.id)}>{isOpen ? "−" : "+"} {t("dataSources.viewRow")}</button>}
            </div>
            {isOpen && item.status === "success" && item.resultPreview && <div onClick={(event) => event.stopPropagation()}>
              <DatabaseResult result={{ rows: item.resultPreview, rowCount: item.rowCount ?? item.resultPreview.length, truncated: item.historyTruncated || item.truncated, durationMs: item.durationMs ?? 0 }} />
            </div>}
          </div>;
        })}
      </div>
      {items.length < total && <div className="drawer-actions" style={{ justifyContent: "center", marginTop: 12 }}>
        <button className="btn" disabled={loading} onClick={() => void load(page + 1)}>{loading ? "…" : t("dataSources.execHistoryLoadMore")}</button>
      </div>}
    </> : !loading && <Empty title={t("dataSources.execHistoryEmptyTitle")} hint={t("dataSources.execHistoryEmptyHint")} />}
  </Drawer>;
}

/* navigator.clipboard 只在 secure context 存在；本 app 常经 LAN http 访问，textarea 回退
   是主路径而非兼容补丁（与 CopyButton 同一处理）。 */
async function writeClipboard(text: string) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(scratch);
    scratch.select();
    try { document.execCommand("copy"); } finally { scratch.remove(); }
  }
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
