import { useEffect, useState } from "react";
import { Drawer, Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { Eye, EyeOff, Plus, Pencil, Trash2 } from "lucide-react";
import { api, type Environment, type EnvironmentUsage } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { Empty } from "../ui";
import { IconButton } from "./IconButton";
import { PublicScripts } from "./PublicScripts";

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

/* ── Main component ─────────────────────────────────────────────── */

export function Environments() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { environments, defaultEnvironmentId, storePlaintext, reloadEnvironments, updateDefaultEnvironment, updateStorePlaintext } = useProjectStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "scripts" ? "scripts" : "envs";

  const [drawerEnv, setDrawerEnv] = useState<Environment | "new">();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string>();
  const [savingDefault, setSavingDefault] = useState(false);
  const [savingPlaintext, setSavingPlaintext] = useState(false);

  /* Create is triggered from the shared page head above the tabs, so the
     request has to be handed down to the panel that owns the drawer. */
  const [createScript, setCreateScript] = useState(false);

  /* ── Drawer state ─────────────────────────────────────────────── */
  const [name, setName] = useState("");
  const [rows, setRows] = useState<VarRow[]>([emptyRow()]);
  const [nameError, setNameError] = useState<string>();

  function openCreate() {
    setDrawerEnv("new");
    setName("");
    setRows([emptyRow()]);
    setNameError(undefined);
  }

  function openEdit(env: Environment) {
    setDrawerEnv(env);
    setName(env.name);
    setRows([...envToRows(env), emptyRow()]);
    setNameError(undefined);
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
    setSaving(true);
    try {
      if (drawerEnv === "new") {
        await api.createEnvironment(projectId, { name: name.trim(), variables, secrets });
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
        });
        message.success(t("environments.updated"));
      }
      await reloadEnvironments();
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
        message.success(t("environments.deleted"));
      },
    });
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
          ? <button className="btn btn-primary" onClick={() => setCreateScript(true)}>{t("scripts.createPublic")}</button>
          : <>
              <label className="inline-field">
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
              </label>
              <label className="check-field" title={t("environments.storePlaintextHint")}>
                <input
                  type="checkbox"
                  checked={storePlaintext}
                  disabled={savingPlaintext}
                  onChange={(event) => void changeStorePlaintext(event.target.checked)}
                />
                {t("environments.storePlaintext")}
              </label>
              <button className="btn btn-primary" onClick={openCreate}>{t("action.createEnvironment")}</button>
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
    {environments.length ? <table className="grid env-grid">
      <thead>
        <tr>
          <th>{t("environments.name")}</th>
          <th className="col-num">{t("environments.variables")}</th>
          <th className="col-num">Secrets</th>
          <th className="col-actions" />
        </tr>
      </thead>
      <tbody>
        {environments.map((env) => <tr key={env.id}>
          <td><strong>{env.name}</strong></td>
          <td className="col-num mono">{Object.keys(env.variables).length}</td>
          <td className="col-num mono">{env.secretKeys.length}</td>
          <td className="col-actions">
            <div className="row-actions">
              <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => openEdit(env)} />
              <IconButton
                icon={<Trash2 size={14} />}
                label={t("action.delete")}
                tone="danger"
                disabled={deleting === env.id}
                onClick={() => void confirmDelete(env)}
              />
            </div>
          </td>
        </tr>)}
      </tbody>
    </table> : <Empty title={t("environments.emptyTitle")} hint={t("environments.emptyHint")} />}

    <Drawer
      title={drawerEnv === "new" ? t("action.createEnvironment") : t("environments.editTitle")}
      open={Boolean(drawerEnv)}
      onClose={closeDrawer}
      width={560}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={closeDrawer}>{t("action.cancel")}</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? "…" : t("action.save")}
          </button>
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
        <div className="kv-row" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) 60px 30px" }}>
          <span style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>{t("environments.variableName")}</span>
          <span style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>{t("environments.variableValue")}</span>
          <span style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>{t("environments.variableType")}</span>
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

  return <div className="kv-row" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) 60px 30px" }}>
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
    {onRemove
      ? <IconButton icon={<Trash2 size={13} />} label={t("action.delete")} tone="danger" onClick={onRemove} />
      : <span />}
  </div>;
}
