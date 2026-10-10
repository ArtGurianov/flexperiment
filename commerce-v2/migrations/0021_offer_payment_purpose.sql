-- Explicit merchant business data. No title/fiscal/provider backfill and no order rewrite.
ALTER TABLE offers ADD COLUMN payment_purpose TEXT;

-- Extend the existing canonical guards to V2 without modifying historical V1 bytes/hashes.
DROP TRIGGER orders_canonical_snapshot_immutable;
CREATE TRIGGER orders_canonical_snapshot_immutable
BEFORE UPDATE OF public_id,customer_id,currency,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id ON orders
WHEN json_extract(OLD.checkout_snapshot_json,'$.schema') IN ('refref.shared-checkout-snapshot/1','refref.shared-checkout-snapshot/2')
BEGIN SELECT RAISE(ABORT,'ORDER_CANONICAL_SNAPSHOT_IMMUTABLE'); END;

DROP TRIGGER order_lines_canonical_snapshot_immutable;
CREATE TRIGGER order_lines_canonical_snapshot_immutable BEFORE UPDATE ON order_lines
WHEN json_extract((SELECT checkout_snapshot_json FROM orders WHERE id=OLD.order_id),'$.schema') IN ('refref.shared-checkout-snapshot/1','refref.shared-checkout-snapshot/2')
BEGIN SELECT RAISE(ABORT,'ORDER_LINE_CANONICAL_SNAPSHOT_IMMUTABLE'); END;

DROP TRIGGER order_lines_canonical_snapshot_delete_guard;
CREATE TRIGGER order_lines_canonical_snapshot_delete_guard BEFORE DELETE ON order_lines
WHEN json_extract((SELECT checkout_snapshot_json FROM orders WHERE id=OLD.order_id),'$.schema') IN ('refref.shared-checkout-snapshot/1','refref.shared-checkout-snapshot/2')
BEGIN SELECT RAISE(ABORT,'ORDER_LINE_CANONICAL_SNAPSHOT_IMMUTABLE'); END;

DROP TRIGGER order_lines_canonical_snapshot_insert_guard;
CREATE TRIGGER order_lines_canonical_snapshot_insert_guard BEFORE INSERT ON order_lines
WHEN json_extract((SELECT checkout_snapshot_json FROM orders WHERE id=NEW.order_id),'$.schema') IN ('refref.shared-checkout-snapshot/1','refref.shared-checkout-snapshot/2')
  AND (NEW.catalog_amount_kopecks IS NULL OR NEW.merchant_discount_kopecks IS NULL
    OR NEW.merchant_amount_kopecks IS NULL OR NEW.fiscal_item_json IS NULL
    OR NEW.legal_release_ref IS NULL OR NEW.legal_release_hash IS NULL
    OR ((SELECT kind FROM products WHERE id=NEW.product_id)='LAB' AND NEW.occurrence_snapshot_json IS NULL)
    OR ((SELECT kind FROM products WHERE id=NEW.product_id)<>'LAB' AND NEW.occurrence_snapshot_json IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'ORDER_LINE_CANONICAL_SNAPSHOT_INCOMPLETE'); END;
