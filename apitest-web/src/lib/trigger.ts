import type { TriggerSource } from "../api";

/**
 * 触发人（P11 边界 11 的第三问：「谁按的按钮」）。
 *
 * 与资产归属（`Ownership`）不是同一种空值：
 * - `triggeredByEmail` 有值 → 直接显示 email（读时 JOIN 的快照，与「创建人」同形制）；
 * - 为空且**触发源不是手动**（定时 / Webhook / 非人 CI）→ 「系统」——后端在这些人不可达的
 *   路径上写 NULL（边界 3），NULL 就是「没有人工触发人」；
 * - 为空且触发源是**手动** → 「—」——这一次响应没取到（入队回执等不带 join 的形状），
 *   不能说成「系统」；
 * - 单条执行（`executions`）拿不到 `triggerSource`：缺 email 时按「系统」读（列表响应里
 *   手动跑的行一定带 email，见 P11-6）。
 */
export function triggerPersonLabel(
  t: (key: string, vars?: Record<string, unknown>) => string,
  email?: string | null,
  source?: TriggerSource,
): string {
  if (email) return email;
  return source === "manual" ? "—" : t("common.bySystem");
}

/**
 * 触发列的完整文案：「触发源「引用名」 · 触发人」。
 *
 * `source` 可空：入队响应等不含触发列的形状也走这里，缺省读作手动。
 * `triggeredByEmail` 显式传 `undefined` 表示这一行没有触发人这一维（如只回触发源的旧形状），
 * 此时只渲染触发源，不追加「 · —」。
 */
export function triggerLabel(
  t: (key: string, vars?: Record<string, unknown>) => string,
  source?: TriggerSource,
  refName?: string | null,
  triggeredByEmail?: string | null,
) {
  const resolved = source ?? "manual";
  const base = t(`suiteReports.trigger${resolved.charAt(0).toUpperCase()}${resolved.slice(1)}`);
  const withRef = refName ? `${base}「${refName}」` : base;
  if (triggeredByEmail === undefined) return withRef;
  return `${withRef} · ${triggerPersonLabel(t, triggeredByEmail, source)}`;
}
