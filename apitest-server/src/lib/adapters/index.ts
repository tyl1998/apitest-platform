import type { DataSourceType } from "../../models/types.js";
import mysql from "./mysql.js";
import postgresql from "./postgres.js";
import type { SqlAdapter } from "./types.js";

/** The registry is the single source of truth for which data source types can
    actually be created and executed — a type in the schema CHECK but not here
    is "not implemented yet", not "supported". */
const registry = new Map<DataSourceType, SqlAdapter>();
for (const adapter of [postgresql, mysql]) registry.set(adapter.type, adapter);

export function getAdapter(type: string): SqlAdapter | undefined {
  return registry.get(type as DataSourceType);
}
