import { performance } from "node:perf_hooks";
import { MongoClient, type Db, type Document, type Sort } from "mongodb";
import { clamp, DEFAULT_MAX_BYTES, DEFAULT_MAX_ROWS, HARD_MAX_BYTES, HARD_MAX_ROWS, truncateRows } from "./common.js";
import { findForbiddenOperator, resolveOperationTokens } from "./operations.js";
import type { OperationDriver, OperationExecutionInput, SqlExecutionResult } from "./types.js";
import type { MongoOperation } from "../../models/types.js";

/** BSON values (ObjectId, Date, Binary, Long…) all expose toJSON; make sure no
    exotic object survives into evidence or the JSON assertion body. */
function normalizeDoc(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeDoc);
  if (typeof value === "object") {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") return (value as { toJSON(): unknown }).toJSON();
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalizeDoc(item);
    return out;
  }
  return value;
}

async function runOperation(db: Db, operation: MongoOperation, maxTimeMS: number, maxRows: number) {
  switch (operation.op) {
    case "find": {
      /* `limit(0)` means "no limit" in MongoDB, so a user-supplied 0 would lift the
         row cap entirely and stream the whole collection into memory. */
      const requested = operation.limit && operation.limit > 0 ? operation.limit : maxRows + 1;
      const limit = Math.min(requested, maxRows + 1);
      const docs = await db.collection(operation.collection).find(operation.filter ?? {}, {
        /* The operation document is user JSON: it is validated for shape, not for
           the driver's own projection/sort types, so it is cast at this boundary. */
        projection: operation.projection, sort: operation.sort as Sort | undefined, maxTimeMS,
      }).limit(limit).toArray();
      return { rows: docs, rowCount: docs.length };
    }
    case "aggregate": {
      const docs = await db.collection(operation.collection).aggregate((operation.pipeline ?? []) as Document[], { maxTimeMS }).limit(maxRows + 1).toArray();
      return { rows: docs, rowCount: docs.length };
    }
    case "count": {
      const count = await db.collection(operation.collection).countDocuments(operation.filter ?? {}, { maxTimeMS });
      return { rows: [{ count }], rowCount: 1 };
    }
    case "distinct": {
      const values = await db.collection(operation.collection).distinct(operation.field, operation.filter ?? {}, { maxTimeMS });
      return { rows: values.slice(0, maxRows + 1).map((value) => ({ value })), rowCount: values.length };
    }
    case "insertOne": {
      const result = await db.collection(operation.collection).insertOne(operation.document, { maxTimeMS });
      return { rows: [{ insertedId: String(result.insertedId) }], rowCount: 1 };
    }
    case "insertMany": {
      const result = await db.collection(operation.collection).insertMany(operation.documents, { maxTimeMS });
      return { rows: [{ insertedCount: result.insertedCount }], rowCount: 1 };
    }
    case "updateOne":
    case "updateMany": {
      const result = await db.collection(operation.collection)[operation.op === "updateOne" ? "updateOne" : "updateMany"](operation.filter, operation.update, { upsert: operation.upsert, maxTimeMS });
      return { rows: [{ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, upsertedId: result.upsertedId ? String(result.upsertedId) : null }], rowCount: 1 };
    }
    case "replaceOne": {
      const result = await db.collection(operation.collection).replaceOne(operation.filter, operation.replacement, { upsert: operation.upsert, maxTimeMS });
      return { rows: [{ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, upsertedId: result.upsertedId ? String(result.upsertedId) : null }], rowCount: 1 };
    }
    case "deleteOne":
    case "deleteMany": {
      const result = await db.collection(operation.collection)[operation.op === "deleteOne" ? "deleteOne" : "deleteMany"](operation.filter, { maxTimeMS });
      return { rows: [{ deletedCount: result.deletedCount }], rowCount: 1 };
    }
  }
}

const adapter: OperationDriver = {
  type: "mongodb",
  execute: async (input: OperationExecutionInput, source): Promise<SqlExecutionResult> => {
    const config = source.config;
    const timeoutMs = clamp(input.timeoutMs ?? config.queryTimeoutMs, 10_000, 60_000);
    const maxRows = clamp(input.maxRows ?? config.maxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS);
    const maxBytes = clamp(input.maxResultBytes ?? config.maxResultBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
    const operation = resolveOperationTokens(input.operation, input.params ?? [], input.values ?? {}) as MongoOperation;
    /* Authoritative pass, after resolution: a `json` parameter can substitute a
       whole object, so the definition-time check in validateOperation cannot be
       the last word on `$where` / `$out` and friends. */
    const forbidden = findForbiddenOperator(operation);
    if (forbidden) throw new Error(`mongo operator "${forbidden}" is not allowed`);
    const connectTimeout = clamp(config.connectTimeoutMs, 5_000, 30_000);
    let uri = "mongodb://";
    if (config.username) uri += `${encodeURIComponent(config.username)}:${encodeURIComponent(source.password ?? "")}@`;
    uri += `${config.host}:${config.port}`;
    const query = new URLSearchParams({ serverSelectionTimeoutMS: String(connectTimeout) });
    if (config.ssl) query.set("tls", "true");
    if (config.authSource) query.set("authSource", config.authSource);
    const client = new MongoClient(`${uri}?${query}`, { serverSelectionTimeoutMS: connectTimeout, maxIdleTimeMS: 1_000 });
    const started = performance.now();
    try {
      await client.connect();
      const db = client.db(config.database);
      const result = await runOperation(db, operation, timeoutMs, maxRows);
      const { rows, truncated } = truncateRows(result.rows.map((row) => normalizeDoc(row)), maxRows, maxBytes);
      return { rows, rowCount: result.rowCount, truncated, durationMs: Math.max(0, Math.round(performance.now() - started)) };
    } finally {
      await client.close().catch(() => {});
    }
  },
};

export default adapter;
