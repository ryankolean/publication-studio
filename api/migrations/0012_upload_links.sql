-- Photo intake by link, for the Claude connector (SUMMIT-344 slice 2).
--
-- get_upload_link mints a link for one wedding; she opens it in her browser
-- and drags in her web-size exports. Only the token's SHA-256 is stored, as
-- with invites and confirmation codes. A link stops working after 24 hours,
-- when she says she is finished, or when a newer link for the same wedding
-- replaces it, and it takes at most a fixed number of photos (`photos`
-- counts what it has taken).
--
-- Each photo also gets a small preview, made in her browser on that page, or
-- once by an operator script for photos stored before this existed. Claude
-- looks through the previews with review_photos; the Worker never resizes
-- anything. preview_key is the preview's R2 key, NULL until one is stored.

CREATE TABLE IF NOT EXISTS upload_links (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  photos      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at  TEXT NOT NULL,
  closed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_upload_links_event ON upload_links (event_id);

ALTER TABLE event_images ADD COLUMN preview_key TEXT;
