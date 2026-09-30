CREATE TABLE control_room_admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX control_room_sessions_cleanup ON control_room_admin_sessions(expires_at, revoked_at);

CREATE TABLE control_room_login_rate_limits (
  rate_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  PRIMARY KEY(rate_key, window_start)
);

CREATE TABLE control_room_audit_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX control_room_audit_recent ON control_room_audit_log(created_at DESC);
