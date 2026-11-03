import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Play, Plus, Trash2 } from "lucide-react";
import { api, type HookResult, type PreRequestHook, type Script } from "../api";
import { isHookResult, normalizeHookResult } from "../lib/hookResult";
import { ScriptChecks } from "./AssertionEditor";
import { useThemeMode } from "../theme";
import { IconButton } from "./IconButton";
import { ScriptCodeEditor } from "./ScriptCodeEditor";

/**
 * 前置钩子 editor (P1-2 收尾).
 *
 * A hook runs after `{{variables}}` are resolved and before the request is
 * sent, which is the only moment a signature can be computed: earlier signs a
 * template, later has nowhere to put the result.
 *
 * Uses the same follow/copy model as other user scripts, so public and private
 * script ownership behaves consistently across lifecycle phases.
 */

/** Opening body, so a new hook starts from something that runs. */
export const DEFAULT_HOOK_TEMPLATE = `// ctx.request.method / .url / .headers / .query / .body / .bodyText
// ctx.crypto.hmac / .encrypt / .hash · ctx.encoding.base64Encode / .hexEncode
// Keys stay on the server: { secret: "SIGN_KEY" } reads an environment secret.

const raw = ctx.request.bodyText ?? "";
// Record what was signed — a rejected signature is diagnosed from this line.
ctx.debug("canonical", raw);
ctx.request.headers.sign = ctx.crypto.hmac("sha256", raw, { secret: "SIGN_KEY" });`;

export function PreRequestHookEditor({ projectId, hooks, onChange, results, environmentId, variables }: {
  projectId: string;
  hooks: PreRequestHook[];
  onChange: (hooks: PreRequestHook[]) => void;
  /** Outcomes from the latest run, matched by name. */
  results?: HookResult[];
  /** The flow's environment, so a hook try-run sees the real variable bag. */
  environmentId?: string;
  /** The flow's seed variables, layered over the environment in a try-run. */
  variables?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const mode = useThemeMode();
  const [hookScripts, setHookScripts] = useState<Script[]>([]);
  const [libraries, setLibraries] = useState<Script[]>([]);
  /**
   * Keyed by index, not by id.
   *
   * The server stores hooks positionally and does not return an id, so an id
   * generated here would not survive a save — and per-row UI state keyed on it
   * would reset the moment the flow reloaded.
   */
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [trying, setTrying] = useState<number>();
  const [tried, setTried] = useState<Record<number, HookResult>>({});
  const [publishFor, setPublishFor] = useState<number>();
  const [publishName, setPublishName] = useState("");
  /**
   * Scripts fetched by id, keyed by script id.
   *
   * Saving a flow converts a private hook body into an anonymous scripts row and
   * stores `{ scriptId }` only — the content deliberately lives in one place.
   * Treating "has a scriptId" as "follows a public script" made every saved
   * private hook look empty after reopening: the id is not in the public list,
   * so nothing supplied the body. Resolve the id and let the *name* decide
   * public vs anonymous.
   */
  const [resolved, setResolved] = useState<Record<string, Script>>({});
  /**
   * Ids whose fetch came back empty — a script deleted after the flow was saved.
   *
   * Tracked so the row stops waiting: without it the editor showed 加载中 forever
   * for a reference that will never resolve.
   */
  const [unresolvable, setUnresolvable] = useState<Record<string, true>>({});
  /* One fetch per id, ever — a deleted script must not be re-requested on every
     keystroke just because it still is not in the cache. */
  const requested = useRef(new Set<string>());
  /**
   * Only true after unmount.
   *
   * A per-effect `stale` flag was wrong here: React runs cleanup before *every*
   * re-run, not just on unmount. The hook-list fetch resolving re-rendered this
   * component, which cancelled the in-flight script fetch, while `requested`
   * already held the id — so the retry never happened and the row waited on a
   * result that had been thrown away. Cancel on unmount only.
   */
  const unmounted = useRef(false);
  useEffect(() => () => { unmounted.current = true; }, []);

  /* ------------------------------------------------------------------ *
   * Saved-but-stale body handling
   *
   * Saving a flow strips hook content down to `{ scriptId }` on the server
   * (content lives in one place). `resolved` holds the copy fetched when the
   * flow loaded, so after a save the editor would fall back to the *old* body
   * until a page reload dropped the cache. Detecting "this id carried inline
   * content and suddenly does not" — the exact shape a save produces — evicts
   * it from the cache and bumps a revision so the fetch effect below re-runs.
   * ------------------------------------------------------------------ */
  const prevContent = useRef<Map<string, boolean>>(new Map());
  const [scriptRev, setScriptRev] = useState(0);

  useEffect(() => {
    const seen = new Map<string, boolean>();
    const evict: string[] = [];
    for (const hook of hooks) {
      const id = hook.script?.scriptId;
      if (!id) continue;
      const hasContent = hook.script?.content !== undefined;
      seen.set(id, hasContent);
      /* Local edit → save: the id held content last render and now does not.
         That is the server having just persisted it, so the cached copy is
         stale and must be refetched — never re-resolved from memory. */
      if (prevContent.current.get(id) === true && !hasContent) evict.push(id);
    }
    prevContent.current = seen;
    if (!evict.length) return;
    for (const id of evict) requested.current.delete(id);
    setResolved((current) => {
      const next = { ...current };
      for (const id of evict) delete next[id];
      return next;
    });
    setScriptRev((current) => current + 1);
  }, [hooks]);

  /* Only `hook` scripts are offered: an assertion script returns a verdict, so
     used here it would rewrite nothing and silently skip signing. */
  useEffect(() => {
    let stale = false;
    void Promise.all([api.scripts(projectId, undefined, "hook"), api.scripts(projectId, undefined, "library")])
      .then(([hooks, libs]) => { if (!stale) { setHookScripts(hooks); setLibraries(libs); } })
      .catch(() => undefined);
    return () => { stale = true; };
  }, [projectId]);

  /* Caches are per project; a project switch must not inherit another's ids. */
  useEffect(() => {
    requested.current = new Set();
    setResolved({});
    setUnresolvable({});
    prevContent.current = new Map();
    setScriptRev(0);
  }, [projectId]);

  /**
   * Referenced ids, as a value rather than an identity.
   *
   * `hooks` is a fresh array on most renders, so depending on it directly re-ran
   * this effect constantly. Keying on the ids themselves means it runs when the
   * set of referenced scripts actually changes.
   */
  const referencedIds = useMemo(
    () => hooks.map((hook) => hook.script?.scriptId).filter((id): id is string => Boolean(id)).join(","),
    [hooks],
  );

  useEffect(() => {
    const missing = referencedIds
      .split(",")
      .filter(Boolean)
      .filter((id) => !requested.current.has(id) && !hookScripts.some((script) => script.id === id));
    if (!missing.length) return;
    for (const id of missing) requested.current.add(id);
    void Promise.all(
      missing.map((id) => api.script(projectId, id).then((script) => [id, script] as const).catch(() => [id, undefined] as const)),
    ).then((entries) => {
      if (unmounted.current) return;
      const found = entries.filter((entry): entry is [string, Script] => Boolean(entry[1]));
      const gone = entries.filter((entry) => !entry[1]).map(([id]) => id);
      if (found.length) setResolved((current) => ({ ...current, ...Object.fromEntries(found) }));
      if (gone.length) setUnresolvable((current) => ({ ...current, ...Object.fromEntries(gone.map((id) => [id, true as const])) }));
    });
  }, [referencedIds, hookScripts, projectId, scriptRev]);

  /** The stored script a hook references, public or anonymous. */
  function referencedScript(hook: PreRequestHook): Script | undefined {
    const id = hook.script?.scriptId;
    if (!id) return undefined;
    return hookScripts.find((script) => script.id === id) ?? resolved[id];
  }

  /** The body a hook would run right now: local edit first, stored copy second. */
  function contentOf(hook: PreRequestHook): string {
    return hook.script?.content ?? referencedScript(hook)?.content ?? "";
  }

  function update(index: number, patch: Partial<PreRequestHook>) {
    onChange(hooks.map((hook, at) => (at === index ? { ...hook, ...patch } : hook)));
  }

  function add() {
    onChange([...hooks, { name: "", type: "script", enabled: true, script: { content: DEFAULT_HOOK_TEMPLATE } }]);
  }

  /** Promotes a private hook body to a named public script and follows it. */
  async function publish(index: number) {
    const hook = hooks[index];
    if (!hook) return;
    if (!publishName.trim()) { message.info(t("scripts.nameRequired")); return; }
    try {
      const created = await api.createScript(projectId, {
        name: publishName.trim(),
        /* A saved-but-unedited private hook carries no local content — its body
           lives in the anonymous scripts row. Publish what would actually run. */
        content: contentOf(hook),
        kind: "hook",
        dependencies: hook.script?.dependencies ?? referencedScript(hook)?.dependencies ?? [],
      });
      setHookScripts((current) => [...current, created].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")));
      update(index, { script: { scriptId: created.id } });
      setPublishFor(undefined);
      setPublishName("");
      message.success(t("scripts.published"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("scripts.saveFailed"));
    }
  }

  /**
   * Try-run against a stand-in request.
   *
   * A hook has no response to read, so the sample is a request — which also
   * makes one failure obvious: a script that reads `ctx.response` fails here
   * rather than at run time.
   */
  async function tryRun(index: number) {
    const hook = hooks[index];
    if (!hook) return;
    const content = contentOf(hook);
    if (!content.trim()) { message.info(t("scripts.empty")); return; }
    setTrying(index);
    try {
      const outcome = await api.tryScript(projectId, {
        content,
        kind: "hook",
        dependencies: hook.script?.dependencies ?? referencedScript(hook)?.dependencies,
        request: { method: "POST", url: "https://api.example.com/orders", headers: {}, body: '{"amount":1}' },
        /* A signing script needs the real variable bag to verify against: the
           flow's environment plus its seed variables, exactly what a run gives
           the hook. Without this, `{ secret: "SIGN_KEY" }` and
           `ctx.variables.SIGN_KEY` both fail in try but work in the run. */
        environmentId,
        variables,
      });
      /* The endpoint is shared with assertion scripts. Never force-cast an
         assertion payload into a hook result: its missing `changed`/`debug`
         arrays used to crash HookOutcome and black out the entire drawer. */
      setTried((current) => ({
        ...current,
        [index]: isHookResult(outcome)
          ? outcome
          : normalizeHookResult({
              ok: false,
              error: outcome.error ?? "the server returned an assertion result for a pre-request script",
              logs: outcome.logs,
            }, hook.name?.trim() || `hook ${index + 1}`),
      }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("scripts.tryFailed"));
    } finally { setTrying(undefined); }
  }

  const options = useMemo(() => [
    { value: "", label: t("hooks.privateScript") },
    ...hookScripts.map((script) => ({ value: script.id, label: script.name ?? script.id })),
  ], [hookScripts, t]);

  return <div className="hooks">
    <p className="form-note">{t("hooks.brief")}</p>
    {hooks.map((hook, index) => {
      const referenced = referencedScript(hook);
      /**
       * Public vs private is decided by the *name*, never by the presence of a
       * scriptId: a saved private hook also carries an id — its body lives in an
       * anonymous scripts row — and treating that id as "follows a public
       * script" is exactly what made saved hooks come back empty.
       */
      const following = Boolean(referenced?.name);
      const content = hook.script?.content ?? referenced?.content ?? "";
      const dependencyIds = hook.script?.dependencies ?? referenced?.dependencies ?? [];
      const selectedLibraries = dependencyIds.map((id) => libraries.find((library) => library.id === id)).filter((item): item is Script => Boolean(item));
      /**
       * Referenced body still in flight: block the editor rather than show an
       * empty one — typing into the gap would overwrite the stored script.
       *
       * A reference that came back missing is *not* pending; it is a script
       * deleted after the flow was saved. Waiting on it forever is what showed
       * 加载中 permanently, so it falls through to an editable empty body.
       */
      const referenceId = hook.script?.scriptId;
      const resolving = Boolean(referenceId)
        && !referenced
        && hook.script?.content === undefined
        && !unresolvable[referenceId!];
      const missingReference = Boolean(referenceId) && Boolean(unresolvable[referenceId!]);
      const isCollapsed = collapsed[index];
      /* The stored name is optional; the server falls back to "hook N", so the
         result lookup has to use the same fallback. */
      const label = hook.name?.trim() || `hook ${index + 1}`;
      const outcome = tried[index] ?? results?.find((item) => item.name === label);

      return <div className="hook-row" key={index}>
        <div className="hook-head">
          <button
            type="button"
            className="btn btn-icon script-collapse"
            onClick={() => setCollapsed((current) => ({ ...current, [index]: !current[index] }))}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? t("scripts.expand") : t("scripts.collapse")}
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          {/* Disabled rather than deleted is the normal way to bisect a signing
              problem, so the toggle sits first among the controls. */}
          <input
            type="checkbox"
            className="kv-toggle"
            checked={hook.enabled !== false}
            onChange={(event) => update(index, { enabled: event.target.checked })}
            aria-label={t("hooks.enabled")}
          />
          <input
            className="input hook-name"
            value={hook.name ?? ""}
            onChange={(event) => update(index, { name: event.target.value })}
            placeholder={t("hooks.namePlaceholder")}
            aria-label={t("hooks.name")}
          />
          <Select
            size="small"
            /* An anonymous script shows as 私有脚本, not as its raw uuid. */
            value={following ? hook.script?.scriptId : ""}
            onChange={(id) => {
              if (id) { update(index, { script: { scriptId: id } }); return; }
              /* 私有脚本 while following = detach a copy. Already-private rows
                 keep their anonymous script instead of resetting to template. */
               if (following) update(index, { script: { content: content || DEFAULT_HOOK_TEMPLATE, dependencies: referenced?.dependencies ?? [] } });
            }}
            options={options}
            style={{ width: 150 }}
          />
          <div className="script-editor-actions">
            {following
              ? <button type="button" className="btn btn-small" onClick={() => update(index, { script: { content } })}>
                  {t("scripts.detach")}
                </button>
              : <button
                  type="button"
                  className="btn btn-small"
                  disabled={!content.trim()}
                  onClick={() => { setPublishName(""); setPublishFor(index); }}
                >
                  {t("scripts.publish")}
                </button>}
            <button type="button" className="btn btn-small" disabled={trying === index || resolving} onClick={() => void tryRun(index)}>
              {trying === index ? t("scripts.trying") : t("scripts.try")}
            </button>
            <IconButton
              icon={<Trash2 size={14} />}
              label={t("action.delete")}
              tone="danger"
              onClick={() => onChange(hooks.filter((_, at) => at !== index))}
            />
          </div>
        </div>

        {!isCollapsed && <>
          <div className="field script-dependencies-field">
            <span>{t("scripts.dependencies")}</span>
            <Select
              mode="multiple"
              value={dependencyIds}
              disabled={following}
              onChange={(dependencies) => update(index, { script: { ...hook.script, dependencies } })}
              options={libraries.map((library) => ({ value: library.id, label: library.name ?? library.id }))}
              placeholder={t("scripts.dependenciesPlaceholder")}
              style={{ width: "100%" }}
            />
          </div>
          {resolving
            ? <p className="script-loading muted mono">{t("scripts.loading")}</p>
            : <div className={`script-code${following ? " is-readonly" : ""}`}>
              <ScriptCodeEditor
                projectId={projectId}
                runtimeKind="hook"
                libraries={selectedLibraries}
                height="200px"
                theme={mode === "dark" ? "vs-dark" : "light"}
                value={content}
                /* Keeps the anonymous scriptId alongside the edit, so saving the
                   flow updates that row in place instead of minting a new script
                   on every save. */
                onChange={(next) => { if (!following) update(index, { script: { ...hook.script, content: next } }); }}
                readOnly={following}
              />
            </div>}
          {following && <p className="form-note">{t("hooks.followingNote", { name: referenced?.name ?? "" })}</p>}
          {/* The reference is gone, so say so instead of presenting an empty
              editor as if the script had always been blank. */}
          {missingReference && <p className="form-error">{t("hooks.missingScript")}</p>}

          {outcome && <HookOutcome outcome={outcome} />}
        </>}
      </div>;
    })}

    <button className="btn btn-with-icon" style={{ marginTop: 8 }} onClick={add}>
      <Plus size={14} />{t("hooks.add")}
    </button>

    <Modal
      title={t("scripts.publishTitle")}
      open={publishFor !== undefined}
      onCancel={() => setPublishFor(undefined)}
      onOk={() => { if (publishFor !== undefined) void publish(publishFor); }}
      okText={t("scripts.publishConfirm")}
      width={420}
    >
      <p className="muted">{t("hooks.publishHint")}</p>
      <input
        className="input"
        value={publishName}
        onChange={(event) => setPublishName(event.target.value)}
        placeholder={t("scripts.namePlaceholder")}
        aria-label={t("scripts.name")}
      />
    </Modal>
  </div>;
}

/**
 * What a hook produced.
 *
 * `debug` is the reason this panel exists: a rejected signature is diagnosed by
 * comparing the canonical string byte for byte, and only the script knows which
 * of its intermediate values that was.
 */
export function HookOutcome({ outcome }: { outcome: HookResult }) {
  const { t } = useTranslation();
  const safe = normalizeHookResult(outcome);
  return <div className="hook-outcome">
    <div className="hook-outcome-head">
      <span className={safe.ok ? "text-pass" : "text-fail"}>
        {safe.ok ? t("hooks.ok") : t("hooks.failed")}
      </span>
      {safe.changed.length > 0 && <span className="mono muted">{t("hooks.changed", { parts: safe.changed.join(", ") })}</span>}
    </div>
    {safe.error && <pre className="mono script-error">{safe.error}</pre>}
    {/* A hook may assert its own preconditions with ctx.assert; a failed check
        aborts the request, so the per-check line is what explains why nothing
        was sent. */}
    <ScriptChecks checks={safe.checks} />
    {safe.debug.map((entry, index) => <div className="hook-debug" key={index}>
      <span className="hook-debug-label">{entry.label}</span>
      {/* Pre-wrapped: a canonical string is compared character by character, so
          it must not be collapsed or truncated. */}
      <pre className="mono hook-debug-value">{entry.value}</pre>
    </div>)}
    {safe.logs.length > 0 && <pre className="mono script-logs">{safe.logs.join("\n")}</pre>}
  </div>;
}
