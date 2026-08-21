/*
 * Execution history must stay readable after an environment is deleted.
 *
 * executions.environment_id is ON DELETE SET NULL, so before this migration a
 * deleted environment silently erased "which environment did this run use"
 * from every historical record. Spec 4.4 (历史保留) requires history to keep
 * the resource name and environment snapshot independently of whether the
 * resource still exists, so the name is denormalised onto the run.
 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS environment_name TEXT;

UPDATE executions AS e
SET environment_name = v.name
FROM environments AS v
WHERE e.environment_id = v.id AND e.environment_name IS NULL;
