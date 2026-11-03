import { useCallback, useEffect, useMemo, useState } from "react";
import { Drawer, Modal, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { History, Pencil, Trash2 } from "lucide-react";
import { api, type Script, type ScriptKind } from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import { useThemeMode } from "../theme";
import { Empty } from "../ui";
import { IconButton } from "./IconButton";
import { OwnerCell } from "./OwnerCell";
import { ScriptCodeEditor } from "./ScriptCodeEditor";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer";

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

const PAGE_SIZES = [20, 50, 100];

export function PublicScripts({ create, onCreateHandled }: {
  /** Parent (Environments) owns the page head; it tells us to open the drawer. */
  create?: boolean;
  onCreateHandled?: () => void;
}) {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const mode = useThemeMode();
  /* viewer：编辑/删除入口不渲染（P6-4）；页头「新建公共脚本」按钮在 Environments 侧已藏。 */
  const canWrite = useCanWrite();

  const [scripts, setScripts] = useState<Script[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  /** Follower counts per script, so the list can show what an edit would touch. */
  const [refCounts, setRefCounts] = useState<Record<string, number>>({});
  /**
   * 依赖库下拉的候选。表格分页后不能再从 `scripts`（当前页）里筛：第 2 页的库
   * 不出现在下拉里，会让人以为「依赖不了它」。选择器与各编辑器同用全量接口。
   */
  const [libraries, setLibraries] = useState<Script[]>([]);
  const [draft, setDraft] = useState<Draft>();
  /* 版本历史抽屉（P10-6）：新建时还没有 assetId，保存后才有版本。 */
  const [scriptHistoryOpen, setScriptHistoryOpen] = useState(false);
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
      /* 管理页走服务端分页；删掉本页最后一行后自动退一页，而不是停在一张空表上。 */
      const result = await api.scriptsPaged(projectId, { page, pageSize });
      if (!result.items.length && result.total > 0 && page > 1) { setPage(page - 1); return; }
      setScripts(result.items);
      setTotal(result.total);
      /* Counts are fetched per script because usage is a containment query over
         another table; the list endpoint deliberately does not join it. */
      const counts = await Promise.all(
        result.items.map(async (script) => {
          const usage = await api.scriptUsage(projectId, script.id).catch(() => undefined);
          return [script.id, usage?.total ?? 0] as const;
        }),
      );
      setRefCounts(Object.fromEntries(counts));
      /* 新建/删除可能增减一个 library，候选下拉跟着表格一起刷新。失败不静默清空
         （P2-2 #2 的教训）：下拉空了会被读成「项目里没有库」。 */
      setLibraries(await api.scripts(projectId, undefined, "library"));
    } catch {
      message.error(t("scripts.loadRefsFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, page, pageSize, t]);

  useEffect(() => { void load(); }, [load]);

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
    <div className="list-card">
    {scripts.length ? <div className="table-scroll"><table className="grid script-grid">
        {/* Explicit widths: without them the name column shares space evenly
            with the timestamp and the four columns bunch up in the middle. */}
        <colgroup>
          <col />
          <col className="script-col-refs" />
          <col className="script-col-updated" />
          <col className="col-owner" />
          <col className="col-owner" />
          <col className="script-col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th>{t("scripts.colName")}</th>
            <th className="col-num">{t("scripts.colRefs")}</th>
            <th>{t("scripts.colUpdated")}</th>
            <th className="col-owner">{t("common.createdBy")}</th>
            <th className="col-owner">{t("common.updatedBy")}</th>
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
            {/* 归属两列（P11-7）：与上面的更新时间并列读——「什么时候改的」+「谁改的」。 */}
            <td className="col-owner mono muted truncate"><OwnerCell kind="created" email={script.createdByEmail} /></td>
            <td className="col-owner mono muted truncate"><OwnerCell kind="updated" email={script.updatedByEmail} createdAt={script.createdAt} updatedAt={script.updatedAt} /></td>
            <td>
               {canWrite && <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => void openEdit(script)} />
                <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => void confirmDelete(script)} />
              </div>}
            </td>
          </tr>)}
        </tbody>
      </table></div> : !loading && <Empty title={t("scripts.emptyTitle")} hint={t("scripts.emptyHint")} />}

    {/* 有内容才放分页器：空态下它只是另一个「这里什么都没有」的提示。 */}
    {scripts.length > 0 && <div className="pager">
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
    </div>

    <Drawer
      title={draft ? (draft.script === "new" ? t("scripts.createPublic") : t("scripts.editPublicTitle", { name: draft.script.name ?? "" })) : ""}
      open={Boolean(draft)}
      onClose={() => { setScriptHistoryOpen(false); setDraft(undefined); }}
      width={640}
      extra={canWrite && draft && draft.script !== "new" ? <button className="btn btn-small btn-with-icon" onClick={() => setScriptHistoryOpen(true)}><History size={14} />{t("version.history")}</button> : undefined}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={() => setDraft(undefined)}>{t("action.cancel")}</button>
          {canWrite && <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? "…" : t("action.save")}
          </button>}
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

    {/* 公共脚本的版本历史（P10-6）：含 script_deps 依赖，回滚会连依赖一起写回。
        匿名（用例私有）脚本没有独立生命周期，也没有这里的入口。回滚后关闭并重拉列表。 */}
    {canWrite && draft && draft.script !== "new" && <VersionHistoryDrawer
      projectId={projectId!}
      assetType="script"
      assetId={draft.script.id}
      name={draft.script.name ?? draft.name}
      open={scriptHistoryOpen}
      onClose={() => setScriptHistoryOpen(false)}
      onRolledBack={() => { setScriptHistoryOpen(false); setDraft(undefined); void load(); }}
    />}
  </>;
}
