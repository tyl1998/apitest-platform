/*
 * P2-2.1: request-node lifecycle closure.
 *
 * A test case now snapshots the same processing phases as a flow request node:
 * pre-request processing, simple response extracts, response scripts, then
 * declarative assertions. Execution evidence keeps response-script outcomes in
 * its own column instead of disguising them as assertion results.
 */

ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS pre_request_hooks JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS extracts JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS response_scripts JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE executions ADD COLUMN IF NOT EXISTS response_script_results JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE scripts DROP CONSTRAINT IF EXISTS scripts_kind_check;
ALTER TABLE scripts ADD CONSTRAINT scripts_kind_check
  CHECK (kind IN ('assertion', 'hook', 'response', 'library', 'node'));

/* Public-script usage checks use JSONB containment before edit/delete. */
CREATE INDEX IF NOT EXISTS test_cases_pre_request_hooks_gin_idx ON test_cases USING gin (pre_request_hooks);
CREATE INDEX IF NOT EXISTS test_cases_response_scripts_gin_idx ON test_cases USING gin (response_scripts);
