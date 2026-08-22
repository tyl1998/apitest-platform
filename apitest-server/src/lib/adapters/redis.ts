import { performance } from "node:perf_hooks";
import { Redis } from "ioredis";
import { clamp, DEFAULT_MAX_BYTES, DEFAULT_MAX_ROWS, HARD_MAX_BYTES, HARD_MAX_ROWS, truncateRows } from "./common.js";
import { resolveOperationTokens, validateRedisCommand } from "./operations.js";
import type { OperationDriver, OperationExecutionInput, SqlExecutionResult } from "./types.js";
import type { RedisOperation } from "../../models/types.js";

/** ioredis returns strings/numbers/arrays/nulls/objects (HGETALL). Map every
    shape into the shared `rows` contract without losing the value. */
function normalizeResult(value: unknown): unknown[] {
  if (value === null) return [];
  if (Array.isArray(value)) return value.map((item) => ({ value: item }));
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([field, item]) => ({ field, value: item }));
  return [{ value }];
}

const adapter: OperationDriver = {
  type: "redis",
  execute: async (input: OperationExecutionInput, source): Promise<SqlExecutionResult> => {
    const config = source.config;
    const timeoutMs = clamp(input.timeoutMs ?? config.queryTimeoutMs, 10_000, 60_000);
    const maxRows = clamp(input.maxRows ?? config.maxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS);
    const maxBytes = clamp(input.maxResultBytes ?? config.maxResultBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
    const operation = resolveOperationTokens(input.operation, input.params ?? [], input.values ?? {}) as RedisOperation;
    const command = String(operation.command ?? "").toUpperCase().trim();
    /* Arity is checked on the *resolved* args, before a socket is opened: a
       rejected command should never reach the server. */
    const args = (operation.args ?? []).map((arg) => String(arg));
    const invalid = validateRedisCommand(command, args.length);
    if (invalid) throw new Error(invalid);
    const client = new Redis({
      host: config.host, port: config.port, db: Number(config.database) || 0,
      username: config.username || undefined, password: source.password || undefined,
      connectTimeout: clamp(config.connectTimeoutMs, 5_000, 30_000),
      commandTimeout: timeoutMs,
      /* Fail fast: a test tool must not spin on a dead server. */
      maxRetriesPerRequest: 1, retryStrategy: () => null,
      /* Must stay lazy: the constructor connects on its own otherwise, and the
         explicit `connect()` below would then reject with "Redis is already
         connecting/connected". Connecting here keeps the failure at one place. */
      lazyConnect: true,
      tls: config.ssl ? {} : undefined,
    });
    const started = performance.now();
    try {
      await client.connect();
      /* Lowercase on the wire: ioredis registers its reply transformers under the
         lowercase command name (`hgetall` → object), and `call()` looks them up by
         the exact name it is given. Passing "HGETALL" silently skipped the
         transformer and returned a flat [field, value, …] array instead of a hash.
         The whitelist check above stays uppercase. */
      const raw = await client.call(command.toLowerCase(), ...args);
      const rows = normalizeResult(raw);
      const { rows: kept, truncated } = truncateRows(rows, maxRows, maxBytes);
      return { rows: kept, rowCount: rows.length, truncated, durationMs: Math.max(0, Math.round(performance.now() - started)) };
    } finally {
      await client.quit().catch(() => client.disconnect());
    }
  },
};

export default adapter;
