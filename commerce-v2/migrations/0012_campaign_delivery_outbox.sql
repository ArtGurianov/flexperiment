ALTER TABLE notification_campaigns ADD COLUMN kind TEXT NOT NULL DEFAULT 'NEW_LESSONS'
  CHECK (kind IN ('NEW_COURSE', 'NEW_LESSONS'));
ALTER TABLE notification_campaigns ADD COLUMN idempotency_key TEXT;
ALTER TABLE notification_campaigns ADD COLUMN request_hash TEXT;
ALTER TABLE notification_campaigns ADD COLUMN queued_at TEXT;
ALTER TABLE notification_campaigns ADD COLUMN completed_at TEXT;
ALTER TABLE notification_campaigns ADD COLUMN dispatch_lease_expires_at TEXT;

CREATE UNIQUE INDEX notification_campaign_idempotency
  ON notification_campaigns(idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE notification_campaign_recipients ADD COLUMN provider_idempotency_key TEXT;
ALTER TABLE notification_campaign_recipients ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (attempt_count >= 0);
CREATE UNIQUE INDEX notification_recipient_provider_idempotency
  ON notification_campaign_recipients(provider_idempotency_key)
  WHERE provider_idempotency_key IS NOT NULL;
