/* P2-1: PostgreSQL data sources and reusable parameterized SQL definitions. */
CREATE TABLE IF NOT EXISTS data_sources (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('postgresql')),
  /* Host/database/user/timeouts only. Password is never stored in this document. */
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  credentials_encrypted BYTEA,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS data_sources_project_created_at_idx ON data_sources(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sql_definitions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  statement_type TEXT NOT NULL CHECK (statement_type IN ('query', 'command')),
  sql TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (data_source_id, name)
);

CREATE INDEX IF NOT EXISTS sql_definitions_project_created_at_idx ON sql_definitions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sql_definitions_data_source_created_at_idx ON sql_definitions(data_source_id, created_at DESC);
