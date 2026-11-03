import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import { useTranslation } from "react-i18next";
import { api, type Script, type ScriptCompletionSymbol, type ScriptRuntimeKind } from "../api";

const contractCache = new Map<string, ReturnType<typeof api.scriptContract>>();

type Props = {
  projectId: string;
  runtimeKind: ScriptRuntimeKind | "library";
  libraries?: Script[];
  value: string;
  onChange: (value: string) => void;
  height: string;
  theme: string;
  readOnly?: boolean;
};

/**
 * Monaco's own types, reached through `@monaco-editor/react`.
 *
 * `monaco-editor` is a transitive dependency, so importing from it directly
 * would depend on the hoisting layout. Deriving from the wrapper's exported
 * types keeps the completion callback typed without adding that coupling.
 */
type CodeModel = NonNullable<ReturnType<Parameters<OnMount>[0]["getModel"]>>;
type CodePosition = InstanceType<Monaco["Position"]>;

/** Shared Monaco boundary for ctx and selected-library completion. */
export function ScriptCodeEditor({ projectId, runtimeKind, libraries = [], value, onChange, height, theme, readOnly }: Props) {
  const { t } = useTranslation();
  const editorRef = useRef<Parameters<OnMount>[0]>();
  const symbolsRef = useRef<ScriptCompletionSymbol[]>([]);
  const modelPath = useRef(`inmemory://apitest/script-${crypto.randomUUID()}.js`);
  const [ctxSymbols, setCtxSymbols] = useState<ScriptCompletionSymbol[]>([]);

  useEffect(() => {
    if (runtimeKind === "library") { setCtxSymbols([]); return; }
    let stale = false;
    let pending = contractCache.get(projectId);
    if (!pending) {
      pending = api.scriptContract(projectId);
      contractCache.set(projectId, pending);
    }
    void pending.then((contract) => {
      if (!stale) setCtxSymbols(contract.ctx.find((item) => item.kind === runtimeKind)?.symbols ?? []);
    }).catch(() => {
      contractCache.delete(projectId);
      if (!stale) setCtxSymbols([]);
    });
    return () => { stale = true; };
  }, [projectId, runtimeKind]);

  const librarySymbols = useMemo(() => libraries.flatMap((library) => (library.symbols ?? []).map((symbol) => ({
    ...symbol,
    detail: `${symbol.detail} · ${library.name ?? library.id}`,
  }))), [libraries]);
  symbolsRef.current = [...ctxSymbols, ...librarySymbols];

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    const model = editor.getModel();
    const disposable = monaco.languages.registerCompletionItemProvider("javascript", {
      triggerCharacters: ["."],
      provideCompletionItems(candidate: CodeModel, position: CodePosition) {
        if (candidate !== model) return { suggestions: [] };
        const line = candidate.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const typed = line.match(/(?:ctx(?:\.[A-Za-z_$][\w$]*)*\.?|[A-Za-z_$][\w$]*)$/)?.[0] ?? "";
        const startColumn = Math.max(1, position.column - typed.length);
        const suggestions = symbolsRef.current
          .filter((symbol) => !typed || (typed.startsWith("ctx") ? symbol.name.startsWith(typed) : !symbol.name.startsWith("ctx") && symbol.name.startsWith(typed)))
          .map((symbol) => ({
            label: symbol.name,
            kind: completionKind(monaco, symbol.kind),
            insertText: symbol.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: symbol.detail,
            documentation: symbol.documentation,
            range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn, endColumn: position.column },
          }));
        return { suggestions };
      },
    });
    editor.onDidDispose(() => disposable.dispose());
  };

  function insertSymbol(symbol: ScriptCompletionSymbol) {
    const editor = editorRef.current;
    if (!editor || readOnly) return;
    const selection = editor.getSelection();
    if (!selection) return;
    editor.executeEdits("script-symbol", [{ range: selection, text: plainInsert(symbol.insertText), forceMoveMarkers: true }]);
    editor.focus();
  }

  return <>
    <Editor
      path={modelPath.current}
      height={height}
      language="javascript"
      theme={theme}
      value={value}
      onChange={(next) => onChange(next ?? "")}
      onMount={onMount}
      options={{
        readOnly,
        minimap: { enabled: false },
        lineNumbers: "on",
        fontSize: 12,
        fontFamily: "'JetBrains Mono', monospace",
        scrollBeyondLastLine: false,
        tabSize: 2,
        automaticLayout: true,
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: true,
      }}
    />
    {libraries.length > 0 && <details className="script-library-catalog">
      <summary>{t("scripts.librarySymbols", { count: librarySymbols.length })}</summary>
      {libraries.map((library) => <div className="script-library-group" key={library.id}>
        <strong>{library.name}</strong>
        {(library.symbols ?? []).length
          ? <div className="script-symbol-list">{(library.symbols ?? []).map((symbol) => <button type="button" className="chip mono" key={symbol.name} title={symbol.documentation} disabled={readOnly} onClick={() => insertSymbol(symbol)}>{symbol.name}</button>)}</div>
          : <span className="muted">{t("scripts.libraryNoSymbols")}</span>}
      </div>)}
    </details>}
  </>;
}

function completionKind(monaco: Monaco, kind: ScriptCompletionSymbol["kind"]) {
  if (kind === "function" || kind === "method") return monaco.languages.CompletionItemKind.Function;
  if (kind === "class") return monaco.languages.CompletionItemKind.Class;
  if (kind === "constant") return monaco.languages.CompletionItemKind.Constant;
  return monaco.languages.CompletionItemKind.Property;
}

function plainInsert(value: string) {
  return value.replace(/\$\{\d+:([^}]+)}/g, "$1").replace(/\$\{\d+}/g, "");
}
