-- A product's identity is what orders, entitlements and Refref snapshots refer to.
-- Price, sale mode, allowlist and access model stay editable under the version check;
-- what a product *is* (its kind, the course or occurrence it sells, its offer ref) does not.
CREATE TRIGGER products_identity_immutable
BEFORE UPDATE OF product_ref, kind, course_ref, occurrence_ref ON products
WHEN NEW.product_ref IS NOT OLD.product_ref
  OR NEW.kind IS NOT OLD.kind
  OR NEW.course_ref IS NOT OLD.course_ref
  OR NEW.occurrence_ref IS NOT OLD.occurrence_ref
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER offers_identity_immutable
BEFORE UPDATE OF offer_ref, product_id ON offers
WHEN NEW.offer_ref IS NOT OLD.offer_ref
  OR NEW.product_id IS NOT OLD.product_id
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_IDENTITY_IMMUTABLE');
END;
