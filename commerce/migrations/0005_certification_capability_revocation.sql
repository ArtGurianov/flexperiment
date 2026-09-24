-- A capability's retirement records why, and one reason may come early.
--
-- `retired_at` already means "never usable again": every bearer check refuses a
-- retired capability, and the live-slot index stops counting it. What 0003
-- guarded is *when* it may be set - only once the capability has expired, at
-- the database's own now. That stays the rule for replacement.
--
-- It made a TTL into an operational lock. Attempt 5's release could not be
-- certified; its last capability was provably never spent and its run
-- provably did nothing, yet carrying the session forward had to wait hours for
-- that capability to expire. A TTL is a safety backstop for an abandoned
-- capability, not a mutex on recovery.
--
-- So retirement now carries a reason:
--
--   EXPIRED_REPLACED       natural expiry, exactly as before. A NULL reason is
--                          held to the same rule, so an older writer keeps
--                          working unchanged.
--   FORWARD_SUPERSESSION   may be early, but only while the capability's
--                          session is an armed, stuck, fenced cutover with no
--                          rollback reserved, and only for a capability of the
--                          session's CURRENT release binding. The application
--                          does this in the same IMMEDIATE transaction that
--                          commits the forward revision, after re-proving the
--                          current target is safe to supersede.
--
-- Unchanged: the stamp is the database's own now, a spent capability can never
-- be retired, an ending is one-way, and nothing is deleted.
--
-- Predeploy-compatible: a nullable column and triggers on this table. The
-- running target only ever spends capabilities, which this does not touch.
ALTER TABLE certification_capabilities
  ADD COLUMN retirement_reason TEXT
  CHECK (retirement_reason IS NULL OR retirement_reason IN ('EXPIRED_REPLACED', 'FORWARD_SUPERSESSION'));

DROP TRIGGER certification_capabilities_retirement_guard;

CREATE TRIGGER certification_capabilities_retirement_guard
BEFORE UPDATE ON certification_capabilities
WHEN OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
  AND (
    -- Spent and retired are different endings, and never both.
    OLD.consumed_at IS NOT NULL
    -- The stamp is not the caller's to choose.
    OR NEW.retired_at <> strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    -- Replacement, or a writer that states no reason: only once expired.
    OR (COALESCE(NEW.retirement_reason, 'EXPIRED_REPLACED') = 'EXPIRED_REPLACED' AND NEW.retired_at < OLD.expires_at)
    -- Forward supersession: only for the current binding of an armed, stuck,
    -- fenced session that can no longer roll back.
    OR (NEW.retirement_reason = 'FORWARD_SUPERSESSION' AND NOT EXISTS (
      SELECT 1 FROM deploy_sessions s
      WHERE s.id = OLD.deployment_session_id
        AND s.mode = 'MAINTENANCE_CUTOVER'
        AND s.state = 'RECOVERY_REQUIRED'
        AND s.rollback_authority = 'NEW_LINEAGE_ONLY'
        AND s.deployment_gate_closed = 1
        AND s.bootstrap_rollback_id IS NULL
        AND OLD.release_sha = COALESCE(
          (SELECT f.target_sha FROM deploy_session_forward_targets f WHERE f.session_id = s.id ORDER BY f.revision DESC LIMIT 1),
          s.target_sha)))
  )
BEGIN SELECT RAISE(ABORT, 'CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE'); END;

-- Why a capability ended is part of that ending: set in the same write that
-- retires it, and never afterwards.
CREATE TRIGGER certification_capabilities_retirement_reason_guard
BEFORE UPDATE ON certification_capabilities
WHEN NEW.retirement_reason IS NOT OLD.retirement_reason
  AND (OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'CERTIFICATION_CAPABILITY_RETIREMENT_REASON_IMMUTABLE'); END;
