-- Retirement is the database's to time, and the rule is one predicate.
--
-- The baseline's guard admitted any stamp in `[expires_at, now]`, so the
-- application still chose the moment - it happened to write the database's
-- clock, but nothing required it to. That is the same class of arrangement as
-- a caller deciding whether its own capability had expired.
--
-- It also carried a term recorded as deliberately redundant: `now <
-- expires_at` is implied by the other two, so no test could kill it alone. A
-- predicate no test can reach is a predicate nobody can prove still works.
--
-- Both go together, because pinning the stamp to the clock is what makes the
-- redundancy removable: with `NEW.retired_at` required to *be* the database's
-- now, "not before expiry" and "not in the future" collapse into one
-- comparison, and the rule reads as what it is - a capability may be retired
-- only once it has really expired, at the moment it is retired.
--
-- SQLite evaluates `'now'` once per statement, so the value this trigger
-- compares against is the same one the UPDATE wrote. `expires_at` is written
-- as `toISOString()` and `strftime('%Y-%m-%dT%H:%M:%fZ','now')` produces the
-- same fixed-width UTC shape, so they compare correctly as text.
DROP TRIGGER certification_capabilities_retirement_guard;

CREATE TRIGGER certification_capabilities_retirement_guard
BEFORE UPDATE ON certification_capabilities
WHEN OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
  AND (
    -- Spent and replaced are different endings, and never both.
    OLD.consumed_at IS NOT NULL
    -- The stamp is not the caller's to choose.
    OR NEW.retired_at <> strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    -- And a capability that has not expired may not be retired at all.
    OR NEW.retired_at < OLD.expires_at
  )
BEGIN SELECT RAISE(ABORT, 'CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE'); END;
