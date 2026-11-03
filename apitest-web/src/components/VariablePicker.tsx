import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Braces } from "lucide-react";
import { IconButton } from "./IconButton";

/**
 * One variable a field can reference, and where it comes from.
 *
 * The origin matters more than the name: `token` produced by step 2 and `token`
 * sitting in the environment behave differently, and knowing which one will win
 * is the whole question when a request sends the wrong value.
 */
export type VariableOption = {
  name: string;
  /** Ordered by precedence, highest first — the picker groups by this. */
  origin: "step" | "flow" | "environment" | "builtin";
  /** Producing step, current value, or usage hint, depending on origin. */
  detail?: string;
};

/**
 * Inserts a `{{variable}}` into whichever field opened it.
 *
 * Exists because the alternative is remembering: a flow's variables are defined
 * in three different places (an upstream step's extracts, the flow's seed
 * values, the environment), and typing `{{tokne}}` produces a request that
 * silently sends the literal text rather than an error.
 */
export function VariablePicker({ options, onPick, label }: {
  options: VariableOption[];
  onPick: (reference: string) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");

  const groups = useMemo(() => {
    const term = keyword.trim().toLowerCase();
    const matching = term ? options.filter((option) => option.name.toLowerCase().includes(term)) : options;
    /* Precedence order, so the one that would actually win is read first. */
    return (["step", "flow", "environment", "builtin"] as const)
      .map((origin) => ({ origin, items: matching.filter((option) => option.origin === origin) }))
      .filter((group) => group.items.length);
  }, [options, keyword]);

  function pick(name: string) {
    onPick(`{{${name}}}`);
    setOpen(false);
    setKeyword("");
  }

  return <span className="var-picker">
    <IconButton icon={<Braces size={14} />} label={label ?? t("variables.insert")} onClick={() => setOpen((current) => !current)} />
    {open && <>
      {/* Click-away closes it: a popover pinned to a row cannot rely on blur,
          because the search box inside it takes focus first. */}
      <span className="var-picker-scrim" onClick={() => setOpen(false)} />
      <div className="var-picker-pop">
        <input
          className="input"
          value={keyword}
          autoFocus
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t("variables.search")}
        />
        {groups.length ? <div className="var-picker-list">
          {groups.map((group) => <div key={group.origin}>
            <span className="var-picker-group">{t(`variables.origin.${group.origin}`)}</span>
            {group.items.map((option) => <button
              key={`${group.origin}:${option.name}`}
              className="var-picker-item"
              onClick={() => pick(option.name)}
            >
              <span className="mono var-picker-name">{option.name}</span>
              {option.detail && <span className="mono muted truncate">{option.detail}</span>}
            </button>)}
          </div>)}
        </div> : <p className="muted var-picker-empty">{t("variables.none")}</p>}
        <p className="form-note">{t("variables.precedence")}</p>
      </div>
    </>}
  </span>;
}
