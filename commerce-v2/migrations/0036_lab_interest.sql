-- FLEX-8 (owner decision 2026-11-22): LAB showcase while sales are closed. A visitor may leave an
-- email to be told when LAB sales open. This is interest only: it never reserves a seat, never
-- creates a customer, order, quote, hold, guest access or ticket, and never touches payment state.
--
-- Personal data: the normalized email is the only subject identifier. It serves one purpose,
-- LAB_SALES_NOTICE. A withdrawal deletes the row (and its notice rows by cascade). Erasure matches
-- the email pseudonym and deletes the row; the suppression list keeps the subject out of later sends.
-- Pending and confirmed rows are removed by the explicit, reviewed retention policy in
-- lab-interest.ts (no default durations). The withdrawal link is derived from the row id with the
-- server secret, so no withdrawal token is stored; the confirmation token is stored only as SHA-256.

CREATE TABLE lab_interest_signups (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 32 AND 64),
  email_normalized TEXT NOT NULL CHECK (length(email_normalized) BETWEEN 3 AND 254 AND email_normalized = lower(trim(email_normalized))),
  -- NULL: any LAB city.
  city_id TEXT REFERENCES cities(id),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'CONFIRMED')),
  purpose TEXT NOT NULL CHECK (purpose = 'LAB_SALES_NOTICE'),
  consent_text_version TEXT NOT NULL CHECK (length(consent_text_version) BETWEEN 1 AND 64),
  consent_text_sha256 TEXT NOT NULL CHECK (length(consent_text_sha256) = 64 AND consent_text_sha256 NOT GLOB '*[^0-9a-f]*'),
  confirm_token_sha256 TEXT UNIQUE CHECK (confirm_token_sha256 IS NULL OR (length(confirm_token_sha256) = 64 AND confirm_token_sha256 NOT GLOB '*[^0-9a-f]*')),
  confirm_expires_at TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  CHECK ((state = 'PENDING' AND confirmed_at IS NULL AND confirm_token_sha256 IS NOT NULL AND confirm_expires_at IS NOT NULL)
      OR (state = 'CONFIRMED' AND confirmed_at IS NOT NULL AND confirm_token_sha256 IS NULL AND confirm_expires_at IS NULL))
);
CREATE UNIQUE INDEX lab_interest_signups_subject_scope ON lab_interest_signups(email_normalized, ifnull(city_id, ''));
CREATE INDEX lab_interest_signups_state_time ON lab_interest_signups(state, created_at);

-- At-most-once delivery per signup and notice: the row is written before the provider call, so an
-- unknown outcome is never retried as a second message.
CREATE TABLE lab_interest_notices (
  signup_id TEXT NOT NULL REFERENCES lab_interest_signups(id) ON DELETE CASCADE,
  notice_key TEXT NOT NULL CHECK (length(notice_key) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('ATTEMPTED', 'SENT')),
  attempted_at TEXT NOT NULL,
  sent_at TEXT,
  CHECK ((state = 'SENT') = (sent_at IS NOT NULL)),
  PRIMARY KEY (signup_id, notice_key)
);
