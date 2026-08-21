-- Terminal fulfillment never remains sellable. These checks complement the
-- domain transition matrix and also protect direct SQLite maintenance.
CREATE TRIGGER IF NOT EXISTS occurrences_terminal_sales_before_insert
BEFORE INSERT ON occurrences
WHEN NEW.fulfillment_status <> 'SCHEDULED' AND NEW.sales_status <> 'CLOSED'
BEGIN
  SELECT RAISE(ABORT, 'OCCURRENCE_TERMINAL_SALES_MUST_BE_CLOSED');
END;

CREATE TRIGGER IF NOT EXISTS occurrences_terminal_sales_before_update
BEFORE UPDATE OF fulfillment_status, sales_status ON occurrences
WHEN NEW.fulfillment_status <> 'SCHEDULED' AND NEW.sales_status <> 'CLOSED'
BEGIN
  SELECT RAISE(ABORT, 'OCCURRENCE_TERMINAL_SALES_MUST_BE_CLOSED');
END;

-- Add the explicit self-service source without weakening the provenance check
-- on historical obligations. SQLite requires a table rebuild for CHECK edits.
ALTER TABLE refund_obligation_events RENAME TO refund_obligation_events_0011_legacy;
ALTER TABLE refund_obligations RENAME TO refund_obligations_0011_legacy;
CREATE TABLE refund_obligations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  initial_source TEXT NOT NULL CHECK (initial_source IN ('OCCURRENCE_CANCELLED', 'LATE_PAYMENT_AFTER_TERMINAL_OCCURRENCE', 'CUSTOMER_CANCELLATION_PARTIAL', 'LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION', 'LATE_PAYMENT_AFTER_RESERVATION_ABANDONMENT', 'CUSTOMER_SELF_SERVICE_REFUND')),
  target_refunded_amount_kopecks INTEGER NOT NULL CHECK (target_refunded_amount_kopecks >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FULFILLING', 'FULFILLED', 'REVIEW_REQUIRED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fulfilled_at TEXT
);
INSERT INTO refund_obligations(id, payment_id, initial_source, target_refunded_amount_kopecks, status, created_at, fulfilled_at)
  SELECT id, payment_id, initial_source, target_refunded_amount_kopecks, status, created_at, fulfilled_at
  FROM refund_obligations_0011_legacy;
CREATE TABLE refund_obligation_events (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES refund_obligations(id),
  source TEXT NOT NULL,
  provider_event_id TEXT,
  admin_action_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO refund_obligation_events(id, obligation_id, source, provider_event_id, admin_action_id, created_at)
  SELECT id, obligation_id, source, provider_event_id, admin_action_id, created_at
  FROM refund_obligation_events_0011_legacy;
DROP TABLE refund_obligation_events_0011_legacy;
DROP TABLE refund_obligations_0011_legacy;

ALTER TABLE orders ADD COLUMN public_order_number TEXT;
UPDATE orders
  SET public_order_number = 'FX-' || upper(hex(randomblob(10)))
  WHERE public_order_number IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_public_order_number_unique
  ON orders(public_order_number COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS admin_reauth_capabilities (
  id TEXT PRIMARY KEY,
  capability_hash TEXT NOT NULL UNIQUE,
  admin_session_id TEXT NOT NULL REFERENCES admin_sessions(id),
  admin_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('CANCEL_OCCURRENCE')),
  resource_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS admin_reauth_capabilities_lookup
  ON admin_reauth_capabilities(capability_hash, expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS customer_refund_confirmation_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT NOT NULL,
  token_nonce TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  invalidated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS customer_refund_confirmation_tokens_lookup
  ON customer_refund_confirmation_tokens(token_hash, expires_at, consumed_at, invalidated_at);
