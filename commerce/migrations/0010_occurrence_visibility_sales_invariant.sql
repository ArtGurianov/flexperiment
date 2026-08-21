-- A hidden occurrence is never sellable. Domain code additionally enforces
-- the allowed one-step lifecycle; these triggers protect direct SQLite writes.
CREATE TRIGGER IF NOT EXISTS occurrences_visibility_sales_before_insert
BEFORE INSERT ON occurrences
WHEN NEW.visibility = 'HIDDEN' AND NEW.sales_status <> 'CLOSED'
BEGIN
  SELECT RAISE(ABORT, 'OCCURRENCE_HIDDEN_SALES_MUST_BE_CLOSED');
END;

CREATE TRIGGER IF NOT EXISTS occurrences_visibility_sales_before_update
BEFORE UPDATE OF visibility, sales_status ON occurrences
WHEN NEW.visibility = 'HIDDEN' AND NEW.sales_status <> 'CLOSED'
BEGIN
  SELECT RAISE(ABORT, 'OCCURRENCE_HIDDEN_SALES_MUST_BE_CLOSED');
END;
