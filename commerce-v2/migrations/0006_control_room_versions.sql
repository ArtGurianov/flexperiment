ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
CREATE UNIQUE INDEX one_offer_per_product ON offers(product_id);

ALTER TABLE merchant_promotion ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
