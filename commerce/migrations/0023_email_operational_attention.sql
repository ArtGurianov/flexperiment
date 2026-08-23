-- Delivery facts are immutable evidence; operational acknowledgement records
-- that an operator has reviewed an actionable terminal/ambiguous outcome.
ALTER TABLE email_outbox ADD COLUMN ops_acknowledged_at TEXT;
ALTER TABLE email_outbox ADD COLUMN ops_acknowledged_reason TEXT;

CREATE INDEX email_outbox_operational_attention_idx
  ON email_outbox(created_at DESC)
  WHERE ops_acknowledged_at IS NULL
    AND status IN ('FAILED', 'BOUNCED', 'SEND_UNKNOWN');
