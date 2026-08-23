-- A city-interest request remains the source of authority until Unisender
-- evidences delivery. Keep the relation separate from the general-purpose
-- outbox so historical outbox rows remain compatible and no PII is copied.
CREATE TABLE city_interest_notification_intents (
  city_interest_request_id TEXT PRIMARY KEY REFERENCES city_interest_requests(id) ON DELETE CASCADE,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES email_outbox(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX city_interest_notification_intents_outbox_idx
  ON city_interest_notification_intents(outbox_id);

-- `email_outbox.status` remains the cross-provider aggregate. Preserve the
-- exact Unisender outcome independently so soft/hard bounces and spam do not
-- become indistinguishable business evidence.
ALTER TABLE email_provider_events ADD COLUMN provider_status TEXT;
