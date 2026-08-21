import { useState } from "react";
import { Drawer } from "antd";
import { useTranslation } from "react-i18next";

/**
 * Picks response header names for header assertions.
 *
 * The body picker walks a tree; headers are a flat list, so this is a simple
 * checkbox list instead.
 */
export function HeaderPicker({ open, headers, onClose, onPick }: {
  open: boolean;
  headers?: Record<string, string>;
  onClose: () => void;
  onPick: (names: string[]) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [seeded, setSeeded] = useState(false);

  if (open && !seeded) {
    setSeeded(true);
    setSelected([]);
  }
  if (!open && seeded) setSeeded(false);

  function toggleSelected(name: string) {
    setSelected((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  }

  const rows = headers ? Object.entries(headers) : [];

  return <Drawer
    title={t("assertions.pickHeaderTitle")}
    open={open}
    onClose={onClose}
    width={480}
    extra={<div className="history-tools">
      <span className="muted mono">{t("assertions.pickSelected", { count: selected.length })}</span>
      <button className="btn btn-primary" disabled={!selected.length} onClick={() => { onPick(selected); onClose(); }}>
        {t("assertions.pickConfirm")}
      </button>
    </div>}
  >
    {!rows.length
      ? <p className="muted">{t("assertions.pickNeedsResponse")}</p>
      : <div className="header-list">
          {rows.map(([name, value]) => <label key={name} className="header-row">
            <input type="checkbox" checked={selected.includes(name)} onChange={() => toggleSelected(name)} />
            <span className="mono header-name">{name}</span>
            <span className="mono muted header-value truncate">{value}</span>
          </label>)}
        </div>}
  </Drawer>;
}
