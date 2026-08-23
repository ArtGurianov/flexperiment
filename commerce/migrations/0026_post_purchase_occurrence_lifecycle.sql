-- Post-purchase occurrence changes are durable facts. Historical revisions are
-- never backfilled into customer notifications or refund rights.
ALTER TABLE occurrences ADD COLUMN admin_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE email_outbox ADD COLUMN superseded_at TEXT;
ALTER TABLE email_outbox ADD COLUMN superseded_reason TEXT;

CREATE TABLE occurrence_change_refund_entitlements (
  id TEXT PRIMARY KEY,
  occurrence_revision_id TEXT NOT NULL REFERENCES occurrence_revisions(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  closed_reason TEXT,
  UNIQUE(occurrence_revision_id, booking_id)
);
CREATE INDEX occurrence_change_refund_entitlements_booking_open_idx
  ON occurrence_change_refund_entitlements(booking_id, status, created_at DESC);

CREATE TABLE occurrence_update_notifications (
  id TEXT PRIMARY KEY,
  occurrence_revision_id TEXT NOT NULL REFERENCES occurrence_revisions(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  outbox_id TEXT NOT NULL UNIQUE REFERENCES email_outbox(id),
  superseded_at TEXT,
  superseded_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(occurrence_revision_id, booking_id)
);
CREATE INDEX occurrence_update_notifications_booking_idx
  ON occurrence_update_notifications(booking_id, created_at DESC);

CREATE TABLE operational_incidents (
  id TEXT PRIMARY KEY,
  incident_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('REFUND_REQUIRES_REVIEW', 'ORGANIZER_CHANGE_REFUND_MANUAL_REVIEW', 'VENUE_ANNOUNCEMENT_OVERDUE')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('refund', 'order', 'occurrence')),
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
CREATE INDEX operational_incidents_open_idx
  ON operational_incidents(status, kind, created_at DESC);
