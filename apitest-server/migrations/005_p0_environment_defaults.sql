CREATE TABLE IF NOT EXISTS project_settings (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  default_environment_id UUID REFERENCES environments(id) ON DELETE SET NULL
);

ALTER TABLE endpoints
  ADD COLUMN IF NOT EXISTS default_environment_id UUID REFERENCES environments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS endpoints_default_environment_id_idx
  ON endpoints(project_id, default_environment_id);
