import { useRef, useState } from "react";
import { bucketTimeLabel, edgeIndices, isolatedIndices, nearestBucket, pathSegments, singleValueIndex } from "./core";

/**
 * 手写 SVG 折线（P8-5 从 Trends.tsx 的私有实现提成底座，P3-9 边界 12 的姿态不变：
 * 不引图表库——图表库带的是自己一整套配色与动效，Quiet Console 只允许一个强调色
 * 和四个语义色）。
 *
 * hover 层（12.6 参考形态，uPlot 的「透明 overlay + 最近点吸附」）：图上盖一层透明
 * rect 捕指针，`offsetX / plotWidth` 反查最近桶，画**竖直参考线 + active 点放大**，
 * 读数常驻在图下方的读数条里（Grafana 面板的形态）——不用 SVG `<text>` 做悬浮
 * tooltip：viewBox 拉伸下 SVG 文本会发虚，读数条也不需要跟着指针跑。
 *
 * 布局约定：viewBox 固定、宽度 100% 拉伸，**必须显式写
 * `preserveAspectRatio="none"`**——SVG 默认是「保持比例 + 居中留白」，容器比
 * viewBox 宽时绘图区只在中间一段，而 hover 反查按「指针 / 容器宽」算比值，分母
 * 就系统性偏大，指针在 A、吸附点落在 B（2026-09-10 用户实测报告的错位）。
 * 轴标签是 HTML 绝对定位，百分比落位；hover 用 `getBoundingClientRect` 实测
 * 像素宽，不用 viewBox 换算。
 */

const CHART_W = 720;
const CHART_H = 170;
const PAD_L = 6;
const PAD_R = 6;
const PAD_T = 10;
const PAD_B = 18;

export type LineSeries = {
  /** null = 这个桶没有样本：线在这里断开（「没执行」≠「0」）。 */
  values: (number | null)[];
  color: string;
  dash?: string;
  width?: number;
};

export type LineChartProps = {
  buckets: string[];
  series: LineSeries[];
  yMax: number;
  yFormat: (value: number) => string;
  /** 桶标签按小时还是按天（`bucketTimeLabel`）。 */
  hourly: boolean;
  yTicks: number[];
  /** 读数条里每个 series 的名字；缺省时读数只列数值。 */
  labels?: string[];
  /** 点桶 → 调用方（P8-6 的下钻接线：URL 表进 12.2）。 */
  onBucketClick?: (index: number) => void;
  /** null 桶是否连线跨过：耗时分位这类「每桶独立结论」的序列跨线可读性更高
      （稀疏窗口下断线只剩碎段）；通过率这类「趋势」序列保持断线——「没执行」
      跨过去会读成「维持不变」。默认 false（断线）。 */
  bridgeGaps?: boolean;
  /** 无障碍标签（role="img" 的 aria-label）。 */
  ariaLabel?: string;
};

export function LineChart({ buckets, series, yMax, yFormat, hourly, yTicks, labels, onBucketClick, bridgeGaps, ariaLabel }: LineChartProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number>();

  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;
  const n = buckets.length;
  const x = (i: number) => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD_T + innerH - (Math.min(v, yMax) / yMax) * innerH;
  const labelAt = edgeIndices(n);
  /* 空数据画空壳（占住图表高度）：P8-6 的分段渲染里，一段没数据不等于页面崩。 */
  if (n === 0) return <div className="chart" style={{ height: CHART_H + 20 }} />;

  return <div className="chart" style={{ position: "relative" }}>
    <div ref={plotRef} style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width="100%" height={CHART_H} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
        {yTicks.map((tick) => <line
          key={tick}
          x1={PAD_L} x2={CHART_W - PAD_R} y1={y(tick)} y2={y(tick)}
          style={{ stroke: "var(--line)" }}
          strokeWidth={1}
        />)}
        {series.map((each, index) => <path
          key={index}
          d={pathSegments(each.values, x, y, { bridgeGaps })}
          fill="none"
          style={{ stroke: each.color }}
          strokeWidth={each.width ?? 1.5}
          strokeDasharray={each.dash}
          strokeLinejoin="round"
          strokeLinecap="round"
        />)}
        {/* 孤立点显式画 circle：单点段只是 `M x,y`，round linecap 下只有线宽那么
            大、dasharray（p99 虚线）下什么都不画——「只有一个点根本看不见」
            （2026-09-10 复验）。断线模式画所有孤立点；桥接模式点都在线上，只在
            全序列恰好一个点时画。半径与 active 点一致，hover 时两层重合不闪。 */}
        {series.map((each, index) => {
          const markers = bridgeGaps ? singleValueIndex(each.values) : isolatedIndices(each.values);
          return markers.map((i) => <circle
            key={`${index}:${i}`}
            cx={x(i)}
            cy={y(each.values[i]!)}
            r={2.5}
            style={{ fill: each.color }}
          />);
        })}
        {/* active 点放大（Recharts ActiveDot 的形态）：吸附到的桶上每个 series 画
            一个 2.5px 半径的实心点，线宽 1.5 的线指上去时肉眼对不上位置的痛点就
            是它解的。null 的 series 不画点。 */}
        {hovered !== undefined && series.map((each, index) => each.values[hovered] !== null && <circle
          key={index}
          cx={x(hovered)}
          cy={y(each.values[hovered]!)}
          r={2.5}
          style={{ fill: each.color, stroke: "var(--surface)" }}
          strokeWidth={1}
        />)}
        {/* 十字线的竖腿（横腿即 y 网格线，不重复画）。半透明，语义色之外不引入
            新颜色。 */}
        {hovered !== undefined && <line
          x1={x(hovered)} x2={x(hovered)} y1={PAD_T} y2={PAD_T + innerH}
          style={{ stroke: "var(--line-strong)" }}
          strokeWidth={1}
          pointerEvents="none"
        />}
        {/* hover 捕获层：透明 rect 盖满绘图区。放在 path 之后（SVG 绘制序），
            不然线会盖住 rect 的指针事件。 */}
        <rect
          x={PAD_L} y={PAD_T} width={innerW} height={innerH}
          fill="transparent"
          style={{ cursor: onBucketClick ? "pointer" : undefined }}
          onPointerMove={(event) => {
            const width = plotRef.current?.getBoundingClientRect().width ?? 0;
            setHovered(nearestBucket(event, width, n)?.index);
          }}
          onPointerLeave={() => setHovered(undefined)}
          onPointerDown={() => { if (hovered !== undefined && onBucketClick) onBucketClick(hovered); }}
        />
      </svg>
      {/* 轴标签浮在 SVG 上：左端是 y 轴刻度，底下一排是桶时间。 */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {yTicks.map((tick) => <span key={tick} className="mono chart-y" style={{ top: y(tick) - 7 }}>{yFormat(tick)}</span>)}
        {labelAt.map((index) => <span key={index} className="mono chart-x" style={{ left: `${(x(index) / CHART_W) * 100}%` }}>
          {bucketTimeLabel(buckets[index], hourly)}
        </span>)}
      </div>
    </div>
    {/* 常驻高度的读数条：空的时候也占位，指针进出时下面的内容不会被顶一次
        （timeline-hover 的既有模式）。读数始终显示最近吸附桶的值，没悬停时
        显示最后一个桶——「图上最后一点是多少」是这类图第二常被问的问题。 */}
    <div className="chart-readout mono">
      {hovered !== undefined
        ? <span className="muted">{bucketTimeLabel(buckets[hovered], hourly)}</span>
        : n > 0 && <span className="muted">{bucketTimeLabel(buckets[n - 1], hourly)}</span>}
      {series.map((each, index) => {
        const at = hovered ?? n - 1;
        const value = each.values[at];
        return <span key={index} className="chart-readout-item">
          {labels?.[index] && <><span className="chart-key chart-key-line" style={{ background: each.color }} />{labels[index]}</>}
          <span>{value === null || value === undefined ? "—" : yFormat(value)}</span>
        </span>;
      })}
    </div>
  </div>;
}
