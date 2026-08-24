-- Unisender Event Dump is an asynchronous, read-only recovery source for
-- delivery callbacks which were accepted by the provider but lost in transit.
-- One durable row per outbox prevents duplicate dump creation across restarts
-- and competing workers. It contains no recipient or email payload.
CREATE TABLE unisender_event_dump_reconciliations (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES email_outbox(id),
  job_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING_CREATE', 'PENDING_DUMP', 'RETRY_WAIT', 'CONSUMED', 'NO_LONGER_NEEDED', 'EXHAUSTED')),
  dump_id TEXT,
  requested_at TEXT,
  next_attempt_at TEXT NOT NULL,
  create_attempts INTEGER NOT NULL DEFAULT 0,
  poll_attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((state = 'PENDING_DUMP') = (dump_id IS NOT NULL))
);

CREATE INDEX unisender_event_dump_reconciliations_due_idx
  ON unisender_event_dump_reconciliations(state, next_attempt_at, created_at);

CREATE INDEX unisender_event_dump_reconciliations_lease_idx
  ON unisender_event_dump_reconciliations(lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;
