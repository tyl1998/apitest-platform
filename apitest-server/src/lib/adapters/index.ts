import type { DataSourceType } from "../../models/types.js";
import type { OperationDriver, SqlAdapter } from "./types.js";

/** The registry is the single source of truth for which data source types can
    actually be created and executed — a type in the schema CHECK but not here
    is "not implemented yet", not "supported". SQL drivers and operation
    drivers (mongo/redis) are separate maps because their contracts differ.

    The loaders are dynamic `import()` on purpose: a PostgreSQL-only project
    should not pay to load `mongodb`, `mssql` and `oracledb` into every API and
    worker process, and a driver that fails to load should take down one data
    source type rather than the whole server at boot. */
const sqlLoaders: Partial<Record<DataSourceType, () => Promise<{ default: SqlAdapter }>>> = {
  postgresql: () => import("./postgres.js"),
  mysql: () => import("./mysql.js"),
  sqlserver: () => import("./mssql.js"),
  oracle: () => import("./oracle.js"),
};

const operationLoaders: Partial<Record<DataSourceType, () => Promise<{ default: OperationDriver }>>> = {
  mongodb: () => import("./mongo.js"),
  redis: () => import("./redis.js"),
};

/* `import()` already caches the module, but memoizing the adapter keeps the
   dispatch path free of a promise hop per execution. */
const sqlCache = new Map<DataSourceType, SqlAdapter>();
const operationCache = new Map<DataSourceType, OperationDriver>();

/** The table key and the driver's own `type` must agree, or dispatch would hand
    a data source to the wrong driver. Keying the map off `adapter.type` used to
    make that impossible; with a hand-written loader table it needs a check. */
function assertType(type: DataSourceType, declared: DataSourceType) {
  if (declared !== type) throw new Error(`adapter registered for "${type}" declares type "${declared}"`);
}

export async function getAdapter(type: string): Promise<SqlAdapter | undefined> {
  const key = type as DataSourceType;
  const cached = sqlCache.get(key);
  if (cached) return cached;
  const loader = sqlLoaders[key];
  if (!loader) return undefined;
  const adapter = (await loader()).default;
  assertType(key, adapter.type);
  sqlCache.set(key, adapter);
  return adapter;
}

export async function getOperationDriver(type: string): Promise<OperationDriver | undefined> {
  const key = type as DataSourceType;
  const cached = operationCache.get(key);
  if (cached) return cached;
  const loader = operationLoaders[key];
  if (!loader) return undefined;
  const driver = (await loader()).default;
  assertType(key, driver.type);
  operationCache.set(key, driver);
  return driver;
}

/** What the route layer accepts when creating/editing a data source. Stays
    synchronous on purpose: answering "is this type real" must not load a driver. */
export function isSupportedDataSourceType(type: string): boolean {
  return type in sqlLoaders || type in operationLoaders;
}
