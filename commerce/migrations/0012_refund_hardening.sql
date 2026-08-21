-- A queued confirmation mail can become obsolete when a later request rotates
-- the token. SKIPPED is terminal but deliberately distinct from provider
-- delivery failure. Rebuild both sides of the only dependent FK because SQLite
-- cannot extend a CHECK constraint in place.
ALTER TABLE email_provider_events RENAME TO email_provider_events_0012_legacy;
ALTER TABLE email_outbox RENAME TO email_outbox_0012_legacy;

CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_email_hash TEXT NOT NULL,
  template TEXT NOT NULL,
  payload_ref TEXT,
  payload_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'BOUNCED', 'SEND_UNKNOWN', 'FAILED', 'SKIPPED')),
  provider_idempotence_key TEXT NOT NULL UNIQUE,
  job_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  send_started_at TEXT,
  provider_request_started_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  delivered_at TEXT,
  bounced_at TEXT
);
INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_ref, payload_snapshot, status, provider_idempotence_key, job_id, lease_owner, lease_expires_at, send_started_at, provider_request_started_at, attempts, last_error, created_at, sent_at, delivered_at, bounced_at)
  SELECT id, type, recipient_email, recipient_email_hash, template, payload_ref, payload_snapshot, status, provider_idempotence_key, job_id, lease_owner, lease_expires_at, send_started_at, provider_request_started_at, attempts, last_error, created_at, sent_at, delivered_at, bounced_at
  FROM email_outbox_0012_legacy;

CREATE TABLE email_provider_events (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES email_outbox(id),
  semantic_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED')),
  job_id TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO email_provider_events(id, outbox_id, semantic_key, status, job_id, received_at)
  SELECT id, outbox_id, semantic_key, status, job_id, received_at
  FROM email_provider_events_0012_legacy;
DROP TABLE email_provider_events_0012_legacy;
DROP TABLE email_outbox_0012_legacy;

-- `public_order_number` is a public reference, so application code is not its
-- only authority. Historical rows were backfilled in 0011; future direct SQL
-- cannot insert a missing number, erase it, or rewrite it.
CREATE TRIGGER IF NOT EXISTS orders_public_order_number_required_before_insert
BEFORE INSERT ON orders
WHEN NEW.public_order_number IS NULL OR trim(NEW.public_order_number) = ''
BEGIN
  SELECT RAISE(ABORT, 'PUBLIC_ORDER_NUMBER_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS orders_public_order_number_immutable_before_update
BEFORE UPDATE OF public_order_number ON orders
WHEN NEW.public_order_number IS NULL
  OR trim(NEW.public_order_number) = ''
  OR NEW.public_order_number <> OLD.public_order_number
BEGIN
  SELECT RAISE(ABORT, 'PUBLIC_ORDER_NUMBER_IMMUTABLE');
END;
