import { getOperationDriver } from "./adapters/index.js";
import type { OperationExecutionInput, SqlExecutionResult } from "./adapters/types.js";
import { loadDataSource } from "./dataSources.js";

/** Dispatches a mongo/redis operation to the driver registered for the data
    source's type. Same envelope as `executeSql` so a database step treats both
    paths identically. */
export async function executeOperation(input: OperationExecutionInput): Promise<SqlExecutionResult> {
  const source = await loadDataSource(input.projectId, input.dataSourceId);
  const driver = await getOperationDriver(source.type);
  if (!driver) throw new Error(`data source type "${source.type}" does not support operations`);
  return driver.execute(input, { type: source.type, config: source.config, password: source.password });
}
