-- `provider_webhook_events` keeps the first immutable observation under the
-- provider semantic idempotency key. Later authenticated payload variants are
-- evidence, never a reason to overwrite that first event.
CREATE TABLE provider_webhook_event_conflicts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'TOCHKA'),
  semantic_key TEXT NOT NULL,
  original_event_id TEXT NOT NULL REFERENCES provider_webhook_events(id),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CONFLICT_QUARANTINED', 'CORRECTED_APPLIED')),
  entity_id TEXT,
  observed_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, semantic_key, payload_hash)
);

CREATE INDEX provider_webhook_event_conflicts_original_idx
  ON provider_webhook_event_conflicts(original_event_id, received_at);
