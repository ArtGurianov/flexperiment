-- `agents.contract_reference` was a NOT NULL, required-in-the-form free-text
-- field connected to nothing: no other table, trigger or query ever read it.
-- The real "договор" contour is the framework/delegation agreement revisions
-- introduced in 0043/0044. This migration removes the dead field so operators
-- stop inventing values for it.
--
-- Same FK-off table-rebuild procedure as 0058, reused verbatim: SQLite cannot
-- drop a NOT NULL column in place while other tables hold a foreign key to
-- agents(id). The loader admits this exact file only through its reviewed
-- SHA-256 registry entry in commerce/src/db.ts.
--
-- Post-0058, `agents` carries no triggers of its own (its only trigger,
-- agents_contractor_type_projection_guard, was dropped in 0058 when
-- contractor_type left the table) - nothing to preserve across the rebuild.

CREATE TABLE agents_0059_new (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  default_reward_type TEXT NOT NULL CHECK (default_reward_type IN ('PERCENT', 'FIXED')),
  default_reward_value INTEGER NOT NULL CHECK (default_reward_value >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO agents_0059_new (
  id, slug, display_name, email, enabled,
  default_reward_type, default_reward_value, created_at, updated_at
)
SELECT id, slug, display_name, email, enabled,
  default_reward_type, default_reward_value, created_at, updated_at
FROM agents;

DROP TABLE agents;
ALTER TABLE agents_0059_new RENAME TO agents;
