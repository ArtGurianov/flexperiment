CREATE UNIQUE INDEX one_all_courses_bundle_product ON products(kind) WHERE kind = 'COURSE_BUNDLE';

CREATE TABLE all_courses_bundle_migration_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO all_courses_bundle_migration_guard(valid)
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM products
    WHERE kind = 'COURSE_BUNDLE' AND product_ref <> 'bundle:all-courses'
  ) THEN 0
  ELSE 1
END;

DROP TABLE all_courses_bundle_migration_guard;

CREATE TRIGGER products_all_courses_bundle_insert_guard
BEFORE INSERT ON products
WHEN NEW.kind = 'COURSE_BUNDLE' AND NEW.product_ref <> 'bundle:all-courses'
BEGIN
  SELECT RAISE(ABORT, 'ALL_COURSES_BUNDLE_REF_INVALID');
END;

CREATE TRIGGER products_all_courses_bundle_update_guard
BEFORE UPDATE OF kind, product_ref ON products
WHEN NEW.kind = 'COURSE_BUNDLE' AND NEW.product_ref <> 'bundle:all-courses'
BEGIN
  SELECT RAISE(ABORT, 'ALL_COURSES_BUNDLE_REF_INVALID');
END;
