-- The only FK-off migration. It contains nothing else: `agents` rebuilt so
-- `contractor_type` admits 'ORGANIZATION', every other column, constraint,
-- default and legacy row preserved byte/semantic-equivalent. SQLite cannot
-- widen a CHECK constraint in place, so the table must be rebuilt.
--
-- The new table is built under a temporary name and swapped into place by
-- DROP + RENAME, never by renaming `agents` itself. `ALTER TABLE ... RENAME
-- TO` rewrites every OTHER table's `REFERENCES agents(id)` clause in the
-- schema to follow the renamed name (proven empirically against this exact
-- better-sqlite3/SQLite build) - renaming `agents` directly would silently
-- repoint all eight inbound FK columns (promo_codes, quotes x2, orders x2,
-- referral_rewards, reward_adjustments, reward_settlements) at a table this
-- migration then drops. None of those eight tables are touched here; the
-- temp-name-then-swap ordering is what keeps their FK clauses untouched by
-- construction rather than by review convention.
CREATE TABLE agents_0042_new (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  email TEXT NOT NULL,
  contractor_type TEXT NOT NULL CHECK (contractor_type IN ('SELF_EMPLOYED', 'INDIVIDUAL_ENTREPRENEUR', 'ORGANIZATION')),
  inn TEXT NOT NULL,
  contract_reference TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  default_reward_type TEXT NOT NULL CHECK (default_reward_type IN ('PERCENT', 'FIXED')),
  default_reward_value INTEGER NOT NULL CHECK (default_reward_value >= 0),
  npd_status_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO agents_0042_new (id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled, default_reward_type, default_reward_value, npd_status_checked_at, created_at, updated_at)
  SELECT id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled, default_reward_type, default_reward_value, npd_status_checked_at, created_at, updated_at
  FROM agents;

DROP TABLE agents;

ALTER TABLE agents_0042_new RENAME TO agents;
