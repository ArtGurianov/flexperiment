-- A deployment-only, global new-order gate.  This is intentionally separate
-- from occurrences.sales_status: pausing a release must not revise an
-- occurrence or create any customer/refund/email business side effect.
CREATE TABLE release_sales_gate (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  sales_paused INTEGER NOT NULL DEFAULT 0 CHECK (sales_paused IN (0, 1)),
  owner_release_id TEXT,
  owner_mode TEXT CHECK (owner_mode IN ('CONTROLLED_CUTOVER', 'ROLLING')),
  expected_source_commit TEXT,
  expected_migration TEXT,
  expected_legal_version TEXT,
  expected_legal_manifest_sha256 TEXT,
  acquired_at TEXT,
  paused_at TEXT,
  reopened_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO release_sales_gate(singleton) VALUES (1);

CREATE TABLE release_sales_gate_events (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('ACQUIRED', 'PAUSED', 'REOPENED')),
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX release_sales_gate_events_release_created_idx
  ON release_sales_gate_events(release_id, created_at);
