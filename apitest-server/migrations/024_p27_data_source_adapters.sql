/* P2-7: widen data source types for the adapter increment (see 5.0.10).
   The registry in lib/adapters is the runtime gate for which types can actually
   be created; the CHECK is forward-looking so later adapters need no migration. */
ALTER TABLE data_sources DROP CONSTRAINT data_sources_type_check;
ALTER TABLE data_sources ADD CONSTRAINT data_sources_type_check
  CHECK (type IN ('postgresql', 'mysql', 'sqlserver', 'oracle', 'mongodb', 'redis'));

/* Named definitions stay one table for all data source kinds (5.0.10): CRUD,
   usage scan, flow-node reference, snapshot and try-run share one path. */
ALTER TABLE sql_definitions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sql';
ALTER TABLE sql_definitions ADD CONSTRAINT sql_definitions_kind_check CHECK (kind IN ('sql', 'mongo', 'redis'));
/* Operation JSONB holds a Mongo/Redis operation for kind <> 'sql'; NULL for SQL. */
ALTER TABLE sql_definitions ADD COLUMN IF NOT EXISTS operation JSONB;
