-- Promo Codes v0 adds immutable commercial evidence only. Existing rows stay
-- nullable; no current mutable promo/agent row is ever used to backfill them.
ALTER TABLE quotes ADD COLUMN promo_agent_id_snapshot TEXT REFERENCES agents(id);
ALTER TABLE orders ADD COLUMN promo_id_snapshot TEXT REFERENCES promo_codes(id);
ALTER TABLE orders ADD COLUMN promo_agent_id_snapshot TEXT REFERENCES agents(id);
ALTER TABLE orders ADD COLUMN price_kopecks_snapshot INTEGER;
ALTER TABLE orders ADD COLUMN discount_kopecks_snapshot INTEGER;
ALTER TABLE admin_command_idempotency ADD COLUMN response_json TEXT;

CREATE TABLE release_certification_allowlist (
  lease_id TEXT PRIMARY KEY,
  owner_release_id TEXT NOT NULL,
  candidate_generation INTEGER NOT NULL,
  expected_source_commit TEXT NOT NULL,
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  promo_id TEXT NOT NULL REFERENCES promo_codes(id),
  expected_idempotency_key_hash TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','CONSUMED','EXPIRED','REVOKED')),
  consumed_at TEXT,
  consumed_order_id TEXT REFERENCES orders(id),
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX one_active_certification_lease
  ON release_certification_allowlist(status) WHERE status = 'ACTIVE';
