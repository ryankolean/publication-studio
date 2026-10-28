-- SUMMIT-344 slice 6: guided plans (spec section 6a), stored so she can
-- pick one up again in a new chat ("continue my Macon plan").
--
-- A plan is one server-side template for one wedding, so its id is the
-- wedding's short id and the template, which she or Claude can say. Its
-- progress is never stored: it is worked out from the wedding's own data on
-- every read. Only her choices are kept: the outlet it is for, her words,
-- and the steps she chose to skip.
CREATE TABLE IF NOT EXISTS plans (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  template       TEXT NOT NULL
                   CHECK (template IN ('new_wedding', 'pick_outlets', 'build_package', 'send_and_follow_up', 'after_acceptance')),
  publication_id TEXT REFERENCES publications (id) ON DELETE SET NULL,
  goal           TEXT,
  skipped_json   TEXT NOT NULL DEFAULT '[]',
  created_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (event_id, template)
);
