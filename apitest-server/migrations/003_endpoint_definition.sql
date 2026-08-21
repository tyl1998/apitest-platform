/*
 * Endpoint definition fields required by Spec 2.1.1 (URL, Method, Headers,
 * Query Params, Body, Auth) that 001 did not carry.
 *
 * body stays JSONB for JSON payloads; body_text holds raw text/form/binary
 * payloads that are not valid JSON, so switching body type never discards
 * what the user typed.
 */
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS query_params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS path_params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS body_type TEXT NOT NULL DEFAULT 'none'
  CHECK (body_type IN ('none', 'json', 'form', 'text'));
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS body_text TEXT;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS auth JSONB NOT NULL DEFAULT '{"type":"none"}'::jsonb;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

/* Existing rows with a JSON body predate body_type and would otherwise read as 'none'. */
UPDATE endpoints SET body_type = 'json' WHERE body IS NOT NULL AND body_type = 'none';
