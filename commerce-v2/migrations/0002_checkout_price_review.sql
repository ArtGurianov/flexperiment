CREATE TABLE checkout_quotes (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  offer_id TEXT NOT NULL REFERENCES offers(id),
  legal_release_id TEXT NOT NULL REFERENCES legal_releases(id),
  order_public_id TEXT NOT NULL UNIQUE,
  line_ref TEXT NOT NULL UNIQUE,
  preview_idempotency_key TEXT NOT NULL UNIQUE,
  base_amount_kopecks INTEGER NOT NULL CHECK (base_amount_kopecks > 0),
  discount_kopecks INTEGER NOT NULL CHECK (discount_kopecks >= 0),
  final_amount_kopecks INTEGER NOT NULL CHECK (final_amount_kopecks > 0),
  rail_quote_json TEXT NOT NULL CHECK (json_valid(rail_quote_json)),
  state TEXT NOT NULL DEFAULT 'REVIEW' CHECK (state IN ('REVIEW', 'CONSUMED', 'EXPIRED')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (final_amount_kopecks = base_amount_kopecks - discount_kopecks),
  CHECK ((state = 'CONSUMED') = (consumed_at IS NOT NULL))
);

CREATE INDEX checkout_quotes_customer_state_idx ON checkout_quotes(customer_id, state, expires_at);
