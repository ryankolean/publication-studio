-- Two-step confirmations for the Claude connector (SUMMIT-344; spec
-- docs/specs/claude-native.md section 6). A tool's first call stores exactly
-- what it would record and hands back a short code; only a second call with
-- that code, from the same person, for the same action and target, within
-- fifteen minutes, records it, once.
--
-- The code itself is never stored: id is its SHA-256. payload_json is what
-- gets recorded on redemption, so a second call cannot change it.
CREATE TABLE IF NOT EXISTS confirmations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_confirmations_user ON confirmations (user_id, action);
