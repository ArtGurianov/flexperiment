CREATE TABLE playback_access_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT,
  lesson_ref TEXT,
  video_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'GRANT_ALLOWED',
    'GRANT_DENIED',
    'GRANT_RATE_LIMITED',
    'DRM_ALLOWED',
    'DRM_DENIED',
    'DRM_TOKEN_INVALID'
  )),
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX playback_access_events_time ON playback_access_events(occurred_at DESC);
CREATE INDEX playback_access_events_customer_time ON playback_access_events(customer_id, occurred_at DESC);
