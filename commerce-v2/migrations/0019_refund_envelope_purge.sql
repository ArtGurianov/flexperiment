-- ART-174 (plan v2, F4, paid-production gate): the sealed refund envelope carries the customer's receipt
-- e-mail, and it is kept only while it can still be needed.
--
--   It is needed until the execution's local resolution is confirmed terminal: the matched accepted
--   Refund (SUCCEEDED), or a refusal Refref proved terminal (REVIEW_REQUIRED with REFUND_DECLINED,
--   REFUND_REJECTED or REFUND_UNAVAILABLE — Refref's REFUND_FAILED vocabulary). Then the sealed body is
--   deleted and envelope_purged_at records when; the non-personal frozen facts (key, payment, amount,
--   key id) stay. Anything uncertain keeps it: it is the only way to replay, and no timer removes it.
--   Once purged, nothing is sealed again.

ALTER TABLE refund_executions ADD COLUMN envelope_purged_at TEXT;

DROP TRIGGER refund_execution_envelope_frozen;
CREATE TRIGGER refund_execution_envelope_frozen
BEFORE UPDATE ON refund_executions
WHEN OLD.request_envelope IS NOT NULL AND (
  NEW.envelope_key_id IS NOT OLD.envelope_key_id OR NEW.refref_payment_id IS NOT OLD.refref_payment_id
  OR NEW.amount_kopecks IS NOT OLD.amount_kopecks OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR (NEW.request_envelope IS NOT OLD.request_envelope AND NOT (
        NEW.request_envelope IS NULL AND NEW.envelope_purged_at IS NOT NULL
        AND (NEW.state = 'SUCCEEDED'
             OR (NEW.state = 'REVIEW_REQUIRED' AND NEW.last_error_code IN ('REFUND_DECLINED', 'REFUND_REJECTED', 'REFUND_UNAVAILABLE')))))
  OR (NEW.envelope_purged_at IS NOT NULL AND NEW.request_envelope IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'REFUND_ENVELOPE_FROZEN');
END;

CREATE TRIGGER refund_execution_envelope_purged
BEFORE UPDATE ON refund_executions
WHEN OLD.envelope_purged_at IS NOT NULL AND (
  NEW.request_envelope IS NOT NULL OR NEW.envelope_purged_at IS NOT OLD.envelope_purged_at
  OR NEW.envelope_key_id IS NOT OLD.envelope_key_id OR NEW.refref_payment_id IS NOT OLD.refref_payment_id
  OR NEW.amount_kopecks IS NOT OLD.amount_kopecks OR NEW.idempotency_key IS NOT OLD.idempotency_key)
BEGIN
  SELECT RAISE(ABORT, 'REFUND_ENVELOPE_PURGED');
END;
