CREATE TABLE merchant_promotion (
  id TEXT PRIMARY KEY,
  code_normalized TEXT NOT NULL UNIQUE,
  discount_kind TEXT NOT NULL CHECK (discount_kind IN ('FIXED', 'PERCENT_BPS')),
  discount_value INTEGER NOT NULL CHECK (discount_value > 0),
  eligible_offer_ref TEXT REFERENCES offers(offer_ref),
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CHECK ((discount_kind = 'PERCENT_BPS' AND discount_value < 10000) OR discount_kind = 'FIXED')
);

CREATE INDEX merchant_promotion_active_window_idx
  ON merchant_promotion(active, starts_at, ends_at);

ALTER TABLE checkout_quotes ADD COLUMN catalog_amount_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (catalog_amount_kopecks >= 0);
ALTER TABLE checkout_quotes ADD COLUMN merchant_discount_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (merchant_discount_kopecks >= 0);
ALTER TABLE checkout_quotes ADD COLUMN merchant_promotion_id TEXT REFERENCES merchant_promotion(id);
ALTER TABLE checkout_quotes ADD COLUMN merchant_promotion_snapshot_json TEXT CHECK (merchant_promotion_snapshot_json IS NULL OR json_valid(merchant_promotion_snapshot_json));
ALTER TABLE checkout_quotes ADD COLUMN refref_checkout_code_outcome TEXT CHECK (refref_checkout_code_outcome IS NULL OR refref_checkout_code_outcome IN ('NONE','APPLIED','NOT_APPLICABLE','NOT_RECOGNIZED','NOT_APPLIED_ATTRIBUTION_LOCKED','NOT_APPLIED_CUSTOMER_KEPT_CURRENT'));
ALTER TABLE checkout_quotes ADD COLUMN checkout_code_input TEXT;

UPDATE checkout_quotes SET catalog_amount_kopecks = base_amount_kopecks WHERE catalog_amount_kopecks = 0;
