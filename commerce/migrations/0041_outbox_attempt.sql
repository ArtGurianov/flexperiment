-- Outbox attempt history: schema only.
--
-- This migration does NOT activate attempt authority. `0041 applied` and
-- `ATTEMPT authoritative` are independent facts, and keeping them independent is
-- what makes rolling convergence safe: an old binary may still write legacy
-- attempt facts while authority remains LEGACY, and the flip happens only once
-- no such binary remains. A migration that activated on application would make
-- convergence a race.
--
--   STATE A  0040 only, LEGACY, dispatch open
--   STATE B  0041 applied, LEGACY still authoritative, dispatch fenced   <- here
--   STATE C  authority activated, legacy columns frozen, still fenced
--   STATE D  ATTEMPT, dispatch open
--
-- This migration is expected to be applied in STATE B, i.e. WHILE THE FENCE IS
-- HELD. It therefore changes the representable state space and must not touch
-- the current authority: the control row survives byte-for-byte, fence and owner
-- included.

-- 1. Attempt history.
CREATE TABLE outbox_attempt (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES email_outbox(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),

  -- Opaque and persisted, never derived. Stable within an attempt - which is
  -- what makes an ambiguous replay safe - and distinct across attempts, which
  -- is what makes a resend reach the provider at all. Attempt #1 carries the
  -- message's existing key byte-for-byte so today's replay protection is
  -- preserved exactly.
  provider_idempotence_key TEXT NOT NULL UNIQUE,

  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  provider_request_started_at TEXT,
  -- When THIS SEND settled - acceptance or refusal established. Not when a
  -- recipient's mail server later emitted a delivery event.
  completed_at TEXT,
  provider_job_id TEXT,

  -- Scheduling and mutual exclusion belong to the attempt: a resend has its own
  -- retry budget and its own lease sequence. send_try_count is the try counter
  -- for THIS attempt, not a count of attempts - legacy `attempts` backfills
  -- into it directly, and must never be used to synthesise multiple logical
  -- attempts.
  send_try_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,

  -- NULL means acceptance or refusal is NOT ESTABLISHED - in flight, or
  -- ambiguous and unsettled. Settling is monotone and one-way.
  --
  -- There is deliberately no UNRESOLVED: an unresolved send is one whose
  -- outcome was never established, and later provider evidence may still settle
  -- it, which an immutable terminal value would forbid. Ambiguity is a
  -- message-level fact and 0039 models it there.
  --
  -- ACCEPTED, not DELIVERED: this is whether the provider accepted THIS SEND.
  -- Whether anyone received it is decided later by provider events and belongs
  -- to the message, so a bounce never rewrites a settled attempt.
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('ACCEPTED', 'KNOWN_FAILED')),
  failure_code TEXT,
  failure_detail TEXT,
  -- Automatic reconciliation budget spent. Scheduling metadata, never evidence:
  -- it must not settle `outcome`, and no elapsed time may either.
  reconciliation_exhausted_at TEXT,

  UNIQUE (message_id, attempt_no)
);

-- At most one unsettled attempt per message.
--
-- This is not only concurrency control. It is what makes the resend rule
-- structural: a message that is FAILED + UNRESOLVED has an attempt whose
-- outcome IS NULL, that attempt occupies this slot, and so the database cannot
-- represent a resend beside an unresolved send. The rule stops depending on a
-- check inside a transaction.
CREATE UNIQUE INDEX outbox_attempt_active_unique
  ON outbox_attempt(message_id) WHERE outcome IS NULL;

CREATE INDEX outbox_attempt_message_idx ON outbox_attempt(message_id, attempt_no);

-- What this row IS never changes, settled or not.
--
-- The unique constraint proves a key is not used by another attempt. It does
-- NOT prove this attempt still carries the key its provider request was made
-- under, and that is the property the whole replay model rests on:
--
--   request sent with key-original, outcome still ambiguous
--   a retry path rewrites the row to key-new
--   the retry reaches the provider as a DIFFERENT logical request
--   the recipient gets two emails
--
-- Separate from settled-immutability because it must hold during the window
-- where the row is legitimately still changing - which is exactly the window in
-- which an ambiguous send is being retried.
CREATE TRIGGER outbox_attempt_identity_immutable_guard
BEFORE UPDATE ON outbox_attempt
WHEN NEW.id IS NOT OLD.id
  OR NEW.message_id IS NOT OLD.message_id
  OR NEW.attempt_no IS NOT OLD.attempt_no
  OR NEW.provider_idempotence_key IS NOT OLD.provider_idempotence_key
  OR NEW.requested_at IS NOT OLD.requested_at
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_ATTEMPT_IDENTITY_IMMUTABLE');
END;

-- A settled attempt is history and never changes. An unsettled one stays
-- mutable in its progress fields - lease, retry state, provider job id - which
-- is what lets later evidence settle it.
CREATE TRIGGER outbox_attempt_settled_immutable_guard
BEFORE UPDATE ON outbox_attempt
WHEN OLD.outcome IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_ATTEMPT_SETTLED_IMMUTABLE');
END;

-- History is not only unmodifiable, it is undiscardable.
--
-- Without this the database proved "two unsettled attempts cannot coexist" but
-- not the property that matters: an unresolved attempt could be DELETED,
-- freeing the partial-unique slot, and a resend inserted beside a send whose
-- outcome was never established. It also made "settled history is immutable"
-- mean only "cannot be updated" while the row could still vanish.
--
-- The WHEN clause is what lets the parent cascade through: deleting a message
-- removes the parent row first, so by the time the cascade reaches its
-- attempts, EXISTS is false and the guard stands aside. Purging a message still
-- purges its history; nothing else can.
CREATE TRIGGER outbox_attempt_delete_guard
BEFORE DELETE ON outbox_attempt
WHEN EXISTS (SELECT 1 FROM email_outbox WHERE id = OLD.message_id)
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_ATTEMPT_DELETE_FORBIDDEN');
END;

-- 2. Drop the 0040 guards BEFORE the rebuild below.
--
-- ALTER TABLE RENAME rewrites trigger bodies to follow the renamed table, so
-- renaming outbox_authority while these exist would repoint them at the
-- temporary table and dropping it would leave the fence silently not fencing.
-- Dropping first and recreating last avoids the rewrite entirely rather than
-- repairing it afterwards. Proven in outbox-authority-control.test.ts, which
-- walks this exact path.
DROP TRIGGER email_outbox_dispatch_pause_guard;
DROP TRIGGER email_outbox_legacy_attempt_freeze_guard;

-- 3. Widen the authority state space to admit ATTEMPT.
--
-- The current control row is preserved exactly, fence and owner included: this
-- migration is applied while the fence is held, and a rebuild that reset to
-- defaults would silently unfence production mail mid-cutover. It changes what
-- is representable, never what is currently true.
ALTER TABLE outbox_authority RENAME TO outbox_authority_0041_legacy;
CREATE TABLE outbox_authority (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  attempt_authority TEXT NOT NULL DEFAULT 'LEGACY' CHECK (attempt_authority IN ('LEGACY', 'ATTEMPT')),
  email_dispatch_paused INTEGER NOT NULL DEFAULT 0 CHECK (email_dispatch_paused IN (0, 1)),
  dispatch_owner_release_id TEXT,
  dispatch_owner_generation INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((email_dispatch_paused = 1) = (dispatch_owner_release_id IS NOT NULL))
);
INSERT INTO outbox_authority(singleton, attempt_authority, email_dispatch_paused,
  dispatch_owner_release_id, dispatch_owner_generation, revision, updated_at)
  SELECT singleton, attempt_authority, email_dispatch_paused,
    dispatch_owner_release_id, dispatch_owner_generation, revision, updated_at
  FROM outbox_authority_0041_legacy;
DROP TABLE outbox_authority_0041_legacy;

-- 4. Widen the audit vocabulary.
--
-- 0040 restricted this to the two transitions it was allowed to perform, so an
-- activation had no action to record. Now that LEGACY -> ATTEMPT becomes
-- representable it needs durable evidence too, and the existing fence history
-- is carried across unchanged - an append-only stream that loses its past is
-- not an audit trail.
ALTER TABLE outbox_authority_events RENAME TO outbox_authority_events_0041_legacy;
CREATE TABLE outbox_authority_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('DISPATCH_FENCED', 'DISPATCH_UNFENCED', 'AUTHORITY_ACTIVATED')),
  owner_release_id TEXT NOT NULL,
  owner_generation INTEGER,
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO outbox_authority_events(id, action, owner_release_id, owner_generation, reason, revision, created_at)
  SELECT id, action, owner_release_id, owner_generation, reason, revision, created_at
  FROM outbox_authority_events_0041_legacy;
DROP TABLE outbox_authority_events_0041_legacy;
CREATE INDEX outbox_authority_events_created_idx ON outbox_authority_events(created_at);

-- 5. Recreate both 0040 guards, verbatim, against the rebuilt table.
CREATE TRIGGER email_outbox_dispatch_pause_guard
BEFORE UPDATE ON email_outbox
WHEN NEW.status = 'SENDING'
  AND OLD.status IN ('PENDING', 'SEND_UNKNOWN')
  AND COALESCE((SELECT email_dispatch_paused FROM outbox_authority WHERE singleton = 1), 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'EMAIL_DISPATCH_PAUSED');
END;

CREATE TRIGGER email_outbox_legacy_attempt_freeze_guard
BEFORE UPDATE ON email_outbox
WHEN COALESCE((SELECT attempt_authority FROM outbox_authority WHERE singleton = 1), 'LEGACY') = 'ATTEMPT'
  AND (
    NEW.provider_idempotence_key IS NOT OLD.provider_idempotence_key
    OR NEW.job_id IS NOT OLD.job_id
    OR NEW.lease_owner IS NOT OLD.lease_owner
    OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
    OR NEW.send_started_at IS NOT OLD.send_started_at
    OR NEW.provider_request_started_at IS NOT OLD.provider_request_started_at
    OR NEW.attempts IS NOT OLD.attempts
    OR NEW.last_error IS NOT OLD.last_error
    OR NEW.provider_error_code IS NOT OLD.provider_error_code
    OR NEW.provider_error_message IS NOT OLD.provider_error_message
    OR NEW.next_attempt_at IS NOT OLD.next_attempt_at
  )
BEGIN
  SELECT RAISE(ABORT, 'EMAIL_OUTBOX_LEGACY_ATTEMPT_FROZEN');
END;
