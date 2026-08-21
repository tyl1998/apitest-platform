/*
 * Project-scoped opt-in for plaintext execution records.
 *
 * Default off keeps the documented masking (Spec 4.6) for every project.
 * A project that opts in stores request/response evidence unmasked, so an
 * internal team can read the exact credentials a signed request carried
 * instead of asterisks — at the cost of environment secrets resolved into
 * those records becoming readable to anyone with execution-record access.
 */

ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS store_plaintext BOOLEAN NOT NULL DEFAULT false;
