/* P2-5: external integration Mock rules and their isolated request evidence. */
CREATE TABLE IF NOT EXISTS mocks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  endpoint_id UUID REFERENCES endpoints(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'fixed', 'template', 'proxy')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 0,
  request_match JSONB NOT NULL DEFAULT '{}'::jsonb,
  response JSONB NOT NULL DEFAULT '{"statusCode":200,"headers":{"content-type":"application/json"},"body":"{}"}'::jsonb,
  snapshot_execution_id UUID REFERENCES executions(id) ON DELETE SET NULL,
  proxy_config JSONB,
  delay_ms INTEGER NOT NULL DEFAULT 0 CHECK (delay_ms BETWEEN 0 AND 30000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mocks_project_priority_idx ON mocks(project_id, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS mocks_public_id_idx ON mocks(public_id);

CREATE TABLE IF NOT EXISTS mock_request_logs (
  id UUID PRIMARY KEY,
  mock_id UUID REFERENCES mocks(id) ON DELETE SET NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  matched BOOLEAN NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  request_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mock_request_logs_mock_created_at_idx ON mock_request_logs(mock_id, created_at DESC);
