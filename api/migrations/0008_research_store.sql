-- SUMMIT-335: the research files in research/publications/ load into D1
-- behind an approval gate.
--
-- The import (scripts/import-research.ts) posts each outlet's validated file
-- as a revision. Nothing reaches the publications table until a person
-- approves the revision in the app; approving copies the research into the
-- existing publication columns, so the wizard and the package checklist keep
-- reading what they read today.
--
-- The photographer's own corrections and tags live beside the research, never
-- inside it, so approving newer research cannot overwrite them.

-- One imported version of an outlet's research file. publication_id carries no
-- foreign key on purpose: a new outlet has no publications row until its first
-- revision is approved.
CREATE TABLE IF NOT EXISTS research_revisions (
  id             TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,
  payload_json   TEXT NOT NULL,   -- {"file": <validated research file>, "contacts": <private overlay or null>}
  content_hash   TEXT NOT NULL,   -- SHA-256 of the canonical payload; an unchanged import adds nothing
  git_sha        TEXT,            -- the commit the files were read from, when the import knows it
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  proposed_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  proposed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  reviewed_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at    TEXT,
  review_note    TEXT
);

CREATE INDEX IF NOT EXISTS idx_research_revisions_publication
  ON research_revisions (publication_id, status, proposed_at);

-- The vocabulary files the research is validated against. Loaded by the
-- import with no approval step: tags only ever grow, and location codes are
-- not facts about an outlet.
CREATE TABLE IF NOT EXISTS research_vocab (
  kind         TEXT PRIMARY KEY CHECK (kind IN ('tags', 'geo')),
  json         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- NULL until the outlet's first research revision is approved; the ten outlets
-- seeded by 0002 and 0006 keep their hand-entered columns until then.
ALTER TABLE publications ADD COLUMN kind TEXT
  CHECK (kind IN ('national_magazine', 'regional_magazine', 'blog', 'destination_international'));
ALTER TABLE publications ADD COLUMN research_json TEXT;
ALTER TABLE publications ADD COLUMN research_revision_id TEXT REFERENCES research_revisions (id);

-- The photographer's corrections to a research fact, keyed by the fact's path
-- in the research file (for example timing.response_window). Shown in place
-- of the research value, and flagged when newer research changes the field.
CREATE TABLE IF NOT EXISTS publication_edits (
  publication_id TEXT NOT NULL REFERENCES publications (id) ON DELETE CASCADE,
  field          TEXT NOT NULL,
  value_json     TEXT NOT NULL,
  note           TEXT,
  updated_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (publication_id, field)
);

-- Rows seeded by 0006 came from research, so they default to it.
ALTER TABLE publication_tags ADD COLUMN origin TEXT NOT NULL DEFAULT 'research'
  CHECK (origin IN ('research', 'added', 'removed'));

ALTER TABLE tags ADD COLUMN origin TEXT NOT NULL DEFAULT 'seed'
  CHECK (origin IN ('seed', 'custom'));
