-- CREATE_UNKNOWN is an ambiguous provider-create boundary. These fields make
-- its read-only recovery finite and restart-safe without ever reissuing POST.
ALTER TABLE payments ADD COLUMN create_unknown_lookup_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN create_unknown_next_lookup_at TEXT;

CREATE INDEX payments_create_unknown_lookup_due_idx
  ON payments(state, status, create_unknown_next_lookup_at)
  WHERE state = 'CREATE_UNKNOWN' AND status = 'PENDING' AND provider_payment_id IS NULL;
