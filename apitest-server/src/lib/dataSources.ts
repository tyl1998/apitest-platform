import { pool } from "../db.js";
import { decryptSecret } from "./crypto.js";
import { mapSqlDefinition, normalizeDataSourceConfig, type DataSourceConfig, type DataSourceType, type SqlDefinition } from "../models/types.js";

export type LoadedDataSource = {
  id: string;
  projectId: string;
  type: DataSourceType;
  config: DataSourceConfig;
  password?: string;
};

export async function loadDataSource(projectId: string, dataSourceId: string): Promise<LoadedDataSource> {
  const result = await pool.query("SELECT * FROM data_sources WHERE id = $1 AND project_id = $2", [dataSourceId, projectId]);
  if (!result.rowCount) throw new Error("data source not found");
  const row = result.rows[0];
  const type = String(row.type) as DataSourceType;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    type,
    config: normalizeDataSourceConfig(row.config, type),
    password: row.credentials_encrypted ? decryptSecret(row.credentials_encrypted as Buffer) : undefined,
  };
}

export async function loadSqlDefinition(projectId: string, sqlId: string): Promise<SqlDefinition | undefined> {
  const result = await pool.query("SELECT * FROM sql_definitions WHERE id = $1 AND project_id = $2", [sqlId, projectId]);
  if (!result.rowCount) return undefined;
  return mapSqlDefinition(result.rows[0]);
}
