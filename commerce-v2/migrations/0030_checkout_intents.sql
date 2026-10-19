-- ART-373: a checkout quote becomes a durable purchase intent. The order and line ids and the exact
-- Refref resolution request are written BEFORE the first Refref call, so a lost answer is recovered by
-- sending the identical request again, never a new one. Lifecycle:
--   DRAFT -> RESOLVING -> (CUSTOMER_ACTION_REQUIRED ->) REVIEW -> PAYMENT_CREATING
--     -> PENDING | UNCERTAIN -> PAID | DECLINED | EXPIRED | REVIEW_REQUIRED
--   and REFUSED (Refref refused the resolution) or EXPIRED before any payment started.
-- consumed_at marks the explicit confirmation; nothing before it can reach a payment provider.
-- The table keeps its name: erasure, retention and the inventory already classify it.

CREATE TABLE checkout_intents_0030 (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  offer_id TEXT NOT NULL REFERENCES offers(id),
  legal_release_id TEXT NOT NULL REFERENCES legal_releases(id),
  storefront TEXT NOT NULL CHECK (storefront IN ('COURSES', 'LAB')),
  order_public_id TEXT NOT NULL UNIQUE,
  line_ref TEXT NOT NULL UNIQUE,
  preview_idempotency_key TEXT NOT NULL UNIQUE,
  -- NULL only on quotes written before this migration.
  request_fingerprint TEXT CHECK (request_fingerprint IS NULL OR (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*')),
  resolution_request_json TEXT CHECK (resolution_request_json IS NULL OR json_valid(resolution_request_json)),
  sale_mode_at_quote TEXT NOT NULL CHECK (sale_mode_at_quote IN ('ACCEPTANCE_ONLY', 'PUBLIC')),
  catalog_amount_kopecks INTEGER NOT NULL CHECK (catalog_amount_kopecks >= 0),
  merchant_discount_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (merchant_discount_kopecks >= 0),
  merchant_promotion_id TEXT REFERENCES merchant_promotion(id),
  merchant_promotion_snapshot_json TEXT CHECK (merchant_promotion_snapshot_json IS NULL OR json_valid(merchant_promotion_snapshot_json)),
  checkout_code_input TEXT,
  line_snapshot_json TEXT CHECK (line_snapshot_json IS NULL OR json_valid(line_snapshot_json)),
  state TEXT NOT NULL CHECK (state IN ('DRAFT', 'RESOLVING', 'CUSTOMER_ACTION_REQUIRED', 'REVIEW', 'REFUSED',
    'PAYMENT_CREATING', 'PENDING', 'UNCERTAIN', 'PAID', 'DECLINED', 'EXPIRED', 'REVIEW_REQUIRED')),
  resolution_sends INTEGER NOT NULL DEFAULT 0 CHECK (resolution_sends >= 0),
  resolution_requested_at TEXT,
  refref_resolution_id TEXT,
  customer_action_url TEXT,
  failure_code TEXT,
  -- The reviewed quote: present from REVIEW on, frozen once written.
  base_amount_kopecks INTEGER CHECK (base_amount_kopecks IS NULL OR base_amount_kopecks > 0),
  discount_kopecks INTEGER CHECK (discount_kopecks IS NULL OR discount_kopecks >= 0),
  final_amount_kopecks INTEGER CHECK (final_amount_kopecks IS NULL OR final_amount_kopecks > 0),
  rail_quote_json TEXT CHECK (rail_quote_json IS NULL OR json_valid(rail_quote_json)),
  refref_checkout_code_outcome TEXT CHECK (refref_checkout_code_outcome IS NULL OR refref_checkout_code_outcome IN ('NONE','APPLIED','NOT_APPLICABLE','NOT_RECOGNIZED','NOT_APPLIED_ATTRIBUTION_LOCKED','NOT_APPLIED_CUSTOMER_KEPT_CURRENT')),
  expires_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((rail_quote_json IS NULL) = (base_amount_kopecks IS NULL)
    AND (rail_quote_json IS NULL) = (discount_kopecks IS NULL)
    AND (rail_quote_json IS NULL) = (final_amount_kopecks IS NULL)
    AND (rail_quote_json IS NULL) = (expires_at IS NULL)),
  CHECK (final_amount_kopecks IS NULL OR final_amount_kopecks = base_amount_kopecks - discount_kopecks),
  CHECK (state NOT IN ('REVIEW', 'PAYMENT_CREATING', 'PENDING', 'UNCERTAIN', 'PAID', 'DECLINED', 'REVIEW_REQUIRED') OR rail_quote_json IS NOT NULL),
  CHECK (CASE WHEN state IN ('PAYMENT_CREATING', 'PENDING', 'UNCERTAIN', 'PAID', 'DECLINED', 'REVIEW_REQUIRED') THEN consumed_at IS NOT NULL
    WHEN state = 'EXPIRED' THEN 1 ELSE consumed_at IS NULL END)
);

INSERT INTO checkout_intents_0030 (id, customer_id, offer_id, legal_release_id, storefront, order_public_id, line_ref,
  preview_idempotency_key, sale_mode_at_quote, catalog_amount_kopecks, merchant_discount_kopecks, merchant_promotion_id,
  merchant_promotion_snapshot_json, checkout_code_input, line_snapshot_json, state, resolution_sends, base_amount_kopecks,
  discount_kopecks, final_amount_kopecks, rail_quote_json, refref_checkout_code_outcome, expires_at, consumed_at, created_at, updated_at)
SELECT quote.id, quote.customer_id, quote.offer_id, quote.legal_release_id,
  CASE product.kind WHEN 'LAB' THEN 'LAB' ELSE 'COURSES' END,
  quote.order_public_id, quote.line_ref, quote.preview_idempotency_key,
  CASE offer.sale_mode WHEN 'ACCEPTANCE_ONLY' THEN 'ACCEPTANCE_ONLY' ELSE 'PUBLIC' END,
  quote.catalog_amount_kopecks, quote.merchant_discount_kopecks, quote.merchant_promotion_id, quote.merchant_promotion_snapshot_json,
  quote.checkout_code_input, quote.line_snapshot_json,
  CASE WHEN quote.state = 'REVIEW' THEN 'REVIEW'
    WHEN quote.state = 'EXPIRED' THEN 'EXPIRED'
    ELSE CASE attempt.state
      WHEN 'CREATING' THEN 'PAYMENT_CREATING'
      WHEN 'CREATE_UNKNOWN' THEN 'UNCERTAIN'
      WHEN 'PENDING' THEN 'PENDING'
      WHEN 'CUSTOMER_ACTION_REQUIRED' THEN 'PENDING'
      WHEN 'PAID' THEN 'PAID'
      WHEN 'REFUND_PENDING' THEN 'PAID'
      WHEN 'PARTIALLY_REFUNDED' THEN 'PAID'
      WHEN 'REFUNDED' THEN 'PAID'
      WHEN 'DECLINED' THEN 'DECLINED'
      WHEN 'EXPIRED' THEN 'EXPIRED'
      ELSE 'REVIEW_REQUIRED' END END,
  1, quote.base_amount_kopecks, quote.discount_kopecks, quote.final_amount_kopecks, quote.rail_quote_json,
  quote.refref_checkout_code_outcome, quote.expires_at, quote.consumed_at, quote.created_at, quote.updated_at
FROM checkout_quotes quote
JOIN offers offer ON offer.id = quote.offer_id
JOIN products product ON product.id = offer.product_id
LEFT JOIN orders ON orders.public_id = quote.order_public_id
LEFT JOIN checkout_attempts attempt ON attempt.order_id = orders.id;

DROP TABLE checkout_quotes;
ALTER TABLE checkout_intents_0030 RENAME TO checkout_quotes;

CREATE INDEX checkout_quotes_customer_state_idx ON checkout_quotes(customer_id, state, expires_at);
CREATE INDEX checkout_quotes_customer_offer_idx ON checkout_quotes(customer_id, offer_id, state);

CREATE TRIGGER checkout_quotes_line_snapshot_insert_guard
BEFORE INSERT ON checkout_quotes
WHEN NEW.line_snapshot_json IS NULL OR NOT json_valid(NEW.line_snapshot_json)
BEGIN
  SELECT RAISE(ABORT, 'CHECKOUT_QUOTE_LINE_SNAPSHOT_REQUIRED');
END;

CREATE TRIGGER checkout_intent_request_insert_guard
BEFORE INSERT ON checkout_quotes
WHEN NEW.resolution_request_json IS NULL OR NEW.request_fingerprint IS NULL OR NEW.state <> 'DRAFT' OR NEW.consumed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'CHECKOUT_INTENT_DRAFT_REQUIRED');
END;

-- What the intent froze before it first called Refref, and the quote once reviewed, never change.
CREATE TRIGGER checkout_intent_frozen_guard
BEFORE UPDATE ON checkout_quotes
WHEN NEW.id IS NOT OLD.id OR NEW.customer_id IS NOT OLD.customer_id OR NEW.offer_id IS NOT OLD.offer_id
  OR NEW.legal_release_id IS NOT OLD.legal_release_id OR NEW.storefront IS NOT OLD.storefront
  OR NEW.order_public_id IS NOT OLD.order_public_id OR NEW.line_ref IS NOT OLD.line_ref
  OR NEW.preview_idempotency_key IS NOT OLD.preview_idempotency_key OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.resolution_request_json IS NOT OLD.resolution_request_json OR NEW.sale_mode_at_quote IS NOT OLD.sale_mode_at_quote
  OR NEW.catalog_amount_kopecks IS NOT OLD.catalog_amount_kopecks OR NEW.merchant_discount_kopecks IS NOT OLD.merchant_discount_kopecks
  OR NEW.merchant_promotion_id IS NOT OLD.merchant_promotion_id
  OR NEW.merchant_promotion_snapshot_json IS NOT OLD.merchant_promotion_snapshot_json
  OR NEW.checkout_code_input IS NOT OLD.checkout_code_input OR NEW.line_snapshot_json IS NOT OLD.line_snapshot_json
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.rail_quote_json IS NOT NULL AND (NEW.rail_quote_json IS NOT OLD.rail_quote_json
    OR NEW.base_amount_kopecks IS NOT OLD.base_amount_kopecks OR NEW.discount_kopecks IS NOT OLD.discount_kopecks
    OR NEW.final_amount_kopecks IS NOT OLD.final_amount_kopecks OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.refref_checkout_code_outcome IS NOT OLD.refref_checkout_code_outcome))
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
BEGIN
  SELECT RAISE(ABORT, 'CHECKOUT_INTENT_FROZEN');
END;

-- Before confirmation an intent only moves forward; after it, never back to a state without payment.
-- Post-confirm read-back may correct DECLINED/EXPIRED/REVIEW_REQUIRED to PENDING or PAID:
-- a late authoritative payment is retained and reconciled rather than discarded as a stale local state.
CREATE TRIGGER checkout_intent_transition_guard
BEFORE UPDATE OF state ON checkout_quotes
WHEN NEW.state IS NOT OLD.state AND NOT (
  (OLD.state = 'DRAFT' AND NEW.state IN ('RESOLVING', 'REFUSED', 'EXPIRED'))
  OR (OLD.state = 'RESOLVING' AND NEW.state IN ('CUSTOMER_ACTION_REQUIRED', 'REVIEW', 'REFUSED', 'EXPIRED'))
  OR (OLD.state = 'CUSTOMER_ACTION_REQUIRED' AND NEW.state IN ('RESOLVING', 'REFUSED', 'EXPIRED'))
  OR (OLD.state = 'REVIEW' AND NEW.state IN ('PAYMENT_CREATING', 'EXPIRED'))
  OR (OLD.consumed_at IS NOT NULL AND OLD.state <> 'PAID'
    AND NEW.state IN ('PENDING', 'UNCERTAIN', 'PAID', 'DECLINED', 'EXPIRED', 'REVIEW_REQUIRED'))
)
BEGIN
  SELECT RAISE(ABORT, 'CHECKOUT_INTENT_TRANSITION_INVALID');
END;
