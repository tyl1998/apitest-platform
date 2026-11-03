import { useState } from "react";
import { useTranslation } from "react-i18next";
import { List, AlignLeft, X } from "lucide-react";
import { IconButton } from "./IconButton";
import { normalizeFullWidthPunct } from "../lib/normalize";
import { VariableField } from "./VariableField";
import type { VariableOption } from "./VariablePicker";

export type Pair = { key: string; value: string; enabled: boolean };

/**
 * Table/text switch, shared by every editor that offers bulk paste.
 *
 * Rendered as one segmented control rather than two loose icon buttons: the
 * two icons are mutually exclusive states of the same view, and separate
 * bordered boxes read as unrelated actions next to a row's delete button.
 */
export function ModeSwitch({ mode, onTable, onText }: {
  mode: "table" | "text";
  onTable: () => void;
  onText: () => void;
}) {
  const { t } = useTranslation();
  return <div className="mode-switch" role="group" aria-label={t("editor.viewMode")}>
    <IconButton icon={<List size={14} />} label={t("editor.tableMode")} active={mode === "table"} onClick={() => mode === "text" && onTable()} />
    <IconButton icon={<AlignLeft size={14} />} label={t("editor.textMode")} active={mode === "text"} onClick={() => mode === "table" && onText()} />
  </div>;
}

export function toPairs(record: Record<string, string> | undefined): Pair[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value, enabled: true }));
}

export function fromPairs(pairs: Pair[]): Record<string, string> {
  return Object.fromEntries(pairs.filter((pair) => pair.enabled && pair.key.trim()).map((pair) => [pair.key.trim(), pair.value]));
}

/**
 * Parses text lines into pairs. Format: `key: value` or `key=value`.
 *
 * Only whole-line comments are recognised (`#` or `//` at the start). Stripping
 * them mid-line would corrupt the values people paste most: `https://…` would
 * lose its path and `#ff0000` would vanish entirely.
 */
function parseText(text: string): Pair[] {
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
    /* Split on the first delimiter only, so a value keeps any later `:` or `=`
       — `Bearer a=b` and `https://host/p` both survive. */
    const colon = trimmed.indexOf(":");
    const equals = trimmed.indexOf("=");
    const at = colon < 0 ? equals : equals < 0 ? colon : Math.min(colon, equals);
    if (at <= 0) return null;
    return { key: trimmed.slice(0, at).trim(), value: trimmed.slice(at + 1).trim(), enabled: true };
  }).filter((pair): pair is Pair => pair !== null);
}

/**
 * Serializes pairs into text lines. Format: `key: value`.
 */
function serializeText(pairs: Pair[]): string {
  return pairs.filter((pair) => pair.enabled && pair.key.trim()).map((pair) => `${pair.key}: ${pair.value}`).join("\n");
}

/**
 * Row editor for headers and params.
 *
 * Rows carry an `enabled` flag so a header can be parked without deleting it,
 * which is the normal way people debug a request. A text mode allows bulk
 * paste from curl/docs/Postman, using `key: value` or `key=value` format.
 *
 * `title` puts the mode switch on the section heading rather than floating it
 * above the rows: with two editors on the params tab, free-standing icon pairs
 * read as unattached controls.
 *
 * There is no "add row" button. A blank row always sits at the end and becomes
 * real as soon as anything is typed into it, so three stacked editors no longer
 * repeat the same button three times. The blank row is not part of `pairs`, so
 * it cannot mark the request dirty or save an empty key.
 */
export function KeyValueEditor({ pairs, onChange, keyPlaceholder, valuePlaceholder, title, hint, variableOptions }: {
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  title: string;
  hint?: string;
  /** Optional because environments and global key/value forms have no flow context. */
  variableOptions?: VariableOption[];
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"table" | "text">("table");
  const [textValue, setTextValue] = useState("");

  function switchToText() {
    setTextValue(serializeText(pairs));
    setMode("text");
  }

  function switchToTable() {
    /* An emptied box means "remove everything", so the parse is applied as-is
       rather than treated as a no-op. */
    onChange(parseText(normalizeFullWidthPunct(textValue)));
    setMode("table");
  }

  /**
   * `index === pairs.length` is the trailing blank row: an edit there appends
   * instead of patching. The row keeps the same list position and React key
   * across that transition, so the DOM node — and the caret in it — survives.
   * 值做全角归一（`：`→`:`），避免全角标点写进请求头被 fetch 拒绝。
   */
  function update(index: number, patch: Partial<Pair>) {
    const applied = patch.value !== undefined ? { ...patch, value: normalizeFullWidthPunct(patch.value) } : patch;
    if (index === pairs.length) {
      onChange([...pairs, { key: "", value: "", enabled: true, ...applied }]);
      return;
    }
    onChange(pairs.map((pair, i) => i === index ? { ...pair, ...applied } : pair));
  }

  const count = pairs.filter((pair) => pair.enabled && pair.key.trim()).length;
  /* The blank row is appended for rendering only; it never reaches `onChange`. */
  const rows: Pair[] = [...pairs, { key: "", value: "", enabled: true }];

  return <div className="kv">
    <div className="kv-head">
      <h3 className="subhead">{title}{count > 0 && <span className="tab-count mono">{count}</span>}</h3>
      {/* Icons, right-aligned on the heading line: the switch is a persistent
          control, not a labelled action, and two words per editor added up to
          more chrome than the rows it sits above. */}
      <ModeSwitch mode={mode} onTable={switchToTable} onText={switchToText} />
    </div>
    {hint && <p className="form-note">{hint}</p>}

    {mode === "table" ? <>
      {rows.map((pair, index) => {
        const blank = index === pairs.length;
        return <div className={`kv-row${blank ? " is-blank" : ""}`} key={index}>
          <input
            type="checkbox"
            className="kv-toggle"
            checked={pair.enabled}
            /* Disabled on the blank row: toggling nothing would otherwise
               commit an empty pair. */
            disabled={blank}
            onChange={(event) => update(index, { enabled: event.target.checked })}
            aria-label={t("editor.enabled")}
          />
          <input
            className="input mono"
            value={pair.key}
            placeholder={blank ? t("editor.addRow") : keyPlaceholder ?? t("editor.key")}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          {variableOptions
            ? <VariableField
                value={pair.value}
                onChange={(value) => update(index, { value })}
                options={variableOptions}
                className="input mono"
                placeholder={blank ? "" : valuePlaceholder ?? t("editor.value")}
                spellCheck={false}
              />
            : <input className="input mono" value={pair.value} placeholder={blank ? "" : valuePlaceholder ?? t("editor.value")} onChange={(event) => update(index, { value: event.target.value })} />}
          {/* Borderless and revealed on row hover/focus: a bordered box per row
              turned the right edge into a column of buttons competing with the
              values beside them. */}
          <button
            type="button"
            className="icon-btn is-ghost row-remove"
            disabled={blank}
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
            aria-label={t("action.delete")}
          >
            <X size={14} />
          </button>
        </div>;
      })}
    </> : <>
      {variableOptions
        ? <VariableField
            value={textValue}
            onChange={setTextValue}
            options={variableOptions}
            multiline
            className="input kv-text"
            placeholder={t("editor.textModePlaceholder")}
            rows={8}
            spellCheck={false}
          />
        : <textarea
            className="input kv-text"
            value={textValue}
            onChange={(event) => setTextValue(event.target.value)}
            placeholder={t("editor.textModePlaceholder")}
            rows={8}
            spellCheck={false}
          />}
      <p className="form-note">{t("editor.textModeHint")}</p>
    </>}
  </div>;
}
