import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type SpecSource, type SpecSourceOperation } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { Method } from "../ui";

/**
 * 创建接口页 URL 框内的来源搜索（P17，2026-10-10 反馈调整）。
 *
 * 与 VariableField 同形：一个输入框 + 贴着它的固定浮层，区别在候选来自「接口来源」
 * 而非变量。输入关键词后**实时**（防抖 450ms、至少 2 字符）搜**已选来源**，命中项按
 * (method, url) 去重、**每条都标出命中的来源**（同 url / 同名字在不同来源也可辨），
 * 点一条交给父组件全量预填（不落库）。
 *
 * 性能（2026-10-10）：① 输入即搜但打字停顿才发，且少于 2 字符不发；② 上一笔在途请求
 * 用 AbortController 取消，避免连打；③ 搜索范围可缩小——左侧「来源 (n/m)」按钮点开小
 * 弹窗勾选（默认全选，记忆到本地），只搜勾中的来源。服务端侧对快照型来源走派生索引，
 * 读写量只与命中数相关（见 migrations/078）。
 */

const MAX_RESULTS = 8;
const MIN_KEYWORD = 2;
const STORAGE_KEY = "apitest.specSourceSelection";

export function SpecSourceSearch({ projectId, onPick }: {
  projectId: string;
  /** 命中一条 → 交给父组件预填创建表单。 */
  onPick: (operation: SpecSourceOperation) => void;
}) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<SpecSource[]>();
  /** 勾中的来源 id；默认全选，记忆到本地。 */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState("");
  const debounced = useDebounced(keyword, 450);
  const [results, setResults] = useState<SpecSourceOperation[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeAnchor, setScopeAnchor] = useState({ top: 0, left: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const scopeRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  /* 点开浮层后，点击组件之外的任何地方都关掉（结果浮层与来源范围浮层一起关）。 */
  useEffect(() => {
    function onDocMouseDown(event: MouseEvent) {
      if (rowRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setScopeOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  /* 全部来源一次拉取（全局可见）。选定范围默认全选，或沿用本地记忆（只留仍存在的）。 */
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    api.specSources().then((rows) => {
      if (!alive) return;
      setSources(rows);
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === null) { setSelectedIds(new Set(rows.map((source) => source.id))); return; }
      try {
        const remembered = (JSON.parse(stored) as string[]).filter((id) => rows.some((source) => source.id === id));
        setSelectedIds(new Set(remembered));
      } catch { setSelectedIds(new Set(rows.map((source) => source.id))); }
    }).catch(() => { if (alive) { setSources([]); setFailed(true); } });
    return () => { alive = false; };
  }, [projectId]);

  function persistSelection(next: Set<string>) {
    setSelectedIds(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  }

  const scopeIds = useMemo(() => [...selectedIds], [selectedIds]);
  const allIds = useMemo(() => (sources ?? []).map((source) => source.id), [sources]);

  /* 输入即搜（防抖）：读到本地记忆；少于 2 字符或没勾来源就不发请求，空闲时清结果。 */
  useEffect(() => {
    const needle = debounced.trim();
    if (needle.length < MIN_KEYWORD || !scopeIds.length) { setResults([]); setSearching(false); setFailed(false); return; }
    const controller = new AbortController();
    setSearching(true);
    api.searchSpecSources(needle, scopeIds, controller.signal)
      .then((items) => { setResults(items.slice(0, MAX_RESULTS)); setFailed(false); })
      .catch(() => { if (!controller.signal.aborted) { setResults([]); setFailed(true); } })
      .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    return () => controller.abort();
  }, [debounced, scopeIds]);

  useEffect(() => { setHighlight(0); }, [results]);

  /* 两个浮层都照 VariableField：贴字段下方，空间不够翻上方。 */
  useLayoutEffect(() => {
    if (!open || !inputRef.current) return;
    const box = inputRef.current.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    setAnchor(below < 240 && box.top > below
      ? { top: Math.max(8, box.top - 244), left: box.left }
      : { top: box.bottom + 4, left: box.left });
  }, [open, results, keyword, sources]);

  useLayoutEffect(() => {
    if (!scopeOpen || !scopeRef.current) return;
    const box = scopeRef.current.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    setScopeAnchor(below < 240 && box.top > below
      ? { top: Math.max(8, box.top - 244), left: box.left }
      : { top: box.bottom + 4, left: box.left });
  }, [scopeOpen, sources]);

  function pick(operation: SpecSourceOperation) {
    onPick(operation);
    setKeyword("");
    setResults([]);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { setOpen(false); return; }
    if (!results.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((current) => (current + 1) % results.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((current) => (current - 1 + results.length) % results.length); }
    else if (event.key === "Enter") { event.preventDefault(); pick(results[highlight]); }
  }

  function toggleScope(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    persistSelection(next);
  }

  const needle = debounced.trim();
  const hasSources = Boolean(sources?.length);
  const showPop = open && sources !== undefined && (!hasSources || searching || results.length > 0 || needle.length > 0);

  return <div className="source-search-row" ref={rowRef}>
    <button
      ref={scopeRef}
      type="button"
      className="btn btn-small source-scope-btn"
      disabled={!hasSources}
      title={t("editor.sourceSearchScope")}
      onClick={() => { setScopeOpen((current) => !current); setOpen(false); }}
    >
      {t("editor.sourceSearchScope")}<span className="mono source-scope-count">{selectedIds.size}/{sources?.length ?? 0}</span>
    </button>

    <span className="var-field">
      <input
        ref={inputRef}
        className="input mono request-url"
        value={keyword}
        placeholder={t("editor.sourceSearchPlaceholder")}
        spellCheck={false}
        aria-label={t("editor.sourceSearch")}
        onChange={(event) => { setKeyword(event.target.value); setOpen(true); setScopeOpen(false); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showPop && <div className="var-field-pop source-search-pop" style={{ top: anchor.top, left: anchor.left }}>
        {!hasSources
          ? <p className="muted var-field-empty">{t("editor.sourceSearchNoSources")}</p>
          : !scopeIds.length
            ? <p className="muted var-field-empty">{t("editor.sourceSearchScopeNone")}</p>
            : failed
              ? <p className="muted var-field-empty">{t("editor.sourceSearchFailed")}</p>
              : searching && !results.length
                ? <p className="muted var-field-empty">{t("import.searching")}</p>
                : !needle
                  ? <p className="muted var-field-empty">{t("editor.sourceSearchStart")}</p>
                  : needle.length < MIN_KEYWORD
                    ? <p className="muted var-field-empty">{t("editor.sourceSearchMin")}</p>
                    : !results.length
                      ? <p className="muted var-field-empty">{t("import.noResults")}</p>
                      : results.map((operation, index) => <button
                        key={`${operation.method} ${operation.url} ${operation.sources.join(",")}`}
                        type="button"
                        className={`var-field-item source-search-item${index === highlight ? " is-active" : ""}`}
                        onMouseDown={(event) => { event.preventDefault(); pick(operation); }}
                        onMouseEnter={() => setHighlight(index)}
                      >
                        <Method method={operation.method} />
                        <span className="source-search-name truncate">{operation.name}</span>
                        <span className="mono muted truncate source-search-url">{operation.url}</span>
                        {/* 每条都标出来源（同 url / 同名字在不同来源时也能分辨）。 */}
                        <span className="chip source-search-source">{operation.sources.join(" · ")}</span>
                      </button>)}
      </div>}
    </span>

    {scopeOpen && <div className="var-field-pop source-scope-pop" style={{ top: scopeAnchor.top, left: scopeAnchor.left }}>
      <div className="source-scope-head">
        <span>{t("editor.sourceSearchScope")}</span>
        <span className="filter-spacer" />
        <button type="button" className="cell-link" onClick={() => persistSelection(new Set(allIds))}>{t("editor.sourceSearchScopeAll")}</button>
        <button type="button" className="cell-link" onClick={() => persistSelection(new Set())}>{t("editor.sourceSearchScopeClear")}</button>
      </div>
      {hasSources
        ? <div className="source-scope-list">
          {sources!.map((source) => <label key={source.id} className="source-scope-item">
            <input type="checkbox" checked={selectedIds.has(source.id)} onChange={() => toggleScope(source.id)} />
            <span className="truncate">{source.name}</span>
            {source.isTemporary && <span className="chip">{t("specSources.temporary")}</span>}
            <span className="muted mono">{source.operationCount}</span>
          </label>)}
        </div>
        : <p className="muted var-field-empty">{t("editor.sourceSearchNoSources")}</p>}
    </div>}
  </div>;
}
