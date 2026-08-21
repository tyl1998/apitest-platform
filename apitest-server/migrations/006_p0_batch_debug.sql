CREATE TABLE IF NOT EXISTS batch_executions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('endpoint_debug')),
  environment_strategy TEXT NOT NULL CHECK (environment_strategy IN ('endpoint_default', 'override')),
  override_environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  total INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES batch_executions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS batch_executions_project_created_at_idx
  ON batch_executions(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS executions_batch_id_idx ON executions(batch_id);
