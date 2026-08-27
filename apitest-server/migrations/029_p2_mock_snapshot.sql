/* P2-5: remember which successful execution supplied an auto snapshot. */
ALTER TABLE mocks
  ADD COLUMN IF NOT EXISTS snapshot_execution_id UUID REFERENCES executions(id) ON DELETE SET NULL;
