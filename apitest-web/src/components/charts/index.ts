/**
 * 图表底座（P8-5）。12.4 的清单：`LineChart`（多 series、null 断线）、
 * `StackedBars`、`Donut`、`Sparkline` + 共享 `niceMsStep`/hover 层。Trends 页与
 * TimelineGantt 都消费这一套——三份画图逻辑收敛成一份；P8-6 的统计页与看板
 * sparkline 也从这里长，不再新写私有 SVG。
 */
export {
  niceMsStep, niceValueTicks, pathSegments, bucketTimeLabel, edgeIndices,
  nearestBucket, formatMsTick, type HoverPoint,
} from "./core";
export { LineChart, type LineChartProps, type LineSeries } from "./LineChart";
export { StackedBars, type StackedBarsProps, type StackedBarBucket } from "./StackedBars";
export { Donut, type DonutSegment } from "./Donut";
export { Sparkline, type SparklineProps } from "./Sparkline";
