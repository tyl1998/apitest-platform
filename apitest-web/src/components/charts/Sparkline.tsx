import { bucketTimeLabel, pathSegments } from "./core";

/**
 * 迷你折线（P8-5；看板 sparkline 用，形态照 react-sparklines 的复杂度做——
 * 数十行、零交互、纯趋势示意）。
 *
 * 设计系统纪律：颜色由调用方给（看板落在语义色上）；高度 22px 固定，不做
 * hover——sparkline 的职责是「过去 30 天的形状」，精确读数归全页图表。
 * 空数据画一条贴底的平线而不是空白：看板卡上的空图会读成「加载失败」。
 */
export type SparklineProps = {
  values: (number | null)[];
  buckets?: string[];
  hourly?: boolean;
  color?: string;
  /** 无障碍标签（Readout 已有文字读数，这里描述的是「形状」）。 */
  ariaLabel?: string;
};

const W = 120;
const H = 22;
const PAD = 1.5;

export function Sparkline({ values, buckets, hourly, color = "var(--ink-2)", ariaLabel }: SparklineProps) {
  const clean = values.filter((value): value is number => value !== null && value !== undefined);
  const max = Math.max(...clean, 1);
  const min = clean.length ? Math.min(...clean) : 0;
  const span = Math.max(max - min, 1);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * (W - PAD * 2) + PAD);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  /* sparkline 是「形状」不是「读数」：空桶一律桥接（断线在 22px 高里只剩几个
     孤立点，「那天没跑」这件事在这么小的图里表达不出来，也不值得表达）。 */
  const d = pathSegments(values, x, y, { bridgeGaps: true }) || `M${PAD},${H - PAD} L${W - PAD},${H - PAD}`;
  /* 末点小圆点：30 天的最后一个点是不是「正在变好」是 sparkline 最常被读的信息。
     findLastIndex 在 ES2023——手写一个倒扫，不为此抬 lib 目标。 */
  let lastIndex = -1;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== null && values[i] !== undefined) { lastIndex = i; break; }
  }
  const last = lastIndex >= 0 ? values[lastIndex] : null;
  const tip = last !== null && last !== undefined
    ? `${last}${buckets?.[lastIndex] ? ` · ${bucketTimeLabel(buckets[lastIndex], hourly ?? false)}` : ""}`
    : undefined;
  return <svg
    viewBox={`0 0 ${W} ${H}`} width={W} height={H}
    preserveAspectRatio="none"
    style={{ maxWidth: "100%" }}
    role="img" aria-label={ariaLabel}
  >
    {tip && <title>{tip}</title>}
    <path
      d={d}
      fill="none"
      style={{ stroke: color }}
      strokeWidth={1.2}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    {last !== null && last !== undefined && <circle cx={x(lastIndex)} cy={y(last)} r={1.6} style={{ fill: color }} />}
  </svg>;
}
