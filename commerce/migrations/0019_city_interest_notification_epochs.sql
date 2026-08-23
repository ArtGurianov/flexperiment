-- A new explicit consent may follow a terminal unsuccessful notification.
-- Keep the prior outbox relation as immutable history while allowing exactly
-- one current intent for the renewed city-interest request.
ALTER TABLE city_interest_notification_intents
  RENAME TO city_interest_notification_intents_0019_legacy;

CREATE TABLE city_interest_notification_intents (
  id TEXT PRIMARY KEY,
  city_interest_request_id TEXT NOT NULL REFERENCES city_interest_requests(id) ON DELETE CASCADE,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES email_outbox(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  superseded_at TEXT
);

INSERT INTO city_interest_notification_intents(
  id, city_interest_request_id, outbox_id, created_at
)
SELECT outbox_id, city_interest_request_id, outbox_id, created_at
  FROM city_interest_notification_intents_0019_legacy;

DROP TABLE city_interest_notification_intents_0019_legacy;

CREATE UNIQUE INDEX city_interest_notification_intents_active_request_unique
  ON city_interest_notification_intents(city_interest_request_id)
  WHERE superseded_at IS NULL;

CREATE INDEX city_interest_notification_intents_outbox_idx
  ON city_interest_notification_intents(outbox_id);
