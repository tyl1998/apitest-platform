import { useRef, useState } from "react";
import { bucketTimeLabel, edgeIndices, nearestBucket } from "./core";

/**
 * 堆叠柱（P8-5 从 Trends.tsx 的 VolumeBars 提成底座）。
 *
 * 堆叠顺序 = `layers` 顺序（第一层垫底）。语义色由调用方给（趋势页是
 * pass 垫底 + fail 叠顶——失败量是「先修哪个」的读数，放最上面离网格线最近）。
 * total=0 的桶画一粒 1px 灰线：空桶是「没有执行」，与「跑了一两个」在柱高上
 * 几乎不可分。
 */

const CHART_W = 720;
const BAR_H = 110;
const PAD_B = 18;
const PAD_X = 6;
const GAP = 3;

export type StackedBarBucket = {
  /** ISO 时间（轴标签用）。 */
  bucket: string;
  /** null = 这层这个桶没有样本：整柱高度按其余层算，那一层画零高。 */
  values: (number | null)[];
  /** 全层合计（含 null 层当 0）：0 表示空桶（画 1px 灰线标记）。 */
  total: number;
};

export type StackedBarsProps = {
  buckets: StackedBarBucket[];
  layers: { color: string }[];
  hourly: boolean;
  /** 读数条里每层的名字。 */
  labels?: string[];
  /** 空间不够时天桶也退化成小时标签的判定（趋势页沿 VolumeBars 原语义：>10 桶按天）。 */
  hourlyLabels?: (bucketCount: number) => boolean;
  onBucketClick?: (index: number) => void;
  ariaLabel?: string;
};

export function StackedBars({ buckets, layers, hourly, labels, hourlyLabels, onBucketClick, ariaLabel }: StackedBarsProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number>();

  const innerH = BAR_H - PAD_B;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.total));
  const gap = GAP;
  const barW = Math.max(2, (CHART_W - PAD_X * 2 - gap * Math.max(0, buckets.length - 1)) / buckets.length);
  const barX = (index: number) => PAD_X + index * (barW + gap);
  const labelAt = edgeIndices(buckets.length);
  /* 与 LineChart 同款：不传 hourlyLabels 时直接用 hourly（趋势页两种图共用同一档）。 */
  const labelHourly = hourlyLabels ? hourlyLabels(buckets.length) : hourly;
  const at = hovered ?? buckets.length - 1;

  if (buckets.length === 0) return <div className="chart" />;

  return <div className="chart" style={{ position: "relative" }}>
    <div ref={plotRef} style={{ position: "relative" }}>
      {/* preserveAspectRatio="none"：宽度 100% 拉伸（hover 反查按容器宽算比值，
          默认的居中留白会让柱区与反查坐标系错开——见 LineChart 同款注释）。 */}
      <svg viewBox={`0 0 ${CHART_W} ${BAR_H}`} width="100%" height={BAR_H} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
        {buckets.map((bucket, index) => {
          /* 从柱底往上叠：每层的高度按各自 value/max 算（不是按 total 比例再切分——
             层内有 null 时两种算法结果不同，逐层算才能让 null 层真的不占高）。 */
          let stackTop = innerH;
          const rects = layers.map((layer, layerIndex) => {
            const value = bucket.values[layerIndex];
            if (value === null || value === undefined || value <= 0) return null;
            const height = Math.max((value / max) * innerH, 1);
            stackTop -= height;
            return <rect
              key={layerIndex}
              x={barX(index)} y={stackTop} width={barW} height={height}
              rx={layerIndex === 0 ? 1 : 0}
              style={{ fill: layer.color }}
            />;
          });
          return <g key={bucket.bucket}>
            {/* hover 高亮是背景带：垫在柱子后面（SVG 后画的在上面），画在柱后
                会把语义色盖掉一层。 */}
            {hovered === index && <rect
              x={barX(index) - 1.5} y={0} width={barW + 3} height={innerH}
              style={{ fill: "var(--hover)" }}
              pointerEvents="none"
            />}
            {stackTop < innerH && rects}
            {/* total=0 的桶画一粒 1px 的灰线：空桶是「没有执行」。 */}
            {bucket.total === 0 && <rect x={barX(index)} y={innerH - 1} width={barW} height={1} style={{ fill: "var(--line)" }} />}
          </g>;
        })}
        <rect
          x={0} y={0} width={CHART_W} height={BAR_H - PAD_B + 2}
          fill="transparent"
          style={{ cursor: onBucketClick ? "pointer" : undefined }}
          onPointerMove={(event) => {
            const width = plotRef.current?.getBoundingClientRect().width ?? 0;
            setHovered(nearestBucket(event, width, buckets.length)?.index);
          }}
          onPointerLeave={() => setHovered(undefined)}
          onPointerDown={() => { if (hovered !== undefined && onBucketClick) onBucketClick(hovered); }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {labelAt.map((index) => <span key={index} className="mono chart-x" style={{ left: `${((barX(index) + barW / 2) / CHART_W) * 100}%` }}>
          {bucketTimeLabel(buckets[index].bucket, labelHourly)}
        </span>)}
      </div>
    </div>
    {/* 常驻读数条（与 LineChart 同一款类，布局收敛在 CSS）。 */}
    {buckets.length > 0 && <div className="chart-readout mono">
      <span className="muted">{bucketTimeLabel(buckets[at].bucket, labelHourly)}</span>
      {labels && layers.map((layer, layerIndex) => {
        const value = buckets[at].values[layerIndex];
        return <span key={layerIndex} className="chart-readout-item">
          <span className="chart-key" style={{ background: layer.color }} />
          {labels[layerIndex]}
          <span>{value === null || value === undefined ? "—" : value}</span>
        </span>;
      })}
      <span className="chart-readout-item muted">{buckets[at].total}</span>
    </div>}
  </div>;
}
