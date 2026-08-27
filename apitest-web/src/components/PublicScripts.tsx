import { useCallback, useEffect, useMemo, useState } from "react";
import { Drawer, Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Pencil, Trash2 } from "lucide-react";
import { api, type Script, type ScriptKind } from "../api";
import { useThemeMode } from "../theme";
import { Empty } from "../ui";
import { IconButton } from "./IconButton";
import { ScriptCodeEditor } from "./ScriptCodeEditor";

/**
 * 具名公共脚本 management (计划 4.0.1: follow / copy).
 *
 * Public scripts live here rather than inside the endpoint workbench on
 * purpose: editing one changes behaviour for every case that follows it, and
 * that blast radius needs a screen where the follower list is visible before
 * the edit — not a drawer reachable while doing something else.
 *
 * Anonymous (case-owned) scripts are deliberately absent. They have no
 * independent lifecycle, so offering an edit here would be an edit the owning
 * case overwrites on its next save.
 */

const NEW_SCRIPT_TEMPLATE = `// ctx.response.status / .headers / .body / .text
// ctx.variables reads prior node-local values; setVariable or return writes one.
ctx.assert.equal(ctx.response.status, 200);
return { responseCode: ctx.response.status };`;

/**
 * Opening body per kind. A hook that started from the assertion template would
 * check the response it does not have, which fails for the wrong reason — the
 * request just never goes out.
 */
const TEMPLATES: Record<ScriptKind, string> = {
  assertion: NEW_SCRIPT_TEMPLATE,
  response: NEW_SCRIPT_TEMPLATE,
  hook: `// ctx.request.method / .url / .headers / .query / .body / .bodyText
// Keys stay on the server: { secret: "SIGN_KEY" } reads an environment secret.
const raw = ctx.request.bodyText ?? "";
ctx.debug("canonical", raw);
ctx.request.headers.sign = ctx.crypto.hmac("sha256", raw, { secret: "SIGN_KEY" });`,
  library: `// Shared helpers. Declared as a dependency, prepended before the script runs.
function canonical(body) {
  return Object.keys(body).sort().map((key) => key + "=" + body[key]).join("&");
}`,
  node: `// A script node reads and writes the variable bag (P2-2).
// ctx.setVariable("name", value) or return { name: value } writes back.
return { at: ctx.variables.token ?? "none" };`,
};

type Draft = { script: Script | "new"; name: string; content: string; kind: ScriptKind; dependencies: string[] };

const KINDS: ScriptKind[] = ["response", "hook", "library", "node"];

export function PublicScripts({ create, onCreateHandled }: {
  /** Parent (Environments) owns the page head; it tells us to open the drawer. */
  create?: boolean;
  onCreateHandled?: () => void;
}) {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const mode = useThemeMode();

  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(true);
  /** Follower counts per script, so the list can show what an edit would touch. */
  const [refCounts, setRefCounts] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string>();
  /** Followers of the script being edited, fetched when the drawer opens. */
  const [followers, setFollowers] = useState<{ id: string; name: string }[]>([]);

  /* The head's "new" button lives above the tabs; honouring it here keeps the
     drawer state where the drawer lives. */
  useEffect(() => {
    if (!create) return;
    openCreate();
    onCreateHandled?.();
  }, [create]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const list = await api.scripts(projectId);
      setScripts(list);
      /* Counts are fetched per script because usage is a containment query over
         another table; the list endpoint deliberately does not join it. */
      const counts = await Promise.all(
        list.map(async (script) => {
          const usage = await api.scriptUsage(projectId, script.id).catch(() => undefined);
          return [script.id, usage?.total ?? 0] as const;
        }),
      );
      setRefCounts(Object.fromEntries(counts));
    } catch {
      message.error(t("scripts.loadRefsFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => { void load(); }, [load]);

  /* Only libraries can be depended on, so the picker offers exactly those. */
  const libraries = useMemo(() => scripts.filter((script) => script.kind === "library"), [scripts]);
  const selectedLibraries = useMemo(() => (draft?.dependencies ?? []).map((id) => libraries.find((library) => library.id === id)).filter((item): item is Script => Boolean(item)), [draft?.dependencies, libraries]);

  function openCreate() {
    setDraft({ script: "new", name: "", content: TEMPLATES.response, kind: "response", dependencies: [] });
    setFollowers([]);
    setNameError(undefined);
  }

  async function openEdit(script: Script) {
    setDraft({
      script, name: script.name ?? "", content: script.content,
      kind: script.kind, dependencies: script.dependencies ?? [],
    });
    setNameError(undefined);
    /* Fetched fresh rather than reusing the list's count: the warning states a
       number the user is about to act on, so it must be current. */
    const usage = await api.scriptUsage(projectId!, script.id).catch(() => undefined);
    /* `users`, not `cases`: since P1-2 a flow node can follow a public script
       too, and a warning that counted only cases would understate the reach. */
    setFollowers(usage?.users ?? []);
  }

  async function save() {
    if (!projectId || !draft) return;
    if (!draft.name.trim()) { setNameError(t("scripts.nameRequired")); return; }
    if (!draft.content.trim()) { message.error(t("scripts.contentRequired")); return; }
    setSaving(true);
    try {
      if (draft.script === "new") {
        await api.createScript(projectId, {
          name: draft.name.trim(), content: draft.content,
          kind: draft.kind, dependencies: draft.dependencies,
        });
        message.success(t("scripts.created"));
      } else {
        /* `kind` is absent on purpose: flipping an assertion into a hook would
           change what `return` means for every follower at once. */
        const updated = await api.updateScript(projectId, draft.script.id, {
          name: draft.name.trim(),
          content: draft.content,
          dependencies: draft.dependencies,
        });
        message.success(t("scripts.publicSaved", { count: updated.followerCount }));
      }
      await load();
      setDraft(undefined);
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      if (status === 409) setNameError(t("environments.nameTaken"));
      else message.error(detail ?? t("scripts.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Delete, refusing while anything follows.
   *
   * Mirrors the environment delete: a blocked delete names the dependents and
   * only proceeds on a second, explicit confirmation, because a silently
   * deleted script leaves its followers failing with "script content is
   * missing" and nothing on screen explaining why.
   */
  async function confirmDelete(script: Script) {
    if (!projectId) return;
    const usage = await api.scriptUsage(projectId, script.id).catch(() => undefined);
    if (!usage) { message.error(t("scripts.loadRefsFailed")); return; }

    const remove = async (force: boolean) => {
      try {
        await api.deleteScript(projectId, script.id, force);
        await load();
        message.success(t("scripts.deleted"));
      } catch { message.error(t("scripts.deleteFailed")); }
    };

    if (!usage.total) {
      Modal.confirm({
        title: t("scripts.deleteTitle", { name: script.name ?? "" }),
        content: t("scripts.deleteHint"),
        okText: t("action.delete"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
        onOk: () => remove(false),
      });
      return;
    }

    Modal.confirm({
      title: t("scripts.deleteBlockedTitle", { count: usage.total }),
      content: `${t("scripts.deleteBlockedHint", { name: script.name ?? "" })}\n\n${usage.users.map((item) => `• ${item.name}`).join("\n")}`,
      okText: t("scripts.deleteAnyway"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: () => remove(true),
    });
  }

  return <>
    {loading
      ? <p className="muted">{t("common.loading")}</p>
      : scripts.length ? <table className="grid script-grid">
        {/* Explicit widths: without them the name column shares space evenly
            with the timestamp and the four columns bunch up in the middle. */}
        <colgroup>
          <col />
          <col className="script-col-refs" />
          <col className="script-col-updated" />
          <col className="script-col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th>{t("scripts.colName")}</th>
            <th className="col-num">{t("scripts.colRefs")}</th>
            <th>{t("scripts.colUpdated")}</th>
            <th className="col-actions" />
          </tr>
        </thead>
        <tbody>
           {scripts.map((script) => <tr key={script.id} data-clickable onClick={() => void openEdit(script)}>
            <td>
              <div className="cell-name">
                <strong className="truncate">{script.name}</strong>
                {/* A kind chip keeps a list of hooks and libraries readable the
                    same way a list of endpoints reads by method. */}
                <span className={`chip chip-kind chip-kind-${script.kind}`}>{t(`scripts.kind.${script.kind}`)}</span>
              </div>
            </td>
            <td className="col-num mono">
              {refCounts[script.id] ? refCounts[script.id] : <span className="muted">{t("scripts.refsNone")}</span>}
            </td>
            <td className="mono muted">{new Date(script.updatedAt).toLocaleString()}</td>
            <td>
               <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => void openEdit(script)} />
                <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => void confirmDelete(script)} />
              </div>
            </td>
          </tr>)}
        </tbody>
      </table> : <Empty title={t("scripts.emptyTitle")} hint={t("scripts.emptyHint")} />}

    <Drawer
      title={draft ? (draft.script === "new" ? t("scripts.createPublic") : t("scripts.editPublicTitle", { name: draft.script.name ?? "" })) : ""}
      open={Boolean(draft)}
      onClose={() => setDraft(undefined)}
      width={640}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={() => setDraft(undefined)}>{t("action.cancel")}</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? "…" : t("action.save")}
          </button>
        </div>
      }
    >
      {draft && <>
        <div className="form-grid">
          <div className="field">
            <span>{t("scripts.name")}</span>
            <input
              className="input"
              value={draft.name}
              onChange={(event) => { setDraft({ ...draft, name: event.target.value }); setNameError(undefined); }}
              placeholder={t("scripts.namePlaceholder")}
              autoFocus
            />
            {nameError && <p className="form-error">{nameError}</p>}
          </div>
          <div className="field">
            <span>{t("scripts.kind")}</span>
            {/* Fixed after creation: changing it would change what `return`
                means for every follower at once, silently. */}
            <Select
              value={draft.kind}
              disabled={draft.script !== "new"}
              onChange={(kind) => setDraft({ ...draft, kind, content: TEMPLATES[kind], dependencies: [] })}
              options={KINDS.map((kind) => ({ value: kind, label: t(`scripts.kind.${kind}`) }))}
              style={{ width: "100%" }}
            />
          </div>
        </div>
        <p className="form-note">{t(`scripts.kindHint.${draft.kind}`)}</p>
        {/* A library is prepended into whoever declares it, so it cannot itself
            declare one — composition stays one level deep and acyclic. */}
        {draft.kind !== "library" && <div className="field" style={{ marginTop: 16 }}>
          <span>{t("scripts.dependencies")}</span>
          <Select
            mode="multiple"
            value={draft.dependencies}
            onChange={(dependencies) => setDraft({ ...draft, dependencies })}
            options={libraries.map((library) => ({ value: library.id, label: library.name ?? library.id }))}
            placeholder={t("scripts.dependenciesPlaceholder")}
            style={{ width: "100%" }}
          />
          <p className="form-note">{t("scripts.dependenciesBrief")}</p>
        </div>}

        {/* The blast radius, named, before the edit is saved. */}
        {draft.script !== "new" && followers.length > 0 && <>
          <p className={followers.length > 1 ? "form-note text-fail" : "form-note"} style={{ marginTop: 16 }}>
            {t("scripts.followerWarning", { count: followers.length })}
          </p>
          <ul className="script-followers">
            {followers.map((follower) => <li key={follower.id} className="mono">{follower.name}</li>)}
          </ul>
        </>}

        <h3 className="subhead" style={{ marginTop: 20 }}>{t("scripts.code")}</h3>
        <div className="script-code" style={{ marginTop: 8 }}>
          <ScriptCodeEditor
            projectId={projectId!}
            runtimeKind={draft.kind}
            libraries={selectedLibraries}
            height="320px"
            theme={mode === "dark" ? "vs-dark" : "light"}
            value={draft.content}
            onChange={(content) => setDraft({ ...draft, content })}
          />
        </div>
      </>}
    </Drawer>
  </>;
}
