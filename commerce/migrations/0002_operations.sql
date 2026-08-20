CREATE TABLE IF NOT EXISTS admin_command_idempotency (
  command TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  canonical_request_hash TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (command, idempotency_key_hash)
);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reward_adjustments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  amount_kopecks INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS provider_drift_reviews (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('PAYMENT', 'REFUND')),
  entity_id TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
