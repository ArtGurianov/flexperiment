-- Keep one active consent request and one delivery intent per occurrence notification.
CREATE TABLE occurrence_notification_requests (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  privacy_policy_version TEXT NOT NULL,
  privacy_policy_sha256 TEXT NOT NULL,
  pd_consent_version TEXT NOT NULL,
  pd_consent_sha256 TEXT NOT NULL,
  consent_accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  superseded_at TEXT,
  superseded_by_request_id TEXT
    REFERENCES occurrence_notification_requests(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE occurrence_notification_intents (
  id TEXT PRIMARY KEY,
  notification_request_id TEXT NOT NULL
    REFERENCES occurrence_notification_requests(id) ON DELETE CASCADE,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES email_outbox(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  superseded_at TEXT
);

CREATE UNIQUE INDEX occurrence_notification_requests_active_identity_unique
  ON occurrence_notification_requests(email_hash, occurrence_id) WHERE superseded_at IS NULL;
CREATE INDEX occurrence_notification_requests_occurrence_idx
  ON occurrence_notification_requests(occurrence_id);
CREATE UNIQUE INDEX occurrence_notification_intents_active_request_unique
  ON occurrence_notification_intents(notification_request_id) WHERE superseded_at IS NULL;
CREATE INDEX occurrence_notification_intents_outbox_idx
  ON occurrence_notification_intents(outbox_id);
