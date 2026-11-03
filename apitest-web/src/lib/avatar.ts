/* ── P9-6 人物生成器 ──────────────────────────────────────────────────────────
 *
 * 移植自仓库根的 hand-drawn-character-creator.html 76–584 行（three.js 部分从
 * 588 行起不搬）：种子 → 物种/五官/配色的确定性生成 + 纯 Canvas 2D 单张绘制。
 * 计划 13.0 边界 5 的落点：
 *
 * - 头像不落库：种子 = preferences.avatarSeed ?? users.id（`components/Avatar`
 *   的调用方解析），前端每次画，同一种子永远同一张脸；
 * - nightmare 物种默认移出（企业内网工具里它只会被当 bug 报）：物种代码与
 *   暗色调色板全保留，开关藏在 preferences.avatarNightmare（无界面入口）；
 * - 动画：idle 只眨眼（何时眨由调用方控制）；状态反应（gaze/pose/jump/mouth，
 *   2026-09-16）；流式思考期间原地踏步 walk（2026-09-22 放宽 Quiet Console 规则 4
 *   后的第二个循环动画，仅绑在流式状态、结束即停）；
 * - 与原版的两处有意差异：① 部件不再各自成纹理贴 3D 平面，而是按原版的世界
 *   坐标以缩放变换直接落笔（笔画按最终分辨率光栅化，不经过纹理降采样）；
 *   ② 五官滚动用一条 rng 流（同种子同人物），描边抖动按部件独立成流
 *   （`seed:part`）——原版共享一条流，增删部件会把整张脸重新洗牌；眼睛例外，
 *   每次眨眼换流（`seed:eyes:N`，boiling line——重描的笔画抖动是特性）。
 */

/** 铅笔墨/纸/腮红（原版 76–100 行的调色常量）。头像自带纸底不随主题：深墨线
    在深色页底上会直接消失，纸底让两种模式都成立（贴纸观感是有意的）。 */
const INK = "#2c2a25";
const PAPER = "#f2ecdd";
const ROSE = "#c05a48";

/* ── seeded random（原版 82–105 行照搬）──────────────────────────────────── */

function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(a: number): () => number {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rngFrom = (str: string) => mulberry32(hashSeed(str));
const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const jit = (rng: () => number, a: number) => (rng() - 0.5) * 2 * a;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ── brush engine（原版 107–186 行）──────────────────────────────────────── */

/** 当前部件的笔画下限（设备像素 ÷ 部件缩放比，由 drawAvatar 的部件变换设置）。
    小尺寸下 w=5 的铅笔线自然渲染只剩 ~1 设备像素（32px 档），没有下限就是发丝。 */
let inkFloor = 1;

type StrokeOptions = { w?: number; passes?: number; wob?: number; color?: string; alpha?: number; close?: boolean };

/* 多遍抖动折线——铅笔质感的核心。 */
function strokePts(ctx: CanvasRenderingContext2D, rng: () => number, pts: number[][], o: StrokeOptions = {}) {
  const { w = 5, passes = 2, wob = 3, color = INK, alpha = 0.9, close = false } = o;
  const width = Math.max(1, w * 0.58);
  const wobble = wob * 1.9;

  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (let p = 0; p < passes; p++) {
    ctx.globalAlpha = alpha * (p ? 0.4 : 1);
    ctx.lineWidth = Math.max(1, width * (0.7 + rng() * 0.6), inkFloor);
    const q = pts.map((pt) => [pt[0] + jit(rng, wobble), pt[1] + jit(rng, wobble)]);
    ctx.beginPath();
    ctx.moveTo(q[0][0], q[0][1]);
    for (let i = 1; i < q.length; i++) {
      const a = q[i - 1], b = q[i];
      ctx.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    }
    const last = q[q.length - 1];
    ctx.lineTo(last[0], last[1]);
    if (close) ctx.closePath();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number, n = 18, a0 = 0, a1 = Math.PI * 2): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

function line(ctx: CanvasRenderingContext2D, rng: () => number, x0: number, y0: number, x1: number, y1: number, o: StrokeOptions = {}) {
  const pts: number[][] = [];
  for (let i = 0; i <= 4; i++) pts.push([lerp(x0, x1, i / 4), lerp(y0, y1, i / 4)]);
  strokePts(ctx, rng, pts, o);
}

function polyFill(ctx: CanvasRenderingContext2D, rng: () => number, pts: number[][], color: string, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function blobFill(ctx: CanvasRenderingContext2D, rng: () => number, cx: number, cy: number, rx: number, ry: number, color: string, alpha = 1) {
  const pts = ellipsePts(cx, cy, rx, ry, 14)
    .map((p) => [p[0] + jit(rng, rx * 0.07), p[1] + jit(rng, ry * 0.07)]);
  polyFill(ctx, rng, pts, color, alpha);
}

function hatch(ctx: CanvasRenderingContext2D, rng: () => number, cx: number, cy: number, r: number, o: { n?: number; color?: string; alpha?: number; w?: number } = {}) {
  const { n = 5, color = INK, alpha = 0.16, w = 3 } = o;
  for (let i = 0; i < n; i++) {
    const off = (i - n / 2) * r * 0.3;
    line(ctx, rng,
      cx - r * 0.5 + off, cy + r * 0.55 + off * 0.3,
      cx + off + r * 0.15, cy - r * 0.25 + off * 0.3,
      { w, color, alpha, wob: 2, passes: 1 });
  }
}

/* ── palettes（原版 188–196 行）──────────────────────────────────────────── */

const ACCENTS = ["#a8503c", "#3f6f8e", "#6f7f3f", "#8a6a9c", "#b0813a", "#4f8a6b"];
const NIGHT_ACCENTS = ["#7c2f3e", "#4a2f66", "#2f4a5e"];
const SKINS = ["#f0e5cd", "#ecdcc4", "#e7d3be", "#f2e8d6"];

type Palette = { ink: string; accent: string; fill: string; skin: string };

function makePalette(rng: () => number, dark: boolean): Palette {
  if (dark) return { ink: INK, accent: pick(rng, NIGHT_ACCENTS), fill: "#e6ddc8", skin: "#e6ddc8" };
  return { ink: INK, accent: pick(rng, ACCENTS), fill: "#f6f1e3", skin: pick(rng, SKINS) };
}

/* ── features（原版 200–584 行：每个都是画布上的纯函数，读 ch.state 反映眨眼）─ */

type Species = "human" | "cat" | "dog" | "nightmare";
type EyeV = "round" | "dot" | "sleepy" | "angry" | "glasses" | "hollow" | "many";
export type MouthV = "smile" | "flat" | "open" | "teeth" | "catmouth" | "jagged";
type NoseV = "curve" | "button" | "big" | "triangle" | "snout";
type HairV = "messy" | "spiky" | "beret" | "antennae" | "horns" | "helmet" | "bald";
type EarV = "human" | "cat" | "dog" | "pointed";
type BodyDeco = "buttons" | "stripes" | "belly" | "none";

type Character = {
  species: Species;
  dark: boolean;
  pal: Palette;
  headW: number;
  headH: number;
  bodyW: number;
  eyeScale: number;
  mouthScale: number;
  eyeV: EyeV;
  mouthV: MouthV;
  noseV: NoseV;
  hairV: HairV;
  earV: EarV;
  blush: boolean;
  bodyDeco: BodyDeco;
  state: { blink: boolean; lookX: number; lookY: number };
};

function drawEyes(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const st = ch.state, pal = ch.pal;
  const er = H * 0.30 * ch.eyeScale, cy = H * 0.52;
  const px = st.lookX * er * 0.35, py = st.lookY * er * 0.3;

  const closed = (x: number, r: number) =>
    strokePts(ctx, rng, ellipsePts(x, cy, r, r * 0.45, 8, 0.2, Math.PI - 0.2), { w: 5, wob: 1.5, color: pal.ink });

  if (ch.eyeV === "many") {
    for (const [x, s] of [[W * 0.2, 0.6], [W * 0.5, 0.95], [W * 0.8, 0.6]] as [number, number][]) {
      const r = er * s;
      if (st.blink) { closed(x, r); continue; }
      blobFill(ctx, rng, x, cy, r, r, pal.ink, 0.95);
      blobFill(ctx, rng, x + px * 0.6, cy + py * 0.6, r * 0.3, r * 0.3, PAPER);
    }
    return;
  }

  const ex = [W * 0.30, W * 0.70];
  ex.forEach((x, i) => {
    if (st.blink) {
      closed(x, er);
      if (ch.eyeV === "glasses") strokePts(ctx, rng, ellipsePts(x, cy, er * 1.5, er * 1.4), { w: 4, wob: 2, color: pal.ink, close: true });
      return;
    }

    switch (ch.eyeV) {
      case "dot":
        blobFill(ctx, rng, x + px, cy + py, er * 0.42, er * 0.46, pal.ink);
        blobFill(ctx, rng, x + px + er * 0.13, cy + py - er * 0.15, er * 0.12, er * 0.12, PAPER, 0.9);
        break;

      case "sleepy":
        strokePts(ctx, rng, ellipsePts(x, cy - er * 0.3, er, er * 0.7, 8, Math.PI + 0.2, Math.PI * 2 - 0.2), { w: 5, wob: 1.5, color: pal.ink });
        blobFill(ctx, rng, x + px, cy + er * 0.15 + py * 0.5, er * 0.3, er * 0.25, pal.ink);
        break;

      case "angry": {
        strokePts(ctx, rng, ellipsePts(x, cy, er * 0.85, er * 0.9), { w: 4.5, wob: 1.5, color: pal.ink, close: true });
        blobFill(ctx, rng, x + px, cy + py, er * 0.35, er * 0.35, pal.ink);
        const s = i === 0 ? 1 : -1;
        line(ctx, rng, x - s * er * 1.1, cy - er * 1.6, x + s * er * 0.8, cy - er * 0.9, { w: 6, color: pal.ink, wob: 2 });
        break;
      }

      case "glasses":
        strokePts(ctx, rng, ellipsePts(x, cy, er * 1.5, er * 1.4), { w: 4, wob: 2, color: pal.ink, close: true });
        blobFill(ctx, rng, x + px, cy + py, er * 0.4, er * 0.42, pal.ink);
        if (i === 1) line(ctx, rng, ex[0] + er * 1.5, cy - er * 0.3, ex[1] - er * 1.5, cy - er * 0.3, { w: 4, color: pal.ink, wob: 1 });
        break;

      case "hollow":
        blobFill(ctx, rng, x, cy, er * 1.05, er * 1.15, pal.ink, 0.9);
        blobFill(ctx, rng, x + px, cy + py, er * 0.3, er * 0.32, PAPER);
        break;

      default: // round
        strokePts(ctx, rng, ellipsePts(x, cy, er, er * 1.05), { w: 4.5, wob: 1.8, color: pal.ink, close: true });
        blobFill(ctx, rng, x + px, cy + py, er * 0.38, er * 0.42, pal.ink);
        blobFill(ctx, rng, x + px + er * 0.12, cy + py - er * 0.14, er * 0.12, er * 0.12, PAPER, 0.95);
    }
  });
}

function drawMouth(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const pal = ch.pal, cx = W / 2, cy = H * 0.42, mw = W * 0.34 * ch.mouthScale;
  const o: StrokeOptions = { w: 5, wob: 2, color: pal.ink };

  switch (ch.mouthV) {
    case "smile":
      strokePts(ctx, rng, ellipsePts(cx, cy - H * 0.12, mw, H * 0.3, 10, 0.25, Math.PI - 0.25), o);
      break;

    case "flat":
      line(ctx, rng, cx - mw, cy, cx + mw * 0.9, cy + jit(rng, 4), o);
      break;

    case "open":
      blobFill(ctx, rng, cx, cy + H * 0.05, mw * 0.38, H * 0.17, ROSE, 0.55);
      strokePts(ctx, rng, ellipsePts(cx, cy + H * 0.05, mw * 0.4, H * 0.18), { ...o, w: 4, close: true });
      break;

    case "teeth":
      strokePts(ctx, rng, ellipsePts(cx, cy - H * 0.1, mw, H * 0.32, 10, 0.2, Math.PI - 0.2), o);
      line(ctx, rng, cx - mw * 0.85, cy + H * 0.02, cx + mw * 0.85, cy + H * 0.02, { ...o, w: 4 });
      for (let i = -2; i <= 2; i++) {
        line(ctx, rng, cx + i * mw * 0.32, cy + H * 0.02, cx + i * mw * 0.3, cy + H * 0.16, { ...o, w: 3, alpha: 0.8, passes: 1 });
      }
      break;

    case "catmouth": // 小「w」嘴
      strokePts(ctx, rng, ellipsePts(cx - mw * 0.4, cy, mw * 0.4, H * 0.14, 6, 0.3, Math.PI - 0.3), { ...o, w: 4 });
      strokePts(ctx, rng, ellipsePts(cx + mw * 0.4, cy, mw * 0.4, H * 0.14, 6, 0.3, Math.PI - 0.3), { ...o, w: 4 });
      break;

    case "jagged": {
      const pts: number[][] = [];
      for (let i = 0; i <= 8; i++) pts.push([cx - mw + (2 * mw) * i / 8, cy + (i % 2 ? H * 0.18 : -H * 0.05)]);
      strokePts(ctx, rng, pts, { ...o, w: 4.5 });
      break;
    }
  }
}

function drawNose(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const pal = ch.pal, cx = W / 2, cy = H * 0.5;
  const o: StrokeOptions = { w: 4.5, wob: 1.6, color: pal.ink };

  const whiskers = () => {
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        line(ctx, rng, cx + s * W * 0.12, cy + (i - 1) * 6, cx + s * W * 0.46, cy + (i - 1) * 13 - 3,
          { w: 2.5, color: pal.ink, wob: 2, passes: 1, alpha: 0.8 });
      }
    }
  };

  switch (ch.noseV) {
    case "curve":
      strokePts(ctx, rng, [[cx - 4, cy - H * 0.22], [cx + 7, cy + H * 0.05], [cx - 6, cy + H * 0.12]], o);
      break;

    case "button":
      strokePts(ctx, rng, ellipsePts(cx, cy, W * 0.07, W * 0.06), { ...o, close: true });
      break;

    case "big":
      blobFill(ctx, rng, cx, cy, W * 0.12, H * 0.2, pal.skin, 0.7);
      strokePts(ctx, rng, ellipsePts(cx, cy, W * 0.12, H * 0.2), { ...o, close: true });
      blobFill(ctx, rng, cx - W * 0.05, cy + H * 0.1, 3, 3, pal.ink);
      blobFill(ctx, rng, cx + W * 0.05, cy + H * 0.1, 3, 3, pal.ink);
      break;

    case "triangle": // cat
      blobFill(ctx, rng, cx, cy - 2, W * 0.06, H * 0.08, ROSE, 0.9);
      strokePts(ctx, rng, [
        [cx - W * 0.06, cy - H * 0.08], [cx + W * 0.06, cy - H * 0.08],
        [cx, cy + H * 0.06], [cx - W * 0.06, cy - H * 0.08],
      ], { ...o, w: 3.5 });
      whiskers();
      break;

    case "snout": // dog
      blobFill(ctx, rng, cx, cy, W * 0.16, H * 0.22, ch.dark ? pal.fill : "#efe6d2", 0.85);
      strokePts(ctx, rng, ellipsePts(cx, cy, W * 0.16, H * 0.22), { ...o, close: true });
      blobFill(ctx, rng, cx, cy - H * 0.06, W * 0.05, H * 0.06, pal.ink);
      for (const s of [-1, 1]) {
        for (let i = 0; i < 3; i++) blobFill(ctx, rng, cx + s * W * 0.08, cy + H * 0.08 + i * 5, 1.8, 1.8, pal.ink, 0.8);
      }
      break;
  }
}

function drawHair(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const pal = ch.pal, cx = W / 2, base = H * 0.72;
  const o: StrokeOptions = { w: 5, wob: 3, color: pal.ink };

  switch (ch.hairV) {
    case "messy":
      for (let i = 0; i < 7; i++) {
        const x0 = cx + (rng() - 0.5) * W * 0.7;
        strokePts(ctx, rng, [
          [x0, base],
          [x0 + jit(rng, 20), base - H * (0.3 + rng() * 0.35)],
          [x0 + jit(rng, 34), base - H * 0.15],
        ], { ...o, w: 4, passes: 1, alpha: 0.85 });
      }
      break;

    case "spiky": {
      const pts: number[][] = [];
      for (let i = 0; i <= 10; i++) pts.push([cx - W * 0.35 + W * 0.7 * i / 10, base - (i % 2 ? H * 0.5 : H * 0.12)]);
      strokePts(ctx, rng, pts, { ...o, w: 4.5 });
      break;
    }

    case "beret":
      blobFill(ctx, rng, cx, base - H * 0.28, W * 0.29, H * 0.22, PAPER, 1);
      blobFill(ctx, rng, cx, base - H * 0.28, W * 0.29, H * 0.22, pal.accent, 1);
      strokePts(ctx, rng, ellipsePts(cx, base - H * 0.28, W * 0.29, H * 0.22), { ...o, close: true });
      line(ctx, rng, cx, base - H * 0.5, cx + 4, base - H * 0.62, { ...o, w: 4 });
      break;

    case "antennae":
      for (const s of [-1, 1]) {
        strokePts(ctx, rng, [
          [cx + s * W * 0.12, base],
          [cx + s * W * 0.2, base - H * 0.45],
          [cx + s * W * 0.26, base - H * 0.72],
        ], { ...o, w: 3.5 });
        blobFill(ctx, rng, cx + s * W * 0.26, base - H * 0.76, 6, 6, pal.accent, 0.95);
        strokePts(ctx, rng, ellipsePts(cx + s * W * 0.26, base - H * 0.76, 7, 7), { ...o, w: 2.5, close: true });
      }
      break;

    case "horns":
      for (const s of [-1, 1]) {
        strokePts(ctx, rng, [
          [cx + s * W * 0.18, base],
          [cx + s * W * 0.3, base - H * 0.4],
          [cx + s * W * 0.24, base - H * 0.72],
        ], { ...o, w: 7 });
      }
      break;

    case "helmet":
      blobFill(ctx, rng, cx, base - H * 0.05, W * 0.36, H * 0.42, PAPER, 1);
      blobFill(ctx, rng, cx, base - H * 0.05, W * 0.36, H * 0.42, pal.accent, 1);
      strokePts(ctx, rng, ellipsePts(cx, base + H * 0.05, W * 0.36, H * 0.48, 12, Math.PI, Math.PI * 2), { ...o, w: 6 });
      line(ctx, rng, cx - W * 0.36, base + H * 0.02, cx + W * 0.36, base + H * 0.02, { ...o, w: 5 });
      for (let i = -1; i <= 1; i++) blobFill(ctx, rng, cx + i * W * 0.17, base - H * 0.22, 3, 3, pal.ink);
      break;

    case "bald":
      if (rng() < 0.4) {
        for (let i = 0; i < 2; i++) line(ctx, rng, cx + i * 10 - 5, base, cx + i * 14 - 7, base - H * 0.3, { ...o, w: 3, passes: 1 });
      }
      break;
  }
}

/* 一只耳；右侧靠镜像变换画同一张纹理（原版是 mesh scale.x = -1）。 */
function drawEar(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const pal = ch.pal;
  const o: StrokeOptions = { w: 5, wob: 2, color: pal.ink };

  /* 不透明纸底 + 头部肤色：耳朵读作头的一部分。 */
  const base = (pts: number[][]) => {
    polyFill(ctx, rng, pts, PAPER, 1);
    polyFill(ctx, rng, pts, ch.dark ? pal.fill : pal.skin, ch.dark ? 0.95 : 0.55);
  };

  switch (ch.earV) {
    case "human": {
      const cx = W * 0.5, cy = H * 0.5, r = W * 0.33;
      base(ellipsePts(cx, cy, r, r, 16));
      strokePts(ctx, rng, ellipsePts(cx, cy, r, r, 16), { ...o, w: 6, wob: 1.5, close: true });
      blobFill(ctx, rng, cx, cy + r * 0.05, r * 0.45, r * 0.45, ROSE, 0.3);
      break;
    }

    case "cat": {
      const tri = [[W * 0.16, H * 0.98], [W * 0.46, H * 0.12], [W * 0.88, H * 0.82], [W * 0.16, H * 0.98]];
      base(tri);
      strokePts(ctx, rng, tri.slice(0, 3), { ...o, w: 6 }); // 开底——与头轮廓融合
      polyFill(ctx, rng, [[W * 0.35, H * 0.8], [W * 0.48, H * 0.36], [W * 0.7, H * 0.68]], ROSE, 0.55);
      break;
    }

    case "dog": { // 垂下的耳垂
      const pts = ellipsePts(W * 0.52, H * 0.52, W * 0.2, H * 0.4, 16);
      polyFill(ctx, rng, pts, PAPER, 1);
      polyFill(ctx, rng, pts, ch.dark ? pal.fill : pal.skin, ch.dark ? 0.95 : 0.6);
      strokePts(ctx, rng, pts, { ...o, w: 5, wob: 1.8, close: true });
      break;
    }

    case "pointed": {
      const tri = [[W * 0.2, H * 0.98], [W * 0.72, H * 0.12], [W * 0.78, H * 0.9], [W * 0.2, H * 0.98]];
      base(tri);
      strokePts(ctx, rng, tri.slice(0, 3), { ...o, w: 6 });
      break;
    }
  }
}

function drawHead(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const cx = W / 2, cy = H * 0.52;
  const rx = W * 0.36 * ch.headW, ry = H * 0.38 * ch.headH;
  const pts = ellipsePts(cx, cy, rx, ry, 16).map((p) => [p[0] + jit(rng, rx * 0.05), p[1] + jit(rng, ry * 0.05)]);

  polyFill(ctx, rng, pts, PAPER, 1); // 不透明纸底——后面的部件不透出来
  polyFill(ctx, rng, pts, ch.dark ? ch.pal.fill : ch.pal.skin, ch.dark ? 1 : 0.55);
  strokePts(ctx, rng, ellipsePts(cx, cy, rx, ry, 20), { w: 6, wob: 4, color: ch.pal.ink, close: true });

  if (ch.dark) return;
  hatch(ctx, rng, cx + rx * 0.5, cy + ry * 0.4, 38, { color: ch.pal.ink });
  if (ch.blush) {
    blobFill(ctx, rng, cx - rx * 0.6, cy + ry * 0.3, 13, 8, ch.pal.accent, 0.28);
    blobFill(ctx, rng, cx + rx * 0.6, cy + ry * 0.3, 13, 8, ch.pal.accent, 0.28);
  }
}

function drawTorso(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const pal = ch.pal, cx = W / 2, cy = H * 0.52;
  const rx = W * 0.34 * ch.bodyW, ry = H * 0.4;
  const pts = ellipsePts(cx, cy, rx, ry, 16).map((p) => [p[0] + jit(rng, rx * 0.05), p[1] + jit(rng, ry * 0.05)]);

  polyFill(ctx, rng, pts, PAPER, 1);
  polyFill(ctx, rng, pts, ch.dark ? pal.fill : pal.accent, ch.dark ? 1 : 0.32);
  strokePts(ctx, rng, ellipsePts(cx, cy, rx, ry, 18), { w: 6, wob: 4, color: pal.ink, close: true });

  if (ch.bodyDeco === "buttons") {
    for (let i = 0; i < 3; i++) blobFill(ctx, rng, cx + jit(rng, 3), cy - ry * 0.4 + i * ry * 0.4, 4.5, 4.5, pal.ink, 0.9);
  }

  if (ch.bodyDeco === "stripes") {
    for (let i = 0; i < 3; i++) {
      line(ctx, rng, cx - rx * 0.85, cy - ry * 0.45 + i * ry * 0.45, cx + rx * 0.85, cy - ry * 0.4 + i * ry * 0.45,
        { w: 5, color: pal.accent, wob: 3, passes: 1, alpha: 0.75 });
    }
  }

  if (ch.bodyDeco === "belly") {
    blobFill(ctx, rng, cx, cy + ry * 0.25, rx * 0.55, ry * 0.5, ch.dark ? "#3a3140" : "#f6f1e3", 0.8);
    strokePts(ctx, rng, ellipsePts(cx, cy + ry * 0.25, rx * 0.55, ry * 0.5, 12),
      { w: 3.5, wob: 3, color: pal.ink, alpha: 0.6, passes: 1, close: true });
  }

  if (!ch.dark) hatch(ctx, rng, cx + rx * 0.55, cy + ry * 0.45, 34, { color: pal.ink, n: 4 });
}

/* 手臂（idle 姿态）：肩关节是轻涂鸦，小臂弓向肚皮。 */
function drawArm(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const bend = W * (0.26 + 0.14 * ch.bodyW + rng() * 0.06);
  const x0 = W * 0.86, mid = x0 - bend, hx = x0 - bend * 0.7;

  strokePts(ctx, rng, [[W * 0.99, H * 0.07], [x0 + (W * 0.99 - x0) * 0.35, H * 0.05], [x0, H * 0.04]],
    { w: 3.5, wob: 4, color: ch.pal.ink, alpha: 0.45 });
  strokePts(ctx, rng, [[x0, H * 0.04], [mid, H * 0.38], [hx, H * 0.86]], { w: 6, wob: 2.5, color: ch.pal.ink });

  if (ch.dark && rng() < 0.6) { // 爪
    for (let i = -1; i <= 1; i++) line(ctx, rng, hx, H * 0.84, hx + i * 9 - 3, H * 0.97, { w: 3.5, color: ch.pal.ink, wob: 1.5, passes: 1 });
  } else {
    strokePts(ctx, rng, ellipsePts(hx, H * 0.9, W * 0.08, H * 0.05), { w: 4, wob: 1.5, color: ch.pal.ink, close: true });
  }
}

/* 手臂（cheer 举手帧，2026-09-16 用户要求的人物反应）：向外上方甩成 V 形，
   手要高过头顶——celebrate 的可见性全靠它。 */
function drawArmUp(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const hx = W * 0.14, hy = H * 0.24;

  strokePts(ctx, rng, [[W * 0.99, H * 0.98], [W * 0.925, H * 0.97], [W * 0.86, H * 0.96]],
    { w: 3.5, wob: 4, color: ch.pal.ink, alpha: 0.45 });
  strokePts(ctx, rng, [[W * 0.86, H * 0.96], [W * 0.44, H * 0.62], [hx, hy]], { w: 6, wob: 2.5, color: ch.pal.ink });

  if (ch.dark) {
    for (let i = -1; i <= 1; i++) line(ctx, rng, hx, hy, hx + i * 9 - 3, hy - H * 0.12, { w: 3.5, color: ch.pal.ink, wob: 1.5, passes: 1 });
  } else {
    strokePts(ctx, rng, ellipsePts(hx, hy - H * 0.04, W * 0.085, H * 0.05), { w: 4, wob: 1.5, color: ch.pal.ink, close: true });
    for (let i = -1; i <= 1; i++) {
      line(ctx, rng, hx + i * 6, hy - H * 0.08, hx + i * 11, hy - H * 0.15, { w: 3, color: ch.pal.ink, wob: 1.2, passes: 1, alpha: 0.9 });
    }
  }
}

/* 手臂（wave 挥手帧，2026-09-22）：单侧上抬到头侧、手掌张开——开/关抽屉的招呼。
   几何照搬已验证的 drawArmUp 上举帧，仅落点收向头侧、加张开的指线。 */
function drawArmWave(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const hx = W * 0.2, hy = H * 0.2;

  strokePts(ctx, rng, [[W * 0.99, H * 0.98], [W * 0.925, H * 0.97], [W * 0.86, H * 0.96]],
    { w: 3.5, wob: 4, color: ch.pal.ink, alpha: 0.45 });
  strokePts(ctx, rng, [[W * 0.86, H * 0.96], [W * 0.5, H * 0.5], [hx, hy]], { w: 6, wob: 2.5, color: ch.pal.ink });

  if (ch.dark) {
    for (let i = -1; i <= 1; i++) line(ctx, rng, hx, hy, hx + i * 9 - 3, hy - H * 0.12, { w: 3.5, color: ch.pal.ink, wob: 1.5, passes: 1 });
  } else {
    strokePts(ctx, rng, ellipsePts(hx, hy, W * 0.085, H * 0.05), { w: 4, wob: 1.5, color: ch.pal.ink, close: true });
    for (let i = -1; i <= 1; i++) {
      line(ctx, rng, hx + i * 6, hy - H * 0.03, hx + i * 11, hy - H * 0.11, { w: 3, color: ch.pal.ink, wob: 1.2, passes: 1, alpha: 0.9 });
    }
  }
}

/* 手臂（shrug 耸肩帧，2026-09-22）：肩正常垂点、小臂外翻向上翻出手掌——「不确定 /
   停一下」。照搬 drawArm 的肩涂鸦，只把小臂折回上抬。 */
function drawArmShrug(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const bend = W * (0.30 + 0.12 * ch.bodyW + rng() * 0.05);
  const x0 = W * 0.86, elbowX = x0 - bend, handX = x0 - bend * 0.45;

  strokePts(ctx, rng, [[W * 0.99, H * 0.07], [x0 + (W * 0.99 - x0) * 0.35, H * 0.05], [x0, H * 0.04]],
    { w: 3.5, wob: 4, color: ch.pal.ink, alpha: 0.45 });
  strokePts(ctx, rng, [[x0, H * 0.04], [elbowX, H * 0.52], [handX, H * 0.34]], { w: 6, wob: 2.5, color: ch.pal.ink });

  /* 翻上的手掌（开口向上的半椭圆——摊手）。 */
  strokePts(ctx, rng, ellipsePts(handX, H * 0.3, W * 0.09, H * 0.05, 10, Math.PI, Math.PI * 2), { w: 4, wob: 1.5, color: ch.pal.ink });
}

/* 手臂（point 指向帧，2026-09-22）：单侧手臂向外下方伸直、食指探出——「看这个」。 */
function drawArmPoint(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const x0 = W * 0.86, handX = W * 0.14, handY = H * 0.62;

  strokePts(ctx, rng, [[W * 0.99, H * 0.07], [x0 + (W * 0.99 - x0) * 0.35, H * 0.05], [x0, H * 0.04]],
    { w: 3.5, wob: 4, color: ch.pal.ink, alpha: 0.45 });
  strokePts(ctx, rng, [[x0, H * 0.04], [W * 0.5, H * 0.34], [handX, handY]], { w: 6, wob: 2.5, color: ch.pal.ink });

  strokePts(ctx, rng, ellipsePts(handX + W * 0.03, handY, W * 0.06, H * 0.045), { w: 4, wob: 1.5, color: ch.pal.ink, close: true });
  line(ctx, rng, handX, handY, handX - W * 0.14, handY + H * 0.04, { w: 4, color: ch.pal.ink, wob: 1.2, passes: 1 });
}

/* 手臂（crossed 抱臂帧，2026-09-22）：肩正常垂点、小臂横过肚皮向内——两臂镜像后
   在身体中线交叠成「抱臂等待」。 */
function drawArmCrossed(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) {
  const x0 = W * 0.9;

  strokePts(ctx, rng, [[W * 0.99, H * 0.07], [x0 + (W * 0.99 - x0) * 0.4, H * 0.05], [x0, H * 0.05]],
    { w: 3.5, wob: 4, color: ch.pal.ink, alpha: 0.45 });
  strokePts(ctx, rng, [[x0, H * 0.05], [W * 0.66, H * 0.4], [W * 0.99, H * 0.62]], { w: 6, wob: 2.5, color: ch.pal.ink });

  strokePts(ctx, rng, ellipsePts(W * 0.96, H * 0.62, W * 0.08, H * 0.05), { w: 4, wob: 1.5, color: ch.pal.ink, close: true });
}

/* 每个姿态的左右手臂函数（[s=-1 侧, s=1 侧]）：对称姿态两侧同函数（靠 s===1 的镜像
   变换成右臂）；wave / point 单侧做动作、另一侧仍垂手。 */
type ArmFn = (ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character) => void;
const ARM_POSES: Record<AvatarPose, readonly [ArmFn, ArmFn]> = {
  idle: [drawArm, drawArm],
  cheer: [drawArmUp, drawArmUp],
  wave: [drawArm, drawArmWave],
  point: [drawArm, drawArmPoint],
  shrug: [drawArmShrug, drawArmShrug],
  crossed: [drawArmCrossed, drawArmCrossed],
};

/* 腿（站立 / 迈步）。swing ∈ [-1,1]：>0 = 这条腿向前摆并抬脚，<0 = 向后蹬（walk
   动画里两条腿相位差半拍）。swing=0 就是原来的直立腿。 */
function drawLeg(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, ch: Character, swing = 0) {
  const footX = W * 0.5 + swing * W * 0.42;
  const lift = Math.max(0, swing) * H * 0.16;
  const kneeX = W * 0.5 + swing * W * 0.18 + jit(rng, 4);
  strokePts(ctx, rng, [[W * 0.5, H * 0.04], [kneeX, H * 0.55 - lift * 0.5], [footX, H * 0.96 - lift]],
    { w: 6, wob: 1.5, color: ch.pal.ink });
}

function drawGround(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number) {
  const pts: number[][] = [];
  for (let i = 0; i <= 24; i++) pts.push([W * i / 24, H * 0.5 + jit(rng, 5)]);
  strokePts(ctx, rng, pts, { w: 4, wob: 3, color: INK, alpha: 0.28, passes: 1 });
}

/* ── species tables（原版 566–584 行）────────────────────────────────────── */

const SPECIES: Record<Species, { ear: EarV; noses: NoseV[]; hairs: HairV[]; mouths: MouthV[]; eyes: EyeV[] }> = {
  human: {
    ear: "human",
    noses: ["curve", "button", "big"],
    hairs: ["messy", "beret", "antennae", "helmet", "spiky", "bald", "messy"],
    mouths: ["smile", "smile", "open", "flat"],
    eyes: ["round", "round", "dot", "sleepy", "glasses"],
  },
  cat: {
    ear: "cat",
    noses: ["triangle"],
    hairs: ["bald", "bald", "beret"],
    mouths: ["catmouth", "smile", "flat"],
    eyes: ["round", "dot", "sleepy"],
  },
  dog: {
    ear: "dog",
    noses: ["snout"],
    hairs: ["bald", "messy"],
    mouths: ["smile", "open", "flat"],
    eyes: ["round", "dot", "sleepy"],
  },
  nightmare: {
    ear: "pointed",
    noses: ["curve", "triangle", "button"],
    hairs: ["horns", "antennae", "messy", "spiky"],
    mouths: ["jagged", "teeth", "open"],
    eyes: ["hollow", "many", "angry", "round"],
  },
};

const SPECIES_ROLL: readonly Species[] = ["human", "human", "cat", "dog", "human", "cat", "dog"];

/** 五官滚动（原版 Character 构造器的确定性部分；动画时钟不搬）。滚动顺序与
    原版一致——同一种子在两个版本里滚出同一个人。 */
function rollCharacter(rng: () => number, nightmareChance: number): Character {
  const species = rng() < nightmareChance ? "nightmare" : pick(rng, SPECIES_ROLL);
  const dark = species === "nightmare";
  const pal = makePalette(rng, dark);
  const sp = SPECIES[species];

  const headW = 1.0 + rng() * 0.25;
  const headH = 1.0 + rng() * 0.25;
  const bodyW = 0.85 + rng() * 0.35;
  const eyeScale = 1.05 + rng() * 0.35;
  const mouthScale = 0.65 + rng() * 0.35;

  const eyeV = pick(rng, sp.eyes);
  const mouthV = pick(rng, sp.mouths);
  const noseV = pick(rng, sp.noses);
  let hairV = pick(rng, sp.hairs);
  const earV = dark ? pick(rng, ["pointed", "cat", "human"] as EarV[]) : sp.ear;
  if (earV === "cat" || earV === "pointed") hairV = "bald"; // 直立耳上不戴帽子
  const blush = rng() < 0.9;
  const bodyDeco = pick(rng, species === "human" ? ["buttons", "stripes", "none", "none"] as BodyDeco[] : ["belly", "none", "stripes"] as BodyDeco[]);

  return { species, dark, pal, headW, headH, bodyW, eyeScale, mouthScale, eyeV, mouthV, noseV, hairV, earV, blush, bodyDeco, state: { blink: false, lookX: 0, lookY: 0 } };
}

/* ── 布局与渲染 ───────────────────────────────────────────────────────────── */

export type AvatarFraming = "bust" | "full";
export type AvatarPose = "idle" | "cheer" | "wave" | "shrug" | "point" | "crossed";

/** 头中心钉在 headGroup y=1.16（原版 HEAD_BASE_Y）；五官认 (u,v) 角度钉在不可见
    头球上（原版 placeFeatures；pitch/yaw 恒 0——不搬视线动画）。 */
const HEAD_BASE_Y = 1.16;
const HEAD_R = 0.34;

/** 世界坐标框（y 向上，地面 = 0）。尺寸是从原版部件摆放算出的包络：
    - bust：头 + 耳 + 发 + 肩口（发顶 ~1.88、耳尖 ~1.78、肩口 ~0.83）；
    - full：全身站姿 + 地面线（手臂最外 ~0.55、地面 ~-0.04）。 */
const FRAMES: Record<AvatarFraming, { x: number; y: number; w: number; h: number }> = {
  /* 半身（32px 圆钮档）：全身在这个尺寸只剩斑点，半身才认得出脸。 */
  bust: { x: -0.56, y: 0.68, w: 1.12, h: 1.26 },
  /* 全身（96px 抽屉头档）：站姿小人 + 地面线。 */
  full: { x: -0.62, y: -0.08, w: 1.24, h: 2.02 },
};

export type AvatarOptions = {
  framing?: AvatarFraming;
  /** nightmare 物种参与滚动（12%）——preferences.avatarNightmare，默认关（边界 5）。 */
  nightmare?: boolean;
  /** 闭眼帧（眨眼动画的落点；false = 静止睁眼）。 */
  blink?: boolean;
  /** 眼睛部件的重描次数：每次眨眼 +1，重描的笔画换一版抖动（boiling line）。 */
  eyeBoil?: number;
  /** 视线（人物反应，2026-09-16）：x/y ∈ [-1,1] 相对头心，y 正 = 向下看——
      只动瞳孔（原版 lookAt 还会带着五官平面微移，这里不搬：96px 下瞳孔偏移
      已可读，头部转向的收益撑不起布局复杂度）。 */
  gaze?: { x: number; y: number };
  /** 姿态（full 框架才有手臂）：idle 垂手 / cheer 举手（celebrate）/ wave 单手挥手
      （开合抽屉招呼）/ shrug 摊手（停止生成）/ point 指向 / crossed 抱臂（thinking
      等待）。手臂反应 = 同一张脸上的表演，不动物种与配色。 */
  pose?: AvatarPose;
  /** 跳跃高度 0..1（celebrate 的抛物线进度，整体上移 0.55 世界单位封顶——
      原版 celebrate 的跳；值由调用方的 rAF 时间线驱动，drawAvatar 本身无时钟）。 */
  jump?: number;
  /** 走路相位 0..1（循环）：流式思考中原地踏步的时钟，由调用方 rAF 驱动。两条腿
      相位差半拍、身体左右微摆——这是 2026-09-22 放宽 Quiet Console 规则 4 后引入的
      **第二个循环动画**（仅在 thinking 心情期间跑，流式结束即停）。full 框架才有腿。 */
  walk?: number;
  /** 表情嘴型覆盖（celebrate 张嘴 / 出错抿嘴）：不在该物种嘴型池里的值忽略——
      猫没有「张嘴」，nightmare 不该被强行「微笑」。 */
  mouth?: MouthV;
};

/** 「换一个形象」的新种子：随机 UUID（本地生成，写进 preferences.avatarSeed；
    非 https 环境没有 randomUUID 时退时间戳+随机串）。 */
export function newAvatarSeed(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 把种子人物画进 size×size 的方形画布（paper 底 + 半身/全身取景）。同参数
    重绘完全一致——确定性落点。 */
export function drawAvatar(ctx: CanvasRenderingContext2D, size: number, seed: string, options: AvatarOptions = {}) {
  const { framing = "bust", nightmare = false, blink = false, eyeBoil = 0, gaze, pose = "idle", jump = 0, walk, mouth } = options;
  /* preferences 是直通存储（PUT 不校验），这里自防护：非字符串/空白种子按
     匿名处理，脏值不进 hashSeed。 */
  const seedText = typeof seed === "string" && seed.trim() ? seed : "anonymous";

  const ch = rollCharacter(rngFrom(seedText), nightmare ? 0.12 : 0);
  /* 反应（gaze/jump/pose/mouth）是同一次确定性滚动之上的「表演」——不动物种与
     配色，人物身份不因表情变化。 */
  ch.state = {
    blink,
    lookX: gaze ? Math.max(-1, Math.min(1, gaze.x)) : 0,
    lookY: gaze ? Math.max(-1, Math.min(1, gaze.y)) : 0,
  };
  if (mouth && SPECIES[ch.species].mouths.includes(mouth)) ch.mouthV = mouth;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, size, size);

  const frame = FRAMES[framing];
  const pad = size * 0.02;
  const scale = Math.min((size - pad * 2) / frame.w, (size - pad * 2) / frame.h);
  /* 跳跃：整根 y 轴抬升（原版 celebrate 的 root.position.y = up * 0.55）。 */
  const lift = Math.max(0, Math.min(1, jump)) * 0.55;
  /* 走路：相位 → 两条腿的摆动（差半拍）+ 躯干左右微摆 + 每步一次的小起伏。
     walk 为 undefined 时全归零——站立不受影响。 */
  const walking = typeof walk === "number" && framing === "full";
  const ph = walking ? (walk as number) * Math.PI * 2 : 0;
  const legSwing = walking ? [Math.sin(ph), Math.sin(ph + Math.PI)] : [0, 0];
  const sway = walking ? Math.sin(ph) * 0.03 : 0;              // 躯干左右微摆
  const bob = walking ? Math.max(0, Math.sin(ph * 2)) * 0.02 : 0; // 每半拍一次的小起伏
  const toX = (x: number) => size / 2 + (x + sway - (frame.x + frame.w / 2)) * scale;
  const toY = (y: number) => pad + (frame.y + frame.h - (y + lift + bob)) * scale;

  /** 一个部件 = 原版一张纹理：本地像素尺寸 + 世界矩形（中心/宽高）+ 可选镜像。
      等价 makePart + 网格摆放，但直接以缩放变换落笔——笔画按最终分辨率光栅化。 */
  const part = (
    localW: number, localH: number,
    cx: number, cy: number, pw: number, ph: number,
    mirror: boolean,
    rng: () => number,
    fn: (ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number) => void,
  ) => {
    const x = toX(cx - pw / 2);
    const y = toY(cy + ph / 2);
    const w = pw * scale;
    const h = ph * scale;
    ctx.save();
    if (mirror) { ctx.translate(x + w, y); ctx.scale(-(w / localW), h / localH); }
    else { ctx.translate(x, y); ctx.scale(w / localW, h / localH); }
    inkFloor = 1.1 / Math.abs(w / localW); // 笔画 ≥1.1 设备像素（见 inkFloor 注释）
    fn(ctx, localW, localH, rng);
    inkFloor = 1;
    ctx.restore();
  };

  /** 部件级确定性抖动流：`seed:part`——重绘间逐笔一致（眼睛除外，见 eyeBoil）。 */
  const stream = (id: string) => rngFrom(`${seedText}:${id}`);
  const withCh = (fn: (ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number, ch: Character) => void) =>
    (c: CanvasRenderingContext2D, w: number, h: number, r: () => number) => fn(c, w, h, r, ch);

  /* ── 自后向前（原版 z 序：地面 < 腿 < 躯干 < 手臂 < 头 < 耳 < 眼 < 鼻 < 嘴 < 发）── */

  if (framing === "full") {
    /* 地面不跟着躯干摆（cx=-sway 抵消 toX 的 sway 项）——踱步是人在动，地不动。 */
    part(1024, 48, -sway, -0.01, 1.6, (1.6 * 48) / 1024, false, rngFrom("avatar-ground"), drawGround);
    /* 迈腿：左右腿相位差半拍（legSwing[0/1]），swing=0 时退回直立腿。 */
    [-1, 1].forEach((s, idx) => part(48, 60, s * 0.12, 0.1, 0.16, 0.2, s === 1, stream(`leg${s}`),
      (c, w, h, r) => drawLeg(c, w, h, r, ch, legSwing[idx])));
  }
  part(224, 224, 0, 0.5, 0.78, 0.82, false, stream("torso"), withCh(drawTorso));
  if (framing === "full") {
    /* 姿态帧换手臂函数（cheer/wave/shrug/point/crossed）；部件流名带 pose——同一姿态
       重绘逐笔一致，切姿态时换一版抖动。wave/point 左右不同函数（单侧做动作）。 */
    const arms = ARM_POSES[pose];
    [-1, 1].forEach((s, idx) => part(96, 160, s * (0.19 * ch.bodyW + 0.137), 0.46, 0.38, 0.52, s === 1, stream(`${pose}Arm${s}`), withCh(arms[idx])));
  }

  part(256, 256, 0, HEAD_BASE_Y, 1.05, 1.05, false, stream("head"), withCh(drawHead));

  /* 耳朵钉在头椭圆上（原版 placeFeatures 的 ear 分支）。 */
  const upright = ch.earV === "cat" || ch.earV === "pointed";
  const earAng = upright ? 0.5 : ch.earV === "dog" ? 1.0 : 0.85;
  const earLift = upright ? 0.09 : ch.earV === "dog" ? -0.02 : 0.04;
  const earRx = 1.05 * 0.36 * ch.headW;
  const earRy = 1.05 * 0.38 * ch.headH;
  for (const s of [-1, 1]) {
    part(96, 96,
      Math.sin(earAng * s) * earRx * 0.93,
      HEAD_BASE_Y + Math.cos(earAng) * earRy * 0.93 - 0.02 + earLift,
      0.36, 0.36, s === 1, stream(`ear${s}`), withCh(drawEar));
  }

  /* 五官：认 (u,v) 角度在头球上（pitch=0 → x 恒 0，y = sin(v)·rad·0.92·headH）。 */
  const featureY = (v: number, rad = HEAD_R) => HEAD_BASE_Y + Math.sin(v) * rad * 0.92 * ch.headH;

  part(160, 64, 0, featureY(0.22), 0.56, 0.22, false, rngFrom(`${seedText}:eyes:${eyeBoil}`), withCh(drawEyes));

  const wideNose = ch.noseV === "triangle" || ch.noseV === "snout";
  part(wideNose ? 192 : 96, 96, 0, featureY(-0.06), wideNose ? 0.72 : 0.36, 0.36, false, stream("nose"), withCh(drawNose));

  part(128, 80, 0, featureY(-0.52), 0.46, 0.29, false, stream("mouth"), withCh(drawMouth));

  part(256, 144, 0, featureY(1.3, HEAD_R * 1.15), 0.95, 0.53, false, stream("hair"), withCh(drawHair));
}
