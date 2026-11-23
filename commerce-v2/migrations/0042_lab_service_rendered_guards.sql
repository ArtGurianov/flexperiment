-- FLEX-85 (D), E review item 4: the SERVICE_RENDERED fact is authoritative for FINAL_SETTLEMENT, so its
-- invariants hold in the schema, not only in code: the fact names its order line's own occurrence, and
-- it is recorded no earlier than that occurrence's end (rendered_at is already guarded by 0037).
CREATE TRIGGER lab_service_rendition_line_occurrence BEFORE INSERT ON lab_service_renditions
WHEN NEW.occurrence_ref IS NOT (SELECT product.occurrence_ref FROM order_lines line JOIN products product ON product.id = line.product_id
  WHERE line.id = NEW.order_line_id AND product.kind = 'LAB')
BEGIN SELECT RAISE(ABORT, 'LAB_SERVICE_RENDERED_OCCURRENCE_MISMATCH'); END;
CREATE TRIGGER lab_service_rendition_recorded_after_end BEFORE INSERT ON lab_service_renditions
WHEN julianday(NEW.recorded_at) < (SELECT julianday(ends_at) FROM lab_occurrences WHERE occurrence_ref = NEW.occurrence_ref)
BEGIN SELECT RAISE(ABORT, 'LAB_SERVICE_RENDERED_BEFORE_END'); END;
