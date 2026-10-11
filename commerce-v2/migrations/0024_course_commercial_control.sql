-- Nonfinancial access receipts; no synthetic order/payment or historical backfill.
CREATE TABLE free_course_enrollments (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_version INTEGER NOT NULL CHECK (product_version > 0),
  enrolled_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, product_id)
);
CREATE TRIGGER free_course_enrollment_authority BEFORE INSERT ON free_course_enrollments
WHEN NOT EXISTS (
  SELECT 1 FROM customers c JOIN "user" u ON u.id=c.auth_user_id JOIN products p ON p.id=NEW.product_id
  WHERE c.id=NEW.customer_id AND u.email_verified=1 AND lower(trim(u.email))=c.email_normalized
    AND p.kind='ONLINE_COURSE' AND p.access_model='FREE' AND p.withdrawn_at IS NULL AND p.version=NEW.product_version
)
BEGIN SELECT RAISE(ABORT, 'FREE_ENROLLMENT_AUTHORITY_INVALID'); END;
CREATE TRIGGER free_course_enrollment_immutable BEFORE UPDATE ON free_course_enrollments
BEGIN SELECT RAISE(ABORT, 'FREE_ENROLLMENT_IMMUTABLE'); END;

CREATE TABLE course_commercial_commands (
  actor TEXT NOT NULL,
  course_ref TEXT NOT NULL,
  command_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor, course_ref, command_key)
);
