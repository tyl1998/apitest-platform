import { useMemo, useState } from "react";
import { Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { Crosshair, X } from "lucide-react";
import type { Assertion, AssertionOperator, AssertionResult, AssertionType, ScriptCheck } from "../api";
import { IconButton } from "./IconButton";
import { JsonPathPicker } from "./JsonPathPicker";
import { HeaderPicker } from "./HeaderPicker";
import { ModeSwitch } from "./KeyValueEditor";
import { RunStatusTag } from "./RunStatusTag";

const TYPES: AssertionType[] = ["status", "header", "jsonPath", "jsonSchema"];
const OPERATORS: AssertionOperator[] = ["equals", "notEquals", "contains", "exists", "notExists", "greaterThan", "lessThan"];
/** Presence operators have nothing to compare against, so the value column hides. */
const PRESENCE: AssertionOperator[] = ["exists", "notExists"];

/**
 * Types whose input is a block, not a row.
 *
 * A schema document does not fit the target/operator/value layout, so this row
 * drops the operator and value columns and opens an editor underneath instead.
 */
const BLOCK_TYPES: AssertionType[] = ["jsonSchema"];
const FIXED_OPERATOR: Partial<Record<AssertionType, AssertionOperator>> = {
  jsonSchema: "matchesSchema",
};

export function isPresenceOperator(operator: AssertionOperator) {
  return PRESENCE.includes(operator);
}

export function isBlockType(type: AssertionType) {
  return BLOCK_TYPES.includes(type);
}

/** Text-mode symbols. Short and typeable, so a rule reads as one line. */
const SYMBOLS: Record<AssertionOperator, string> = {
  equals: "=",
  notEquals: "!=",
  contains: "~",
  exists: "exists",
  notExists: "!exists",
  greaterThan: ">",
  lessThan: "<",
  /* Block types never serialize to text, so these are placeholders that keep the
     record total rather than symbols anyone types. */
  matchesSchema: "matchesSchema",
  isTrue: "isTrue",
};

/**
 * One assertion per line, e.g.
 *   `$.status = 200`
 *   `$.headers.content-type ~ json`
 *   `$.body.data.token exists`
 *
 * The `$.headers.` and `$.body` prefixes are how the server already addresses
 * a response, so the text form matches what the assertion actually reads.
 */
function serializeAssertions(assertions: Assertion[]): string {
  /* Block types have no one-line form; they are preserved out of band by the
     caller rather than rendered here as something unparseable. */
  return assertions.filter((assertion) => !isBlockType(assertion.type)).map((assertion) => {
    const target = assertion.type === "status" ? "$.status"
      : assertion.type === "header" ? `$.headers.${assertion.target ?? ""}`
      : assertion.target ?? "";
    const symbol = SYMBOLS[assertion.operator];
    return isPresenceOperator(assertion.operator) ? `${target} ${symbol}` : `${target} ${symbol} ${assertion.expected ?? ""}`;
  }).join("\n");
}

function parseAssertions(text: string): Assertion[] {
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;

    /* Longest symbols first, so `!=` is not read as `=` and `!exists` is not
       read as `exists`. */
    const ordered = (Object.entries(SYMBOLS) as [AssertionOperator, string][])
      .sort((a, b) => b[1].length - a[1].length);

    for (const [operator, symbol] of ordered) {
      const at = trimmed.indexOf(` ${symbol}`);
      if (at < 0) continue;
      const rawTarget = trimmed.slice(0, at).trim();
      const expected = trimmed.slice(at + symbol.length + 1).trim();
      if (!rawTarget) continue;

      const lower = rawTarget.toLowerCase();
      const type: AssertionType = lower === "$.status" ? "status" : lower.startsWith("$.headers.") ? "header" : "jsonPath";
      const target = type === "header" ? rawTarget.slice("$.headers.".length) : rawTarget;

      const assertion: Assertion = { type, operator };
      if (type !== "status") assertion.target = target;
      if (!isPresenceOperator(operator)) assertion.expected = expected;
      return assertion;
    }
    return null;
  }).filter((assertion): assertion is Assertion => assertion !== null);
}

/** The status-code assertion 保存为用例 pre-fills from the last response (交互文档 3.1.3). */
export function defaultAssertions(statusCode?: number): Assertion[] {
  return [{ type: "status", operator: "equals", expected: String(statusCode ?? 200) }];
}

/**
 * Assertion table for a case.
 *
 * `results` is optional: the same table shows the configuration while editing
 * and the verdict after a run, so a failure is read in the row that caused it
 * instead of a separate list.
 *
 * `responseBody` powers 快速提取: paths are picked out of the body actually
 * returned, rather than typed from memory.
 */
export function AssertionEditor({ assertions, onChange, results, responseBody, responseHeaders }: {
  /** Kept in the shared prop contract for existing call sites. */
  projectId: string;
  assertions: Assertion[];
  onChange: (assertions: Assertion[]) => void;
  results?: AssertionResult[];
  responseBody?: string;
  /** Powers 快速提取 for header assertions, the same way the body does for JSONPath. */
  responseHeaders?: Record<string, string>;
  responseStatusCode?: number;
  environmentId?: string;
  variables?: Record<string, string>;
}) {
  const { t } = useTranslation();
  /** The row 快速提取 was opened for; picking replaces that row's target. */
  const [picking, setPicking] = useState<number>();
  const [mode, setMode] = useState<"table" | "text">("table");
  const [textValue, setTextValue] = useState("");
  function switchToText() {
    setTextValue(serializeAssertions(assertions));
    setMode("text");
  }

  function switchToTable() {
    /**
     * Applied as written, so clearing the box clears the rules — but only the
     * ones text mode can express. Schema assertions are re-attached
     * unchanged, because a mode that cannot render them must not be able to
     * delete them either.
     */
    const preserved = assertions.filter((assertion) => isBlockType(assertion.type));
    onChange([...parseAssertions(textValue), ...preserved]);
    setMode("table");
  }

  /** Assertions the text box is holding aside, so the note can name the count. */
  const blockCount = assertions.filter((assertion) => isBlockType(assertion.type)).length;

  function update(index: number, patch: Partial<Assertion>) {
    onChange(assertions.map((assertion, i) => {
      if (i !== index) return assertion;
      const next = { ...assertion, ...patch };

      /* Changing type rebuilds the row: each type has its own input shape, and
         leftovers from the previous one would submit silently. */
      if (patch.type && patch.type !== assertion.type) {
        const fixed = FIXED_OPERATOR[patch.type];
        if (fixed) next.operator = fixed;
        else if (isBlockType(assertion.type)) next.operator = "equals";

        if (patch.type === "jsonSchema") {
          delete next.target;
          /* A permissive starting schema: valid, and edits narrow it. */
          if (!next.expected?.trim().startsWith("{")) next.expected = '{\n  "type": "object"\n}';
        } else {
          if (isBlockType(assertion.type)) next.expected = "";
        }
      }

      /* Switching to a presence operator drops a now-meaningless expected value
         so it cannot be silently submitted. */
      if (patch.operator && isPresenceOperator(patch.operator)) delete next.expected;
      else if (patch.operator && !isBlockType(next.type) && next.expected === undefined) next.expected = "";
      /* status always reads the status code, so a target would be ignored. */
      if (next.type === "status") delete next.target;
      return next;
    }));
  }

  /* Refuses rather than opening an empty picker: with no response there is
     nothing to extract from, and the fix is to send the request first. */
  function openPicker(index: number, type: "header" | "jsonPath") {
    const assertion = assertions[index];
    if (type === "jsonPath") {
      if (!responseBody) { message.info(t("assertions.pickNeedsResponse")); return; }
      try { JSON.parse(responseBody); } catch { message.info(t("assertions.pickNotJson")); return; }
    }
    if (type === "header" && !responseHeaders) { message.info(t("assertions.pickNeedsResponse")); return; }
    setPicking(index);
  }

  /**
   * First path replaces the row that asked; the rest are appended as their own
   * assertions, so picking several yields several checks. Headers work the same
   * way: pick one or many, the first fills the current row.
   */
  function applyPicked(paths: string[]) {
    if (picking === undefined || !paths.length) return;
    const [first, ...rest] = paths;
    /* Header names arrive bare; JSONPath arrives prefixed with `$.`. */
    const type: AssertionType = first.startsWith("$.") ? "jsonPath" : "header";
    const next = assertions.map((item, i) => i === picking ? { ...item, type, target: first } : item);
    onChange([...next, ...rest.map((path): Assertion => ({ type, target: path, operator: "exists" }))]);
  }

  return <div className="assertions">
    <div className="kv-head">
      <h3 className="subhead">{t("assertions.title")}</h3>
      <ModeSwitch mode={mode} onTable={switchToTable} onText={switchToText} />
    </div>
    {/* States the rule that makes assertions worth writing: they, not the HTTP
        status, decide the verdict. */}
    <p className="form-note">{t("assertions.verdictHint")}</p>

    {mode === "table" ? <>
    {assertions.map((assertion, index) => {
      const result = results?.[index];
      const block = isBlockType(assertion.type);

      /* Block types own the full width: their input is an editor, not a cell. */
      if (block) return <div className="assertion-block" key={index}>
        <div className="assertion-row">
          <Select
            size="small"
            value={assertion.type}
            onChange={(type) => update(index, { type })}
            options={TYPES.map((value) => ({ value, label: t(`assertions.type.${value}`) }))}
            style={{ width: 104 }}
          />
          {result && <span className="assertion-verdict">
            <RunStatusTag status={result.passed ? "pass" : "fail"} />
          </span>}
          {/* Same ghost ✕ as the key/value rows: one delete affordance across
              every row editor, revealed on hover rather than boxed per row. */}
          <button type="button" className="icon-btn is-ghost row-remove" onClick={() => onChange(assertions.filter((_, i) => i !== index))} aria-label={t("action.delete")}><X size={14} /></button>
        </div>
        <SchemaInput
          value={assertion.expected ?? ""}
          onChange={(expected) => update(index, { expected })}
        />

        {result && !result.passed && result.message && <pre className="mono assertion-block-error">{result.message}</pre>}
      </div>;

      return <div className="assertion-row" key={index}>
        <Select
          size="small"
          value={assertion.type}
          onChange={(type) => update(index, { type })}
          options={TYPES.map((value) => ({ value, label: t(`assertions.type.${value}`) }))}
          style={{ width: 104 }}
        />
        {assertion.type === "status"
          ? <span className="mono assertion-fixed">$.status</span>
          : <span className="assertion-target">
              <input
                className="input mono"
                value={assertion.target ?? ""}
                onChange={(event) => update(index, { target: event.target.value })}
                placeholder={assertion.type === "header" ? "content-type" : "$.data.token"}
                aria-label={t("assertions.target")}
              />
              {/* JSONPath extracts from body; header extracts from response headers. */}
              {assertion.type === "jsonPath" && <IconButton icon={<Crosshair size={13} />} label={t("assertions.pick")} onClick={() => openPicker(index, "jsonPath")} />}
              {assertion.type === "header" && responseHeaders && <IconButton icon={<Crosshair size={13} />} label={t("assertions.pick")} onClick={() => openPicker(index, "header")} />}
            </span>}
        <Select
          size="small"
          value={assertion.operator}
          onChange={(operator) => update(index, { operator })}
          options={OPERATORS.map((value) => ({ value, label: t(`assertions.operator.${value}`) }))}
          style={{ width: 108 }}
        />
        {isPresenceOperator(assertion.operator)
          ? <span className="assertion-fixed muted">—</span>
          : <input
              className="input mono"
              value={assertion.expected ?? ""}
              onChange={(event) => update(index, { expected: event.target.value })}
              placeholder={assertion.type === "status" ? "200" : t("assertions.expected")}
              aria-label={t("assertions.expected")}
            />}
        {result && <span className="assertion-verdict">
          <RunStatusTag status={result.passed ? "pass" : "fail"} />
          {!result.passed && <span className="mono muted assertion-actual">{result.message ?? t("assertions.actual", { value: result.actual ?? "—" })}</span>}
        </span>}
        <button type="button" className="icon-btn is-ghost row-remove" onClick={() => onChange(assertions.filter((_, i) => i !== index))} aria-label={t("action.delete")}><X size={14} /></button>
      </div>;
    })}
    <button type="button" className="btn" onClick={() => onChange([...assertions, { type: "jsonPath", target: "$.", operator: "exists" }])}>
      {t("assertions.add")}
    </button>
    <p className="form-note">{t("assertions.hint")}</p>
    </> : <>
      <textarea
        className="input kv-text"
        value={textValue}
        onChange={(event) => setTextValue(event.target.value)}
        placeholder={t("assertions.textModePlaceholder")}
        rows={10}
        spellCheck={false}
      />
      <p className="form-note">{t("assertions.textModeHint")}</p>
      {/* Says the schema rules are still there. Without this, a user
          who cannot see them in the box assumes they were dropped. */}
      {blockCount > 0 && <p className="form-note">{t("assertions.textModeBlockNote", { count: blockCount })}</p>}
    </>}

    <JsonPathPicker
      open={picking !== undefined && (assertions[picking]?.type === "jsonPath")}
      body={responseBody}
      onClose={() => setPicking(undefined)}
      onPick={applyPicked}
    />
    <HeaderPicker
      open={picking !== undefined && (assertions[picking]?.type === "header")}
      headers={responseHeaders}
      onClose={() => setPicking(undefined)}
      onPick={applyPicked}
    />
  </div>;
}

/**
 * Schema input with its own validity check.
 *
 * A schema is checked for being parseable JSON as it is typed, because the
 * alternative is running the whole case to find out a brace is missing. This is
 * only a syntax check — whether the schema is *correct* is what the assertion
 * itself reports.
 */
function SchemaInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const error = useMemo(() => {
    if (!value.trim()) return t("assertions.schemaEmpty");
    try { JSON.parse(value); return undefined; }
    catch (parseError) { return parseError instanceof Error ? parseError.message : t("assertions.schemaInvalid"); }
  }, [value, t]);

  return <div className="assertion-schema">
    <textarea
      className="input kv-text mono"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={'{\n  "type": "object",\n  "required": ["id"]\n}'}
      rows={8}
      spellCheck={false}
      aria-label={t("assertions.schema")}
    />
    {error
      ? <p className="form-note text-fail">{error}</p>
      : <p className="form-note">{t("assertions.schemaValid")}</p>}
  </div>;
}

/** Per-check verdicts shared by pre-processing, response, and node scripts. */
export function ScriptChecks({ checks }: { checks?: ScriptCheck[] }) {
  if (!checks?.length) return null;
  return <ul className="script-checks">
    {checks.map((check, index) => <li key={index} className="mono">
      <span className={check.passed ? "text-pass" : "text-fail"}>{check.passed ? "✓" : "✗"}</span>
      {" "}{check.label}
      {!check.passed && check.message && check.message !== check.label && <span className="muted"> — {check.message}</span>}
    </li>)}
  </ul>;
}

/** Read-only assertion verdicts, for a result snapshot that is not being edited. */
export function AssertionResults({ results }: { results: AssertionResult[] }) {
  const { t } = useTranslation();
  if (!results.length) return null;

  const passed = results.filter((result) => result.passed).length;
  return <div className="code-block">
    <span className="label">{t("assertions.results", { passed, total: results.length })}</span>
    <div className="assertion-list">
      {results.map((result, index) => <div className="assertion-result" key={index}>
        <RunStatusTag status={result.passed ? "pass" : "fail"} />
        <code className="mono assertion-expr">
          {/* A schema is named instead of printing its full document. */}
          {isBlockType(result.type)
            ? t(`assertions.type.${result.type}`)
            : <>
                {result.type === "status" ? "$.status" : result.type === "header" ? `$.headers.${result.target}` : result.target}
                {" "}{t(`assertions.operator.${result.operator}`)}
                {!isPresenceOperator(result.operator) && ` ${result.expected}`}
              </>}
        </code>
        {!result.passed && result.message && <span className="mono muted">{result.message}</span>}
        {!result.passed && !result.message && <span className="mono muted">{t("assertions.actual", { value: result.actual ?? "—" })}</span>}
      </div>)}
    </div>
  </div>;
}
