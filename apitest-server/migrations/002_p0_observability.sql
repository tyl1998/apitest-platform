ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{"theme":"system","language":"zh-CN","restoreLastPage":false}'::jsonb;

ALTER TABLE executions ADD COLUMN IF NOT EXISTS environment_id UUID REFERENCES environments(id) ON DELETE SET NULL;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS response_headers JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS response_content_type TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS response_size_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS response_truncated BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS executions_endpoint_created_at_idx ON executions(endpoint_id, created_at DESC);
