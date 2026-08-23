-- Preserve historical incidents while adding a dedicated fail-safe signal for
-- an immutable occurrence-update payload whose customer baseline cannot be
-- parsed. Such evidence must be reviewed, never silently coalesced away.
CREATE TABLE operational_incidents_rebuilt (
  id TEXT PRIMARY KEY,
  incident_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN (
    'REFUND_REQUIRES_REVIEW',
    'ORGANIZER_CHANGE_REFUND_MANUAL_REVIEW',
    'VENUE_ANNOUNCEMENT_OVERDUE',
    'OCCURRENCE_NOTIFICATION_PAYLOAD_CORRUPT'
  )),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('refund', 'order', 'occurrence')),
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

INSERT INTO operational_incidents_rebuilt(
  id, incident_key, kind, entity_type, entity_id, details_json,
  status, resolution_note, created_at, resolved_at
)
SELECT id, incident_key, kind, entity_type, entity_id, details_json,
  status, resolution_note, created_at, resolved_at
FROM operational_incidents;

DROP TABLE operational_incidents;
ALTER TABLE operational_incidents_rebuilt RENAME TO operational_incidents;

CREATE INDEX operational_incidents_open_idx
  ON operational_incidents(status, kind, created_at DESC);
