-- ART-373: changing schedule/venue ends an unconfirmed quote permanently, including change-back.
-- Existing LAB quotes lack mutation history: request a fresh preview at this upgrade boundary.
-- Never touch a consumed intent: PENDING/UNCERTAIN payment and its seat remain read-back governed.
UPDATE checkout_quotes SET state='EXPIRED',failure_code='CHECKOUT_QUOTE_STALE',updated_at=CURRENT_TIMESTAMP
WHERE storefront='LAB' AND consumed_at IS NULL
  AND state IN ('DRAFT','RESOLVING','CUSTOMER_ACTION_REQUIRED','REVIEW');

CREATE TRIGGER lab_occurrences_invalidate_unconfirmed_quotes
AFTER UPDATE ON lab_occurrences
WHEN NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at
  OR NEW.timezone IS NOT OLD.timezone OR NEW.venue_status IS NOT OLD.venue_status
  OR NEW.venue_name IS NOT OLD.venue_name OR NEW.venue_address IS NOT OLD.venue_address
  OR NEW.venue_disclosure_text IS NOT OLD.venue_disclosure_text
  OR NEW.venue_announce_by IS NOT OLD.venue_announce_by OR NEW.lifecycle IS NOT OLD.lifecycle
BEGIN
  UPDATE checkout_quotes SET state='EXPIRED',
    failure_code=CASE WHEN NEW.lifecycle='CANCELLED' THEN 'LAB_OCCURRENCE_CANCELLED' ELSE 'CHECKOUT_QUOTE_STALE' END,
    updated_at=CURRENT_TIMESTAMP
  WHERE consumed_at IS NULL AND state IN ('DRAFT','RESOLVING','CUSTOMER_ACTION_REQUIRED','REVIEW')
    AND offer_id IN (SELECT offer.id FROM offers offer JOIN products product ON product.id=offer.product_id
      WHERE product.kind='LAB' AND product.occurrence_ref=OLD.occurrence_ref);
END;
