import type { HookResult } from "../api";

/**
 * `POST /scripts/try` is shared by assertion and hook scripts, so its payload is
 * a union. Treating an assertion result (`{ passed }`) as a hook result
 * (`{ ok, changed, debug }`) made `HookOutcome` read `.length` from undefined
 * and took down the entire drawer. This guard keeps the failure local: show the
 * returned error as an invalid hook result instead of throwing during render.
 */
export function isHookResult(value: unknown): value is HookResult {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as HookResult).ok === "boolean"
    && Array.isArray((value as HookResult).logs)
    && Array.isArray((value as HookResult).debug)
    && Array.isArray((value as HookResult).changed);
}

/**
 * Old execution rows and failed/malformed try-responses need a display shape.
 * Normalizing at the UI edge makes hook history forward-compatible if a later
 * backend adds fields or an older record predates `hook_results`.
 */
export function normalizeHookResult(value: Partial<HookResult> | undefined, fallback = "hook"): HookResult {
  return {
    name: typeof value?.name === "string" ? value.name : fallback,
    type: typeof value?.type === "string" ? value.type : "script",
    ok: value?.ok === true,
    error: typeof value?.error === "string" ? value.error : undefined,
    logs: Array.isArray(value?.logs) ? value.logs.map(String) : [],
    debug: Array.isArray(value?.debug)
      ? value.debug
        .filter((entry): entry is { label: string; value: string } => Boolean(entry) && typeof entry.label === "string" && typeof entry.value === "string")
      : [],
    changed: Array.isArray(value?.changed) ? value.changed.map(String) : [],
    /* Absent on rows recorded before 计划 4.0.2 and on failed try-responses, so
       it normalizes to an empty list rather than undefined — a renderer reading
       `.length` off it is exactly the crash this module exists to prevent. */
    checks: Array.isArray(value?.checks)
      ? value.checks
        .filter((check): check is { label: string; passed: boolean; message?: string } => Boolean(check) && typeof check.label === "string" && typeof check.passed === "boolean")
      : [],
  };
}
