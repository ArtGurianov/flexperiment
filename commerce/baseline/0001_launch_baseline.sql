-- The launch baseline: the whole schema, as one statement of what is true.
--
-- This replaces sixty-one migrations that recorded how the schema arrived
-- rather than what it is. It is deliberately lineage-incompatible with any
-- database built from them: `schema_identity` is what a runtime reads to tell a
-- supported database from a pre-launch one, and a pre-launch one fails closed
-- rather than being adapted. From 0002 onward the ledger is append-only again.
--
-- Nothing here may mean "this row predates a feature". Where a condition used
-- to say that, it was not translated - it was removed, and what remained was
-- restated as a rule about the data itself.
--
-- ---------------------------------------------------------------------------
-- The invariants this file inherits, and must keep stating
-- ---------------------------------------------------------------------------
--
-- Venue disclosure (was 0008). The public disclosure deadline is a catalog
-- invariant, not merely a form hint. The triggers also protect direct SQLite
-- maintenance from creating a TO_BE_ANNOUNCED occurrence whose promise is made
-- after the workshop starts.
--
-- Visibility (was 0010). A hidden occurrence is never sellable. Domain code
-- additionally enforces the allowed one-step lifecycle; these triggers protect
-- direct SQLite writes.
--
-- Fulfillment (was 0011). Terminal fulfillment never remains sellable. These
-- checks complement the domain transition matrix and also protect direct
-- SQLite maintenance.
--
-- Provider webhooks (was 0024, 0025). `provider_webhook_events` keeps the first
-- immutable observation under the provider semantic idempotency key. Later
-- authenticated payload variants are evidence, never a reason to overwrite that
-- first event, and a conflict fails closed: evidence must be reviewed, never
-- coerced or dropped.
--
-- Delivery outcome (was 0039). FAILED and `delivery_outcome NOT NULL` are the
-- same fact, in both directions. A message that failed says why, and a message
-- carrying a reason is failed.
--
-- Dispatch fence (was 0040). `outbox_authority` is an operator's durable stop
-- on outgoing mail, held by one owner and moved by compare-and-set. It is a
-- fence and nothing else: the authority selector it used to carry is gone,
-- because attempt records are the only dispatch authority now.
--
-- Attempt identity (was 0041). An attempt's identity and its computed send are
-- frozen once written, and at most one attempt per message is active. This is
-- what stops a retry, a crash or a concurrent worker from sending a second
-- copy of the same email, and it is the reason the message-level attempt
-- columns could be removed at all.
--
-- ---------------------------------------------------------------------------

CREATE TABLE cities (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE occurrences (
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
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, admin_revision INTEGER NOT NULL DEFAULT 1, admin_reserved_seats INTEGER NOT NULL DEFAULT 0
  CHECK (admin_reserved_seats >= 0),
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

CREATE TABLE occurrence_revisions (
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

CREATE TABLE legal_releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  effective_at TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX one_active_legal_release ON legal_releases(active) WHERE active = 1;

CREATE TABLE promo_codes (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES partners(id),
  code TEXT NOT NULL,
  normalized_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  discount_type TEXT NOT NULL DEFAULT 'NONE' CHECK (discount_type IN ('NONE', 'PERCENT', 'FIXED')),
  discount_value INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  material_revision INTEGER NOT NULL,
  legal_release_id TEXT NOT NULL REFERENCES legal_releases(id),
  promo_id TEXT REFERENCES promo_codes(id),
  attributed_agent_id TEXT REFERENCES partners(id),
  price_kopecks INTEGER NOT NULL,
  discount_kopecks INTEGER NOT NULL CHECK (discount_kopecks >= 0),
  final_amount_kopecks INTEGER NOT NULL CHECK (final_amount_kopecks >= 0),
  venue_disclosure TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, referral_slug TEXT, promo_code_snapshot TEXT, discount_type_snapshot TEXT CHECK (discount_type_snapshot IN ('NONE', 'PERCENT', 'FIXED')), discount_value_snapshot INTEGER, promo_agent_id_snapshot TEXT REFERENCES partners(id));

CREATE TABLE orders (
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
  attributed_agent_id TEXT REFERENCES partners(id),
  reward_type_snapshot TEXT CHECK (reward_type_snapshot IN ('PERCENT', 'FIXED')),
  reward_value_snapshot INTEGER,
  promo_code_snapshot TEXT,
  discount_type_snapshot TEXT CHECK (discount_type_snapshot IN ('NONE', 'PERCENT', 'FIXED')),
  discount_value_snapshot INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, fiscal_purpose_snapshot TEXT, fiscal_item_name_snapshot TEXT, public_offer_version TEXT, public_offer_sha256 TEXT, public_offer_accepted_at TEXT, privacy_policy_version TEXT, privacy_policy_sha256 TEXT, privacy_policy_presented_at TEXT, pd_consent_version TEXT, pd_consent_sha256 TEXT, pd_consent_accepted_at TEXT, checkout_disclosure_version TEXT, checkout_disclosure_sha256 TEXT, public_order_number TEXT, customer_adult_confirmed_at TEXT, customer_acceptance_ip TEXT, customer_acceptance_user_agent TEXT, participant_name TEXT, participant_date_of_birth TEXT, participant_age_at_occurrence INTEGER CHECK (participant_age_at_occurrence >= 0), participant_is_minor INTEGER CHECK (participant_is_minor IN (0, 1)), participant_requires_adult_accompaniment INTEGER CHECK (participant_requires_adult_accompaniment IN (0, 1)), participant_is_customer INTEGER CHECK (participant_is_customer IN (0, 1)), minor_legal_representative_confirmed_at TEXT, minor_legal_representative_confirmation_text TEXT, under_14_accompaniment_confirmed_at TEXT, under_14_accompaniment_confirmation_text TEXT, participant_age_band TEXT CHECK (participant_age_band IN ('ADULT', 'MINOR_14_17', 'MINOR_UNDER_14')), promo_id_snapshot TEXT REFERENCES promo_codes(id), promo_agent_id_snapshot TEXT REFERENCES partners(id), price_kopecks_snapshot INTEGER, discount_kopecks_snapshot INTEGER, explicit_promo_id TEXT REFERENCES promo_codes(id), resolved_partner_id TEXT REFERENCES partners(id), resolved_engagement_id TEXT REFERENCES engagements(id), resolved_engagement_revision_id TEXT REFERENCES engagement_revisions(id), resolved_promo_authorization_id TEXT REFERENCES engagement_promo_authorizations(id), attribution_rule_version INTEGER NOT NULL DEFAULT 1, resolution_reason TEXT NOT NULL CHECK (resolution_reason IN ('DIRECT', 'DISCOUNT_PROMO', 'EXPLICIT_PARTNER_PROMO')),
  certification_run_id TEXT REFERENCES certification_runs(run_id)
);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'CONFIRMED', 'CANCELLED')),
  cancelled_at TEXT,
  cancellation_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX bookings_occupancy ON bookings(occurrence_id, status);

CREATE TABLE tickets (
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

CREATE TABLE payments (
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
, create_unknown_lookup_attempts INTEGER NOT NULL DEFAULT 0, create_unknown_next_lookup_at TEXT, provider_error_class TEXT, provider_error_code TEXT);

CREATE TABLE checkout_idempotency (
  idempotency_key_hash TEXT PRIMARY KEY,
  canonical_request_hash TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE booking_cancellation_idempotency (
  idempotency_key_hash TEXT PRIMARY KEY,
  canonical_request_hash TEXT NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE refunds (
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

CREATE UNIQUE INDEX one_nonterminal_refund_per_payment ON refunds(payment_id)
  WHERE status IN ('REQUESTED', 'SUBMITTING', 'SUBMIT_UNKNOWN', 'RECONCILING');

CREATE TABLE reward_settlements (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES partners(id),
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
, engagement_id TEXT REFERENCES engagements(id), engagement_revision_id TEXT REFERENCES engagement_revisions(id), base_registry_snapshot_id TEXT REFERENCES engagement_reward_registry_snapshot(id), reward_registry_hash TEXT, effective_reward_snapshot_id TEXT REFERENCES engagement_effective_reward_snapshots(id), partner_identity_id TEXT REFERENCES partner_identities(id), payout_profile_revision_id TEXT REFERENCES payout_profile_revisions(id), tax_mode_snapshot TEXT CHECK (tax_mode_snapshot IS NULL OR tax_mode_snapshot IN ('NPD', 'OTHER')), legal_profile_revision_id_snapshot TEXT REFERENCES agent_referrals_legal_profile_revisions(id), supersedes_settlement_id TEXT REFERENCES reward_settlements(id), cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION'), tax_treatment_revision_id_snapshot TEXT REFERENCES agent_referrals_tax_treatment_revisions(id), tax_canonicalization_version TEXT, tax_canonical_json TEXT, tax_canonical_hash TEXT);

CREATE TABLE settlement_recoveries (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  amount_recovered_kopecks INTEGER NOT NULL CHECK (amount_recovered_kopecks > 0),
  recovered_at TEXT NOT NULL,
  method TEXT NOT NULL,
  evidence_reference TEXT NOT NULL,
  note TEXT
);

CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE admin_command_idempotency (
  command TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  canonical_request_hash TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, response_json TEXT,
  PRIMARY KEY (command, idempotency_key_hash)
);

CREATE TABLE referral_rewards (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  agent_id TEXT NOT NULL REFERENCES partners(id),
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE provider_drift_reviews (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('PAYMENT', 'REFUND')),
  entity_id TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE TABLE provider_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('TOCHKA', 'UNISENDER_GO')),
  semantic_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('APPLIED', 'QUARANTINED', 'IGNORED')),
  entity_id TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, observed_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(provider, semantic_key)
);

CREATE TABLE legal_release_publish_events (
  id TEXT PRIMARY KEY,
  legal_release_id TEXT NOT NULL REFERENCES legal_releases(id),
  release_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('PUBLISHED', 'REPLAY_VERIFIED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX legal_release_publish_events_release ON legal_release_publish_events(legal_release_id, created_at);

CREATE TABLE reservation_abandonments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  admin_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ABANDONED', 'LATE_PAYMENT_REVIEW_REQUIRED', 'LATE_PAYMENT_REFUNDED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE TRIGGER occurrences_venue_announce_before_insert
BEFORE INSERT ON occurrences
WHEN NEW.venue_status = 'TO_BE_ANNOUNCED'
  AND NEW.venue_announce_by IS NOT NULL
  AND julianday(NEW.venue_announce_by) >= julianday(NEW.starts_at)
BEGIN
  SELECT RAISE(ABORT, 'VENUE_ANNOUNCEMENT_TOO_LATE');
END;

CREATE TRIGGER occurrences_venue_announce_before_update
BEFORE UPDATE OF venue_status, venue_announce_by, starts_at ON occurrences
WHEN NEW.venue_status = 'TO_BE_ANNOUNCED'
  AND NEW.venue_announce_by IS NOT NULL
  AND julianday(NEW.venue_announce_by) >= julianday(NEW.starts_at)
BEGIN
  SELECT RAISE(ABORT, 'VENUE_ANNOUNCEMENT_TOO_LATE');
END;

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX admin_sessions_cleanup
  ON admin_sessions(expires_at, revoked_at);

CREATE TRIGGER occurrences_visibility_sales_before_insert
BEFORE INSERT ON occurrences
WHEN NEW.visibility = 'HIDDEN' AND NEW.sales_status <> 'CLOSED'
BEGIN
  SELECT RAISE(ABORT, 'OCCURRENCE_HIDDEN_SALES_MUST_BE_CLOSED');
END;

CREATE TRIGGER occurrences_visibility_sales_before_update
BEFORE UPDATE OF visibility, sales_status ON occurrences
WHEN NEW.visibility = 'HIDDEN' AND NEW.sales_status <> 'CLOSED'
BEGIN
  SELECT RAISE(ABORT, 'OCCURRENCE_HIDDEN_SALES_MUST_BE_CLOSED');
END;

CREATE TRIGGER occurrences_terminal_sales_before_insert
BEFORE INSERT ON occurrences
WHEN NEW.fulfillment_status <> 'SCHEDULED' AND NEW.sales_status <> 'CLOSED'
BEGIN
  SELECT RAISE(ABORT, 'OCCURRENCE_TERMINAL_SALES_MUST_BE_CLOSED');
END;

CREATE TRIGGER occurrences_terminal_sales_before_update
BEFORE UPDATE OF fulfillment_status, sales_status ON occurrences
WHEN NEW.fulfillment_status <> 'SCHEDULED' AND NEW.sales_status <> 'CLOSED'
BEGIN
  SELECT RAISE(ABORT, 'OCCURRENCE_TERMINAL_SALES_MUST_BE_CLOSED');
END;

CREATE TABLE refund_obligations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  initial_source TEXT NOT NULL CHECK (initial_source IN ('OCCURRENCE_CANCELLED', 'LATE_PAYMENT_AFTER_TERMINAL_OCCURRENCE', 'CUSTOMER_CANCELLATION_PARTIAL', 'LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION', 'LATE_PAYMENT_AFTER_RESERVATION_ABANDONMENT', 'CUSTOMER_SELF_SERVICE_REFUND')),
  target_refunded_amount_kopecks INTEGER NOT NULL CHECK (target_refunded_amount_kopecks >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FULFILLING', 'FULFILLED', 'REVIEW_REQUIRED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fulfilled_at TEXT
);

CREATE TABLE refund_obligation_events (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES refund_obligations(id),
  source TEXT NOT NULL,
  provider_event_id TEXT,
  admin_action_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX orders_public_order_number_unique
  ON orders(public_order_number COLLATE NOCASE);

CREATE TABLE admin_reauth_capabilities (
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

CREATE INDEX admin_reauth_capabilities_lookup
  ON admin_reauth_capabilities(capability_hash, expires_at, consumed_at);

CREATE TABLE customer_refund_confirmation_tokens (
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

CREATE INDEX customer_refund_confirmation_tokens_lookup
  ON customer_refund_confirmation_tokens(token_hash, expires_at, consumed_at, invalidated_at);

CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_email_hash TEXT NOT NULL,
  template TEXT NOT NULL,
  payload_ref TEXT,
  payload_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'BOUNCED', 'SEND_UNKNOWN', 'FAILED', 'SKIPPED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  delivered_at TEXT,
  bounced_at TEXT
, suppressed_at TEXT, ops_acknowledged_at TEXT, ops_acknowledged_reason TEXT, superseded_at TEXT, superseded_reason TEXT, delivery_outcome TEXT
  CHECK (delivery_outcome IS NULL OR delivery_outcome IN ('KNOWN_FAILED', 'UNRESOLVED')));

CREATE TABLE email_provider_events (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES email_outbox(id),
  semantic_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED')),
  job_id TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, provider_status TEXT);

CREATE TRIGGER orders_public_order_number_required_before_insert
BEFORE INSERT ON orders
WHEN NEW.public_order_number IS NULL OR trim(NEW.public_order_number) = ''
BEGIN
  SELECT RAISE(ABORT, 'PUBLIC_ORDER_NUMBER_REQUIRED');
END;

CREATE TRIGGER orders_public_order_number_immutable_before_update
BEFORE UPDATE OF public_order_number ON orders
WHEN NEW.public_order_number IS NULL
  OR trim(NEW.public_order_number) = ''
  OR NEW.public_order_number <> OLD.public_order_number
BEGIN
  SELECT RAISE(ABORT, 'PUBLIC_ORDER_NUMBER_IMMUTABLE');
END;

CREATE INDEX reward_settlements_prepared_stale_idx
  ON reward_settlements(prepared_at)
  WHERE status = 'PREPARED';

CREATE TABLE reward_settlement_command_idempotency (
  command TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  canonical_request_hash TEXT NOT NULL,
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  recovery_id TEXT REFERENCES settlement_recoveries(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (command, idempotency_key_hash)
);

CREATE TABLE city_interest_requests (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  city_slug TEXT NOT NULL,
  privacy_policy_version TEXT NOT NULL,
  privacy_policy_sha256 TEXT NOT NULL,
  pd_consent_version TEXT NOT NULL,
  pd_consent_sha256 TEXT NOT NULL,
  consent_accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  superseded_at TEXT,
  superseded_by_request_id TEXT REFERENCES city_interest_requests(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE city_interest_notification_intents (
  id TEXT PRIMARY KEY,
  city_interest_request_id TEXT NOT NULL REFERENCES city_interest_requests(id) ON DELETE CASCADE,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES email_outbox(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  superseded_at TEXT
);

CREATE UNIQUE INDEX city_interest_requests_active_identity_unique
  ON city_interest_requests(email_hash, city_slug)
  WHERE superseded_at IS NULL;

CREATE INDEX city_interest_requests_city_created_at_idx
  ON city_interest_requests(city_slug, created_at);

CREATE INDEX city_interest_requests_expiry_idx
  ON city_interest_requests(expires_at);

CREATE UNIQUE INDEX city_interest_notification_intents_active_request_unique
  ON city_interest_notification_intents(city_interest_request_id)
  WHERE superseded_at IS NULL;

CREATE INDEX city_interest_notification_intents_outbox_idx
  ON city_interest_notification_intents(outbox_id);

CREATE INDEX payments_create_unknown_lookup_due_idx
  ON payments(state, status, create_unknown_next_lookup_at)
  WHERE state = 'CREATE_UNKNOWN' AND status = 'PENDING' AND provider_payment_id IS NULL;

CREATE INDEX email_outbox_operational_attention_idx
  ON email_outbox(created_at DESC)
  WHERE ops_acknowledged_at IS NULL
    AND status IN ('FAILED', 'BOUNCED', 'SEND_UNKNOWN');

CREATE TABLE "provider_webhook_event_conflicts" (
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

CREATE INDEX provider_webhook_event_conflicts_original_idx
  ON provider_webhook_event_conflicts(original_event_id, received_at);

CREATE TABLE occurrence_change_refund_entitlements (
  id TEXT PRIMARY KEY,
  occurrence_revision_id TEXT NOT NULL REFERENCES occurrence_revisions(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  closed_reason TEXT,
  UNIQUE(occurrence_revision_id, booking_id)
);

CREATE INDEX occurrence_change_refund_entitlements_booking_open_idx
  ON occurrence_change_refund_entitlements(booking_id, status, created_at DESC);

CREATE TABLE occurrence_update_notifications (
  id TEXT PRIMARY KEY,
  occurrence_revision_id TEXT NOT NULL REFERENCES occurrence_revisions(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  outbox_id TEXT NOT NULL UNIQUE REFERENCES email_outbox(id),
  superseded_at TEXT,
  superseded_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(occurrence_revision_id, booking_id)
);

CREATE INDEX occurrence_update_notifications_booking_idx
  ON occurrence_update_notifications(booking_id, created_at DESC);

CREATE TABLE "operational_incidents" (
  id TEXT PRIMARY KEY,
  incident_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN (
    'REFUND_REQUIRES_REVIEW',
    'ORGANIZER_CHANGE_REFUND_MANUAL_REVIEW',
    'VENUE_ANNOUNCEMENT_OVERDUE',
    'OCCURRENCE_NOTIFICATION_PAYLOAD_CORRUPT'
  )),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('refund', 'order', 'occurrence')),
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE INDEX operational_incidents_open_idx
  ON operational_incidents(status, kind, created_at DESC);

CREATE TABLE unisender_event_dump_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  create_lease_owner TEXT,
  create_lease_expires_at TEXT
, next_create_probe_at TEXT, create_probe_failures INTEGER NOT NULL DEFAULT 0, last_create_probe_error TEXT);

CREATE TABLE unisender_event_dump_create_attempts (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL
);

CREATE INDEX unisender_event_dump_create_attempts_window_idx
  ON unisender_event_dump_create_attempts(started_at);

CREATE TABLE unisender_event_dump_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('CREATE_IN_FLIGHT', 'POLL_READY', 'POLL_RETRY', 'CREATE_UNKNOWN', 'CONSUMED', 'EXHAUSTED')),
  dump_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  create_started_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  poll_attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, requested_limit INTEGER NOT NULL DEFAULT 100000, job_id_filter TEXT,
  CHECK ((state IN ('POLL_READY', 'POLL_RETRY')) = (dump_id IS NOT NULL))
);

CREATE INDEX unisender_event_dump_runs_due_idx
  ON unisender_event_dump_runs(state, next_attempt_at, created_at);

CREATE TABLE unisender_event_dump_targets (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES unisender_event_dump_runs(id),
  outbox_id TEXT NOT NULL REFERENCES email_outbox(id),
  job_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'CONSUMED', 'RETRY_WAIT', 'NO_LONGER_NEEDED')),
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, recovery_mode TEXT NOT NULL DEFAULT 'BATCH'
  CHECK (recovery_mode IN ('BATCH', 'TARGETED_JOB')));

CREATE UNIQUE INDEX unisender_event_dump_targets_active_outbox_unique
  ON unisender_event_dump_targets(outbox_id) WHERE state = 'ACTIVE';

CREATE INDEX unisender_event_dump_targets_candidate_idx
  ON unisender_event_dump_targets(outbox_id, state, next_attempt_at);

CREATE TABLE emergency_sales_gate (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  sales_paused INTEGER NOT NULL DEFAULT 0 CHECK (sales_paused IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  paused_at TEXT,
  paused_reason TEXT,
  paused_by_admin_id TEXT,
  reopened_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE emergency_sales_gate_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('PAUSED', 'REOPENED')),
  admin_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX emergency_sales_gate_events_created_idx ON emergency_sales_gate_events(created_at);

CREATE TABLE occurrence_notification_requests (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  privacy_policy_version TEXT NOT NULL,
  privacy_policy_sha256 TEXT NOT NULL,
  pd_consent_version TEXT NOT NULL,
  pd_consent_sha256 TEXT NOT NULL,
  consent_accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  superseded_at TEXT,
  superseded_by_request_id TEXT
    REFERENCES occurrence_notification_requests(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE occurrence_notification_intents (
  id TEXT PRIMARY KEY,
  notification_request_id TEXT NOT NULL
    REFERENCES occurrence_notification_requests(id) ON DELETE CASCADE,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES email_outbox(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  superseded_at TEXT
);

CREATE UNIQUE INDEX occurrence_notification_requests_active_identity_unique
  ON occurrence_notification_requests(email_hash, occurrence_id) WHERE superseded_at IS NULL;

CREATE INDEX occurrence_notification_requests_occurrence_idx
  ON occurrence_notification_requests(occurrence_id);

CREATE UNIQUE INDEX occurrence_notification_intents_active_request_unique
  ON occurrence_notification_intents(notification_request_id) WHERE superseded_at IS NULL;

CREATE INDEX occurrence_notification_intents_outbox_idx
  ON occurrence_notification_intents(outbox_id);

CREATE TRIGGER email_outbox_delivery_outcome_insert_guard
BEFORE INSERT ON email_outbox
WHEN (NEW.status = 'FAILED' AND NEW.delivery_outcome IS NULL)
  OR (NEW.status <> 'FAILED' AND NEW.delivery_outcome IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'EMAIL_OUTBOX_DELIVERY_OUTCOME_INVARIANT');
END;

CREATE TRIGGER email_outbox_delivery_outcome_update_guard
BEFORE UPDATE ON email_outbox
WHEN (NEW.status = 'FAILED' AND NEW.delivery_outcome IS NULL)
  OR (NEW.status <> 'FAILED' AND NEW.delivery_outcome IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'EMAIL_OUTBOX_DELIVERY_OUTCOME_INVARIANT');
END;

CREATE INDEX email_outbox_delivery_outcome_idx
  ON email_outbox(delivery_outcome) WHERE delivery_outcome IS NOT NULL;

CREATE TABLE outbox_attempt (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES email_outbox(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),

  -- Opaque and persisted, never derived. Stable within an attempt - which is
  -- what makes an ambiguous replay safe - and distinct across attempts, which
  -- is what makes a resend reach the provider at all. Attempt #1 carries the
  -- message's existing key byte-for-byte so today's replay protection is
  -- preserved exactly.
  provider_idempotence_key TEXT NOT NULL UNIQUE,

  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  provider_request_started_at TEXT,
  -- When THIS SEND settled - acceptance or refusal established. Not when a
  -- recipient's mail server later emitted a delivery event.
  completed_at TEXT,
  provider_job_id TEXT,

  -- Scheduling and mutual exclusion belong to the attempt: a resend has its own
  -- retry budget and its own lease sequence. send_try_count is the try counter
  -- for THIS attempt, not a count of attempts - legacy `attempts` backfills
  -- into it directly, and must never be used to synthesise multiple logical
  -- attempts.
  send_try_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,

  -- NULL means acceptance or refusal is NOT ESTABLISHED - in flight, or
  -- ambiguous and unsettled. Settling is monotone and one-way.
  --
  -- There is deliberately no UNRESOLVED: an unresolved send is one whose
  -- outcome was never established, and later provider evidence may still settle
  -- it, which an immutable terminal value would forbid. Ambiguity is a
  -- message-level fact and 0039 models it there.
  --
  -- ACCEPTED, not DELIVERED: this is whether the provider accepted THIS SEND.
  -- Whether anyone received it is decided later by provider events and belongs
  -- to the message, so a bounce never rewrites a settled attempt.
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('ACCEPTED', 'KNOWN_FAILED')),
  failure_code TEXT,
  failure_detail TEXT,
  -- Automatic reconciliation budget spent. Scheduling metadata, never evidence:
  -- it must not settle `outcome`, and no elapsed time may either.
  reconciliation_exhausted_at TEXT,

  UNIQUE (message_id, attempt_no)
);

CREATE UNIQUE INDEX outbox_attempt_active_unique
  ON outbox_attempt(message_id) WHERE outcome IS NULL;

CREATE INDEX outbox_attempt_message_idx ON outbox_attempt(message_id, attempt_no);

CREATE TRIGGER outbox_attempt_identity_immutable_guard
BEFORE UPDATE ON outbox_attempt
WHEN NEW.id IS NOT OLD.id
  OR NEW.message_id IS NOT OLD.message_id
  OR NEW.attempt_no IS NOT OLD.attempt_no
  OR NEW.provider_idempotence_key IS NOT OLD.provider_idempotence_key
  OR NEW.requested_at IS NOT OLD.requested_at
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_ATTEMPT_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER outbox_attempt_settled_immutable_guard
BEFORE UPDATE ON outbox_attempt
WHEN OLD.outcome IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_ATTEMPT_SETTLED_IMMUTABLE');
END;

CREATE TRIGGER outbox_attempt_delete_guard
BEFORE DELETE ON outbox_attempt
WHEN EXISTS (SELECT 1 FROM email_outbox WHERE id = OLD.message_id)
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_ATTEMPT_DELETE_FORBIDDEN');
END;

CREATE TABLE outbox_authority (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  email_dispatch_paused INTEGER NOT NULL DEFAULT 0 CHECK (email_dispatch_paused IN (0, 1)),
  dispatch_owner_session_id TEXT REFERENCES deploy_sessions(id),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((email_dispatch_paused = 1) = (dispatch_owner_session_id IS NOT NULL))
);

CREATE TABLE outbox_authority_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('DISPATCH_FENCED', 'DISPATCH_UNFENCED')),
  owner_session_id TEXT NOT NULL REFERENCES deploy_sessions(id),
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX outbox_authority_events_created_idx ON outbox_authority_events(created_at);

CREATE TRIGGER email_outbox_dispatch_pause_guard
BEFORE UPDATE ON email_outbox
WHEN NEW.status = 'SENDING'
  AND OLD.status IN ('PENDING', 'SEND_UNKNOWN')
  AND COALESCE((SELECT email_dispatch_paused FROM outbox_authority WHERE singleton = 1), 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'EMAIL_DISPATCH_PAUSED');
END;

CREATE TABLE agent_referrals_feature_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'SUSPENDED')),
  owner_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agent_referrals_feature_state_events (
  id TEXT PRIMARY KEY,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX agent_referrals_feature_state_events_revision_idx
  ON agent_referrals_feature_state_events(revision);

CREATE TABLE agent_referrals_activation_manifest (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE framework_agreement_revisions (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES framework_agreement_revisions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER framework_agreement_revisions_immutable_guard
BEFORE UPDATE ON framework_agreement_revisions
BEGIN
  SELECT RAISE(ABORT, 'FRAMEWORK_AGREEMENT_REVISION_IMMUTABLE');
END;

CREATE TRIGGER framework_agreement_revisions_delete_guard
BEFORE DELETE ON framework_agreement_revisions
BEGIN
  SELECT RAISE(ABORT, 'FRAMEWORK_AGREEMENT_REVISION_IMMUTABLE');
END;

CREATE TABLE delegation_template_revisions (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE,
  ord_reporting_mode TEXT NOT NULL CHECK (ord_reporting_mode = 'FLEXPERIMENT_DELEGATED'),
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES delegation_template_revisions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER delegation_template_revisions_immutable_guard
BEFORE UPDATE ON delegation_template_revisions
BEGIN
  SELECT RAISE(ABORT, 'DELEGATION_TEMPLATE_REVISION_IMMUTABLE');
END;

CREATE TRIGGER delegation_template_revisions_delete_guard
BEFORE DELETE ON delegation_template_revisions
BEGIN
  SELECT RAISE(ABORT, 'DELEGATION_TEMPLATE_REVISION_IMMUTABLE');
END;

CREATE TABLE ad_channel_policy (
  id TEXT PRIMARY KEY,
  channel_key TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ALLOWED', 'BLOCKED', 'REVIEW_REQUIRED')),
  effective_from TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (NOT (channel_key IN ('other', 'other_internet_platform', 'unknown', '*') AND status = 'ALLOWED'))
);

CREATE UNIQUE INDEX ad_channel_policy_channel_revision_unique
  ON ad_channel_policy(channel_key, policy_revision);

CREATE INDEX ad_channel_policy_effective_idx
  ON ad_channel_policy(channel_key, effective_from);

CREATE TRIGGER ad_channel_policy_immutable_guard
BEFORE UPDATE ON ad_channel_policy
BEGIN
  SELECT RAISE(ABORT, 'AD_CHANNEL_POLICY_REVISION_IMMUTABLE');
END;

CREATE TRIGGER ad_channel_policy_delete_guard
BEFORE DELETE ON ad_channel_policy
BEGIN
  SELECT RAISE(ABORT, 'AD_CHANNEL_POLICY_REVISION_IMMUTABLE');
END;

CREATE TABLE partner_identities (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES partners(id),
  email TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  onboarding_state TEXT NOT NULL DEFAULT 'INVITED' CHECK (onboarding_state IN ('INVITED', 'PROFILE_SUBMITTED', 'PROFILE_VERIFIED', 'FRAMEWORK_ISSUED', 'FRAMEWORK_ACCEPTED', 'PARTNER_ACTIVE')),
  onboarding_revision INTEGER NOT NULL DEFAULT 1,
  submitted_legal_form TEXT CHECK (submitted_legal_form IS NULL OR submitted_legal_form IN ('INDIVIDUAL', 'INDIVIDUAL_ENTREPRENEUR', 'LEGAL_ENTITY')),
  submitted_tax_mode TEXT CHECK (submitted_tax_mode IS NULL OR submitted_tax_mode IN ('NPD', 'OTHER')),
  legal_profile_revision_id TEXT REFERENCES agent_referrals_legal_profile_revisions(id),
  destroyed_at TEXT,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, submitted_opf TEXT, submitted_full_name TEXT, submitted_short_name TEXT, submitted_inn TEXT, submitted_kpp TEXT, submitted_registration_number TEXT, submitted_legal_address TEXT, legal_profile_draft_revision INTEGER NOT NULL DEFAULT 0);

CREATE TABLE partner_identity_events (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  event_kind TEXT NOT NULL,
  actor_realm TEXT NOT NULL CHECK (actor_realm IN ('ADMIN', 'PARTNER', 'SYSTEM')),
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX partner_identity_events_partner_idx ON partner_identity_events(partner_identity_id, created_at);

CREATE TRIGGER partner_identity_events_immutable_guard
BEFORE UPDATE ON partner_identity_events
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_EVENT_IMMUTABLE'); END;

CREATE TRIGGER partner_identity_events_delete_guard
BEFORE DELETE ON partner_identity_events
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_EVENT_IMMUTABLE'); END;

CREATE TABLE partner_invite_capabilities (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  purpose TEXT NOT NULL CHECK (purpose = 'ONBOARDING'),
  verifier_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  superseded_by_id TEXT REFERENCES partner_invite_capabilities(id),
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX partner_invite_capabilities_partner_idx ON partner_invite_capabilities(partner_identity_id);

CREATE UNIQUE INDEX partner_invite_capabilities_active_unique
  ON partner_invite_capabilities(partner_identity_id) WHERE consumed_at IS NULL AND revoked_at IS NULL AND superseded_by_id IS NULL;

CREATE TABLE partner_otp_challenges (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  purpose TEXT NOT NULL CHECK (purpose = 'LOGIN'),
  secret_hash TEXT NOT NULL,
  send_outcome TEXT CHECK (send_outcome IS NULL OR send_outcome IN ('ACCEPTED', 'UNKNOWN', 'KNOWN_FAILED')),
  send_attempted_at TEXT,
  consumed_at TEXT,
  superseded_by_id TEXT REFERENCES partner_otp_challenges(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX partner_otp_challenges_partner_idx ON partner_otp_challenges(partner_identity_id);

CREATE UNIQUE INDEX partner_otp_challenges_active_unique
  ON partner_otp_challenges(partner_identity_id) WHERE consumed_at IS NULL AND superseded_by_id IS NULL;

CREATE TABLE partner_sessions (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX partner_sessions_partner_idx ON partner_sessions(partner_identity_id);

CREATE TABLE step_up_grants (
  id TEXT PRIMARY KEY,
  partner_session_id TEXT NOT NULL REFERENCES partner_sessions(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  action TEXT NOT NULL CHECK (action IN ('FRAMEWORK_ACCEPTANCE', 'PAYOUT_PROFILE_SUPERSESSION')),
  resource_json TEXT NOT NULL,
  resource_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX step_up_grants_partner_idx ON step_up_grants(partner_identity_id);

CREATE TABLE payout_profile_revisions (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ACTIVE_DESTINATION', 'REVOKED')),
  key_id TEXT,
  ciphertext TEXT,
  nonce TEXT,
  destination_kind TEXT CHECK (destination_kind IS NULL OR destination_kind IN ('BANK_CARD', 'BANK_ACCOUNT')),
  destination_last4 TEXT,
  supersedes_revision_id TEXT REFERENCES payout_profile_revisions(id),
  step_up_grant_id TEXT NOT NULL UNIQUE REFERENCES step_up_grants(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (partner_identity_id, revision),
  CHECK (
    (kind = 'ACTIVE_DESTINATION' AND key_id IS NOT NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND destination_kind IS NOT NULL)
    OR (kind = 'REVOKED' AND key_id IS NULL AND ciphertext IS NULL AND nonce IS NULL AND destination_kind IS NULL AND destination_last4 IS NULL)
  )
);

CREATE INDEX payout_profile_revisions_partner_idx ON payout_profile_revisions(partner_identity_id, revision);

CREATE TRIGGER payout_profile_revisions_immutable_guard
BEFORE UPDATE ON payout_profile_revisions
BEGIN SELECT RAISE(ABORT, 'PAYOUT_PROFILE_REVISION_IMMUTABLE'); END;

CREATE TRIGGER payout_profile_revisions_delete_guard
BEFORE DELETE ON payout_profile_revisions
BEGIN SELECT RAISE(ABORT, 'PAYOUT_PROFILE_REVISION_IMMUTABLE'); END;

CREATE TABLE partner_identity_retention_policies (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES partner_identity_retention_policies(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER partner_identity_retention_policies_immutable_guard
BEFORE UPDATE ON partner_identity_retention_policies
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_RETENTION_POLICY_IMMUTABLE'); END;

CREATE TRIGGER partner_identity_retention_policies_delete_guard
BEFORE DELETE ON partner_identity_retention_policies
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_RETENTION_POLICY_IMMUTABLE'); END;

CREATE TABLE partner_identity_legal_holds (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  reason TEXT NOT NULL,
  placed_by_admin_id TEXT NOT NULL,
  placed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT,
  released_by_admin_id TEXT,
  released_reason TEXT,
  CHECK (
    (released_at IS NULL AND released_by_admin_id IS NULL AND released_reason IS NULL)
    OR (released_at IS NOT NULL AND released_by_admin_id IS NOT NULL AND released_reason IS NOT NULL)
  )
);

CREATE INDEX partner_identity_legal_holds_partner_idx ON partner_identity_legal_holds(partner_identity_id);

CREATE UNIQUE INDEX partner_identity_legal_holds_active_unique
  ON partner_identity_legal_holds(partner_identity_id) WHERE released_at IS NULL;

CREATE TRIGGER partner_identity_legal_holds_placement_immutable_guard
BEFORE UPDATE ON partner_identity_legal_holds
WHEN NEW.partner_identity_id IS NOT OLD.partner_identity_id
  OR NEW.reason IS NOT OLD.reason
  OR NEW.placed_by_admin_id IS NOT OLD.placed_by_admin_id
  OR NEW.placed_at IS NOT OLD.placed_at
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_LEGAL_HOLD_PLACEMENT_IMMUTABLE'); END;

CREATE TRIGGER partner_identity_legal_holds_release_one_way_guard
BEFORE UPDATE ON partner_identity_legal_holds
WHEN OLD.released_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_LEGAL_HOLD_ALREADY_RELEASED'); END;

CREATE TRIGGER partner_identity_legal_holds_delete_guard
BEFORE DELETE ON partner_identity_legal_holds
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_LEGAL_HOLD_IMMUTABLE'); END;

CREATE TABLE partner_identity_destruction_events (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL UNIQUE REFERENCES partner_identities(id),
  destroyed_fields_json TEXT NOT NULL,
  retention_policy_revision_id TEXT NOT NULL REFERENCES partner_identity_retention_policies(id),
  requested_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER partner_identity_destruction_events_immutable_guard
BEFORE UPDATE ON partner_identity_destruction_events
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_DESTRUCTION_EVENT_IMMUTABLE'); END;

CREATE TRIGGER partner_identity_destruction_events_delete_guard
BEFORE DELETE ON partner_identity_destruction_events
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_DESTRUCTION_EVENT_IMMUTABLE'); END;

CREATE TABLE partner_audience_verification_events (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  city_id TEXT NOT NULL REFERENCES cities(id),
  aggregate_revision INTEGER NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('VERIFIED', 'REVOKED')),
  valid_until TEXT,
  supersedes_event_id TEXT REFERENCES partner_audience_verification_events(id),
  evidence_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  placed_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  UNIQUE (partner_identity_id, city_id, aggregate_revision),
  CHECK (
    (event_kind = 'VERIFIED' AND valid_until IS NOT NULL)
    OR (event_kind = 'REVOKED' AND valid_until IS NULL)
  )
);

CREATE INDEX partner_audience_verification_events_current_idx
  ON partner_audience_verification_events(partner_identity_id, city_id, aggregate_revision);

CREATE TRIGGER partner_audience_verification_events_immutable_guard
BEFORE UPDATE ON partner_audience_verification_events
BEGIN SELECT RAISE(ABORT, 'PARTNER_AUDIENCE_VERIFICATION_EVENT_IMMUTABLE'); END;

CREATE TRIGGER partner_audience_verification_events_delete_guard
BEFORE DELETE ON partner_audience_verification_events
BEGIN SELECT RAISE(ABORT, 'PARTNER_AUDIENCE_VERIFICATION_EVENT_IMMUTABLE'); END;

CREATE TABLE engagements (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  lifecycle_state TEXT NOT NULL DEFAULT 'OFFERED' CHECK (lifecycle_state IN ('OFFERED', 'ACCEPTED', 'ACTIVE', 'SUSPENDED', 'CLOSED')),
  lifecycle_revision INTEGER NOT NULL DEFAULT 1,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (partner_identity_id, occurrence_id)
);

CREATE INDEX engagements_partner_idx ON engagements(partner_identity_id);

CREATE INDEX engagements_occurrence_idx ON engagements(occurrence_id);

CREATE TABLE engagement_revisions (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  revision INTEGER NOT NULL,
  occurrence_material_revision INTEGER NOT NULL,
  reward_type TEXT NOT NULL CHECK (reward_type IN ('PERCENT', 'FIXED')),
  reward_value INTEGER NOT NULL CHECK (reward_value >= 0),
  customer_discount_type TEXT NOT NULL CHECK (customer_discount_type IN ('NONE', 'PERCENT', 'FIXED')),
  customer_discount_value INTEGER NOT NULL CHECK (customer_discount_value >= 0),
  publication_start_at TEXT NOT NULL,
  publication_end_at TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES engagement_revisions(id),
  created_by_admin_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (engagement_id, revision),
  CHECK (publication_end_at > publication_start_at),
  CHECK (
    (customer_discount_type = 'NONE' AND customer_discount_value = 0)
    OR (customer_discount_type = 'PERCENT' AND customer_discount_value BETWEEN 1 AND 9999)
    OR (customer_discount_type = 'FIXED' AND customer_discount_value > 0)
  )
);

CREATE INDEX engagement_revisions_engagement_idx ON engagement_revisions(engagement_id, revision);

CREATE TRIGGER engagement_revisions_immutable_guard
BEFORE UPDATE ON engagement_revisions
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_REVISION_IMMUTABLE'); END;

CREATE TRIGGER engagement_revisions_delete_guard
BEFORE DELETE ON engagement_revisions
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_REVISION_IMMUTABLE'); END;

CREATE TABLE engagement_step_up_grants (
  id TEXT PRIMARY KEY,
  partner_session_id TEXT NOT NULL REFERENCES partner_sessions(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  action TEXT NOT NULL CHECK (action IN ('ENGAGEMENT_ACCEPTANCE', 'DELEGATION_REVOCATION')),
  resource_json TEXT NOT NULL,
  resource_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX engagement_step_up_grants_partner_idx ON engagement_step_up_grants(partner_identity_id);

CREATE TABLE engagement_acceptances (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  step_up_grant_id TEXT NOT NULL UNIQUE REFERENCES engagement_step_up_grants(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (engagement_id, engagement_revision_id)
);

CREATE TRIGGER engagement_acceptances_immutable_guard
BEFORE UPDATE ON engagement_acceptances
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_ACCEPTANCE_IMMUTABLE'); END;

CREATE TRIGGER engagement_acceptances_delete_guard
BEFORE DELETE ON engagement_acceptances
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_ACCEPTANCE_IMMUTABLE'); END;

CREATE TABLE partner_promos (
  id TEXT PRIMARY KEY,
  promo_code_id TEXT NOT NULL UNIQUE REFERENCES promo_codes(id),
  partner_id TEXT NOT NULL UNIQUE REFERENCES partners(id),
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER partner_promos_immutable_guard
BEFORE UPDATE ON partner_promos
BEGIN SELECT RAISE(ABORT, 'PARTNER_PROMO_IMMUTABLE'); END;

CREATE TRIGGER partner_promos_delete_guard
BEFORE DELETE ON partner_promos
BEGIN SELECT RAISE(ABORT, 'PARTNER_PROMO_IMMUTABLE'); END;

CREATE TABLE engagement_promo_authorizations (
  id TEXT PRIMARY KEY,
  promo_code_id TEXT NOT NULL REFERENCES promo_codes(id),
  partner_id TEXT NOT NULL REFERENCES partners(id),
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  sequence INTEGER NOT NULL,
  supersedes_authorization_id TEXT REFERENCES engagement_promo_authorizations(id),
  effective_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  revoked_at TEXT,
  revoked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(engagement_id, sequence)
);

CREATE INDEX engagement_promo_authorizations_engagement_idx ON engagement_promo_authorizations(engagement_id);

CREATE UNIQUE INDEX engagement_promo_authorizations_current_unique
  ON engagement_promo_authorizations(promo_code_id, occurrence_id) WHERE revoked_at IS NULL;

CREATE TRIGGER engagement_promo_authorizations_placement_immutable_guard
BEFORE UPDATE ON engagement_promo_authorizations
WHEN NEW.promo_code_id IS NOT OLD.promo_code_id
  OR NEW.partner_id IS NOT OLD.partner_id
  OR NEW.occurrence_id IS NOT OLD.occurrence_id
  OR NEW.engagement_id IS NOT OLD.engagement_id
  OR NEW.engagement_revision_id IS NOT OLD.engagement_revision_id
  OR NEW.sequence IS NOT OLD.sequence
  OR NEW.supersedes_authorization_id IS NOT OLD.supersedes_authorization_id
  OR NEW.effective_at IS NOT OLD.effective_at
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_PROMO_AUTHORIZATION_PLACEMENT_IMMUTABLE'); END;

CREATE TRIGGER engagement_promo_authorizations_revoke_one_way_guard
BEFORE UPDATE ON engagement_promo_authorizations
WHEN OLD.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_PROMO_AUTHORIZATION_ALREADY_REVOKED'); END;

CREATE TRIGGER engagement_promo_authorizations_delete_guard
BEFORE DELETE ON engagement_promo_authorizations
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_PROMO_AUTHORIZATION_IMMUTABLE'); END;

CREATE TABLE engagement_activation_events (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  audience_verification_event_id TEXT NOT NULL REFERENCES partner_audience_verification_events(id),
  legal_profile_revision_id TEXT NOT NULL REFERENCES agent_referrals_legal_profile_revisions(id),
  framework_acceptance_id TEXT NOT NULL REFERENCES framework_acceptances(id),
  ord_reporting_delegation_id TEXT NOT NULL REFERENCES ord_reporting_delegations(id),
  promo_authorization_id TEXT NOT NULL REFERENCES engagement_promo_authorizations(id),
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  activated_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX engagement_activation_events_engagement_idx ON engagement_activation_events(engagement_id, created_at);

CREATE TRIGGER engagement_activation_events_immutable_guard
BEFORE UPDATE ON engagement_activation_events
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_ACTIVATION_EVENT_IMMUTABLE'); END;

CREATE TRIGGER engagement_activation_events_delete_guard
BEFORE DELETE ON engagement_activation_events
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_ACTIVATION_EVENT_IMMUTABLE'); END;

CREATE TABLE engagement_creative_revisions (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  revision INTEGER NOT NULL,
  partner_id TEXT NOT NULL REFERENCES partners(id),
  promo_code_id TEXT NOT NULL REFERENCES promo_codes(id),
  format_kind TEXT NOT NULL CHECK (format_kind IN ('post', 'story', 'short_video', 'long_video', 'stream', 'audio', 'text', 'graphic', 'text_graphic', 'native_authored')),
  media_ref TEXT,
  copy_text TEXT,
  cta_text TEXT,
  mandatory_labeling_text TEXT NOT NULL,
  creative_target_url TEXT NOT NULL,
  creative_hash TEXT NOT NULL,
  supersedes_creative_revision_id TEXT REFERENCES engagement_creative_revisions(id),
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (engagement_id, revision)
);

CREATE INDEX engagement_creative_revisions_engagement_idx ON engagement_creative_revisions(engagement_id);

CREATE TRIGGER engagement_creative_revisions_immutable_guard
BEFORE UPDATE ON engagement_creative_revisions
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_CREATIVE_REVISION_IMMUTABLE'); END;

CREATE TRIGGER engagement_creative_revisions_delete_guard
BEFORE DELETE ON engagement_creative_revisions
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_CREATIVE_REVISION_IMMUTABLE'); END;

CREATE TABLE engagement_creative_authorizations (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  promo_authorization_id TEXT NOT NULL REFERENCES engagement_promo_authorizations(id),
  creative_revision_id TEXT NOT NULL REFERENCES engagement_creative_revisions(id),
  supersedes_authorization_id TEXT REFERENCES engagement_creative_authorizations(id),
  effective_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  revoked_at TEXT,
  revoked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX engagement_creative_authorizations_engagement_idx ON engagement_creative_authorizations(engagement_id);

CREATE UNIQUE INDEX engagement_creative_authorizations_current_unique
  ON engagement_creative_authorizations(engagement_id) WHERE revoked_at IS NULL;

CREATE TRIGGER engagement_creative_authorizations_placement_immutable_guard
BEFORE UPDATE ON engagement_creative_authorizations
WHEN NEW.engagement_id IS NOT OLD.engagement_id
  OR NEW.engagement_revision_id IS NOT OLD.engagement_revision_id
  OR NEW.promo_authorization_id IS NOT OLD.promo_authorization_id
  OR NEW.creative_revision_id IS NOT OLD.creative_revision_id
  OR NEW.supersedes_authorization_id IS NOT OLD.supersedes_authorization_id
  OR NEW.effective_at IS NOT OLD.effective_at
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_CREATIVE_AUTHORIZATION_PLACEMENT_IMMUTABLE'); END;

CREATE TRIGGER engagement_creative_authorizations_revoke_one_way_guard
BEFORE UPDATE ON engagement_creative_authorizations
WHEN OLD.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_CREATIVE_AUTHORIZATION_ALREADY_REVOKED'); END;

CREATE TRIGGER engagement_creative_authorizations_delete_guard
BEFORE DELETE ON engagement_creative_authorizations
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_CREATIVE_AUTHORIZATION_IMMUTABLE'); END;

CREATE TABLE engagement_distributions (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX engagement_distributions_engagement_idx ON engagement_distributions(engagement_id);

CREATE TABLE engagement_distribution_revisions (
  id TEXT PRIMARY KEY,
  distribution_id TEXT NOT NULL REFERENCES engagement_distributions(id),
  revision INTEGER NOT NULL,
  supersedes_revision_id TEXT REFERENCES engagement_distribution_revisions(id),
  engagement_revision_id TEXT REFERENCES engagement_revisions(id),
  creative_revision_id TEXT REFERENCES engagement_creative_revisions(id),
  channel_key TEXT NOT NULL,
  channel_policy_status TEXT NOT NULL CHECK (channel_policy_status IN ('ALLOWED', 'BLOCKED', 'REVIEW_REQUIRED')),
  channel_policy_revision INTEGER,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('channel', 'page', 'profile', 'site', 'stream')),
  resource_identifier TEXT NOT NULL,
  distribution_resource_url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  ended_at TEXT,
  reported_by TEXT NOT NULL CHECK (reported_by IN ('PARTNER', 'ADMIN')),
  correction_reason TEXT,
  evidence_ref TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (distribution_id, revision),
  CHECK (revision = 1 OR correction_reason IS NOT NULL),
  CHECK ((engagement_revision_id IS NULL) = (creative_revision_id IS NULL))
);

CREATE INDEX engagement_distribution_revisions_distribution_idx ON engagement_distribution_revisions(distribution_id, revision);

CREATE TRIGGER engagement_distribution_revisions_immutable_guard
BEFORE UPDATE ON engagement_distribution_revisions
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_DISTRIBUTION_REVISION_IMMUTABLE'); END;

CREATE TRIGGER engagement_distribution_revisions_delete_guard
BEFORE DELETE ON engagement_distribution_revisions
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_DISTRIBUTION_REVISION_IMMUTABLE'); END;

CREATE TABLE engagement_distribution_events (
  id TEXT PRIMARY KEY,
  distribution_id TEXT NOT NULL REFERENCES engagement_distributions(id),
  event_sequence INTEGER NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('DECLARED', 'MARKED_REPORTABLE', 'REVIEW_REQUIRED', 'REVIEW_CLEARED', 'REMOVAL_REQUIRED', 'REMOVAL_CLAIMED', 'REMOVAL_CONFIRMED', 'OVERDUE_REMOVAL', 'REMOVAL_UNVERIFIED')),
  actor_realm TEXT NOT NULL CHECK (actor_realm IN ('ADMIN', 'PARTNER', 'SYSTEM')),
  evidence_ref TEXT,
  reason TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  UNIQUE (distribution_id, event_sequence)
);

CREATE INDEX engagement_distribution_events_distribution_idx ON engagement_distribution_events(distribution_id, event_sequence);

CREATE TRIGGER engagement_distribution_events_immutable_guard
BEFORE UPDATE ON engagement_distribution_events
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_DISTRIBUTION_EVENT_IMMUTABLE'); END;

CREATE TRIGGER engagement_distribution_events_delete_guard
BEFORE DELETE ON engagement_distribution_events
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_DISTRIBUTION_EVENT_IMMUTABLE'); END;

CREATE TABLE ord_reporting_delegation_revocations (
  id TEXT PRIMARY KEY,
  ord_reporting_delegation_id TEXT NOT NULL UNIQUE REFERENCES ord_reporting_delegations(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  revoked_by_realm TEXT NOT NULL CHECK (revoked_by_realm IN ('ADMIN', 'PARTNER')),
  revoked_by_admin_id TEXT,
  reason TEXT NOT NULL,
  revoked_for_new_activity_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (revoked_by_realm = 'ADMIN' AND revoked_by_admin_id IS NOT NULL)
    OR (revoked_by_realm = 'PARTNER' AND revoked_by_admin_id IS NULL)
  )
);

CREATE TRIGGER ord_reporting_delegation_revocations_immutable_guard
BEFORE UPDATE ON ord_reporting_delegation_revocations
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_DELEGATION_REVOCATION_IMMUTABLE'); END;

CREATE TRIGGER ord_reporting_delegation_revocations_delete_guard
BEFORE DELETE ON ord_reporting_delegation_revocations
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_DELEGATION_REVOCATION_IMMUTABLE'); END;

CREATE TABLE engagement_closure_events (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL UNIQUE REFERENCES engagements(id),
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  revoked_promo_authorization_id TEXT NOT NULL REFERENCES engagement_promo_authorizations(id),
  reward_registry_finalization_evidence_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  closed_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER engagement_closure_events_immutable_guard
BEFORE UPDATE ON engagement_closure_events
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_CLOSURE_EVENT_IMMUTABLE'); END;

CREATE TRIGGER engagement_closure_events_delete_guard
BEFORE DELETE ON engagement_closure_events
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_CLOSURE_EVENT_IMMUTABLE'); END;

CREATE TRIGGER orders_authority_tuple_consistency_guard
BEFORE INSERT ON orders
WHEN NOT (
  (NEW.resolution_reason IN ('DIRECT', 'DISCOUNT_PROMO')
    AND NEW.attributed_agent_id IS NULL
    AND NEW.reward_type_snapshot IS NULL AND NEW.reward_value_snapshot IS NULL
    AND NEW.resolved_partner_id IS NULL AND NEW.resolved_engagement_id IS NULL
    AND NEW.resolved_engagement_revision_id IS NULL AND NEW.resolved_promo_authorization_id IS NULL)
  OR
  (NEW.resolution_reason = 'EXPLICIT_PARTNER_PROMO'
    AND NEW.explicit_promo_id IS NOT NULL AND NEW.resolved_partner_id IS NOT NULL
    AND NEW.resolved_engagement_id IS NOT NULL AND NEW.resolved_engagement_revision_id IS NOT NULL
    AND NEW.resolved_promo_authorization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM engagement_promo_authorizations a
      WHERE a.id = NEW.resolved_promo_authorization_id
        AND a.promo_code_id = NEW.explicit_promo_id
        AND a.partner_id = NEW.resolved_partner_id
        AND a.engagement_id = NEW.resolved_engagement_id
        AND a.engagement_revision_id = NEW.resolved_engagement_revision_id
        AND a.occurrence_id = NEW.occurrence_id
    )
    AND NEW.attributed_agent_id = NEW.resolved_partner_id
    AND EXISTS (
      SELECT 1 FROM engagement_revisions r
      WHERE r.id = NEW.resolved_engagement_revision_id
        AND r.engagement_id = NEW.resolved_engagement_id
        AND r.reward_type = NEW.reward_type_snapshot
        AND r.reward_value = NEW.reward_value_snapshot
    ))
)
BEGIN SELECT RAISE(ABORT, 'ORDER_AUTHORITY_TUPLE_INCONSISTENT'); END;

CREATE TRIGGER orders_authority_columns_immutable_guard
BEFORE UPDATE ON orders
WHEN NEW.explicit_promo_id IS NOT OLD.explicit_promo_id
  OR NEW.resolved_partner_id IS NOT OLD.resolved_partner_id
  OR NEW.resolved_engagement_id IS NOT OLD.resolved_engagement_id
  OR NEW.resolved_engagement_revision_id IS NOT OLD.resolved_engagement_revision_id
  OR NEW.resolved_promo_authorization_id IS NOT OLD.resolved_promo_authorization_id
  OR NEW.attribution_rule_version IS NOT OLD.attribution_rule_version
  OR NEW.resolution_reason IS NOT OLD.resolution_reason
  OR NEW.attributed_agent_id IS NOT OLD.attributed_agent_id
  OR NEW.reward_type_snapshot IS NOT OLD.reward_type_snapshot
  OR NEW.reward_value_snapshot IS NOT OLD.reward_value_snapshot
BEGIN SELECT RAISE(ABORT, 'ORDER_AUTHORITY_COLUMNS_IMMUTABLE'); END;

CREATE TABLE engagement_reward_registry_snapshot (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL UNIQUE REFERENCES engagements(id),
  engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
  terminal_status TEXT NOT NULL CHECK (terminal_status IN ('COMPLETED', 'CANCELLED')),
  reward_total_kopecks INTEGER NOT NULL CHECK (reward_total_kopecks >= 0),
  formula_version INTEGER NOT NULL,
  source_order_ids_json TEXT NOT NULL,
  source_state_hash TEXT NOT NULL,
  watermark TEXT NOT NULL,
  finalized_by_admin_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- §B-6: a CANCELLED occurrence may finalize the registry, but can never
  -- produce positive payable authority - "mint a zero effective snapshot"
  -- is not merely an application convention here, since E1 is always
  -- seeded from R.reward_total_kopecks. A structural (not merely
  -- application-level) CHECK, because this is exactly the boundary PR7's
  -- settlement/act/payment machinery will trust R to have already proven.
  CHECK (terminal_status = 'COMPLETED' OR reward_total_kopecks = 0)
);

CREATE TRIGGER engagement_reward_registry_snapshot_relational_consistency_guard
BEFORE INSERT ON engagement_reward_registry_snapshot
WHEN NOT (
  EXISTS (SELECT 1 FROM engagement_revisions r WHERE r.id = NEW.engagement_revision_id AND r.engagement_id = NEW.engagement_id)
  AND EXISTS (SELECT 1 FROM engagements e WHERE e.id = NEW.engagement_id AND e.occurrence_id = NEW.occurrence_id)
  AND EXISTS (SELECT 1 FROM occurrences o WHERE o.id = NEW.occurrence_id AND o.fulfillment_status = NEW.terminal_status)
)
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER engagement_reward_registry_snapshot_immutable_guard
BEFORE UPDATE ON engagement_reward_registry_snapshot
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_IMMUTABLE'); END;

CREATE TRIGGER engagement_reward_registry_snapshot_delete_guard
BEFORE DELETE ON engagement_reward_registry_snapshot
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_IMMUTABLE'); END;

CREATE TABLE engagement_effective_reward_snapshots (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  base_registry_snapshot_id TEXT NOT NULL REFERENCES engagement_reward_registry_snapshot(id),
  supersedes_effective_snapshot_id TEXT REFERENCES engagement_effective_reward_snapshots(id),
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('INITIAL', 'CORRECTION')),
  reward_total_kopecks INTEGER NOT NULL CHECK (reward_total_kopecks >= 0),
  source_state_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (engagement_id, sequence),
  CHECK ((kind = 'INITIAL') = (sequence = 1)),
  CHECK ((sequence = 1) = (supersedes_effective_snapshot_id IS NULL))
);

CREATE INDEX engagement_effective_reward_snapshots_engagement_idx ON engagement_effective_reward_snapshots(engagement_id, sequence);

CREATE TRIGGER engagement_effective_reward_snapshots_relational_consistency_guard
BEFORE INSERT ON engagement_effective_reward_snapshots
WHEN NOT (
  EXISTS (
    SELECT 1 FROM engagement_reward_registry_snapshot r
    WHERE r.id = NEW.base_registry_snapshot_id AND r.engagement_id = NEW.engagement_id
      AND (r.terminal_status = 'COMPLETED' OR NEW.reward_total_kopecks = 0)
      AND (
        NEW.supersedes_effective_snapshot_id IS NOT NULL
        OR (r.engagement_revision_id = NEW.engagement_revision_id AND r.reward_total_kopecks = NEW.reward_total_kopecks AND r.source_state_hash = NEW.source_state_hash)
      )
  )
  AND EXISTS (SELECT 1 FROM engagement_revisions rev WHERE rev.id = NEW.engagement_revision_id AND rev.engagement_id = NEW.engagement_id)
  AND (
    NEW.supersedes_effective_snapshot_id IS NULL
    OR EXISTS (
      SELECT 1 FROM engagement_effective_reward_snapshots prev
      WHERE prev.id = NEW.supersedes_effective_snapshot_id
        AND prev.engagement_id = NEW.engagement_id
        AND prev.base_registry_snapshot_id = NEW.base_registry_snapshot_id
        AND prev.sequence = NEW.sequence - 1
        AND prev.engagement_revision_id = NEW.engagement_revision_id
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER engagement_effective_reward_snapshots_immutable_guard
BEFORE UPDATE ON engagement_effective_reward_snapshots
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_IMMUTABLE'); END;

CREATE TRIGGER engagement_effective_reward_snapshots_delete_guard
BEFORE DELETE ON engagement_effective_reward_snapshots
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_IMMUTABLE'); END;

CREATE UNIQUE INDEX reward_settlements_effective_snapshot_unique
  ON reward_settlements(effective_reward_snapshot_id) WHERE effective_reward_snapshot_id IS NOT NULL;

CREATE TRIGGER reward_settlements_authority_columns_immutable_guard
BEFORE UPDATE ON reward_settlements
WHEN NEW.engagement_id IS NOT OLD.engagement_id
  OR NEW.engagement_revision_id IS NOT OLD.engagement_revision_id
  OR NEW.base_registry_snapshot_id IS NOT OLD.base_registry_snapshot_id
  OR NEW.reward_registry_hash IS NOT OLD.reward_registry_hash
  OR NEW.effective_reward_snapshot_id IS NOT OLD.effective_reward_snapshot_id
  OR NEW.partner_identity_id IS NOT OLD.partner_identity_id
  OR NEW.payout_profile_revision_id IS NOT OLD.payout_profile_revision_id
  OR NEW.tax_mode_snapshot IS NOT OLD.tax_mode_snapshot
  OR NEW.legal_profile_revision_id_snapshot IS NOT OLD.legal_profile_revision_id_snapshot
  OR NEW.contractor_type_snapshot IS NOT OLD.contractor_type_snapshot
  OR NEW.supersedes_settlement_id IS NOT OLD.supersedes_settlement_id
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.occurrence_id IS NOT OLD.occurrence_id
  OR NEW.amount_kopecks IS NOT OLD.amount_kopecks
  OR NEW.tax_treatment_revision_id_snapshot IS NOT OLD.tax_treatment_revision_id_snapshot
  OR NEW.tax_canonicalization_version IS NOT OLD.tax_canonicalization_version
  OR NEW.tax_canonical_json IS NOT OLD.tax_canonical_json
  OR NEW.tax_canonical_hash IS NOT OLD.tax_canonical_hash
BEGIN SELECT RAISE(ABORT, 'REWARD_SETTLEMENT_AUTHORITY_COLUMNS_IMMUTABLE'); END;

CREATE TRIGGER reward_settlements_agent_referrals_status_transition_guard
BEFORE UPDATE ON reward_settlements
WHEN (NEW.status IS NOT OLD.status OR NEW.cancellation_reason IS NOT OLD.cancellation_reason)
  AND NOT (
    OLD.status = 'PREPARED' AND OLD.cancellation_reason IS NULL AND (
      (NEW.status = 'CANCELLED_BEFORE_PAYMENT' AND NEW.cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION'
        AND NOT EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.settlement_id = NEW.id AND pa.status IN ('IN_PROGRESS', 'PAYOUT_UNKNOWN', 'MADE'))
        AND EXISTS (
          SELECT 1 FROM engagement_effective_reward_snapshots newE
          WHERE newE.engagement_id = NEW.engagement_id
            AND newE.kind = 'CORRECTION'
            AND newE.supersedes_effective_snapshot_id = OLD.effective_reward_snapshot_id
            AND newE.sequence = (SELECT MAX(sequence) FROM engagement_effective_reward_snapshots WHERE engagement_id = NEW.engagement_id)
        ))
      OR (NEW.status = 'SETTLED' AND NEW.cancellation_reason IS NULL AND NEW.tax_mode_snapshot = 'OTHER'
          AND EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.settlement_id = NEW.id AND pa.status = 'MADE'))
      OR (NEW.status = 'PENDING_DOCUMENT' AND NEW.cancellation_reason IS NULL AND NEW.tax_mode_snapshot = 'NPD'
          AND EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.settlement_id = NEW.id AND pa.status = 'MADE'))
    )
    OR (OLD.status = 'PENDING_DOCUMENT' AND NEW.status = 'SETTLED' AND NEW.cancellation_reason IS NULL
        AND EXISTS (SELECT 1 FROM payment_attempts pa JOIN npd_receipts r ON r.payment_attempt_id = pa.id WHERE pa.settlement_id = NEW.id AND pa.status = 'MADE'))
  )
BEGIN SELECT RAISE(ABORT, 'REWARD_SETTLEMENT_TRANSITION_ILLEGAL'); END;

CREATE TRIGGER reward_settlements_agent_referrals_terminal_immutable_guard
BEFORE UPDATE ON reward_settlements
WHEN OLD.status IN ('SETTLED', 'CANCELLED_BEFORE_PAYMENT')
BEGIN SELECT RAISE(ABORT, 'REWARD_SETTLEMENT_TERMINAL_IMMUTABLE'); END;

CREATE TRIGGER engagement_effective_reward_snapshots_no_correction_during_live_payment_guard
BEFORE INSERT ON engagement_effective_reward_snapshots
WHEN NEW.kind = 'CORRECTION' AND EXISTS (
  SELECT 1 FROM reward_settlements rs
  JOIN payment_attempts pa ON pa.settlement_id = rs.id
  WHERE rs.engagement_id = NEW.engagement_id
    AND pa.status IN ('IN_PROGRESS', 'PAYOUT_UNKNOWN')
)
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_CORRECTION_BLOCKED_PAYMENT_IN_FLIGHT'); END;

CREATE TABLE settlement_step_up_grants (
  id TEXT PRIMARY KEY,
  partner_session_id TEXT NOT NULL REFERENCES partner_sessions(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  action TEXT NOT NULL CHECK (action = 'ACT_ACCEPTANCE'),
  resource_json TEXT NOT NULL,
  resource_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX settlement_step_up_grants_partner_idx ON settlement_step_up_grants(partner_identity_id);

CREATE TABLE settlement_acts (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL UNIQUE REFERENCES reward_settlements(id),
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  effective_reward_snapshot_id TEXT NOT NULL REFERENCES engagement_effective_reward_snapshots(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  presented_at TEXT,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX settlement_acts_partner_idx ON settlement_acts(partner_identity_id);

CREATE TRIGGER settlement_acts_relational_consistency_guard
BEFORE INSERT ON settlement_acts
WHEN NOT EXISTS (
  SELECT 1 FROM reward_settlements rs
  WHERE rs.id = NEW.settlement_id
    AND rs.engagement_id = NEW.engagement_id AND rs.engagement_revision_id = NEW.engagement_revision_id
    AND rs.effective_reward_snapshot_id = NEW.effective_reward_snapshot_id
    AND rs.partner_identity_id = NEW.partner_identity_id AND rs.amount_kopecks = NEW.amount_kopecks
)
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER settlement_acts_fields_immutable_guard
BEFORE UPDATE ON settlement_acts
WHEN NEW.settlement_id IS NOT OLD.settlement_id OR NEW.engagement_id IS NOT OLD.engagement_id
  OR NEW.engagement_revision_id IS NOT OLD.engagement_revision_id OR NEW.effective_reward_snapshot_id IS NOT OLD.effective_reward_snapshot_id
  OR NEW.partner_identity_id IS NOT OLD.partner_identity_id OR NEW.amount_kopecks IS NOT OLD.amount_kopecks
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_FIELDS_IMMUTABLE'); END;

CREATE TRIGGER settlement_acts_presented_one_way_guard
BEFORE UPDATE ON settlement_acts
WHEN OLD.presented_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_ALREADY_PRESENTED'); END;

CREATE TRIGGER settlement_acts_delete_guard
BEFORE DELETE ON settlement_acts
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_IMMUTABLE'); END;

CREATE TABLE settlement_act_acceptances (
  id TEXT PRIMARY KEY,
  act_id TEXT NOT NULL UNIQUE REFERENCES settlement_acts(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  step_up_grant_id TEXT NOT NULL UNIQUE REFERENCES settlement_step_up_grants(id),
  accepted_amount_kopecks INTEGER NOT NULL,
  accepted_engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER settlement_act_acceptances_relational_consistency_guard
BEFORE INSERT ON settlement_act_acceptances
WHEN (NOT EXISTS (
  SELECT 1 FROM settlement_acts a
  WHERE a.id = NEW.act_id AND a.presented_at IS NOT NULL
    AND a.partner_identity_id = NEW.partner_identity_id
    AND a.amount_kopecks = NEW.accepted_amount_kopecks
    AND a.engagement_revision_id = NEW.accepted_engagement_revision_id
))
OR EXISTS (SELECT 1 FROM settlement_act_disputes d WHERE d.act_id = NEW.act_id)
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_ACCEPTANCE_INVALID'); END;

CREATE TRIGGER settlement_act_acceptances_immutable_guard
BEFORE UPDATE ON settlement_act_acceptances
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_ACCEPTANCE_IMMUTABLE'); END;

CREATE TRIGGER settlement_act_acceptances_delete_guard
BEFORE DELETE ON settlement_act_acceptances
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_ACCEPTANCE_IMMUTABLE'); END;

CREATE TABLE settlement_act_disputes (
  id TEXT PRIMARY KEY,
  act_id TEXT NOT NULL UNIQUE REFERENCES settlement_acts(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  reason TEXT NOT NULL CHECK (reason IN ('AMOUNT_INCORRECT', 'PARTNER_DETAILS_INCORRECT', 'SERVICE_NOT_RENDERED', 'OTHER')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER settlement_act_disputes_relational_consistency_guard
BEFORE INSERT ON settlement_act_disputes
WHEN (NOT EXISTS (
  SELECT 1 FROM settlement_acts a WHERE a.id = NEW.act_id AND a.presented_at IS NOT NULL AND a.partner_identity_id = NEW.partner_identity_id
))
OR EXISTS (SELECT 1 FROM settlement_act_acceptances acc WHERE acc.act_id = NEW.act_id)
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_DISPUTE_INVALID'); END;

CREATE TRIGGER settlement_act_disputes_immutable_guard
BEFORE UPDATE ON settlement_act_disputes
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_DISPUTE_IMMUTABLE'); END;

CREATE TRIGGER settlement_act_disputes_delete_guard
BEFORE DELETE ON settlement_act_disputes
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_DISPUTE_IMMUTABLE'); END;

CREATE TABLE npd_status_checks (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'UNKNOWN')),
  checked_at TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (partner_identity_id, sequence)
);

CREATE INDEX npd_status_checks_partner_idx ON npd_status_checks(partner_identity_id, sequence);

CREATE TRIGGER npd_status_checks_immutable_guard BEFORE UPDATE ON npd_status_checks BEGIN SELECT RAISE(ABORT, 'NPD_STATUS_CHECK_IMMUTABLE'); END;

CREATE TRIGGER npd_status_checks_delete_guard BEFORE DELETE ON npd_status_checks BEGIN SELECT RAISE(ABORT, 'NPD_STATUS_CHECK_IMMUTABLE'); END;

CREATE TABLE payment_authorizations (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  act_id TEXT NOT NULL REFERENCES settlement_acts(id),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  payout_profile_revision_id TEXT NOT NULL REFERENCES payout_profile_revisions(id),
  npd_status_check_id TEXT REFERENCES npd_status_checks(id),
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX payment_authorizations_settlement_idx ON payment_authorizations(settlement_id);

CREATE TRIGGER payment_authorizations_relational_consistency_guard
BEFORE INSERT ON payment_authorizations
WHEN NOT (
  EXISTS (
    SELECT 1 FROM reward_settlements rs
    WHERE rs.id = NEW.settlement_id
      AND rs.amount_kopecks = NEW.amount_kopecks
      AND rs.payout_profile_revision_id = NEW.payout_profile_revision_id
      AND rs.status = 'PREPARED'
      AND NOT EXISTS (SELECT 1 FROM reward_settlements later WHERE later.supersedes_settlement_id = rs.id)
      AND rs.effective_reward_snapshot_id = (
        SELECT id FROM engagement_effective_reward_snapshots
        WHERE engagement_id = rs.engagement_id
        ORDER BY sequence DESC LIMIT 1
      )
      AND (
        (rs.tax_mode_snapshot = 'NPD' AND NEW.npd_status_check_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM npd_status_checks c
            WHERE c.id = NEW.npd_status_check_id AND c.status = 'ACTIVE' AND c.partner_identity_id = rs.partner_identity_id
              AND c.sequence = (SELECT MAX(sequence) FROM npd_status_checks WHERE partner_identity_id = rs.partner_identity_id)
              AND (julianday('now') - julianday(c.checked_at)) * 86400000 <= 14400000
              AND (julianday('now') - julianday(c.checked_at)) * 86400000 >= 0
          ))
        OR (rs.tax_mode_snapshot = 'OTHER' AND NEW.npd_status_check_id IS NULL)
      )
  )
  AND EXISTS (
    SELECT 1 FROM settlement_acts a
    WHERE a.id = NEW.act_id AND a.settlement_id = NEW.settlement_id AND a.presented_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM settlement_act_acceptances acc WHERE acc.act_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM settlement_act_disputes d WHERE d.act_id = a.id)
  )
  AND EXISTS (
    SELECT 1 FROM payout_profile_revisions ppr
    WHERE ppr.id = NEW.payout_profile_revision_id AND ppr.kind = 'ACTIVE_DESTINATION'
      AND ppr.revision = (SELECT MAX(revision) FROM payout_profile_revisions WHERE partner_identity_id = ppr.partner_identity_id)
  )
)
BEGIN SELECT RAISE(ABORT, 'PAYMENT_AUTHORIZATION_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER payment_authorizations_immutable_guard BEFORE UPDATE ON payment_authorizations BEGIN SELECT RAISE(ABORT, 'PAYMENT_AUTHORIZATION_IMMUTABLE'); END;

CREATE TRIGGER payment_authorizations_delete_guard BEFORE DELETE ON payment_authorizations BEGIN SELECT RAISE(ABORT, 'PAYMENT_AUTHORIZATION_IMMUTABLE'); END;

CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY,
  payment_authorization_id TEXT NOT NULL UNIQUE REFERENCES payment_authorizations(id),
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'MADE', 'PAYOUT_UNKNOWN', 'CONFIRMED_NOT_MADE')),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  made_at TEXT,
  payout_unknown_at TEXT,
  confirmed_not_made_at TEXT,
  evidence_ref TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The exact shape per state, not merely "the right timestamp is set":
  -- IN_PROGRESS carries no outcome evidence of any kind yet; every
  -- terminal-ish state requires a non-EMPTY (not merely non-NULL)
  -- evidence_ref via trim(), and forbids the timestamp of the state it
  -- is NOT (a row can never simultaneously claim MADE and
  -- CONFIRMED_NOT_MADE timestamps). payout_unknown_at is deliberately
  -- NOT forced to NULL for MADE/CONFIRMED_NOT_MADE: both real edges
  -- (IN_PROGRESS -> X directly, or IN_PROGRESS -> PAYOUT_UNKNOWN -> X)
  -- are legal per payment_attempts_transition_legality_guard, so a
  -- MADE/CONFIRMED_NOT_MADE row may legitimately carry a payout_unknown_at
  -- left over from an earlier PAYOUT_UNKNOWN stop on its own path.
  CHECK (
    (status = 'IN_PROGRESS' AND made_at IS NULL AND payout_unknown_at IS NULL AND confirmed_not_made_at IS NULL AND evidence_ref IS NULL)
    OR (status = 'MADE' AND made_at IS NOT NULL AND confirmed_not_made_at IS NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '')
    OR (status = 'PAYOUT_UNKNOWN' AND payout_unknown_at IS NOT NULL AND made_at IS NULL AND confirmed_not_made_at IS NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '')
    OR (status = 'CONFIRMED_NOT_MADE' AND confirmed_not_made_at IS NOT NULL AND made_at IS NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '')
  )
);

CREATE UNIQUE INDEX payment_attempts_active_unique
  ON payment_attempts(settlement_id) WHERE status != 'CONFIRMED_NOT_MADE';

CREATE INDEX payment_attempts_settlement_idx ON payment_attempts(settlement_id);

CREATE TRIGGER payment_attempts_relational_consistency_guard
BEFORE INSERT ON payment_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM payment_authorizations pa
  WHERE pa.id = NEW.payment_authorization_id AND pa.settlement_id = NEW.settlement_id AND pa.amount_kopecks = NEW.amount_kopecks
)
BEGIN SELECT RAISE(ABORT, 'PAYMENT_ATTEMPT_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER payment_attempts_identity_immutable_guard
BEFORE UPDATE ON payment_attempts
WHEN NEW.id IS NOT OLD.id OR NEW.payment_authorization_id IS NOT OLD.payment_authorization_id
  OR NEW.settlement_id IS NOT OLD.settlement_id OR NEW.amount_kopecks IS NOT OLD.amount_kopecks
  OR NEW.started_at IS NOT OLD.started_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'PAYMENT_ATTEMPT_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER payment_attempts_terminal_immutable_guard
BEFORE UPDATE ON payment_attempts
WHEN OLD.status = 'MADE' OR OLD.status = 'CONFIRMED_NOT_MADE'
BEGIN SELECT RAISE(ABORT, 'PAYMENT_ATTEMPT_TERMINAL_IMMUTABLE'); END;

CREATE TRIGGER payment_attempts_transition_legality_guard
BEFORE UPDATE ON payment_attempts
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('MADE', 'PAYOUT_UNKNOWN', 'CONFIRMED_NOT_MADE'))
  OR (OLD.status = 'PAYOUT_UNKNOWN' AND NEW.status IN ('MADE', 'CONFIRMED_NOT_MADE'))
)
BEGIN SELECT RAISE(ABORT, 'PAYMENT_ATTEMPT_TRANSITION_ILLEGAL'); END;

CREATE TRIGGER payment_attempts_delete_guard
BEFORE DELETE ON payment_attempts
BEGIN SELECT RAISE(ABORT, 'PAYMENT_ATTEMPT_IMMUTABLE'); END;

CREATE TABLE npd_receipts (
  id TEXT PRIMARY KEY,
  payment_attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts(id),
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  receipt_reference TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER npd_receipts_relational_consistency_guard
BEFORE INSERT ON npd_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM payment_attempts pat
  JOIN reward_settlements rs ON rs.id = pat.settlement_id
  WHERE pat.id = NEW.payment_attempt_id AND pat.status = 'MADE' AND pat.settlement_id = NEW.settlement_id
    AND rs.tax_mode_snapshot = 'NPD'
)
BEGIN SELECT RAISE(ABORT, 'NPD_RECEIPT_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER npd_receipts_immutable_guard BEFORE UPDATE ON npd_receipts BEGIN SELECT RAISE(ABORT, 'NPD_RECEIPT_IMMUTABLE'); END;

CREATE TRIGGER npd_receipts_delete_guard BEFORE DELETE ON npd_receipts BEGIN SELECT RAISE(ABORT, 'NPD_RECEIPT_IMMUTABLE'); END;

CREATE TABLE engagement_zero_reward_closures (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL UNIQUE REFERENCES engagements(id),
  engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  base_registry_snapshot_id TEXT NOT NULL REFERENCES engagement_reward_registry_snapshot(id),
  effective_reward_snapshot_id TEXT NOT NULL REFERENCES engagement_effective_reward_snapshots(id),
  reward_total_kopecks INTEGER NOT NULL CHECK (reward_total_kopecks = 0),
  closure_reason TEXT NOT NULL CHECK (closure_reason IN ('NO_ELIGIBLE_CONVERSIONS', 'FULLY_REFUNDED', 'OCCURRENCE_CANCELLED', 'OTHER_POLICY_ZERO', 'CORRECTED_TO_ZERO')),
  occurrence_fulfillment_status TEXT NOT NULL CHECK (occurrence_fulfillment_status IN ('COMPLETED', 'CANCELLED')),
  service_period_start_at TEXT NOT NULL,
  service_period_end_at TEXT NOT NULL,
  reporting_policy_version INTEGER NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  canonical_hash TEXT NOT NULL,
  closed_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER engagement_zero_reward_closures_relational_consistency_guard
BEFORE INSERT ON engagement_zero_reward_closures
WHEN NOT (
  EXISTS (
    SELECT 1 FROM engagement_effective_reward_snapshots e
    WHERE e.id = NEW.effective_reward_snapshot_id AND e.engagement_id = NEW.engagement_id
      AND e.engagement_revision_id = NEW.engagement_revision_id AND e.base_registry_snapshot_id = NEW.base_registry_snapshot_id
      AND e.reward_total_kopecks = 0
  )
  AND EXISTS (SELECT 1 FROM engagement_reward_registry_snapshot r WHERE r.id = NEW.base_registry_snapshot_id AND r.engagement_id = NEW.engagement_id)
  AND NOT EXISTS (
    SELECT 1 FROM reward_settlements rs
    WHERE rs.engagement_id = NEW.engagement_id AND rs.status != 'CANCELLED_BEFORE_PAYMENT'
  )
)
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_ZERO_REWARD_CLOSURE_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER engagement_zero_reward_closures_immutable_guard BEFORE UPDATE ON engagement_zero_reward_closures BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_ZERO_REWARD_CLOSURE_IMMUTABLE'); END;

CREATE TRIGGER engagement_zero_reward_closures_delete_guard BEFORE DELETE ON engagement_zero_reward_closures BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_ZERO_REWARD_CLOSURE_IMMUTABLE'); END;

CREATE TABLE engagement_recovery_exposure_evidence (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  effective_reward_snapshot_id TEXT NOT NULL UNIQUE REFERENCES engagement_effective_reward_snapshots(id),
  paid_net_kopecks INTEGER NOT NULL CHECK (paid_net_kopecks >= 0),
  exposure_kopecks INTEGER NOT NULL CHECK (exposure_kopecks >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX engagement_recovery_exposure_evidence_engagement_idx ON engagement_recovery_exposure_evidence(engagement_id, created_at);

CREATE TRIGGER engagement_recovery_exposure_evidence_relational_consistency_guard
BEFORE INSERT ON engagement_recovery_exposure_evidence
WHEN NOT (
  EXISTS (SELECT 1 FROM reward_settlements rs WHERE rs.id = NEW.settlement_id AND rs.engagement_id = NEW.engagement_id)
  AND EXISTS (SELECT 1 FROM engagement_effective_reward_snapshots e WHERE e.id = NEW.effective_reward_snapshot_id AND e.engagement_id = NEW.engagement_id AND e.kind = 'CORRECTION')
  AND EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.settlement_id = NEW.settlement_id AND pa.status = 'MADE')
)
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_RECOVERY_EXPOSURE_EVIDENCE_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER engagement_recovery_exposure_evidence_immutable_guard BEFORE UPDATE ON engagement_recovery_exposure_evidence BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_RECOVERY_EXPOSURE_EVIDENCE_IMMUTABLE'); END;

CREATE TRIGGER engagement_recovery_exposure_evidence_delete_guard BEFORE DELETE ON engagement_recovery_exposure_evidence BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_RECOVERY_EXPOSURE_EVIDENCE_IMMUTABLE'); END;

CREATE TABLE ord_provider_profile_revisions (
  id TEXT PRIMARY KEY,
  profile_kind TEXT NOT NULL CHECK (profile_kind IN ('COUNTERPARTY', 'PLATFORM', 'CONTRACT', 'MEDIA')),
  revision INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES ord_provider_profile_revisions(id),
  reason TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (profile_kind, revision),
  CHECK ((revision = 1) = (supersedes_revision_id IS NULL))
);

CREATE TRIGGER ord_provider_profile_revisions_immutable_guard
BEFORE UPDATE ON ord_provider_profile_revisions
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_PROFILE_REVISION_IMMUTABLE'); END;

CREATE TRIGGER ord_provider_profile_revisions_delete_guard
BEFORE DELETE ON ord_provider_profile_revisions
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_PROFILE_REVISION_IMMUTABLE'); END;

CREATE TRIGGER ord_provider_profile_revisions_lineage_guard
BEFORE INSERT ON ord_provider_profile_revisions
WHEN NEW.revision > 1 AND NOT EXISTS (
  SELECT 1 FROM ord_provider_profile_revisions prev WHERE prev.id = NEW.supersedes_revision_id AND prev.profile_kind = NEW.profile_kind AND prev.revision = NEW.revision - 1
)
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_PROFILE_REVISION_LINEAGE_INCONSISTENT'); END;

CREATE TABLE ord_reporting_period_policy (
  id TEXT PRIMARY KEY,
  format_kind TEXT NOT NULL CHECK (format_kind IN ('post', 'story', 'short_video', 'long_video', 'stream', 'audio', 'text', 'graphic', 'text_graphic', 'native_authored')),
  policy_revision INTEGER NOT NULL,
  reporting_basis TEXT NOT NULL CHECK (reporting_basis IN ('CALENDAR_MONTH', 'PROVIDER_SPECIAL_PERIOD')),
  effective_from TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (format_kind, policy_revision)
);

CREATE INDEX ord_reporting_period_policy_effective_idx ON ord_reporting_period_policy(format_kind, effective_from);

CREATE TRIGGER ord_reporting_period_policy_immutable_guard
BEFORE UPDATE ON ord_reporting_period_policy
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_PERIOD_POLICY_IMMUTABLE'); END;

CREATE TRIGGER ord_reporting_period_policy_delete_guard
BEFORE DELETE ON ord_reporting_period_policy
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_PERIOD_POLICY_IMMUTABLE'); END;

CREATE TABLE ord_provider_operations (
  id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('COUNTERPARTY', 'PLATFORM', 'CONTRACT', 'MEDIA')),
  revision INTEGER NOT NULL,
  supersedes_operation_id TEXT REFERENCES ord_provider_operations(id),
  provider_profile_revision_id TEXT NOT NULL REFERENCES ord_provider_profile_revisions(id),
  operation_key TEXT NOT NULL UNIQUE,
  local_state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (local_state IN ('DRAFT', 'SUBMITTED', 'CONFIRMED')),
  vk_submission_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (vk_submission_state IN ('NOT_SUBMITTED', 'SUBMITTED', 'SUBMIT_FAILED')),
  vk_external_id TEXT,
  erir_code TEXT,
  erir_evidence_ref TEXT,
  evidence_ref TEXT,
  lock_state TEXT NOT NULL DEFAULT 'MUTABLE' CHECK (lock_state IN ('MUTABLE', 'CORRECTION_ONLY', 'EXTERNALLY_LOCKED')),
  correction_reason TEXT,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (operation_kind, revision),
  CHECK ((revision = 1) = (supersedes_operation_id IS NULL)),
  CHECK (revision = 1 OR correction_reason IS NOT NULL),
  -- Exact per-state shape (P0.6-style rigor, applied here too): DRAFT
  -- carries no observed/evidence facts at all and is always MUTABLE;
  -- SUBMITTED/CONFIRMED both require a real, non-empty evidence_ref and a
  -- real vk_external_id - "submitted" is never representable without
  -- durable provenance. Only CONFIRMED may leave MUTABLE.
  CHECK (
    (local_state = 'DRAFT' AND vk_submission_state IN ('NOT_SUBMITTED', 'SUBMIT_FAILED') AND vk_external_id IS NULL AND evidence_ref IS NULL AND lock_state = 'MUTABLE')
    OR (local_state = 'SUBMITTED' AND vk_submission_state = 'SUBMITTED' AND vk_external_id IS NOT NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '' AND lock_state = 'MUTABLE')
    OR (local_state = 'CONFIRMED' AND vk_submission_state = 'SUBMITTED' AND vk_external_id IS NOT NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '' AND lock_state IN ('CORRECTION_ONLY', 'EXTERNALLY_LOCKED'))
  ),
  -- ERIR reconciliation evidence (round-3 P0.4): independent of local/VK
  -- submission state, but never representable without its OWN durable
  -- provenance - a code with no evidence is exactly as unproven as a
  -- nullable external id merely existing.
  CHECK ((erir_code IS NULL) = (erir_evidence_ref IS NULL)) ,
  CHECK (erir_evidence_ref IS NULL OR trim(erir_evidence_ref) != ''),
  -- ERIR can only ever be recorded once a real submission is on file - DRAFT
  -- (never yet told VK anything) can never carry a reconciliation fact.
  CHECK (local_state != 'DRAFT' OR erir_code IS NULL)
);

CREATE INDEX ord_provider_operations_kind_idx ON ord_provider_operations(operation_kind, revision);

CREATE TRIGGER ord_provider_operations_relational_consistency_guard
BEFORE INSERT ON ord_provider_operations
WHEN (NEW.revision > 1 AND NOT EXISTS (
  SELECT 1 FROM ord_provider_operations prev WHERE prev.id = NEW.supersedes_operation_id AND prev.operation_kind = NEW.operation_kind AND prev.revision = NEW.revision - 1 AND prev.lock_state = 'CORRECTION_ONLY'
))
OR NOT EXISTS (
  SELECT 1 FROM ord_provider_profile_revisions p
  WHERE p.id = NEW.provider_profile_revision_id AND p.profile_kind = NEW.operation_kind
    AND p.revision = (SELECT MAX(revision) FROM ord_provider_profile_revisions WHERE profile_kind = NEW.operation_kind)
)
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER ord_provider_operations_terminal_immutable_guard
BEFORE UPDATE ON ord_provider_operations
WHEN OLD.lock_state = 'EXTERNALLY_LOCKED'
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_TERMINAL_IMMUTABLE'); END;

CREATE TRIGGER ord_provider_operations_correction_only_guard
BEFORE UPDATE ON ord_provider_operations
WHEN OLD.lock_state = 'CORRECTION_ONLY' AND (
  NEW.local_state IS NOT OLD.local_state OR NEW.vk_submission_state IS NOT OLD.vk_submission_state OR NEW.vk_external_id IS NOT OLD.vk_external_id
  OR NEW.evidence_ref IS NOT OLD.evidence_ref OR (NEW.lock_state NOT IN ('CORRECTION_ONLY', 'EXTERNALLY_LOCKED'))
)
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_CORRECTION_ONLY'); END;

CREATE TRIGGER ord_provider_operations_authority_immutable_guard
BEFORE UPDATE ON ord_provider_operations
WHEN NEW.operation_kind IS NOT OLD.operation_kind OR NEW.revision IS NOT OLD.revision OR NEW.supersedes_operation_id IS NOT OLD.supersedes_operation_id
  OR NEW.provider_profile_revision_id IS NOT OLD.provider_profile_revision_id OR NEW.operation_key IS NOT OLD.operation_key OR NEW.created_by_admin_id IS NOT OLD.created_by_admin_id
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_AUTHORITY_COLUMNS_IMMUTABLE'); END;

CREATE TRIGGER ord_provider_operations_observed_id_immutable_guard
BEFORE UPDATE ON ord_provider_operations
WHEN (OLD.vk_external_id IS NOT NULL AND NEW.vk_external_id IS NOT OLD.vk_external_id)
  OR (OLD.erir_code IS NOT NULL AND NEW.erir_code IS NOT OLD.erir_code)
  OR (OLD.erir_evidence_ref IS NOT NULL AND NEW.erir_evidence_ref IS NOT OLD.erir_evidence_ref)
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_OBSERVED_ID_IMMUTABLE'); END;

CREATE TRIGGER ord_provider_operations_lock_requires_current_guard
BEFORE UPDATE ON ord_provider_operations
WHEN NEW.lock_state = 'EXTERNALLY_LOCKED' AND OLD.lock_state != 'EXTERNALLY_LOCKED' AND EXISTS (
  SELECT 1 FROM ord_provider_operations newer WHERE newer.operation_kind = OLD.operation_kind AND newer.revision > OLD.revision
)
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_LOCK_REQUIRES_CURRENT'); END;

CREATE TRIGGER ord_provider_operations_delete_guard
BEFORE DELETE ON ord_provider_operations
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_IMMUTABLE'); END;

CREATE TABLE ord_creative_registrations (
  id TEXT PRIMARY KEY,
  creative_revision_id TEXT NOT NULL REFERENCES engagement_creative_revisions(id),
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  revision INTEGER NOT NULL,
  supersedes_registration_id TEXT REFERENCES ord_creative_registrations(id),
  operation_key TEXT NOT NULL UNIQUE,
  provider_counterparty_profile_id TEXT NOT NULL REFERENCES ord_provider_profile_revisions(id),
  provider_contract_profile_id TEXT NOT NULL REFERENCES ord_provider_profile_revisions(id),
  registered_creative_target_url TEXT NOT NULL,
  local_state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (local_state IN ('DRAFT', 'SUBMITTED', 'CONFIRMED')),
  vk_submission_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (vk_submission_state IN ('NOT_SUBMITTED', 'SUBMITTED', 'SUBMIT_FAILED')),
  vk_external_id TEXT,
  vk_object_id TEXT,
  erid TEXT,
  erir_code TEXT,
  erir_evidence_ref TEXT,
  evidence_ref TEXT,
  lock_state TEXT NOT NULL DEFAULT 'MUTABLE' CHECK (lock_state IN ('MUTABLE', 'CORRECTION_ONLY', 'EXTERNALLY_LOCKED')),
  correction_reason TEXT,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (creative_revision_id, revision),
  CHECK ((revision = 1) = (supersedes_registration_id IS NULL)),
  CHECK (revision = 1 OR correction_reason IS NOT NULL),
  -- Exact per-state shape (P0.3): CONFIRMED is the ONLY state
  -- CREATIVE_READY_TO_PUBLISH's provider half may ever accept, and it now
  -- structurally REQUIRES vk_submission_state = SUBMITTED and real
  -- evidence - "confirmed with an ERID but VK was never actually told"
  -- (the exact P0.3 counterexample) is no longer representable.
  CHECK (
    (local_state = 'DRAFT' AND vk_submission_state IN ('NOT_SUBMITTED', 'SUBMIT_FAILED') AND vk_external_id IS NULL AND vk_object_id IS NULL AND erid IS NULL AND evidence_ref IS NULL AND lock_state = 'MUTABLE')
    OR (local_state = 'SUBMITTED' AND vk_submission_state = 'SUBMITTED' AND vk_external_id IS NOT NULL AND vk_object_id IS NULL AND erid IS NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '' AND lock_state = 'MUTABLE')
    OR (local_state = 'CONFIRMED' AND vk_submission_state = 'SUBMITTED' AND vk_external_id IS NOT NULL AND vk_object_id IS NOT NULL AND erid IS NOT NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '' AND lock_state IN ('CORRECTION_ONLY', 'EXTERNALLY_LOCKED'))
  ),
  -- ERIR reconciliation evidence (round-3 P0.4) - never representable
  -- without its own durable provenance, and never before a real submission
  -- is on file (DRAFT can never carry a reconciliation fact).
  CHECK ((erir_code IS NULL) = (erir_evidence_ref IS NULL)),
  CHECK (erir_evidence_ref IS NULL OR trim(erir_evidence_ref) != ''),
  CHECK (local_state != 'DRAFT' OR erir_code IS NULL)
);

CREATE INDEX ord_creative_registrations_engagement_idx ON ord_creative_registrations(engagement_id);

CREATE TRIGGER ord_creative_registrations_relational_consistency_guard
BEFORE INSERT ON ord_creative_registrations
WHEN NOT EXISTS (
  SELECT 1 FROM engagement_creative_revisions ecr
  WHERE ecr.id = NEW.creative_revision_id AND ecr.engagement_id = NEW.engagement_id AND ecr.creative_target_url = NEW.registered_creative_target_url
)
OR (NEW.revision > 1 AND NOT EXISTS (
  SELECT 1 FROM ord_creative_registrations prev WHERE prev.id = NEW.supersedes_registration_id AND prev.creative_revision_id = NEW.creative_revision_id AND prev.revision = NEW.revision - 1 AND prev.lock_state = 'CORRECTION_ONLY'
))
OR NOT EXISTS (
  SELECT 1 FROM ord_provider_profile_revisions p WHERE p.id = NEW.provider_counterparty_profile_id AND p.profile_kind = 'COUNTERPARTY'
    AND p.revision = (SELECT MAX(revision) FROM ord_provider_profile_revisions WHERE profile_kind = 'COUNTERPARTY')
)
OR NOT EXISTS (
  SELECT 1 FROM ord_provider_profile_revisions p WHERE p.id = NEW.provider_contract_profile_id AND p.profile_kind = 'CONTRACT'
    AND p.revision = (SELECT MAX(revision) FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT')
)
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER ord_creative_registrations_terminal_immutable_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN OLD.lock_state = 'EXTERNALLY_LOCKED'
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_TERMINAL_IMMUTABLE'); END;

CREATE TRIGGER ord_creative_registrations_correction_only_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN OLD.lock_state = 'CORRECTION_ONLY' AND (
  NEW.local_state IS NOT OLD.local_state OR NEW.vk_submission_state IS NOT OLD.vk_submission_state OR NEW.vk_external_id IS NOT OLD.vk_external_id
  OR NEW.vk_object_id IS NOT OLD.vk_object_id OR NEW.erid IS NOT OLD.erid OR NEW.evidence_ref IS NOT OLD.evidence_ref
  OR (NEW.lock_state NOT IN ('CORRECTION_ONLY', 'EXTERNALLY_LOCKED'))
)
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_CORRECTION_ONLY'); END;

CREATE TRIGGER ord_creative_registrations_authority_immutable_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN NEW.creative_revision_id IS NOT OLD.creative_revision_id
  OR NEW.engagement_id IS NOT OLD.engagement_id
  OR NEW.revision IS NOT OLD.revision
  OR NEW.supersedes_registration_id IS NOT OLD.supersedes_registration_id
  OR NEW.operation_key IS NOT OLD.operation_key
  OR NEW.provider_counterparty_profile_id IS NOT OLD.provider_counterparty_profile_id
  OR NEW.provider_contract_profile_id IS NOT OLD.provider_contract_profile_id
  OR NEW.registered_creative_target_url IS NOT OLD.registered_creative_target_url
  OR NEW.created_by_admin_id IS NOT OLD.created_by_admin_id
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_AUTHORITY_COLUMNS_IMMUTABLE'); END;

CREATE TRIGGER ord_creative_registrations_observed_ids_immutable_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN (OLD.vk_external_id IS NOT NULL AND NEW.vk_external_id IS NOT OLD.vk_external_id)
  OR (OLD.vk_object_id IS NOT NULL AND NEW.vk_object_id IS NOT OLD.vk_object_id)
  OR (OLD.erid IS NOT NULL AND NEW.erid IS NOT OLD.erid)
  OR (OLD.erir_code IS NOT NULL AND NEW.erir_code IS NOT OLD.erir_code)
  OR (OLD.erir_evidence_ref IS NOT NULL AND NEW.erir_evidence_ref IS NOT OLD.erir_evidence_ref)
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_OBSERVED_ID_IMMUTABLE'); END;

CREATE TRIGGER ord_creative_registrations_lock_requires_current_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN NEW.lock_state = 'EXTERNALLY_LOCKED' AND OLD.lock_state != 'EXTERNALLY_LOCKED' AND EXISTS (
  SELECT 1 FROM ord_creative_registrations newer WHERE newer.creative_revision_id = OLD.creative_revision_id AND newer.revision > OLD.revision
)
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_LOCK_REQUIRES_CURRENT'); END;

CREATE TRIGGER ord_creative_registrations_delete_guard
BEFORE DELETE ON ord_creative_registrations
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_IMMUTABLE'); END;

CREATE TABLE ord_distribution_period_reports (
  id TEXT PRIMARY KEY,
  distribution_id TEXT NOT NULL REFERENCES engagement_distributions(id),
  distribution_revision_id TEXT NOT NULL REFERENCES engagement_distribution_revisions(id),
  reporting_basis TEXT NOT NULL CHECK (reporting_basis IN ('CALENDAR_MONTH', 'PROVIDER_SPECIAL_PERIOD')),
  reporting_period_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  supersedes_report_id TEXT REFERENCES ord_distribution_period_reports(id),
  statistics_state TEXT NOT NULL CHECK (statistics_state IN ('ACTUAL', 'REPORTING_DATA_UNAVAILABLE')),
  statistics_json TEXT,
  review_required INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN statistics_state = 'REPORTING_DATA_UNAVAILABLE' THEN 1 ELSE 0 END) STORED,
  statistics_reason TEXT NOT NULL DEFAULT 'ORDINARY' CHECK (statistics_reason IN ('ORDINARY', 'ZERO_REWARD_STATISTICS', 'CONTINUING_STATISTICS')),
  zero_reward_closure_id TEXT REFERENCES engagement_zero_reward_closures(id),
  operation_key TEXT NOT NULL UNIQUE,
  evidence_ref TEXT NOT NULL,
  submission_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (submission_state IN ('NOT_SUBMITTED', 'SUBMITTED', 'SUBMIT_FAILED')),
  vk_operation_external_id TEXT,
  erir_code TEXT,
  submission_evidence_ref TEXT,
  correction_reason TEXT,
  canonical_hash TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (distribution_id, reporting_period_key, revision),
  CHECK (revision = 1 OR correction_reason IS NOT NULL),
  CHECK ((revision = 1) = (supersedes_report_id IS NULL)),
  CHECK (
    (statistics_state = 'ACTUAL' AND statistics_json IS NOT NULL)
    OR (statistics_state = 'REPORTING_DATA_UNAVAILABLE' AND statistics_json IS NULL)
  ),
  CHECK (
    (statistics_reason = 'ORDINARY' AND zero_reward_closure_id IS NULL)
    OR (statistics_reason IN ('ZERO_REWARD_STATISTICS', 'CONTINUING_STATISTICS') AND zero_reward_closure_id IS NOT NULL)
  ),
  CHECK (
    (submission_state = 'NOT_SUBMITTED' AND vk_operation_external_id IS NULL AND erir_code IS NULL AND submission_evidence_ref IS NULL)
    OR (submission_state = 'SUBMIT_FAILED' AND vk_operation_external_id IS NULL AND erir_code IS NULL)
    OR (submission_state = 'SUBMITTED' AND vk_operation_external_id IS NOT NULL AND erir_code IS NOT NULL AND submission_evidence_ref IS NOT NULL AND trim(submission_evidence_ref) != '')
  )
);

CREATE INDEX ord_distribution_period_reports_distribution_idx ON ord_distribution_period_reports(distribution_id, reporting_period_key, revision);

CREATE INDEX ord_distribution_period_reports_zero_reward_idx ON ord_distribution_period_reports(zero_reward_closure_id);

CREATE INDEX ord_distribution_period_reports_review_required_idx ON ord_distribution_period_reports(distribution_id, review_required);

CREATE TRIGGER ord_distribution_period_reports_relational_consistency_guard
BEFORE INSERT ON ord_distribution_period_reports
WHEN NOT EXISTS (SELECT 1 FROM engagement_distribution_revisions edr WHERE edr.id = NEW.distribution_revision_id AND edr.distribution_id = NEW.distribution_id)
OR (NEW.revision > 1 AND NOT EXISTS (
  SELECT 1 FROM ord_distribution_period_reports prev
  WHERE prev.id = NEW.supersedes_report_id AND prev.distribution_id = NEW.distribution_id
    AND prev.reporting_period_key = NEW.reporting_period_key AND prev.revision = NEW.revision - 1
))
OR (NEW.zero_reward_closure_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM engagement_zero_reward_closures z JOIN engagement_distributions d ON d.engagement_id = z.engagement_id
  WHERE z.id = NEW.zero_reward_closure_id AND d.id = NEW.distribution_id
))
OR (NEW.statistics_reason IN ('ZERO_REWARD_STATISTICS', 'CONTINUING_STATISTICS') AND EXISTS (
  SELECT 1 FROM engagement_distributions d JOIN reward_settlements rs ON rs.engagement_id = d.engagement_id
  WHERE d.id = NEW.distribution_id AND rs.status != 'CANCELLED_BEFORE_PAYMENT'
))
BEGIN SELECT RAISE(ABORT, 'ORD_DISTRIBUTION_PERIOD_REPORT_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER ord_distribution_period_reports_immutable_guard
BEFORE UPDATE ON ord_distribution_period_reports
BEGIN SELECT RAISE(ABORT, 'ORD_DISTRIBUTION_PERIOD_REPORT_IMMUTABLE'); END;

CREATE TRIGGER ord_distribution_period_reports_delete_guard
BEFORE DELETE ON ord_distribution_period_reports
BEGIN SELECT RAISE(ABORT, 'ORD_DISTRIBUTION_PERIOD_REPORT_IMMUTABLE'); END;

CREATE TABLE ord_paid_invoice_payloads (
  id TEXT PRIMARY KEY,
  act_id TEXT NOT NULL UNIQUE REFERENCES settlement_acts(id),
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  accepted_amount_kopecks INTEGER NOT NULL CHECK (accepted_amount_kopecks > 0),
  accepted_engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  tax_mode_snapshot TEXT NOT NULL CHECK (tax_mode_snapshot IN ('NPD', 'OTHER')),
  legal_profile_revision_id_snapshot TEXT NOT NULL,
  contractor_type_snapshot TEXT NOT NULL,
  provider_contract_profile_id TEXT NOT NULL REFERENCES ord_provider_profile_revisions(id),
  operation_key TEXT NOT NULL UNIQUE,
  submission_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (submission_state IN ('NOT_SUBMITTED', 'SUBMITTED', 'SUBMIT_FAILED')),
  vk_operation_external_id TEXT,
  erir_code TEXT,
  evidence_ref TEXT,
  lock_state TEXT NOT NULL DEFAULT 'MUTABLE' CHECK (lock_state IN ('MUTABLE', 'EXTERNALLY_LOCKED')),
  canonical_hash TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, tax_treatment_revision_id_snapshot TEXT REFERENCES agent_referrals_tax_treatment_revisions(id), ord_participant_canonicalization_version TEXT, partner_participant_json TEXT, partner_participant_hash TEXT, tax_canonicalization_version TEXT, tax_canonical_json TEXT, tax_canonical_hash TEXT,
  -- Round-3 P1.1: four MUTUALLY EXCLUSIVE exact shapes, one per real state -
  -- not a loose "MUTABLE admits anything but SUBMITTED-without-evidence"
  -- branch, which still let raw SQL fabricate e.g. NOT_SUBMITTED with a
  -- populated vk_operation_external_id/erir_code, or SUBMIT_FAILED with
  -- external ids attached.
  CHECK (
    (lock_state = 'MUTABLE' AND submission_state = 'NOT_SUBMITTED' AND vk_operation_external_id IS NULL AND erir_code IS NULL AND evidence_ref IS NULL)
    OR (lock_state = 'MUTABLE' AND submission_state = 'SUBMIT_FAILED' AND vk_operation_external_id IS NULL AND erir_code IS NULL AND evidence_ref IS NULL)
    OR (lock_state = 'MUTABLE' AND submission_state = 'SUBMITTED' AND vk_operation_external_id IS NOT NULL AND erir_code IS NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '')
    OR (lock_state = 'EXTERNALLY_LOCKED' AND submission_state = 'SUBMITTED' AND vk_operation_external_id IS NOT NULL AND erir_code IS NOT NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '')
  )
);

CREATE TRIGGER ord_paid_invoice_payloads_terminal_immutable_guard
BEFORE UPDATE ON ord_paid_invoice_payloads
WHEN OLD.lock_state = 'EXTERNALLY_LOCKED'
BEGIN SELECT RAISE(ABORT, 'ORD_PAID_INVOICE_PAYLOAD_TERMINAL_IMMUTABLE'); END;

CREATE TRIGGER ord_paid_invoice_payloads_observed_id_immutable_guard
BEFORE UPDATE ON ord_paid_invoice_payloads
WHEN OLD.vk_operation_external_id IS NOT NULL AND NEW.vk_operation_external_id IS NOT OLD.vk_operation_external_id
BEGIN SELECT RAISE(ABORT, 'ORD_PAID_INVOICE_PAYLOAD_OBSERVED_ID_IMMUTABLE'); END;

CREATE TRIGGER ord_paid_invoice_payloads_delete_guard
BEFORE DELETE ON ord_paid_invoice_payloads
BEGIN SELECT RAISE(ABORT, 'ORD_PAID_INVOICE_PAYLOAD_IMMUTABLE'); END;

CREATE TRIGGER agent_referrals_feature_state_events_immutable_guard
BEFORE UPDATE ON agent_referrals_feature_state_events
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_FEATURE_STATE_EVENT_IMMUTABLE'); END;

CREATE TRIGGER agent_referrals_feature_state_events_delete_guard
BEFORE DELETE ON agent_referrals_feature_state_events
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_FEATURE_STATE_EVENT_IMMUTABLE'); END;

CREATE UNIQUE INDEX agent_referrals_feature_state_events_revision_unique
  ON agent_referrals_feature_state_events(revision);

CREATE TRIGGER agent_referrals_feature_state_events_lineage_guard
BEFORE INSERT ON agent_referrals_feature_state_events
WHEN NOT (
  NEW.from_state IN ('ACTIVE', 'SUSPENDED')
  AND NEW.to_state IN ('ACTIVE', 'SUSPENDED')
  AND (
    (NEW.from_state = 'ACTIVE' AND NEW.to_state = 'SUSPENDED')
    OR (NEW.from_state = 'SUSPENDED' AND NEW.to_state = 'ACTIVE')
  )
  AND (
    (NOT EXISTS (SELECT 1 FROM agent_referrals_feature_state_events) AND NEW.from_state = 'ACTIVE')
    OR EXISTS (
      SELECT 1 FROM agent_referrals_feature_state_events prev
      WHERE prev.revision = NEW.revision - 1 AND prev.to_state = NEW.from_state
    )
  )
  AND EXISTS (
    SELECT 1 FROM agent_referrals_feature_state s
    WHERE s.singleton = 1 AND s.revision = NEW.revision AND s.state = NEW.to_state
  )
)
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_FEATURE_STATE_EVENT_LINEAGE_INCONSISTENT'); END;

CREATE TRIGGER agent_referrals_activation_manifest_immutable_guard
BEFORE UPDATE ON agent_referrals_activation_manifest
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_ACTIVATION_MANIFEST_IMMUTABLE'); END;

CREATE TRIGGER agent_referrals_activation_manifest_delete_guard
BEFORE DELETE ON agent_referrals_activation_manifest
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_ACTIVATION_MANIFEST_IMMUTABLE'); END;

CREATE TABLE "agent_referrals_legal_profile_revisions" (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES partners(id),
  revision INTEGER NOT NULL,
  legal_form TEXT NOT NULL CHECK (legal_form IN ('INDIVIDUAL', 'INDIVIDUAL_ENTREPRENEUR', 'LEGAL_ENTITY')),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('NPD', 'OTHER')),
  projected_contractor_type TEXT NOT NULL CHECK (projected_contractor_type IN ('SELF_EMPLOYED', 'INDIVIDUAL_ENTREPRENEUR', 'ORGANIZATION')),
  -- Unified legal requisites (PR-E). Every one is an asserted fact, never
  -- derived from another field (full_name is never built from opf+
  -- short_name or vice versa) - see the shape/format CHECKs below for the
  -- exact per-legal_form matrix. TEXT throughout, including every
  -- identifier (inn/kpp/registration_number): these are never arithmetic
  -- values, and a leading zero is significant.
  opf TEXT,
  full_name TEXT NOT NULL,
  short_name TEXT,
  inn TEXT NOT NULL,
  kpp TEXT,
  registration_number TEXT,
  legal_address TEXT,
  supersedes_revision_id TEXT REFERENCES agent_referrals_legal_profile_revisions(id),
  reason TEXT NOT NULL,
  assertion_source TEXT NOT NULL CHECK (assertion_source IN ('PARTNER_ASSERTED', 'ADMIN_ASSERTED')),
  evidence_ref TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_id, revision),
  CHECK (
    (legal_form = 'INDIVIDUAL' AND tax_mode = 'NPD' AND projected_contractor_type = 'SELF_EMPLOYED')
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND tax_mode IN ('NPD', 'OTHER') AND projected_contractor_type = 'INDIVIDUAL_ENTREPRENEUR')
    OR (legal_form = 'LEGAL_ENTITY' AND tax_mode = 'OTHER' AND projected_contractor_type = 'ORGANIZATION')
  ),
  CHECK (evidence_ref IS NULL OR trim(evidence_ref, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (assertion_source = 'PARTNER_ASSERTED' OR (assertion_source = 'ADMIN_ASSERTED' AND evidence_ref IS NOT NULL)),
  -- Requisites SHAPE per legal_form: which fields this legal_form leaves
  -- NULL vs requires. INDIVIDUAL (self-employed/NPD individuals) and
  -- INDIVIDUAL_ENTREPRENEUR intentionally carry no legal_address requisite
  -- in PR-E - collecting a natural person's address is real PII with no
  -- concrete document/provider consumer yet, not schema symmetry for its
  -- own sake. short_name is the one OPTIONAL field, and only for
  -- LEGAL_ENTITY - no constraint names it structurally NULL/NOT NULL.
  CHECK (
    (legal_form = 'INDIVIDUAL' AND opf IS NULL AND short_name IS NULL AND kpp IS NULL AND registration_number IS NULL AND legal_address IS NULL)
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND opf IS NULL AND short_name IS NULL AND kpp IS NULL AND registration_number IS NOT NULL AND legal_address IS NULL)
    OR (legal_form = 'LEGAL_ENTITY' AND opf IS NOT NULL AND kpp IS NOT NULL AND registration_number IS NOT NULL AND legal_address IS NOT NULL)
  ),
  -- full_name is required for every legal_form (the registered full name /
  -- FIO), so this CHECK stands alone rather than folding into the shape
  -- CHECK above.
  CHECK (trim(full_name, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  -- A present-but-blank value is never accepted as "provided", matching
  -- the same evidence_ref discipline established in 0050/0051 - SQLite's
  -- single-argument trim() only strips ASCII space.
  CHECK (opf IS NULL OR trim(opf, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (short_name IS NULL OR trim(short_name, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (legal_address IS NULL OR trim(legal_address, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  -- INN: digits only, exact length by legal_form (12 for a natural
  -- person/individual entrepreneur, 10 for a legal entity - Russian tax
  -- identifier conventions).
  CHECK (
    (legal_form IN ('INDIVIDUAL', 'INDIVIDUAL_ENTREPRENEUR') AND length(inn) = 12 AND inn NOT GLOB '*[^0-9]*')
    OR (legal_form = 'LEGAL_ENTITY' AND length(inn) = 10 AND inn NOT GLOB '*[^0-9]*')
  ),
  -- KPP: digits only, exactly 9 - only ever present for LEGAL_ENTITY, and
  -- the shape CHECK above already makes it required there.
  CHECK (kpp IS NULL OR (length(kpp) = 9 AND kpp NOT GLOB '*[^0-9]*')),
  -- registration_number: digits only, exact length by legal_form (15 for
  -- an individual entrepreneur's OGRNIP, 13 for a legal entity's OGRN).
  CHECK (
    registration_number IS NULL
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND length(registration_number) = 15 AND registration_number NOT GLOB '*[^0-9]*')
    OR (legal_form = 'LEGAL_ENTITY' AND length(registration_number) = 13 AND registration_number NOT GLOB '*[^0-9]*')
  )
);

CREATE INDEX agent_referrals_legal_profile_revisions_agent_idx
  ON agent_referrals_legal_profile_revisions(agent_id, revision);

CREATE TRIGGER agent_referrals_legal_profile_revisions_immutable_guard
BEFORE UPDATE ON agent_referrals_legal_profile_revisions
BEGIN
  SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE');
END;

CREATE TRIGGER agent_referrals_legal_profile_revisions_delete_guard
BEFORE DELETE ON agent_referrals_legal_profile_revisions
BEGIN
  SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE');
END;

CREATE TRIGGER reward_settlements_contractor_type_projection_guard
BEFORE INSERT ON reward_settlements
WHEN NEW.legal_profile_revision_id_snapshot IS NOT NULL
  AND NEW.contractor_type_snapshot IS NOT (
    SELECT projected_contractor_type FROM agent_referrals_legal_profile_revisions
    WHERE id = NEW.legal_profile_revision_id_snapshot
  )
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_SETTLEMENT_CONTRACTOR_TYPE_PROJECTION_MISMATCH'); END;

CREATE TABLE agent_referrals_legal_profile_change_requests (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  legal_form TEXT NOT NULL CHECK (legal_form IN ('INDIVIDUAL', 'INDIVIDUAL_ENTREPRENEUR', 'LEGAL_ENTITY')),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('NPD', 'OTHER')),
  opf TEXT,
  full_name TEXT NOT NULL,
  short_name TEXT,
  inn TEXT NOT NULL,
  kpp TEXT,
  registration_number TEXT,
  legal_address TEXT,
  assertion_source TEXT NOT NULL CHECK (assertion_source IN ('PARTNER_ASSERTED', 'ADMIN_ASSERTED')),
  evidence_ref TEXT,
  reason TEXT NOT NULL,
  supersedes_revision_id TEXT NOT NULL REFERENCES agent_referrals_legal_profile_revisions(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'VERIFIED', 'REJECTED', 'STALE')),
  resolved_legal_profile_revision_id TEXT REFERENCES agent_referrals_legal_profile_revisions(id),
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_reason TEXT, request_sequence INTEGER NOT NULL DEFAULT 0,

  CHECK (
    (legal_form = 'INDIVIDUAL' AND tax_mode = 'NPD')
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND tax_mode IN ('NPD', 'OTHER'))
    OR (legal_form = 'LEGAL_ENTITY' AND tax_mode = 'OTHER')
  ),
  CHECK (evidence_ref IS NULL OR trim(evidence_ref, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (assertion_source = 'PARTNER_ASSERTED' OR (assertion_source = 'ADMIN_ASSERTED' AND evidence_ref IS NOT NULL)),
  CHECK (
    (state = 'PENDING' AND resolved_legal_profile_revision_id IS NULL AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_reason IS NULL)
    OR (state = 'VERIFIED' AND resolved_legal_profile_revision_id IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    OR (state IN ('REJECTED', 'STALE') AND resolved_legal_profile_revision_id IS NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_reason IS NOT NULL)
  ),
  CHECK (
    (legal_form = 'INDIVIDUAL' AND opf IS NULL AND short_name IS NULL AND kpp IS NULL AND registration_number IS NULL AND legal_address IS NULL)
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND opf IS NULL AND short_name IS NULL AND kpp IS NULL AND registration_number IS NOT NULL AND legal_address IS NULL)
    OR (legal_form = 'LEGAL_ENTITY' AND opf IS NOT NULL AND kpp IS NOT NULL AND registration_number IS NOT NULL AND legal_address IS NOT NULL)
  ),
  CHECK (trim(full_name, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (opf IS NULL OR trim(opf, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (short_name IS NULL OR trim(short_name, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (legal_address IS NULL OR trim(legal_address, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (
    (legal_form IN ('INDIVIDUAL', 'INDIVIDUAL_ENTREPRENEUR') AND length(inn) = 12 AND inn NOT GLOB '*[^0-9]*')
    OR (legal_form = 'LEGAL_ENTITY' AND length(inn) = 10 AND inn NOT GLOB '*[^0-9]*')
  ),
  CHECK (kpp IS NULL OR (length(kpp) = 9 AND kpp NOT GLOB '*[^0-9]*')),
  CHECK (
    registration_number IS NULL
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND length(registration_number) = 15 AND registration_number NOT GLOB '*[^0-9]*')
    OR (legal_form = 'LEGAL_ENTITY' AND length(registration_number) = 13 AND registration_number NOT GLOB '*[^0-9]*')
  )
);

CREATE INDEX agent_referrals_legal_profile_change_requests_partner_idx
  ON agent_referrals_legal_profile_change_requests(partner_identity_id, created_at);

CREATE UNIQUE INDEX agent_referrals_legal_profile_change_requests_pending_unique
  ON agent_referrals_legal_profile_change_requests(partner_identity_id) WHERE state = 'PENDING';

CREATE TRIGGER agent_referrals_legal_profile_change_requests_terminal_immutable_guard
BEFORE UPDATE ON agent_referrals_legal_profile_change_requests
WHEN OLD.state != 'PENDING'
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE'); END;

CREATE TRIGGER agent_referrals_legal_profile_change_requests_pending_reentry_guard
BEFORE UPDATE ON agent_referrals_legal_profile_change_requests
WHEN OLD.state = 'PENDING' AND NEW.state = 'PENDING'
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE'); END;

CREATE TRIGGER agent_referrals_legal_profile_change_requests_delete_guard
BEFORE DELETE ON agent_referrals_legal_profile_change_requests
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE'); END;

CREATE TABLE agent_referrals_tax_treatment_revisions (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  -- The EXACT legal-profile revision this treatment describes - never
  -- "whichever profile is current when read". A legal-profile supersession
  -- never carries a treatment forward: the new revision starts with zero
  -- treatment rows of its own until a fresh SYSTEM_DERIVED NPD mint or an
  -- explicit ADMIN_ASSERTED record names it.
  legal_profile_revision_id TEXT NOT NULL REFERENCES agent_referrals_legal_profile_revisions(id),
  -- Append-only correction/business ordering, scoped per partner (not per
  -- legal_profile_revision_id) - mirrors agent_referrals_legal_profile_
  -- revisions' own revision counter, but a single monotonic sequence is
  -- simpler here since resolution always filters by legal_profile_revision_id
  -- first anyway (see the resolver's own WHERE clause), so cross-revision
  -- sequence numbers never need to be contiguous or compared to each other.
  sequence INTEGER NOT NULL,
  tax_system TEXT NOT NULL CHECK (tax_system IN ('NPD', 'USN', 'AUSN', 'OSNO', 'PSN', 'ESHN', 'OTHER')),
  vat_treatment TEXT NOT NULL CHECK (vat_treatment IN ('NO_VAT', 'VAT_5', 'VAT_7', 'VAT_22')),
  no_vat_basis TEXT CHECK (no_vat_basis IS NULL OR no_vat_basis IN ('NPD', 'AUSN', 'PSN', 'USN_EXEMPT', 'OTHER_CONFIRMED')),
  -- The instant this treatment becomes the applicable one - a temporal
  -- fact, resolved via "latest effective_from <= instant", never simply
  -- MAX(sequence). Ties (a same-instant correction) break on sequence DESC.
  -- ONE canonical sortable format, never a caller-chosen string (review
  -- round 1, P1.1): a UTC instant, millisecond precision, always Z-suffixed
  -- - exactly what Date.prototype.toISOString() produces. Enforced below by
  -- round-tripping through strftime() and requiring byte-identity with the
  -- input: a value already in this exact shape round-trips unchanged; every
  -- other representation (date-only, no milliseconds, an explicit +HH:MM
  -- offset, or outright malformed input) round-trips to something different
  -- (or to NULL for unparseable input) and is rejected. The explicit
  -- `IS NOT NULL` guard is required, not redundant: SQLite's CHECK accepts
  -- a NULL result as satisfied (three-valued SQL logic - a bare
  -- `x = NULL` comparison is itself NULL, never FALSE), so unparseable
  -- input - where strftime() itself returns NULL - would otherwise pass
  -- this CHECK silently instead of being rejected. This is what makes the
  -- lexicographic ORDER BY effective_from ... above a sound temporal
  -- ordering, not merely a string comparison that happens to work for
  -- well-behaved input.
  effective_from TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', effective_from) IS NOT NULL
    AND effective_from = strftime('%Y-%m-%dT%H:%M:%fZ', effective_from)
  ),
  assertion_source TEXT NOT NULL CHECK (assertion_source IN ('SYSTEM_DERIVED', 'ADMIN_ASSERTED')),
  evidence_ref TEXT,
  reason TEXT NOT NULL,
  created_by_admin_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (partner_identity_id, sequence),

  -- vat_treatment/no_vat_basis are two halves of one fact: NO_VAT always
  -- names why (no_vat_basis NOT NULL); any real rate always leaves the
  -- basis unset - mirrors the evidence_ref discipline used throughout this
  -- domain (a field is either always-present-with-a-value or always-null
  -- for a given branch, never "present but meaningless").
  CHECK (
    (vat_treatment = 'NO_VAT' AND no_vat_basis IS NOT NULL)
    OR (vat_treatment != 'NO_VAT' AND no_vat_basis IS NULL)
  ),

  -- The tax_system x vat_treatment x no_vat_basis matrix. Deliberately NOT
  -- a general Russian VAT engine and NOT an income-threshold inference: for
  -- every tax_system other than NPD/AUSN/PSN, this only proves INTERNAL
  -- consistency of the tuple an admin explicitly asserted (with evidence) -
  -- it never decides which rate is legally correct for a given operator.
  --   NPD  - always NO_VAT/NPD, SYSTEM_DERIVED only (enforced below).
  --   AUSN - always NO_VAT/AUSN (not a plaintiff-supplied fact - AUSN in
  --          general does not recognize VAT payer status).
  --   PSN  - always NO_VAT/PSN (review round 1, P1.4: PSN is an individual-
  --          entrepreneur-only patent regime under Russian law - ФНС
  --          describes it as obtained by an ИП, and income taxed under it
  --          is exempt from VAT with only narrow statutory exceptions this
  --          schema does not model). Restricted to legal_form =
  --          INDIVIDUAL_ENTREPRENEUR by the relational trigger below, not
  --          this table-local CHECK, which cannot see the joined legal
  --          profile's own legal_form.
  --   USN  - either NO_VAT/USN_EXEMPT or any of VAT_5/VAT_7/VAT_22,
  --          entirely by explicit admin assertion (2026 thresholds and the
  --          5%/7%/22% choice are a business/legal fact this schema does
  --          not compute).
  --   OSNO/ESHN/OTHER - either VAT_22 or an explicitly confirmed exemption
  --          (NO_VAT/OTHER_CONFIRMED) - never auto-derived.
  CHECK (
    (tax_system = 'NPD' AND vat_treatment = 'NO_VAT' AND no_vat_basis = 'NPD')
    OR (tax_system = 'AUSN' AND vat_treatment = 'NO_VAT' AND no_vat_basis = 'AUSN')
    OR (tax_system = 'PSN' AND vat_treatment = 'NO_VAT' AND no_vat_basis = 'PSN')
    OR (tax_system = 'USN' AND (
      (vat_treatment = 'NO_VAT' AND no_vat_basis = 'USN_EXEMPT')
      OR vat_treatment IN ('VAT_5', 'VAT_7', 'VAT_22')
    ))
    OR (tax_system IN ('OSNO', 'ESHN', 'OTHER') AND (
      vat_treatment = 'VAT_22'
      OR (vat_treatment = 'NO_VAT' AND no_vat_basis = 'OTHER_CONFIRMED')
    ))
  ),

  -- Provenance discipline, matching 0050's own assertion_source/evidence_ref
  -- pattern exactly (including the whitespace-aware trim() - SQLite's
  -- single-argument trim() only strips ASCII space): SYSTEM_DERIVED exists
  -- ONLY for the automatic NPD mint (atomic with the legal-profile mint
  -- that produced tax_mode=NPD), carries no evidence and no admin actor.
  -- Every other tax_system is a financially/legally significant fact this
  -- migration deliberately requires an admin to assert with real evidence -
  -- there is no partner self-service candidate lifecycle for tax treatment
  -- in PR-F (unlike D2's legal-profile supersession, which does have one).
  CHECK (
    (assertion_source = 'SYSTEM_DERIVED' AND tax_system = 'NPD' AND evidence_ref IS NULL AND created_by_admin_id IS NULL)
    OR (assertion_source = 'ADMIN_ASSERTED' AND tax_system != 'NPD' AND created_by_admin_id IS NOT NULL
      AND evidence_ref IS NOT NULL AND trim(evidence_ref, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != '')
  )
);

CREATE INDEX agent_referrals_tax_treatment_revisions_legal_profile_idx
  ON agent_referrals_tax_treatment_revisions(legal_profile_revision_id, effective_from, sequence);

CREATE UNIQUE INDEX agent_referrals_tax_treatment_revisions_system_derived_unique
  ON agent_referrals_tax_treatment_revisions(legal_profile_revision_id) WHERE assertion_source = 'SYSTEM_DERIVED';

CREATE TRIGGER agent_referrals_tax_treatment_revisions_relational_consistency_guard
BEFORE INSERT ON agent_referrals_tax_treatment_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM partner_identities pi
  JOIN agent_referrals_legal_profile_revisions lp ON lp.id = NEW.legal_profile_revision_id
  WHERE pi.id = NEW.partner_identity_id AND pi.agent_id = lp.agent_id
    AND (lp.tax_mode = 'NPD') = (NEW.tax_system = 'NPD')
    AND (NEW.tax_system != 'PSN' OR lp.legal_form = 'INDIVIDUAL_ENTREPRENEUR')
)
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_TAX_TREATMENT_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER agent_referrals_tax_treatment_revisions_immutable_guard
BEFORE UPDATE ON agent_referrals_tax_treatment_revisions
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_TAX_TREATMENT_REVISION_IMMUTABLE'); END;

CREATE TRIGGER agent_referrals_tax_treatment_revisions_delete_guard
BEFORE DELETE ON agent_referrals_tax_treatment_revisions
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_TAX_TREATMENT_REVISION_IMMUTABLE'); END;

CREATE TRIGGER ord_paid_invoice_payloads_relational_consistency_guard
BEFORE INSERT ON ord_paid_invoice_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM settlement_acts a
  WHERE a.id = NEW.act_id AND a.settlement_id = NEW.settlement_id AND a.engagement_id = NEW.engagement_id AND a.partner_identity_id = NEW.partner_identity_id
)
OR NOT EXISTS (
  SELECT 1 FROM settlement_act_acceptances acc
  WHERE acc.act_id = NEW.act_id AND acc.accepted_amount_kopecks = NEW.accepted_amount_kopecks AND acc.accepted_engagement_revision_id = NEW.accepted_engagement_revision_id
)
OR NOT EXISTS (
  SELECT 1 FROM reward_settlements rs
  WHERE rs.id = NEW.settlement_id
    AND rs.tax_mode_snapshot = NEW.tax_mode_snapshot AND rs.legal_profile_revision_id_snapshot = NEW.legal_profile_revision_id_snapshot AND rs.contractor_type_snapshot = NEW.contractor_type_snapshot
    AND rs.tax_treatment_revision_id_snapshot = NEW.tax_treatment_revision_id_snapshot
    AND rs.tax_canonicalization_version = NEW.tax_canonicalization_version
    AND rs.tax_canonical_json = NEW.tax_canonical_json AND rs.tax_canonical_hash = NEW.tax_canonical_hash
)
OR NOT EXISTS (
  SELECT 1 FROM ord_provider_profile_revisions p WHERE p.id = NEW.provider_contract_profile_id AND p.profile_kind = 'CONTRACT'
    AND p.revision = (SELECT MAX(revision) FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT')
)
OR NEW.ord_participant_canonicalization_version != 'ORD_PARTICIPANT_V1' OR NEW.partner_participant_json IS NULL OR NEW.partner_participant_hash IS NULL
OR NEW.tax_canonicalization_version != 'SETTLEMENT_TAX_V1' OR NEW.tax_canonical_json IS NULL OR NEW.tax_canonical_hash IS NULL
BEGIN SELECT RAISE(ABORT, 'ORD_PAID_INVOICE_PAYLOAD_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER ord_paid_invoice_payloads_authority_immutable_guard
BEFORE UPDATE ON ord_paid_invoice_payloads
WHEN NEW.act_id IS NOT OLD.act_id OR NEW.settlement_id IS NOT OLD.settlement_id OR NEW.engagement_id IS NOT OLD.engagement_id OR NEW.partner_identity_id IS NOT OLD.partner_identity_id
  OR NEW.accepted_amount_kopecks IS NOT OLD.accepted_amount_kopecks OR NEW.accepted_engagement_revision_id IS NOT OLD.accepted_engagement_revision_id
  OR NEW.tax_mode_snapshot IS NOT OLD.tax_mode_snapshot OR NEW.legal_profile_revision_id_snapshot IS NOT OLD.legal_profile_revision_id_snapshot OR NEW.contractor_type_snapshot IS NOT OLD.contractor_type_snapshot
  OR NEW.provider_contract_profile_id IS NOT OLD.provider_contract_profile_id OR NEW.operation_key IS NOT OLD.operation_key OR NEW.canonical_hash IS NOT OLD.canonical_hash
  OR NEW.tax_treatment_revision_id_snapshot IS NOT OLD.tax_treatment_revision_id_snapshot
  OR NEW.ord_participant_canonicalization_version IS NOT OLD.ord_participant_canonicalization_version
  OR NEW.partner_participant_json IS NOT OLD.partner_participant_json OR NEW.partner_participant_hash IS NOT OLD.partner_participant_hash
  OR NEW.tax_canonicalization_version IS NOT OLD.tax_canonicalization_version
  OR NEW.tax_canonical_json IS NOT OLD.tax_canonical_json OR NEW.tax_canonical_hash IS NOT OLD.tax_canonical_hash
BEGIN SELECT RAISE(ABORT, 'ORD_PAID_INVOICE_PAYLOAD_AUTHORITY_COLUMNS_IMMUTABLE'); END;

CREATE TABLE partner_command_idempotency (
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  -- A stable SEMANTIC command name ("partner.payout.set"), never a URL: a
  -- route can be renamed without silently splitting a command's identity in
  -- two, and two routes cannot accidentally share one.
  command TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  -- The contract this record was written under. admin V2 carries the same
  -- fact implicitly, as a "v2:" prefix inside its fingerprint, which makes a
  -- contract change look like an ordinary body mismatch (409
  -- IDEMPOTENCY_CONFLICT). Naming it here lets a replay under a changed
  -- contract fail as IDEMPOTENCY_CONTRACT_SUPERSEDED instead - the same code
  -- the admin path already uses for its own "this record predates the
  -- current contract" case.
  contract_version TEXT NOT NULL,
  -- A stored row means a COMMITTED command result. Validation failures,
  -- suspension refusals and conflicts are not cached: they never reach the
  -- INSERT, and the CHECK makes that structural rather than conventional.
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (partner_identity_id, command, key_hash)
);

CREATE TRIGGER partner_command_idempotency_immutable_guard
BEFORE UPDATE ON partner_command_idempotency
BEGIN SELECT RAISE(ABORT, 'PARTNER_COMMAND_IDEMPOTENCY_IMMUTABLE'); END;

CREATE TRIGGER partner_command_idempotency_delete_guard
BEFORE DELETE ON partner_command_idempotency
BEGIN SELECT RAISE(ABORT, 'PARTNER_COMMAND_IDEMPOTENCY_IMMUTABLE'); END;

CREATE UNIQUE INDEX agent_referrals_legal_profile_change_requests_sequence_unique
  ON agent_referrals_legal_profile_change_requests(partner_identity_id, request_sequence);

CREATE TRIGGER agent_referrals_legal_profile_change_requests_request_fields_immutable_guard
BEFORE UPDATE ON agent_referrals_legal_profile_change_requests
-- id joins the group too, and it was missing from every version of this
-- guard including 0052's. A TEXT PRIMARY KEY is not an immutable one:
-- SQLite permits updating a PK as long as the new value does not collide,
-- so the same resolution statement that may not rewrite a filed INN could
-- still have rewritten WHICH filed request it was resolving. The row's
-- identity is the first thing the evidence asserts, not a resolution field.
WHEN NEW.id IS NOT OLD.id
  OR NEW.partner_identity_id IS NOT OLD.partner_identity_id
  OR NEW.legal_form IS NOT OLD.legal_form
  OR NEW.tax_mode IS NOT OLD.tax_mode
  OR NEW.opf IS NOT OLD.opf
  OR NEW.full_name IS NOT OLD.full_name
  OR NEW.short_name IS NOT OLD.short_name
  OR NEW.inn IS NOT OLD.inn
  OR NEW.kpp IS NOT OLD.kpp
  OR NEW.registration_number IS NOT OLD.registration_number
  OR NEW.legal_address IS NOT OLD.legal_address
  OR NEW.assertion_source IS NOT OLD.assertion_source
  OR NEW.evidence_ref IS NOT OLD.evidence_ref
  OR NEW.reason IS NOT OLD.reason
  OR NEW.supersedes_revision_id IS NOT OLD.supersedes_revision_id
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.request_sequence IS NOT OLD.request_sequence
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE'); END;

CREATE UNIQUE INDEX partner_invite_capabilities_head_unique
  ON partner_invite_capabilities(partner_identity_id)
  WHERE superseded_by_id IS NULL;

CREATE TRIGGER reward_settlements_authority_tuple_consistency_guard
BEFORE INSERT ON reward_settlements
WHEN NOT (
  (NEW.engagement_id IS NOT NULL AND NEW.engagement_revision_id IS NOT NULL
    AND NEW.base_registry_snapshot_id IS NOT NULL AND NEW.reward_registry_hash IS NOT NULL AND NEW.effective_reward_snapshot_id IS NOT NULL
    AND NEW.partner_identity_id IS NOT NULL AND NEW.payout_profile_revision_id IS NOT NULL
    AND NEW.tax_mode_snapshot IS NOT NULL AND NEW.legal_profile_revision_id_snapshot IS NOT NULL
    AND NEW.tax_treatment_revision_id_snapshot IS NOT NULL AND NEW.tax_canonicalization_version = 'SETTLEMENT_TAX_V1'
    AND NEW.tax_canonical_json IS NOT NULL AND NEW.tax_canonical_hash IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM engagement_effective_reward_snapshots e
      WHERE e.id = NEW.effective_reward_snapshot_id
        AND e.engagement_id = NEW.engagement_id
        AND e.engagement_revision_id = NEW.engagement_revision_id
        AND e.base_registry_snapshot_id = NEW.base_registry_snapshot_id
        AND e.reward_total_kopecks = NEW.amount_kopecks
        AND e.sequence = (SELECT MAX(sequence) FROM engagement_effective_reward_snapshots WHERE engagement_id = NEW.engagement_id)
    )
    AND EXISTS (SELECT 1 FROM engagement_reward_registry_snapshot r WHERE r.id = NEW.base_registry_snapshot_id AND r.source_state_hash = NEW.reward_registry_hash)
    AND EXISTS (
      SELECT 1 FROM engagements en JOIN occurrences o ON o.id = en.occurrence_id
      WHERE en.id = NEW.engagement_id AND en.occurrence_id = NEW.occurrence_id AND o.fulfillment_status = 'COMPLETED'
    )
    AND EXISTS (SELECT 1 FROM partner_identities pi WHERE pi.id = NEW.partner_identity_id AND pi.agent_id = NEW.agent_id)
    AND EXISTS (SELECT 1 FROM engagements en2 WHERE en2.id = NEW.engagement_id AND en2.partner_identity_id = NEW.partner_identity_id)
    AND EXISTS (
      SELECT 1 FROM partner_identities pi2
      JOIN agent_referrals_legal_profile_revisions lp ON lp.id = pi2.legal_profile_revision_id
      WHERE pi2.id = NEW.partner_identity_id AND pi2.legal_profile_revision_id = NEW.legal_profile_revision_id_snapshot
        AND lp.agent_id = NEW.agent_id AND lp.tax_mode = NEW.tax_mode_snapshot
        AND lp.projected_contractor_type = NEW.contractor_type_snapshot
    )
    AND EXISTS (
      SELECT 1 FROM agent_referrals_tax_treatment_revisions tt
      WHERE tt.id = NEW.tax_treatment_revision_id_snapshot
        AND tt.legal_profile_revision_id = NEW.legal_profile_revision_id_snapshot
        AND tt.partner_identity_id = NEW.partner_identity_id
    )
    AND EXISTS (
      SELECT 1 FROM payout_profile_revisions ppr
      WHERE ppr.id = NEW.payout_profile_revision_id AND ppr.partner_identity_id = NEW.partner_identity_id AND ppr.kind = 'ACTIVE_DESTINATION'
        AND ppr.revision = (SELECT MAX(revision) FROM payout_profile_revisions WHERE partner_identity_id = NEW.partner_identity_id)
    )
    AND (
      NEW.supersedes_settlement_id IS NULL
      OR EXISTS (
        SELECT 1 FROM reward_settlements prev
        JOIN engagement_effective_reward_snapshots e2 ON e2.id = NEW.effective_reward_snapshot_id
        WHERE prev.id = NEW.supersedes_settlement_id
          AND prev.engagement_id = NEW.engagement_id
          AND prev.status = 'CANCELLED_BEFORE_PAYMENT'
          AND prev.cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION'
          AND e2.supersedes_effective_snapshot_id = prev.effective_reward_snapshot_id
      )
    ))
)
BEGIN SELECT RAISE(ABORT, 'REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT'); END;

CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE framework_issuances (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  sequence INTEGER NOT NULL,
  framework_agreement_revision_id TEXT NOT NULL REFERENCES framework_agreement_revisions(id),
  delegation_template_revision_id TEXT NOT NULL REFERENCES delegation_template_revisions(id),
  issued_by_admin_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (partner_identity_id, sequence)
);

CREATE TRIGGER framework_issuances_immutable_guard
BEFORE UPDATE ON framework_issuances
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ISSUANCE_IMMUTABLE'); END;

CREATE TRIGGER framework_issuances_delete_guard
BEFORE DELETE ON framework_issuances
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ISSUANCE_IMMUTABLE'); END;

CREATE TABLE framework_acceptances (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  issuance_id TEXT NOT NULL REFERENCES framework_issuances(id),
  legal_profile_revision_id TEXT NOT NULL REFERENCES agent_referrals_legal_profile_revisions(id),
  step_up_grant_id TEXT NOT NULL UNIQUE REFERENCES step_up_grants(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (partner_identity_id, issuance_id)
);

CREATE TRIGGER framework_acceptances_immutable_guard
BEFORE UPDATE ON framework_acceptances
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ACCEPTANCE_IMMUTABLE'); END;

CREATE TRIGGER framework_acceptances_delete_guard
BEFORE DELETE ON framework_acceptances
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ACCEPTANCE_IMMUTABLE'); END;

CREATE TRIGGER framework_acceptances_issuance_partner_consistency_guard
BEFORE INSERT ON framework_acceptances
WHEN NOT EXISTS (
  SELECT 1 FROM framework_issuances fi
  WHERE fi.id = NEW.issuance_id AND fi.partner_identity_id = NEW.partner_identity_id
)
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ACCEPTANCE_ISSUANCE_PARTNER_MISMATCH'); END;

CREATE TRIGGER framework_acceptances_legal_profile_partner_consistency_guard
BEFORE INSERT ON framework_acceptances
WHEN NOT EXISTS (
  SELECT 1 FROM agent_referrals_legal_profile_revisions lp
  JOIN partner_identities pi ON pi.agent_id = lp.agent_id
  WHERE lp.id = NEW.legal_profile_revision_id AND pi.id = NEW.partner_identity_id
)
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ACCEPTANCE_LEGAL_PROFILE_PARTNER_MISMATCH'); END;

CREATE TABLE ord_reporting_delegations (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  framework_acceptance_id TEXT NOT NULL UNIQUE REFERENCES framework_acceptances(id),
  delegation_template_revision_id TEXT NOT NULL REFERENCES delegation_template_revisions(id),
  ord_reporting_mode TEXT NOT NULL CHECK (ord_reporting_mode = 'FLEXPERIMENT_DELEGATED'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER ord_reporting_delegations_immutable_guard
BEFORE UPDATE ON ord_reporting_delegations
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_DELEGATION_IMMUTABLE'); END;

CREATE TRIGGER ord_reporting_delegations_delete_guard
BEFORE DELETE ON ord_reporting_delegations
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_DELEGATION_IMMUTABLE'); END;

CREATE TRIGGER ord_reporting_delegations_acceptance_partner_consistency_guard
BEFORE INSERT ON ord_reporting_delegations
WHEN NOT EXISTS (
  SELECT 1 FROM framework_acceptances fa
  WHERE fa.id = NEW.framework_acceptance_id AND fa.partner_identity_id = NEW.partner_identity_id
)
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_DELEGATION_ACCEPTANCE_PARTNER_MISMATCH'); END;

CREATE TRIGGER ord_reporting_delegations_template_issuance_consistency_guard
BEFORE INSERT ON ord_reporting_delegations
WHEN NOT EXISTS (
  SELECT 1
  FROM framework_acceptances fa
  JOIN framework_issuances fi ON fi.id = fa.issuance_id
  WHERE fa.id = NEW.framework_acceptance_id
    AND fi.delegation_template_revision_id = NEW.delegation_template_revision_id
)
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_DELEGATION_TEMPLATE_ISSUANCE_MISMATCH'); END;

-- The singleton that makes lineage answerable before anything trusts the
-- database. Absent means legacy; unrecognised means unknown; both fail closed.
CREATE TABLE schema_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  lineage TEXT NOT NULL CHECK (lineage = 'flexperiment-launch'),
  baseline_version TEXT NOT NULL,
  established_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER schema_identity_immutable_guard
BEFORE UPDATE ON schema_identity
BEGIN SELECT RAISE(ABORT, 'SCHEMA_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER schema_identity_delete_guard
BEFORE DELETE ON schema_identity
BEGIN SELECT RAISE(ABORT, 'SCHEMA_IDENTITY_IMMUTABLE'); END;

-- Session state and the deployment gate as one row. A gate closed by a session
-- that does not exist is the state this shape exists to forbid.
CREATE TABLE deploy_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('MAINTENANCE_CUTOVER', 'ROLLING_SAFE')),
  target_sha TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACQUIRED', 'FENCED', 'DEPLOYING', 'RECOVERY_REQUIRED', 'SAFE_ABORTED', 'SUCCEEDED', 'ROLLED_BACK')),
  rollback_authority TEXT NOT NULL CHECK (rollback_authority IN ('OLD_LINEAGE_ALLOWED', 'NEW_LINEAGE_ONLY')),
  mutation_observed INTEGER NOT NULL DEFAULT 0 CHECK (mutation_observed IN (0, 1)),
  deployment_gate_closed INTEGER NOT NULL DEFAULT 0 CHECK (deployment_gate_closed IN (0, 1)),
  created_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  pre_deploy_topology TEXT NOT NULL,
  observed_topology TEXT,
  adopted_cutover_id TEXT UNIQUE,
  adopted_envelope_sha256 TEXT,
  predecessor_database_ref TEXT,
  predecessor_database_sha256 TEXT,
  bootstrap_rollback_id TEXT UNIQUE,
  -- A finished session never leaves sales shut.
  CHECK (NOT (state IN ('SAFE_ABORTED', 'SUCCEEDED', 'ROLLED_BACK') AND deployment_gate_closed = 1)),
  -- A rolling release does not fence; that is what makes it rolling.
  CHECK (NOT (mode = 'ROLLING_SAFE' AND deployment_gate_closed = 1)),
  -- A safe abort claims production was never touched, so the two cannot coexist.
  CHECK (NOT (state = 'SAFE_ABORTED' AND mutation_observed = 1)),
  -- Adoption is one fact with four parts. `cutover-handoff` writes them
  -- together and `bootstrap-rollback` reads them together, so a session
  -- carrying an archive digest but no cutover id - or a cutover id with no
  -- archive to return to - is not a partial handoff, it is a corrupt one.
  CHECK (
    (adopted_cutover_id IS NULL AND adopted_envelope_sha256 IS NULL
      AND predecessor_database_ref IS NULL AND predecessor_database_sha256 IS NULL)
    OR
    (adopted_cutover_id IS NOT NULL AND adopted_envelope_sha256 IS NOT NULL
      AND predecessor_database_ref IS NOT NULL AND predecessor_database_sha256 IS NOT NULL)
  )
);

-- At most one session may be live. The indexed expression is constant per row;
-- what carries the rule is the predicate.
CREATE UNIQUE INDEX deploy_sessions_single_non_terminal_idx
  ON deploy_sessions((state IS NOT NULL))
  WHERE state IN ('ACQUIRED', 'FENCED', 'DEPLOYING', 'RECOVERY_REQUIRED');

CREATE INDEX deploy_sessions_state_idx ON deploy_sessions(state, lease_expires_at);

CREATE TRIGGER deploy_sessions_identity_immutable_guard
BEFORE UPDATE ON deploy_sessions
WHEN NEW.id IS NOT OLD.id
  OR NEW.mode IS NOT OLD.mode
  OR NEW.target_sha IS NOT OLD.target_sha
  OR NEW.candidate_id IS NOT OLD.candidate_id
  OR NEW.created_at IS NOT OLD.created_at
  -- Every one of these arrives in `AcquireInput` and none appears in
  -- `DeploySessionPatch`, so after acquisition they have no legal path of
  -- change at all - not even null to a value. A write-once rule would be
  -- weaker than the contract it is meant to enforce.
  OR NEW.pre_deploy_topology IS NOT OLD.pre_deploy_topology
  OR NEW.adopted_cutover_id IS NOT OLD.adopted_cutover_id
  OR NEW.adopted_envelope_sha256 IS NOT OLD.adopted_envelope_sha256
  OR NEW.predecessor_database_ref IS NOT OLD.predecessor_database_ref
  OR NEW.predecessor_database_sha256 IS NOT OLD.predecessor_database_sha256
BEGIN SELECT RAISE(ABORT, 'DEPLOY_SESSION_IDENTITY_IMMUTABLE'); END;

-- `observed_topology` is deliberately absent from the frozen list above: it IS
-- the reading, and readings are meant to be retaken. `pre_deploy_topology` is
-- the fact, and it is easy to confuse the two - `planResume` compares
-- production against the snapshot to decide whether a safe abort is available,
-- so anything able to edit it can make a production that moved look untouched.
CREATE TRIGGER deploy_sessions_monotonicity_guard
BEFORE UPDATE ON deploy_sessions
WHEN OLD.state IN ('SAFE_ABORTED', 'SUCCEEDED', 'ROLLED_BACK')
  OR (OLD.mutation_observed = 1 AND NEW.mutation_observed = 0)
  OR (OLD.rollback_authority = 'NEW_LINEAGE_ONLY' AND NEW.rollback_authority IS NOT 'NEW_LINEAGE_ONLY')
  OR (OLD.bootstrap_rollback_id IS NOT NULL AND NEW.bootstrap_rollback_id IS NOT OLD.bootstrap_rollback_id)
BEGIN SELECT RAISE(ABORT, 'DEPLOY_SESSION_TRANSITION_ILLEGAL'); END;

-- Evidence per instance rather than per unit, so readiness can tell a converged
-- runtime from an old one that has not stopped. A second row for the same unit
-- is expected, not a conflict - that is the whole reason it replaces the
-- singleton the ledger used to keep.
CREATE TABLE runtime_instance_evidence (
  instance_id TEXT PRIMARY KEY,
  unit TEXT NOT NULL CHECK (unit IN ('COMMERCE', 'WORKER')),
  source_commit TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  last_successful_sweep_at TEXT
);

CREATE INDEX runtime_instance_evidence_unit_idx ON runtime_instance_evidence(unit, heartbeat_at);

CREATE TRIGGER runtime_instance_evidence_identity_immutable_guard
BEFORE UPDATE ON runtime_instance_evidence
WHEN NEW.instance_id IS NOT OLD.instance_id
  OR NEW.unit IS NOT OLD.unit
  OR NEW.source_commit IS NOT OLD.source_commit
  OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'RUNTIME_INSTANCE_EVIDENCE_IDENTITY_IMMUTABLE'); END;

-- A revisioned authority only one runner can advance.
CREATE TABLE certification_runs (
  run_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  release_sha TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'NEW', 'OCCURRENCE_CREATED', 'OCCURRENCE_PUBLISHED', 'OCCURRENCE_OPEN', 'QUOTE_READY',
    'CHECKOUT_SUBMITTING', 'CHECKOUT_CREATED', 'ORDER_IDENTIFIED', 'PAYMENT_PROVEN',
    'TICKET_EMAIL_DELIVERED', 'BOOKING_CANCELLED', 'BOOKING_CANCELLED_EMAIL_DELIVERED',
    'REFUND_SUCCEEDED', 'REFUND_EMAIL_DELIVERED', 'OCCURRENCE_CLEANED', 'COMPLETE')),
  direction TEXT NOT NULL CHECK (direction IN ('NORMAL', 'FINANCIAL_EFFECT_POSSIBLE', 'CLEANUP_STARTED', 'CATALOGUE_CLEAN')),
  started_at TEXT NOT NULL,
  pending_command TEXT,
  superseded_command TEXT,
  -- Why this run can never be a PASS. Separate from `direction` on purpose: the
  -- happy path shuts the catalogue too, as its last step.
  failure_outcome TEXT CHECK (failure_outcome IN ('FAILED', 'INCOMPLETE')),
  failure_code TEXT,
  failure_recorded_at TEXT,
  occurrence_id TEXT,
  quote_id TEXT,
  status_id TEXT,
  order_id TEXT,
  payment_id TEXT,
  booking_id TEXT,
  ticket_id TEXT,
  refund_obligation_id TEXT,
  refund_id TEXT,
  human_ticket_verified_at TEXT,
  completed_at TEXT,
  CHECK ((failure_outcome IS NULL) = (failure_code IS NULL)),
  CHECK ((failure_outcome IS NULL) = (failure_recorded_at IS NULL))
);

-- Compare-and-set decides WHO wrote; this decides whether the write was legal.
-- The baseline needs both, and they are not substitutes.
CREATE TRIGGER certification_runs_transition_guard
BEFORE UPDATE ON certification_runs
WHEN NEW.revision IS NOT OLD.revision + 1
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.release_sha IS NOT OLD.release_sha
  OR NEW.started_at IS NOT OLD.started_at
  OR (CASE NEW.phase
        WHEN 'NEW' THEN 0 WHEN 'OCCURRENCE_CREATED' THEN 1 WHEN 'OCCURRENCE_PUBLISHED' THEN 2
        WHEN 'OCCURRENCE_OPEN' THEN 3 WHEN 'QUOTE_READY' THEN 4 WHEN 'CHECKOUT_SUBMITTING' THEN 5
        WHEN 'CHECKOUT_CREATED' THEN 6 WHEN 'ORDER_IDENTIFIED' THEN 7 WHEN 'PAYMENT_PROVEN' THEN 8
        WHEN 'TICKET_EMAIL_DELIVERED' THEN 9 WHEN 'BOOKING_CANCELLED' THEN 10
        WHEN 'BOOKING_CANCELLED_EMAIL_DELIVERED' THEN 11 WHEN 'REFUND_SUCCEEDED' THEN 12
        WHEN 'REFUND_EMAIL_DELIVERED' THEN 13 WHEN 'OCCURRENCE_CLEANED' THEN 14 WHEN 'COMPLETE' THEN 15 END)
     < (CASE OLD.phase
        WHEN 'NEW' THEN 0 WHEN 'OCCURRENCE_CREATED' THEN 1 WHEN 'OCCURRENCE_PUBLISHED' THEN 2
        WHEN 'OCCURRENCE_OPEN' THEN 3 WHEN 'QUOTE_READY' THEN 4 WHEN 'CHECKOUT_SUBMITTING' THEN 5
        WHEN 'CHECKOUT_CREATED' THEN 6 WHEN 'ORDER_IDENTIFIED' THEN 7 WHEN 'PAYMENT_PROVEN' THEN 8
        WHEN 'TICKET_EMAIL_DELIVERED' THEN 9 WHEN 'BOOKING_CANCELLED' THEN 10
        WHEN 'BOOKING_CANCELLED_EMAIL_DELIVERED' THEN 11 WHEN 'REFUND_SUCCEEDED' THEN 12
        WHEN 'REFUND_EMAIL_DELIVERED' THEN 13 WHEN 'OCCURRENCE_CLEANED' THEN 14 WHEN 'COMPLETE' THEN 15 END)
  OR (CASE NEW.direction WHEN 'NORMAL' THEN 0 WHEN 'FINANCIAL_EFFECT_POSSIBLE' THEN 1 WHEN 'CLEANUP_STARTED' THEN 2 WHEN 'CATALOGUE_CLEAN' THEN 3 END)
     < (CASE OLD.direction WHEN 'NORMAL' THEN 0 WHEN 'FINANCIAL_EFFECT_POSSIBLE' THEN 1 WHEN 'CLEANUP_STARTED' THEN 2 WHEN 'CATALOGUE_CLEAN' THEN 3 END)
  -- A recorded failure is never rewritten and never cleared.
  OR (OLD.failure_outcome IS NOT NULL AND (
        NEW.failure_outcome IS NOT OLD.failure_outcome
        OR NEW.failure_code IS NOT OLD.failure_code
        OR NEW.failure_recorded_at IS NOT OLD.failure_recorded_at))
  -- Arming and settling are the adapter's to decide. Replacing one armed
  -- command with another is not a transition it has, it changes what a later
  -- resume sends to the outside world, and nothing else would notice.
  OR (OLD.pending_command IS NOT NULL AND NEW.pending_command IS NOT NULL AND NEW.pending_command IS NOT OLD.pending_command)
  OR (OLD.superseded_command IS NOT NULL AND NEW.superseded_command IS NOT OLD.superseded_command)
BEGIN SELECT RAISE(ABORT, 'CERTIFICATION_RUN_TRANSITION_ILLEGAL'); END;

-- Recovery follows these identifiers to find real objects to cancel, refund and
-- verify. Rewriting `order_id` or `booking_id` corrupts nothing the run can
-- detect - it sends a correctly working recovery at a different customer's
-- purchase. Each may go from null to a value once, and never move again.
CREATE TRIGGER certification_runs_evidence_write_once_guard
BEFORE UPDATE ON certification_runs
WHEN (OLD.occurrence_id IS NOT NULL AND NEW.occurrence_id IS NOT OLD.occurrence_id)
  OR (OLD.quote_id IS NOT NULL AND NEW.quote_id IS NOT OLD.quote_id)
  OR (OLD.status_id IS NOT NULL AND NEW.status_id IS NOT OLD.status_id)
  OR (OLD.order_id IS NOT NULL AND NEW.order_id IS NOT OLD.order_id)
  OR (OLD.payment_id IS NOT NULL AND NEW.payment_id IS NOT OLD.payment_id)
  OR (OLD.booking_id IS NOT NULL AND NEW.booking_id IS NOT OLD.booking_id)
  OR (OLD.ticket_id IS NOT NULL AND NEW.ticket_id IS NOT OLD.ticket_id)
  OR (OLD.refund_obligation_id IS NOT NULL AND NEW.refund_obligation_id IS NOT OLD.refund_obligation_id)
  OR (OLD.refund_id IS NOT NULL AND NEW.refund_id IS NOT OLD.refund_id)
  OR (OLD.human_ticket_verified_at IS NOT NULL AND NEW.human_ticket_verified_at IS NOT OLD.human_ticket_verified_at)
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT, 'CERTIFICATION_RUN_EVIDENCE_IMMUTABLE'); END;

-- A one-shot capability, spent in the same transaction as the order it admits.
CREATE TABLE certification_capabilities (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES certification_runs(run_id),
  deployment_session_id TEXT NOT NULL REFERENCES deploy_sessions(id),
  release_sha TEXT NOT NULL,
  max_amount_kopecks INTEGER NOT NULL CHECK (max_amount_kopecks > 0),
  expires_at TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  consumed_at TEXT,
  retired_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Spent or replaced, never both.
  CHECK (consumed_at IS NULL OR retired_at IS NULL)
);

-- The slot is a stored fact, not a computed one. A partial index cannot express
-- "unexpired", because SQLite evaluates the predicate against the row and not
-- against the clock - so an expired, unconsumed capability would block its own
-- replacement forever, and reissuing after expiry is exactly what is permitted.
-- Retiring keeps the row, so "expired" and "spent" stay different facts.
CREATE UNIQUE INDEX certification_capabilities_live_slot_idx
  ON certification_capabilities(deployment_session_id)
  WHERE consumed_at IS NULL AND retired_at IS NULL;

CREATE TRIGGER certification_capabilities_scope_immutable_guard
BEFORE UPDATE ON certification_capabilities
WHEN NEW.id IS NOT OLD.id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.deployment_session_id IS NOT OLD.deployment_session_id
  OR NEW.release_sha IS NOT OLD.release_sha
  OR NEW.max_amount_kopecks IS NOT OLD.max_amount_kopecks
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.nonce IS NOT OLD.nonce
BEGIN SELECT RAISE(ABORT, 'CERTIFICATION_CAPABILITY_SCOPE_IMMUTABLE'); END;

CREATE TRIGGER certification_capabilities_ending_one_way_guard
BEFORE UPDATE ON certification_capabilities
WHEN (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
BEGIN SELECT RAISE(ABORT, 'CERTIFICATION_CAPABILITY_ENDING_IMMUTABLE'); END;

-- Retiring is what frees the slot, so without this a raw UPDATE could retire a
-- live capability early and issue a second one beside it - defeating the
-- partial unique index rather than passing it.
--
-- The condition has to be about the clock, not about the columns. Comparing
-- `NEW.retired_at` to `OLD.expires_at` alone only proves the written value
-- reads as later than expiry; it says nothing about when the UPDATE happened,
-- so `SET retired_at = '9999-01-01...'` would free the slot of a live
-- capability today. So the guard asks three things: the capability was never
-- spent, the database's own clock is past expiry *now*, and the stamp being
-- written is neither before expiry nor in the future.
--
-- `expires_at` and `retired_at` are written as `toISOString()`, and
-- `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` produces the same fixed-width UTC
-- shape, so all three compare correctly as text.
--
-- The `now < expires_at` term is deliberately redundant and is recorded as
-- such: the last two terms already admit only `expires_at <= retired_at <=
-- now`, which implies it, so no test can kill that term alone. It stays
-- because it states the rule the other two only imply, and because weakening
-- either of them would otherwise silently restore the bypass.
CREATE TRIGGER certification_capabilities_retirement_guard
BEFORE UPDATE ON certification_capabilities
WHEN OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
  AND (
    OLD.consumed_at IS NOT NULL
    OR strftime('%Y-%m-%dT%H:%M:%fZ', 'now') < OLD.expires_at
    OR NEW.retired_at < OLD.expires_at
    OR NEW.retired_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
BEGIN SELECT RAISE(ABORT, 'CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE'); END;

-- No store exposes a delete, and every one of these rows is the authority
-- something else is decided from. Without these, the slot model is trivially
-- bypassed - delete the live capability, insert another - and the partial
-- index never participates. The same raw DELETE would destroy a running
-- deployment's authority, or a run's recovery evidence before anything
-- references it. Ending a thing is a recorded transition here, never a removal.
CREATE TRIGGER certification_capabilities_delete_guard
BEFORE DELETE ON certification_capabilities
BEGIN SELECT RAISE(ABORT, 'CERTIFICATION_CAPABILITY_IMMUTABLE'); END;

CREATE TRIGGER certification_runs_delete_guard
BEFORE DELETE ON certification_runs
BEGIN SELECT RAISE(ABORT, 'CERTIFICATION_RUN_IMMUTABLE'); END;

CREATE TRIGGER deploy_sessions_delete_guard
BEFORE DELETE ON deploy_sessions
BEGIN SELECT RAISE(ABORT, 'DEPLOY_SESSION_IMMUTABLE'); END;

-- The ledger the runtime keeps for 0002 and onward. The baseline creates it so
-- that a database built from this file alone is already a database the migrator
-- recognises.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ---------------------------------------------------------------------------
-- Genesis
--
-- The zero state of the schema itself, not launch content. Each row is a
-- singleton or an immutable policy revision whose absence a runtime reads as
-- "fail closed" rather than "empty": dispatch stays fenced, the ORD path has
-- no policy to resolve, and lineage is unanswerable. The catalogue - cities,
-- occurrences, operational settings - is NOT here; it belongs to
-- `launch-seed.ts`, which runs against a database this file has already made
-- trustworthy.
-- ---------------------------------------------------------------------------

INSERT INTO schema_identity(singleton, lineage, baseline_version) VALUES (1, 'flexperiment-launch', '0001_launch_baseline');

INSERT INTO outbox_authority(singleton) VALUES (1);

INSERT INTO emergency_sales_gate(singleton) VALUES (1);

INSERT INTO unisender_event_dump_control(singleton) VALUES (1);

-- ACTIVE, because there is no longer a state meaning "before the feature
-- existed" to start from.
INSERT INTO agent_referrals_feature_state(singleton, state, owner_id, revision) VALUES (1, 'ACTIVE', NULL, 1);

-- Contractually permitted channels and the reporting basis for each format.
-- Both tables are append-only and immutable: a revision is a new row, never an
-- edit. `effective_from` predates any engagement on purpose - it means "in
-- force from before anything this schema can describe".
INSERT INTO ad_channel_policy(id, channel_key, policy_revision, status, effective_from, reason) VALUES
  (lower(hex(randomblob(16))), 'likee', 1, 'ALLOWED', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'rutube', 1, 'ALLOWED', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'telegram', 1, 'ALLOWED', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'tiktok', 1, 'ALLOWED', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'twitch', 1, 'ALLOWED', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'vk', 1, 'ALLOWED', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'vk_clips', 1, 'ALLOWED', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'vk_video', 1, 'ALLOWED', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'youtube', 1, 'ALLOWED', '2020-01-01T00:00:00.000Z', 'Launch baseline.');

INSERT INTO ord_reporting_period_policy(id, format_kind, policy_revision, reporting_basis, effective_from, reason) VALUES
  (lower(hex(randomblob(16))), 'audio', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'graphic', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'long_video', 1, 'PROVIDER_SPECIAL_PERIOD', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'native_authored', 1, 'PROVIDER_SPECIAL_PERIOD', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'post', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'short_video', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'story', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'stream', 1, 'PROVIDER_SPECIAL_PERIOD', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'text', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Launch baseline.'),
  (lower(hex(randomblob(16))), 'text_graphic', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Launch baseline.');
