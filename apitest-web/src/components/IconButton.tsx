import type { ReactNode } from "react";
import { Tooltip } from "antd";

/**
 * Icon-only action button.
 *
 * The label is required and becomes both the tooltip and the accessible name,
 * so an icon never ships without a text equivalent. Actions stay compact
 * enough to sit on one row, which keeps table rows a uniform height.
 */
export function IconButton({ icon, label, onClick, tone, disabled, active }: {
  icon: ReactNode;
  label: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  tone?: "default" | "primary" | "danger";
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Tooltip title={label} mouseEnterDelay={0.4}>
      <button
        type="button"
        className={`icon-btn${tone && tone !== "default" ? ` is-${tone}` : ""}${active ? " is-active" : ""}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
