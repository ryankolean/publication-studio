-- The event image pool (SUMMIT-304).
--
-- Until now an image was known only through packages.image_keys, so the
-- curation board had no way to list what was uploaded for an event but not
-- yet selected. One row per R2 object, written by PUT /images/:key after the
-- bytes land. The key is minted server-side as events/<event_id>/<uuid>.<ext>,
-- so it is also the primary key here.

CREATE TABLE IF NOT EXISTS event_images (
  key           TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  content_type  TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_event_images_event ON event_images (event_id, created_at);
