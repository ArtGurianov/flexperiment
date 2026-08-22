-- PREPARED is a durable allocation. Staleness creates operator-visible
-- evidence only; it never releases or rewrites the allocated reward amount.
CREATE TABLE IF NOT EXISTS settlement_prepared_reviews (
  settlement_id TEXT PRIMARY KEY REFERENCES reward_settlements(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  first_detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS reward_settlements_prepared_stale_idx
  ON reward_settlements(prepared_at)
  WHERE status = 'PREPARED';

-- Lifecycle mutations are separately idempotent from PREPARED creation. The
-- record preserves the authoritative result across a lost HTTP response.
CREATE TABLE IF NOT EXISTS reward_settlement_command_idempotency (
  command TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  canonical_request_hash TEXT NOT NULL,
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  recovery_id TEXT REFERENCES settlement_recoveries(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (command, idempotency_key_hash)
);
