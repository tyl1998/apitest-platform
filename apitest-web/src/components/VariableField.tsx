import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { VariableOption } from "./VariablePicker";

/**
 * A text field that completes `{{variable}}` as you type.
 *
 * Replaces the "insert variable" buttons that used to sit beside every field.
 * Those had two problems: they added a control to every row whether or not
 * anyone wanted a variable, and they inserted at the end of the value rather
 * than at the caret, so using one in the middle of a URL meant fixing it up by
 * hand afterwards.
 *
 * Typing `{{` is the trigger because it is what people already type. The list
 * filters on what follows, so `{{tok` narrows to `token` without a round trip
 * to a picker — and a name that is not in the list is immediately visible as
 * "no suggestions", which is the cheapest way to catch `{{tokne}}` before it
 * ships as literal text in a request.
 */

const MAX_SUGGESTIONS = 8;

/** The unclosed `{{` before the caret, if the caret is inside one. */
function activeReference(value: string, caret: number) {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf("{{");
  if (start < 0) return undefined;
  const term = before.slice(start + 2);
  /**
   * A `}}` or a line break between the braces and the caret means this is an
   * already-finished reference the caret happens to be sitting after. Without
   * this check, moving the caret past any existing `{{var}}` would reopen the
   * list over a field the user is not editing.
   */
  if (term.includes("}}") || term.includes("\n")) return undefined;
  return { start, term };
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: VariableOption[];
  /** Renders a textarea instead of an input, for request bodies. */
  multiline?: boolean;
  className?: string;
  placeholder?: string;
  rows?: number;
  spellCheck?: boolean;
  /** `password` for credential fields; the完成 popover still works over the mask. */
  type?: "text" | "password";
  "aria-label"?: string;
};

export function VariableField({ value, onChange, options, multiline, className, placeholder, rows, spellCheck, type, ...rest }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  /** Viewport coordinates for the popover, recomputed as the list opens. */
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  /** Set when an insert moves the caret; applied after the value has committed. */
  const pendingCaret = useRef<number>();

  const active = useMemo(() => (open ? activeReference(value, caret) : undefined), [open, value, caret]);

  const matches = useMemo(() => {
    if (!active) return [];
    const term = active.term.trim().toLowerCase();
    const matching = term ? options.filter((option) => option.name.toLowerCase().includes(term)) : options;
    return matching.slice(0, MAX_SUGGESTIONS);
  }, [active, options]);

  /* Highlight returns to the top whenever the candidate set changes, so Enter
     never accepts a row that scrolled out from under the selection. */
  useEffect(() => { setHighlight(0); }, [active?.term]);

  /**
   * Anchored to the field, below it.
   *
   * Not to the caret itself: measuring a caret inside a textarea requires
   * mirroring the whole element, and the gain — a popover a few pixels closer
   * to the cursor — does not justify a second copy of the text laid out
   * offscreen. Below the field is unambiguous and stays put while typing.
   */
  useLayoutEffect(() => {
    if (!active || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    /* Flip above when the field sits low enough that the list would be clipped. */
    const below = window.innerHeight - box.bottom;
    setAnchor(below < 220 && box.top > below
      ? { top: Math.max(8, box.top - 224), left: box.left }
      : { top: box.bottom + 4, left: box.left });
  }, [active, value]);

  useLayoutEffect(() => {
    if (pendingCaret.current === undefined || !ref.current) return;
    ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = undefined;
  }, [value]);

  function sync(element: HTMLInputElement | HTMLTextAreaElement) {
    setCaret(element.selectionStart ?? element.value.length);
  }

  function accept(name: string) {
    if (!active) return;
    const after = value.slice(caret);
    /* Consume a `}}` the user (or a paste) already typed, so accepting a
       suggestion cannot leave `{{token}}}}` behind. */
    const tail = after.startsWith("}}") ? after.slice(2) : after;
    const inserted = `{{${name}}}`;
    onChange(`${value.slice(0, active.start)}${inserted}${tail}`);
    pendingCaret.current = active.start + inserted.length;
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!active || !matches.length) {
      /* Escape still closes a list showing "no suggestions", which is otherwise
         only dismissable by deleting the braces. */
      if (event.key === "Escape" && open) setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((current) => (current + 1) % matches.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((current) => (current - 1 + matches.length) % matches.length); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); accept(matches[highlight].name); }
    else if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
  }

  const shared = {
    ref,
    className,
    value,
    placeholder,
    spellCheck,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(event.target.value);
      sync(event.target);
      setOpen(true);
    },
    /* Caret moves without an edit still open or close the list, so clicking
       into an existing `{{` offers its alternatives. */
    onKeyUp: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => sync(event.currentTarget),
    onClick: (event: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => { sync(event.currentTarget); setOpen(true); },
    onFocus: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => { sync(event.currentTarget); setOpen(true); },
    onBlur: () => setOpen(false),
    onKeyDown,
    ...rest,
  };

  return <span className={`var-field${multiline ? " is-multiline" : ""}`}>
    {multiline
      ? <textarea {...shared} rows={rows} />
      /* `type` only exists on the input branch: a masked textarea is not a thing,
         and a body field has no password variant. */
      : <input {...shared} type={type} />}

    {active && <div className="var-field-pop" style={{ top: anchor.top, left: anchor.left }}>
      {matches.length ? matches.map((option, index) => <button
        key={`${option.origin}:${option.name}`}
        type="button"
        className={`var-field-item${index === highlight ? " is-active" : ""}`}
        /* mousedown, not click: the field's blur would close the list before a
           click ever landed. */
        onMouseDown={(event) => { event.preventDefault(); accept(option.name); }}
        onMouseEnter={() => setHighlight(index)}
      >
        <span className="mono var-field-name">{option.name}</span>
        <span className="var-field-origin">{t(`variables.origin.${option.origin}`)}</span>
        {option.detail && <span className="mono muted truncate">{option.detail}</span>}
      </button>) : <p className="muted var-field-empty">{t("variables.noMatch", { term: active.term })}</p>}
    </div>}
  </span>;
}
