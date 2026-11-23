-- Refusing LAB notices must not change COURSE consent or disable ticket recovery mail.
CREATE TABLE lab_interest_suppressions (
  email_normalized TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);
