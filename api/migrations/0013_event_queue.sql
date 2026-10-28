-- SUMMIT-344 slice 5: her running order of outlets for one wedding.
--
-- One outlet holds a wedding at a time (design doc 7.3, 7.4), so she picks
-- the order to try them in. The first outlet without a closed answer is up
-- next; when it declines or the wedding is withdrawn, the next one is. The
-- order is hers: setting it again replaces it whole, and the submissions
-- table stays the record of what was actually sent.
CREATE TABLE IF NOT EXISTS event_queue (
  event_id       TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  publication_id TEXT NOT NULL REFERENCES publications (id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK (position >= 1),
  set_by         TEXT REFERENCES users (id) ON DELETE SET NULL,
  set_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (event_id, publication_id),
  UNIQUE (event_id, position)
);
