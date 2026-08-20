PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cities (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS occurrences (
  id TEXT PRIMARY KEY,
  city_id TEXT NOT NULL REFERENCES cities(id),
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  price_kopecks INTEGER NOT NULL CHECK (price_kopecks >= 0),
  currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  sales_status TEXT NOT NULL DEFAULT 'OPEN' CHECK (sales_status IN ('OPEN', 'PAUSED', 'CLOSED')),
  visibility TEXT NOT NULL DEFAULT 'HIDDEN' CHECK (visibility IN ('HIDDEN', 'PUBLISHED')),
  fulfillment_status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (fulfillment_status IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')),
  completed_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  material_revision INTEGER NOT NULL DEFAULT 1 CHECK (material_revision >= 1),
  venue_status TEXT NOT NULL CHECK (venue_status IN ('CONFIRMED', 'TO_BE_ANNOUNCED')),
  venue_name TEXT,
  venue_address TEXT,
  venue_public INTEGER NOT NULL DEFAULT 0 CHECK (venue_public IN (0, 1)),
  venue_disclosure_text TEXT,
  venue_announce_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (venue_status = 'CONFIRMED' AND venue_name IS NOT NULL AND venue_address IS NOT NULL)
    OR (venue_status = 'TO_BE_ANNOUNCED' AND venue_disclosure_text IS NOT NULL AND venue_announce_by IS NOT NULL)
  ),
  CHECK (
    (fulfillment_status = 'SCHEDULED' AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (fulfillment_status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (fulfillment_status = 'CANCELLED' AND cancelled_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS occurrence_revisions (
  id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  revision INTEGER NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  changed_by_admin_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (occurrence_id, revision)
);

CREATE TABLE IF NOT EXISTS legal_releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  effective_at TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_legal_release ON legal_releases(active) WHERE active = 1;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  email TEXT NOT NULL,
  contractor_type TEXT NOT NULL CHECK (contractor_type IN ('SELF_EMPLOYED', 'INDIVIDUAL_ENTREPRENEUR')),
  inn TEXT NOT NULL,
  contract_reference TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  default_reward_type TEXT NOT NULL CHECK (default_reward_type IN ('PERCENT', 'FIXED')),
  default_reward_value INTEGER NOT NULL CHECK (default_reward_value >= 0),
  npd_status_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  code TEXT NOT NULL,
  normalized_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  discount_type TEXT NOT NULL DEFAULT 'NONE' CHECK (discount_type IN ('NONE', 'PERCENT', 'FIXED')),
  discount_value INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  material_revision INTEGER NOT NULL,
  legal_release_id TEXT NOT NULL REFERENCES legal_releases(id),
  promo_id TEXT REFERENCES promo_codes(id),
  attributed_agent_id TEXT REFERENCES agents(id),
  price_kopecks INTEGER NOT NULL,
  discount_kopecks INTEGER NOT NULL CHECK (discount_kopecks >= 0),
  final_amount_kopecks INTEGER NOT NULL CHECK (final_amount_kopecks >= 0),
  venue_disclosure TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  public_status_id TEXT NOT NULL UNIQUE,
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_email_hash TEXT NOT NULL,
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks >= 0),
  currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  occurrence_material_revision INTEGER NOT NULL,
  venue_disclosure_snapshot TEXT NOT NULL,
  checkout_legal_release_id TEXT NOT NULL REFERENCES legal_releases(id),
  legal_snapshot_json TEXT NOT NULL,
  eligibility_confirmed_at TEXT NOT NULL,
  attributed_agent_id TEXT REFERENCES agents(id),
  reward_type_snapshot TEXT CHECK (reward_type_snapshot IN ('PERCENT', 'FIXED')),
  reward_value_snapshot INTEGER,
  promo_code_snapshot TEXT,
  discount_type_snapshot TEXT CHECK (discount_type_snapshot IN ('NONE', 'PERCENT', 'FIXED')),
  discount_value_snapshot INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'CONFIRMED', 'CANCELLED')),
  cancelled_at TEXT,
  cancellation_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS bookings_occupancy ON bookings(occurrence_id, status);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  status TEXT NOT NULL CHECK (status IN ('VALID', 'VOID')),
  capability_hash TEXT NOT NULL UNIQUE,
  capability_ciphertext TEXT NOT NULL,
  capability_nonce TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_at TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  state TEXT NOT NULL CHECK (state IN ('CREATING', 'CREATED', 'CREATE_UNKNOWN', 'CREATE_FAILED')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RECONCILING', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED', 'CANCELLED', 'REVIEW_REQUIRED')),
  captured_amount_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (captured_amount_kopecks >= 0),
  provider_payment_id TEXT UNIQUE,
  payment_url TEXT,
  provider_idempotency_key TEXT NOT NULL UNIQUE,
  creation_started_at TEXT NOT NULL,
  provider_request_started_at TEXT,
  last_reconcile_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS checkout_idempotency (
  idempotency_key_hash TEXT PRIMARY KEY,
  canonical_request_hash TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS booking_cancellation_idempotency (
  idempotency_key_hash TEXT PRIMARY KEY,
  canonical_request_hash TEXT NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refund_obligations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  initial_source TEXT NOT NULL CHECK (initial_source IN ('OCCURRENCE_CANCELLED', 'LATE_PAYMENT_AFTER_TERMINAL_OCCURRENCE', 'CUSTOMER_CANCELLATION_PARTIAL', 'LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION')),
  target_refunded_amount_kopecks INTEGER NOT NULL CHECK (target_refunded_amount_kopecks >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FULFILLING', 'FULFILLED', 'REVIEW_REQUIRED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fulfilled_at TEXT
);

CREATE TABLE IF NOT EXISTS refund_obligation_events (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES refund_obligations(id),
  source TEXT NOT NULL,
  provider_event_id TEXT,
  admin_action_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  reason TEXT NOT NULL,
  note TEXT,
  source TEXT NOT NULL CHECK (source IN ('ADMIN_COMPENSATION', 'REFUND_OBLIGATION')),
  status TEXT NOT NULL CHECK (status IN ('REQUESTED', 'SUBMITTING', 'SUBMIT_UNKNOWN', 'RECONCILING', 'SUCCEEDED', 'FAILED', 'REVIEW_REQUIRED')),
  idempotency_key_hash TEXT NOT NULL UNIQUE,
  canonical_request_hash TEXT NOT NULL,
  provider_reference TEXT,
  provider_observed_total_refunded INTEGER,
  submission_started_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_reconcile_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  succeeded_at TEXT,
  failed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_nonterminal_refund_per_payment ON refunds(payment_id)
  WHERE status IN ('REQUESTED', 'SUBMITTING', 'SUBMIT_UNKNOWN', 'RECONCILING');

CREATE TABLE IF NOT EXISTS reward_settlements (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  method TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PREPARED', 'PENDING_DOCUMENT', 'SETTLED', 'CANCELLED_BEFORE_PAYMENT')),
  contractor_type_snapshot TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  payment_made_at TEXT,
  settled_at TEXT,
  cancelled_before_payment_at TEXT,
  npd_status_checked_at TEXT,
  npd_status_effective_on TEXT,
  document_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (document_confirmed IN (0, 1)),
  document_reference TEXT,
  document_confirmed_at TEXT,
  note TEXT,
  created_by_admin_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reward_settlement_idempotency (
  idempotency_key_hash TEXT PRIMARY KEY,
  canonical_request_hash TEXT NOT NULL,
  settlement_id TEXT NOT NULL UNIQUE REFERENCES reward_settlements(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settlement_recoveries (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  amount_recovered_kopecks INTEGER NOT NULL CHECK (amount_recovered_kopecks > 0),
  recovered_at TEXT NOT NULL,
  method TEXT NOT NULL,
  evidence_reference TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_email_hash TEXT NOT NULL,
  template TEXT NOT NULL,
  payload_ref TEXT,
  payload_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'BOUNCED', 'SEND_UNKNOWN', 'FAILED')),
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

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
