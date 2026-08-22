import type { DataSourceOperation, SqlParameterDefinition } from "../../models/types.js";
import { resolveDeep } from "../resolve.js";
import { convertValue } from "./common.js";

const MONGO_OPS = ["find", "aggregate", "count", "distinct", "insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany"];

/* Read/write value commands only. No blocking (BLPOP…), no pub/sub (SUBSCRIBE…),
   no scripting (EVAL) — a Lua script is arbitrary code execution from a data
   source config, which this platform does not need to offer. PING is here
   because the connection test goes through the same gate as a user operation.
   Lives here rather than in redis.ts so definition-time validation and the
   driver share one list instead of drifting apart.

   The value is the allowed `args` count as `[min, max]`, with `null` meaning
   variadic. Arity is part of the gate because Redis only answers "wrong number
   of arguments" without saying how many it wanted, and changing the command in
   the editor without fixing `args` is the easiest mistake to make here — this
   turns it into a message at save time. */
const REDIS_COMMANDS: Record<string, [number, number | null]> = {
  PING: [0, 1],
  GET: [1, 1], SET: [2, null], MSET: [2, null], MGET: [1, null],
  DEL: [1, null], EXISTS: [1, null], EXPIRE: [2, 3], TTL: [1, 1], PERSIST: [1, 1],
  INCR: [1, 1], INCRBY: [2, 2], DECR: [1, 1], DECRBY: [2, 2], INCRBYFLOAT: [2, 2],
  GETSET: [2, 2], SETNX: [2, 2],
  LPUSH: [2, null], RPUSH: [2, null], LPOP: [1, 2], RPOP: [1, 2], LRANGE: [3, 3], LLEN: [1, 1],
  HSET: [3, null], HMSET: [3, null], HGET: [2, 2], HGETALL: [1, 1], HDEL: [2, null], HLEN: [1, 1], HEXISTS: [2, 2],
  SADD: [2, null], SREM: [2, null], SMEMBERS: [1, 1], SCARD: [1, 1], SISMEMBER: [2, 2],
};

/** The one gate for a redis operation: allowed command, then allowed arity.
    Used at definition time and again by the driver before it opens a socket. */
export function validateRedisCommand(command: string, argCount: number): string | undefined {
  const arity = REDIS_COMMANDS[command];
  if (!arity) return `redis command "${command}" is not allowed`;
  const [min, max] = arity;
  if (argCount >= min && (max === null || argCount <= max)) return undefined;
  const plural = (count: number) => `${count} argument${count === 1 ? "" : "s"}`;
  if (max === null) return `redis ${command} takes at least ${plural(min)}, got ${argCount}`;
  if (min === max) return `redis ${command} takes ${plural(min)}, got ${argCount}`;
  return `redis ${command} takes ${min}–${max} arguments, got ${argCount}`;
}

/* Operators with no place in a test tool: `$where` / `$function` / `$accumulator`
   execute server-side JavaScript, and `$out` / `$merge` let a nominally read-only
   `aggregate` overwrite a whole collection. The SQL path earns its read-only
   guarantee from `statementType` + `BEGIN READ ONLY`; the operation path has no
   equivalent, so these are refused outright instead of being left to whoever
   reviews each definition. */
const FORBIDDEN_MONGO_OPERATORS = new Set(["$where", "$function", "$accumulator", "$out", "$merge"]);

function isObject(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Per-op payload beyond `collection`: keys that must be present as objects. */
const MONGO_REQUIRED_OBJECTS: Record<string, string[]> = {
  insertOne: ["document"],
  updateOne: ["filter", "update"],
  updateMany: ["filter", "update"],
  replaceOne: ["filter", "replacement"],
  deleteOne: ["filter"],
  deleteMany: ["filter"],
};

/**
 * The first forbidden operator used as a *key* anywhere in the document, or
 * undefined. Keys only: a `$where` sitting in a value position is data.
 *
 * Called twice on purpose — once at definition time, once after `{{name}}`
 * resolution — because a `json` parameter can substitute a whole object and
 * smuggle an operator past the definition-time check. Same split as
 * `skeleton.validateStatement`, where the adapter's exact-dialect pass is the
 * authoritative one.
 */
export function findForbiddenOperator(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) { const found = findForbiddenOperator(item); if (found) return found; }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_MONGO_OPERATORS.has(key)) return key;
      const found = findForbiddenOperator(item); if (found) return found;
    }
  }
  return undefined;
}

/** Which driver an inline operation belongs to, by its shape. */
export function inferOperationKind(operation: unknown): "mongo" | "redis" {
  return (operation as { op?: unknown })?.op === "command" ? "redis" : "mongo";
}

export function validateOperation(operation: unknown): string | undefined {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return "operation must be an object";
  const record = operation as Record<string, unknown>;
  if (record.op === "command") {
    if (typeof record.command !== "string" || !record.command.trim()) return "operation.command is required";
    if (!Array.isArray(record.args)) return "operation.args must be an array";
    /* Same gate the driver applies, run at save time so a wrong command or a
       wrong argument count is a 400 on the definition instead of a raw Redis
       error one step into a flow run. */
    return validateRedisCommand(record.command.trim().toUpperCase(), record.args.length);
  }
  if (typeof record.op !== "string" || !MONGO_OPS.includes(record.op)) return `operation.op must be one of ${MONGO_OPS.join(", ")}`;
  if (typeof record.collection !== "string" || !record.collection.trim()) return "operation.collection is required";
  if (record.op === "aggregate" && !Array.isArray(record.pipeline)) return "aggregate requires a pipeline array";
  if (record.op === "distinct" && (typeof record.field !== "string" || !record.field.trim())) return "distinct requires a field string";
  if (record.op === "insertMany" && (!Array.isArray(record.documents) || !record.documents.length || !record.documents.every(isObject))) return "insertMany requires a non-empty array of documents";
  /* Without this the driver receives `undefined` and answers with a stack trace
     instead of a message naming the field the definition is missing. */
  for (const field of MONGO_REQUIRED_OBJECTS[record.op] ?? []) {
    if (!isObject(record[field])) return `${record.op} requires ${field} to be an object`;
  }
  const forbidden = findForbiddenOperator(record);
  if (forbidden) return `mongo operator "${forbidden}" is not allowed`;
  return undefined;
}

function findTokens(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g)) out.push(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) findTokens(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) findTokens(item, out);
  }
  return out;
}

/**
 * Deep-resolves `{{name}}` tokens inside the operation document. Defaults from
 * the parameter definitions apply when the call site supplied no value; a token
 * that survives resolution is a hard error — sending the literal `{{name}}`
 * into the store would put the cause a whole step away from the report.
 */
export function resolveOperationTokens(
  operation: unknown,
  definitions: SqlParameterDefinition[],
  supplied: Record<string, unknown>,
): unknown {
  const bag: Record<string, unknown> = {};
  for (const definition of definitions) {
    const name = definition.name.trim();
    if (Object.prototype.hasOwnProperty.call(supplied, name)) bag[name] = convertValue(definition, supplied[name]);
    else if (definition.defaultValue !== undefined) bag[name] = definition.defaultValue;
  }
  const resolved = resolveDeep(operation, bag) as DataSourceOperation;
  const leftovers = [...new Set(findTokens(resolved))];
  if (leftovers.length) throw new Error(`operation parameter value missing: ${leftovers.map((name) => `{{${name}}}`).join(", ")}`);
  return resolved;
}
