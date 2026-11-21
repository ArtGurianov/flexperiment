-- FLEX-119: native payments, refunds and fiscal events
-- (docs/plans/2026-11-20-native-payment-refund-contract.md). New tables only: no existing table is
-- altered, and every earlier migration stays byte-identical. Sealed envelopes and contacts hold the
-- receipt e-mail; they are purged at a terminal state and never present on a terminal row.
-- Registered as 0039 (coordinator DDL registry). The lock requires contiguous numbering, so this branch
-- carries it as the next free number after main (0036); the coordinator assigns the final number at integration.

CREATE TABLE native_payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  payment_ref TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('CREATING', 'CREATE_UNKNOWN', 'PENDING', 'PAID', 'DECLINED', 'EXPIRED', 'REVIEW_REQUIRED')),
  provider_payment_id TEXT UNIQUE,
  payment_url TEXT,
  last_reason TEXT,
  request_envelope TEXT,
  envelope_key_id TEXT,
  envelope_purged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (request_envelope IS NULL OR envelope_key_id IS NOT NULL)
);
CREATE INDEX native_payments_open ON native_payments(state, updated_at);

CREATE TABLE native_payment_observations (
  id TEXT PRIMARY KEY,
  native_payment_id TEXT REFERENCES native_payments(id),
  native_refund_id TEXT REFERENCES native_refunds(id),
  source TEXT NOT NULL CHECK (source IN ('CREATE_RESPONSE', 'SUBMIT_RESPONSE', 'CALLBACK', 'READ_BACK')),
  observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
  decided_state TEXT NOT NULL,
  reason TEXT,
  observed_at TEXT NOT NULL,
  CHECK ((native_payment_id IS NULL) <> (native_refund_id IS NULL))
);
CREATE INDEX native_payment_observations_payment ON native_payment_observations(native_payment_id, observed_at);
CREATE INDEX native_payment_observations_refund ON native_payment_observations(native_refund_id, observed_at);

CREATE TABLE native_callback_inbox (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  signature_valid INTEGER NOT NULL CHECK (signature_valid IN (0, 1)),
  subject_kind TEXT CHECK (subject_kind IS NULL OR subject_kind IN ('PAYMENT', 'REFUND')),
  subject_ref TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(provider, provider_event_id)
);
CREATE INDEX native_callback_inbox_received ON native_callback_inbox(received_at);

CREATE TABLE native_refunds (
  id TEXT PRIMARY KEY,
  refund_request_id TEXT NOT NULL UNIQUE REFERENCES refund_requests(id),
  native_payment_id TEXT NOT NULL REFERENCES native_payments(id),
  refund_ref TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  state TEXT NOT NULL CHECK (state IN ('SUBMITTING', 'SUBMIT_UNKNOWN', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REVIEW_REQUIRED')),
  provider_refund_id TEXT UNIQUE,
  last_reason TEXT,
  request_envelope TEXT,
  envelope_key_id TEXT,
  envelope_purged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX native_refunds_open ON native_refunds(state, updated_at);

CREATE TABLE fiscal_events (
  id TEXT PRIMARY KEY,
  event_ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('PAYMENT_RECEIPT', 'REFUND_RECEIPT', 'FINAL_SETTLEMENT')),
  order_line_id TEXT NOT NULL REFERENCES order_lines(id),
  refund_request_id TEXT REFERENCES refund_requests(id),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('FULL_PAYMENT', 'FULL_PREPAYMENT')),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  items_json TEXT NOT NULL CHECK (json_valid(items_json)),
  mode TEXT NOT NULL CHECK (mode IN ('PROVIDER', 'MERCHANT')),
  state TEXT NOT NULL CHECK (state IN ('AWAITING_SERVICE', 'PENDING', 'SUBMITTING', 'SUBMIT_UNKNOWN', 'REGISTERED', 'REJECTED',
    'REVIEW_REQUIRED', 'NOT_REQUIRED', 'CANCELLED')),
  provider_receipt_id TEXT,
  last_reason TEXT,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  sealed_contact TEXT,
  contact_key_id TEXT,
  contact_purged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'REFUND_RECEIPT') = (refund_request_id IS NOT NULL))
);
CREATE INDEX fiscal_events_open ON fiscal_events(state, updated_at);
CREATE INDEX fiscal_events_line ON fiscal_events(order_line_id, kind);

-- Terminal rows never carry a sealed envelope/contact, and never leave their terminal state.
CREATE TRIGGER native_payment_terminal_sealed
BEFORE UPDATE ON native_payments
WHEN NEW.state IN ('PAID', 'DECLINED', 'EXPIRED') AND NEW.request_envelope IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'NATIVE_PAYMENT_TERMINAL_REQUIRES_PURGE');
END;

CREATE TRIGGER native_payment_terminal_final
BEFORE UPDATE OF state ON native_payments
WHEN OLD.state IN ('DECLINED', 'EXPIRED') AND NEW.state NOT IN (OLD.state, 'REVIEW_REQUIRED')
  OR OLD.state = 'PAID' AND NEW.state NOT IN ('PAID', 'REVIEW_REQUIRED')
BEGIN
  SELECT RAISE(ABORT, 'NATIVE_PAYMENT_TERMINAL_FINAL');
END;

CREATE TRIGGER native_refund_terminal_sealed
BEFORE UPDATE ON native_refunds
WHEN NEW.state IN ('SUCCEEDED', 'FAILED') AND NEW.request_envelope IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'NATIVE_REFUND_TERMINAL_REQUIRES_PURGE');
END;

CREATE TRIGGER native_refund_terminal_final
BEFORE UPDATE OF state ON native_refunds
WHEN OLD.state IN ('SUCCEEDED', 'FAILED') AND NEW.state NOT IN (OLD.state, 'REVIEW_REQUIRED')
BEGIN
  SELECT RAISE(ABORT, 'NATIVE_REFUND_TERMINAL_FINAL');
END;

CREATE TRIGGER fiscal_event_terminal_sealed
BEFORE UPDATE ON fiscal_events
WHEN NEW.state IN ('REGISTERED', 'REJECTED', 'NOT_REQUIRED', 'CANCELLED') AND NEW.sealed_contact IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'FISCAL_EVENT_TERMINAL_REQUIRES_PURGE');
END;

CREATE TRIGGER fiscal_event_terminal_final
BEFORE UPDATE OF state ON fiscal_events
WHEN OLD.state IN ('REGISTERED', 'REJECTED', 'NOT_REQUIRED', 'CANCELLED') AND NEW.state NOT IN (OLD.state, 'REVIEW_REQUIRED')
BEGIN
  SELECT RAISE(ABORT, 'FISCAL_EVENT_TERMINAL_FINAL');
END;
