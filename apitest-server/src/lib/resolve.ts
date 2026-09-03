/**
 * Built-in variables (Spec 2.1.2). Resolved per reference at run time and not
 * stored anywhere, so they cannot be edited or deleted from an environment.
 *
 * They take precedence over environment variables of the same name: the name
 * is reserved, and letting an environment silently shadow `$uuid` would make
 * a request behave differently depending on which environment ran it.
 *
 * Each accepts optional arguments in `{{$name(args)}}` form. Without arguments
 * the previous defaults are unchanged, so existing environments keep working.
 *
 *   {{$timestamp}}            epoch milliseconds
 *   {{$timestamp(s)}}         epoch seconds
 *   {{$date}}                 2026-08-07
 *   {{$date(YYYY-MM-DD)}}     2026-08-07
 *   {{$date(MM)}}             08
 *   {{$date(YYYYMMDDHHmmss)}} 20260807181635
 *   {{$uuid}}                 v4
 *   {{$randomInt}}            0 – 999999
 *   {{$randomInt(100)}}       0 – 100
 *   {{$randomInt(10,20)}}     10 – 20
 *   {{$randomStr}}            8 chars
 *   {{$randomStr(16)}}        16 chars
 */
export const BUILTIN_VARIABLES = ["$timestamp", "$date", "$uuid", "$randomInt", "$randomStr"] as const;

/**
 * A fresh regex per call. A shared `/g` instance carries `lastIndex` between
 * `replace` and `matchAll`, which makes resolution depend on what ran before.
 */
const reference = () => /{{\s*(\$?[\w.-]+)\s*(?:\(([^)]*)\))?\s*}}/g;

/**
 * Date tokens, longest-first so `YYYY` is not consumed as two `YY` and `SSS`
 * not as `ss` + `S`. Local time, because a user writing `YYYY-MM-DD` into a
 * request means the date they see on their own clock.
 */
const DATE_TOKENS = /YYYY|YY|MM|DD|HH|mm|SSS|ss/g;

function formatDate(date: Date, pattern: string) {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return pattern.replace(DATE_TOKENS, (token) => {
    switch (token) {
      case "YYYY": return String(date.getFullYear());
      case "YY": return pad(date.getFullYear() % 100);
      case "MM": return pad(date.getMonth() + 1);
      case "DD": return pad(date.getDate());
      case "HH": return pad(date.getHours());
      case "mm": return pad(date.getMinutes());
      case "ss": return pad(date.getSeconds());
      case "SSS": return pad(date.getMilliseconds(), 3);
      default: return token;
    }
  });
}

/** Lowercase alphanumerics, matching what `toString(36)` produced before. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomStr(size: number) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/**
 * `rawArgs` is `undefined` for a bare `{{$name}}` and the literal text inside
 * the parentheses otherwise. `$date` reads it whole, since a format may contain
 * commas; the numeric builtins split it.
 */
function builtin(name: string, rawArgs?: string): string | undefined {
  const args = (rawArgs ?? "").split(",").map((arg) => arg.trim()).filter(Boolean);

  switch (name) {
    case "$timestamp": {
      const now = Date.now();
      return args[0]?.toLowerCase() === "s" ? String(Math.floor(now / 1000)) : String(now);
    }
    case "$date":
      return formatDate(new Date(), rawArgs?.trim() || "YYYY-MM-DD");
    case "$uuid":
      return crypto.randomUUID();
    case "$randomInt": {
      const bounds = args.map(Number).filter(Number.isFinite);
      let [min, max] = bounds.length === 1
        ? [0, Math.floor(bounds[0])]
        : bounds.length >= 2 ? [Math.floor(bounds[0]), Math.floor(bounds[1])] : [0, 999_999];
      if (max < min) [min, max] = [max, min];
      return String(min + Math.floor(Math.random() * (max - min + 1)));
    }
    case "$randomStr": {
      const requested = Number(args[0]);
      /* Clamped: a stray {{$randomStr(1e9)}} should not allocate a gigabyte. */
      const size = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 4096) : 8;
      return randomStr(size);
    }
    default:
      return undefined;
  }
}

/**
 * A variable bag may hold non-strings (P1-2).
 *
 * A flow extract can capture an array or an object — `$.data.packageNos` is the
 * motivating case — and the next step usually needs to put it into a JSON body
 * *as* an array. Forcing every value to string at capture time made that
 * impossible: the body received `"[\"A\",\"B\"]"` where the API expected
 * `["A","B"]`, and no amount of template writing could recover the difference.
 */
export type VariableBag = Record<string, unknown>;

/** Text for interpolation: objects and arrays as JSON, everything else as-is. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/**
 * Replaces every `{{name}}` reference. Unknown names are left verbatim — and
 * left exactly as written, arguments included — so a missing variable or a
 * misspelled builtin is visible in the execution snapshot rather than silently
 * collapsing to an empty string.
 *
 * Always returns a string. A structured value embedded in surrounding text can
 * only be text, so it is serialized; whole-field substitution is the caller's
 * job (`resolveDeep`).
 */
export function resolveVariables(value: string, variables: VariableBag) {
  return value.replace(reference(), (whole, key: string, rawArgs: string | undefined) => {
    const resolved = key.startsWith("$") ? builtin(key, rawArgs) : variables[key];
    return resolved === undefined ? whole : asText(resolved);
  });
}

/**
 * Matches a string that is *nothing but* one reference, e.g. `"{{items}}"`.
 *
 * The distinction this draws is the whole point of structured variables:
 * `{ "list": "{{items}}" }` means "put the array here", while
 * `{ "note": "got {{items}}" }` can only mean text. Anchoring the pattern is
 * what lets one bag serve both without a second syntax to learn.
 */
const SOLE_REFERENCE = /^\s*{{\s*(\$?[\w.-]+)\s*(?:\(([^)]*)\))?\s*}}\s*$/;

export function resolveDeep(value: unknown, variables: VariableBag): unknown {
  if (typeof value === "string") {
    const sole = SOLE_REFERENCE.exec(value);
    if (sole) {
      const [, key, rawArgs] = sole;
      const resolved = key.startsWith("$") ? builtin(key, rawArgs) : variables[key];
      /* Unknown names stay verbatim, exactly as in `resolveVariables`, so a
         typo remains visible in the snapshot instead of becoming null. */
      if (resolved === undefined) return value;
      /**
       * A captured value arrives as text when it came from a `{{var}}` chain, so
       * a JSON-looking string is re-parsed to restore its shape. Guarded by the
       * first character: a token like `123456` must stay a string, or an id would
       * silently become a number and change the request.
       */
      if (typeof resolved === "string") {
        const trimmed = resolved.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try { return JSON.parse(trimmed); } catch { return resolved; }
        }
        return resolved;
      }
      return resolved;
    }
    return resolveVariables(value, variables);
  }
  if (Array.isArray(value)) return value.map((item) => resolveDeep(item, variables));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveDeep(item, variables)]));
  return value;
}

/**
 * 触发时变量覆盖的键形约束（P3-2，计划 6.5）。
 *
 * 只接受 `Record<string, string>`，键匹配 `^[A-Za-z_][A-Za-z0-9_]*$`：键会变成变量袋
 * 里的名字，宽松的键（带点、带空格、`__proto__`）要么解析不了要么会撞坏袋的语义。
 * 套件执行、调度配置（P3-6）与 Webhook 请求体（P3-3）共用这一个校验，两份实现
 * 必然在「哪些键放行」上分叉。
 */
export const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 校验一份变量覆盖；返回 undefined 表示合法（或未提供）。
 *
 * `label` 只进错误文案（P4.5-2 起 CI 触发参数共用同一份键形校验，说 "parameters" 而不是
 * 误报 "variables"）；默认值保持既有调用方的消息不变。
 */
export function validateVariableOverrides(input: unknown, label = "variables"): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) return `${label} must be an object of string values`;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!VARIABLE_NAME_PATTERN.test(key)) return `${label} name "${key}" must start with a letter or underscore and contain only letters, digits and underscores`;
    if (typeof value !== "string") return `${label} "${key}" must be a string`;
  }
  return undefined;
}

/** Every `{{name}}` referenced by a string, excluding built-ins. */
export function collectReferences(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(reference())) {
      const name = match[1];
      if (!name.startsWith("$")) into.add(name);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { collectReferences(key, into); collectReferences(item, into); }
  }
  return into;
}
