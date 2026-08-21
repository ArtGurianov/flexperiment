-- Signed cookies bind a browser-held proof to this durable, server-authoritative
-- session record. A revoked or missing row therefore cannot be replayed after
-- logout, including after a Commerce restart.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS admin_sessions_cleanup
  ON admin_sessions(expires_at, revoked_at);
