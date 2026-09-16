import { useCallback, useEffect, useMemo, useState } from "react";
import { AutoComplete, Drawer, Modal, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { CopyPlus, Eye, EyeOff, Pencil, Trash2 } from "lucide-react";
import { api, type Environment, type EnvironmentUsage, type RunnerLabelStatus } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useCanManageProject, useCanWrite } from "../hooks/useMyRole";
import { usePageContext } from "../hooks/usePageContext";
import { useProjectStore } from "../stores/projectStore";
import { Empty } from "../ui";
import { CopyButton } from "./CopyButton";
import { IconButton } from "./IconButton";
import { fromPairs, toPairs } from "./KeyValueEditor";
import { PublicScripts } from "./PublicScripts";
import { VariableRowsEditor } from "./VariableRowsEditor";

/** Built-in dynamic variable examples (Spec 2.1.2). Displayed as help, not enforced. */
const BUILTIN_EXAMPLES: [string, string][] = [
  ["{{$timestamp}}", "1723032995123"],
  ["{{$timestamp(s)}}", "1723032995"],
  ["{{$date}}", "2026-08-07"],
  ["{{$date(MM)}}", "08"],
  ["{{$date(YYYYMMDDHHmmss)}}", "20260807181635"],
  ["{{$uuid}}", "v4 UUID"],
  ["{{$randomInt}}", "0 – 999999"],
  ["{{$randomInt(100)}}", "0 – 100"],
  ["{{$randomInt(10,20)}}", "10 – 20"],
  ["{{$randomStr}}", "8 chars (alphanumeric)"],
  ["{{$randomStr(16)}}", "16 chars"],
];

/* ── Variable row types ─────────────────────────────────────────── */

/**
 * 分区标签格式，与服务端 `RUNNER_LABEL_PATTERN` 逐字一致（P2-8）。
 *
 * 前端也校验只是为了当场给提示；服务端那道才是权威的——标签会进 Redis key，绕过界面的
 * 请求同样必须被拒。
 */
const RUNNER_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

type VarRow = {
  key: string;
  value: string;
  /** true = secret; value is the new plaintext to write, or "" to keep existing */
  secret: boolean;
  /** true when this key already exists on the server as a secret */
  existingSecret: boolean;
};

function emptyRow(): VarRow {
  return { key: "", value: "", secret: false, existingSecret: false };
}

function envToRows(env: Environment): VarRow[] {
  const rows: VarRow[] = Object.entries(env.variables).map(([key, value]) => ({
    key, value, secret: false, existingSecret: false,
  }));
  for (const key of env.secretKeys) {
    rows.push({ key, value: "", secret: true, existingSecret: true });
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return rows;
}

function rowsToInput(rows: VarRow[]) {
  const variables: Record<string, string> = {};
  const secrets: Record<string, string | null> = {};
  for (const row of rows) {
    if (!row.key.trim()) continue;
    if (row.secret) {
      /* Only send a value when the user typed one; empty = keep existing. */
      if (row.value.trim()) secrets[row.key.trim()] = row.value;
    } else {
      variables[row.key.trim()] = row.value;
    }
  }
  return { variables, secrets };
}

const PAGE_SIZES = [20, 50, 100];

/* ── Main component ─────────────────────────────────────────────── */

export function Environments() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { environments, defaultEnvironmentId, storePlaintext, reloadEnvironments, updateDefaultEnvironment, updateStorePlaintext } = useProjectStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "scripts" ? "scripts" : "envs";
  /* viewer：环境/脚本的写入口全藏；默认环境与明文开关另按项目管理员收（上面注释）。 */
  const canWrite = useCanWrite();
  const canManage = useCanManageProject();

  /**
   * 管理页自己的分页数据源（服务端分页 + keyword 过滤，与套件列表同款）。
   * store 里的全量列表继续喂各处选择器与「默认环境」下拉——两份数据一个来源，
   * 增删改后两边都刷新。
   */
  const [keyword, setKeyword] = useState("");
  const debouncedKeyword = useDebounced(keyword);
  const [list, setList] = useState<Environment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!projectId || tab !== "envs") return;
    setLoading(true);
    try {
      const result = await api.environmentList(projectId, { keyword: debouncedKeyword, page, pageSize });
      setList(result.items);
      setTotal(result.total);
    } catch {
      message.error(t("environments.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, tab, debouncedKeyword, page, pageSize, t]);

  useEffect(() => { void load(); }, [load]);
  /** 关键字变了从第一页看起：命中项可能在前面的页里。 */
  const filtered = Boolean(debouncedKeyword.trim());

  const [drawerEnv, setDrawerEnv] = useState<Environment | "new">();

  /* 助手页面上下文（P9-4c）：「把当前环境的 baseUrl 换成 stg」指向抽屉里正在编辑的
     环境——只带 id 与名字，secret 值绝不进上下文。 */
  usePageContext({
    page: "environments",
    ...(drawerEnv && drawerEnv !== "new" ? { entities: { environmentId: drawerEnv.id, environmentName: drawerEnv.name }, focus: "environment-editor" } : {}),
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string>();
  const [duplicating, setDuplicating] = useState<string>();
  const [savingDefault, setSavingDefault] = useState(false);
  const [savingPlaintext, setSavingPlaintext] = useState(false);

  /* 分区目录（worker 上报的 ∪ 环境配置的）。拉取失败时静默降级成「只用本项目标签做
     建议」——建议列表缺席不该挡住编辑环境这件事本身。 */
  const [runnerLabels, setRunnerLabels] = useState<RunnerLabelStatus[]>();
  const refreshRunnerLabels = useCallback(() => {
    api.runnerLabels().then(setRunnerLabels).catch(() => setRunnerLabels(undefined));
  }, []);

  /* 进入环境页时拉一次分区目录；抽屉每次打开再补一次——「在线台数」是提示文案的
     依据，拿旧的心跳快照说「没有执行器」会误导刚起完 worker 的用户。 */
  useEffect(() => { if (tab === "envs") refreshRunnerLabels(); }, [tab, refreshRunnerLabels]);

  /* Create is triggered from the shared page head above the tabs, so the
     request has to be handed down to the panel that owns the drawer. */
  const [createScript, setCreateScript] = useState(false);

  /* ── Drawer state ─────────────────────────────────────────────── */
  const [name, setName] = useState("");
  const [rows, setRows] = useState<VarRow[]>([emptyRow()]);
  const [nameError, setNameError] = useState<string>();
  /* 默认请求头（P3-2/6.5 泳道第一层）：与变量分两块编辑。头是「每个请求都加什么」，
     变量是「{{}} 展开成什么」——混在一起用户会往变量里写 X-Env-Tag 然后奇怪它没生效。 */
  const [headerPairs, setHeaderPairs] = useState(toPairs({}));
  /* 执行分区（P2-8）。空串在保存时归一成 default，与服务端同一条规则。 */
  const [runnerLabel, setRunnerLabel] = useState("");
  const [runnerLabelError, setRunnerLabelError] = useState<string>();

  /* 分区标签的候选：worker 上报的分区 ∪ 本项目已用过的标签，只作提示、不作约束。
     标签是「这个系统在哪个网段」的声明，可以先于 worker 存在，所以这里不限制只能从
     候选里选——AutoComplete 单击即列出全部候选，同时仍允许自由输入。候选右侧带上
     在线台数：「无执行器」那一行正是用户选标签前最需要看到的信息。
     `default` 必须在列：它不是「没有分区」而是「平台所在网段」这一个真实选项，藏起来
     会让只有 default 的项目（初装的常态）打开一个空下拉。 */
  const runnerLabelChoices = useMemo(() => {
    const labels = [...new Set([...(runnerLabels ?? []).map((each) => each.label), ...environments.map((env) => env.runnerLabel)])]
      .filter((label) => label)
      .sort();
    const statusOf = (label: string) => runnerLabels?.find((each) => each.label === label);
    return labels.map((label) => {
      const status = statusOf(label);
      const suffix = !status ? "" : status.online > 0
        ? t("environments.partitionOnlineCount", { count: status.online, total: status.total })
        : t("workers.partitionNone");
      return { value: label, label: <span className="mono">{label}{suffix && <span className="muted"> · {suffix}</span>}</span> };
    });
  }, [runnerLabels, environments, t]);

  /* 当前输入的分区有没有在线执行器。目录没拉到（undefined）时一律不提示：提示比缺席
     更糟的场景是分区是新的、worker 正在启动。default 除外——它暗示「回平台网段」，
     而平台网段的 worker 由部署保证，不在环境编辑器的职责里。 */
  const noRunnerForLabel = (label: string) => {
    if (!label || label === "default" || !runnerLabels) return false;
    return runnerLabels.some((each) => each.label === label && each.online === 0);
  };

  function openCreate() {
    refreshRunnerLabels();
    setDrawerEnv("new");
    setName("");
    setRows([emptyRow()]);
    setHeaderPairs(toPairs({}));
    setNameError(undefined);
    setRunnerLabel("");
    setRunnerLabelError(undefined);
  }

  function openEdit(env: Environment) {
    refreshRunnerLabels();
    setDrawerEnv(env);
    setName(env.name);
    setRows([...envToRows(env), emptyRow()]);
    setHeaderPairs(toPairs(env.defaultHeaders));
    setNameError(undefined);
    /* datalist 时代 default 显示为空；现在是下拉里的显式选项，如实显示——「选了
       default 但框是空的」在 AutoComplete 里读起来像没选。保存仍按「空归一成
       default」的规则，两种输入等价。 */
    setRunnerLabel(env.runnerLabel);
    setRunnerLabelError(undefined);
  }

  function closeDrawer() { setDrawerEnv(undefined); }

  /* ── Row editing ──────────────────────────────────────────────── */

  function patchRow(index: number, patch: Partial<VarRow>) {
    setRows((current) => {
      const next = current.map((row, i) => i === index ? { ...row, ...patch } : row);
      /* Auto-append a blank row when the last row gets a key. */
      const last = next[next.length - 1];
      if (last && last.key.trim()) next.push(emptyRow());
      return next;
    });
  }

  function removeRow(index: number) {
    setRows((current) => {
      const next = current.filter((_, i) => i !== index);
      if (!next.length) return [emptyRow()];
      return next;
    });
  }

  /* ── Validation ───────────────────────────────────────────────── */

  function validate(): boolean {
    if (!name.trim()) { setNameError(t("environments.nameRequired")); return false; }
    const label = runnerLabel.trim();
    if (label && !RUNNER_LABEL_PATTERN.test(label)) { setRunnerLabelError(t("environments.runnerLabelInvalid")); return false; }
    const filled = rows.filter((row) => row.key.trim());
    const keys = filled.map((row) => row.key.trim());
    const dup = keys.find((key, i) => keys.indexOf(key) !== i);
    if (dup) { message.error(t("environments.duplicateKey", { key: dup })); return false; }
    for (const row of filled) {
      if (!row.key.trim()) { message.error(t("environments.keyRequired")); return false; }
      if (row.secret && !row.existingSecret && !row.value.trim()) {
        message.error(t("environments.secretValueRequired", { key: row.key })); return false;
      }
    }
    return true;
  }

  /* ── Save ─────────────────────────────────────────────────────── */

  async function save() {
    if (!projectId || !validate()) return;
    const { variables, secrets } = rowsToInput(rows.filter((row) => row.key.trim()));
    /* 空串归一成 default：服务端也这么做，两边一致才让「清空输入 = 回到平台网段」成立。 */
    const label = runnerLabel.trim() || "default";
    setSaving(true);
    try {
      if (drawerEnv === "new") {
        await api.createEnvironment(projectId, { name: name.trim(), variables, secrets, runnerLabel: label, defaultHeaders: fromPairs(headerPairs) });
        message.success(t("environments.created"));
      } else if (drawerEnv) {
        /* Keys removed from the editor must be explicitly nulled out. */
        const removedSecrets: Record<string, null> = {};
        for (const key of drawerEnv.secretKeys) {
          if (!rows.some((row) => row.key.trim() === key && row.secret)) {
            removedSecrets[key] = null;
          }
        }
        await api.updateEnvironment(projectId, drawerEnv.id, {
          name: name.trim(),
          variables,
          secrets: { ...removedSecrets, ...secrets },
          runnerLabel: label,
          /* 默认头整体替换：行由 env.defaultHeaders 初始化，原样不动就是原值；全删
             就是清空——空对象在后端就是「清除全部默认头」。 */
          defaultHeaders: fromPairs(headerPairs),
        });
        message.success(t("environments.updated"));
      }
      await Promise.all([reloadEnvironments(), load()]);
      closeDrawer();
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 409) message.error(t("environments.nameTaken"));
      else message.error(t("environments.saveFailed"));
    } finally { setSaving(false); }
  }

  async function changeDefaultEnvironment(environmentId?: string) {
    setSavingDefault(true);
    try {
      await updateDefaultEnvironment(environmentId ?? null);
      message.success(t("environments.defaultUpdated"));
    } catch {
      message.error(t("environments.defaultUpdateFailed"));
    } finally { setSavingDefault(false); }
  }

  async function changeStorePlaintext(checked: boolean) {
    setSavingPlaintext(true);
    try {
      await updateStorePlaintext(checked);
      message.success(checked ? t("environments.plaintextOn") : t("environments.plaintextOff"));
    } catch {
      message.error(t("environments.plaintextUpdateFailed"));
    } finally { setSavingPlaintext(false); }
  }

  /* ── Delete ───────────────────────────────────────────────────── */

  async function confirmDelete(env: Environment) {
    if (!projectId) return;
    setDeleting(env.id);
    let usage: EnvironmentUsage | undefined;
    try { usage = await api.environmentUsage(projectId, env.id); }
    catch { message.error(t("environments.loadUsageFailed")); setDeleting(undefined); return; }
    finally { setDeleting(undefined); }

    const historyNote = usage.executionCount > 0
      ? `\n\n${t("environments.deleteHistoryNote", { count: usage.executionCount })}`
      : "";

    if (!usage.blocked) {
      Modal.confirm({
        title: t("environments.deleteTitle", { name: env.name }),
        content: t("environments.deleteHint") + historyNote,
        okText: t("action.delete"),
        okButtonProps: { danger: true },
        cancelText: t("action.cancel"),
        onOk: async () => {
          await api.deleteEnvironment(projectId, env.id);
          await reloadEnvironments();
          /* 删掉的是本页最后一行且不是第一页：先退一页再加载，否则停在一张空页上。 */
          if (list.length === 1 && page > 1) setPage(page - 1); else await load();
          message.success(t("environments.deleted"));
        },
      });
      return;
    }

    /* Blocked: show which endpoints reference this environment. */
    const endpointList = usage.endpoints
      .map((ep) => `• ${ep.method} ${ep.name} (${ep.variables.map((v) => `{{${v}}}`).join(", ")})`)
      .join("\n");

    Modal.confirm({
      title: t("environments.deleteBlockedTitle", { count: usage.endpoints.length }),
      content: `${t("environments.deleteBlockedHint", { name: env.name })}\n\n${endpointList}${historyNote}`,
      okText: t("environments.deleteAnyway"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        await api.deleteEnvironment(projectId, env.id, true);
        await reloadEnvironments();
        if (list.length === 1 && page > 1) setPage(page - 1); else await load();
        message.success(t("environments.deleted"));
      },
    });
  }

  /* ── Duplicate ───────────────────────────────────────────────── */

  async function duplicateEnv(env: Environment) {
    if (!projectId) return;
    setDuplicating(env.id);
    try {
      /* 名字由客户端带后缀传入（与服务端英文 "copy" 兜底一致）；secret 明文全程不出
         服务端，副本在服务端一次 INSERT…SELECT 里成型。 */
      const copy = await api.duplicateEnvironment(projectId, env.id, `${env.name} ${t("environments.copySuffix")}`);
      await Promise.all([reloadEnvironments(), load()]);
      message.success(t("environments.duplicated", { name: copy.name }));
    } catch {
      message.error(t("environments.duplicateFailed"));
    } finally {
      setDuplicating(undefined);
    }
  }

  /* ── Render ───────────────────────────────────────────────────── */

  return <main className="content">
    {/**
     * One page head above the tabs, then the tabs, matching系统设置.
     *
     * The head has to sit outside the tab panels: with a `page-head` inside each
     * branch the title moved and the tab strip jumped down the page on every
     * switch, which is what made this bar feel unlike the one in系统设置.
     * `.tabs` carries its own horizontal padding for panel use, so it is
     * cancelled here — inside `.content` it would indent past the heading.
     */}
    <div className="page-head">
      <div>
        <h1>{tab === "scripts" ? t("scripts.manageTitle") : t("environments.title")}</h1>
        <p>{tab === "scripts" ? t("scripts.manageHint") : t("environments.hint")}</p>
      </div>
      <div className="topbar-actions">
        {tab === "scripts"
          ? (canWrite && <button className="btn btn-primary" onClick={() => setCreateScript(true)}>{t("scripts.createPublic")}</button>)
          : <>
              {/* 默认环境 / 明文记录是项目设置写（P6-1 起挂 requireProjectAdmin）——
                  developer 看得到读数但改不了，入口只给项目管理员。 */}
              {canManage && <label className="inline-field">
                <span>{t("environments.projectDefault")}</span>
                <Select
                  value={defaultEnvironmentId ?? undefined}
                  onChange={(environmentId) => void changeDefaultEnvironment(environmentId)}
                  options={environments.map((environment) => ({ value: environment.id, label: environment.name }))}
                  placeholder={t("endpoints.noEnvironment")}
                  style={{ width: 148 }}
                  loading={savingDefault}
                  disabled={savingDefault}
                  allowClear
                />
              </label>}
              {canManage && <label className="check-field" title={t("environments.storePlaintextHint")}>
                <input
                  type="checkbox"
                  checked={storePlaintext}
                  disabled={savingPlaintext}
                  onChange={(event) => void changeStorePlaintext(event.target.checked)}
                />
                {t("environments.storePlaintext")}
              </label>}
              {canWrite && <button className="btn btn-primary" onClick={openCreate}>{t("action.createEnvironment")}</button>}
            </>}
      </div>
    </div>

    <div className="tabs" role="tablist" style={{ paddingInline: 0, marginBottom: "var(--s4)" }}>
      <button
        role="tab"
        aria-selected={tab === "envs"}
        className={`tab${tab === "envs" ? " is-active" : ""}`}
        onClick={() => setSearchParams({ tab: "envs" }, { replace: true })}
      >{t("scripts.tabEnvironments")}</button>
      <button
        role="tab"
        aria-selected={tab === "scripts"}
        className={`tab${tab === "scripts" ? " is-active" : ""}`}
        onClick={() => setSearchParams({ tab: "scripts" }, { replace: true })}
      >{t("scripts.tabScripts")}</button>
    </div>

    {tab === "scripts"
      ? <PublicScripts create={createScript} onCreateHandled={() => setCreateScript(false)} />
      : <>
    {/* 搜索在 SQL 里命中全量：列表分页后，按当前页过滤会让人以为某个环境不存在。 */}
    <div className="filter-bar">
      <input
        className="input"
        value={keyword}
        onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
        placeholder={t("environments.searchPlaceholder")}
        style={{ width: 260 }}
      />
      {loading && <span className="muted">{t("filter.searching")}</span>}
    </div>

    {list.length ? <table className="grid env-grid">
      <thead>
        <tr>
          <th>{t("environments.name")}</th>
          <th>{t("environments.runnerLabel")}</th>
          <th className="col-num">{t("environments.variables")}</th>
          <th className="col-num">Secrets</th>
          <th className="col-actions" />
        </tr>
      </thead>
      <tbody>
        {list.map((env) => <tr key={env.id} data-clickable onClick={() => openEdit(env)}>
          <td><strong>{env.name}</strong></td>
          {/* default 用 muted 显示而不是留空：空单元格读成「没配置这个字段」，而事实是
              「就在平台所在网段发」，那是一个确定的答案。 */}
          <td className={`mono${env.runnerLabel === "default" ? " muted" : ""}`}>{env.runnerLabel}</td>
          <td className="col-num mono">{Object.keys(env.variables).length}</td>
          <td className="col-num mono">{env.secretKeys.length}</td>
          <td className="col-actions">
            {canWrite && <div className="row-actions" onClick={(event) => event.stopPropagation()}>
              <IconButton
                icon={<CopyPlus size={14} />}
                label={t("action.duplicate")}
                disabled={duplicating === env.id}
                onClick={() => void duplicateEnv(env)}
              />
              <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => openEdit(env)} />
              <IconButton
                icon={<Trash2 size={14} />}
                label={t("action.delete")}
                tone="danger"
                disabled={deleting === env.id}
                onClick={() => void confirmDelete(env)}
              />
            </div>}
          </td>
        </tr>)}
      </tbody>
    </table> : !loading && <Empty
      title={filtered ? t("environments.emptyFiltered") : t("environments.emptyTitle")}
      hint={filtered ? t("suites.emptyFilteredHint") : t("environments.emptyHint")}
    />}

    {/* 有内容才放分页器：空态下它只是另一个「这里什么都没有」的提示。 */}
    {list.length > 0 && <div className="pager">
      <Pagination
        current={page}
        pageSize={pageSize}
        total={total}
        pageSizeOptions={PAGE_SIZES}
        showSizeChanger
        showQuickJumper={total > pageSize * 5}
        onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
      />
    </div>}

    <Drawer
      title={drawerEnv === "new" ? t("action.createEnvironment") : t("environments.editTitle")}
      open={Boolean(drawerEnv)}
      onClose={closeDrawer}
      width={560}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={closeDrawer}>{t("action.cancel")}</button>
          {canWrite && <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? "…" : t("action.save")}
          </button>}
        </div>
      }
    >
      <div className="field">
        <span>{t("environments.name")}</span>
        <input
          className="input"
          value={name}
          onChange={(e) => { setName(e.target.value); setNameError(undefined); }}
          placeholder={t("environments.namePlaceholder")}
          autoFocus
        />
        {nameError && <p className="form-error">{nameError}</p>}
      </div>

      {/* 执行分区（P2-8）。放在名称之后、变量之前：它与变量无关，是「这个环境指向的系统
          该从哪个网段访问」这一条环境级属性，读的顺序也该在变量清单之前。 */}
      <div className="field runner-label-field" style={{ marginTop: 16 }}>
        <span>{t("environments.runnerLabel")}</span>
        {/* AutoComplete 而不是原生 datalist：datalist 只在输入字符后才弹建议，单击看不到
            候选，用户无从知道有哪些分区可选。AutoComplete 单击即列出全部候选，同时保留
            自由输入——分区可以先于 worker 存在，输入框不能只允许选已有标签。 */}
        <AutoComplete
          value={runnerLabel}
          onChange={(value) => { setRunnerLabel(value); setRunnerLabelError(undefined); }}
          options={runnerLabelChoices}
          placeholder={t("environments.runnerLabelPlaceholder")}
          style={{ width: "100%" }}
        />
        {runnerLabelError
          ? <p className="form-error">{runnerLabelError}</p>
          : noRunnerForLabel(runnerLabel.trim())
            /* 提前到配置时说运行时才会遇到的 2004：保存不受阻（分区可以先于 worker 存在），
                但用户该知道下一次执行会失败、去哪里补。失败用红是设计系统的保留语义。 */
            ? <p className="form-error">{t("environments.runnerLabelNoRunner", { label: runnerLabel.trim() })}</p>
            : <p className="form-note">{t("environments.runnerLabelHint")}</p>}
      </div>

      <h3 className="subhead" style={{ marginTop: 20 }}>{t("environments.variables")}</h3>
      <p className="form-note">{t("editor.variableHint")}</p>
      {/* 内置动态变量: 求值发生在执行时, 每个 {{$...}} 引用独立求值, 不落盘 (Spec 2.1.2)。
          默认收起 — 参数表比变量列表长, 展开会把变量编辑器挤出视野。 */}
      <details className="builtin-help">
        <summary>{t("scripts.builtinTitle")}</summary>
        <table className="builtin-table">
          <tbody>
            {BUILTIN_EXAMPLES.map(([ref, note]) => <tr key={ref}>
              <td className="mono">{ref}</td>
              <td className="muted">{note}</td>
            </tr>)}
          </tbody>
        </table>
      </details>

      <div className="kv" style={{ marginTop: 12 }}>
        {/* Header */}
        <div className="kv-row" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) 60px 28px 28px" }}>
          <span style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>{t("environments.variableName")}</span>
          <span style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>{t("environments.variableValue")}</span>
          <span style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>{t("environments.variableType")}</span>
          <span />
          <span />
        </div>

        {rows.map((row, index) => (
          <VarRowEditor
            key={index}
            row={row}
            onChange={(patch) => patchRow(index, patch)}
            onRemove={rows.length > 1 ? () => removeRow(index) : undefined}
          />
        ))}
      </div>

      {/* 默认头是独立的第二块（见 state 注释）：值可引用上方变量表里的名字，
          buildRequest 以最低优先级合并，接口自己写了同名头时以接口为准。
          行样式与变量覆盖一致（VariableRowsEditor），复制按钮给头名本身。 */}
      <div style={{ marginTop: 20 }}>
        <VariableRowsEditor
          title={t("environments.defaultHeaders")}
          hint={t("environments.defaultHeadersHint")}
          pairs={headerPairs}
          onChange={setHeaderPairs}
          keyPlaceholder="X-Env-Tag"
          copyTemplate={false}
        />
      </div>

      <p className="form-note" style={{ marginTop: 12 }}>{t("environments.secretMaskNote")}</p>
    </Drawer>
      </>}
  </main>;
}

/* ── Variable row editor ────────────────────────────────────────── */

function VarRowEditor({ row, onChange, onRemove }: {
  row: VarRow;
  onChange: (patch: Partial<VarRow>) => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);

  return <div className="kv-row" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) 60px 28px 28px" }}>
    <input
      className="input mono"
      value={row.key}
      onChange={(e) => onChange({ key: e.target.value })}
      placeholder="KEY"
      spellCheck={false}
    />
    {row.secret ? (
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <input
          className="input mono"
          type={revealed ? "text" : "password"}
          value={row.value}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder={row.existingSecret ? t("environments.secretPlaceholder") : t("environments.secretNewPlaceholder")}
          style={{ paddingRight: 30, width: "100%" }}
          spellCheck={false}
        />
        <button
          type="button"
          style={{ position: "absolute", right: 6, background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", padding: 0, display: "flex" }}
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? "Hide" : "Show"}
        >
          {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>
    ) : (
      <input
        className="input mono"
        value={row.value}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder="value"
        spellCheck={false}
      />
    )}
    <button
      type="button"
      className={`btn${row.secret ? " btn-primary" : ""}`}
      style={{ fontSize: 11, padding: "0 6px", height: 34 }}
      onClick={() => onChange({ secret: !row.secret, value: "", existingSecret: false })}
      title={row.secret ? t("environments.typeText") : t("environments.typeSecret")}
    >
      {row.secret ? "Secret" : "Text"}
    </button>
    {row.key.trim()
      ? <CopyButton value={() => `{{${row.key.trim()}}}`} />
      : <span />}
    {onRemove
      ? <IconButton icon={<Trash2 size={13} />} label={t("action.delete")} tone="danger" onClick={onRemove} />
      : <span />}
  </div>;
}
