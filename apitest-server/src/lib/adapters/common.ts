import type { SqlParameterDefinition } from "../../models/types.js";
import { sqlSkeleton, type SkeletonFlags } from "./skeleton.js";

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PARAM_TYPES: SqlParameterDefinition["type"][] = ["string", "number", "boolean", "date", "json"];
export const DEFAULT_MAX_ROWS = 100;
export const HARD_MAX_ROWS = 1000;
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const HARD_MAX_BYTES = 10 * 1024 * 1024;

export function validateSqlParams(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "params must be an array";
  if (value.length > 100) return "params must contain at most 100 entries";
  const names = new Set<string>();
  for (const item of value as SqlParameterDefinition[]) {
    if (!item || typeof item !== "object") return "each parameter definition must be an object";
    const extra = Object.keys(item).filter((key) => !["name", "type", "required", "defaultValue"].includes(key));
    if (extra.length) return "parameter definitions only support name, type, required and defaultValue";
    if (!item.name?.trim() || !PARAM_NAME.test(item.name.trim())) return "parameter names must start with a letter or underscore and contain only letters, numbers, dot, dash or underscore";
    if (names.has(item.name.trim())) return `parameter "${item.name.trim()}" is declared twice`;
    names.add(item.name.trim());
    if (!PARAM_TYPES.includes(item.type)) return `parameter "${item.name.trim()}" has an unsupported type`;
    if (item.required !== undefined && typeof item.required !== "boolean") return `parameter "${item.name.trim()}" required must be boolean`;
  }
  return undefined;
}

export function convertValue(definition: SqlParameterDefinition, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  switch (definition.type) {
    case "string": return String(value);
    case "number": {
      const number = Number(value); if (!Number.isFinite(number)) throw new Error(`parameter "${definition.name}" must be a number`); return number;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      throw new Error(`parameter "${definition.name}" must be a boolean`);
    }
    case "date": {
      const date = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(date.getTime())) throw new Error(`parameter "${definition.name}" must be a date`);
      return date;
    }
    case "json": return typeof value === "string" ? JSON.parse(value) : value;
  }
}

/**
 * Replaces `{{name}}` tokens that sit in executable SQL (not inside a string,
 * identifier or comment) with the dialect's positional placeholder. Every
 * occurrence gets its own value slot: that is required by `?` (one array value
 * per placeholder) and harmless for `$n` / `:n` / `@pn`, where a repeated name
 * then simply repeats its value at a new position.
 */
export function compileSql(
  sql: string,
  definitions: SqlParameterDefinition[],
  supplied: Record<string, unknown>,
  placeholder: (index: number) => string,
  flags: SkeletonFlags,
) {
  const byName = new Map(definitions.map((item) => [item.name.trim(), { ...item, name: item.name.trim() }]));
  const values: unknown[] = [];
  const skeleton = sqlSkeleton(sql, flags);
  const compiled = sql.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (token: string, rawName: string, offset: number) => {
    /* A token in a SQL string/comment is data, not a bind location. */
    if (!skeleton.slice(offset, offset + token.length).includes("{")) return token;
    const definition = byName.get(rawName);
    if (!definition) throw new Error(`SQL parameter "${rawName}" is not declared`);
    let value = Object.prototype.hasOwnProperty.call(supplied, rawName) ? supplied[rawName] : definition.defaultValue;
    if ((value === undefined || value === null) && definition.required) throw new Error(`SQL parameter "${rawName}" is required`);
    values.push(convertValue(definition, value));
    return placeholder(values.length);
  });
  const unused = Object.keys(supplied).filter((name) => !byName.has(name));
  if (unused.length) throw new Error(`undeclared SQL parameter values: ${unused.join(", ")}`);
  return { sql: compiled.replace(/;\s*$/, ""), values };
}

export function clamp(value: number | undefined, fallback: number, maximum: number) {
  return Math.min(maximum, Math.max(1, Number.isFinite(value) ? Math.floor(value!) : fallback));
}

/** Shared row limit: a code-authored LIMIT bounds rows, a byte budget bounds
    the serialized result. Both apply uniformly across dialects. */
export function truncateRows(rows: unknown[], maxRows: number, maxBytes: number) {
  const kept: unknown[] = []; let bytes = 0; let truncated = rows.length > maxRows;
  for (const row of rows.slice(0, maxRows)) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (bytes + size > maxBytes) { truncated = true; break; }
    kept.push(row); bytes += size;
  }
  return { rows: kept, truncated };
}
