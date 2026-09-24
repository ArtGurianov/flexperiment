-- Where an armed cutover session has been carried forward to.
--
-- A session's `target_sha` and `candidate_id` are frozen at acquisition and
-- stay the historical fact of what the cutover first set out to deploy. When
-- that target turns out to be uncertifiable after arming - rollback forbidden,
-- sales fenced - recovery is forward only, to a newer release, and this table
-- is the record of each step: revision N moved the session from `from_sha` to
-- `target_sha`. The session's current release binding is its highest revision,
-- or revision 0 (its own target) when it has none. See
-- docs/release/FORWARD_SUPERSESSION.md.
--
-- A predeploy-compatible expand migration: it is applied while the previous
-- target is still serving, so it adds a table and triggers on that table only,
-- and changes nothing about any write the previous target can make.
--
-- The authority for appending is `ReleaseAuthorityStore.appendForwardTarget`,
-- which also proves the caller owns the session's lease. These triggers are the
-- backstop for the rules that need no caller identity.
CREATE TABLE deploy_session_forward_targets (
  session_id TEXT NOT NULL REFERENCES deploy_sessions(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  from_sha TEXT NOT NULL CHECK (length(from_sha) = 40),
  target_sha TEXT NOT NULL CHECK (length(target_sha) = 40 AND target_sha <> from_sha),
  candidate_id TEXT NOT NULL,
  -- The exact-SHA CI attestation admission read when this revision was made.
  -- Resumption relies on it instead of asking GitHub again.
  ci_evidence TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, revision)
);

-- Only an armed, stuck, fenced session with no rollback reserved may be carried
-- forward. Anything else can still roll back, or is not in recovery at all.
CREATE TRIGGER deploy_session_forward_targets_session_guard
BEFORE INSERT ON deploy_session_forward_targets
WHEN NOT EXISTS (
  SELECT 1 FROM deploy_sessions
  WHERE id = NEW.session_id
    AND mode = 'MAINTENANCE_CUTOVER'
    AND state = 'RECOVERY_REQUIRED'
    AND rollback_authority = 'NEW_LINEAGE_ONLY'
    AND deployment_gate_closed = 1
    AND bootstrap_rollback_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'FORWARD_TARGET_SESSION_NOT_SUPERSEDABLE'); END;

-- Gap-free and chained: each revision is the next number, and starts from
-- where the previous one (or the session itself) left off.
CREATE TRIGGER deploy_session_forward_targets_chain_guard
BEFORE INSERT ON deploy_session_forward_targets
WHEN NEW.revision IS NOT (
    SELECT COALESCE(MAX(revision), 0) + 1 FROM deploy_session_forward_targets WHERE session_id = NEW.session_id)
  OR NEW.from_sha IS NOT COALESCE(
    (SELECT target_sha FROM deploy_session_forward_targets WHERE session_id = NEW.session_id ORDER BY revision DESC LIMIT 1),
    (SELECT target_sha FROM deploy_sessions WHERE id = NEW.session_id))
BEGIN SELECT RAISE(ABORT, 'FORWARD_TARGET_CHAIN_BROKEN'); END;

-- A revision is a record of what happened. It is never rewritten or removed.
CREATE TRIGGER deploy_session_forward_targets_immutable
BEFORE UPDATE ON deploy_session_forward_targets
BEGIN SELECT RAISE(ABORT, 'FORWARD_TARGET_IMMUTABLE'); END;

CREATE TRIGGER deploy_session_forward_targets_undeletable
BEFORE DELETE ON deploy_session_forward_targets
BEGIN SELECT RAISE(ABORT, 'FORWARD_TARGET_IMMUTABLE'); END;
