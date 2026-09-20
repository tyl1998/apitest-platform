/**
 * 图表底座的共享内核（P8-5）。
 *
 * 12.4 的约定集中在这里：刻度挑「整齐值」、hover 用透明 rect + 指针矩形反查最近桶
 * （不逐 path 命中）、读数条常驻高度（条件渲染会把下面的表格顶一次）、轴标签与
 * tooltip 走 HTML 绝对定位（viewBox 拉伸下 SVG 文本会发虚——Trends 页 P3-9 起的
 * 既有结论）。线与柱才留在 SVG 里。
 */

/** 刻度的「整齐间隔」候选（毫秒）：升序，取第一个 ≥ 目标间隔的值。 */
const NICE_STEPS_MS = [100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

/**
 * 挑一个整齐的毫秒刻度间隔（从 TimelineGantt 收编，2026-09-02 验收版语义不变）。
 * 候选表之外（跨度超过 ~50 分钟的长 run）按 10 分钟向上取整，**不能退回 `span`
 * 本身**：那样刻度最多落进一个，图会退化成只有首尾两个标签、一条网格线都没有——
 * 而越长的图越需要网格来读「哪一段最慢」。
 */
export function niceMsStep(span: number, targetTicks = 6): number {
  const target = span / (targetTicks - 1);
  return NICE_STEPS_MS.find((step) => step >= target) ?? Math.ceil(target / 600_000) * 600_000;
}

/**
 * 数值轴的整齐刻度：1/2/5 × 10^k 乘出候选，取「刻度数不超过 target」里最小步长，
 * 再从 0（或 ceiling 到步长）铺到 span。值域覆盖 0（趋势图的 y 轴从 0 起——
 * 折线的「高度差」只有在同一起点时才可比），所以不接受负下界；传 span ≤ 0 时
 * 退回单刻度 [0]，图不至于除零。
 */
export function niceValueTicks(span: number, targetTicks = 4): number[] {
  if (!isFinite(span) || span <= 0) return [0];
  const power = Math.pow(10, Math.floor(Math.log10(span)));
  const candidates = [1, 2, 2.5, 5, 10].map((k) => k * power);
  const step = candidates.find((each) => span / each <= targetTicks - 1) ?? span;
  const ticks: number[] = [];
  for (let value = 0; value < span - step / 2; value += step) ticks.push(roundTick(value));
  ticks.push(roundTick(span % step === 0 ? span : Math.ceil(span / step) * step));
  return ticks;
}

/** 2.5×10^k 这类步长相乘会带出浮点尾差（0.30000000000000004），贴回刻度精度。 */
function roundTick(value: number): number {
  const digits = Math.max(0, -Math.floor(Math.log10(value || 1)) + 1);
  return Number(value.toFixed(Math.min(digits, 6)));
}

/**
 * 实样本的 path 段。两种语义（2026-09-10 用户反馈「折线没有连续性」后显式分叉）：
 *
 * - 默认**断线**：连续非 null 段各自成 path。折线图的空档由 `gapSegments` 的虚线
 *   补上（推断≠样本），所以这里不需要跨桶连线。
 * - `bridgeGaps`：跨过 null 桶连成一条**实线**。`Sparkline` 用这个——22px 高的
 *   形状图里虚线/断线都表达不出东西，它要的只是「一条形状」。
 *
 * 单点段在这里**只产出 `M x,y`**，别指望它可见：零长 path 在 round linecap 下
 * 只有线宽那么大、在 `stroke-dasharray` 下什么都不画（2026-09-10 复验：「只有
 * 一个点根本看不见」）。孤立点的可见性由 `isolatedIndices` + 调用方显式画
 * circle 兜底。
 */
export function pathSegments(
  values: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
  options: { bridgeGaps?: boolean } = {},
): string {
  const segments: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) segments.push(current);
    current = [];
  };
  values.forEach((value, i) => {
    if (value === null) {
      /* 桥接：只弃点不断段——下一个非 null 值继续追加 L，线跨过空桶。 */
      if (!options.bridgeGaps) flush();
      return;
    }
    current.push(`${current.length ? "L" : "M"}${x(i).toFixed(1)},${y(value).toFixed(1)}`);
  });
  flush();
  return segments.map((segment) => segment.join(" ")).join(" ");
}

/**
 * 断线模式下需要显式画 circle 的下标：值非 null 且左右邻居（存在时）都是 null。
 * 这些点独占一个 path 段，而单点段只是 `M x,y`，不画 circle 就不可见。
 */
export function isolatedIndices(values: (number | null | undefined)[]): number[] {
  const out: number[] = [];
  values.forEach((value, i) => {
    if (value === null || value === undefined) return;
    const prev = i > 0 ? values[i - 1] : null;
    const next = i < values.length - 1 ? values[i + 1] : null;
    if ((prev === null || prev === undefined) && (next === null || next === undefined)) out.push(i);
  });
  return out;
}

/**
 * 无样本的空档两侧「最近的实样本」之间的虚线连接段（P10-8 后统计页走查：折线在
 * 没数据的桶上断成几截，看不出趋势）。null 桶本身没有数值可画，但把两侧最近的
 * 实样本用**虚线**连起来，线段样式自己就说明了「这段是推断，不是样本」——实样本
 * 之间的相邻连线仍由 `pathSegments` 画实线，读数条的「—」照旧表达「没样本」。
 *
 * 一段连续的 null 只产出**一条**虚线（a → 下一个实样本 b），不是逐桶连线：中间
 * 没有坐标可落。全序列没有或只剩一个实样本时返回空串——前者无从连，后者没有
 * 邻居（可见性由 `isolatedIndices` 的 circle 兜底）。
 */
export function gapSegments(
  values: (number | null | undefined)[],
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  const out: string[] = [];
  let lastIndex = -1;
  let lastValue: number | null = null;
  values.forEach((value, i) => {
    if (value === null || value === undefined) return;
    if (lastIndex >= 0 && lastValue !== null && i - lastIndex > 1) {
      out.push(`M${x(lastIndex).toFixed(1)},${y(lastValue).toFixed(1)} L${x(i).toFixed(1)},${y(value).toFixed(1)}`);
    }
    lastIndex = i;
    lastValue = value;
  });
  return out.join(" ");
}

/** 桶时间标签：小时桶按时刻，天桶按月-日。 */
export function bucketTimeLabel(iso: string, hourly: boolean): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hourly
    ? `${pad(date.getHours())}:00`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 轴上均匀标哪几个桶：首尾必含、去重、最多 max 个（P10-8 后统计页走查「x 轴刻度
 * 太稀」——从首/中/尾三个加到 6 个）。桶数不足 max 时全标，中间桶仍居中落位，
 * 首尾两个由调用方向图内对齐。
 */
export function axisIndices(n: number, max = 6): number[] {
  if (n <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < max; k += 1) out.push(Math.round((k * (n - 1)) / (max - 1)));
  return out.filter((index, i, all) => all.indexOf(index) === i);
}

export type HoverPoint = {
  /** 最近桶的下标（0 基）。 */
  index: number;
  /** 指针在绘图区内的横向比例（0..1），竖直参考线画这里。 */
  ratio: number;
};

/**
 * hover 层的共享反查：透明 rect 捕 `onPointerMove`，用指针在**绘图区 rect** 内的横向
 * 比例算最近桶——不逐 path 命中（用户得精确指到 1.5px 宽的线上）。rect 用
 * `getBoundingClientRect` 实测而不是 viewBox 推算：SVG 被 `width: 100%` 拉伸后，
 * 绘图区像素宽与 viewBox 不一致，用 viewBox 换算会把十字线放偏。
 *
 * 参照物取 `clientX - rect.left` 而不是 `offsetX`：offsetX 对 SVG 子元素的参照物
 * 各浏览器不一致（有的按元素、有的按 SVG 根），绘图区带左留白（y 轴刻度栏）时差
 * 一个留白就会把吸附点整体带偏——「指 A 选 B」是 P8-5 修过的缺陷，不能退回去。
 *
 * 指针离开即清空（`onPointerLeave`）；`onPointerDown` 透传给 `onClick` 的调用方
 * ——按 12.4，「图表 onClick 按 URL 表跳转」是 P8-6 的下钻接线，这里先把事件形状
 * 定下来，避免底座接线时再改一遍 API。
 */
export function nearestBucket(event: { clientX: number }, plotRect: { left: number; width: number }, bucketCount: number): HoverPoint | undefined {
  if (!plotRect || plotRect.width <= 0 || bucketCount <= 0) return undefined;
  const ratio = Math.min(1, Math.max(0, (event.clientX - plotRect.left) / plotRect.width));
  return { index: Math.min(bucketCount - 1, Math.round(ratio * (bucketCount - 1))), ratio };
}

/** 只在 ms 精度上有意义时带小数——整秒刻度上的 `.0` 是噪声（TimelineGantt 收编）。 */
export function formatMsTick(ms: number, step: number): string {
  const date = new Date(ms);
  const clock = date.toLocaleTimeString([], { hourCycle: "h23" });
  return step < 1000
    ? `${clock}.${String(date.getMilliseconds()).padStart(3, "0").slice(0, 2)}`
    : clock;
}
