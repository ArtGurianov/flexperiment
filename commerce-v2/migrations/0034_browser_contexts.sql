-- ART-378 (B2): merchant browser contexts and short-lived arrival proofs (refref docs/29 §2, §4, §6).
-- A context is one browser on one storefront origin. Refref learns only its opaque ID and origin; the
-- binding to an LMS account stays here and exists only to rotate the context on logout/account switch.
-- Erasing a customer cascades to the contexts bound to them and to their proofs.
CREATE TABLE browser_contexts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 32 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  storefront TEXT NOT NULL CHECK (storefront IN ('COURSES','LAB')),
  storefront_origin TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ROTATED','CLOSED')),
  bound_customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
  -- Only a context Refref closed is re-homed; an account-boundary rotation never has a successor.
  successor_id TEXT REFERENCES browser_contexts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  retired_at TEXT,
  retire_reason TEXT CHECK (retire_reason IN ('LOGOUT','ACCOUNT_SWITCH','REFREF_CLOSED')),
  close_state TEXT CHECK (close_state IN ('PENDING','ACKNOWLEDGED','REFUSED')),
  close_attempts INTEGER NOT NULL DEFAULT 0,
  close_settled_at TEXT,
  CHECK ((status = 'ACTIVE') = (retired_at IS NULL)),
  CHECK ((status = 'ACTIVE') = (retire_reason IS NULL)),
  CHECK (status <> 'ROTATED' OR (close_state IS NOT NULL AND successor_id IS NULL)),
  CHECK (bound_customer_id IS NULL OR storefront = 'COURSES')
);
CREATE INDEX browser_contexts_close_pending ON browser_contexts(retired_at) WHERE close_state = 'PENDING';
CREATE INDEX browser_contexts_expiry ON browser_contexts(expires_at);

-- Raw proof is temporary merchant state: it is cleared as soon as the claim settles and never
-- outlives the 30-minute claim window. The hash alone keeps a repeated landing idempotent.
CREATE TABLE browser_context_arrivals (
  id TEXT PRIMARY KEY,
  browser_context_id TEXT NOT NULL REFERENCES browser_contexts(id) ON DELETE CASCADE,
  proof_sha256 TEXT NOT NULL UNIQUE CHECK (length(proof_sha256) = 64),
  arrival_proof TEXT,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','CONFIRMED','FAILED','EXPIRED','ABANDONED')),
  failure_code TEXT,
  captured_at TEXT NOT NULL,
  claim_deadline_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  claim_id TEXT,
  eligible_until TEXT,
  settled_at TEXT,
  CHECK (state = 'PENDING' OR arrival_proof IS NULL),
  CHECK ((state = 'CONFIRMED') = (claim_id IS NOT NULL)),
  CHECK ((state = 'PENDING') = (settled_at IS NULL))
);
CREATE INDEX browser_context_arrivals_context ON browser_context_arrivals(browser_context_id, state);
