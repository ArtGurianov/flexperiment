-- FLEX-120/121 (B): MY session audience, MY OTP delivery facts, LMS session exchange and derived
-- LMS sessions. Contract: docs/plans/2026-11-20-my-identity-session-exchange-design.md §11.
-- Numbered on the current base chain; the coordinator assigns the final number (reserved 0038).
-- Existing sessions keep audience NULL (LEGACY); only the MY surface writes 'MY'.
ALTER TABLE "session" ADD COLUMN audience TEXT CHECK (audience IS NULL OR audience = 'MY');

-- Delivery facts only: the code itself exists solely as Better Auth's hash in verification.
CREATE TABLE my_otp_outbox (
  id TEXT PRIMARY KEY,
  recipient_normalized TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','SENT','FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 240),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX my_otp_outbox_recipient ON my_otp_outbox(recipient_normalized, created_at);

-- One browser-bound, one-time transition from a live MY session to a derived LMS session.
-- State, code and tokens are stored only as SHA-256. Signing out of MY deletes the session row,
-- which cascades to its exchanges and derived LMS sessions.
CREATE TABLE session_exchanges (
  id TEXT PRIMARY KEY CHECK (length(id) = 22 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  audience TEXT NOT NULL CHECK (audience = 'LMS'),
  return_path TEXT NOT NULL CHECK (length(return_path) BETWEEN 1 AND 256),
  state_sha256 TEXT NOT NULL CHECK (length(state_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('STARTED','ISSUED','REDEEMED','FAILED','CANCELED')),
  my_session_id TEXT REFERENCES "session"(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
  code_sha256 TEXT UNIQUE CHECK (code_sha256 IS NULL OR length(code_sha256) = 64),
  code_expires_at TEXT,
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) <= 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  issued_at TEXT,
  closed_at TEXT,
  CHECK (status NOT IN ('ISSUED','REDEEMED') OR (my_session_id IS NOT NULL AND customer_id IS NOT NULL
    AND code_sha256 IS NOT NULL AND code_expires_at IS NOT NULL AND issued_at IS NOT NULL)),
  CHECK (status <> 'FAILED' OR failure_code IS NOT NULL),
  CHECK ((status IN ('STARTED','ISSUED')) = (closed_at IS NULL))
);
CREATE INDEX session_exchanges_my_session ON session_exchanges(my_session_id);
CREATE INDEX session_exchanges_expiry ON session_exchanges(expires_at);

CREATE TABLE lms_sessions (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  parent_session_id TEXT NOT NULL REFERENCES "session"(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  exchange_id TEXT NOT NULL UNIQUE REFERENCES session_exchanges(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX lms_sessions_parent ON lms_sessions(parent_session_id);
CREATE INDEX lms_sessions_expiry ON lms_sessions(expires_at);
