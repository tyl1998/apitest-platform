import type { ReactNode } from "react";
import { Tooltip } from "antd";

/**
 * Icon-only action button.
 *
 * The label is required and becomes both the tooltip and the accessible name,
 * so an icon never ships without a text equivalent. Actions stay compact
 * enough to sit on one row, which keeps table rows a uniform height.
 */
export function IconButton({ icon, label, onClick, tone, disabled, active, className }: {
  icon: ReactNode;
  label: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  tone?: "default" | "primary" | "danger";
  disabled?: boolean;
  active?: boolean;
  /** 调用方自带的外观钩子（如常红的退出标记）：只加类，不改语义。 */
  className?: string;
}) {
  return (
    <Tooltip title={label} mouseEnterDelay={0.4}>
      <button
        type="button"
        className={`icon-btn${tone && tone !== "default" ? ` is-${tone}` : ""}${active ? " is-active" : ""}${className ? ` ${className}` : ""}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
