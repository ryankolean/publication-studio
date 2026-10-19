-- Rename the core record from wedding to event (SUMMIT-312).
--
-- 0001-0003 are applied in production, so this migration renames in place
-- rather than editing them. ALTER TABLE ... RENAME keeps every row, CHECK
-- constraint, default and the submissions UNIQUE pair. With
-- legacy_alter_table off (the default in SQLite and D1), renaming the table
-- also rewrites the REFERENCES clauses in vendor_credits, packages,
-- submissions and credit_requests, and renaming a column rewrites the index
-- and UNIQUE definitions that name it.

ALTER TABLE weddings RENAME TO events;
ALTER TABLE events RENAME COLUMN wedding_date TO event_date;

ALTER TABLE vendor_credits  RENAME COLUMN wedding_id TO event_id;
ALTER TABLE packages        RENAME COLUMN wedding_id TO event_id;
ALTER TABLE submissions     RENAME COLUMN wedding_id TO event_id;
ALTER TABLE credit_requests RENAME COLUMN wedding_id TO event_id;

-- Index names are not rewritten by a rename, so the ones that carried the old
-- name are dropped and recreated. idx_packages_pair keeps its name; it is
-- recreated so its definition is stated here against event_id rather than
-- left to the implicit rewrite. idx_submissions_status and idx_audit_entity
-- reference no renamed column and are untouched.
DROP INDEX IF EXISTS idx_weddings_rights;
CREATE INDEX IF NOT EXISTS idx_events_rights ON events (rights_status, consent_status);

DROP INDEX IF EXISTS idx_vendor_credits_wedding;
CREATE INDEX IF NOT EXISTS idx_vendor_credits_event ON vendor_credits (event_id, sort_order);

DROP INDEX IF EXISTS idx_packages_pair;
CREATE INDEX IF NOT EXISTS idx_packages_pair ON packages (event_id, publication_id, version);

-- DECISION: audit rows written before the rename name the old entity. They
-- are relabelled so a query for entity = 'event' sees the whole history.
UPDATE audit_log SET entity = 'event' WHERE entity = 'wedding';
