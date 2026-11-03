import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, History } from "lucide-react";
import { IconButton } from "./IconButton";

/**
 * The history sidebar shared by the endpoint and flow workspaces.
 *
 * Both editors show the same thing — recent runs for the asset being edited —
 * so the panel, the collapse control and the collapsed rail live here once
 * instead of being inlined twice and drifting apart. Each workspace supplies
 * its own header (a title, or the segmented 用例/调试记录 control), filter,
 * list content and pager.
 */
export function HistorySidebar({ open, onToggle, header, filter, list, pager, railLabel, railCount }: {
  open: boolean;
  onToggle: () => void;
  /** Optional header inside the card; defaults to the rail label. */
  header?: ReactNode;
  /** The filters row (source/status selects). */
  filter?: ReactNode;
  /** The run list. */
  list: ReactNode;
  pager?: ReactNode;
  railLabel: string;
  railCount: number;
}) {
  const { t } = useTranslation();

  if (!open) {
    return <button className="history-rail" onClick={onToggle} title={t("history.expand")} aria-label={t("history.expand")}>
      <History size={15} />
      <span className="mono history-rail-count">{railCount}</span>
      <span className="history-rail-label">{railLabel}</span>
    </button>;
  }

  return <aside className="workbench-side">
    <div className="panel history-card">
      <div className="panel-head">
        {header ?? <strong>{railLabel}</strong>}
        <IconButton icon={<ChevronRight size={15} />} label={t("history.collapse")} onClick={onToggle} />
      </div>
      {filter}
      <div className="history-list">{list}</div>
      {pager}
    </div>
  </aside>;
}
