-- SUMMIT-336: what the matcher needs to know about a wedding, and a compact
-- copy of what it needs to know about an outlet.
--
-- The matcher itself stores nothing: it ranks outlets on each request from
-- these columns, the wedding's tags, and her history with each outlet.

-- Where the wedding took place, as a code from research/vocab/geo.yaml
-- (US-XX, US-XX:<metro> or a country code), so it compares directly with an
-- outlet's coverage. The free-text city, state and country stay: outlets
-- print those.
ALTER TABLE events ADD COLUMN location_code TEXT;

ALTER TABLE events ADD COLUMN content_type TEXT NOT NULL DEFAULT 'real_wedding'
  CHECK (content_type IN ('real_wedding', 'elopement', 'styled_shoot'));

-- Where the wedding has already been shared, one row per place. Outlets that
-- take only unshared weddings read these; the couple's and vendors' posts are
-- the ones most often missed.
CREATE TABLE IF NOT EXISTS event_exposures (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  channel        TEXT NOT NULL
                   CHECK (channel IN ('own_blog', 'own_social', 'couple_social', 'vendor_social', 'publication')),
  detail         TEXT,             -- which vendor or which outlet, in her words
  publication_id TEXT REFERENCES publications (id) ON DELETE SET NULL,
  created_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_event_exposures_event ON event_exposures (event_id);

-- The intake's prior_exposure JSON becomes rows, then the column goes. Every
-- production wedding had nothing recorded when this shipped.
INSERT INTO event_exposures (id, event_id, channel)
  SELECT lower(hex(randomblob(16))), id, 'own_blog' FROM events
  WHERE json_extract(prior_exposure, '$.ownBlog') = 1;

INSERT INTO event_exposures (id, event_id, channel)
  SELECT lower(hex(randomblob(16))), id, 'own_social' FROM events
  WHERE json_extract(prior_exposure, '$.igPosted') = 1;

INSERT INTO event_exposures (id, event_id, channel, detail)
  SELECT lower(hex(randomblob(16))), events.id, 'publication', earlier.value
  FROM events, json_each(events.prior_exposure, '$.priorPubs') AS earlier
  WHERE trim(earlier.value) != '';

ALTER TABLE events DROP COLUMN prior_exposure;

-- The outlet's matching facts (coverage, content types, exclusivity, prior
-- exposure rules, freshness, frequency, fees, reach), projected from the
-- approved research with her corrections applied, like the other columns.
-- NULL until research is approved: the matcher then treats every fact as
-- unknown.
ALTER TABLE publications ADD COLUMN match_json TEXT;
