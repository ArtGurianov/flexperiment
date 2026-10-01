ALTER TABLE checkout_quotes ADD COLUMN line_snapshot_json TEXT
  CHECK (line_snapshot_json IS NULL OR json_valid(line_snapshot_json));

CREATE TRIGGER checkout_quotes_line_snapshot_insert_guard
BEFORE INSERT ON checkout_quotes
WHEN NEW.line_snapshot_json IS NULL OR NOT json_valid(NEW.line_snapshot_json)
BEGIN
  SELECT RAISE(ABORT, 'CHECKOUT_QUOTE_LINE_SNAPSHOT_REQUIRED');
END;

ALTER TABLE order_lines ADD COLUMN catalog_amount_kopecks INTEGER
  CHECK (catalog_amount_kopecks IS NULL OR catalog_amount_kopecks >= 0);
ALTER TABLE order_lines ADD COLUMN merchant_discount_kopecks INTEGER
  CHECK (merchant_discount_kopecks IS NULL OR merchant_discount_kopecks >= 0);
ALTER TABLE order_lines ADD COLUMN merchant_amount_kopecks INTEGER
  CHECK (merchant_amount_kopecks IS NULL OR merchant_amount_kopecks > 0);
ALTER TABLE order_lines ADD COLUMN merchant_promotion_snapshot_json TEXT
  CHECK (merchant_promotion_snapshot_json IS NULL OR json_valid(merchant_promotion_snapshot_json));
ALTER TABLE order_lines ADD COLUMN fiscal_item_json TEXT
  CHECK (fiscal_item_json IS NULL OR json_valid(fiscal_item_json));
ALTER TABLE order_lines ADD COLUMN legal_release_ref TEXT;
ALTER TABLE order_lines ADD COLUMN legal_release_hash TEXT
  CHECK (legal_release_hash IS NULL OR (length(legal_release_hash) = 64 AND legal_release_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE order_lines ADD COLUMN occurrence_snapshot_json TEXT
  CHECK (occurrence_snapshot_json IS NULL OR json_valid(occurrence_snapshot_json));

CREATE TRIGGER order_lines_canonical_snapshot_insert_guard
BEFORE INSERT ON order_lines
WHEN json_extract((SELECT checkout_snapshot_json FROM orders WHERE id = NEW.order_id), '$.schema') = 'refref.shared-checkout-snapshot/1'
  AND (
    NEW.catalog_amount_kopecks IS NULL
    OR NEW.merchant_discount_kopecks IS NULL
    OR NEW.merchant_amount_kopecks IS NULL
    OR NEW.fiscal_item_json IS NULL
    OR NEW.legal_release_ref IS NULL
    OR NEW.legal_release_hash IS NULL
    OR ((SELECT kind FROM products WHERE id = NEW.product_id) = 'LAB' AND NEW.occurrence_snapshot_json IS NULL)
    OR ((SELECT kind FROM products WHERE id = NEW.product_id) <> 'LAB' AND NEW.occurrence_snapshot_json IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'ORDER_LINE_CANONICAL_SNAPSHOT_INCOMPLETE');
END;

CREATE TRIGGER orders_canonical_snapshot_immutable
BEFORE UPDATE OF public_id, customer_id, currency, total_kopecks, checkout_snapshot_json, snapshot_hash, legal_release_id ON orders
WHEN json_extract(OLD.checkout_snapshot_json, '$.schema') = 'refref.shared-checkout-snapshot/1'
BEGIN
  SELECT RAISE(ABORT, 'ORDER_CANONICAL_SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER order_lines_canonical_snapshot_immutable
BEFORE UPDATE ON order_lines
WHEN json_extract((SELECT checkout_snapshot_json FROM orders WHERE id = OLD.order_id), '$.schema') = 'refref.shared-checkout-snapshot/1'
BEGIN
  SELECT RAISE(ABORT, 'ORDER_LINE_CANONICAL_SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER order_lines_canonical_snapshot_delete_guard
BEFORE DELETE ON order_lines
WHEN json_extract((SELECT checkout_snapshot_json FROM orders WHERE id = OLD.order_id), '$.schema') = 'refref.shared-checkout-snapshot/1'
BEGIN
  SELECT RAISE(ABORT, 'ORDER_LINE_CANONICAL_SNAPSHOT_IMMUTABLE');
END;
