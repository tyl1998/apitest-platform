import { useEffect, useRef, useState } from "react";
import { drawAvatar, type AvatarFraming, type MouthV } from "../lib/avatar";

/**
 * 人物头像（P9-6）：`lib/avatar` 的 Canvas 2D 封装，两档尺寸两个挂点——
 * 抽屉圆钮 32px（bust 半身）与抽屉头 96px（full 全身）。
 *
 * - 确定性：同一种子永远同一张脸，头像不落库、前端每次画；
 * - **人物反应（2026-09-16 用户要求）**：`mood` 是持续基线（idle / thinking=流式
 *   中的「想」），`pulse` 是一次性反应（greet 开抽屉打招呼 / sent 发出消息低头
 *   看一眼 / done 回复完成欢呼 / error 出错委屈 / bounce 圆钮小跳）——由调用方
 *   递增 nonce 触发。反应 = 同一张脸上的表演（视线/嘴型/姿态/跳跃），不动物种
 *   与配色；且全部是状态变化驱动的离散动画，与 Quiet Console「动效只标记状态
 *   变化」一致；
 * - 眨眼是唯一的 idle 循环动画（计划 13.0 边界 5），只在 `animate` 为真且
 *   mood idle 且无一次性反应时跑——调用方保证「抽屉打开 && 没有在飞请求」
 *   （全应用只允许一个环境动画，与在飞呼吸点不同时出现）；
 * - `prefers-reduced-motion`：眨眼与跳跃停（跳跃直接落到姿态帧，位移消失、
 *   表情还在——表情是状态不是动效），视线/嘴型的切换保留。
 */
export type AvatarMood = "idle" | "thinking";
export type AvatarPulseKind = "greet" | "sent" | "done" | "error" | "bounce";
export type AvatarPulse = { kind: AvatarPulseKind; nonce: number };

const JUMP_MS = 900;
const JUMP_KINDS = new Set<AvatarPulseKind>(["greet", "done", "bounce"]);
const HOLD_MS: Record<AvatarPulseKind, number> = { greet: 700, sent: 700, done: 700, error: 2200, bounce: 400 };
const IDLE_PHASE = { kind: null, started: 0 } as const;

export function Avatar({ seed, size, framing, animate = false, mood = "idle", pulse, nightmare = false, className }: {
  seed: string;
  size: number;
  framing?: AvatarFraming;
  animate?: boolean;
  mood?: AvatarMood;
  pulse?: AvatarPulse;
  nightmare?: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [blink, setBlink] = useState(false);
  const boilRef = useRef(0);
  const [phase, setPhase] = useState<{ kind: AvatarPulseKind | null; started: number }>(IDLE_PHASE);
  const [jump, setJump] = useState(0);
  const reducedMotion = useRef(window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  /* pulse 触发：nonce 变化才认——同一个对象被重复 set 不重触发。 */
  const pulseNonce = useRef<number>();
  useEffect(() => {
    if (!pulse || pulse.nonce === pulseNonce.current) return;
    pulseNonce.current = pulse.nonce;
    setPhase({ kind: pulse.kind, started: performance.now() });
  }, [pulse]);

  /* 跳跃时间线（rAF）：greet/done/bounce；高度走 4p(1-p) 抛物线（原版 celebrate
     的 ballistic flight），落回基线。 */
  useEffect(() => {
    if (!phase.kind || !JUMP_KINDS.has(phase.kind)) { setJump(0); return; }
    /* reduced-motion：不跑帧循环，姿态帧停一个保持时长就收（位移消失、表情保留）。 */
    if (reducedMotion.current) {
      const timer = window.setTimeout(() => setPhase(IDLE_PHASE), HOLD_MS[phase.kind]);
      return () => window.clearTimeout(timer);
    }
    let raf = 0;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const p = Math.min(1, (performance.now() - phase.started) / JUMP_MS);
      setJump(p < 1 ? 4 * p * (1 - p) : 0);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setPhase(IDLE_PHASE);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [phase]);

  /* 非跳跃反应（sent/error）的保持计时。 */
  useEffect(() => {
    if (!phase.kind || JUMP_KINDS.has(phase.kind)) return;
    const timer = window.setTimeout(() => setPhase(IDLE_PHASE), HOLD_MS[phase.kind]);
    return () => window.clearTimeout(timer);
  }, [phase]);

  /* 眨眼时钟：只在 idle 基线、无一次性反应时跑；animate 关闭（抽屉合上 / 在飞
     请求出现）立即停在睁眼帧。 */
  useEffect(() => {
    if (!animate || mood !== "idle" || phase.kind) { setBlink(false); return; }
    if (reducedMotion.current) return;
    let timer: number | undefined;
    let alive = true;
    const closeEyes = () => {
      if (!alive) return;
      setBlink(false);
      timer = window.setTimeout(openEyes, 1600 + Math.random() * 4600);
    };
    const openEyes = () => {
      if (!alive) return;
      boilRef.current += 1;
      setBlink(true);
      timer = window.setTimeout(closeEyes, 110 + Math.random() * 70);
    };
    timer = window.setTimeout(openEyes, 1200 + Math.random() * 3800);
    return () => { alive = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [animate, seed, mood, phase.kind]);

  /* 表演参数：一次性反应优先于 mood 基线。cheer = 举手 + 张嘴 + 眼睛向上
     （原版 celebrate 的 lookY -0.8）；think = 视线抬起看向侧上方。 */
  const cheer = phase.kind === "greet" || phase.kind === "done";
  const gazeX = cheer ? 0 : phase.kind === "sent" ? 0 : phase.kind === "error" ? 0 : mood === "thinking" ? -0.55 : 0;
  const gazeY = cheer ? -0.8 : phase.kind === "sent" ? 0.7 : phase.kind === "error" ? 0.8 : mood === "thinking" ? -0.35 : 0;
  const pose = cheer ? "cheer" : "idle";
  const mouth: MouthV | undefined = cheer ? "open" : phase.kind === "error" ? "flat" : undefined;

  /* 画像：任一参数变化即整张重画（部件级确定性流保证表情帧间其余部件逐笔
     一致）。dpr 封顶 2——铅笔线在更高密度上不再需要更细。 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawAvatar(ctx, canvas.width, seed, {
      framing,
      nightmare,
      blink,
      eyeBoil: boilRef.current,
      gaze: { x: gazeX, y: gazeY },
      pose,
      jump,
      mouth,
    });
  }, [seed, size, framing, nightmare, blink, gazeX, gazeY, pose, jump, mouth]);

  return <canvas ref={canvasRef} className={`avatar-canvas${className ? ` ${className}` : ""}`} style={{ width: size, height: size }} aria-hidden />;
}
