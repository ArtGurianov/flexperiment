ALTER TABLE orders ADD COLUMN fiscal_purpose_snapshot TEXT;
ALTER TABLE orders ADD COLUMN fiscal_item_name_snapshot TEXT;

CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('TOCHKA', 'UNISENDER_GO')),
  semantic_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('APPLIED', 'QUARANTINED', 'IGNORED')),
  entity_id TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, semantic_key)
);

CREATE TABLE IF NOT EXISTS email_provider_events (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES email_outbox(id),
  semantic_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED')),
  job_id TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
