-- SUMMIT-337: the photographer's style profile.
--
-- Each wedding is tagged from the same vocabulary as the outlets (the tags
-- table), so the matcher (SUMMIT-336) compares sets. Claude may suggest tags
-- from a wedding's photos and the wedding's date and state suggest a season
-- and a region, but only tags she confirms count. The profile itself is not
-- stored: it is read from her confirmed tags and her past features.

-- One analysis of a wedding's photos: which photos went to Claude, what it
-- cost and how it ended. A run is repeated only when the photo set changes.
CREATE TABLE IF NOT EXISTS style_runs (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  model           TEXT NOT NULL,
  image_keys_json TEXT NOT NULL,   -- the R2 keys sent, in order
  photo_set_hash  TEXT NOT NULL,   -- SHA-256 of the sorted keys
  status          TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'refused')),
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  error           TEXT,
  created_by      TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_style_runs_event ON style_runs (event_id, created_at);

-- A tag on a wedding, and what the photographer made of it. A suggestion
-- stays a suggestion until she confirms or rejects it; a new analysis may
-- replace suggestions but never a decision.
CREATE TABLE IF NOT EXISTS event_tags (
  event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  state      TEXT NOT NULL CHECK (state IN ('suggested', 'confirmed', 'rejected')),
  source     TEXT NOT NULL CHECK (source IN ('analysis', 'derived', 'photographer')),
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  reason     TEXT,                 -- the analysis's one line on what it saw
  run_id     TEXT REFERENCES style_runs (id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (event_id, tag_id)
);

-- Where her work has been published, inside this tool or before it. The
-- outlet is linked when it is one of the researched publications and named
-- either way; the wedding is linked when it is in the tool.
CREATE TABLE IF NOT EXISTS past_features (
  id             TEXT PRIMARY KEY,
  publication_id TEXT REFERENCES publications (id) ON DELETE SET NULL,
  outlet_name    TEXT NOT NULL,
  event_id       TEXT REFERENCES events (id) ON DELETE SET NULL,
  feature_url    TEXT,
  published_on   TEXT,             -- YYYY-MM-DD or YYYY-MM
  role           TEXT NOT NULL DEFAULT 'lead' CHECK (role IN ('lead', 'second_shooter')),
  notes          TEXT,
  created_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Switches the photographer sets for herself. photo_analysis is 'on' only
-- once she has agreed to her photos being sent to Claude for tag suggestions.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY CHECK (key IN ('photo_analysis')),
  value      TEXT NOT NULL,
  updated_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- The intake form's free-text style tags become confirmed tags where they
-- name a vocabulary tag, then the column goes. Every production wedding had
-- an empty list when this shipped.
INSERT OR IGNORE INTO event_tags (event_id, tag_id, state, source)
  SELECT events.id, picked.value, 'confirmed', 'photographer'
  FROM events, json_each(events.style_tags) AS picked
  WHERE picked.value IN (SELECT id FROM tags);

ALTER TABLE events DROP COLUMN style_tags;
