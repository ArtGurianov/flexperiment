-- FLEX-128: minimal start-of-learning fact recorded by an explicit FREE enrollment.
-- Nonfinancial, subject-linked; no order, payment, course_access_starts or progress
-- is derived from it. Initial progress is shown as 0%; viewing/completion is not inferred.
CREATE TABLE course_learning_starts (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  course_ref TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  source TEXT NOT NULL CHECK (source = 'FREE_ENROLLMENT'),
  started_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, course_ref)
);
CREATE TRIGGER course_learning_start_authority BEFORE INSERT ON course_learning_starts
WHEN NOT EXISTS (
  SELECT 1 FROM free_course_enrollments f JOIN products p ON p.id=f.product_id
  WHERE f.customer_id=NEW.customer_id AND f.product_id=NEW.product_id
    AND p.kind='ONLINE_COURSE' AND p.course_ref=NEW.course_ref
)
BEGIN SELECT RAISE(ABORT, 'COURSE_LEARNING_START_AUTHORITY_INVALID'); END;
CREATE TRIGGER course_learning_start_immutable BEFORE UPDATE ON course_learning_starts
BEGIN SELECT RAISE(ABORT, 'COURSE_LEARNING_START_IMMUTABLE'); END;
