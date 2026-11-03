import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * 环形（P8-5 从 Trends.tsx 的 FailureDonut 提成底座）。
 *
 * 半径 15.915（周长恰为 100，dasharray 直接用百分比）；hover 高亮用描边加粗表达
 * ——不引入语义色之外的颜色，也不做动画（Quiet Console 的 motion 预算只有
 * 状态切换）。中心数字 + 外侧图例沿用 P3-9 形态。
 *
 * `onSliceClick`（P8-6 下钻接线）：某片 → 调用方（归因片 → 报告列表 +
 * `attribution=<code>` 筛选，12.2 的 URL 表）；片与图例两条路都触发，同一片的
 * 两个入口不该指向两个地方。
 */
export type DonutSegment = { label: string; value: number; color: string };

export function Donut({ segments, centerLabel, onSliceClick }: { segments: DonutSegment[]; centerLabel?: string; onSliceClick?: (index: number) => void }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<number>();
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (!total) return <p className="form-note">{t("charts.noData")}</p>;
  const R = 15.915;
  let offset = 25; /* 从 12 点方向起 */
  return <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
    <svg viewBox="0 0 42 42" width={132} height={132} preserveAspectRatio="none" role="img" aria-label={centerLabel ?? t("charts.distribution")}>
      <circle cx="21" cy="21" r={R} fill="none" style={{ stroke: "var(--line)" }} strokeWidth={5} />
      {segments.map((segment, index) => {
        const share = (segment.value / total) * 100;
        const dash = `${share} ${100 - share}`;
        const element = <circle
          key={segment.label}
          cx="21" cy="21" r={R} fill="none"
          style={{ stroke: segment.color, opacity: hovered === undefined || hovered === index ? 1 : 0.35, cursor: onSliceClick ? "pointer" : undefined }}
          strokeWidth={hovered === index ? 6 : 5}
          strokeDasharray={dash}
          strokeDashoffset={offset}
          onPointerEnter={() => setHovered(index)}
          onPointerLeave={() => setHovered(undefined)}
          onPointerDown={() => { if (onSliceClick) onSliceClick(index); }}
        />;
        offset -= share;
        return element;
      })}
      <text x="21" y="20" textAnchor="middle" className="mono" style={{ fill: "var(--ink)", fontSize: 6, fontWeight: 600 }}>
        {hovered === undefined ? total : segments[hovered].value}
      </text>
      <text x="21" y="26" textAnchor="middle" style={{ fill: "var(--ink-3)", fontSize: 2.8 }}>
        {hovered === undefined ? centerLabel ?? t("charts.total") : `${((segments[hovered].value / total) * 100).toFixed(1)}%`}
      </text>
    </svg>
    <ul className="chart-legend">
      {segments.map((segment, index) => <li
        key={segment.label}
        onPointerEnter={() => setHovered(index)}
        onPointerLeave={() => setHovered(undefined)}
        onClick={() => { if (onSliceClick) onSliceClick(index); }}
        style={onSliceClick ? { cursor: "pointer" } : undefined}
      >
        <span className="chart-key" style={{ background: segment.color }} />
        <span className="truncate">{segment.label}</span>
        <span className="mono muted">{segment.value}</span>
      </li>)}
    </ul>
  </div>;
}
