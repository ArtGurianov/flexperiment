-- ART-174 (Linear plan v2, F4): a refund execution is its frozen submission, and it succeeds only on
-- the accepted Refund it produced.
--
--   1. Every new execution carries its sealed submission envelope (refund-envelope.ts): the exact
--      Idempotency-Key and body sent to Refref, under a recorded key id, with the Refref payment and the
--      amount it refunds. Frozen once written: a replay sends exactly it, and nothing rebuilds it.
--   2. SUCCEEDED requires the canonical Refund Refref accepted for it (canonical_refund_id), read back and
--      matched to this payment and amount. A balance that moved is not a refund of this execution.
--   3. Rows from before this migration carry no envelope; they are left as they are, and the runtime sends
--      any still in flight to a person instead of rebuilding their request.

ALTER TABLE refund_executions ADD COLUMN refref_payment_id TEXT;
ALTER TABLE refund_executions ADD COLUMN amount_kopecks INTEGER;
ALTER TABLE refund_executions ADD COLUMN request_envelope TEXT;
ALTER TABLE refund_executions ADD COLUMN envelope_key_id TEXT;
ALTER TABLE refund_executions ADD COLUMN canonical_refund_id TEXT;

CREATE TRIGGER refund_execution_envelope_required
BEFORE INSERT ON refund_executions
WHEN NEW.request_envelope IS NULL OR NEW.envelope_key_id IS NULL OR NEW.refref_payment_id IS NULL
  OR NEW.amount_kopecks IS NULL OR NEW.amount_kopecks <= 0
BEGIN
  SELECT RAISE(ABORT, 'REFUND_ENVELOPE_REQUIRED');
END;

CREATE TRIGGER refund_execution_envelope_frozen
BEFORE UPDATE ON refund_executions
WHEN OLD.request_envelope IS NOT NULL AND (
  NEW.request_envelope IS NOT OLD.request_envelope OR NEW.envelope_key_id IS NOT OLD.envelope_key_id
  OR NEW.refref_payment_id IS NOT OLD.refref_payment_id OR NEW.amount_kopecks IS NOT OLD.amount_kopecks
  OR NEW.idempotency_key IS NOT OLD.idempotency_key)
BEGIN
  SELECT RAISE(ABORT, 'REFUND_ENVELOPE_FROZEN');
END;

CREATE TRIGGER refund_execution_success_is_accepted
BEFORE UPDATE OF state ON refund_executions
WHEN NEW.state = 'SUCCEEDED' AND OLD.state <> 'SUCCEEDED' AND NEW.canonical_refund_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'REFUND_SUCCESS_REQUIRES_ACCEPTED_REFUND');
END;

CREATE TRIGGER refund_execution_canonical_refund_frozen
BEFORE UPDATE OF canonical_refund_id ON refund_executions
WHEN OLD.canonical_refund_id IS NOT NULL AND NEW.canonical_refund_id IS NOT OLD.canonical_refund_id
BEGIN
  SELECT RAISE(ABORT, 'REFUND_CANONICAL_REFUND_FROZEN');
END;
