-- Separate delivery truth from worker workflow state.
--
-- `status = 'FAILED'` has been asserting something untrue. Three paths write it,
-- and they do not mean the same thing:
--
--   EmailProviderRejectedError        an HTTP response refused the send
--   UNISENDER_HTTP_REJECTED_LEGACY    the same, reclassified after the fact
--   SEND_UNKNOWN_ATTEMPT_LIMIT        reconciliation budget ran out
--
-- The third established nothing. It is not an observed failure; it is a question
-- that stopped being asked, and the provider may well have delivered the message.
-- Any resend keyed on `status = 'FAILED'` would therefore send a second copy of a
-- delivered message and record it as recovery from failure.
--
-- The fix is not to split `status` into more workflow states. `status` is
-- liveness - what the worker may still do with this row - and it is a perfectly
-- good answer to that question. What it must stop being is the authority on
-- whether the message reached anyone. That is a second axis and it gets its own
-- column.
--
--   status            FAILED     automatic processing has stopped
--   delivery_outcome  UNRESOLVED delivery truth is still unknown
--
-- ADD COLUMN is used deliberately. Extending the CHECK on `status` is impossible
-- in SQLite without rebuilding the table, and `email_outbox` now has eight
-- inbound foreign keys - renaming it rewrites every one of them to point at the
-- legacy table, so the rebuild would have to carry nine tables including consent
-- and PII tables with partial unique indexes. That is a large blast radius for a
-- migration whose whole purpose is honesty about a single fact.
--
-- No resend capability is introduced here. This migration only stops the
-- database from asserting something it cannot know.

ALTER TABLE email_outbox ADD COLUMN delivery_outcome TEXT
  CHECK (delivery_outcome IS NULL OR delivery_outcome IN ('KNOWN_FAILED', 'UNRESOLVED'));

-- Positive identification first, and only from values this codebase writes
-- itself. `provider_error_code` cannot serve here: it carries raw provider codes
-- (204, 1588, 903 in production today), an open set that grows without review.
-- `last_error` is ours and is deterministic.
UPDATE email_outbox
  SET delivery_outcome = 'KNOWN_FAILED'
  WHERE status = 'FAILED'
    AND last_error IN ('UNISENDER_HTTP_REJECTED', 'UNISENDER_HTTP_REJECTED_LEGACY');

-- Everything else that reached FAILED is unknown provenance, and unknown
-- provenance is unknown delivery. Fail closed: never KNOWN_FAILED by default,
-- because the only consequence of guessing KNOWN_FAILED is a duplicate send to a
-- real person, while the only consequence of guessing UNRESOLVED is that a
-- message stays un-resendable until someone establishes what happened.
UPDATE email_outbox
  SET delivery_outcome = 'UNRESOLVED'
  WHERE status = 'FAILED' AND delivery_outcome IS NULL;

CREATE INDEX email_outbox_delivery_outcome_idx
  ON email_outbox(delivery_outcome) WHERE delivery_outcome IS NOT NULL;
