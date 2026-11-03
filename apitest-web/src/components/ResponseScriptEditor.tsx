import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { api, type ResponseScript, type ResponseScriptResult, type Script, type ScriptTryResult } from "../api";
import { useThemeMode } from "../theme";
import { ScriptChecks } from "./AssertionEditor";
import { IconButton } from "./IconButton";
import { ScriptCodeEditor } from "./ScriptCodeEditor";

export const DEFAULT_RESPONSE_SCRIPT_TEMPLATE = `// ctx.response.status / .headers / .body / .text
// ctx.variables includes pre-request and simple-extract values.
// ctx.assert checks business rules; return or setVariable proposes downstream values.
const items = Array.isArray(ctx.response.body?.data) ? ctx.response.body.data : [];
const total = items.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
ctx.assert.greaterThan(total, 0, "total must be positive");
return { responseTotal: total };`;

/** Post-response script editor shared by Flow request nodes and test cases. */
export function ResponseScriptEditor({ projectId, scripts, onChange, results, response, environmentId, variables }: {
  projectId: string;
  scripts: ResponseScript[];
  onChange: (scripts: ResponseScript[]) => void;
  /** Evidence from the latest run, matched by name. */
  results?: ResponseScriptResult[];
  /** The response on screen, so a try-run sees what the editor shows. */
  response?: { statusCode?: number; headers?: Record<string, string>; body?: string };
  /** The run's environment, so a try-run resolves the same variable bag. */
  environmentId?: string;
  /** Seed variables layered over that environment in a try-run. */
  variables?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const mode = useThemeMode();
  const [publicScripts, setPublicScripts] = useState<Script[]>([]);
  const [libraries, setLibraries] = useState<Script[]>([]);
  /** Keyed by index: the server stores scripts positionally and returns no id. */
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [trying, setTrying] = useState<number>();
  const [tried, setTried] = useState<Record<number, ScriptTryResult>>({});
  const [publishFor, setPublishFor] = useState<number>();
  const [publishName, setPublishName] = useState("");
  /**
   * Scripts fetched by id, keyed by script id.
   *
   * Saving strips a private script body down to `{ scriptId }` — the content
   * deliberately lives in one anonymous row. Treating "has a scriptId" as
   * "follows a public script" made every saved private script come back empty:
   * the id is not in the public list, so nothing supplied the body. Resolve the
   * id and let the *name* decide public vs anonymous.
   */
  const [resolved, setResolved] = useState<Record<string, Script>>({});
  /** Ids whose fetch came back empty — a script deleted after the flow was saved. */
  const [unresolvable, setUnresolvable] = useState<Record<string, true>>({});
  /* One fetch per id, ever — a deleted script must not be re-requested on every
     keystroke just because it still is not in the cache. */
  const requested = useRef(new Set<string>());
  /**
   * Only true after unmount.
   *
   * A per-effect `stale` flag was wrong here: React runs cleanup before *every*
   * re-run, not just on unmount. The public-list fetch resolving re-renders this
   * component, which would cancel the in-flight script fetch, while `requested`
   * already held the id — so the retry never happened and the row waited on a
   * result that had been thrown away. Cancel on unmount only.
   */
  const unmounted = useRef(false);
  useEffect(() => () => { unmounted.current = true; }, []);

  /* ------------------------------------------------------------------ *
   * Saved-but-stale body handling
   *
   * Saving strips a private script's content down to `{ scriptId }` on the
   * server. `resolved` holds the copy fetched when the flow loaded, so after a
   * save the editor would fall back to the *old* body until a page reload
   * dropped the cache. Detecting "this id carried inline content and suddenly
   * does not" — the exact shape a save produces — evicts it from the cache and
   * bumps a revision so the fetch effect below re-runs.
   * ------------------------------------------------------------------ */
  const prevContent = useRef<Map<string, boolean>>(new Map());
  const [scriptRev, setScriptRev] = useState(0);

  useEffect(() => {
    const seen = new Map<string, boolean>();
    const evict: string[] = [];
    for (const item of scripts) {
      const id = item.script?.scriptId;
      if (!id) continue;
      const hasContent = item.script?.content !== undefined;
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
  }, [scripts]);

  /* Only `response` scripts are offered: an assertion or hook script speaks a
     different ctx contract and must not be picked as a response script. */
  useEffect(() => {
    let stale = false;
    void Promise.all([api.scripts(projectId, undefined, "response"), api.scripts(projectId, undefined, "library")])
      .then(([shared, libs]) => { if (!stale) { setPublicScripts(shared); setLibraries(libs); } })
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
   * `scripts` is a fresh array on most renders, so depending on it directly
   * re-ran this effect constantly. Keying on the ids themselves means it runs
   * when the set of referenced scripts actually changes.
   */
  const referencedIds = useMemo(
    () => scripts.map((item) => item.script?.scriptId).filter((id): id is string => Boolean(id)).join(","),
    [scripts],
  );

  useEffect(() => {
    const missing = referencedIds
      .split(",")
      .filter(Boolean)
      .filter((id) => !requested.current.has(id) && !publicScripts.some((script) => script.id === id));
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
  }, [referencedIds, publicScripts, projectId, scriptRev]);

  /** The stored script a row references, public or anonymous. */
  function referencedScript(item: ResponseScript): Script | undefined {
    const id = item.script?.scriptId;
    if (!id) return undefined;
    return publicScripts.find((script) => script.id === id) ?? resolved[id];
  }

  /** The body a row would run right now: local edit first, stored copy second. */
  function contentOf(item: ResponseScript): string {
    return item.script?.content ?? referencedScript(item)?.content ?? "";
  }

  function patch(index: number, next: Partial<ResponseScript>) {
    onChange(scripts.map((item, at) => (at === index ? { ...item, ...next } : item)));
  }

  function add() {
    onChange([...scripts, { type: "script", enabled: true, name: "", script: { content: DEFAULT_RESPONSE_SCRIPT_TEMPLATE } }]);
  }

  /** Promotes a private body to a named public script and follows it. */
  async function publish(index: number) {
    const item = scripts[index];
    if (!item) return;
    if (!publishName.trim()) { message.info(t("scripts.nameRequired")); return; }
    try {
      const created = await api.createScript(projectId, {
        name: publishName.trim(),
        /* A saved-but-unedited private script carries no local content — its body
           lives in the anonymous scripts row. Publish what would actually run. */
        content: contentOf(item),
        kind: "response",
        dependencies: item.script?.dependencies ?? referencedScript(item)?.dependencies ?? [],
      });
      setPublicScripts((current) => [...current, created].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")));
      patch(index, { script: { scriptId: created.id } });
      setPublishFor(undefined);
      setPublishName("");
      message.success(t("scripts.published"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("scripts.saveFailed"));
    }
  }

  /**
   * Try-run against the response on screen.
   *
   * The same kind the server persists, so a try-run behaves exactly as the
   * recorded run will — `ctx.assert` decides the verdict and a returned object
   * proposes variables.
   */
  async function tryRun(index: number) {
    const item = scripts[index];
    if (!item) return;
    const content = contentOf(item);
    if (!content.trim()) { message.info(t("scripts.empty")); return; }
    setTrying(index);
    try {
      const outcome = await api.tryScript(projectId, {
        content,
        kind: "response",
        dependencies: item.script?.dependencies ?? referencedScript(item)?.dependencies,
        statusCode: response?.statusCode,
        headers: response?.headers,
        body: response?.body,
        environmentId,
        variables,
      });
      /* `kind: "response"` try-runs return a ScriptTryResult (it has `passed`);
         never force-cast a hook/assertion payload into it. */
      if ("passed" in outcome) setTried((current) => ({ ...current, [index]: outcome }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("scripts.tryFailed"));
    } finally { setTrying(undefined); }
  }

  const options = useMemo(() => [
    { value: "", label: t("hooks.privateScript") },
    ...publicScripts.map((script) => ({ value: script.id, label: script.name ?? script.id })),
  ], [publicScripts, t]);

  return <div className="hooks">
    <p className="form-note">{t("responseScripts.brief")}</p>
    {scripts.map((item, index) => {
      const referenced = referencedScript(item);
      /**
       * Public vs private is decided by the *name*, never by the presence of a
       * scriptId: a saved private script also carries an id — its body lives in
       * an anonymous scripts row — and treating that id as "follows a public
       * script" is exactly what made saved scripts come back empty.
       */
      const following = Boolean(referenced?.name);
      const content = contentOf(item);
      const dependencyIds = item.script?.dependencies ?? referenced?.dependencies ?? [];
      const selectedLibraries = dependencyIds.map((id) => libraries.find((library) => library.id === id)).filter((item): item is Script => Boolean(item));
      /**
       * Referenced body still in flight: block the editor rather than show an
       * empty one — typing into the gap would overwrite the stored script.
       *
       * A reference that came back missing is *not* pending; it is a script
       * deleted after the flow was saved. Waiting on it forever is what showed
       * 加载中 permanently, so it falls through to an editable empty body.
       */
      const referenceId = item.script?.scriptId;
      const resolving = Boolean(referenceId)
        && !referenced
        && item.script?.content === undefined
        && !unresolvable[referenceId!];
      const missingReference = Boolean(referenceId) && Boolean(unresolvable[referenceId!]);
      const isCollapsed = collapsed[index];
      /* The stored name is optional; evidence falls back to "response script N". */
      const label = item.name?.trim() || `response script ${index + 1}`;
      const triedOutcome = tried[index];
      const executedOutcome = results?.find((entry) => entry.name === label);

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
          {/* Disabled rather than deleted is the normal way to bisect a failing
              script, so the toggle sits first among the controls. */}
          <input
            type="checkbox"
            className="kv-toggle"
            checked={item.enabled !== false}
            onChange={(event) => patch(index, { enabled: event.target.checked })}
            aria-label={t("hooks.enabled")}
          />
          <input
            className="input hook-name"
            value={item.name ?? ""}
            onChange={(event) => patch(index, { name: event.target.value })}
            placeholder={t("responseScripts.namePlaceholder")}
            aria-label={t("responseScripts.name")}
          />
          <Select
            size="small"
            /* An anonymous script shows as 私有脚本, not as its raw uuid. */
            value={following ? item.script?.scriptId : ""}
            onChange={(id) => {
              if (id) { patch(index, { script: { scriptId: id } }); return; }
              /* 私有脚本 while following = detach a copy. Already-private rows
                 keep their anonymous script instead of resetting to template. */
              if (following) patch(index, { script: { content: content || DEFAULT_RESPONSE_SCRIPT_TEMPLATE, dependencies: referenced?.dependencies ?? [] } });
            }}
            options={options}
            style={{ width: 150 }}
          />
          <div className="script-editor-actions">
            {following
              ? <button type="button" className="btn btn-small" onClick={() => patch(index, { script: { content } })}>
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
              onClick={() => onChange(scripts.filter((_, at) => at !== index))}
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
              onChange={(dependencies) => patch(index, { script: { ...item.script, dependencies } })}
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
                runtimeKind="response"
                libraries={selectedLibraries}
                height="220px"
                theme={mode === "dark" ? "vs-dark" : "light"}
                value={content}
                /* Keeps the anonymous scriptId alongside the edit, so saving the
                   flow updates that row in place instead of minting a new script
                   on every save. */
                onChange={(next) => { if (!following) patch(index, { script: { ...item.script, content: next } }); }}
                readOnly={following}
              />
            </div>}
          {following && <p className="form-note">{t("hooks.followingNote", { name: referenced?.name ?? "" })}</p>}
          {/* The reference is gone, so say so instead of presenting an empty
              editor as if the script had always been blank. */}
          {missingReference && <p className="form-error">{t("hooks.missingScript")}</p>}

          {triedOutcome && <div className="hook-outcome">
            <span className={triedOutcome.passed ? "text-pass" : "text-fail"}>{triedOutcome.passed ? t("scripts.tryPassed") : t("scripts.tryFailed_")}</span>
            <ScriptChecks checks={triedOutcome.checks} />
            {triedOutcome.error && <pre className="mono script-error">{triedOutcome.error}</pre>}
            {triedOutcome.variables && Object.keys(triedOutcome.variables).length > 0 && <p className="mono muted">{t("scripts.wroteVariables", { list: Object.entries(triedOutcome.variables).map(([key, value]) => `${key}=${value}`).join(", ") })}</p>}
          </div>}
          {executedOutcome && <div className="hook-outcome">
            <span className={executedOutcome.ok ? "text-pass" : "text-fail"}>{executedOutcome.ok ? t("scripts.tryPassed") : t("scripts.tryFailed_")}</span>
            <ScriptChecks checks={executedOutcome.checks} />
            {executedOutcome.error && <pre className="mono script-error">{executedOutcome.error}</pre>}
          </div>}
        </>}
      </div>;
    })}

    <button className="btn btn-with-icon" style={{ marginTop: 8 }} onClick={add}>
      <Plus size={14} />{t("responseScripts.add")}
    </button>

    <Modal
      title={t("scripts.publishTitle")}
      open={publishFor !== undefined}
      onCancel={() => setPublishFor(undefined)}
      onOk={() => { if (publishFor !== undefined) void publish(publishFor); }}
      okText={t("scripts.publishConfirm")}
      width={420}
    >
      <input
        className="input"
        value={publishName}
        onChange={(event) => setPublishName(event.target.value)}
        placeholder={t("scripts.namePlaceholder")}
        aria-label={t("scripts.namePlaceholder")}
      />
    </Modal>
  </div>;
}

/** Read-only response-script evidence used in execution snapshots. */
export function ResponseScriptResults({ results }: { results: ResponseScriptResult[] }) {
  if (!results.length) return null;
  return <div className="hook-results">{results.map((result, index) => <div className="hook-outcome" key={index}><div className="hook-outcome-head"><strong>{result.name}</strong><span className={result.ok ? "text-pass" : "text-fail"}>{result.ok ? "PASS" : "FAIL"}</span></div>{result.error && <pre className="mono script-error">{result.error}</pre>}<ScriptChecks checks={result.checks} />{result.debug.map((entry, at) => <div className="hook-debug" key={at}><span className="hook-debug-label">{entry.label}</span><pre className="mono hook-debug-value">{entry.value}</pre></div>)}{result.logs.length > 0 && <pre className="mono script-logs">{result.logs.join("\n")}</pre>}</div>)}</div>;
}
