-- A terminal delivery failure can be followed only by a new explicit consent
-- epoch. Retain the failed request row as a redacted audit anchor so its
-- superseded intent/outbox/provider evidence remains referentially intact.
ALTER TABLE city_interest_notification_intents
  RENAME TO city_interest_notification_intents_0021_legacy;

ALTER TABLE city_interest_requests
  RENAME TO city_interest_requests_0021_legacy;

CREATE TABLE city_interest_requests (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  city_slug TEXT NOT NULL,
  privacy_policy_version TEXT NOT NULL,
  privacy_policy_sha256 TEXT NOT NULL,
  pd_consent_version TEXT NOT NULL,
  pd_consent_sha256 TEXT NOT NULL,
  consent_accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  superseded_at TEXT,
  superseded_by_request_id TEXT REFERENCES city_interest_requests(id) DEFERRABLE INITIALLY DEFERRED
);

INSERT INTO city_interest_requests(
  id, email_normalized, email_hash, city_slug,
  privacy_policy_version, privacy_policy_sha256,
  pd_consent_version, pd_consent_sha256, consent_accepted_at, created_at,
  expires_at, superseded_at, superseded_by_request_id
)
SELECT id, email_normalized, email_hash, city_slug,
  privacy_policy_version, privacy_policy_sha256,
  pd_consent_version, pd_consent_sha256, consent_accepted_at, created_at,
  expires_at, NULL, NULL
  FROM city_interest_requests_0021_legacy;

CREATE TABLE city_interest_notification_intents (
  id TEXT PRIMARY KEY,
  city_interest_request_id TEXT NOT NULL REFERENCES city_interest_requests(id) ON DELETE CASCADE,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES email_outbox(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  superseded_at TEXT
);

INSERT INTO city_interest_notification_intents(
  id, city_interest_request_id, outbox_id, created_at, superseded_at
)
SELECT id, city_interest_request_id, outbox_id, created_at, superseded_at
  FROM city_interest_notification_intents_0021_legacy;

DROP TABLE city_interest_notification_intents_0021_legacy;
DROP TABLE city_interest_requests_0021_legacy;

CREATE UNIQUE INDEX city_interest_requests_active_identity_unique
  ON city_interest_requests(email_hash, city_slug)
  WHERE superseded_at IS NULL;

CREATE INDEX city_interest_requests_city_created_at_idx
  ON city_interest_requests(city_slug, created_at);

CREATE INDEX city_interest_requests_expiry_idx
  ON city_interest_requests(expires_at);

CREATE UNIQUE INDEX city_interest_notification_intents_active_request_unique
  ON city_interest_notification_intents(city_interest_request_id)
  WHERE superseded_at IS NULL;

CREATE INDEX city_interest_notification_intents_outbox_idx
  ON city_interest_notification_intents(outbox_id);
