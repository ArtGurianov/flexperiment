-- A received provider rejection and a lost transport response have different
-- recovery semantics. Keep the former auditable without retaining request PII,
-- and persist the retry schedule for the latter across worker restarts.
ALTER TABLE email_outbox ADD COLUMN provider_error_code TEXT;
ALTER TABLE email_outbox ADD COLUMN provider_error_message TEXT;
ALTER TABLE email_outbox ADD COLUMN next_attempt_at TEXT;

CREATE INDEX email_outbox_send_unknown_due_idx
  ON email_outbox(next_attempt_at, created_at)
  WHERE status = 'SEND_UNKNOWN';
