-- ART-174 / PR #177: a proven terminal refusal and deletion of its sealed receipt contact are one
-- statement, not two commits. REVIEW_REQUIRED alone is not terminal: uncertainty and fact mismatches
-- retain their envelope. These guards coexist with 0019's frozen and one-way-purge guards.

-- Repair the precise crash-gap shape left by 0019, without changing financial facts or other reviews.
UPDATE refund_executions
SET request_envelope = NULL,
    envelope_purged_at = COALESCE(envelope_purged_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE state = 'REVIEW_REQUIRED'
  AND last_error_code IN ('REFUND_DECLINED', 'REFUND_REJECTED', 'REFUND_UNAVAILABLE')
  AND request_envelope IS NOT NULL;

CREATE TRIGGER refund_execution_terminal_refusal_purged_insert
BEFORE INSERT ON refund_executions
WHEN NEW.state = 'REVIEW_REQUIRED'
  AND NEW.last_error_code IN ('REFUND_DECLINED', 'REFUND_REJECTED', 'REFUND_UNAVAILABLE')
  AND NEW.request_envelope IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'REFUND_TERMINAL_REFUSAL_REQUIRES_PURGE');
END;

CREATE TRIGGER refund_execution_terminal_refusal_purged_update
BEFORE UPDATE ON refund_executions
WHEN NEW.state = 'REVIEW_REQUIRED'
  AND NEW.last_error_code IN ('REFUND_DECLINED', 'REFUND_REJECTED', 'REFUND_UNAVAILABLE')
  AND NEW.request_envelope IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'REFUND_TERMINAL_REFUSAL_REQUIRES_PURGE');
END;
