CREATE TABLE IF NOT EXISTS legal_release_publish_events (
  id TEXT PRIMARY KEY,
  legal_release_id TEXT NOT NULL REFERENCES legal_releases(id),
  release_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('PUBLISHED', 'REPLAY_VERIFIED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS legal_release_publish_events_release ON legal_release_publish_events(legal_release_id, created_at);
