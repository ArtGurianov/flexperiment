-- 0024 was already applied with a transitional CORRECTED_APPLIED status.
-- Copying into the final table deliberately fails transactionally if such a
-- historical row exists: evidence must be reviewed, never coerced or dropped.
CREATE TABLE provider_webhook_event_conflicts_rebuilt (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'TOCHKA'),
  semantic_key TEXT NOT NULL,
  original_event_id TEXT NOT NULL REFERENCES provider_webhook_events(id),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'CONFLICT_QUARANTINED'),
  entity_id TEXT,
  observed_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, semantic_key, payload_hash)
);

INSERT INTO provider_webhook_event_conflicts_rebuilt(
  id, provider, semantic_key, original_event_id, payload_hash, status,
  entity_id, observed_json, received_at
)
SELECT id, provider, semantic_key, original_event_id, payload_hash, status,
  entity_id, observed_json, received_at
FROM provider_webhook_event_conflicts;

DROP TABLE provider_webhook_event_conflicts;
ALTER TABLE provider_webhook_event_conflicts_rebuilt RENAME TO provider_webhook_event_conflicts;

CREATE INDEX provider_webhook_event_conflicts_original_idx
  ON provider_webhook_event_conflicts(original_event_id, received_at);
