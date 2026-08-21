/* P2-0: parent execution index plus generic step evidence. */
CREATE TABLE IF NOT EXISTS execution_index (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('flow', 'scenario', 'suite', 'batch')),
  target_id UUID,
  target_name TEXT NOT NULL,
  /* The concrete parent row. Kept as an id rather than a polymorphic FK. */
  detail_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled')),
  total INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  canceled_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (kind, detail_id)
);

CREATE INDEX IF NOT EXISTS execution_index_project_created_at_idx ON execution_index(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_index_target_created_at_idx ON execution_index(kind, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_index_pending_idx ON execution_index(status, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS execution_steps (
  id UUID PRIMARY KEY,
  index_id UUID NOT NULL REFERENCES execution_index(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  step_type TEXT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled')),
  stage INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  /* HTTP evidence stays in executions; database and future non-HTTP steps leave this NULL. */
  http_execution_id UUID REFERENCES executions(id) ON DELETE SET NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (index_id, step_id, position)
);

CREATE INDEX IF NOT EXISTS execution_steps_index_position_idx ON execution_steps(index_id, position);
CREATE INDEX IF NOT EXISTS execution_steps_http_execution_idx ON execution_steps(http_execution_id) WHERE http_execution_id IS NOT NULL;

ALTER TABLE flow_executions ADD COLUMN IF NOT EXISTS execution_index_id UUID REFERENCES execution_index(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS flow_executions_execution_index_id_idx
  ON flow_executions(execution_index_id) WHERE execution_index_id IS NOT NULL;

/*
 * Existing databases may not have pgcrypto. md5(text)::uuid gives a stable UUID
 * for this one-time backfill without introducing an extension dependency.
 */
INSERT INTO execution_index (
  id, project_id, kind, target_id, target_name, detail_id, status,
  total, success_count, failed_count, skipped_count, canceled_count,
  created_at, started_at, finished_at
)
SELECT
  md5('p2-flow-index:' || flow_executions.id::text)::uuid,
  project_id, 'flow', flow_id, flow_name, id, status,
  total, success_count, failed_count, skipped_count,
  CASE WHEN status = 'canceled' THEN GREATEST(total - success_count - failed_count - skipped_count, 0) ELSE 0 END,
  created_at, started_at, finished_at
FROM flow_executions
ON CONFLICT (kind, detail_id) DO NOTHING;

UPDATE flow_executions
SET execution_index_id = execution_index.id
FROM execution_index
WHERE execution_index.kind = 'flow'
  AND execution_index.detail_id = flow_executions.id
  AND flow_executions.execution_index_id IS NULL;
