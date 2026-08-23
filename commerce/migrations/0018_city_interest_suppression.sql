-- A city-interest request can be withdrawn or expire after a worker has
-- already started its provider call. Keep that suppression durable so a late
-- provider response cannot return the redacted outbox row to the ordinary
-- email lifecycle.
ALTER TABLE email_outbox ADD COLUMN suppressed_at TEXT;
