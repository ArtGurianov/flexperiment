ALTER TABLE products
  ADD COLUMN occurrence_ref TEXT REFERENCES lab_occurrences(occurrence_ref);

CREATE UNIQUE INDEX one_product_per_lab_occurrence
  ON products(occurrence_ref) WHERE occurrence_ref IS NOT NULL;

CREATE TABLE product_occurrence_migration_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO product_occurrence_migration_guard(valid)
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM products
    WHERE (kind = 'LAB' AND occurrence_ref IS NULL)
       OR (kind <> 'LAB' AND occurrence_ref IS NOT NULL)
  ) THEN 0
  ELSE 1
END;

DROP TABLE product_occurrence_migration_guard;

CREATE TRIGGER products_occurrence_insert_guard
BEFORE INSERT ON products
WHEN (NEW.kind = 'LAB' AND NEW.occurrence_ref IS NULL)
  OR (NEW.kind <> 'LAB' AND NEW.occurrence_ref IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_OCCURRENCE_CONTRACT_INVALID');
END;

CREATE TRIGGER products_occurrence_update_guard
BEFORE UPDATE OF kind, occurrence_ref ON products
WHEN (NEW.kind = 'LAB' AND NEW.occurrence_ref IS NULL)
  OR (NEW.kind <> 'LAB' AND NEW.occurrence_ref IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_OCCURRENCE_CONTRACT_INVALID');
END;
